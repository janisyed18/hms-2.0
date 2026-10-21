"""Sync cursor ordering and device registration under real PostgreSQL concurrency.

SQLite cannot show these: they need independent transactions whose commit order,
sequence allocation and row/advisory locks interleave. Interleavings are forced with
explicit gates and lock-wait polling, never with sleeps standing in for ordering.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.sync as sync_module
import hms_backend.app.core.audit as audit_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.sync_schemas import SyncRecordRead
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.core.repository import record_create
from hms_backend.app.main import create_app
from hms_backend.app.models.foundation import Device, SyncChange
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.notifications.models import OutboxEvent
from hms_backend.app.modules.notifications.outbox import bounded_aggregate_id

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
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


def _principal(user_id: str) -> Principal:
    return Principal(
        user_id=user_id, roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )


def _client(
    database: async_sessionmaker[AsyncSession], user_id: str
) -> httpx.AsyncClient:
    app = create_app()

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with database() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: _principal(user_id)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    )


def _device_headers(
    device_id: str, platform: str = "android", app_version: str = "26.1.0"
) -> dict[str, str]:
    return {
        "X-HMS-Device-Id": device_id,
        "X-HMS-Device-Platform": platform,
        "X-HMS-App-Version": app_version,
    }


@dataclass
class _Gate:
    reached: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)


@pytest.mark.asyncio
async def test_a_transaction_that_commits_later_is_never_skipped_by_the_cursor(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sequence order must equal commit order, or a polling client loses a change.

    Transaction A is held just before it takes the global ledger lock; B then runs to
    completion and commits. If A's sync sequence number was already allocated (lower
    than B's), the client advances its cursor past B and never receives A.
    """
    real_lock = audit_module._acquire_audit_chain_lock  # noqa: SLF001
    gate = _Gate()

    async def gated_lock(session: AsyncSession) -> None:
        held = session.info.get("gate")
        if held is not None:
            held.reached.set()
            await held.release.wait()
        await real_lock(session)

    monkeypatch.setattr(audit_module, "_acquire_audit_chain_lock", gated_lock)
    tag = uuid4().hex[:10].upper()
    user_id = str(uuid4())
    device = _device_headers(f"poll-{tag}")

    async def mutate(name: str, held: _Gate | None) -> str:
        async with database() as session:
            if held is not None:
                session.info["gate"] = held
            customer = Customer(code=f"{name}-{tag}", name=f"{name} {tag}")
            session.add(customer)
            await record_create(
                session, customer, actor_id=user_id, action="customer.created"
            )
            await session.commit()
            return customer.id

    async with database() as session:
        baseline = int(await session.scalar(select(func.max(SyncChange.seq))) or 0)

    task_a = asyncio.create_task(mutate("A", gate))
    await gate.reached.wait()  # A is paused at the lock request
    id_b = await mutate("B", None)  # B starts later and commits first

    async with _client(database, user_id) as client:
        first = await client.get(
            "/api/v1/sync/changes", params={"since": baseline}, headers=device
        )
        assert first.status_code == 200, first.text
        cursor = first.json()["cursor"]
        delivered = {c["entity_id"] for c in first.json()["changes"]}
        assert id_b in delivered

        gate.release.set()
        id_a = await task_a  # A commits after the client already polled

        second = await client.get(
            "/api/v1/sync/changes", params={"since": cursor}, headers=device
        )
        assert second.status_code == 200, second.text
        delivered |= {c["entity_id"] for c in second.json()["changes"]}

    assert {id_a, id_b} <= delivered, "the later-committing change was never delivered"


