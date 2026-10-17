"""Public, unauthenticated certificate verification.

A certificate's ``public_token`` is a capability: anyone holding it (e.g. by
scanning the QR code on the PDF) can confirm the certificate is genuine and
unmodified, and download the signed PDF. No customer data beyond what is printed
on the certificate is exposed, and the token cannot be used to enumerate other
certificates.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.api.schemas import CertificateVerifyResponse
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    ObjectNotFoundError,
    ObjectStorage,
    PresignedObjectStorage,
    get_object_storage,
)
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.integrity import (
    assess_certificate,
    check_artifact,
)
from hms_backend.app.modules.certificates.models import Certificate

router = APIRouter(prefix="/certificates", tags=["public-verification"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def _load_by_token(session: AsyncSession, token: str) -> Certificate:
    statement = (
        select(Certificate)
        .where(Certificate.public_token == token, Certificate.deleted_at.is_(None))
        .options(
            selectinload(Certificate.inspection),
            selectinload(Certificate.asset).selectinload(Asset.customer),
            selectinload(Certificate.asset).selectinload(Asset.product),
            selectinload(Certificate.asset).selectinload(Asset.ends),
        )
    )
    certificate = (await session.scalars(statement)).first()
    if certificate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Certificate not found",
        )
    return certificate


@router.get("/verify/{public_token}", response_model=CertificateVerifyResponse)
async def verify_certificate(
    public_token: str,
    session: SessionDep,
) -> CertificateVerifyResponse:
    certificate = await _load_by_token(session, public_token)
    assessment = await assess_certificate(
        certificate, storage=get_object_storage(), settings=settings
    )

    facts = assessment.facts
    if facts is not None:
        # Verified against the issuance snapshot, never today's master data.
        asset_number = facts.asset_number
        customer_name = facts.customer_name
        product_name = facts.product_name
        standard_code: str | None = facts.standard_code or None
        inspection_result: str | None = facts.inspection_result or None
    else:
        asset = certificate.asset
        product = asset.product
        asset_number = asset.asset_number
        customer_name = asset.customer.name
        product_name = product.name
        standard_code = getattr(getattr(product, "standard", None), "code", None)
        inspection_result = certificate.inspection.result

    return CertificateVerifyResponse(
        valid=assessment.valid,
        status=certificate.status,
        integrity=assessment.integrity.value,
        hash_matches=assessment.hash_matches,
        artifact_verified=assessment.artifact_verified,
        signed=assessment.signature_verified,
        expired=assessment.expired,
        certificate_number=certificate.number,
        certificate_version=certificate.certificate_version,
        issued_at=certificate.issued_at,
        valid_until=certificate.valid_until,
        verification_hash=certificate.verification_hash,
        asset_number=asset_number,
        customer_name=customer_name,
        product_name=product_name,
        standard_code=standard_code,
        inspection_result=inspection_result,
        message=assessment.message,
    )


@router.get("/verify/{public_token}/pdf")
async def download_certificate_pdf(
    public_token: str,
    session: SessionDep,
    download: bool = Query(default=False),
) -> Response:
    certificate = await _load_by_token(session, public_token)
    storage = get_object_storage()
    filename = f"{certificate.number}.pdf"

    if certificate.issuance_facts is None or not certificate.pdf_sha256:
        # LEGACY_UNVERIFIED: no recorded evidence to check against. Still
        # downloadable (it is reported as unverified by /verify), served as before.
        return _legacy_pdf_response(certificate, storage, filename, download)

    # Fail closed: only hand out an artifact that matches its issuance evidence.
    # Authenticity gates the download, not business validity, so an expired or
    # revoked certificate's genuine PDF stays available (/verify reports it is no
    # longer valid). The verified bytes are served directly rather than redirected
    # so what is sent is exactly what was checked.
    artifact = await check_artifact(certificate, storage=storage, settings=settings)
    if artifact.pdf is None:
        if not artifact.exists:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Certificate PDF is not available",
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Certificate PDF failed integrity verification",
        )
    disposition = "attachment" if download else "inline"
    return Response(
        content=artifact.pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )


def _legacy_pdf_response(
    certificate: Certificate,
    storage: ObjectStorage,
    filename: str,
    download: bool,
) -> Response:
    # With an S3-backed store, redirect the client straight to a short-lived
    # presigned URL so the (potentially large) PDF is served by S3 rather than
    # streamed through the API task. Missing objects surface as a clean 404.
    if isinstance(storage, PresignedObjectStorage):
        if not storage.exists(certificate.pdf_object_key):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Certificate PDF is not available",
            )
        url = storage.presigned_get_url(
            certificate.pdf_object_key,
            download_filename=filename if download else None,
        )
        return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    try:
        pdf = storage.get(certificate.pdf_object_key)
    except ObjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Certificate PDF is not available",
        ) from exc
    disposition = "attachment" if download else "inline"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )
