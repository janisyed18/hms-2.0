from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.models.foundation import AuditEvent


def normalise_for_json(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: normalise_for_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalise_for_json(item) for item in value]
    return value


REDACTED = "[REDACTED]"

# Fixed PostgreSQL transaction lock key for the one globally ordered hash chain.
_AUDIT_CHAIN_LOCK_KEY = 0x484D534155444954

# Credential material must never be stored in, or returned from, the audit trail.
# Matching is on the key name (case-insensitive, at any depth). Exact names are
# listed rather than a "password" substring so that harmless state such as
# ``must_change_password`` or ``failed_password_attempts`` stays visible.
_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "new_password",
        "current_password",
        "temporary_password",
        "password_hash",
        "token_hash",
        "code_digest",
        "recovery_codes",
        "mfa_secret",
        "authorization",
        "cookie",
        "api_key",
        "private_key",
        "pepper",
    }
)
_SENSITIVE_SUFFIXES = ("_secret", "_token", "_ciphertext", "_private_key")


def _is_sensitive_key(key: object) -> bool:
    name = str(key).lower()
    return name in _SENSITIVE_KEYS or name.endswith(_SENSITIVE_SUFFIXES)


def redact_sensitive(value: Any) -> Any:
    """Return a copy with credential values replaced by a fixed marker.

    A ``None`` value stays ``None`` so an audit reader can still see whether a
    credential was present, without seeing it. Used both when writing new audit
    events and when serving stored ones, so historical rows (kept byte-identical in
    the hash chain) are never returned with secret material.
    """
    if isinstance(value, dict):
        return {
            key: (
                REDACTED
                if _is_sensitive_key(key) and item is not None
                else redact_sensitive(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(
        normalise_for_json(value),
        sort_keys=True,
        separators=(",", ":"),
    )


def _audit_hash(event: AuditEvent) -> str:
    payload = {
        "actor_id": event.actor_id,
        "action": event.action,
        "entity": event.entity,
        "entity_id": event.entity_id,
        "before": event.before,
        "after": event.after,
        "timestamp": normalise_for_json(event.timestamp),
        "prev_hash": event.prev_hash,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


async def append_audit_event(
    session: AsyncSession,
    *,
    actor_id: str,
    action: str,
    entity: str,
    entity_id: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> AuditEvent:
    # Flush pending domain writes before taking the global lock. Otherwise a
    # concurrent transaction can hold a domain-row lock while waiting for it.
    await session.flush()
    await _acquire_audit_chain_lock(session)
    latest = await _latest_audit_event(session)
    normalised_before = redact_sensitive(normalise_for_json(before))
    normalised_after = redact_sensitive(normalise_for_json(after))
    event = AuditEvent(
        actor_id=actor_id,
        action=action,
        entity=entity,
        entity_id=entity_id,
        before=normalised_before,
        after=normalised_after,
        timestamp=datetime.now(UTC),
        prev_hash=latest.hash if latest else None,
        hash="",
    )
    event.hash = _audit_hash(event)
    session.add(event)
    await session.flush()
    return event


async def acquire_ledger_lock(session: AsyncSession) -> None:
    """Take the global, transaction-scoped ledger lock (PostgreSQL; no-op elsewhere).

    One lock orders every writer of the two append-only ledgers (the audit hash chain
    and the sync change log). It is held until the transaction ends, so anything
    numbered or chained *after* acquiring it commits in that same order.
    """
    await _acquire_audit_chain_lock(session)


async def _acquire_audit_chain_lock(session: AsyncSession) -> None:
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": _AUDIT_CHAIN_LOCK_KEY},
        )


async def _latest_audit_event(session: AsyncSession) -> AuditEvent | None:
    return (
        await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence.desc()))
    ).first()


async def verify_audit_chain(session: AsyncSession) -> bool:
    events = (
        await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
    ).all()
    previous_hash: str | None = None

    for event in events:
        if event.prev_hash != previous_hash:
            return False
        if event.hash != _audit_hash(event):
            return False
        previous_hash = event.hash

    return True
