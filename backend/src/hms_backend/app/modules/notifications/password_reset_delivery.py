"""Transient password-reset email delivery.

Reset links intentionally bypass the permanent notification body log. The raw
token is decrypted only while constructing the outbound SES message and the
encrypted envelope is scrubbed after delivery or terminal expiry/failure.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as default_settings
from hms_backend.app.core.password_reset_tokens import (
    EncryptedPasswordResetDelivery,
    decrypt_password_reset_delivery,
)
from hms_backend.app.modules.identity.models import (
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)
from hms_backend.app.modules.notifications.channels.base import (
    ChannelAdapter,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.channels.registry import (
    build_channel_adapters,
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
)
from hms_backend.app.modules.notifications.templates import render

logger = logging.getLogger("hms_backend.notifications.password_reset_delivery")


async def dispatch_password_reset_deliveries(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    settings: Settings | None = None,
    adapter: ChannelAdapter | None = None,
    now: datetime | None = None,
    limit: int = 100,
) -> dict[str, int]:
    settings = settings or default_settings

    def clock() -> datetime:
        return now if now is not None else datetime.now(UTC)

    email_adapter = (
        adapter or build_channel_adapters(settings)[NotificationChannel.EMAIL]
    )
    # A claim whose holder died is requeued, or dead-lettered with its secret scrubbed.
    await requeue_expired_claims(
        session_factory,
        PasswordResetDelivery,
        now=clock(),
        max_attempts=settings.notification_max_attempts,
        dead_letter_values={"ciphertext": None},
    )
    async with session_factory() as session:
        delivery_ids = list(
            (
                await session.scalars(
                    select(PasswordResetDelivery.id)
                    .where(
                        PasswordResetDelivery.status == "PENDING",
                        PasswordResetDelivery.ciphertext.is_not(None),
                        PasswordResetDelivery.scheduled_for <= clock(),
                    )
                    .order_by(PasswordResetDelivery.scheduled_for)
                    .limit(limit)
                )
            ).all()
        )

    sent = 0
    failed = 0
    for delivery_id in delivery_ids:
        try:
            result = await _deliver_one(
                session_factory,
                delivery_id,
                adapter=email_adapter,
                settings=settings,
                clock=clock,
            )
        except Exception:  # noqa: BLE001 - one delivery must not stop the batch
            logger.exception("password reset delivery %s failed", delivery_id)
            continue
        if result == "sent":
            sent += 1
        elif result == "failed":
            failed += 1
    return {"sent": sent, "failed": failed}


def _terminal_failure(now: datetime, error: str) -> dict[str, Any]:
    return {
        "status": "DEAD_LETTER",
        "failed_at": now,
        "error": error,
        "ciphertext": None,
    }


async def _deliver_one(
    session_factory: async_sessionmaker[AsyncSession],
    delivery_id: str,
    *,
    adapter: ChannelAdapter,
    settings: Settings,
    clock: Callable[[], datetime],
) -> str:
    # Durable claim first: only the holder of a claim may send, so overlapping
    # dispatchers can never email the same reset link twice.
    held = await claim(
        session_factory,
        PasswordResetDelivery,
        delivery_id,
        now=clock(),
        lease_seconds=settings.notification_claim_lease_seconds,
    )
    if held is None:
        return "skip"

    async with session_factory() as session:
        delivery = await session.get(PasswordResetDelivery, delivery_id)
        if delivery is None or delivery.ciphertext is None:
            await _record(
                session_factory, held, _terminal_failure(clock(), "reset unavailable")
            )
            return "failed"
        reset = await session.get(PasswordResetToken, delivery.reset_id)
        if (
            reset is None
            or reset.consumed_at is not None
            or _aware(reset.expires_at) <= clock()
        ):
            await _record(
                session_factory, held, _terminal_failure(clock(), "reset link expired")
            )
            return "failed"
        if reset.superseded_at is not None:
            # A newer request replaced this link and the API rejects it on confirm, so
            # emailing it would hand the user a link that cannot work.
            await _record(
                session_factory,
                held,
                _terminal_failure(clock(), "reset link superseded"),
            )
            return "failed"
        user = await session.get(User, reset.user_id)
        if user is None or user.deleted_at is not None:
            await _record(
                session_factory,
                held,
                _terminal_failure(clock(), "reset recipient unavailable"),
            )
            return "failed"

        try:
            raw = decrypt_password_reset_delivery(
                EncryptedPasswordResetDelivery(
                    ciphertext=delivery.ciphertext,
                    key_version=delivery.key_version,
                ),
                reset_id=reset.id,
                user_id=user.id,
                config=settings,
            )
            link = _reset_link(settings, raw)
            rendered = render(
                NotificationCategory.PASSWORD_RESET,
                NotificationChannel.EMAIL,
                {"link": link},
                sender_name=settings.notification_sender_name,
                issuer_identifier=settings.issuer_identifier,
            )
            result = await adapter.send(
                OutgoingMessage(
                    channel=NotificationChannel.EMAIL,
                    to_address=delivery.recipient_email,
                    subject=rendered.subject,
                    body_text=rendered.body_text,
                    body_html=rendered.body_html,
                )
            )
        except Exception:  # noqa: BLE001 - keep delivery worker retryable
            result = None

    finished = clock()
    if result is not None and result.success:
        await _record(
            session_factory,
            held,
            {
                "status": "SENT",
                "sent_at": finished,
                "provider_message_id": result.provider_message_id,
                "ciphertext": None,
                "error": None,
            },
        )
        return "sent"

    if held.token >= settings.notification_max_attempts:
        await _record(
            session_factory, held, _terminal_failure(finished, "email delivery failed")
        )
        return "failed"
    await _record(
        session_factory,
        held,
        {
            "status": "PENDING",
            "scheduled_for": finished
            + timedelta(
                seconds=settings.notification_retry_backoff_seconds * held.token
            ),
            "error": "email delivery failed",
        },
    )
    return "skip"


async def _record(
    session_factory: async_sessionmaker[AsyncSession],
    held: Claim,
    values: dict[str, Any],
) -> None:
    """Write the outcome fenced by the claim; never let it abort the batch."""
    try:
        applied = await finalise(session_factory, PasswordResetDelivery, held, values)
    except Exception:
        # The email may already have gone out. The row stays claimed, so it is not
        # re-sent before the lease expires and its secret is scrubbed on expiry.
        logger.exception(
            "could not record the outcome for password reset delivery %s (attempt %s)",
            held.row_id,
            held.token,
        )
        return
    if not applied:
        logger.error(
            "lost the claim on password reset delivery %s (attempt %s) before "
            "recording its outcome; it may be sent again",
            held.row_id,
            held.token,
        )


def _reset_link(settings: Settings, raw_token: str) -> str:
    base = settings.auth_browser_staff_public_url.rstrip("/")
    return f"{base}/reset-password?{urlencode({'token': raw_token})}"


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value
