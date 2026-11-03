"""Shared rules for destructive and reversible record lifecycle actions."""

from __future__ import annotations

from collections.abc import Collection
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.models.base import Base

_LABELS = {
    "assets": "assets",
    "inspection_bookings": "inspection bookings",
    "inspection_appointments": "inspection appointments",
    "products": "products",
    "retest_schedules": "retest schedules",
    "users": "users",
    "user_customer_accesses": "customer user assignments",
    "asset_end_configurations": "asset end configurations",
}


def require_super_admin(principal: Principal, action: str = "delete") -> None:
    """Delete, archive and restore need Super Admin, not a generic permission."""
    if Role.SUPER_ADMIN not in principal.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Only a Super Admin can {action} records.",
        )


async def referencing_counts(
    session: AsyncSession,
    model: type[Any],
    record_id: str,
    *,
    ignore: Collection[str] = (),
) -> dict[str, int]:
    """Live (not logically deleted) rows pointing at ``record_id`` by foreign key."""
    target = model.__table__
    counts: dict[str, int] = {}
    for table in Base.metadata.sorted_tables:
        if table.name in ignore:
            continue
        for foreign_key in table.foreign_keys:
            if foreign_key.column.table is not target:
                continue
            statement = (
                select(func.count())
                .select_from(table)
                .where(foreign_key.parent == record_id)
            )
            if "deleted_at" in table.c:
                statement = statement.where(table.c.deleted_at.is_(None))
            found = await session.scalar(statement) or 0
            if found:
                counts[table.name] = counts.get(table.name, 0) + int(found)
    return counts


async def ensure_not_referenced(
    session: AsyncSession,
    model: type[Any],
    record_id: str,
    *,
    what: str,
    ignore: Collection[str] = (),
    alternative: str,
) -> None:
    """409 when history or live work still references the record."""
    counts = await referencing_counts(session, model, record_id, ignore=ignore)
    if not counts:
        return
    summary = ", ".join(
        f"{count} {_LABELS.get(table, table.replace('_', ' '))}"
        for table, count in sorted(counts.items())
    )
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"This {what} is still used by {summary}. {alternative}",
    )
