"""Notification enums.

These use ``(str, Enum)`` rather than ``StrEnum`` so the pure policy/template
logic that depends on them stays importable on any Python 3.10+ interpreter and
independent of the ORM layer. The ORM models import these same values.
"""

from __future__ import annotations

# ruff: noqa: UP042 - intentionally (str, Enum) rather than StrEnum so this pure
# module (and the policy/template logic on top of it) stays importable and unit
# testable on Python 3.10+, independent of the ORM layer.
from enum import Enum


class NotificationTier(str, Enum):
    """Criticality tier (spec §4). Governs channel policy and opt-out rules."""

    CRITICAL = "CRITICAL"          # safety/security: both channels, mandatory
    TRANSACTIONAL = "TRANSACTIONAL"  # identity/account: mandatory, factual
    IMPORTANT = "IMPORTANT"        # email always, SMS if opted in
    INFORMATIONAL = "INFORMATIONAL"  # email-first, opt-out honoured, batchable


class NotificationChannel(str, Enum):
    EMAIL = "EMAIL"
    SMS = "SMS"
    IN_APP = "IN_APP"


class NotificationStatus(str, Enum):
    PENDING = "PENDING"
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"
    BOUNCED = "BOUNCED"
    SUPPRESSED = "SUPPRESSED"  # skipped by consent/policy — recorded, never sent
    DEAD_LETTER = "DEAD_LETTER"  # exhausted retries


class RecipientType(str, Enum):
    USER = "USER"
    CUSTOMER_CONTACT = "CUSTOMER_CONTACT"


class NotificationCategory(str, Enum):
    """Every notification-bearing event in the lifecycle matrix (spec §7)."""

    # Retest scheduling
    RETEST_ADVANCE = "RETEST_ADVANCE"
    RETEST_DUE = "RETEST_DUE"
    RETEST_OVERDUE = "RETEST_OVERDUE"
    SERVICE_BOOKED = "SERVICE_BOOKED"
    # Asset
    ASSET_APPROACHING_CONDEMNATION = "ASSET_APPROACHING_CONDEMNATION"
    ASSET_CONDEMNED = "ASSET_CONDEMNED"
    ASSET_RETIRED = "ASSET_RETIRED"
    ASSET_BULK_IMPORT_COMPLETED = "ASSET_BULK_IMPORT_COMPLETED"
    # Inspection
    INSPECTION_SUBMITTED = "INSPECTION_SUBMITTED"
    INSPECTION_APPROVED = "INSPECTION_APPROVED"
    INSPECTION_REJECTED = "INSPECTION_REJECTED"
    INSPECTION_FAILED = "INSPECTION_FAILED"
    # Certificate
    CERTIFICATE_ISSUED = "CERTIFICATE_ISSUED"
    CERTIFICATE_BULK_COMPLETED = "CERTIFICATE_BULK_COMPLETED"
    CERTIFICATE_REVOKED = "CERTIFICATE_REVOKED"
    # User / identity
    USER_INVITATION = "USER_INVITATION"
    PASSWORD_RESET = "PASSWORD_RESET"
    MFA_CODE = "MFA_CODE"
    SUSPICIOUS_LOGIN = "SUSPICIOUS_LOGIN"
    ROLE_CHANGED = "ROLE_CHANGED"
    # Device / mobile security
    DEVICE_REGISTERED = "DEVICE_REGISTERED"
    DEVICE_REVOKED = "DEVICE_REVOKED"
    OFFLINE_WINDOW_EXPIRING = "OFFLINE_WINDOW_EXPIRING"
