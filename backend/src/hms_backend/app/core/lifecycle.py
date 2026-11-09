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


# Which column names a blocking record to a person; tables not listed give a count only.
_RECORD_NAME_COLUMNS = {
    "assets": "asset_number",
    "products": "name",
    "users": "email",
}
_MAX_SAMPLES = 5


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


async def blocking_references(
    session: AsyncSession,
    model: type[Any],
    record_id: str,
    *,
    ignore: Collection[str] = (),
) -> list[dict[str, Any]]:
    """What still refers to the record: per table a count and a few named samples.

    Read-only counterpart of ``ensure_not_referenced`` so the UI can show what blocks a
    delete before the person tries it. Samples are only ever a name already visible to a
    Super Admin; nothing here is a reason to relax the server-side check on delete.
    """
    counts = await referencing_counts(session, model, record_id, ignore=ignore)
    target = model.__table__
    blockers: list[dict[str, Any]] = []
    for table_name, count in sorted(counts.items()):
        records: list[dict[str, str]] = []
        name_column = _RECORD_NAME_COLUMNS.get(table_name)
        table = Base.metadata.tables[table_name]
        if name_column is not None and name_column in table.c:
            link = next(
                fk.parent for fk in table.foreign_keys if fk.column.table is target
            )
            statement = (
                select(table.c.id, table.c[name_column])
                .where(link == record_id)
                .order_by(table.c[name_column])
                .limit(_MAX_SAMPLES)
            )
            if "deleted_at" in table.c:
                statement = statement.where(table.c.deleted_at.is_(None))
            records = [
                {"id": str(row[0]), "name": str(row[1])}
                for row in (await session.execute(statement)).all()
            ]
        blockers.append(
            {
                "kind": table_name,
                "label": _LABELS.get(table_name, table_name.replace("_", " ")),
                "count": count,
                "records": records,
            }
        )
    return blockers
