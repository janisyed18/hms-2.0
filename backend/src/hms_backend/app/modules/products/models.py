from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin

if TYPE_CHECKING:
    from hms_backend.app.modules.reference.models import NominalBore, Standard


class Product(SyncableMixin, Base):
    __tablename__ = "products"

    category: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    sub_category: Mapped[str | None] = mapped_column(String(120), nullable=True)
    code: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    product_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(120), nullable=True)
    kind: Mapped[str | None] = mapped_column(String(120), nullable=True)
    test_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    standard_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("standards.id"),
        nullable=True,
        index=True,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    standard: Mapped[Standard | None] = relationship(lazy="selectin")
    pressure_ratings: Mapped[list[ProductPressureRating]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class ProductPressureRating(SyncableMixin, Base):
    __tablename__ = "product_pressure_ratings"
    __table_args__ = (
        UniqueConstraint(
            "product_id",
            "nominal_bore_id",
            name="uq_product_pressure_rating_product_bore",
        ),
    )

    product_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("products.id"),
        nullable=False,
        index=True,
    )
    nominal_bore_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("nominal_bores.id"),
        nullable=False,
        index=True,
    )
    working_pressure_kpa: Mapped[int] = mapped_column(Integer, nullable=False)
    test_pressure_kpa: Mapped[int] = mapped_column(Integer, nullable=False)

    product: Mapped[Product] = relationship(
        back_populates="pressure_ratings",
        lazy="selectin",
    )
    nominal_bore: Mapped[NominalBore] = relationship(lazy="selectin")
