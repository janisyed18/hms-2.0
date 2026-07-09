"""Versioned, channel-specific notification templates (spec §8).

Defaults live in code as a registry; a ``NotificationTemplate`` DB row with the
same ``key`` may override wording without a deployment (looked up by the relay
before falling back here). Email renders both HTML and plain text; SMS is short
with a deep link. Non-essential categories get an unsubscribe line; every message
is sender-identified (BAT) for Spam Act compliance (N-10).
"""

from __future__ import annotations

from dataclasses import dataclass

from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationTier,
)
from hms_backend.app.modules.notifications.policy import policy_for

_Cat = NotificationCategory
_Ch = NotificationChannel


class _SafeDict(dict[str, object]):
    def __missing__(self, key: str) -> str:  # noqa: D401
        return ""


@dataclass(frozen=True)
class RenderedMessage:
    subject: str
    body_text: str
    body_html: str | None
    template_key: str
    template_version: int


@dataclass(frozen=True)
class _Template:
    subject: str
    body: str  # plain-text body (also used to build HTML)
    version: int = 1


# key = (category, channel). SMS templates omit a subject.
_TEMPLATES: dict[tuple[NotificationCategory, NotificationChannel], _Template] = {
    (_Cat.INSPECTION_SUBMITTED, _Ch.EMAIL): _Template(
        "Inspection {inspection_id} awaiting your review",
        "An inspection for asset {asset_number} ({customer_name}) has been "
        "submitted and is awaiting review.\n\nOpen it in HMS to review and "
        "approve or reject.",
    ),
    (_Cat.INSPECTION_REJECTED, _Ch.EMAIL): _Template(
        "Inspection {inspection_id} rejected — action needed",
        "Your inspection for asset {asset_number} was rejected and needs "
        "re-inspection.\n\nReason: {reason}",
    ),
    (_Cat.INSPECTION_REJECTED, _Ch.SMS): _Template(
        "", "HMS: inspection for {asset_number} rejected — re-inspection needed. {link}"
    ),
    (_Cat.INSPECTION_APPROVED, _Ch.EMAIL): _Template(
        "Inspection {inspection_id} approved",
        "Your inspection for asset {asset_number} has been approved.",
    ),
    (_Cat.INSPECTION_FAILED, _Ch.EMAIL): _Template(
        "SAFETY: asset {asset_number} failed inspection",
        "Asset {asset_number} ({customer_name}) failed inspection and must be "
        "removed from service pending assessment.",
    ),
    (_Cat.INSPECTION_FAILED, _Ch.SMS): _Template(
        "",
        "HMS SAFETY: asset {asset_number} FAILED inspection. "
        "Remove from service. {link}",
    ),
    (_Cat.CERTIFICATE_ISSUED, _Ch.EMAIL): _Template(
        "Certificate {certificate_number} issued for asset {asset_number}",
        "A test certificate has been issued for asset {asset_number} "
        "({customer_name}).\n\nView and verify it here: {link}",
    ),
    (_Cat.CERTIFICATE_ISSUED, _Ch.SMS): _Template(
        "", "HMS: certificate {certificate_number} issued for {asset_number}. {link}"
    ),
    (_Cat.CERTIFICATE_REVOKED, _Ch.EMAIL): _Template(
        "Certificate {certificate_number} revoked",
        "Certificate {certificate_number} for asset {asset_number} has been "
        "revoked and is no longer valid.",
    ),
    (_Cat.CERTIFICATE_REVOKED, _Ch.SMS): _Template(
        "", "HMS: certificate {certificate_number} for {asset_number} REVOKED. {link}"
    ),
    (_Cat.ASSET_CONDEMNED, _Ch.EMAIL): _Template(
        "SAFETY: asset {asset_number} condemned",
        "Asset {asset_number} ({customer_name}) has been condemned and must not "
        "be used. Please remove it from service immediately.",
    ),
    (_Cat.ASSET_CONDEMNED, _Ch.SMS): _Template(
        "", "HMS SAFETY: asset {asset_number} CONDEMNED. Do not use. {link}"
    ),
    (_Cat.ASSET_APPROACHING_CONDEMNATION, _Ch.EMAIL): _Template(
        "Asset {asset_number} approaching condemnation",
        "Asset {asset_number} ({customer_name}) is approaching its condemnation "
        "date ({grave_date}). Please plan its replacement.",
    ),
    (_Cat.RETEST_ADVANCE, _Ch.EMAIL): _Template(
        "Retest due soon for asset {asset_number}",
        "Asset {asset_number} ({customer_name}) is due for retest on "
        "{due_date} ({days_before} days). Please arrange testing.",
    ),
    (_Cat.RETEST_DUE, _Ch.EMAIL): _Template(
        "Retest due today for asset {asset_number}",
        "Asset {asset_number} ({customer_name}) is due for retest today "
        "({due_date}).",
    ),
    (_Cat.RETEST_DUE, _Ch.SMS): _Template(
        "", "HMS: asset {asset_number} retest due today ({due_date}). {link}"
    ),
    (_Cat.RETEST_OVERDUE, _Ch.EMAIL): _Template(
        "OVERDUE: retest for asset {asset_number}",
        "Asset {asset_number} ({customer_name}) retest is overdue since "
        "{due_date} ({days_overdue} days). Escalation level {escalation_level}.",
    ),
    (_Cat.RETEST_OVERDUE, _Ch.SMS): _Template(
        "", "HMS: asset {asset_number} retest OVERDUE {days_overdue}d. {link}"
    ),
    # --- Device & identity ---
    (_Cat.DEVICE_REGISTERED, _Ch.EMAIL): _Template(
        "New device registered on your HMS account",
        "A new device ({device_label}) was registered on your account. If this "
        "was not you, contact BAT Engineering immediately.",
    ),
    (_Cat.DEVICE_REGISTERED, _Ch.SMS): _Template(
        "", "HMS SECURITY: a new device was registered on your account. {link}"
    ),
    (_Cat.DEVICE_REVOKED, _Ch.EMAIL): _Template(
        "A device on your HMS account was revoked",
        "Device {device_label} has been revoked and will wipe its local data on "
        "next sync.",
    ),
    (_Cat.USER_INVITATION, _Ch.EMAIL): _Template(
        "You have been invited to BAT Engineering HMS",
        "An account has been created for you in HMS.\n\nActivate it here: {link}",
    ),
    (_Cat.PASSWORD_RESET, _Ch.EMAIL): _Template(
        "Reset your HMS password",
        "A password reset was requested for your HMS account.\n\nReset it here "
        "(link expires shortly): {link}\n\nIf you did not request this, you can "
        "ignore this email.",
    ),
    (_Cat.ROLE_CHANGED, _Ch.EMAIL): _Template(
        "Your HMS role was updated",
        "Your role in HMS has changed to {role}.",
    ),
}

