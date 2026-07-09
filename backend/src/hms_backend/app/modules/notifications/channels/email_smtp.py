"""Email adapter for OCI Email Delivery (SMTP) — used in 'live' mode."""

from __future__ import annotations

import logging
from email.message import EmailMessage

import aiosmtplib

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel

logger = logging.getLogger("hms_backend.notifications.email")


class SmtpEmailAdapter:
    channel = NotificationChannel.EMAIL

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        s = self._settings
        email = EmailMessage()
        email["From"] = f"{s.notification_sender_name} <{s.email_from_address}>"
        email["To"] = message.to_address
        email["Subject"] = message.subject or s.notification_sender_name
        if s.notification_ses_configuration_set:
            email["X-SES-CONFIGURATION-SET"] = s.notification_ses_configuration_set
        email.set_content(message.body_text)
        if message.body_html:
            email.add_alternative(message.body_html, subtype="html")

        try:
            result = await aiosmtplib.send(
                email,
                hostname=s.smtp_host,
                port=s.smtp_port,
                username=s.smtp_username or None,
                password=s.smtp_password or None,
                start_tls=s.smtp_use_tls,
                timeout=30,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced to the dispatcher for retry
            logger.warning("SMTP send failed to %s: %s", message.to_address, exc)
            return DeliveryResult(success=False, error=str(exc))

        # aiosmtplib returns (errors_dict, message); empty errors == accepted.
        return DeliveryResult(success=True, provider_message_id=str(result[1])[:200])
