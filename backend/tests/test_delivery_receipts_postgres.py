"""Parked delivery receipts under real PostgreSQL concurrency."""

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
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.enums import NotificationStatus
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent
from hms_backend.app.modules.notifications.outbox import (
    RECEIPT_EVENT_TYPE,
    defer_receipt,
    receipt_dedupe_key,
)
from hms_backend.app.modules.notifications.service import apply_deferred_receipts

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


async def _seed_sent(
    database: async_sessionmaker[AsyncSession], provider_message_id: str
) -> str:
    async with database() as session:
        notification = Notification(
            event_ref=f"event-{uuid4().hex[:8]}",
            category="CERTIFICATE_ISSUED",
            tier="IMPORTANT",
            recipient_type="USER",
            recipient_id=str(uuid4()),
            recipient_address="receipt@example.test",
            channel="EMAIL",
            template_key="certificate_issued",
            subject="Certificate issued",
            body="Your certificate has been issued.",
            status=NotificationStatus.SENT.value,
            provider_message_id=provider_message_id,
            attempts=1,
            idempotency_key=uuid4().hex + uuid4().hex,
            scheduled_for=datetime.now(UTC),
        )
        session.add(notification)
        await session.commit()
        return notification.id


async def _cleanup(
    database: async_sessionmaker[AsyncSession], provider_message_id: str
) -> None:
    async with database() as session:
        await session.execute(
            delete(Notification).where(
                Notification.provider_message_id == provider_message_id
            )
        )
        await session.execute(
            delete(OutboxEvent).where(
                OutboxEvent.dedupe_key.in_(
                    [
                        receipt_dedupe_key(provider_message_id, status)
                        for status in NotificationStatus
                    ]
                )
            )
        )
        await session.commit()


async def _wait_until_blocked(
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
async def test_a_sweep_leaves_a_receipt_another_sweep_holds_and_applies_it_later(
    database: async_sessionmaker[AsyncSession],
) -> None:
    pmid = f"sweep-{uuid4().hex}"
    nid = await _seed_sent(database, pmid)
    async with database() as session:
        event = await defer_receipt(
            session, provider_message_id=pmid, status=NotificationStatus.DELIVERED
        )
        await session.commit()
        assert event is not None
        event_id = event.id
    try:
        async with database() as holder:
            # Another sweep is applying this receipt right now: it holds the row.
            await holder.execute(
                select(OutboxEvent.id)
                .where(OutboxEvent.id == event_id)
                .with_for_update()
            )
            result = await asyncio.wait_for(
                apply_deferred_receipts(database, settings=Settings()), timeout=10
            )
            # Skipped, not applied twice and not blocked behind the holder.
            assert result["applied"] == 0
            async with database() as observer:
                assert (await observer.get(Notification, nid)).status == "SENT"  # type: ignore[union-attr]
            await holder.rollback()

        later = await apply_deferred_receipts(database, settings=Settings())
        assert later["applied"] >= 1
        async with database() as observer:
            final = await observer.get(Notification, nid)
            assert final is not None and final.status == "DELIVERED"
    finally:
        await _cleanup(database, pmid)


@pytest.mark.asyncio
async def test_a_provider_retry_racing_the_first_delivery_parks_one_receipt(
    database: async_sessionmaker[AsyncSession],
) -> None:
    pmid = f"retry-{uuid4().hex}"
    try:
        async with database() as first, database() as second:
            parked = await defer_receipt(
                first, provider_message_id=pmid, status=NotificationStatus.DELIVERED
            )
            assert parked is not None  # inserted, not yet committed

            retry = asyncio.create_task(
                defer_receipt(
                    second,
                    provider_message_id=pmid,
                    status=NotificationStatus.DELIVERED,
                )
            )
            # The retry reaches the unique key and waits for the first to commit.
            await _wait_until_blocked(database, "notification_outbox")
            assert not retry.done()
            await first.commit()

            # It loses the race cleanly: no error, and nothing parked a second time.
            assert await asyncio.wait_for(retry, timeout=10) is None
            await second.commit()

        async with database() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(OutboxEvent)
                .where(
                    OutboxEvent.event_type == RECEIPT_EVENT_TYPE,
                    OutboxEvent.dedupe_key
                    == receipt_dedupe_key(pmid, NotificationStatus.DELIVERED),
                )
            )
        assert count == 1
    finally:
        await _cleanup(database, pmid)
