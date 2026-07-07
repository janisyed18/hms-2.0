"""SMS adapter for Twilio — used in 'live' mode.

Uses the Twilio REST API directly over httpx to avoid a heavy SDK dependency.
``twilio_from`` may be an E.164 number or an alphanumeric sender ID (common for
Australian SMS).
"""

from __future__ import annotations

import logging

import httpx

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel

logger = logging.getLogger("hms_backend.notifications.sms")

_TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"


class TwilioSmsAdapter:
    channel = NotificationChannel.SMS

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        s = self._settings
        url = _TWILIO_API.format(sid=s.twilio_account_sid)
        data = {
            "To": message.to_address,
            "From": s.twilio_from,
            "Body": message.body_text,
        }
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    url, data=data, auth=(s.twilio_account_sid, s.twilio_auth_token)
                )
        except httpx.HTTPError as exc:  # pragma: no cover - network path
            logger.warning("Twilio send failed to %s: %s", message.to_address, exc)
            return DeliveryResult(success=False, error=str(exc))

        if response.status_code >= 400:
            return DeliveryResult(
                success=False,
                error=f"twilio {response.status_code}: {response.text[:200]}",
            )
        sid = response.json().get("sid")
        return DeliveryResult(success=True, provider_message_id=sid)
