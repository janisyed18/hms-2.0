"""Durable claims for outbound messages (notifications and password-reset emails).

Sending an email or SMS is an external side effect no database transaction can undo.
Reading a ``PENDING`` row, sending, and only then recording ``SENT`` lets two
overlapping dispatchers (overlapping beat ticks, parallel workers, or a redelivered
acks-late task) send the same message. So a dispatcher first **claims** the row in its
own committed transaction, and only the holder of a claim may send.

* **Claim** is one atomic ``UPDATE ... WHERE status = 'PENDING' AND due``: of any number
  of concurrent claimants exactly one matches the row. It moves the row to ``SENDING``,
  increments ``attempts`` and sets ``scheduled_for`` to the *lease deadline*.
* **Fencing**: ``attempts`` is the fencing token. The final status write only applies
  while the row is still ``SENDING`` with that same ``attempts`` value, so a worker
  whose lease expired and whose row was re-claimed can never overwrite the newer
  claim's outcome.
* **Recovery**: a ``SENDING`` row whose lease has expired means a worker died (or hung)
  after claiming, so the outcome is unknown. It is requeued, or dead-lettered once it
  has used its attempts. This is deliberately at-least-once for that crash window: it
  can send a duplicate, never silently drop a message, and never loops forever.

No schema change: ``status`` is a free string and ``scheduled_for`` already means "when
this row is next eligible for processing".
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger("hms_backend.notifications.claims")

PENDING = "PENDING"
CLAIMED = "SENDING"
DEAD_LETTER = "DEAD_LETTER"

# Delays before retrying the final status write if the database hiccups after a send.
FINALISE_RETRY_DELAYS: tuple[float, ...] = (0.2, 0.5)


@dataclass(frozen=True)
class Claim:
    row_id: str
    token: int  # ``attempts`` at claim time: the fencing token


async def claim(
    session_factory: async_sessionmaker[AsyncSession],
    model: Any,
    row_id: str,
    *,
    now: datetime,
    lease_seconds: int,
) -> Claim | None:
    """Atomically claim a due ``PENDING`` row, or return None if someone else did."""
    statement = (
        update(model)
        .where(
            model.id == row_id,
            model.status == PENDING,
            or_(model.scheduled_for.is_(None), model.scheduled_for <= now),
        )
        .values(
            status=CLAIMED,
            attempts=model.attempts + 1,
            scheduled_for=now + timedelta(seconds=lease_seconds),
        )
        .returning(model.attempts)
    )
    async with session_factory() as session:
        token = (await session.execute(statement)).scalar_one_or_none()
        await session.commit()
    return None if token is None else Claim(row_id=row_id, token=int(token))


async def finalise(
    session_factory: async_sessionmaker[AsyncSession],
    model: Any,
    held: Claim,
    values: dict[str, Any],
    *,
    retry_delays: tuple[float, ...] | None = None,
) -> bool:
    """Record the outcome of a claimed send, only if the claim is still ours.

    Returns False when the claim was lost (the lease expired and the row was
    re-claimed), in which case nothing is written. A transient database failure is
    retried, because failing here after a successful send is how duplicates start.
    """
    delays = FINALISE_RETRY_DELAYS if retry_delays is None else retry_delays
    statement = (
        update(model)
        .where(
            model.id == held.row_id,
            model.status == CLAIMED,
            model.attempts == held.token,
        )
        .values(**values)
    )
    for attempt in range(len(delays) + 1):
        try:
            async with session_factory() as session:
                result = await session.execute(statement)
                await session.commit()
            return bool(result.rowcount)  # type: ignore[attr-defined]
        except Exception:
            if attempt == len(delays):
                raise
            await asyncio.sleep(delays[attempt])
    return False  # pragma: no cover - the loop always returns or raises


async def requeue_expired_claims(
    session_factory: async_sessionmaker[AsyncSession],
    model: Any,
    *,
    now: datetime,
    max_attempts: int,
    dead_letter_values: dict[str, Any] | None = None,
) -> dict[str, int]:
    """Resolve rows still ``SENDING`` after their lease: requeue or dead-letter."""
    expired = and_(model.status == CLAIMED, model.scheduled_for <= now)
    exhausted = (
        update(model)
        .where(expired, model.attempts >= max_attempts)
        .values(
            status=DEAD_LETTER,
            failed_at=now,
            error="delivery outcome unknown after the final attempt",
            **(dead_letter_values or {}),
        )
    )
    requeued = (
        update(model)
        .where(expired, model.attempts < max_attempts)
        .values(
            status=PENDING,
            scheduled_for=now,
            error="previous attempt did not complete; retrying",
        )
    )
    async with session_factory() as session:
        dead = (await session.execute(exhausted)).rowcount  # type: ignore[attr-defined]
        again = (await session.execute(requeued)).rowcount  # type: ignore[attr-defined]
        await session.commit()
    if dead or again:
        logger.warning(
            "resolved expired claims: %s requeued, %s dead-lettered", again, dead
        )
    return {"requeued": int(again), "dead_lettered": int(dead)}
