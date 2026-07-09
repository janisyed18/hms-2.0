from __future__ import annotations

from email.message import EmailMessage
from typing import Any

import pytest

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import OutgoingMessage
from hms_backend.app.modules.notifications.channels.email_ses import AwsSesEmailAdapter
from hms_backend.app.modules.notifications.channels.email_smtp import SmtpEmailAdapter
from hms_backend.app.modules.notifications.channels.registry import (
    build_channel_adapters,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel


class _FakeSesClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send_email(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(kwargs)
        return {"MessageId": "ses-message-1"}


@pytest.mark.asyncio
async def test_smtp_adapter_adds_ses_configuration_set_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_send(
        message: EmailMessage, **kwargs: object
    ) -> tuple[dict[str, object], str]:
        captured["message"] = message
        captured["kwargs"] = kwargs
        return {}, "queued"

    monkeypatch.setattr(
        "hms_backend.app.modules.notifications.channels.email_smtp.aiosmtplib.send",
        fake_send,
    )
    adapter = SmtpEmailAdapter(
        Settings(
            smtp_host="email-smtp.ap-southeast-2.amazonaws.com",
            smtp_username="smtp-user",
            smtp_password="smtp-pass",
            email_from_address="hms@example.com",
            notification_ses_configuration_set="hms-dev-notifications",
        )
    )

    result = await adapter.send(
        OutgoingMessage(
            channel=NotificationChannel.EMAIL,
            to_address="recipient@example.com",
            subject="Certificate ready",
            body_text="Your certificate is ready.",
        )
    )

    sent = captured["message"]
    assert isinstance(sent, EmailMessage)
    assert sent["X-SES-CONFIGURATION-SET"] == "hms-dev-notifications"
    assert captured["kwargs"]["hostname"] == "email-smtp.ap-southeast-2.amazonaws.com"
    assert result.success is True


@pytest.mark.asyncio
async def test_aws_ses_adapter_sends_simple_email_payload() -> None:
    client = _FakeSesClient()
    adapter = AwsSesEmailAdapter(
        Settings(
            notification_sender_name="BAT Engineering",
            email_from_address="alerts@example.com",
            notification_ses_configuration_set="hms-dev-notifications",
        ),
        client=client,
    )

    result = await adapter.send(
        OutgoingMessage(
            channel=NotificationChannel.EMAIL,
            to_address="recipient@example.com",
            subject="Certificate ready",
            body_text="Your certificate is ready.",
            body_html="<p>Your certificate is ready.</p>",
        )
    )

    assert result.success is True
    assert result.provider_message_id == "ses-message-1"
    assert client.calls == [
        {
            "FromEmailAddress": "BAT Engineering <alerts@example.com>",
            "Destination": {"ToAddresses": ["recipient@example.com"]},
            "Content": {
                "Simple": {
                    "Subject": {
                        "Data": "Certificate ready",
                        "Charset": "UTF-8",
                    },
                    "Body": {
                        "Text": {
                            "Data": "Your certificate is ready.",
                            "Charset": "UTF-8",
                        },
                        "Html": {
                            "Data": "<p>Your certificate is ready.</p>",
                            "Charset": "UTF-8",
                        },
                    },
                }
            },
            "ConfigurationSetName": "hms-dev-notifications",
        }
    ]


def test_live_registry_selects_aws_ses_email_adapter() -> None:
    adapters = build_channel_adapters(
        Settings(
            notification_channel_mode="live",
            notification_email_provider="aws_ses",
        )
    )

    assert isinstance(adapters[NotificationChannel.EMAIL], AwsSesEmailAdapter)
