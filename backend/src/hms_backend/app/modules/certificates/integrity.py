"""Authoritative certificate validity decision used by public verification.

A certificate is valid only when every independent check passes:

* it carries an issuance snapshot and that snapshot still hashes to the stored
  ``verification_hash`` (so master-data edits after issuance are irrelevant);
* the stored PDF exists and matches the digest recorded at issuance;
* the PDF's signature is intact, covers the whole file and chains to the
  configured trust anchor;
* the status is ISSUED and ``valid_until`` (inclusive) has not passed.

Integrity and validity are separate answers. ``integrity`` says whether this is the
genuine, unmodified certificate (the first three checks); ``valid`` says whether it
may currently be relied on (all of them). A revoked, superseded or expired
certificate is therefore ``VERIFIED`` but not valid, while a tampered one is
``FAILED``.

Certificates without a snapshot are ``LEGACY_UNVERIFIED``: they stay readable and
downloadable but are never reported as authentic without controlled review or
reissuance.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from hms_backend.app.core.config import Settings
from hms_backend.app.core.object_storage import ObjectNotFoundError, ObjectStorage
from hms_backend.app.modules.certificates.mapping import (
    CertificateFacts,
    facts_from_snapshot,
    format_date,
    format_ts,
    to_verification_input,
)
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.certificates.signature import averify_pdf_signature
from hms_backend.app.modules.certificates.verification import compute_verification_hash


class IntegrityStatus(StrEnum):
    VERIFIED = "VERIFIED"
    LEGACY_UNVERIFIED = "LEGACY_UNVERIFIED"
    FAILED = "FAILED"


@dataclass(frozen=True)
class CertificateAssessment:
    integrity: IntegrityStatus
    valid: bool
    hash_matches: bool
    artifact_verified: bool
    signature_verified: bool
    expired: bool
    message: str
    facts: CertificateFacts | None = None


def pdf_sha256(pdf: bytes) -> str:
    return hashlib.sha256(pdf).hexdigest()


def snapshot_issued_at(facts: CertificateFacts) -> datetime:
    """Server-issued instant from the immutable snapshot (UTC, second resolution)."""
    return datetime.strptime(facts.issued_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def snapshot_valid_until(facts: CertificateFacts) -> date | None:
    return date.fromisoformat(facts.valid_until) if facts.valid_until else None


def snapshot_mismatch(certificate: Certificate, facts: CertificateFacts) -> str | None:
    """Name the first mutable column that disagrees with the signed snapshot.

    The relational columns are only an indexed projection of what was issued; for
    evidence-backed certificates the snapshot is authoritative and any divergence
    (e.g. an extended ``valid_until``) is an integrity failure, not a new fact.
    """
    checks = (
        ("certificate number", certificate.number, facts.certificate_number),
        ("version", certificate.certificate_version, facts.certificate_version),
        ("public token", certificate.public_token, facts.public_token),
        ("issue date", format_ts(certificate.issued_at), facts.issued_at),
        ("validity period", format_date(certificate.valid_until), facts.valid_until),
    )
    for label, recorded, signed in checks:
        if recorded != signed:
            return label
    return None


def is_expired(valid_until: date | None, today: date) -> bool:
    """``valid_until`` is the last valid day, so it is only expired the day after."""
    return valid_until is not None and today > valid_until


def _failed(
    message: str,
    *,
    facts: CertificateFacts | None = None,
    hash_matches: bool = False,
    artifact_verified: bool = False,
    signature_verified: bool = False,
    expired: bool = False,
) -> CertificateAssessment:
    return CertificateAssessment(
        integrity=IntegrityStatus.FAILED,
        valid=False,
        hash_matches=hash_matches,
        artifact_verified=artifact_verified,
        signature_verified=signature_verified,
        expired=expired,
        message=message,
        facts=facts,
    )


@dataclass(frozen=True)
class ArtifactCheck:
    """Outcome of checking the stored PDF against the evidence recorded at issuance."""

    pdf: bytes | None
    exists: bool
    digest_ok: bool
    signature_ok: bool
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.digest_ok and self.signature_ok


async def check_artifact(
    certificate: Certificate,
    *,
    facts: CertificateFacts,
    storage: ObjectStorage,
    settings: Settings,
) -> ArtifactCheck:
    """Fetch the stored PDF once and verify its digest and signature.

    The returned ``pdf`` is the exact byte string that was verified, so a caller
    that serves it cannot be handed different bytes than the ones checked.
    """
    try:
        pdf = await asyncio.to_thread(storage.get, certificate.pdf_object_key)
    except ObjectNotFoundError:
        return ArtifactCheck(
            pdf=None,
            exists=False,
            digest_ok=False,
            signature_ok=False,
            message="Verification FAILED: the signed certificate document is missing.",
        )
    if pdf_sha256(pdf) != certificate.pdf_sha256:
        return ArtifactCheck(
            pdf=None,
            exists=True,
            digest_ok=False,
            signature_ok=False,
            message=(
                "Verification FAILED: the stored certificate document has been altered."
            ),
        )
    # The signer's certificate is judged at the server-issued instant recorded in
    # the snapshot, never at a time the PDF itself claims.
    evidence = await averify_pdf_signature(
        pdf,
        settings.certificate_trust_anchor_path,
        snapshot_issued_at(facts),
        settings.certificate_trust_anchor_pem,
    )
    if not evidence.verified:
        return ArtifactCheck(
            pdf=None,
            exists=True,
            digest_ok=True,
            signature_ok=False,
            message=f"Verification FAILED: {evidence.reason}.",
        )
    return ArtifactCheck(pdf=pdf, exists=True, digest_ok=True, signature_ok=True)


def _authentic_but_not_valid(
    message: str,
    *,
    facts: CertificateFacts,
    hash_matches: bool,
    artifact_verified: bool,
    signature_verified: bool,
    expired: bool,
) -> CertificateAssessment:
    """Genuine certificate that may no longer be relied on (revoked, expired...)."""
    return CertificateAssessment(
        integrity=IntegrityStatus.VERIFIED,
        valid=False,
        hash_matches=hash_matches,
        artifact_verified=artifact_verified,
        signature_verified=signature_verified,
        expired=expired,
        message=message,
        facts=facts,
    )


async def assess_certificate(
    certificate: Certificate,
    *,
    storage: ObjectStorage,
    settings: Settings,
    today: date | None = None,
) -> CertificateAssessment:
    today = today or datetime.now(UTC).date()

    if certificate.issuance_facts is None or not certificate.pdf_sha256:
        expired = is_expired(certificate.valid_until, today)
        return CertificateAssessment(
            integrity=IntegrityStatus.LEGACY_UNVERIFIED,
            valid=False,
            hash_matches=False,
            artifact_verified=False,
            signature_verified=False,
            expired=expired,
            message=(
                "This certificate predates integrity verification and cannot be "
                "confirmed automatically. Contact the issuer to review or reissue "
                "it."
            ),
        )

    facts = facts_from_snapshot(certificate.issuance_facts)
    # Expiry comes from the signed snapshot so the database cannot extend it.
    expired = is_expired(snapshot_valid_until(facts), today)
    recomputed = compute_verification_hash(to_verification_input(facts))
    if recomputed != certificate.verification_hash:
        return _failed(
            "Verification FAILED: the certificate content does not match its "
            "recorded hash. Do not rely on this document.",
            facts=facts,
            expired=expired,
        )

    diverged = snapshot_mismatch(certificate, facts)
    if diverged is not None:
        return _failed(
            f"Verification FAILED: the recorded {diverged} differs from the signed "
            "certificate. Do not rely on this document.",
            facts=facts,
            hash_matches=True,
            expired=expired,
        )

    artifact = await check_artifact(
        certificate, facts=facts, storage=storage, settings=settings
    )
    if not artifact.ok:
        return _failed(
            artifact.message,
            facts=facts,
            hash_matches=True,
            artifact_verified=artifact.digest_ok,
            expired=expired,
        )

    common = dict(
        facts=facts,
        hash_matches=True,
        artifact_verified=True,
        signature_verified=True,
        expired=expired,
    )
    # Past this point the document is the genuine, unmodified certificate. Whether
    # it may still be relied on is a separate question: a revoked, superseded or
    # expired certificate is authentic (integrity VERIFIED) but not valid.
    if certificate.status != CertificateStatus.ISSUED.value:
        return _authentic_but_not_valid(
            f"This certificate is {certificate.status.lower()} and is no longer "
            "valid, though its content is authentic.",
            **common,  # type: ignore[arg-type]
        )
    if expired:
        return _authentic_but_not_valid(
            f"This certificate expired on {snapshot_valid_until(facts):%d %B %Y}, "
            "though its content is authentic.",
            **common,  # type: ignore[arg-type]
        )
    return CertificateAssessment(
        integrity=IntegrityStatus.VERIFIED,
        valid=True,
        message="Certificate is authentic and active.",
        **common,  # type: ignore[arg-type]
    )
