"""Pure parsers for provider delivery webhooks (spec §3.4; N-06).

Each parser turns a raw request body into ``(provider_message_id, status)`` pairs
that the API applies to notifications. ORM-free, so they are unit-testable in
isolation.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

from hms_backend.app.modules.notifications.enums import NotificationStatus

# Twilio status callback -> our status.
TWILIO_STATUS = {
    "delivered": NotificationStatus.DELIVERED,
    "sent": NotificationStatus.SENT,
    "failed": NotificationStatus.FAILED,
    "undelivered": NotificationStatus.BOUNCED,
}
# Amazon SES notification type (via SNS) -> our status.
SES_STATUS = {
    "Delivery": NotificationStatus.DELIVERED,
    "Bounce": NotificationStatus.BOUNCED,
    "Complaint": NotificationStatus.FAILED,
}
GENERIC_STATUS = {status.value: status for status in NotificationStatus}

Receipts = list[tuple[str, NotificationStatus]]


def parse_twilio(body: bytes) -> Receipts:
    parsed = parse_qs(body.decode("utf-8", "ignore"))
    sid = (parsed.get("MessageSid") or parsed.get("SmsSid") or [""])[0]
    raw = (parsed.get("MessageStatus") or parsed.get("SmsStatus") or [""])[0]
    mapped = TWILIO_STATUS.get(raw.lower())
    return [(sid, mapped)] if sid and mapped else []


def parse_generic(body: bytes) -> Receipts:
    """Generic JSON: {"provider_message_id": "...", "status": "DELIVERED"}."""
    try:
        data = json.loads(body or b"{}")
    except (ValueError, TypeError):
        return []
    pmid = str(data.get("provider_message_id", ""))
    mapped = GENERIC_STATUS.get(str(data.get("status", "")))
    return [(pmid, mapped)] if pmid and mapped else []


def parse_sns(body: bytes) -> Receipts:
    """Amazon SES delivery/bounce notification delivered via SNS."""
    try:
        envelope = json.loads(body or b"{}")
    except (ValueError, TypeError):
        return []
    if envelope.get("Type") == "SubscriptionConfirmation":
        return []  # confirmed out-of-band; nothing to update
    message = envelope.get("Message", envelope)
    if isinstance(message, str):
        try:
            message = json.loads(message)
        except (ValueError, TypeError):
            return []
    notification_type = message.get("notificationType") or message.get("eventType")
    mapped = SES_STATUS.get(str(notification_type))
    message_id = (message.get("mail") or {}).get("messageId", "")
    return [(str(message_id), mapped)] if message_id and mapped else []


def parse_receipts(provider: str, body: bytes) -> Receipts:
    if provider == "twilio":
        return parse_twilio(body)
    if provider in ("ses", "sns"):
        return parse_sns(body)
    return parse_generic(body)
