from __future__ import annotations

# ruff: noqa: E402, F401, I001

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin

if TYPE_CHECKING:
    from hms_backend.app.modules.assets.models import Asset
    from hms_backend.app.modules.scheduling.models import RetestSchedule


class Customer(SyncableMixin, Base):
    __tablename__ = "customers"

    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    retest_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    default_retest_months: Mapped[int | None] = mapped_column(Integer, nullable=True)

    locations: Mapped[list[CustomerLocation]] = relationship(
        back_populates="customer",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    contacts: Mapped[list[CustomerContact]] = relationship(
        back_populates="customer",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    assets: Mapped[list[Asset]] = relationship(
        back_populates="customer",
        lazy="selectin",
    )
    retest_schedules: Mapped[list[RetestSchedule]] = relationship(
        back_populates="customer",
        lazy="selectin",
    )


class CustomerLocation(SyncableMixin, Base):
    __tablename__ = "customer_locations"

    customer_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("customers.id"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    address_1: Mapped[str | None] = mapped_column(String(240), nullable=True)
    address_2: Mapped[str | None] = mapped_column(String(240), nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(80), nullable=True)
    country: Mapped[str | None] = mapped_column(String(80), nullable=True)

    customer: Mapped[Customer] = relationship(
        back_populates="locations",
        lazy="selectin",
    )
    assets: Mapped[list[Asset]] = relationship(
        back_populates="location",
        lazy="selectin",
    )


class CustomerContact(SyncableMixin, Base):
    __tablename__ = "customer_contacts"

    customer_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("customers.id"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(80), nullable=True)
    role: Mapped[str | None] = mapped_column(String(120), nullable=True)
    receives_retest_reminders: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
    )

    customer: Mapped[Customer] = relationship(
        back_populates="contacts",
        lazy="selectin",
    )


from hms_backend.app.modules.assets import models as _asset_models  # noqa: E402,F401
from hms_backend.app.modules.scheduling import models as _scheduling_models  # noqa: E402,F401
