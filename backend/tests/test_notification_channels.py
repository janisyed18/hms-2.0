"""Channel adapter request-shaping + webhook parser tests.

These exercise the provider integration surface (SMTP/SES email, Twilio SMS,
and delivery-webhook parsing) without any network or ORM.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from email.message import EmailMessage
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from hms_backend.app.api.notifications import _check_webhook_secret, _verify_webhook
from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.modules.notifications.channels.base import OutgoingMessage
from hms_backend.app.modules.notifications.channels.email_ses import AwsSesEmailAdapter
from hms_backend.app.modules.notifications.channels.email_smtp import (
    SmtpEmailAdapter,
    build_email_message,
)
from hms_backend.app.modules.notifications.channels.registry import (
    build_channel_adapters,
)
from hms_backend.app.modules.notifications.channels.sms_twilio import (
    build_twilio_request,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationChannel,
    NotificationStatus,
)
from hms_backend.app.modules.notifications.webhooks import (
    parse_generic,
    parse_sns,
    parse_twilio,
)


def _webhook_request(
    secret: str | None = None,
    query_string: bytes = b"",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    headers = headers or []
    if secret is not None:
        headers.append((b"x-hms-webhook-secret", secret.encode()))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/notifications/webhooks/generic",
            "headers": headers,
            "query_string": query_string,
        }
    )


def test_webhook_secret_is_required_outside_local_development(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_settings, "environment", "production")
    monkeypatch.setattr(app_settings, "notification_webhook_secret", "")

    with pytest.raises(HTTPException, match="Webhook authentication") as exc_info:
        _check_webhook_secret(_webhook_request())

    assert exc_info.value.status_code == 503


def test_webhook_secret_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_settings, "environment", "production")
    monkeypatch.setattr(app_settings, "notification_webhook_secret", "webhook-secret")

    with pytest.raises(HTTPException, match="Invalid webhook secret"):
        _check_webhook_secret(_webhook_request("wrong"))

    _check_webhook_secret(_webhook_request("webhook-secret"))


@pytest.mark.asyncio
async def test_twilio_webhook_uses_provider_signature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callback_url = "https://staff.example.com/api/v1/notifications/webhooks/twilio"
    body = b"MessageSid=SM1&MessageStatus=delivered"
    signature = base64.b64encode(
        hmac.new(
            b"twilio-auth-token",
            f"{callback_url}MessageSidSM1MessageStatusdelivered".encode(),
            hashlib.sha1,
        ).digest()
    ).decode()
    monkeypatch.setattr(app_settings, "twilio_auth_token", "twilio-auth-token")
    monkeypatch.setattr(
        app_settings, "notification_twilio_status_callback_url", callback_url
    )
    request = _webhook_request(headers=[(b"x-twilio-signature", signature.encode())])

    await _verify_webhook("twilio", request, body)
    with pytest.raises(HTTPException, match="Invalid Twilio signature") as exc_info:
        await _verify_webhook("twilio", request, b"MessageSid=SM2")
    assert exc_info.value.status_code == 403


def test_live_twilio_requires_a_complete_https_callback_configuration() -> None:
    settings = Settings(notification_channel_mode="live", twilio_account_sid="AC123")
    assert settings.notification_security_config_errors()
    assert Settings(
        notification_channel_mode="live",
        twilio_account_sid="AC123",
        twilio_auth_token="token",
        twilio_from="+61400000000",
        notification_twilio_status_callback_url="https://staff.example.com/callback",
    ).notification_security_config_errors() == []


def test_webhook_secret_is_not_accepted_from_a_query_parameter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_settings, "environment", "production")
    monkeypatch.setattr(app_settings, "notification_webhook_secret", "webhook-secret")

    with pytest.raises(HTTPException, match="Invalid webhook secret"):
        _check_webhook_secret(_webhook_request(query_string=b"token=webhook-secret"))


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


def test_build_twilio_request() -> None:
    settings = Settings(twilio_account_sid="AC123", twilio_from="+61400000000")
    msg = OutgoingMessage(
        channel=NotificationChannel.SMS,
        to_address="+61411111111",
        subject=None,
        body_text="HMS: certificate issued.",
    )
    url, data = build_twilio_request(settings, msg)
    assert url.endswith("/Accounts/AC123/Messages.json")
    assert data == {
        "To": "+61411111111",
        "From": "+61400000000",
        "Body": "HMS: certificate issued.",
    }


def test_twilio_request_includes_the_signed_status_callback() -> None:
    settings = Settings(
        twilio_account_sid="AC123",
        twilio_from="+61400000000",
        notification_twilio_status_callback_url="https://staff.example.com/api/v1/notifications/webhooks/twilio",
    )
    _, data = build_twilio_request(
        settings,
        OutgoingMessage(
            channel=NotificationChannel.SMS,
            to_address="+61411111111",
            subject=None,
            body_text="HMS",
        ),
    )
    assert data["StatusCallback"] == settings.notification_twilio_status_callback_url


def test_build_email_message_is_multipart() -> None:
    settings = Settings(
        notification_sender_name="BAT Engineering",
        email_from_address="no-reply@bat.example",
    )
    msg = OutgoingMessage(
        channel=NotificationChannel.EMAIL,
        to_address="user@example.com",
        subject="Certificate issued",
        body_text="plain body",
        body_html="<p>html body</p>",
    )
    email = build_email_message(settings, msg)
    assert email["To"] == "user@example.com"
    assert email["Subject"] == "Certificate issued"
    assert "BAT Engineering" in email["From"]
    assert "no-reply@bat.example" in email["From"]
    assert email.get_content_type() == "multipart/alternative"
    parts = [p.get_content_type() for p in email.iter_parts()]
    assert "text/plain" in parts
    assert "text/html" in parts


def test_parse_twilio_statuses() -> None:
    assert parse_twilio(b"MessageSid=SM1&MessageStatus=delivered") == [
        ("SM1", NotificationStatus.DELIVERED)
    ]
    assert parse_twilio(b"MessageSid=SM2&MessageStatus=failed") == [
        ("SM2", NotificationStatus.FAILED)
    ]
    assert parse_twilio(b"MessageSid=SM3&MessageStatus=undelivered") == [
        ("SM3", NotificationStatus.BOUNCED)
    ]
    # queued/unknown -> no receipt
    assert parse_twilio(b"MessageSid=SM4&MessageStatus=queued") == []


def test_parse_generic() -> None:
    body = json.dumps(
        {"provider_message_id": "abc", "status": "DELIVERED"}
    ).encode()
    assert parse_generic(body) == [("abc", NotificationStatus.DELIVERED)]
    assert parse_generic(b"not json") == []


def test_parse_sns_delivery_and_bounce() -> None:
    def envelope(notification_type: str, message_id: str) -> bytes:
        inner = json.dumps(
            {"notificationType": notification_type, "mail": {"messageId": message_id}}
        )
        return json.dumps({"Type": "Notification", "Message": inner}).encode()

    assert parse_sns(envelope("Delivery", "M1")) == [
        ("M1", NotificationStatus.DELIVERED)
    ]
    assert parse_sns(envelope("Bounce", "M2")) == [
        ("M2", NotificationStatus.BOUNCED)
    ]
    assert parse_sns(envelope("Complaint", "M3")) == [
        ("M3", NotificationStatus.FAILED)
    ]


def test_parse_sns_ignores_subscription_confirmation() -> None:
    body = json.dumps({"Type": "SubscriptionConfirmation", "Token": "x"}).encode()
    assert parse_sns(body) == []
