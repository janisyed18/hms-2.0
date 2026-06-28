from __future__ import annotations

from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from hms_backend.app.models.base import Base, SyncableMixin


class LookupMixin(SyncableMixin):
    __abstract__ = True

    code: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Coupling(LookupMixin, Base):
    __tablename__ = "couplings"


class CouplingAddOn(LookupMixin, Base):
    __tablename__ = "coupling_add_ons"


class AttachMethod(LookupMixin, Base):
    __tablename__ = "attach_methods"


class Material(LookupMixin, Base):
    __tablename__ = "materials"


class NominalBore(SyncableMixin, Base):
    __tablename__ = "nominal_bores"

    code: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Standard(LookupMixin, Base):
    __tablename__ = "standards"
