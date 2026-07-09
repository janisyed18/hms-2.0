from __future__ import annotations

from email.message import EmailMessage
from typing import Any

import pytest

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import OutgoingMessage
from hms_backend.app.modules.notifications.channels.email_smtp import SmtpEmailAdapter
from hms_backend.app.modules.notifications.enums import NotificationChannel


@pytest.mark.asyncio
async def test_smtp_adapter_adds_ses_configuration_set_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_send(message: EmailMessage, **kwargs: object) -> tuple[dict, str]:
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
