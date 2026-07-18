from __future__ import annotations

# ruff: noqa: E402, F401, I001

from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import Date, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin

if TYPE_CHECKING:
    from hms_backend.app.modules.certificates.models import Certificate
    from hms_backend.app.modules.customers.models import Customer, CustomerLocation
    from hms_backend.app.modules.inspections.models import Inspection
    from hms_backend.app.modules.products.models import Product
    from hms_backend.app.modules.reference.models import (
        AttachMethod,
        Coupling,
        CouplingAddOn,
        Material,
        NominalBore,
    )
    from hms_backend.app.modules.scheduling.models import RetestSchedule


class AssetLifecycleStatus(StrEnum):
    DRAFT = "DRAFT"
    IN_SERVICE = "IN_SERVICE"
    DUE = "DUE"
    OVERDUE = "OVERDUE"
    CONDEMNED = "CONDEMNED"
    RETIRED = "RETIRED"


class AssetEnd(StrEnum):
    A = "A"
    B = "B"


class Asset(SyncableMixin, Base):
    __tablename__ = "assets"

    customer_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("customers.id"),
        nullable=False,
        index=True,
    )
    location_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("customer_locations.id"),
        nullable=True,
        index=True,
    )
    product_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("products.id"),
        nullable=False,
        index=True,
    )
    asset_number: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    asset_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    customer_serial_no: Mapped[str | None] = mapped_column(String(120), nullable=True)
    purchase_order_number: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )
    tag: Mapped[str | None] = mapped_column(String(120), nullable=True, unique=True)
    lifecycle_status: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default=AssetLifecycleStatus.DRAFT.value,
    )
    manufacture_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    installation_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    grave_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    next_retest_due_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    condemned_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    length_m: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    customer: Mapped[Customer] = relationship(back_populates="assets", lazy="selectin")
    location: Mapped[CustomerLocation | None] = relationship(
        back_populates="assets",
        lazy="selectin",
    )
    product: Mapped[Product] = relationship(lazy="selectin")
    ends: Mapped[list[AssetEndConfiguration]] = relationship(
        back_populates="asset",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    inspections: Mapped[list[Inspection]] = relationship(
        back_populates="asset",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    certificates: Mapped[list[Certificate]] = relationship(
        back_populates="asset",
        lazy="selectin",
    )
    retest_schedule: Mapped[RetestSchedule | None] = relationship(
        back_populates="asset",
        uselist=False,
        lazy="selectin",
    )


class AssetEndConfiguration(SyncableMixin, Base):
    __tablename__ = "asset_end_configurations"
    __table_args__ = (
        UniqueConstraint("asset_id", "end", name="uq_asset_end_config_asset_end"),
    )

    asset_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("assets.id"),
        nullable=False,
        index=True,
    )
    end: Mapped[str] = mapped_column(String(1), nullable=False)
    nominal_bore_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("nominal_bores.id"),
        nullable=True,
        index=True,
    )
    material_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("materials.id"),
        nullable=True,
        index=True,
    )
    coupling_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("couplings.id"),
        nullable=True,
        index=True,
    )
    coupling_add_on_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("coupling_add_ons.id"),
        nullable=True,
        index=True,
    )
    attach_method_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("attach_methods.id"),
        nullable=True,
        index=True,
    )
    fitting: Mapped[str | None] = mapped_column(String(160), nullable=True)
    size: Mapped[str | None] = mapped_column(String(80), nullable=True)

    asset: Mapped[Asset] = relationship(back_populates="ends", lazy="selectin")
    nominal_bore: Mapped[NominalBore | None] = relationship(lazy="selectin")
    material: Mapped[Material | None] = relationship(lazy="selectin")
    coupling: Mapped[Coupling | None] = relationship(lazy="selectin")
    coupling_add_on: Mapped[CouplingAddOn | None] = relationship(lazy="selectin")
    attach_method: Mapped[AttachMethod | None] = relationship(lazy="selectin")


from hms_backend.app.modules.certificates import models as _certificate_models  # noqa: E402,F401
from hms_backend.app.modules.inspections import models as _inspection_models  # noqa: E402,F401
from hms_backend.app.modules.scheduling import models as _scheduling_models  # noqa: E402,F401
