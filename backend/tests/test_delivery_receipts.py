"""Provider delivery receipts that arrive before we know the provider message id.

A provider accepts a message and starts its own clock: its delivery webhook can reach us
before ``adapter.send`` has even returned, and so before the dispatcher has stored the
``provider_message_id`` the receipt is keyed on. The webhook endpoint answers 2xx so the
provider does not retry, which means a receipt that matches nothing would be lost for
good, leaving a bounced message recorded as merely "sent". The endpoint therefore parks
such a receipt, and the relay applies it once the notification is identifiable.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import Settings
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
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
from hms_backend.app.modules.notifications.outbox import (
    RECEIPT_EVENT_TYPE,
    receipt_dedupe_key,
)
from hms_backend.app.modules.notifications.service import (
    apply_deferred_receipts,
    dispatch_pending,
    relay_outbox,
)

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
WEBHOOK = "/api/v1/notifications/webhooks/generic"


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def webhook_client(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def post_receipt(
    factory: async_sessionmaker[AsyncSession],
    provider_message_id: str,
    status: NotificationStatus,
) -> dict[str, int]:
    async with webhook_client(factory) as client:
        response = await client.post(
            WEBHOOK,
            json={"provider_message_id": provider_message_id, "status": status.value},
        )
    assert response.status_code == 200, response.text
    body: dict[str, int] = response.json()
    return body


async def seed(factory: async_sessionmaker[AsyncSession], **overrides: Any) -> str:
    values: dict[str, Any] = {
        "event_ref": f"event-{uuid4().hex[:8]}",
        "category": "CERTIFICATE_ISSUED",
        "tier": "IMPORTANT",
        "recipient_type": "USER",
        "recipient_id": str(uuid4()),
        "recipient_address": "early@example.test",
        "channel": "EMAIL",
        "template_key": "certificate_issued",
        "subject": "Certificate issued",
        "body": "Your certificate has been issued.",
        "status": NotificationStatus.PENDING.value,
        "idempotency_key": uuid4().hex + uuid4().hex,
        "scheduled_for": NOW - timedelta(minutes=1),
    }
    values.update(overrides)
    async with factory() as session:
        notification = Notification(**values)
        session.add(notification)
        await session.commit()
        return notification.id


async def row(
    factory: async_sessionmaker[AsyncSession], notification_id: str
) -> Notification:
    async with factory() as session:
        found = await session.get(Notification, notification_id)
        assert found is not None
        return found


async def parked(
    factory: async_sessionmaker[AsyncSession],
) -> list[OutboxEvent]:
    async with factory() as session:
        return list(
            (
                await session.scalars(
                    select(OutboxEvent)
                    .where(OutboxEvent.event_type == RECEIPT_EVENT_TYPE)
                    .order_by(OutboxEvent.occurred_at)
                )
            ).all()
        )


class EarlyReceiptAdapter:
    """Accepts the message, and the provider's webhook lands before ``send`` returns."""

    channel = NotificationChannel.EMAIL

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        receipts: list[NotificationStatus],
        provider_message_id: str = "provider-msg-1",
    ) -> None:
        self._factory = factory
        self._receipts = receipts
        self.provider_message_id = provider_message_id
        self.responses: list[dict[str, int]] = []

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        for status in self._receipts:
            self.responses.append(
                await post_receipt(self._factory, self.provider_message_id, status)
            )
        return DeliveryResult(
            success=True, provider_message_id=self.provider_message_id
        )


def adapters(adapter: Any) -> dict[NotificationChannel, ChannelAdapter]:
    return {NotificationChannel.EMAIL: adapter}


