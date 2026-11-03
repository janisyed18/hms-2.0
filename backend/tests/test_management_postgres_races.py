"""Last Super Admin and last Location deletes under real PostgreSQL concurrency,
plus the customer archive migration and persistence.

Each request runs in its own session and transaction. SQLite ignores ``FOR UPDATE``,
so only PostgreSQL shows whether the invariants hold when deletes overlap.
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
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import utc_now
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.identity.models import User

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)
# Long enough for a blocked request to reach its lock wait, short enough to stay quick.
SETTLE_SECONDS = 0.75


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


async def _active_super_admins(
    factory: async_sessionmaker[AsyncSession], ids: list[str]
) -> int:
    async with factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(
                User.id.in_(ids),
                User.deleted_at.is_(None),
                User.account_status == "ACTIVE",
            )
        )
    return count or 0


@pytest_asyncio.fixture
async def super_admins(
    database: async_sessionmaker[AsyncSession],
) -> AsyncIterator[list[str]]:
    """Exactly two Super Admins and no other active ones, restored afterwards."""
    token = uuid4().hex[:12]
    async with database() as session:
        # Another run's leftovers must not count as a surviving Super Admin.
        others = (
            await session.scalars(
                select(User).where(
                    User.role == Role.SUPER_ADMIN.value,
                    User.deleted_at.is_(None),
                    User.account_status == "ACTIVE",
                )
            )
        ).all()
        parked = [user.id for user in others]
        for user in others:
            user.account_status = "DISABLED"
        mine = [
            User(
                oidc_subject=f"race-{token}-{n}",
                email=f"race-{token}-{n}@example.test",
                role=Role.SUPER_ADMIN.value,
            )
            for n in (1, 2)
        ]
        session.add_all(mine)
        await session.commit()
        ids = [user.id for user in mine]
    try:
        yield ids
    finally:
        async with database() as session:
            await session.execute(
                text("DELETE FROM users WHERE id = ANY(:ids)"), {"ids": ids}
            )
            if parked:
                await session.execute(
                    text(
                        "UPDATE users SET account_status = 'ACTIVE' "
                        "WHERE id = ANY(:ids)"
                    ),
                    {"ids": parked},
                )
            await session.commit()


@pytest.mark.asyncio
async def test_concurrent_super_admin_deletes_leave_one(
    database: async_sessionmaker[AsyncSession], super_admins: list[str]
) -> None:
    first, second = super_admins
    async with (
        client_for(database, _super("someone-a")) as one,
        client_for(database, _super("someone-b")) as two,
    ):
        results = await asyncio.gather(
            one.delete(f"/api/v1/admin/users/{first}"),
            two.delete(f"/api/v1/admin/users/{second}"),
        )

    statuses = sorted(response.status_code for response in results)
    assert statuses == [204, 409]
    assert await _active_super_admins(database, super_admins) == 1


@pytest.mark.asyncio
async def test_super_admin_delete_waits_for_the_other_and_is_then_refused(
    database: async_sessionmaker[AsyncSession], super_admins: list[str]
) -> None:
    """Deterministic overlap: one transaction holds the lock while the other asks."""
    first, second = super_admins
    async with database() as holder:
        await holder.execute(
            select(User.id)
            .where(
                User.role == Role.SUPER_ADMIN.value,
                User.deleted_at.is_(None),
                User.account_status == "ACTIVE",
            )
            .order_by(User.id)
            .with_for_update()
        )
        async with client_for(database, _super("someone-b")) as client:
            blocked = asyncio.create_task(
                client.delete(f"/api/v1/admin/users/{second}")
            )
            await asyncio.sleep(SETTLE_SECONDS)
            assert not blocked.done(), "the delete must wait for the row lock"
            # The holder deletes the other admin and commits, releasing the lock.
            await holder.execute(
                text(
                    "UPDATE users SET deleted_at = :now, account_status = 'DISABLED' "
                    "WHERE id = :id"
                ),
                {"now": utc_now(), "id": first},
            )
            await holder.commit()
            response = await asyncio.wait_for(blocked, timeout=10)

    assert response.status_code == 409
    assert "last active Super Admin" in response.json()["detail"]
    assert await _active_super_admins(database, super_admins) == 1


@pytest_asyncio.fixture
async def two_locations(
    database: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[str, list[str]]]:
    token = uuid4().hex[:10]
    async with database() as session:
        customer = Customer(code=f"RACE-{token}", name=f"Race {token}")
        locations = [
            CustomerLocation(customer=customer, name=f"Site {n}") for n in (1, 2)
        ]
        session.add_all([customer, *locations])
        await session.commit()
        ids = [location.id for location in locations]
        customer_id = customer.id
    try:
        yield customer_id, ids
    finally:
        async with database() as session:
            await session.execute(
                text("DELETE FROM customer_locations WHERE customer_id = :c"),
                {"c": customer_id},
            )
            await session.execute(
                text("DELETE FROM customers WHERE id = :c"), {"c": customer_id}
            )
            await session.commit()


async def _active_locations(
    factory: async_sessionmaker[AsyncSession], customer_id: str
) -> int:
    async with factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(CustomerLocation)
            .where(
                CustomerLocation.customer_id == customer_id,
                CustomerLocation.deleted_at.is_(None),
            )
        )
    return count or 0


@pytest.mark.asyncio
async def test_concurrent_location_deletes_keep_one(
    database: async_sessionmaker[AsyncSession],
    two_locations: tuple[str, list[str]],
) -> None:
    customer_id, (first, second) = two_locations
    async with (
        client_for(database, _super("someone-a")) as one,
        client_for(database, _super("someone-b")) as two,
    ):
        results = await asyncio.gather(
            one.delete(f"/api/v1/customers/{customer_id}/locations/{first}"),
            two.delete(f"/api/v1/customers/{customer_id}/locations/{second}"),
        )

    assert sorted(response.status_code for response in results) == [204, 409]
    assert await _active_locations(database, customer_id) == 1


@pytest.mark.asyncio
async def test_location_delete_waits_on_the_customer_lock_then_conflicts(
    database: async_sessionmaker[AsyncSession],
    two_locations: tuple[str, list[str]],
) -> None:
    customer_id, (first, second) = two_locations
    async with database() as holder:
        await holder.execute(
            select(Customer.id).where(Customer.id == customer_id).with_for_update()
        )
        async with client_for(database, _super("someone-b")) as client:
            blocked = asyncio.create_task(
                client.delete(f"/api/v1/customers/{customer_id}/locations/{second}")
            )
            await asyncio.sleep(SETTLE_SECONDS)
            assert not blocked.done(), "the delete must wait for the customer lock"
            await holder.execute(
                text("UPDATE customer_locations SET deleted_at = :now WHERE id = :id"),
                {"now": utc_now(), "id": first},
            )
            await holder.commit()
            response = await asyncio.wait_for(blocked, timeout=10)

    assert response.status_code == 409
    assert "at least one location" in response.json()["detail"]
    assert await _active_locations(database, customer_id) == 1


@pytest.mark.asyncio
async def test_migration_added_a_nullable_archived_at_and_nothing_destructive(
    database: async_sessionmaker[AsyncSession],
) -> None:
    async with database() as session:
        column = (
            await session.execute(
                text(
                    "SELECT data_type, is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'customers' AND column_name = 'archived_at'"
                )
            )
        ).one()
        # Existing customers stay active: the column is optional and has no default.
        default = await session.scalar(
            text(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'customers' AND column_name = 'archived_at'"
            )
        )

    assert column.is_nullable == "YES"
    assert column.data_type.startswith("timestamp")
    assert default is None


@pytest.mark.asyncio
async def test_archive_and_restore_persist(
    database: async_sessionmaker[AsyncSession],
) -> None:
    token = uuid4().hex[:10]
    async with database() as session:
        customer = Customer(code=f"ARCH-{token}", name=f"Archive {token}")
        session.add(customer)
        await session.commit()
        customer_id = customer.id
    try:
        async with client_for(database, _super("someone")) as client:
            archived = await client.post(f"/api/v1/customers/{customer_id}/archive")
            async with database() as session:
                stored = await session.scalar(
                    select(Customer.archived_at).where(Customer.id == customer_id)
                )
            restored = await client.post(f"/api/v1/customers/{customer_id}/restore")
            async with database() as session:
                cleared = await session.scalar(
                    select(Customer.archived_at).where(Customer.id == customer_id)
                )
        assert archived.status_code == 200
        assert stored is not None
        assert restored.status_code == 200
        assert cleared is None
    finally:
        async with database() as session:
            await session.execute(
                text("DELETE FROM customers WHERE id = :c"), {"c": customer_id}
            )
            await session.commit()
