from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin

if TYPE_CHECKING:
    from hms_backend.app.modules.assets.models import Asset
    from hms_backend.app.modules.customers.models import Customer


class RetestScheduleStatus(StrEnum):
    UPCOMING = "UPCOMING"
    DUE = "DUE"
    OVERDUE = "OVERDUE"
    SUSPENDED = "SUSPENDED"


class RetestSchedule(SyncableMixin, Base):
    __tablename__ = "retest_schedules"

    customer_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("customers.id"),
        nullable=False,
        index=True,
    )
    asset_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("assets.id"),
        nullable=False,
        unique=True,
    )
    due_at: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default=RetestScheduleStatus.UPCOMING.value,
    )
    reminder_interval_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=30,
    )
    escalation_interval_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=7,
    )
    last_reminded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    escalated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    customer: Mapped[Customer] = relationship(
        back_populates="retest_schedules",
        lazy="selectin",
    )
    asset: Mapped[Asset] = relationship(
        back_populates="retest_schedule",
        lazy="selectin",
    )
