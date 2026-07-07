"""Criticality-tier + consent channel policy (spec §4, §6; N-04, N-05, N-10).

Pure logic: given a category's policy and a recipient's verification + preference
context, decide which channels a notification is actually sent on, and record why
any candidate channel was suppressed. No ORM or IO here, so it is fully unit
testable.

Rules
-----
* CRITICAL (safety/security) and TRANSACTIONAL are **mandatory**: sent on their
  default channels regardless of marketing opt-out (N-05), still sender-identified.
* IMPORTANT: email always; SMS only if the recipient opted in.
* INFORMATIONAL: email-first and opt-out honoured (N-10); SMS only if opted in.
* SMS on any tier requires a **verified** phone (N-04). Opt-in is additionally
  required unless the tier is mandatory.
* EMAIL requires a verified email address before use (spec §6).
* IN_APP has no consent gate (internal delivery).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationTier,
)

_C = NotificationChannel
_T = NotificationTier
_Cat = NotificationCategory

MANDATORY_TIERS = frozenset({NotificationTier.CRITICAL, NotificationTier.TRANSACTIONAL})


@dataclass(frozen=True)
class CategoryPolicy:
    tier: NotificationTier
    # Maximal set of channels this category may use; actual send is filtered by
    # recipient consent/verification below.
    channels: tuple[NotificationChannel, ...]

    @property
    def mandatory(self) -> bool:
        return self.tier in MANDATORY_TIERS


# Derived from the lifecycle matrix (spec §7) and tier policy (spec §4).
CATEGORY_POLICIES: dict[NotificationCategory, CategoryPolicy] = {
    _Cat.RETEST_ADVANCE: CategoryPolicy(_T.INFORMATIONAL, (_C.EMAIL, _C.SMS)),
    _Cat.RETEST_DUE: CategoryPolicy(_T.IMPORTANT, (_C.EMAIL, _C.SMS)),
    _Cat.RETEST_OVERDUE: CategoryPolicy(_T.IMPORTANT, (_C.EMAIL, _C.SMS)),
    _Cat.SERVICE_BOOKED: CategoryPolicy(_T.INFORMATIONAL, (_C.EMAIL,)),
    _Cat.ASSET_APPROACHING_CONDEMNATION: CategoryPolicy(
        _T.INFORMATIONAL, (_C.EMAIL,)
    ),
    _Cat.ASSET_CONDEMNED: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.SMS)),
    _Cat.ASSET_RETIRED: CategoryPolicy(_T.INFORMATIONAL, (_C.EMAIL,)),
    _Cat.ASSET_BULK_IMPORT_COMPLETED: CategoryPolicy(
        _T.INFORMATIONAL, (_C.EMAIL, _C.IN_APP)
    ),
    _Cat.INSPECTION_SUBMITTED: CategoryPolicy(_T.IMPORTANT, (_C.EMAIL, _C.IN_APP)),
    _Cat.INSPECTION_APPROVED: CategoryPolicy(
        _T.INFORMATIONAL, (_C.EMAIL, _C.IN_APP)
    ),
    _Cat.INSPECTION_REJECTED: CategoryPolicy(_T.IMPORTANT, (_C.EMAIL, _C.SMS)),
    _Cat.INSPECTION_FAILED: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.SMS)),
    _Cat.CERTIFICATE_ISSUED: CategoryPolicy(_T.IMPORTANT, (_C.EMAIL, _C.SMS)),
    _Cat.CERTIFICATE_BULK_COMPLETED: CategoryPolicy(
        _T.INFORMATIONAL, (_C.EMAIL, _C.IN_APP)
    ),
    _Cat.CERTIFICATE_REVOKED: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.SMS)),
    _Cat.USER_INVITATION: CategoryPolicy(_T.TRANSACTIONAL, (_C.EMAIL,)),
    _Cat.PASSWORD_RESET: CategoryPolicy(_T.TRANSACTIONAL, (_C.EMAIL,)),
    _Cat.MFA_CODE: CategoryPolicy(_T.TRANSACTIONAL, (_C.SMS,)),
    _Cat.SUSPICIOUS_LOGIN: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.SMS)),
    _Cat.ROLE_CHANGED: CategoryPolicy(_T.INFORMATIONAL, (_C.EMAIL,)),
    _Cat.DEVICE_REGISTERED: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.SMS)),
    _Cat.DEVICE_REVOKED: CategoryPolicy(_T.CRITICAL, (_C.EMAIL, _C.IN_APP)),
    _Cat.OFFLINE_WINDOW_EXPIRING: CategoryPolicy(_T.IMPORTANT, (_C.IN_APP, _C.EMAIL)),
}


def policy_for(category: NotificationCategory) -> CategoryPolicy:
    return CATEGORY_POLICIES[category]


@dataclass(frozen=True)
class RecipientContext:
    """Per-recipient facts used to resolve channels for one category."""

    email: str | None = None
    phone_e164: str | None = None
    email_verified: bool = False
    phone_verified: bool = False
    # Per-category preferences:
    sms_opted_in: bool = False
    email_unsubscribed: bool = False  # only meaningful for INFORMATIONAL


@dataclass(frozen=True)
class ChannelDecision:
    channels: tuple[NotificationChannel, ...]
    suppressed: tuple[tuple[NotificationChannel, str], ...] = field(
        default_factory=tuple
    )


def resolve_channels(
    category: NotificationCategory,
    recipient: RecipientContext,
) -> ChannelDecision:
    """Return the channels a notification for ``category`` should actually send on."""
    policy = policy_for(category)
    send: list[NotificationChannel] = []
    suppressed: list[tuple[NotificationChannel, str]] = []

    for channel in policy.channels:
        ok, reason = _channel_allowed(policy, channel, recipient)
        if ok:
            send.append(channel)
        else:
            suppressed.append((channel, reason))

    return ChannelDecision(channels=tuple(send), suppressed=tuple(suppressed))


def _channel_allowed(
    policy: CategoryPolicy,
    channel: NotificationChannel,
    r: RecipientContext,
) -> tuple[bool, str]:
    if channel is NotificationChannel.IN_APP:
        return True, ""

    if channel is NotificationChannel.EMAIL:
        if not r.email:
            return False, "no email address"
        if not r.email_verified:
            return False, "email not verified"
        if policy.tier is NotificationTier.INFORMATIONAL and r.email_unsubscribed:
            return False, "unsubscribed"
        return True, ""

    if channel is NotificationChannel.SMS:
        if not r.phone_e164:
            return False, "no phone number"
        if not r.phone_verified:
            return False, "phone not verified"
        # Mandatory tiers (e.g. MFA, device registered) don't require opt-in,
        # but every other tier requires explicit SMS opt-in (N-04).
        if not policy.mandatory and not r.sms_opted_in:
            return False, "sms not opted in"
        if policy.tier is NotificationTier.INFORMATIONAL and r.email_unsubscribed:
            return False, "unsubscribed"
        return True, ""

    return False, "unknown channel"
