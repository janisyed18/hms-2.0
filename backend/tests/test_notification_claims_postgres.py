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
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
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

    def __init__(self, hold_first: bool = False) -> None:
        self.sends: dict[str, int] = {}
        self._hold_first = hold_first
        self.first_started = asyncio.Event()
        self.release = asyncio.Event()

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        count = self.sends.get(message.to_address, 0) + 1
        self.sends[message.to_address] = count
        if self._hold_first and count == 1:
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
    adapter = RecordingAdapter(hold_first=True)

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