_SENDER_LINE = "BAT Engineering — {issuer_identifier}"


def render(
    category: NotificationCategory,
    channel: NotificationChannel,
    context: dict[str, object],
    *,
    sender_name: str = "BAT Engineering",
    issuer_identifier: str = "",
    unsubscribe_url: str | None = None,
) -> RenderedMessage:
    """Render a message for a category/channel with sender ID + (opt-out) footer."""
    template = _TEMPLATES.get((category, channel)) or _fallback(category, channel)
    safe = _SafeDict(context)
    subject = template.subject.format_map(safe)
    body = template.body.format_map(safe)

    tier = policy_for(category).tier
    footer_parts = [_SENDER_LINE.format(issuer_identifier=issuer_identifier)]
    # Only non-essential (informational) messages carry an unsubscribe link.
    if (
        channel is NotificationChannel.EMAIL
        and tier is NotificationTier.INFORMATIONAL
        and unsubscribe_url
    ):
        footer_parts.append(f"Unsubscribe from these updates: {unsubscribe_url}")

    if channel is NotificationChannel.SMS:
        # SMS stays short: sender prefix only, no footer block.
        text = body if body.startswith("HMS") else f"{sender_name}: {body}"
        return RenderedMessage(
            subject="",
            body_text=text.strip(),
            body_html=None,
            template_key=f"{category.value}:{channel.value}",
            template_version=template.version,
        )

    footer = "\n\n" + "\n".join(footer_parts)
    body_text = body + footer
    body_html = _to_html(subject, body, footer_parts)
    return RenderedMessage(
        subject=subject or sender_name,
        body_text=body_text,
        body_html=body_html,
        template_key=f"{category.value}:{channel.value}",
        template_version=template.version,
    )


def _fallback(
    category: NotificationCategory, channel: NotificationChannel
) -> _Template:
    label = category.value.replace("_", " ").title()
    if channel is NotificationChannel.SMS:
        return _Template("", f"HMS: {label} — {{link}}")
    return _Template(
        f"HMS notification: {label}", f"{label} for asset {{asset_number}}."
    )


def _to_html(subject: str, body: str, footer_parts: list[str]) -> str:
    paragraphs = "".join(
        f"<p>{_escape(line)}</p>" for line in body.split("\n") if line.strip()
    )
    footer = "".join(
        f'<p style="color:#5b6b80;font-size:12px">{_escape(f)}</p>'
        for f in footer_parts
    )
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f2544">'
        f"<h2>{_escape(subject)}</h2>{paragraphs}<hr/>{footer}</div>"
    )


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
