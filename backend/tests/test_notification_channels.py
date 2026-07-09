"""Channel adapter request-shaping + webhook parser tests.

These exercise the provider integration surface (Twilio request, SES/SMTP email,
and delivery-webhook parsing) without any network or ORM.
"""

import json

from hms_backend.app.core.config import Settings
from hms_backend.app.modules.notifications.channels.base import OutgoingMessage
from hms_backend.app.modules.notifications.channels.email_smtp import (
    build_email_message,
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
