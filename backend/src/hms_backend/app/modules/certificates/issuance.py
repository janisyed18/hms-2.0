"""Reusable certificate issuance service.

The render + sign + store + persist pipeline lives here so both the interactive
single-issue route and the Celery bulk task share one implementation. Callers own
the transaction: this function stages the certificate (and its audit + sync rows)
on the session but does not commit.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from uuid6 import uuid7

from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as default_settings
from hms_backend.app.core.object_storage import ObjectStorage, get_object_storage
from hms_backend.app.core.repository import record_create, record_update
from hms_backend.app.modules.certificates.engine_client import (
    CertificateEngineClient,
    get_certificate_engine,
)
from hms_backend.app.modules.certificates.integrity import pdf_sha256
from hms_backend.app.modules.certificates.mapping import (
    build_facts,
    facts_to_snapshot,
    to_proto,
)
from hms_backend.app.modules.certificates.models import (
    NON_CERTIFIABLE_ASSET_STATUSES,
    Certificate,
    CertificateStatus,
)
from hms_backend.app.modules.certificates.signature import averify_pdf_signature
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event


class CertificateAlreadyIssuedError(RuntimeError):
    """The inspection already has a certificate."""


class InspectionNotApprovedError(RuntimeError):
    """The inspection is not in the APPROVED state."""


class AssetNotCertifiableError(RuntimeError):
    """The asset's lifecycle state forbids issuing a certificate (e.g. condemned)."""


class CertificateConflictError(RuntimeError):
    """The certificate number or public token is already in use."""


class CertificateSignatureError(RuntimeError):
    """The rendered PDF is not signed by a signer the configured CA trusts."""


class CertificateStorageError(RuntimeError):
    """The stored PDF could not be read back identical to what was rendered."""


logger = logging.getLogger("hms_backend.certificates.issuance")


def _discard_artifact(storage: ObjectStorage, key: str) -> None:
    """Best-effort removal of an object no committed row can reference.

    Only called from a failure path of a transaction that never committed, so the
    key is unreferenced. A failed delete must not mask the original error: the
    orphan is then found by ``reconcile_certificate_artifacts``.
    """
    try:
        storage.delete(key)
    except Exception as exc:  # noqa: BLE001 - never mask the original failure
        logger.warning(
            "could not remove unreferenced certificate artifact %s (%s); "
            "reconcile_certificate_artifacts will find it",
            key,
            type(exc).__name__,
        )


async def _store_verified_artifact(
    storage: ObjectStorage, key: str, pdf: bytes
) -> None:
    """Write the PDF, then read it back and compare, before anything refers to it.

    A row must never point at an object that is missing or not byte-identical to
    what was rendered, signed and hashed.
    """
    await asyncio.to_thread(storage.put, key, pdf)
    stored = await asyncio.to_thread(storage.get, key)
    if pdf_sha256(stored) != pdf_sha256(pdf):
        raise CertificateStorageError(
            "stored certificate PDF does not match the rendered document"
        )


_REVISION_KEY = re.compile(r"^(?P<stem>.+?)(?:-r(?P<revision>\d+))?(?P<ext>\.[^./]+)?$")


def _require_regenerable(certificate: Certificate) -> None:
    if certificate.status != CertificateStatus.ISSUED.value:
        raise ValueError("only issued certificates can have their PDF regenerated")
    if certificate.issuance_facts is not None:
        # Certificates with integrity evidence are immutable: re-rendering from
        # current master data would silently replace what was actually issued.
        raise ValueError("a certificate with issuance evidence cannot be regenerated")