@pytest.mark.asyncio
async def test_an_empty_page_never_advances_the_cursor_past_an_undelivered_change(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A poll that found nothing must not move the cursor using a *later* snapshot.

    The request reads ``seq > since`` and finds no rows. Before it builds its response,
    another transaction commits a visible change. If the empty response then asked the
    database for the new maximum sequence, its cursor would jump over that change, which
    the client would never be sent.
    """
    real_visible = sync_module._visible_change_records  # noqa: SLF001
    gate = _Gate()
    used = {"yes": False}

    async def pause_after_the_select(
        session: AsyncSession, principal: Principal, scanned: Sequence[SyncChange]
    ) -> list[SyncRecordRead]:
        records = await real_visible(session, principal, scanned)
        if not used["yes"]:
            used["yes"] = True
            gate.reached.set()
            await gate.release.wait()
        return records

    monkeypatch.setattr(sync_module, "_visible_change_records", pause_after_the_select)
    tag = uuid4().hex[:10].upper()
    user_id = str(uuid4())
    device = _device_headers(f"empty-{tag}")
    async with database() as session:
        baseline = int(await session.scalar(select(func.max(SyncChange.seq))) or 0)

    async def poll(since: int) -> httpx.Response:
        async with _client(database, user_id) as client:
            return await client.get(
                "/api/v1/sync/changes", params={"since": since}, headers=device
            )

    empty_poll = asyncio.create_task(poll(baseline))
    await gate.reached.wait()  # the first SELECT is done and found nothing

    async with database() as session:  # a visible change commits mid-request
        customer = Customer(code=f"E-{tag}", name=f"Empty {tag}")
        session.add(customer)
        await record_create(
            session, customer, actor_id=user_id, action="customer.created"
        )
        await session.commit()
        new_id = customer.id

    gate.release.set()
    first = await empty_poll
    assert first.status_code == 200, first.text
    assert first.json()["changes"] == []
    # Nothing was consumed past `since`, so the cursor must not have moved.
    assert first.json()["cursor"] == baseline

    second = await poll(first.json()["cursor"])
    assert second.status_code == 200, second.text
    assert new_id in {c["entity_id"] for c in second.json()["changes"]}


# --- sync devices ---------------------------------------------------------------


def _realistic_device_id() -> str:
    """What the inspector browser generates: 54 characters, wider than 36."""
    device_id = f"inspector-browser-{uuid4()}"
    assert len(device_id) > 36
    return device_id


async def _registered_events(
    database: async_sessionmaker[AsyncSession], device_id: str
) -> int:
    async with database() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(OutboxEvent)
                .where(
                    OutboxEvent.event_type == "DEVICE_REGISTERED",
                    OutboxEvent.aggregate_id == bounded_aggregate_id(device_id),
                )
            )
            or 0
        )


async def _device_row(
    database: async_sessionmaker[AsyncSession], device_id: str
) -> Device:
    async with database() as session:
        device = await session.get(Device, device_id)
        assert device is not None
        return device


@pytest.mark.asyncio
async def test_a_real_inspector_device_id_registers_and_can_be_revoked(
    database: async_sessionmaker[AsyncSession],
) -> None:
    """A 54-character id overflowed the 36-character outbox key: HTTP 500."""
    device_id = _realistic_device_id()
    user_id = str(uuid4())

    async with _client(database, user_id) as client:
        registered = await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=_device_headers(device_id),
        )
        revoked = await client.patch(
            f"/api/v1/admin/devices/{device_id}", json={"revoked": True}
        )
        refused = await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=_device_headers(device_id),
        )

    assert registered.status_code == 200, registered.text
    assert revoked.status_code == 200, revoked.text
    assert refused.status_code == 403
    assert await _registered_events(database, device_id) == 1
    async with database() as session:
        events = (
            await session.scalars(
                select(OutboxEvent).where(
                    OutboxEvent.event_type.in_(["DEVICE_REGISTERED", "DEVICE_REVOKED"]),
                    OutboxEvent.aggregate_id == bounded_aggregate_id(device_id),
                )
            )
        ).all()
    assert sorted(e.event_type for e in events) == [
        "DEVICE_REGISTERED",
        "DEVICE_REVOKED",
    ]
    assert all(len(e.aggregate_id) <= 36 for e in events)


@pytest.mark.asyncio
async def test_two_sessions_registering_the_same_new_device_do_not_fail(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    real_lock = sync_module._lock_device  # noqa: SLF001
    barrier = asyncio.Barrier(2)
    first_look: set[int] = set()

    async def lock_then_wait(session: AsyncSession, device_id: str) -> Device | None:
        device = await real_lock(session, device_id)
        if id(session) not in first_look:
            first_look.add(id(session))
            if device is None:
                # Hold both requests until each has seen "no such device".
                await barrier.wait()
        return device

    monkeypatch.setattr(sync_module, "_lock_device", lock_then_wait)
    device_id = _realistic_device_id()
    user_id = str(uuid4())

    async def register() -> int:
        async with _client(database, user_id) as client:
            response = await client.get(
                "/api/v1/sync/changes",
                params={"since": 0},
                headers=_device_headers(device_id),
            )
            return response.status_code

    assert list(await asyncio.gather(register(), register())) == [200, 200]
    async with database() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(Device)
            .where(Device.device_id == device_id)
        )
    assert count == 1
    assert await _registered_events(database, device_id) == 1  # only the winner emits


async def _wait_until_blocked_on(
    database: async_sessionmaker[AsyncSession], statement: str
) -> None:
    for _ in range(200):
        async with database() as session:
            blocked = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE wait_event_type = 'Lock' AND query ILIKE :pattern"
                ),
                {"pattern": f"%{statement}%"},
            )
        if blocked:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"nothing is blocked on a lock running {statement!r}")


@pytest.mark.asyncio
async def test_a_revoke_cannot_commit_while_a_sync_holds_the_device_lock(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Revocation must serialise with an in-flight sync, never slip past it."""
    device_id = _realistic_device_id()
    user_id = str(uuid4())
    async with _client(database, user_id) as client:
        assert (
            await client.get(
                "/api/v1/sync/changes",
                params={"since": 0},
                headers=_device_headers(device_id),
            )
        ).status_code == 200

    real_lock = sync_module._lock_device  # noqa: SLF001
    gate = _Gate()
    used = {"yes": False}

    async def hold_after_lock(session: AsyncSession, requested: str) -> Device | None:
        device = await real_lock(session, requested)
        if not used["yes"]:
            used["yes"] = True
            gate.reached.set()
            await gate.release.wait()
        return device

    monkeypatch.setattr(sync_module, "_lock_device", hold_after_lock)

    async def syncing() -> int:
        async with _client(database, user_id) as client:
            return (
                await client.get(
                    "/api/v1/sync/changes",
                    params={"since": 0},
                    headers=_device_headers(device_id, app_version="2.0.0"),
                )
            ).status_code

    async def revoking() -> None:
        async with database() as session:
            await session.execute(
                update(Device).where(Device.device_id == device_id).values(revoked=True)
            )
            await session.commit()

    sync_task = asyncio.create_task(syncing())
    await gate.reached.wait()  # the sync now holds the device row lock
    revoke_task = asyncio.create_task(revoking())
    await _wait_until_blocked_on(database, "UPDATE devices")
    assert not revoke_task.done()  # the revoke cannot commit past the in-flight sync

    gate.release.set()
    assert await sync_task == 200  # it started before the revoke, so it completes
    await revoke_task

    async with _client(database, user_id) as client:
        after = await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=_device_headers(device_id),
        )
    assert after.status_code == 403  # revocation wins for every later request
    assert (await _device_row(database, device_id)).revoked is True


