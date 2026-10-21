"""Transactional outbox emit helpers (spec §3.1; N-01).

Business code calls :func:`emit_event` inside its own transaction, *before*
commit. If the transaction rolls back, the event is never written and nothing is
ever notified. The relay later turns committed events into notifications.
"""

from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.models import OutboxEvent

# ``notification_outbox.aggregate_id`` is a 36-character column, but a device id is up
# to 80 (inspector browsers use ``inspector-browser-<uuid>``, 54). Recipients are
# addressed from the payload, never from this column, so an over-long id is mapped to a
# stable 36-character UUID instead of failing the whole request on PostgreSQL.
_AGGREGATE_ID_WIDTH = 36


def bounded_aggregate_id(aggregate_id: str) -> str:
    if len(aggregate_id) <= _AGGREGATE_ID_WIDTH:
        return aggregate_id
    return str(uuid5(NAMESPACE_URL, f"hms:outbox-aggregate:{aggregate_id}"))


async def emit_event(
    session: AsyncSession,
    *,
    category: NotificationCategory,
    aggregate_type: str,
    aggregate_id: str,
    payload: dict[str, Any],
    dedupe_key: str | None = None,
) -> OutboxEvent:
    """Stage an outbox event on the current session (no commit).

    ``event_type`` is the category value, so the relay maps it back directly.
    """
    event = OutboxEvent(
        event_type=category.value,
        aggregate_type=aggregate_type,
        aggregate_id=bounded_aggregate_id(aggregate_id),
        payload=payload,
        dedupe_key=dedupe_key,
    )
    session.add(event)
    return event


async def emit_event_if_absent(
    session: AsyncSession,
    *,
    category: NotificationCategory,
    aggregate_type: str,
    aggregate_id: str,
    payload: dict[str, Any],
    dedupe_key: str,
) -> OutboxEvent | None:
    """Emit only if no event with ``dedupe_key`` exists (idempotent scheduler)."""
    existing = await session.scalar(
        select(OutboxEvent.id).where(OutboxEvent.dedupe_key == dedupe_key)
    )
    if existing is not None:
        return None
    return await emit_event(
        session,
        category=category,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        payload=payload,
        dedupe_key=dedupe_key,
    )
