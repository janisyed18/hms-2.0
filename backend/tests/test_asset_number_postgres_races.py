"""Asset Number allocation under real PostgreSQL concurrency.

An Asset Number is the identity staff quote to each other, so two assets must never
carry the same one and a generated number must never be skipped or reused. Each request
runs in its own session and transaction; SQLite ignores ``FOR UPDATE``, so only
PostgreSQL shows whether the allocation holds when creates overlap.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.modules.assets.models import Asset, AssetNumberCounter
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.products.models import Product

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("Race tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("Race tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=8)
    try:
        async with engine.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@asynccontextmanager
async def client_for(
    factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def own_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:  # one session, one transaction per request
            yield session

    async def principal_override() -> Principal:
        return principal

    app.dependency_overrides[get_session] = own_session
    app.dependency_overrides[get_current_principal] = principal_override
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


def _super(record_user_id: str) -> Principal:
    return Principal(
        user_id=f"actor-{record_user_id}",
        roles=frozenset({Role.SUPER_ADMIN}),
        customer_ids=frozenset(),
        record_user_id=record_user_id,
    )


@pytest_asyncio.fixture
async def place(
    database: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[str, str, str]]:
    """A customer, one of its locations and an enabled product to hang assets on."""
    token = uuid4().hex[:10]
    async with database() as session:
        customer = Customer(code=f"ANUM-{token}", name=f"Asset Number {token}")
        location = CustomerLocation(customer=customer, name=f"Site {token}")
        product = Product(
            category="Hose",
            code=f"ANUM-{token}",
            name=f"Race Hose {token}",
            enabled=True,
        )
        session.add_all([customer, location, product])
        await session.commit()
        ids = (customer.id, location.id, product.id)
    try:
        yield ids
    finally:
        async with database() as session:
            await session.execute(
                text("DELETE FROM asset_end_configurations WHERE asset_id IN "
                     "(SELECT id FROM assets WHERE customer_id = :c)"),
                {"c": ids[0]},
            )
            await session.execute(
                text("DELETE FROM assets WHERE customer_id = :c"), {"c": ids[0]}
            )
            await session.execute(
                text("DELETE FROM customer_locations WHERE customer_id = :c"),
                {"c": ids[0]},
            )
            await session.execute(
                text("DELETE FROM customers WHERE id = :c"), {"c": ids[0]}
            )
            await session.execute(
                text("DELETE FROM products WHERE id = :p"), {"p": ids[2]}
            )
            await session.commit()


def _body(place: tuple[str, str, str], **overrides: object) -> dict[str, object]:
    customer_id, location_id, product_id = place
    payload: dict[str, object] = {
        "customer_id": customer_id,
        "location_id": location_id,
        "product_id": product_id,
        "generate_asset_number": True,
    }
    payload.update(overrides)
    return payload


async def _numbers(
    factory: async_sessionmaker[AsyncSession], customer_id: str
) -> list[str]:
    async with factory() as session:
        rows = await session.scalars(
            select(Asset.asset_number).where(
                Asset.customer_id == customer_id,
                Asset.deleted_at.is_(None),
            )
        )
    return sorted(rows.all())


async def _set_counter(
    factory: async_sessionmaker[AsyncSession], next_number: int
) -> None:
    async with factory() as session:
        counter = await session.get(AssetNumberCounter, 1)
        if counter is None:
            session.add(AssetNumberCounter(id=1, next_number=next_number))
        else:
            counter.next_number = next_number
        await session.commit()


@pytest.mark.asyncio
async def test_two_generated_numbers_never_collide(
    database: async_sessionmaker[AsyncSession],
    place: tuple[str, str, str],
) -> None:
    """AUTO / AUTO: the counter hands each create its own number."""
    async with (
        client_for(database, _super("someone-a")) as one,
        client_for(database, _super("someone-b")) as two,
    ):
        results = await asyncio.gather(
            one.post("/api/v1/assets", json=_body(place)),
            two.post("/api/v1/assets", json=_body(place)),
        )

    assert [response.status_code for response in results] == [201, 201]
    given = [response.json()["asset_number"] for response in results]
    assert len(set(given)) == 2, f"both creates took the same number: {given}"
    assert await _numbers(database, place[0]) == sorted(given)


@pytest.mark.asyncio
async def test_a_generated_number_cannot_land_on_a_manual_one(
    database: async_sessionmaker[AsyncSession],
    place: tuple[str, str, str],
) -> None:
    """AUTO / MANUAL: the number the counter is about to hand out, typed in by hand."""
    await _set_counter(database, 40100)
    async with (
        client_for(database, _super("someone-a")) as one,
        client_for(database, _super("someone-b")) as two,
    ):
        results = await asyncio.gather(
            one.post("/api/v1/assets", json=_body(place)),
            two.post(
                "/api/v1/assets",
                json=_body(
                    place, asset_number="40100", generate_asset_number=False
                ),
            ),
        )

    statuses = sorted(response.status_code for response in results)
    # Whoever commits second must be refused rather than duplicate the number.
    assert statuses in ([201, 201], [201, 409]), statuses
    stored = await _numbers(database, place[0])
    assert len(stored) == len(set(stored)), f"the same number twice: {stored}"
    assert len(stored) == statuses.count(201)


@pytest.mark.asyncio
async def test_the_same_manual_number_twice_is_refused_not_duplicated(
    database: async_sessionmaker[AsyncSession],
    place: tuple[str, str, str],
) -> None:
    """MANUAL / MANUAL: identical numbers, sent together, must give one 409."""
    async with (
        client_for(database, _super("someone-a")) as one,
        client_for(database, _super("someone-b")) as two,
    ):
        typed = _body(place, asset_number="A-40200", generate_asset_number=False)
        results = await asyncio.gather(
            one.post("/api/v1/assets", json=typed),
            two.post("/api/v1/assets", json=typed),
        )

    assert sorted(response.status_code for response in results) == [201, 409]
    refused = next(r for r in results if r.status_code == 409)
    assert "already in use" in refused.json()["detail"]
    assert await _numbers(database, place[0]) == ["A-40200"]
