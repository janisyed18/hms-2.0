"""Read-only check that the database is safe to start notification workers against.

Starting the worker and beat services makes every due ``PENDING`` row sendable and
resumes outbox processing. This reports, from aggregates only, whether the rows the
dispatchers will meet are in a state they are designed for. It has no mutation mode:
every query runs in a PostgreSQL ``READ ONLY`` transaction that is always rolled back,
and the transaction is verified to be read-only before anything is read.

The report holds counts, statuses and ages only. It never selects an address, subject,
body, payload, ciphertext, token or error text.

Exit status: 0 ready, 1 activation-blocking conditions found, 2 the check itself failed.

* **Blockers** are states the dispatchers do not expect and would act on wrongly:
  an expired ``SENDING`` claim (a send of unknown outcome) or a finished
  password-reset delivery still retaining its ciphertext.
* **Warnings** are work that will start on activation. They are not wrong, but the
  reviewer should know the size of it before sending begins.

``outbox.unprocessed_by_*`` and ``password_resets.due_by_outcome`` are an activation
preview for a human to read: what relaying the backlog would work on, and what each due
password-reset row will do when the dispatcher reaches it (only ``valid`` and
``valid_superseded`` send an email; ``consumed``, ``expired`` and ``user_unavailable``
are dead-lettered unsent. ``not_selected_ciphertext_missing`` rows are never selected by
the dispatcher at all, so they stay ``PENDING`` untouched). They
carry type names, counts and ages, never identifiers or content, and never gate.

``outbox.processed_with_error`` is diagnostic only. A processed event legitimately
keeps its error text: a business event that failed once and then succeeded, and a
delivery receipt retired as unmatched or malformed, both end ``processed_at`` and
``error`` set. The columns cannot tell those from a historical race artifact, so the
count never gates activation.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from sqlalchemy import Select, and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncConnection

from hms_backend.app.api.dependencies import engine
from hms_backend.app.modules.identity.models import (
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent
from hms_backend.app.modules.notifications.outbox import RECEIPT_EVENT_TYPE

SENDING = "SENDING"
PENDING = "PENDING"
FINISHED_RESET_STATUSES = ("SENT", "DEAD_LETTER")
STATEMENT_TIMEOUT = "15s"
# Statuses are code-controlled constants. Anything else is reported as OTHER so a stray
# free-text value in the column can never reach the report.
_STATUS = re.compile(r"^[A-Z][A-Z_]{0,31}$")
# Event and aggregate types are code-controlled names (``DELIVERY_RECEIPT``, ``Asset``).
_TYPE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,79}$")
# The preview lists at most this many event-type x aggregate-type pairs.
_MAX_PAIRS = 50


def _status_key(raw: object) -> str:
    return raw if isinstance(raw, str) and _STATUS.match(raw) else "OTHER"


def _type_key(raw: object) -> str:
    return raw if isinstance(raw, str) and _TYPE_NAME.match(raw) else "OTHER"


def _age(now: datetime, moment: datetime | None) -> int | None:
    return None if moment is None else max(0, int((now - moment).total_seconds()))


async def _scalar(conn: AsyncConnection, statement: Select[Any]) -> int:
    value = (await conn.execute(statement)).scalar_one()
    return int(value or 0)


async def _by_status(conn: AsyncConnection, model: Any) -> dict[str, int]:
    rows = (
        await conn.execute(select(model.status, func.count()).group_by(model.status))
    ).all()
    counts: dict[str, int] = {}
    for status, count in rows:
        key = _status_key(status)
        counts[key] = counts.get(key, 0) + int(count)
    return dict(sorted(counts.items()))


def _count(*conditions: Any) -> Select[Any]:
    return select(func.count()).where(*conditions)


async def _notification_section(conn: AsyncConnection, now: datetime) -> dict[str, Any]:
    n = Notification
    return {
        "by_status": await _by_status(conn, n),
        "due_pending": await _scalar(
            conn,
            _count(
                n.status == PENDING,
                or_(n.scheduled_for.is_(None), n.scheduled_for <= now),
            ),
        ),
        "expired_sending": await _scalar(
            conn, _count(n.status == SENDING, n.scheduled_for <= now)
        ),
    }


async def _outbox_preview(conn: AsyncConnection, now: datetime) -> dict[str, Any]:
    """What relaying the backlog would work on: type names, counts and ages only."""
    e = OutboxEvent
    rows = (
        await conn.execute(
            select(
                e.event_type,
                e.aggregate_type,
                func.count(),
                func.min(e.occurred_at),
                func.max(e.occurred_at),
            )
            .where(e.processed_at.is_(None))
            .group_by(e.event_type, e.aggregate_type)
        )
    ).all()
    by_event: dict[str, dict[str, Any]] = {}
    by_aggregate: dict[str, int] = {}
    pairs: dict[tuple[str, str], int] = {}
    for event_type, aggregate_type, count, oldest, newest in rows:
        event_key, aggregate_key = _type_key(event_type), _type_key(aggregate_type)
        entry = by_event.setdefault(
            event_key,
            {"count": 0, "oldest": oldest, "newest": newest},
        )
        entry["count"] += int(count)
        entry["oldest"] = min(entry["oldest"], oldest)
        entry["newest"] = max(entry["newest"], newest)
        by_aggregate[aggregate_key] = by_aggregate.get(aggregate_key, 0) + int(count)
        pairs[(event_key, aggregate_key)] = pairs.get(
            (event_key, aggregate_key), 0
        ) + int(count)
    ranked = sorted(pairs.items(), key=lambda item: (-item[1], item[0]))
    return {
        "unprocessed_by_event_type": {
            key: {
                "count": entry["count"],
                "oldest_age_seconds": _age(now, entry["oldest"]),
                "newest_age_seconds": _age(now, entry["newest"]),
            }
            for key, entry in sorted(by_event.items())
        },
        "unprocessed_by_aggregate_type": dict(sorted(by_aggregate.items())),
        "unprocessed_by_event_and_aggregate_type": [
            {"event_type": pair[0], "aggregate_type": pair[1], "count": count}
            for pair, count in ranked[:_MAX_PAIRS]
        ],
        "unprocessed_pairs_truncated": len(ranked) > _MAX_PAIRS,
    }


async def _reset_due_outcomes(conn: AsyncConnection, now: datetime) -> dict[str, int]:
    """Classify due PENDING resets the way the dispatcher will, in the same order."""
    p, t, u = PasswordResetDelivery, PasswordResetToken, User
    outcome = case(
        (p.ciphertext.is_(None), "not_selected_ciphertext_missing"),
        (t.id.is_(None), "reset_token_missing"),
        (t.consumed_at.is_not(None), "consumed"),
        (t.expires_at <= now, "expired"),
        (or_(u.id.is_(None), u.deleted_at.is_not(None)), "user_unavailable"),
        (t.superseded_at.is_not(None), "valid_superseded"),
        else_="valid",
    )
    rows = (
        await conn.execute(
            select(outcome, func.count())
            .select_from(p)
            .outerjoin(t, t.id == p.reset_id)
            .outerjoin(u, u.id == t.user_id)
            .where(p.status == PENDING, p.scheduled_for <= now)
            .group_by(outcome)
        )
    ).all()
    return dict(sorted((str(name), int(count)) for name, count in rows))


async def _outbox_section(conn: AsyncConnection, now: datetime) -> dict[str, Any]:
    e = OutboxEvent
    unprocessed = e.processed_at.is_(None)
    oldest = (
        await conn.execute(select(func.min(e.occurred_at)).where(unprocessed))
    ).scalar_one()
    return {
        "unprocessed": await _scalar(conn, _count(unprocessed)),
        "unprocessed_parked_receipts": await _scalar(
            conn, _count(unprocessed, e.event_type == RECEIPT_EVENT_TYPE)
        ),
        "unprocessed_with_error": await _scalar(
            conn, _count(unprocessed, e.error.is_not(None))
        ),
        "unprocessed_max_attempts": await _scalar(
            conn, select(func.max(e.attempts)).where(unprocessed)
        ),
        "unprocessed_oldest_age_seconds": (
            None if oldest is None else max(0, int((now - oldest).total_seconds()))
        ),
        **await _outbox_preview(conn, now),
        "processed_with_error": await _scalar(
            conn, _count(e.processed_at.is_not(None), e.error.is_not(None))
        ),
    }


async def _password_reset_section(
    conn: AsyncConnection, now: datetime
) -> dict[str, Any]:
    p = PasswordResetDelivery
    return {
        "by_status": await _by_status(conn, p),
        "due_pending": await _scalar(
            conn, _count(p.status == PENDING, p.scheduled_for <= now)
        ),
        "due_by_outcome": await _reset_due_outcomes(conn, now),
        "expired_sending": await _scalar(
            conn, _count(p.status == SENDING, p.scheduled_for <= now)
        ),
        "finished_retaining_ciphertext": await _scalar(
            conn,
            _count(
                and_(p.status.in_(FINISHED_RESET_STATUSES), p.ciphertext.is_not(None))
            ),
        ),
    }


def evaluate(report: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    """Return ``(blockers, warnings)`` for a collected report."""
    notifications = report["notifications"]
    outbox = report["outbox"]
    resets = report["password_resets"]

    blockers: list[str] = []
    if notifications["expired_sending"]:
        blockers.append("notifications: expired SENDING claims")
    if resets["expired_sending"]:
        blockers.append("password_resets: expired SENDING claims")
    if resets["finished_retaining_ciphertext"]:
        blockers.append(
            "password_resets: SENT or DEAD_LETTER rows retaining ciphertext"
        )

    warnings: list[str] = []
    if notifications["due_pending"]:
        warnings.append("notifications: due PENDING rows will be sent on activation")
    if resets["due_pending"]:
        warnings.append("password_resets: due PENDING rows will be sent on activation")
    if outbox["unprocessed"]:
        warnings.append("outbox: unprocessed events will be relayed on activation")
    if outbox["unprocessed_with_error"]:
        warnings.append("outbox: unprocessed events already carry an error")
    return blockers, warnings


async def collect(conn: AsyncConnection) -> dict[str, Any]:
    """Run every check on ``conn``, which must already be in a read-only transaction."""
    now: datetime = (await conn.execute(select(func.now()))).scalar_one()
    report: dict[str, Any] = {
        "notifications": await _notification_section(conn, now),
        "outbox": await _outbox_section(conn, now),
        "password_resets": await _password_reset_section(conn, now),
    }
    blockers, warnings = evaluate(report)
    report["blockers"] = blockers
    report["warnings"] = warnings
    report["ready"] = not blockers
    return report


async def begin_read_only(conn: AsyncConnection) -> None:
    """Make the open transaction read-only, and refuse to continue unless it is."""
    await conn.execute(text("SET TRANSACTION READ ONLY"))
    await conn.execute(text(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"))
    mode = (await conn.execute(text("SHOW transaction_read_only"))).scalar_one()
    if mode != "on":
        raise RuntimeError("could not establish a read-only transaction")


async def run() -> dict[str, Any]:
    async with engine.connect() as conn:
        try:
            await begin_read_only(conn)
            return await collect(conn)
        finally:
            await conn.rollback()


def main() -> None:
    try:
        report = asyncio.run(run())
    except Exception as exc:  # report the class only: messages can echo connection data
        print(json.dumps({"ready": False, "error": type(exc).__name__}))
        sys.exit(2)
    print(json.dumps(report, sort_keys=True))
    sys.exit(0 if report["ready"] else 1)


if __name__ == "__main__":
    main()
