"""Transactional outbox emit helpers (spec §3.1; N-01).

Business code calls :func:`emit_event` inside its own transaction, *before*
commit. If the transaction rolls back, the event is never written and nothing is
ever notified. The relay later turns committed events into notifications.
"""

from __future__ import annotations

import hashlib
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationStatus,
)
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
    """Emit only if no event with ``dedupe_key`` exists (idempotent scheduler).

    Safe against a concurrent emitter of the same key: the insert runs in a savepoint,
    so losing the race to the unique key (another transaction created it first) returns
    None instead of failing the caller's whole transaction.
    """
    existing = await session.scalar(
        select(OutboxEvent.id).where(OutboxEvent.dedupe_key == dedupe_key)
    )
    if existing is not None:
        return None
    try:
        async with session.begin_nested():
            return await emit_event(
                session,
                category=category,
                aggregate_type=aggregate_type,
                aggregate_id=aggregate_id,
                payload=payload,
                dedupe_key=dedupe_key,
            )
    except IntegrityError:
        return None


# A delivery receipt that matches no notification yet. A provider can report delivery
# before the dispatcher has stored the ``provider_message_id`` the receipt is keyed on
# (even before ``send`` has returned), and the webhook answers 2xx so the provider does
# not retry. Such a receipt is parked here, as an outbox row of this type, until the
# relay finds its notification. These rows are not notification events: the relay
# handles them separately and never feeds them to the category pipeline.
RECEIPT_EVENT_TYPE = "DELIVERY_RECEIPT"
_DEDUPE_KEY_WIDTH = 200


def receipt_dedupe_key(provider_message_id: str, status: NotificationStatus) -> str:
    key = f"receipt:{provider_message_id}:{status.value}"
    if len(key) <= _DEDUPE_KEY_WIDTH:
        return key
    return "receipt:" + hashlib.sha256(key.encode()).hexdigest()


async def defer_receipt(
    session: AsyncSession,
    *,
    provider_message_id: str,
    status: NotificationStatus,
) -> OutboxEvent | None:
    """Park a receipt that matched nothing. Returns None if it is already parked."""
    key = receipt_dedupe_key(provider_message_id, status)
    existing = await session.scalar(
        select(OutboxEvent.id).where(OutboxEvent.dedupe_key == key)
    )
    if existing is not None:
        return None
    event = OutboxEvent(
        event_type=RECEIPT_EVENT_TYPE,
        aggregate_type="delivery_receipt",
        aggregate_id=bounded_aggregate_id(provider_message_id),
        payload={"provider_message_id": provider_message_id, "status": status.value},
        dedupe_key=key,
    )
    try:
        # A savepoint, so a provider retrying the same callback concurrently (a unique
        # key violation) leaves the caller's transaction intact.
        async with session.begin_nested():
            session.add(event)
            await session.flush()
    except IntegrityError:
        return None
    return event
