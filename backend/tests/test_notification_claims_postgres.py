"""Notification dispatch under real PostgreSQL concurrency.

A notification is an external side effect (an email or an SMS) that no database
transaction can undo, so the dispatcher must *claim* a row durably before sending, and
two overlapping dispatchers must never send the same notification. Interleavings are
forced with explicit gates, never with sleeps standing in for ordering.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationChannel,
    NotificationStatus,
)
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent
from hms_backend.app.modules.notifications.service import _relay_one, dispatch_pending

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


class RecordingAdapter:
    """Counts sends per recipient; the first send to each can be held open."""

    channel = NotificationChannel.EMAIL

    def __init__(self, hold_address: str | None = None) -> None:
        self.sends: dict[str, int] = {}
        # Only this recipient's first send is held open, so rows left in the shared
        # database by other tests can never entangle with the interleaving.
        self._hold_address = hold_address
        self.first_started = asyncio.Event()
        self.release = asyncio.Event()

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        count = self.sends.get(message.to_address, 0) + 1
        self.sends[message.to_address] = count
        if self._hold_address == message.to_address and count == 1:
            self.first_started.set()
            await self.release.wait()
        return DeliveryResult(success=True, provider_message_id=f"msg-{count}")


async def _seed(database: async_sessionmaker[AsyncSession], address: str) -> str:
    async with database() as session:
        notification = Notification(
            event_ref=f"event-{uuid4().hex[:8]}",
            category="CERTIFICATE_ISSUED",
            tier="IMPORTANT",
            recipient_type="USER",
            recipient_id=str(uuid4()),
            recipient_address=address,
            channel="EMAIL",
            template_key="certificate_issued",
            subject="Certificate issued",
            body="Your certificate has been issued.",
            status=NotificationStatus.PENDING.value,
            idempotency_key=uuid4().hex + uuid4().hex,
            scheduled_for=datetime.now(UTC),
        )
        session.add(notification)
        await session.commit()
        return notification.id


async def _row(
    database: async_sessionmaker[AsyncSession], notification_id: str
) -> Notification:
    async with database() as session:
        row = await session.get(Notification, notification_id)
        assert row is not None
        return row


def _adapters(adapter: RecordingAdapter) -> dict[NotificationChannel, ChannelAdapter]:
    return {NotificationChannel.EMAIL: adapter}


@pytest.mark.asyncio
async def test_two_overlapping_dispatchers_send_a_notification_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    """Beat ticks overlap, workers run in parallel, acks-late tasks are redelivered."""
    address = f"{uuid4().hex[:10]}@example.test"
    notification_id = await _seed(database, address)
    adapter = RecordingAdapter(hold_address=address)

    first = asyncio.create_task(
        dispatch_pending(database, adapters=_adapters(adapter), settings=Settings())
    )
    await adapter.first_started.wait()  # the first dispatcher is inside the send

    # A second dispatcher starts while the first is still sending.
    second = await asyncio.wait_for(
        dispatch_pending(database, adapters=_adapters(adapter), settings=Settings()),
        timeout=20,
    )
    adapter.release.set()
    first_result = await first

    assert adapter.sends[address] == 1, "the notification was sent more than once"
    assert second["sent"] == 0
    assert first_result["sent"] >= 1
    row = await _row(database, notification_id)
    assert row.status == NotificationStatus.SENT.value
    assert row.attempts == 1


@pytest.mark.asyncio
async def test_concurrent_dispatchers_send_every_notification_exactly_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:8]
    addresses = [f"{tag}-{n}@example.test" for n in range(12)]
    ids = {address: await _seed(database, address) for address in addresses}
    adapter = RecordingAdapter()

    await asyncio.gather(
        *(
            dispatch_pending(database, adapters=_adapters(adapter), settings=Settings())
            for _ in range(4)
        )
    )

    assert {a: adapter.sends.get(a, 0) for a in addresses} == dict.fromkeys(
        addresses, 1
    )
    for notification_id in ids.values():
        row = await _row(database, notification_id)
        assert (row.status, row.attempts) == (NotificationStatus.SENT.value, 1)


@pytest.mark.asyncio
async def test_a_relay_skips_an_outbox_event_another_relay_is_processing(
    database: async_sessionmaker[AsyncSession],
) -> None:
    async with database() as session:
        event = OutboxEvent(
            event_type="NOT_A_REAL_CATEGORY",
            aggregate_type="test",
            aggregate_id=str(uuid4()),
            payload={},
        )
        session.add(event)
        await session.commit()
        event_id = event.id

    async with database() as holder:
        # Another relay is mid-way through this event: it holds the row.
        await holder.execute(
            select(OutboxEvent.id).where(OutboxEvent.id == event_id).with_for_update()
        )
        created = await asyncio.wait_for(
            _relay_one(database, event_id, Settings()), timeout=10
        )
        assert created == 0

        async with database() as observer:
            skipped = await observer.get(OutboxEvent, event_id)
            assert skipped is not None
            # Skipped, not failed: no spurious attempt or error was recorded.
            assert (skipped.processed_at, skipped.attempts, skipped.error) == (
                None,
                0,
                None,
            )
        await holder.rollback()

    # Once the other relay is done with it, the event is processed normally.
    await _relay_one(database, event_id, Settings())
    final = await _fetch_event(database, event_id)
    assert final.processed_at is not None


async def _fetch_event(
    database: async_sessionmaker[AsyncSession], event_id: str
) -> OutboxEvent:
    async with database() as session:
        found = await session.get(OutboxEvent, event_id)
        assert found is not None
        return found


class _Relays:
    """Gates that force one relay's failure to interleave with another's success."""

    def __init__(self) -> None:
        self.armed = False
        self.a_rolled_back = asyncio.Event()
        self.b_taken_over = asyncio.Event()
        self.b_at_commit = asyncio.Event()
        self.release_b = asyncio.Event()
        self.a_done = False
        self.b_gated = False


class _InterleavingSession(AsyncSession):
    control: _Relays | None = None

    async def rollback(self) -> None:
        await super().rollback()
        control = _InterleavingSession.control
        if control is not None and control.armed and not control.a_done:
            # Relay A has failed and released the event row. Hold it here until
            # relay B has taken the event over.
            control.a_done = True
            control.a_rolled_back.set()
            await control.b_taken_over.wait()

    async def commit(self) -> None:
        control = _InterleavingSession.control
        if (
            control is not None
            and control.armed
            and control.a_done
            and not control.b_gated
        ):
            # Relay B has done its work but has not committed: it still holds the row.
            control.b_gated = True
            control.b_at_commit.set()
            await control.release_b.wait()
        await super().commit()


@pytest.mark.asyncio
async def test_a_failed_relay_cannot_stamp_an_error_on_an_event_another_relay_completed(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Relay A fails and releases the event; relay B takes it over and succeeds.

    A then records its failure from a stale view in which the event still looks
    unprocessed, while B's commit is still pending. That write must not land on an
    event that is, by the time it executes, already processed.
    """
    import hms_backend.app.modules.notifications.service as service_module
    from hms_backend.app.modules.notifications.enums import RecipientType
    from hms_backend.app.modules.notifications.recipients import ResolvedRecipient

    async with database() as session:
        event = OutboxEvent(
            event_type="CERTIFICATE_ISSUED",
            aggregate_type="certificate",
            aggregate_id=str(uuid4()),
            payload={
                "customer_id": str(uuid4()),
                "asset_id": str(uuid4()),
                "asset_number": "HA-1",
                "certificate_number": "CERT-RELAY",
                "link": "https://example.test/verify/t",
            },
        )
        session.add(event)
        await session.commit()
        event_id = event.id

    calls = {"n": 0}

    async def resolve(*_args: object, **_kwargs: object) -> list[ResolvedRecipient]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("relay A failed while resolving recipients")
        return [
            ResolvedRecipient(
                recipient_type=RecipientType.CUSTOMER_CONTACT,
                recipient_id=str(uuid4()),
                email="contact@example.test",
                phone_e164=None,
                email_verified=True,
                phone_verified=False,
            )
        ]

    monkeypatch.setattr(service_module, "resolve_recipients", resolve)
    control = _Relays()
    _InterleavingSession.control = control
    interleaving = cast(
        "async_sessionmaker[AsyncSession]",
        async_sessionmaker(
            database.kw["bind"], class_=_InterleavingSession, expire_on_commit=False
        ),
    )
    control.armed = True
    try:
        relay_a = asyncio.create_task(_relay_one(interleaving, event_id, Settings()))
        await control.a_rolled_back.wait()  # A failed and released the event row

        relay_b = asyncio.create_task(_relay_one(interleaving, event_id, Settings()))
        await control.b_at_commit.wait()  # B has the row and is about to commit
        control.b_taken_over.set()  # now let A record its failure

        # A's write cannot complete while B holds the row, or it has nothing to write.
        await _wait_for_a_blocked_event_write(database)
        control.release_b.set()
        await asyncio.wait_for(asyncio.gather(relay_a, relay_b), timeout=20)
    finally:
        control.armed = False
        control.release_b.set()
        control.b_taken_over.set()
        _InterleavingSession.control = None

    try:
        final = await _fetch_event(database, event_id)
        assert final.processed_at is not None
        assert (final.attempts, final.error) == (0, None), (
            "relay A stamped its failure on an event relay B had completed"
        )
        async with database() as session:
            keys = (
                await session.scalars(
                    select(Notification.idempotency_key).where(
                        Notification.event_ref == event_id
                    )
                )
            ).all()
        assert len(keys) >= 1 and len(keys) == len(set(keys))  # B's rows, exactly once
    finally:
        # Leave no PENDING notification behind in the shared database.
        async with database() as session:
            await session.execute(
                delete(Notification).where(Notification.event_ref == event_id)
            )
            await session.execute(delete(OutboxEvent).where(OutboxEvent.id == event_id))
            await session.commit()


async def _wait_for_a_blocked_event_write(
    database: async_sessionmaker[AsyncSession],
) -> None:
    for _ in range(200):
        async with database() as session:
            blocked = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE wait_event_type = 'Lock' "
                    "AND query ILIKE '%notification_outbox%'"
                )
            )
        if blocked:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("relay A's failure write never blocked on the event row")