@pytest.mark.asyncio
async def test_concurrent_metadata_updates_are_serialised_and_deterministic(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    device_id = _realistic_device_id()
    user_id = str(uuid4())
    async with _client(database, user_id) as client:
        await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=_device_headers(device_id),
        )

    real_lock = sync_module._lock_device  # noqa: SLF001
    gate = _Gate()
    used = {"yes": False}

    async def hold_after_lock(session: AsyncSession, requested: str) -> Device | None:
        device = await real_lock(session, requested)
        if not used["yes"]:
            used["yes"] = True
            gate.reached.set()
            await gate.release.wait()
        return device

    monkeypatch.setattr(sync_module, "_lock_device", hold_after_lock)

    async def update(platform: str, version: str) -> int:
        async with _client(database, user_id) as client:
            return (
                await client.get(
                    "/api/v1/sync/changes",
                    params={"since": 0},
                    headers=_device_headers(device_id, platform, version),
                )
            ).status_code

    first = asyncio.create_task(update("android", "2.0.0"))
    await gate.reached.wait()
    second = asyncio.create_task(update("ios", "3.0.0"))
    # The second request queues behind the first's row lock instead of racing it.
    await _wait_until_blocked_on(database, "FOR UPDATE")
    assert not second.done()

    gate.release.set()
    assert [await first, await second] == [200, 200]
    device = await _device_row(database, device_id)
    # Serialised, so the later request's values win as a consistent pair.
    assert (device.platform, device.app_version) == ("ios", "3.0.0")
    assert device.revoked is False


@pytest.mark.asyncio
async def test_a_device_cannot_change_owner_under_concurrency_either(
    database: async_sessionmaker[AsyncSession],
) -> None:
    device_id = _realistic_device_id()
    owner, intruder = str(uuid4()), str(uuid4())
    async with _client(database, owner) as client:
        await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=_device_headers(device_id),
        )

    async def attempt(user_id: str) -> int:
        async with _client(database, user_id) as client:
            return (
                await client.get(
                    "/api/v1/sync/changes",
                    params={"since": 0},
                    headers=_device_headers(device_id, "android", "9.9.9"),
                )
            ).status_code

    results = await asyncio.gather(
        *(attempt(intruder) for _ in range(3)), attempt(owner)
    )
    assert list(results) == [403, 403, 403, 200]
    assert (await _device_row(database, device_id)).user_id == owner
