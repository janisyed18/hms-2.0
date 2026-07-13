"""Transient password-reset email delivery.

Reset links intentionally bypass the permanent notification body log. The raw
token is decrypted only while constructing the outbound SES message and the
encrypted envelope is scrubbed after delivery or terminal expiry/failure.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
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
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
)
from hms_backend.app.modules.notifications.templates import render


async def dispatch_password_reset_deliveries(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    settings: Settings | None = None,
    adapter: ChannelAdapter | None = None,
    now: datetime | None = None,
    limit: int = 100,
) -> dict[str, int]:
    settings = settings or default_settings
    current = now or datetime.now(UTC)
    email_adapter = (
        adapter or build_channel_adapters(settings)[NotificationChannel.EMAIL]
    )
    async with session_factory() as session:
        delivery_ids = list(
            (
                await session.scalars(
                    select(PasswordResetDelivery.id)
                    .where(
                        PasswordResetDelivery.status == "PENDING",
                        PasswordResetDelivery.ciphertext.is_not(None),
                        PasswordResetDelivery.scheduled_for <= current,
                    )
                    .order_by(PasswordResetDelivery.scheduled_for)
                    .limit(limit)
                )
            ).all()
        )

    sent = 0
    failed = 0
    for delivery_id in delivery_ids:
        result = await _deliver_one(
            session_factory,
            delivery_id,
            adapter=email_adapter,
            settings=settings,
            now=current,
        )
        if result == "sent":
            sent += 1
        elif result == "failed":
            failed += 1
    return {"sent": sent, "failed": failed}


async def _deliver_one(
    session_factory: async_sessionmaker[AsyncSession],
    delivery_id: str,
    *,
    adapter: ChannelAdapter,
    settings: Settings,
    now: datetime,
) -> str:
    async with session_factory() as session:
        delivery = await session.get(PasswordResetDelivery, delivery_id)
        if (
            delivery is None
            or delivery.status != "PENDING"
            or delivery.ciphertext is None
        ):
            return "skip"
        reset = await session.get(PasswordResetToken, delivery.reset_id)
        if (
            reset is None
            or reset.consumed_at is not None
            or _aware(reset.expires_at) <= now
        ):
            _mark_terminal_failure(delivery, now, "reset link expired")
            await session.commit()
            return "failed"
        user = await session.get(User, reset.user_id)
        if user is None or user.deleted_at is not None:
            _mark_terminal_failure(delivery, now, "reset recipient unavailable")
            await session.commit()
            return "failed"

        delivery.attempts += 1
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

        if result is not None and result.success:
            delivery.status = "SENT"
            delivery.sent_at = now
            delivery.provider_message_id = result.provider_message_id
            delivery.ciphertext = None
            delivery.error = None
            await session.commit()
            return "sent"

        if delivery.attempts >= settings.notification_max_attempts:
            _mark_terminal_failure(delivery, now, "email delivery failed")
            await session.commit()
            return "failed"
        delivery.status = "PENDING"
        delivery.scheduled_for = now + timedelta(
            seconds=settings.notification_retry_backoff_seconds * delivery.attempts
        )
        delivery.error = "email delivery failed"
        await session.commit()
        return "skip"


def _reset_link(settings: Settings, raw_token: str) -> str:
    base = settings.auth_browser_staff_public_url.rstrip("/")
    return f"{base}/reset-password?{urlencode({'token': raw_token})}"


def _mark_terminal_failure(
    delivery: PasswordResetDelivery, now: datetime, error: str
) -> None:
    delivery.status = "DEAD_LETTER"
    delivery.failed_at = now
    delivery.error = error
    delivery.ciphertext = None


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value
