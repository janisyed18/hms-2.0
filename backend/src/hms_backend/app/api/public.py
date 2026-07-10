"""Public, unauthenticated certificate verification.

A certificate's ``public_token`` is a capability: anyone holding it (e.g. by
scanning the QR code on the PDF) can confirm the certificate is genuine and
unmodified, and download the signed PDF. No customer data beyond what is printed
on the certificate is exposed, and the token cannot be used to enumerate other
certificates.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.api.schemas import CertificateVerifyResponse
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    ObjectNotFoundError,
    PresignedObjectStorage,
    get_object_storage,
)
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.mapping import (
    build_facts,
    to_verification_input,
)
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.certificates.verification import compute_verification_hash

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
    inspection = certificate.inspection

    facts = build_facts(
        inspection,
        certificate_number=certificate.number,
        certificate_version=certificate.certificate_version,
        status=certificate.status,
        issued_at=certificate.issued_at,
        valid_until=certificate.valid_until,
        public_token=certificate.public_token,
        verify_url="",  # not part of the hash
        issued_by_name=certificate.issued_by_user_id,
        issuer_name=settings.issuer_name,
        issuer_identifier=settings.issuer_identifier,
    )
    recomputed = compute_verification_hash(to_verification_input(facts))
    hash_matches = recomputed == certificate.verification_hash

    is_active = certificate.status == CertificateStatus.ISSUED.value
    valid = hash_matches and is_active
    product = certificate.asset.product
    standard = getattr(product, "standard", None)

    if not hash_matches:
        message = (
            "Verification FAILED: the certificate content does not match its "
            "recorded hash. Do not rely on this document."
        )
    elif not is_active:
        message = (
            f"This certificate is {certificate.status.lower()} and is no longer "
            "valid, though its content is authentic."
        )
    else:
        message = "Certificate is authentic and active."

    return CertificateVerifyResponse(
        valid=valid,
        status=certificate.status,
        hash_matches=hash_matches,
        signed=True,
        certificate_number=certificate.number,
        certificate_version=certificate.certificate_version,
        issued_at=certificate.issued_at,
        valid_until=certificate.valid_until,
        verification_hash=certificate.verification_hash,
        asset_number=certificate.asset.asset_number,
        customer_name=certificate.asset.customer.name,
        product_name=product.name,
        standard_code=getattr(standard, "code", None),
        inspection_result=inspection.result,
        message=message,
    )


@router.get("/verify/{public_token}/pdf")
async def download_certificate_pdf(
    public_token: str,
    session: SessionDep,
) -> Response:
    certificate = await _load_by_token(session, public_token)
    storage = get_object_storage()

    # With an S3-backed store, redirect the client straight to a short-lived
    # presigned URL so the (potentially large) PDF is served by S3 rather than
    # streamed through the API task. Missing objects surface as a clean 404.
    if isinstance(storage, PresignedObjectStorage):
        if not storage.exists(certificate.pdf_object_key):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Certificate PDF is not available",
            )
        url = storage.presigned_get_url(certificate.pdf_object_key)
        return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    try:
        pdf = storage.get(certificate.pdf_object_key)
    except ObjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Certificate PDF is not available",
        ) from exc
    filename = f"{certificate.number}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
