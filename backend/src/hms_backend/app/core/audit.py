from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
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
    latest = (
        await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence.desc()))
    ).first()
    normalised_before = normalise_for_json(before)
    normalised_after = normalise_for_json(after)
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
