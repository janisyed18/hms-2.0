from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin

if TYPE_CHECKING:
    from hms_backend.app.modules.assets.models import Asset
    from hms_backend.app.modules.certificates.models import Certificate


class InspectionType(StrEnum):
    NEW_ASSET = "NEW_ASSET"
    SERVICE = "SERVICE"


class InspectionStatus(StrEnum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class InspectionTemplate(SyncableMixin, Base):
    __tablename__ = "inspection_templates"

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    inspection_type: Mapped[str] = mapped_column(String(40), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    questions: Mapped[list[InspectionQuestion]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class InspectionQuestion(SyncableMixin, Base):
    __tablename__ = "inspection_questions"

    template_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("inspection_templates.id"),
        nullable=False,
        index=True,
    )
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    response_type: Mapped[str] = mapped_column(String(40), nullable=False)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)

    template: Mapped[InspectionTemplate] = relationship(
        back_populates="questions",
        lazy="selectin",
    )
    answers: Mapped[list[InspectionAnswer]] = relationship(
        back_populates="question",
        lazy="selectin",
    )


class Inspection(SyncableMixin, Base):
    __tablename__ = "inspections"

    asset_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("assets.id"),
        nullable=False,
        index=True,
    )
    inspection_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default=InspectionStatus.DRAFT.value,
    )
    result: Mapped[str | None] = mapped_column(String(40), nullable=True)
    inspector_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    reviewer_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    rejected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    asset: Mapped[Asset] = relationship(back_populates="inspections", lazy="selectin")
    answers: Mapped[list[InspectionAnswer]] = relationship(
        back_populates="inspection",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    photos: Mapped[list[InspectionPhoto]] = relationship(
        back_populates="inspection",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    pressure_test: Mapped[PressureTestResult | None] = relationship(
        back_populates="inspection",
        cascade="all, delete-orphan",
        uselist=False,
        lazy="selectin",
    )
    certificate: Mapped[Certificate | None] = relationship(
        back_populates="inspection",
        uselist=False,
        lazy="selectin",
    )


class InspectionAnswer(SyncableMixin, Base):
    __tablename__ = "inspection_answers"

    inspection_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("inspections.id"),
        nullable=False,
        index=True,
    )
    question_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("inspection_questions.id"),
        nullable=True,
        index=True,
    )
    answer: Mapped[dict[str, Any] | str | bool | int | float | None] = mapped_column(
        JSON,
        nullable=True,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    inspection: Mapped[Inspection] = relationship(
        back_populates="answers",
        lazy="selectin",
    )
    question: Mapped[InspectionQuestion | None] = relationship(
        back_populates="answers",
        lazy="selectin",
    )


class PressureTestResult(SyncableMixin, Base):
    __tablename__ = "pressure_test_results"

    inspection_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("inspections.id"),
        nullable=False,
        unique=True,
    )
    applied_pressure_kpa: Mapped[int] = mapped_column(Integer, nullable=False)
    hold_time_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    measurements: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    inspection: Mapped[Inspection] = relationship(
        back_populates="pressure_test",
        lazy="selectin",
    )


class InspectionPhoto(SyncableMixin, Base):
    __tablename__ = "inspection_photos"

    inspection_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("inspections.id"),
        nullable=False,
        index=True,
    )
    object_key: Mapped[str] = mapped_column(String(500), nullable=False)
    caption: Mapped[str | None] = mapped_column(String(240), nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    inspection: Mapped[Inspection] = relationship(
        back_populates="photos",
        lazy="selectin",
    )
