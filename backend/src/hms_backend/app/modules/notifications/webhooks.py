"""Pure parsers for provider delivery webhooks (spec §3.4; N-06).

Each parser turns a raw request body into ``(provider_message_id, status)`` pairs
that the API applies to notifications. ORM-free, so they are unit-testable in
isolation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from urllib.parse import parse_qs, urlsplit

import httpx
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

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
_SNS_CERT_HOST = re.compile(r"^sns(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$")
_SNS_CERT_MAX_BYTES = 64 * 1024


def verify_twilio_signature(
    auth_token: str,
    callback_url: str,
    body: bytes,
    signature: str,
) -> bool:
    """Verify a form-encoded Twilio callback without trusting request headers."""
    if not auth_token or not callback_url or not signature:
        return False
    params = parse_qs(body.decode("utf-8", "strict"), keep_blank_values=True)
    signed = callback_url
    for name in sorted(params):
        for value in sorted(set(params[name])):
            signed += f"{name}{value}"
    expected = base64.b64encode(
        hmac.new(auth_token.encode(), signed.encode(), hashlib.sha1).digest()
    ).decode()
    return hmac.compare_digest(expected, signature)


def build_sns_string_to_sign(envelope: Mapping[str, object]) -> bytes:
    """Build the canonical SNS message required for RSA signature checking."""
    message_type = str(envelope.get("Type", ""))
    fields: tuple[str, ...]
    if message_type == "Notification":
        fields = ("Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type")
    elif message_type in {"SubscriptionConfirmation", "UnsubscribeConfirmation"}:
        fields = (
            "Message",
            "MessageId",
            "SubscribeURL",
            "Timestamp",
            "Token",
            "TopicArn",
            "Type",
        )
    else:
        raise ValueError("Unsupported SNS message type")

    values: list[str] = []
    for field in fields:
        if field == "Subject" and field not in envelope:
            continue
        value = envelope.get(field)
        if value is None:
            raise ValueError(f"SNS message is missing {field}")
        values.extend((field, str(value)))
    return ("\n".join(values) + "\n").encode()


def verify_sns_signature(
    envelope: Mapping[str, object],
    certificate_pem: bytes,
    allowed_topic_arns: set[str],
) -> bool:
    """Verify a signed SNS envelope after its certificate URL is trusted."""
    if str(envelope.get("TopicArn", "")) not in allowed_topic_arns:
        return False
    signature_version = str(envelope.get("SignatureVersion", ""))
    algorithm = {"1": hashes.SHA1(), "2": hashes.SHA256()}.get(signature_version)
    signature = envelope.get("Signature")
    if algorithm is None or not isinstance(signature, str):
        return False
    try:
        certificate = x509.load_pem_x509_certificate(certificate_pem)
        public_key = certificate.public_key()
        if not isinstance(public_key, RSAPublicKey):
            return False
        public_key.verify(
            base64.b64decode(signature, validate=True),
            build_sns_string_to_sign(envelope),
            padding.PKCS1v15(),
            algorithm,
        )
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def sns_signing_certificate_url(envelope: Mapping[str, object]) -> str:
    """Validate the SNS certificate URL before making an outbound request."""
    url = envelope.get("SigningCertURL")
    if not isinstance(url, str):
        raise ValueError("SNS message is missing SigningCertURL")
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or not _SNS_CERT_HOST.fullmatch(host)
        or not parsed.path.startswith("/SimpleNotificationService-")
        or not parsed.path.endswith(".pem")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Untrusted SNS signing certificate URL")
    return url


async def verify_sns_request(body: bytes, allowed_topic_arns: set[str]) -> bool:
    """Verify an SNS envelope without permitting certificate-fetch SSRF."""
    try:
        envelope = json.loads(body)
        if not isinstance(envelope, dict):
            return False
        if str(envelope.get("TopicArn", "")) not in allowed_topic_arns:
            return False
        certificate_url = sns_signing_certificate_url(envelope)
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            response = await client.get(certificate_url)
        if response.status_code != 200 or len(response.content) > _SNS_CERT_MAX_BYTES:
            return False
        return verify_sns_signature(envelope, response.content, allowed_topic_arns)
    except (httpx.HTTPError, TypeError, ValueError):
        return False


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
