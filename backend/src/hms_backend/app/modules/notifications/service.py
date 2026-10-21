"""Notification engine: relay (outbox -> notifications), dispatcher (send +
retry + dead-letter), and the daily scheduler.

All functions take a ``session_factory`` and process each unit in its own
transaction so one failure never rolls back the rest. They are invoked from
Celery tasks, and are directly unit-testable with an in-memory session factory.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as default_settings
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import NON_CERTIFIABLE_ASSET_STATUSES
from hms_backend.app.modules.notifications.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.channels.registry import (
    get_channel_adapters,
)
from hms_backend.app.modules.notifications.claims import (
    Claim,
    claim,
    finalise,
    requeue_expired_claims,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationStatus,
)
from hms_backend.app.modules.notifications.idempotency import (
    notification_idempotency_key,
)
from hms_backend.app.modules.notifications.models import (
    Notification,
    NotificationPreference,
    OutboxEvent,
)
from hms_backend.app.modules.notifications.outbox import emit_event_if_absent
from hms_backend.app.modules.notifications.policy import (
    RecipientContext,
    policy_for,
    resolve_channels,
)
from hms_backend.app.modules.notifications.recipients import (
    ResolvedRecipient,
    resolve_recipients,
)
from hms_backend.app.modules.notifications.templates import render
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

logger = logging.getLogger("hms_backend.notifications.service")

# Retest schedules in these states are still actionable for reminders.
_ACTIVE_SCHEDULE_STATUSES = (
    RetestScheduleStatus.UPCOMING.value,
    RetestScheduleStatus.DUE.value,
    RetestScheduleStatus.OVERDUE.value,
)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _opt_str(value: Any) -> str | None:
    return str(value) if value else None


# --- Relay: committed outbox events -> notification rows -------------------------


async def relay_outbox(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    settings: Settings | None = None,
    limit: int = 100,
) -> dict[str, int]:
    settings = settings or default_settings
    async with session_factory() as session:
        event_ids = list(
            (
                await session.scalars(
                    select(OutboxEvent.id)
                    .where(OutboxEvent.processed_at.is_(None))
                    .order_by(OutboxEvent.occurred_at)
                    .limit(limit)
                )
            ).all()
        )

    processed = 0
    created = 0
    for event_id in event_ids:
        outcome = await _relay_one(session_factory, event_id, settings)
        processed += 1
        created += outcome
    return {"processed": processed, "created": created}


async def _relay_one(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    settings: Settings,
) -> int:
    async with session_factory() as session:
        # Claim the event row. A relay that finds it locked by another relay skips it,
        # so two relays never both materialise (and then collide on) the same event.
        event = await session.scalar(
            select(OutboxEvent)
            .where(OutboxEvent.id == event_id)
            .with_for_update(skip_locked=True)
        )
        if event is None or event.processed_at is not None:
            return 0
        try:
            category = NotificationCategory(event.event_type)
        except ValueError:
            event.processed_at = _utc_now()
            event.error = f"unknown event type {event.event_type}"
            await session.commit()
            return 0

        created = 0
        try:
            recipients = await resolve_recipients(session, category, event.payload)
            for recipient in recipients:
                created += await _materialise(
                    session, event, category, recipient, settings
                )
            event.processed_at = _utc_now()
            await session.commit()
        except Exception as exc:  # noqa: BLE001 - isolate one event's failure
            await session.rollback()
            async with session_factory() as retry_session:
                ev = await retry_session.get(OutboxEvent, event_id)
                # Only an event that is still unprocessed has failed: one another
                # relay already completed must not be marked with a spurious error.
                if ev is not None and ev.processed_at is None:
                    ev.attempts += 1
                    ev.error = str(exc)
                    await retry_session.commit()
            logger.warning("relay failed for event %s: %s", event_id, exc)
        return created


async def _materialise(
    session: AsyncSession,
    event: OutboxEvent,
    category: NotificationCategory,
    recipient: ResolvedRecipient,
    settings: Settings,
) -> int:
    context = await _recipient_context(session, recipient, category)
    decision = resolve_channels(category, context)
    tier = policy_for(category).tier
    payload = event.payload
    created = 0

    to_create: list[tuple[NotificationChannel, str, str | None]] = [
        (channel, NotificationStatus.PENDING.value, None)
        for channel in decision.channels
    ]
    # Record policy-suppressed channels for an audit trail of opt-outs (N-09/N-10).
    to_create += [
        (channel, NotificationStatus.SUPPRESSED.value, reason)
        for channel, reason in decision.suppressed
    ]

    for channel, status, reason in to_create:
        key = notification_idempotency_key(
            event_ref=event.id,
            recipient_type=recipient.recipient_type,
            recipient_id=recipient.recipient_id,
            channel=channel,
        )
        exists = await session.scalar(
            select(Notification.id).where(Notification.idempotency_key == key)
        )
        if exists is not None:
            continue

        address = (
            recipient.email if channel is NotificationChannel.EMAIL
            else recipient.phone_e164 if channel is NotificationChannel.SMS
            else None
        )
        rendered = render(
            category,
            channel,
            dict(payload),
            sender_name=settings.notification_sender_name,
            issuer_identifier=settings.issuer_identifier,
            unsubscribe_url=_unsubscribe_url(settings, recipient, category),
        )
        session.add(
            Notification(
                event_ref=event.id,
                category=category.value,
                tier=tier.value,
                recipient_type=recipient.recipient_type.value,
                recipient_id=recipient.recipient_id,
                recipient_address=address,
                channel=channel.value,
                template_key=rendered.template_key,
                template_version=rendered.template_version,
                subject=rendered.subject or None,
                body=rendered.body_text,
                body_html=rendered.body_html,
                status=status,
                idempotency_key=key,
                error=reason,
                scheduled_for=_utc_now(),
                customer_id=_opt_str(payload.get("customer_id")),
                asset_id=_opt_str(payload.get("asset_id")),
            )
        )
        if status == NotificationStatus.PENDING.value:
            created += 1
    return created


async def _recipient_context(
    session: AsyncSession,
    recipient: ResolvedRecipient,
    category: NotificationCategory,
) -> RecipientContext:
    prefs = (
        await session.scalars(
            select(NotificationPreference).where(
                NotificationPreference.party_type == recipient.party_type,
                NotificationPreference.party_id == recipient.recipient_id,
                NotificationPreference.category == category.value,
            )
        )
    ).all()
    sms_opted_in = False
    email_unsubscribed = False
    for pref in prefs:
        if pref.channel == NotificationChannel.SMS.value:
            sms_opted_in = pref.opted_in
        elif pref.channel == NotificationChannel.EMAIL.value and not pref.opted_in:
            email_unsubscribed = True
    return RecipientContext(
        email=recipient.email,
        phone_e164=recipient.phone_e164,
        email_verified=recipient.email_verified,
        phone_verified=recipient.phone_verified,
        sms_opted_in=sms_opted_in,
        email_unsubscribed=email_unsubscribed,
    )


def _unsubscribe_url(
    settings: Settings,
    recipient: ResolvedRecipient,
    category: NotificationCategory,
) -> str:
    base = settings.public_base_url.rstrip("/")
    return (
        f"{base}/api/v1/notifications/unsubscribe"
        f"?party_type={recipient.party_type}&party_id={recipient.recipient_id}"
        f"&category={category.value}"
    )


# --- Dispatcher: claim, send, record -----------------------------------------------


async def dispatch_pending(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    adapters: dict[NotificationChannel, ChannelAdapter] | None = None,
    settings: Settings | None = None,
    limit: int = 100,
    now: datetime | None = None,
) -> dict[str, int]:
    adapters = adapters or get_channel_adapters()
    settings = settings or default_settings

    def clock() -> datetime:
        return now if now is not None else _utc_now()

    # Claims whose holder died or hung are resolved first: requeued, or dead-lettered
    # once they have used their attempts (see ``claims``).
    await requeue_expired_claims(
        session_factory,
        Notification,
        now=clock(),
        max_attempts=settings.notification_max_attempts,
    )
    async with session_factory() as session:
        ids = list(
            (
                await session.scalars(
                    select(Notification.id)
                    .where(
                        Notification.status == NotificationStatus.PENDING.value,
                        or_(
                            Notification.scheduled_for.is_(None),
                            Notification.scheduled_for <= clock(),
                        ),
                    )
                    .order_by(Notification.created_at)
                    .limit(limit)
                )
            ).all()
        )

    sent = 0
    failed = 0
    for notification_id in ids:
        try:
            result = await _dispatch_one(
                session_factory, notification_id, adapters, settings, clock
            )
        except Exception:  # noqa: BLE001 - one notification must not stop the batch
            logger.exception("dispatch failed for notification %s", notification_id)
            continue
        if result == "sent":
            sent += 1
        elif result == "dead_letter":
            failed += 1
    return {"sent": sent, "dead_letter": failed}


async def _dispatch_one(
    session_factory: async_sessionmaker[AsyncSession],
    notification_id: str,
    adapters: dict[NotificationChannel, ChannelAdapter],
    settings: Settings,
    clock: Callable[[], datetime],
) -> str:
    # Durable claim first: only the holder of a claim may send, so two overlapping
    # dispatchers can never send the same notification.
    held = await claim(
        session_factory,
        Notification,
        notification_id,
        now=clock(),
        lease_seconds=settings.notification_claim_lease_seconds,
    )
    if held is None:
        return "skip"

    async with session_factory() as session:
        n = await session.get(Notification, notification_id)
        if n is None:
            return "skip"
        channel = NotificationChannel(n.channel)
        message = OutgoingMessage(
            channel=channel,
            to_address=n.recipient_address or "",
            subject=n.subject,
            body_text=n.body,
            body_html=n.body_html,
        )
        address_missing = n.recipient_address is None
    adapter = adapters.get(channel)

    needs_address = channel is not NotificationChannel.IN_APP
    if adapter is None or (needs_address and address_missing):
        await _record(
            session_factory,
            held,
            {
                "status": NotificationStatus.FAILED.value,
                "failed_at": clock(),
                "error": "no adapter or address",
            },
        )
        return "failed"

    try:
        result = await adapter.send(message)
    except Exception as exc:  # noqa: BLE001 - a raising adapter is a failed attempt
        result = DeliveryResult(success=False, error=type(exc).__name__)

    finished = clock()
    if result.success:
        await _record(
            session_factory,
            held,
            {
                "status": NotificationStatus.SENT.value,
                "sent_at": finished,
                "provider_message_id": result.provider_message_id,
                "error": None,
            },
        )
        return "sent"

    if held.token >= settings.notification_max_attempts:
        await _record(
            session_factory,
            held,
            {
                "status": NotificationStatus.DEAD_LETTER.value,
                "failed_at": finished,
                "error": result.error,
            },
        )
        return "dead_letter"
    # Retry later with linear backoff.
    await _record(
        session_factory,
        held,
        {
            "status": NotificationStatus.PENDING.value,
            "error": result.error,
            "scheduled_for": finished
            + timedelta(
                seconds=settings.notification_retry_backoff_seconds * held.token
            ),
        },
    )
    return "retry"


async def _record(
    session_factory: async_sessionmaker[AsyncSession],
    held: Claim,
    values: dict[str, Any],
) -> None:
    """Write the outcome fenced by the claim; never let it abort the batch."""
    try:
        applied = await finalise(session_factory, Notification, held, values)
    except Exception:
        # The message may already have been sent. The row stays SENDING, so it is not
        # re-sent before the lease expires; log what an operator needs to reconcile.
        logger.exception(
            "could not record the outcome for notification %s (attempt %s, "
            "provider message id %s)",
            held.row_id,
            held.token,
            values.get("provider_message_id"),
        )
        return
    if not applied:
        logger.error(
            "lost the claim on notification %s (attempt %s) before recording its "
            "outcome; it may be sent again",
            held.row_id,
            held.token,
        )


# --- Scheduler: daily retest reminders + overdue escalation ----------------------


async def run_retest_scheduler(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    settings: Settings | None = None,
    today: date | None = None,
) -> dict[str, int]:
    settings = settings or default_settings
    today = today or _utc_now().date()
    emitted = 0

    async with session_factory() as session:
        schedules = (
            await session.scalars(
                select(RetestSchedule)
                .join(Asset, Asset.id == RetestSchedule.asset_id)
                .where(
                    RetestSchedule.deleted_at.is_(None),
                    RetestSchedule.status.in_(_ACTIVE_SCHEDULE_STATUSES),
                    Asset.deleted_at.is_(None),
                    Asset.lifecycle_status.notin_(NON_CERTIFIABLE_ASSET_STATUSES),
                )
            )
        ).all()

        for schedule in schedules:
            asset = schedule.asset
            due = schedule.due_at
            base: dict[str, Any] = {
                "customer_id": schedule.customer_id,
                "asset_id": asset.id,
                "asset_number": asset.asset_number,
                "due_date": due.isoformat(),
                "link": settings.public_base_url.rstrip("/"),
            }
            days_to_due = (due - today).days
            days_overdue = (today - due).days

            if days_to_due in settings.retest_advance_days:
                emitted += await _emit(
                    session,
                    NotificationCategory.RETEST_ADVANCE,
                    asset.id,
                    {**base, "days_before": days_to_due},
                    f"RETEST_ADVANCE:{asset.id}:{due.isoformat()}:{days_to_due}",
                )
            elif days_to_due == 0:
                emitted += await _emit(
                    session,
                    NotificationCategory.RETEST_DUE,
                    asset.id,
                    base,
                    f"RETEST_DUE:{asset.id}:{due.isoformat()}",
                )
            elif days_overdue in settings.retest_overdue_escalation_days:
                level = settings.retest_overdue_escalation_days.index(days_overdue) + 1
                emitted += await _emit(
                    session,
                    NotificationCategory.RETEST_OVERDUE,
                    asset.id,
                    {**base, "days_overdue": days_overdue, "escalation_level": level},
                    f"RETEST_OVERDUE:{asset.id}:{due.isoformat()}:{days_overdue}",
                )

        await session.commit()
    return {"emitted": emitted}


async def apply_delivery_receipt(
    session: AsyncSession,
    *,
    provider_message_id: str,
    status: NotificationStatus,
) -> bool:
    """Update a notification's delivery status from a provider webhook (N-06).

    Matches on ``provider_message_id``. Returns True if a row was updated.
    """
    if not provider_message_id:
        return False
    notification = await session.scalar(
        select(Notification).where(
            Notification.provider_message_id == provider_message_id
        )
    )
    if notification is None:
        return False
    now = _utc_now()
    if status is NotificationStatus.DELIVERED:
        notification.status = status.value
        notification.delivered_at = now
    elif status in (NotificationStatus.FAILED, NotificationStatus.BOUNCED):
        notification.status = status.value
        notification.failed_at = now
        notification.error = f"provider reported {status.value.lower()}"
    elif status is NotificationStatus.SENT and notification.status == (
        NotificationStatus.PENDING.value
    ):
        notification.status = status.value
        notification.sent_at = now
    return True


async def _emit(
    session: AsyncSession,
    category: NotificationCategory,
    asset_id: str,
    payload: dict[str, Any],
    dedupe_key: str,
) -> int:
    event = await emit_event_if_absent(
        session,
        category=category,
        aggregate_type="asset",
        aggregate_id=asset_id,
        payload=payload,
        dedupe_key=dedupe_key,
    )
    return 1 if event is not None else 0
