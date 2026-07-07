"""Pure policy / idempotency / template tests (spec §4, §6; N-04, N-05, N-07, N-10).

These depend only on the ORM-free notification core, so they exercise the
compliance and consent rules directly.
"""

from hms_backend.app.modules.notifications.enums import (
    NotificationCategory as C,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationChannel as Ch,
)
from hms_backend.app.modules.notifications.enums import (
    RecipientType,
)
from hms_backend.app.modules.notifications.idempotency import (
    notification_idempotency_key,
)
from hms_backend.app.modules.notifications.policy import (
    ChannelDecision,
    RecipientContext,
    resolve_channels,
)
from hms_backend.app.modules.notifications.templates import render


def _channels(decision: ChannelDecision) -> set[str]:
    return {c.value for c in decision.channels}


def test_mandatory_critical_ignores_optout() -> None:
    # N-05: condemned (Critical/safety) sends on both channels even when the
    # recipient has unsubscribed and never opted into SMS.
    r = RecipientContext(
        email="c@x.com",
        phone_e164="+61400000000",
        email_verified=True,
        phone_verified=True,
        sms_opted_in=False,
        email_unsubscribed=True,
    )
    decision = resolve_channels(C.ASSET_CONDEMNED, r)
    assert _channels(decision) == {"EMAIL", "SMS"}


def test_important_sms_requires_optin() -> None:
    # N-04: Important (certificate issued) sends email always; SMS only on opt-in.
    no_optin = resolve_channels(
        C.CERTIFICATE_ISSUED,
        RecipientContext(
            email="c@x.com",
            phone_e164="+61400000000",
            email_verified=True,
            phone_verified=True,
        ),
    )
    assert _channels(no_optin) == {"EMAIL"}
    opted = resolve_channels(
        C.CERTIFICATE_ISSUED,
        RecipientContext(
            email="c@x.com",
            phone_e164="+61400000000",
            email_verified=True,
            phone_verified=True,
            sms_opted_in=True,
        ),
    )
    assert _channels(opted) == {"EMAIL", "SMS"}


def test_sms_requires_verified_phone() -> None:
    r = RecipientContext(
        email="c@x.com",
        phone_e164="+61400000000",
        email_verified=True,
        phone_verified=False,
        sms_opted_in=True,
    )
    decision = resolve_channels(C.CERTIFICATE_ISSUED, r)
    assert _channels(decision) == {"EMAIL"}
    assert any(ch is Ch.SMS and "verified" in why for ch, why in decision.suppressed)


def test_informational_unsubscribe_is_honoured() -> None:
    # N-10: informational email is suppressed when unsubscribed.
    r = RecipientContext(email="c@x.com", email_verified=True, email_unsubscribed=True)
    decision = resolve_channels(C.RETEST_ADVANCE, r)
    assert _channels(decision) == set()


def test_email_requires_verified_address() -> None:
    r = RecipientContext(email="c@x.com", email_verified=False)
    decision = resolve_channels(C.CERTIFICATE_ISSUED, r)
    assert "EMAIL" not in _channels(decision)


def test_idempotency_key_is_stable_and_channel_distinct() -> None:
    # N-07
    k_email = notification_idempotency_key(
        event_ref="evt1",
        recipient_type=RecipientType.USER,
        recipient_id="u1",
        channel=Ch.EMAIL,
    )
    assert k_email == notification_idempotency_key(
        event_ref="evt1",
        recipient_type=RecipientType.USER,
        recipient_id="u1",
        channel=Ch.EMAIL,
    )
    assert k_email != notification_idempotency_key(
        event_ref="evt1",
        recipient_type=RecipientType.USER,
        recipient_id="u1",
        channel=Ch.SMS,
    )
    assert len(k_email) == 64


def test_template_email_has_sender_id_and_html() -> None:
    m = render(
        C.CERTIFICATE_ISSUED,
        Ch.EMAIL,
        {
            "asset_number": "HA-1",
            "customer_name": "Acme",
            "certificate_number": "CERT-1",
            "link": "https://x/verify/t",
        },
        issuer_identifier="ABN 123",
    )
    assert "CERT-1" in m.subject
    assert "BAT Engineering" in m.body_text  # sender identification
    assert m.body_html is not None


def test_template_informational_includes_unsubscribe() -> None:
    m = render(
        C.RETEST_ADVANCE,
        Ch.EMAIL,
        {"asset_number": "HA-1", "customer_name": "Acme", "due_date": "2027-01-01"},
        unsubscribe_url="https://x/unsub",
    )
    assert "Unsubscribe" in m.body_text


def test_template_sms_is_short_and_has_link() -> None:
    m = render(
        C.CERTIFICATE_ISSUED,
        Ch.SMS,
        {"asset_number": "HA-1", "certificate_number": "CERT-1", "link": "https://x/t"},
    )
    assert m.subject == ""
    assert "https://x/t" in m.body_text