@pytest.mark.asyncio
async def test_an_early_delivered_receipt_is_kept_and_applied(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(factory)
    adapter = EarlyReceiptAdapter(factory, [NotificationStatus.DELIVERED])

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    # The webhook could not match anything yet; it answered 2xx but kept the receipt.
    assert adapter.responses == [{"updated": 0, "deferred": 1}]
    assert len(await parked(factory)) == 1
    assert (await row(factory, nid)).status == NotificationStatus.SENT.value

    swept = await relay_outbox(factory, settings=Settings())

    final = await row(factory, nid)
    assert final.provider_message_id == "provider-msg-1"
    assert final.status == NotificationStatus.DELIVERED.value
    assert final.delivered_at is not None
    assert swept["receipts_applied"] == 1
    (event,) = await parked(factory)
    assert event.processed_at is not None and event.error is None


@pytest.mark.asyncio
async def test_a_bounce_that_arrives_early_is_not_left_recorded_as_sent(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(factory)
    adapter = EarlyReceiptAdapter(factory, [NotificationStatus.BOUNCED])

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )
    await relay_outbox(factory, settings=Settings())

    final = await row(factory, nid)
    assert final.status == NotificationStatus.BOUNCED.value
    assert final.failed_at is not None


@pytest.mark.asyncio
async def test_a_provider_retrying_the_same_receipt_parks_it_once(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    first = await post_receipt(factory, "retry-1", NotificationStatus.DELIVERED)
    again = await post_receipt(factory, "retry-1", NotificationStatus.DELIVERED)

    assert first == {"updated": 0, "deferred": 1}
    assert again == {"updated": 0, "deferred": 0}
    assert len(await parked(factory)) == 1


@pytest.mark.asyncio
async def test_a_receipt_waits_for_its_notification_then_applies_once(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    await post_receipt(factory, "late-id", NotificationStatus.DELIVERED)

    waiting = await relay_outbox(factory, settings=Settings())
    assert waiting["receipts_applied"] == 0
    (event,) = await parked(factory)
    assert event.processed_at is None  # still waiting, not discarded

    nid = await seed(
        factory,
        status=NotificationStatus.SENT.value,
        provider_message_id="late-id",
        attempts=1,
    )
    applied = await relay_outbox(factory, settings=Settings())

    assert applied["receipts_applied"] == 1
    assert (await row(factory, nid)).status == NotificationStatus.DELIVERED.value
    # Applied exactly once: a further sweep finds nothing to do.
    assert (await relay_outbox(factory, settings=Settings()))["receipts_applied"] == 0


@pytest.mark.asyncio
async def test_parked_receipts_are_applied_in_the_order_they_were_received(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    await post_receipt(factory, "ordered", NotificationStatus.DELIVERED)
    await post_receipt(factory, "ordered", NotificationStatus.BOUNCED)
    async with factory() as session:
        delivered_event, bounced_event = (
            (await parked(factory))[0],
            (await parked(factory))[1],
        )
        for offset, event in ((2, delivered_event), (1, bounced_event)):
            await session.execute(
                update(OutboxEvent)
                .where(OutboxEvent.id == event.id)
                .values(occurred_at=NOW - timedelta(minutes=offset))
            )
        await session.commit()
    nid = await seed(
        factory,
        status=NotificationStatus.SENT.value,
        provider_message_id="ordered",
        attempts=1,
    )

    await apply_deferred_receipts(factory, settings=Settings(), now=NOW)

    # DELIVERED came first and BOUNCED last, so the later report is the final state.
    assert (await row(factory, nid)).status == NotificationStatus.BOUNCED.value


@pytest.mark.asyncio
async def test_a_receipt_that_never_matches_is_retired_after_the_retention_window(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    await post_receipt(factory, "nobody-knows", NotificationStatus.DELIVERED)
    settings = Settings(notification_receipt_retention_hours=48)

    soon = await apply_deferred_receipts(
        factory, settings=settings, now=datetime.now(UTC) + timedelta(hours=47)
    )
    # A receipt that is merely waiting is not examined at all (that is what keeps it
    # from crowding out ready ones), so nothing is reported for it.
    assert soon == {"applied": 0, "expired": 0, "waiting": 0}
    assert [e.processed_at for e in await parked(factory)] == [None]

    later = await apply_deferred_receipts(
        factory, settings=settings, now=datetime.now(UTC) + timedelta(hours=49)
    )
    assert later == {"applied": 0, "expired": 1, "waiting": 0}
    (event,) = await parked(factory)
    assert event.processed_at is not None
    assert event.error == "no matching notification"


@pytest.mark.asyncio
async def test_unmatched_receipts_never_crowd_out_real_notification_events(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    """Stuck receipts are older than the event; a batch of one must still reach it."""
    for n in range(5):
        await post_receipt(factory, f"stuck-{n}", NotificationStatus.DELIVERED)
    async with factory() as session:
        await session.execute(
            update(OutboxEvent).values(occurred_at=NOW - timedelta(hours=1))
        )
        event = OutboxEvent(
            event_type="NOT_A_REAL_CATEGORY",
            aggregate_type="test",
            aggregate_id=str(uuid4()),
            payload={},
            occurred_at=NOW,
        )
        session.add(event)
        await session.commit()
        event_id = event.id

    result = await relay_outbox(factory, settings=Settings(), limit=1)

    assert result["processed"] == 1
    async with factory() as session:
        handled = await session.get(OutboxEvent, event_id)
        assert handled is not None and handled.processed_at is not None


@pytest.mark.asyncio
async def test_a_malformed_parked_receipt_is_retired_at_expiry_not_kept_forever(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with factory() as session:
        session.add(
            OutboxEvent(
                event_type=RECEIPT_EVENT_TYPE,
                aggregate_type="delivery_receipt",
                aggregate_id=str(uuid4()),
                payload={"provider_message_id": "x", "status": "NOT_A_STATUS"},
                dedupe_key=f"receipt:malformed:{uuid4().hex}",
            )
        )
        await session.commit()
    settings = Settings(notification_receipt_retention_hours=48)

    early = await apply_deferred_receipts(factory, settings=settings)
    assert early == {"applied": 0, "expired": 0, "waiting": 0}

    late = await apply_deferred_receipts(
        factory, settings=settings, now=datetime.now(UTC) + timedelta(hours=49)
    )

    assert late == {"applied": 0, "expired": 1, "waiting": 0}
    (event,) = await parked(factory)
    assert event.error == "malformed delivery receipt"


@pytest.mark.asyncio
async def test_waiting_receipts_never_starve_a_receipt_that_is_ready(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    """More unmatched receipts than one sweep covers must not hide a matchable one."""
    limit = 3
    for n in range(limit + 2):
        await post_receipt(factory, f"never-matches-{n}", NotificationStatus.DELIVERED)
    async with factory() as session:  # the waiting receipts are the oldest
        await session.execute(
            update(OutboxEvent).values(occurred_at=NOW - timedelta(hours=1))
        )
        await session.commit()
    # A later receipt, parked because its notification had no provider id yet...
    await post_receipt(factory, "ready-now", NotificationStatus.DELIVERED)
    # ...and the notification has since been given it, so this receipt is ready.
    nid = await seed(
        factory,
        status=NotificationStatus.SENT.value,
        provider_message_id="ready-now",
        attempts=1,
    )
    async with factory() as session:
        ready = await session.scalar(
            select(OutboxEvent).where(
                OutboxEvent.dedupe_key
                == receipt_dedupe_key("ready-now", NotificationStatus.DELIVERED)
            )
        )
        assert ready is not None
        ready.occurred_at = NOW  # newest of all
        await session.commit()

    result = await apply_deferred_receipts(
        factory, settings=Settings(), now=NOW + timedelta(minutes=1), limit=limit
    )

    # It is applied now, not after the older unmatched receipts expire (48 h).
    assert (await row(factory, nid)).status == NotificationStatus.DELIVERED.value
    assert result["applied"] == 1
    waiting = [e for e in await parked(factory) if e.processed_at is None]
    assert len(waiting) == limit + 2  # none of the unmatched ones was retired


@pytest.mark.asyncio
async def test_expired_receipts_are_retired_steadily_past_a_small_sweep_limit(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    for n in range(4):
        await post_receipt(factory, f"old-{n}", NotificationStatus.DELIVERED)
    async with factory() as session:
        await session.execute(
            update(OutboxEvent).values(occurred_at=NOW - timedelta(hours=60))
        )
        await session.commit()
    settings = Settings(notification_receipt_retention_hours=48)

    first = await apply_deferred_receipts(factory, settings=settings, now=NOW, limit=2)
    second = await apply_deferred_receipts(factory, settings=settings, now=NOW, limit=2)

    assert (first["expired"], second["expired"]) == (2, 2)  # steady progress
    assert all(e.processed_at is not None for e in await parked(factory))