def next_revision_key(key: str) -> str:
    """Write-once key for the next regeneration of ``key``.

    ``certificates/<id>/v1.pdf`` -> ``certificates/<id>/v1-r1.pdf`` -> ``...-r2.pdf``.
    Deterministic, so a retry after a failed attempt targets the same (still
    unreferenced) key, while a committed artifact's key is never reused.
    """
    match = _REVISION_KEY.match(key)
    if match is None:  # pragma: no cover - the pattern matches any non-empty key
        return f"{key}-r1"
    revision = int(match.group("revision") or 0) + 1
    return f"{match.group('stem')}-r{revision}{match.group('ext') or ''}"


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
    issued_by_user_id: str | None = None,
    valid_until: date | None = None,
    number: str | None = None,
    public_token: str | None = None,
    settings: Settings | None = None,
    engine: CertificateEngineClient | None = None,
    storage: ObjectStorage | None = None,
) -> Certificate:
    """Render, sign, store and stage a certificate for an approved inspection.

    Raises :class:`CertificateAlreadyIssuedError`,
    :class:`InspectionNotApprovedError`, :class:`AssetNotCertifiableError`,
    :class:`CertificateConflictError`, :class:`CertificateSignatureError`, or
    :class:`~hms_backend.app.modules.certificates.engine_client.CertificateEngineError`.
    Does not commit. Raises :class:`CertificateStorageError` if the stored PDF cannot
    be read back identical. On any failure after the object write, the object is
    removed before the exception propagates.
    """
    settings = settings or default_settings
    engine = engine or get_certificate_engine()
    storage = storage or get_object_storage()

    if inspection.certificate is not None:
        raise CertificateAlreadyIssuedError("Certificate already issued for inspection")
    if inspection.status != InspectionStatus.APPROVED.value:
        raise InspectionNotApprovedError(
            "certificate can only be issued from an approved inspection"
        )
    asset = inspection.asset
    if asset is not None and asset.lifecycle_status in NON_CERTIFIABLE_ASSET_STATUSES:
        # Fail before the expensive render/sign/store so we never produce an
        # orphaned PDF for an asset that can't hold a certificate.
        raise AssetNotCertifiableError(
            f"cannot issue a certificate for a {asset.lifecycle_status.lower()} asset"
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
    # Fail before any external write when the number is already taken. The unique
    # constraint (enforced at the flush below) remains the arbiter for races.
    if await session.scalar(select(Certificate.id).where(Certificate.number == number)):
        raise CertificateConflictError(f"Certificate number {number} already exists")

    rendered = await engine.render(to_proto(facts))
    # Never record or report a signature we have not verified ourselves.
    # Trust is judged at the backend-chosen issue instant, not the PDF's own claim.
    evidence = await averify_pdf_signature(
        rendered.pdf,
        settings.certificate_trust_anchor_path,
        issued_at,
        settings.certificate_trust_anchor_pem,
    )
    if not rendered.signed or not evidence.verified:
        raise CertificateSignatureError(
            "certificate PDF is not signed by a trusted signer: "
            f"{evidence.reason or 'engine reported signing disabled'}"
        )

    # The object key is opaque and unique per certificate, so no issuance (failed
    # or otherwise) can ever overwrite another certificate's artifact.
    certificate_id = str(uuid7())
    pdf_object_key = f"certificates/{certificate_id}/v1.pdf"
    certificate = Certificate.issue_from_inspection(
        inspection,
        number=number,
        pdf_object_key=pdf_object_key,
        verification_hash=rendered.verification_hash,
        public_token=public_token,
        issued_by_user_id=issued_by_user_id or actor_id,
        valid_until=valid_until,
        certificate_id=certificate_id,
        issuance_facts=facts_to_snapshot(facts),
        pdf_sha256=pdf_sha256(rendered.pdf),
        signer_common_name=evidence.signer_common_name,
        signed_at=evidence.signed_at,
    )
    certificate.issued_at = issued_at
    session.add(certificate)
    # Reserve the unique number / token / hash in the database BEFORE touching
    # storage: a duplicate fails here and writes nothing externally.
    try:
        await session.flush()
    except IntegrityError as exc:
        raise CertificateConflictError(
            "Certificate number, token or hash is already in use"
        ) from exc
    # From here an external object exists (or may, if a write fails ambiguously) that
    # no committed row references yet. Any failure before this function returns means
    # the caller's transaction will not commit, so the object is removed. A crash or
    # a failure at commit time cannot run this; reconciliation covers those.
    try:
        await _store_verified_artifact(storage, pdf_object_key, rendered.pdf)
        await record_create(
            session,
            certificate,
            actor_id=actor_id,
            action="certificate.issued",
        )

        # Emit a domain event on the transactional outbox (N-01): if the caller's
        # transaction rolls back, no notification is ever produced.
        await emit_event(
            session,
            category=NotificationCategory.CERTIFICATE_ISSUED,
            aggregate_type="certificate",
            aggregate_id=certificate.id,
            payload={
                "customer_id": inspection.asset.customer_id,
                "asset_id": inspection.asset.id,
                "asset_number": inspection.asset.asset_number,
                "asset_name": inspection.asset.asset_name,
                "certificate_number": number,
                "public_token": public_token,
                "link": verify_url,
            },
        )
    except BaseException:
        _discard_artifact(storage, pdf_object_key)
        raise
    return certificate


async def regenerate_certificate_pdf(
    session: AsyncSession,
    certificate: Certificate,
    *,
    actor_id: str,
    settings: Settings | None = None,
    engine: CertificateEngineClient | None = None,
    storage: ObjectStorage | None = None,
) -> Certificate:
    """Re-render a stored issued certificate and repair its verification hash.

    This is deliberately limited to issued records. It retains the certificate's
    public identity (number, token and issue date), so it is suitable for recovering
    a missing legacy PDF without creating a second certificate.

    The replacement is written to a *new* write-once key and the row is repointed in
    the caller's transaction. The currently committed artifact is never overwritten,
    so a failure or rollback at any point leaves the committed row and its object
    exactly as they were. The superseded object is left in place. The caller owns
    the transaction.
    """
    _require_regenerable(certificate)  # fail fast, before taking the lock

    settings = settings or default_settings
    engine = engine or get_certificate_engine()
    storage = storage or get_object_storage()
    # Serialise concurrent regenerations of the same certificate (a row lock on
    # PostgreSQL) and read the state that is actually committed now. Eligibility is
    # re-checked from that fresh state: a concurrent revoke, or an upgrade that
    # attached issuance evidence, must not be acted on from a stale in-memory copy.
    await session.refresh(
        certificate,
        attribute_names=[
            "status",
            "issuance_facts",
            "pdf_object_key",
            "verification_hash",
            "version",
        ],
        with_for_update=True,
    )
    _require_regenerable(certificate)
    inspection = certificate.inspection
    verify_url = (
        f"{settings.public_base_url.rstrip('/')}"
        f"/api/v1/certificates/verify/{certificate.public_token}"
    )
    facts = build_facts(
        inspection,
        certificate_number=certificate.number,
        certificate_version=certificate.certificate_version,
        status=certificate.status,
        issued_at=certificate.issued_at,
        valid_until=certificate.valid_until,
        public_token=certificate.public_token,
        verify_url=verify_url,
        issued_by_name=certificate.issued_by_user_id,
        issuer_name=settings.issuer_name,
        issuer_identifier=settings.issuer_identifier,
    )
    rendered = await engine.render(to_proto(facts))

    new_key = next_revision_key(certificate.pdf_object_key)
    try:
        await _store_verified_artifact(storage, new_key, rendered.pdf)
        before = certificate.to_audit_dict()
        certificate.pdf_object_key = new_key
        certificate.verification_hash = rendered.verification_hash
        await record_update(
            session,
            certificate,
            actor_id=actor_id,
            action="certificate.pdf_regenerated",
            before=before,
        )
    except BaseException:
        _discard_artifact(storage, new_key)
        raise
    return certificate
