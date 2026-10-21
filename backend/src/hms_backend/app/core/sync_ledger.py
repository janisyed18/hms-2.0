"""The single place a ``SyncChange`` row is created.

Clients read the change log with a cursor: "everything with ``seq`` greater than the
last one I saw". That is only correct if sequence order equals commit order. A
sequence number is allocated when the row is INSERTed, so if two transactions insert
before either commits, the one with the *lower* number can still commit *later*; a
client that has already advanced past the higher number never receives it.

``stage_sync_change`` therefore takes the global ledger lock **before** the INSERT, and
that lock is held until the transaction ends. Any other writer's sequence number is
then allocated only after this transaction has committed (or rolled back), so numbers
and commits stay in the same order and a cursor can never skip a committed change.

Pending domain writes are flushed before the lock is requested, so a transaction never
waits for the ledger lock while holding row locks it has not yet taken (the same
ordering ``append_audit_event`` uses).

Do not construct ``SyncChange`` anywhere else; a test enforces this.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.audit import acquire_ledger_lock
from hms_backend.app.models.foundation import SyncChange


async def stage_sync_change(
    session: AsyncSession,
    *,
    entity: str,
    entity_id: str,
    op: str,
    version: int,
) -> SyncChange:
    await session.flush()
    await acquire_ledger_lock(session)
    change = SyncChange(entity=entity, entity_id=entity_id, op=op, version=version)
    session.add(change)
    await session.flush()
    return change
