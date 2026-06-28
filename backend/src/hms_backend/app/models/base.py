from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from uuid6 import uuid7


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class SyncableMixin:
    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid7()),
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    legacy_system: Mapped[str | None] = mapped_column(String(80), nullable=True)
    legacy_table: Mapped[str | None] = mapped_column(String(80), nullable=True)
    legacy_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    legacy_payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    def to_audit_dict(self) -> dict[str, object | None]:
        from hms_backend.app.core.audit import normalise_for_json

        table = cast(Any, self).__table__
        return {
            column.name: normalise_for_json(getattr(self, column.name))
            for column in table.columns
        }
