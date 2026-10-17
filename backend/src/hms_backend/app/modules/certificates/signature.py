"""Cryptographic validation of the signature embedded in a certificate PDF.

The certificate engine reports ``signed=True`` and a signer name when it signs,
but that is a claim made at issuance time. Everything here re-derives the answer
from the PDF bytes alone, against a configured trust anchor, so a verifier never
has to trust a persisted flag.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.status import SignatureCoverageLevel
from pyhanko_certvalidator import ValidationContext


@dataclass(frozen=True)
class SignatureEvidence:
    verified: bool
    reason: str
    signer_common_name: str = ""
    signed_at: datetime | None = None


def _fail(reason: str) -> SignatureEvidence:
    return SignatureEvidence(verified=False, reason=reason)


def verify_pdf_signature(pdf: bytes, trust_anchor_path: str) -> SignatureEvidence:
    """Verify the PDF's signature is intact, trusted and covers the whole file."""
    if not trust_anchor_path:
        return _fail("no certificate trust anchor is configured")
    anchor = Path(trust_anchor_path)
    if not anchor.is_file():
        return _fail("the configured certificate trust anchor is not readable")
    try:
        trust_root = load_cert_from_pemder(str(anchor))  # type: ignore[no-untyped-call]
        reader = PdfFileReader(BytesIO(pdf))
        signatures = reader.embedded_signatures
        if len(signatures) != 1:
            return _fail(
                "the PDF is not signed"
                if not signatures
                else "the PDF carries an unexpected number of signatures"
            )
        signature = signatures[0]
        # Validate as at the claimed signing time so a leaf certificate that has
        # since expired does not invalidate certificates it legitimately signed.
        reported = signature.self_reported_timestamp or datetime.now(UTC)
        moment = reported.astimezone(UTC)
        context = ValidationContext(
            trust_roots=[trust_root],
            allow_fetching=False,
            revocation_mode="soft-fail",
            moment=moment,
        )
        status = validate_pdf_signature(signature, context)
    except Exception as exc:  # noqa: BLE001 - malformed PDFs must fail, not raise
        return _fail(f"the PDF signature could not be validated ({type(exc).__name__})")

    if not status.intact or not status.valid:
        return _fail("the PDF signature is invalid or the document was modified")
    if not status.trusted:
        return _fail("the PDF signature does not chain to the trusted certificate CA")
    if status.coverage != SignatureCoverageLevel.ENTIRE_FILE:
        return _fail("the PDF signature does not cover the entire document")

    subject = status.signing_cert.subject.native.get("common_name")
    if isinstance(subject, list):
        subject = subject[0] if subject else ""
    return SignatureEvidence(
        verified=True,
        reason="",
        signer_common_name=str(subject or ""),
        signed_at=moment,
    )


async def averify_pdf_signature(
    pdf: bytes, trust_anchor_path: str
) -> SignatureEvidence:
    # Validation is CPU-bound; keep it off the event loop.
    return await asyncio.to_thread(verify_pdf_signature, pdf, trust_anchor_path)
