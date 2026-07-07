"""Reusable certificate issuance service.

The render + sign + store + persist pipeline lives here so both the interactive
single-issue route and the Celery bulk task share one implementation. Callers own
the transaction: this function stages the certificate (and its audit + sync rows)
on the session but does not commit.
"""

from __future__ import annotations

import secrets
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as default_settings
from hms_backend.app.core.object_storage import ObjectStorage, get_object_storage
from hms_backend.app.core.repository import record_create
from hms_backend.app.modules.certificates.engine_client import (
    CertificateEngineClient,
    get_certificate_engine,
)
from hms_backend.app.modules.certificates.mapping import build_facts, to_proto
from hms_backend.app.modules.certificates.models import (
    Certificate,
    CertificateStatus,
)
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus


class CertificateAlreadyIssuedError(RuntimeError):
    """The inspection already has a certificate."""


class InspectionNotApprovedError(RuntimeError):
    """The inspection is not in the APPROVED state."""


def generate_public_token() -> str:
    return secrets.token_urlsafe(24)


def generate_certificate_number(inspection: Inspection, issued_at: datetime) -> str:
    asset_number = inspection.asset.asset_number if inspection.asset else "ASSET"
    return f"CERT-{asset_number}-{issued_at:%Y%m%d}-{secrets.token_hex(3).upper()}"


async def generate_and_store_certificate(
    session: AsyncSession,
    inspection: Inspection,
    *,
    actor_id: str,
    valid_until: date | None = None,
    number: str | None = None,
    public_token: str | None = None,
    settings: Settings | None = None,
    engine: CertificateEngineClient | None = None,
    storage: ObjectStorage | None = None,
) -> Certificate:
    """Render, sign, store and stage a certificate for an approved inspection.

    Raises :class:`CertificateAlreadyIssuedError`,
    :class:`InspectionNotApprovedError`, or
    :class:`~hms_backend.app.modules.certificates.engine_client.CertificateEngineError`.
    Does not commit.
    """
    settings = settings or default_settings
    engine = engine or get_certificate_engine()
    storage = storage or get_object_storage()

    if inspection.certificate is not None:
        raise CertificateAlreadyIssuedError(
            "Certificate already issued for inspection"
        )
    if inspection.status != InspectionStatus.APPROVED.value:
        raise InspectionNotApprovedError(
            "certificate can only be issued from an approved inspection"
        )

    issued_at = datetime.now(UTC).replace(microsecond=0)
    number = (number or "").strip() or generate_certificate_number(
        inspection, issued_at
    )
    public_token = (public_token or "").strip() or generate_public_token()
    verify_url = (
        f"{settings.public_base_url.rstrip('/')}"
        f"/api/v1/certificates/verify/{public_token}"
    )
    facts = build_facts(
        inspection,
        certificate_number=number,
        certificate_version=1,
        status=CertificateStatus.ISSUED.value,
        issued_at=issued_at,
        valid_until=valid_until,
        public_token=public_token,
        verify_url=verify_url,
        issued_by_name=actor_id,
        issuer_name=settings.issuer_name,
        issuer_identifier=settings.issuer_identifier,
    )
    rendered = await engine.render(to_proto(facts))
    pdf_object_key = f"certificates/{number}-v1.pdf"
    storage.put(pdf_object_key, rendered.pdf)

    certificate = Certificate.issue_from_inspection(
        inspection,
        number=number,
        pdf_object_key=pdf_object_key,
        verification_hash=rendered.verification_hash,
        public_token=public_token,
        issued_by_user_id=actor_id,
        valid_until=valid_until,
    )
    certificate.issued_at = issued_at
    session.add(certificate)
    await record_create(
        session,
        certificate,
        actor_id=actor_id,
        action="certificate.issued",
    )
    return certificate
