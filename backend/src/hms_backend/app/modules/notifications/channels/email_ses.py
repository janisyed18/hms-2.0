"""AWS SES v2 email adapter — used in AWS live mode without SMTP keys."""

from __future__ import annotations

import importlib
import logging
from typing import Any

from starlette.concurrency import run_in_threadpool

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel

logger = logging.getLogger("hms_backend.notifications.email")


def _create_sesv2_client(region_name: str) -> Any:
    boto3 = importlib.import_module("boto3")
    kwargs = {}
    if region_name:
        kwargs["region_name"] = region_name
    return boto3.client("sesv2", **kwargs)


class AwsSesEmailAdapter:
    channel = NotificationChannel.EMAIL

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self._settings = settings
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = _create_sesv2_client(self._settings.notification_ses_region)
        return self._client

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        s = self._settings
        body: dict[str, dict[str, str]] = {
            "Text": {"Data": message.body_text, "Charset": "UTF-8"}
        }
        if message.body_html:
            body["Html"] = {"Data": message.body_html, "Charset": "UTF-8"}

        params: dict[str, Any] = {
            "FromEmailAddress": (
                f"{s.notification_sender_name} <{s.email_from_address}>"
            ),
            "Destination": {"ToAddresses": [message.to_address]},
            "Content": {
                "Simple": {
                    "Subject": {
                        "Data": message.subject or s.notification_sender_name,
                        "Charset": "UTF-8",
                    },
                    "Body": body,
                }
            },
        }
        if s.notification_ses_configuration_set:
            params["ConfigurationSetName"] = s.notification_ses_configuration_set

        try:
            response = await run_in_threadpool(
                self._get_client().send_email, **params
            )
        except Exception as exc:  # noqa: BLE001 - dispatcher persists provider error
            logger.warning("SES send failed to %s: %s", message.to_address, exc)
            return DeliveryResult(success=False, error=str(exc))

        message_id = response.get("MessageId") if isinstance(response, dict) else None
        return DeliveryResult(success=True, provider_message_id=message_id)
