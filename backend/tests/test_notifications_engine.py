"""Notification engine integration tests (N-01, N-02, N-06, N-07, N-09, N-11).

Uses an in-memory DB and fake channel adapters, so the relay -> dispatch ->
scheduler pipeline runs without Redis/Celery or real providers.
"""

from collections.abc import AsyncGenerator
from datetime import date, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import Settings
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer, CustomerContact
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.notifications.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationStatus,
)
from hms_backend.app.modules.notifications.models import (
    Notification,
    OutboxEvent,
)
from hms_backend.app.modules.notifications.outbox import emit_event
from hms_backend.app.modules.notifications.service import (
    dispatch_pending,
    relay_outbox,
    run_retest_scheduler,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

SessionFactory = async_sessionmaker[AsyncSession]


class _OkAdapter:
    def __init__(self, channel: NotificationChannel) -> None:
        self.channel = channel
        self.sent: list[OutgoingMessage] = []

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        self.sent.append(message)
        return DeliveryResult(success=True, provider_message_id="ok-1")


class _FailAdapter:
    def __init__(self, channel: NotificationChannel) -> None:
        self.channel = channel

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        return DeliveryResult(success=False, error="provider down")


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def _seed_customer_asset(session: AsyncSession) -> tuple[str, str]:
    product = Product(category="Hydraulic", code="HP", name="Hose")
    customer = Customer(code="ACME", name="Acme")
    session.add(
        CustomerContact(
            customer=customer,
            name="Site Contact",
            email="contact@acme.example",
            email_verified=True,
        )
    )
    asset = Asset(
        customer=customer,
        product=product,
        asset_number="HA-1",
        lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
    )
    session.add(asset)
    await session.flush()
    return customer.id, asset.id


async def _emit_cert_issued(
    session_factory: SessionFactory,
    customer_id: str,
    asset_id: str,
) -> None:
    async with session_factory() as session:
        await emit_event(
            session,
            category=NotificationCategory.CERTIFICATE_ISSUED,
            aggregate_type="certificate",
            aggregate_id="cert-1",
            payload={
                "customer_id": customer_id,
                "asset_id": asset_id,
                "asset_number": "HA-1",
                "certificate_number": "CERT-1",
                "link": "https://x/verify/t",
            },
        )
        await session.commit()


# --- N-01: transactional outbox --------------------------------------------------


@pytest.mark.asyncio
async def test_outbox_rollback_emits_nothing(
    session_factory: SessionFactory,
) -> None:
    async with session_factory() as session:
        await emit_event(
            session,
            category=NotificationCategory.CERTIFICATE_ISSUED,
            aggregate_type="certificate",
            aggregate_id="c1",
            payload={},
        )
        await session.rollback()
    async with session_factory() as session:
        count = await session.scalar(select(Notification.id))
        events = (await session.scalars(select(OutboxEvent))).all()
    assert events == []
    assert count is None


# --- N-07 / N-09: relay creates notifications idempotently -----------------------


@pytest.mark.asyncio
async def test_relay_creates_and_is_idempotent(
    session_factory: SessionFactory,
) -> None:
    async with session_factory() as session:
        customer_id, asset_id = await _seed_customer_asset(session)
        await session.commit()
    await _emit_cert_issued(session_factory, customer_id, asset_id)

    first = await relay_outbox(session_factory)
    assert first["created"] == 1  # one email to the verified contact

    async with session_factory() as session:
        notifs = (await session.scalars(select(Notification))).all()
        pending = [n for n in notifs if n.status == NotificationStatus.PENDING.value]
        suppressed = [
            n for n in notifs if n.status == NotificationStatus.SUPPRESSED.value
        ]
        assert len(pending) == 1
        assert pending[0].channel == NotificationChannel.EMAIL.value
        assert pending[0].customer_id == customer_id
        # SMS suppressed (contact has no verified phone) — recorded for audit.
        assert any(n.channel == NotificationChannel.SMS.value for n in suppressed)

    # Re-running the relay processes no new events and creates no duplicates.
    second = await relay_outbox(session_factory)
    assert second["processed"] == 0
    async with session_factory() as session:
        assert len((await session.scalars(select(Notification))).all()) == len(notifs)


@pytest.mark.asyncio
async def test_relay_resolves_user_recipients_from_oidc_subject(
    session_factory: SessionFactory,
) -> None:
    async with session_factory() as session:
        reviewer = User(
            oidc_subject="reviewer-oidc",
            email="reviewer@example.com",
            role="REVIEWER",
            email_verified=True,
        )
        session.add(reviewer)
        await session.flush()
        reviewer_id = reviewer.id
        await emit_event(
            session,
            category=NotificationCategory.INSPECTION_SUBMITTED,
            aggregate_type="inspection",
            aggregate_id="inspection-1",
            payload={
                "inspection_id": "inspection-1",
                "asset_id": "asset-1",
                "asset_number": "HA-1",
                "reviewer_user_id": "reviewer-oidc",
            },
        )
        await session.commit()

    result = await relay_outbox(session_factory)
    assert result["created"] == 2
    async with session_factory() as session:
        notifications = (await session.scalars(select(Notification))).all()
    assert {n.recipient_id for n in notifications} == {reviewer_id}


# --- N-06: dispatch, retry, dead-letter ------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_sends_pending(session_factory: SessionFactory) -> None:
    async with session_factory() as session:
        customer_id, asset_id = await _seed_customer_asset(session)
        await session.commit()
    await _emit_cert_issued(session_factory, customer_id, asset_id)
    await relay_outbox(session_factory)

    adapters: dict[NotificationChannel, ChannelAdapter] = {
        NotificationChannel.EMAIL: _OkAdapter(NotificationChannel.EMAIL)
    }
    result = await dispatch_pending(session_factory, adapters=adapters)
    assert result["sent"] == 1
    async with session_factory() as session:
        n = (
            await session.scalars(
                select(Notification).where(
                    Notification.status == NotificationStatus.SENT.value
                )
            )
        ).one()
        assert n.provider_message_id == "ok-1"
        assert n.attempts == 1


@pytest.mark.asyncio
async def test_dispatch_dead_letters_after_max_attempts(
    session_factory: SessionFactory,
) -> None:
    async with session_factory() as session:
        customer_id, asset_id = await _seed_customer_asset(session)
        await session.commit()
    await _emit_cert_issued(session_factory, customer_id, asset_id)
    await relay_outbox(session_factory)

    settings = Settings(notification_max_attempts=1)
    adapters: dict[NotificationChannel, ChannelAdapter] = {
        NotificationChannel.EMAIL: _FailAdapter(NotificationChannel.EMAIL)
    }
    await dispatch_pending(session_factory, adapters=adapters, settings=settings)
    async with session_factory() as session:
        n = (await session.scalars(select(Notification))).first()
        assert n is not None
        assert n.status == NotificationStatus.DEAD_LETTER.value
        assert n.error == "provider down"


# --- N-02 / N-11: scheduler ------------------------------------------------------


@pytest.mark.asyncio
async def test_scheduler_emits_retest_due_idempotently(
    session_factory: SessionFactory,
) -> None:
    today = date(2026, 7, 7)
    async with session_factory() as session:
        customer_id, asset_id = await _seed_customer_asset(session)
        session.add(
            RetestSchedule(
                customer_id=customer_id,
                asset_id=asset_id,
                due_at=today,  # due today
                status=RetestScheduleStatus.DUE.value,
                reminder_interval_days=30,
                escalation_interval_days=7,
            )
        )
        await session.commit()

    first = await run_retest_scheduler(session_factory, today=today)
    assert first["emitted"] == 1
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == NotificationCategory.RETEST_DUE.value
                )
            )
        ).all()
        assert len(events) == 1

    # A second run the same day must not duplicate the event (dedupe key).
    second = await run_retest_scheduler(session_factory, today=today)
    assert second["emitted"] == 0


@pytest.mark.asyncio
async def test_scheduler_emits_overdue_escalation(
    session_factory: SessionFactory,
) -> None:
    due = date(2026, 7, 1)
    today = due + timedelta(days=7)  # first escalation step
    async with session_factory() as session:
        customer_id, asset_id = await _seed_customer_asset(session)
        session.add(
            RetestSchedule(
                customer_id=customer_id,
                asset_id=asset_id,
                due_at=due,
                status=RetestScheduleStatus.OVERDUE.value,
                reminder_interval_days=30,
                escalation_interval_days=7,
            )
        )
        await session.commit()

    await run_retest_scheduler(session_factory, today=today)
    async with session_factory() as session:
        event = (
            await session.scalars(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == NotificationCategory.RETEST_OVERDUE.value
                )
            )
        ).one()
        assert event.payload["days_overdue"] == 7
        assert event.payload["escalation_level"] == 1
