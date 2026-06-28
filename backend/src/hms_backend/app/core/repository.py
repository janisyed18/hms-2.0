from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.audit import append_audit_event
from hms_backend.app.models.foundation import SyncChange


class SyncableEntity(Protocol):
    id: str
    version: int
    deleted_at: datetime | None

    def to_audit_dict(self) -> dict[str, object | None]:
        ...


async def soft_delete(
    session: AsyncSession,
    entity: SyncableEntity,
    *,
    actor_id: str,
    action: str,
) -> None:
    before = entity.to_audit_dict()
    entity.deleted_at = datetime.now(UTC)
    entity.version += 1
    after = entity.to_audit_dict()

    session.add(
        SyncChange(
            entity=entity.__class__.__name__,
            entity_id=entity.id,
            op="delete",
            version=entity.version,
        )
    )
    await append_audit_event(
        session,
        actor_id=actor_id,
        action=action,
        entity=entity.__class__.__name__,
        entity_id=entity.id,
        before=before,
        after=after,
    )


async def record_create(
    session: AsyncSession,
    entity: SyncableEntity,
    *,
    actor_id: str,
    action: str,
) -> None:
    await session.flush()
    session.add(
        SyncChange(
            entity=entity.__class__.__name__,
            entity_id=entity.id,
            op="create",
            version=entity.version,
        )
    )
    await append_audit_event(
        session,
        actor_id=actor_id,
        action=action,
        entity=entity.__class__.__name__,
        entity_id=entity.id,
        before=None,
        after=entity.to_audit_dict(),
    )


async def record_update(
    session: AsyncSession,
    entity: SyncableEntity,
    *,
    actor_id: str,
    action: str,
    before: dict[str, object | None],
) -> None:
    entity.version += 1
    after = entity.to_audit_dict()
    session.add(
        SyncChange(
            entity=entity.__class__.__name__,
            entity_id=entity.id,
            op="update",
            version=entity.version,
        )
    )
    await append_audit_event(
        session,
        actor_id=actor_id,
        action=action,
        entity=entity.__class__.__name__,
        entity_id=entity.id,
        before=before,
        after=after,
    )
