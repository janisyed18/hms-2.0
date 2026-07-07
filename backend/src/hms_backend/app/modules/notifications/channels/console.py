"""Development channel adapters that log instead of sending.

Used when ``notification_channel_mode == "console"`` so the whole pipeline runs
locally without SMTP/Twilio credentials. Also provides the IN_APP adapter used in
every mode (in-app delivery is just persisting the notification row, which the
dispatcher already does — the adapter simply acknowledges it).
"""

from __future__ import annotations

import logging
import uuid

from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel

logger = logging.getLogger("hms_backend.notifications.console")


def _console_id() -> str:
    return f"console-{uuid.uuid4()}"


class ConsoleEmailAdapter:
    channel = NotificationChannel.EMAIL

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        logger.info(
            "[EMAIL] to=%s subject=%r\n%s",
            message.to_address,
            message.subject,
            message.body_text,
        )
        return DeliveryResult(success=True, provider_message_id=_console_id())


class ConsoleSmsAdapter:
    channel = NotificationChannel.SMS

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        logger.info("[SMS] to=%s\n%s", message.to_address, message.body_text)
        return DeliveryResult(success=True, provider_message_id=_console_id())


class InAppAdapter:
    """In-app 'delivery' is the persisted notification row; acknowledge instantly."""

    channel = NotificationChannel.IN_APP

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        return DeliveryResult(success=True, provider_message_id="in-app")
