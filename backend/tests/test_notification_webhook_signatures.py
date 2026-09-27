from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

from hms_backend.app.modules.notifications.webhooks import (
    build_sns_string_to_sign,
    sns_signing_certificate_url,
    verify_sns_signature,
    verify_twilio_signature,
)


def test_twilio_signature_requires_the_configured_public_callback_url() -> None:
    url = "https://staff.example.com/api/v1/notifications/webhooks/twilio"
    body = b"MessageSid=SM1&MessageStatus=delivered"
    signature = base64.b64encode(
        hmac.new(
            b"twilio-auth-token",
            f"{url}MessageSidSM1MessageStatusdelivered".encode(),
            hashlib.sha1,
        ).digest()
    ).decode()

    assert verify_twilio_signature("twilio-auth-token", url, body, signature)
    assert not verify_twilio_signature(
        "twilio-auth-token", f"{url}/wrong", body, signature
    )


def test_sns_signature_requires_a_trusted_topic_and_valid_certificate() -> None:
    topic_arn = "arn:aws:sns:ap-southeast-2:123456789012:hms-notifications"
    envelope = {
        "Type": "Notification",
        "MessageId": "message-1",
        "TopicArn": topic_arn,
        "Subject": "SES event",
        "Message": json.dumps(
            {"notificationType": "Delivery", "mail": {"messageId": "ses-1"}}
        ),
        "Timestamp": "2026-09-27T00:00:00.000Z",
        "SignatureVersion": "2",
    }
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SNS")]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SNS")]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    envelope["Signature"] = base64.b64encode(
        key.sign(
            build_sns_string_to_sign(envelope),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    ).decode()
    certificate_pem = certificate.public_bytes(serialization.Encoding.PEM)

    assert verify_sns_signature(envelope, certificate_pem, {topic_arn})
    assert not verify_sns_signature(envelope, certificate_pem, set())


def test_sns_certificate_url_cannot_be_used_for_ssrf() -> None:
    for url in (
        "http://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-test.pem",
        "https://sns.ap-southeast-2.amazonaws.com.evil.test/SimpleNotificationService-test.pem",
        "https://127.0.0.1/SimpleNotificationService-test.pem",
        "https://sns.ap-southeast-2.amazonaws.com/other.pem",
    ):
        try:
            sns_signing_certificate_url({"SigningCertURL": url})
        except ValueError:
            continue
        raise AssertionError(f"accepted untrusted URL: {url}")
