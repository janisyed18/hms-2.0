"""Customer deletion under real PostgreSQL: concurrency and archive immutability.

SQLite ignores ``FOR UPDATE`` and has no triggers, so these two guarantees only show
on PostgreSQL. Skipped unless ``POSTGRES_TEST_DATABASE_URL`` points at a migrated
database whose name ends in ``_test``.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.modules.history.service as history_service
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.object_storage import LocalObjectStorage, set_object_storage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.history.models import CustomerDeletionBatch
from hms_backend.app.modules.products.models import Product

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(
        not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
    ),
    pytest.mark.usefixtures("customer_deletion_enabled"),
]
SUPER = Principal(
    user_id="pg-super", roles=frozenset({Role.SUPER_ADMIN}), customer_ids=frozenset()
)


@pytest.fixture
def storage(tmp_path: Path) -> Iterator[LocalObjectStorage]:
    store = LocalObjectStorage(tmp_path / "objects")
    set_object_storage(store)
    yield store
    set_object_storage(None)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
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
    factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def own_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:  # one session, one transaction per request
            yield session

    async def principal() -> Principal:
        return SUPER

    app.dependency_overrides[get_session] = own_session
    app.dependency_overrides[get_current_principal] = principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def _customer(factory: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    token = uuid4().hex[:10]
    async with factory() as session:
        customer = Customer(code=f"PG-{token}".upper(), name=f"Customer {token}")
        product = Product(category="Hose", code=f"P-{token}", name=f"P-{token}")
        session.add_all([customer, product])
        await session.flush()
        location = CustomerLocation(customer_id=customer.id, name="Yard")
        session.add(location)
        await session.flush()
        session.add(
            Asset(
                customer_id=customer.id,
                location_id=location.id,
                product_id=product.id,
                asset_number=f"A-{token}",
                customer_serial_no=f"SN-{token}",
                tag=f"HMS-{token}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
        )
        await session.commit()
        return customer.id, customer.name


async def _body(
    client: httpx.AsyncClient, customer_id: str, name: str
) -> dict[str, str]:
    check = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
    return {"confirm_name": name, "impact_fingerprint": check.json()["fingerprint"]}


@pytest.mark.asyncio
async def test_two_simultaneous_deletes_archive_the_customer_exactly_once(
    database: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    customer_id, name = await _customer(database)
    async with client_for(database) as one, client_for(database) as two:
        body = await _body(one, customer_id, name)
        url = f"/api/v1/customers/{customer_id}/delete-with-history"
        first, second = await asyncio.gather(
            one.post(url, json=body), two.post(url, json=body)
        )

    assert sorted([first.status_code, second.status_code]) == [200, 404]
    async with database() as session:
        batches = await session.scalar(
            select(func.count())
            .select_from(CustomerDeletionBatch)
            .where(
                CustomerDeletionBatch.customer_id == customer_id,
                CustomerDeletionBatch.status == "COMPLETED",
            )
        )
    assert batches == 1


@pytest.mark.asyncio
async def test_editing_a_child_record_after_the_preview_blocks_the_delete(
    database: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    """Counts are unchanged, but the reviewed impact is not what would be archived."""
    customer_id, name = await _customer(database)
    async with client_for(database) as client:
        body = await _body(client, customer_id, name)
        async with database() as session:
            await session.execute(
                update(Asset)
                .where(Asset.customer_id == customer_id)
                .values(tag=f"CHANGED-{uuid4().hex[:6]}")
            )
            await session.commit()
        response = await client.post(
            f"/api/v1/customers/{customer_id}/delete-with-history", json=body
        )
        assert response.status_code == 409
        assert "changed after you reviewed" in response.json()["detail"]
        # A fresh preview reflects the edit and the delete then succeeds.
        fresh = await _body(client, customer_id, name)
        assert fresh["impact_fingerprint"] != body["impact_fingerprint"]
        retry = await client.post(
            f"/api/v1/customers/{customer_id}/delete-with-history", json=fresh
        )
        assert retry.status_code == 200


@pytest.mark.asyncio
async def test_child_records_cannot_change_while_the_deletion_is_in_progress(
    database: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Checking the fingerprint is not enough: the rows stay locked until commit."""
    customer_id, name = await _customer(database)
    reached, release = asyncio.Event(), asyncio.Event()
    original = history_service.read_snapshot

    async def paused(session: AsyncSession, customer: str) -> history_service.Snapshot:
        reached.set()  # fingerprint checked, archive not yet written
        await release.wait()
        return await original(session, customer)

    async with client_for(database) as client:
        body = await _body(client, customer_id, name)
        monkeypatch.setattr(history_service, "read_snapshot", paused)
        deletion = asyncio.create_task(
            client.post(
                f"/api/v1/customers/{customer_id}/delete-with-history", json=body
            )
        )
        await asyncio.wait_for(reached.wait(), timeout=20)

        async def attempt(statement: str) -> None:
            async with database() as other:
                await other.execute(text("SET LOCAL lock_timeout = '400ms'"))
                await other.execute(text(statement), {"cid": customer_id})
                await other.commit()

        # Another transaction cannot edit existing children in the meantime.
        with pytest.raises(DBAPIError, match="lock timeout"):
            await attempt("UPDATE assets SET tag = 'EDITED' WHERE customer_id = :cid")
        with pytest.raises(DBAPIError, match="lock timeout"):
            await attempt(
                "UPDATE customer_locations SET name = 'EDITED' WHERE customer_id = :cid"
            )
        release.set()
        response = await asyncio.wait_for(deletion, timeout=60)

    assert response.status_code == 200, response.text
    async with database() as session:
        archived = (
            (
                await session.execute(
                    text(
                        "SELECT payload->>'tag' FROM history_records "
                        "WHERE batch_id = :batch AND record_type = 'assets'"
                    ),
                    {"batch": response.json()["id"]},
                )
            )
            .scalars()
            .all()
        )
    assert archived and "EDITED" not in archived


@pytest.mark.asyncio
async def test_simultaneous_retries_with_one_key_return_one_batch(
    database: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    customer_id, name = await _customer(database)
    headers = {"Idempotency-Key": f"pg-{uuid4().hex}"}
    async with client_for(database) as one, client_for(database) as two:
        body = await _body(one, customer_id, name)
        url = f"/api/v1/customers/{customer_id}/delete-with-history"
        first, second = await asyncio.gather(
            one.post(url, json=body, headers=headers),
            two.post(url, json=body, headers=headers),
        )

    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert sorted([first.json()["replayed"], second.json()["replayed"]]) == [
        False,
        True,
    ]


@pytest.mark.asyncio
async def test_archive_tables_reject_update_and_delete(
    database: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    customer_id, name = await _customer(database)
    async with client_for(database) as client:
        body = await _body(client, customer_id, name)
        created = await client.post(
            f"/api/v1/customers/{customer_id}/delete-with-history", json=body
        )
    batch_id = created.json()["id"]
    # (This scene has no files, so no evidence rows; the trigger is the same one.)
    statements = [
        "UPDATE history_customer_deletions SET customer_name = 'x' WHERE id = :id",
        "DELETE FROM history_customer_deletions WHERE id = :id",
        "UPDATE history_records SET payload_sha256 = 'x' WHERE batch_id = :id",
        "DELETE FROM history_records WHERE batch_id = :id",
        "DELETE FROM history_relationships WHERE batch_id = :id",
    ]
    for statement in statements:
        async with database() as session:
            with pytest.raises(DBAPIError, match="insert-only"):
                await session.execute(text(statement), {"id": batch_id})
