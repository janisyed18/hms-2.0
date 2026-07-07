from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from hms_backend.app.models.base import Base, SyncableMixin, utc_now
from hms_backend.app.modules.inspections.models import InspectionStatus

if TYPE_CHECKING:
    from hms_backend.app.modules.assets.models import Asset
    from hms_backend.app.modules.inspections.models import Inspection


class CertificateStatus(StrEnum):
    DRAFT = "DRAFT"
    ISSUED = "ISSUED"
    SUPERSEDED = "SUPERSEDED"
    REVOKED = "REVOKED"


class CertificateIssueError(ValueError):
    pass


# Asset lifecycle states that must never receive a new compliance certificate.
# String literals (not the AssetLifecycleStatus enum) are used to avoid a
# circular import between the certificates and assets modules.
NON_CERTIFIABLE_ASSET_STATUSES = frozenset({"CONDEMNED", "RETIRED"})


class Certificate(SyncableMixin, Base):
    __tablename__ = "certificates"

    inspection_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("inspections.id"),
        nullable=False,
        unique=True,
    )
    asset_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("assets.id"),
        nullable=False,
        index=True,
    )
    number: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    certificate_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    pdf_object_key: Mapped[str] = mapped_column(String(500), nullable=False)
    verification_hash: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        unique=True,
    )
    public_token: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    issued_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    status: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default=CertificateStatus.DRAFT.value,
    )

    inspection: Mapped[Inspection] = relationship(
        back_populates="certificate",
        lazy="selectin",
    )
    asset: Mapped[Asset] = relationship(back_populates="certificates", lazy="selectin")

    @classmethod
    def issue_from_inspection(
        cls,
        inspection: Inspection,
        *,
        number: str,
        pdf_object_key: str,
        verification_hash: str,
        public_token: str,
        issued_by_user_id: str,
        valid_until: date | None,
    ) -> Certificate:
        if inspection.status != InspectionStatus.APPROVED.value:
            raise CertificateIssueError(
                "certificate can only be issued from an approved inspection"
            )

        asset = inspection.asset
        if asset is not None and asset.lifecycle_status in (
            NON_CERTIFIABLE_ASSET_STATUSES
        ):
            raise CertificateIssueError(
                "cannot issue a certificate for a "
                f"{asset.lifecycle_status.lower()} asset"
            )

        return cls(
            inspection=inspection,
            asset=inspection.asset,
            number=number,
            certificate_version=1,
            valid_until=valid_until,
            pdf_object_key=pdf_object_key,
            verification_hash=verification_hash,
            public_token=public_token,
            issued_by_user_id=issued_by_user_id,
            status=CertificateStatus.ISSUED.value,
        )
