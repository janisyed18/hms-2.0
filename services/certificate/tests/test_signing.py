from __future__ import annotations

from io import BytesIO

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from hms_certificate.config import Settings
from hms_certificate.domain import CertificateData, compute_verification_hash
from hms_certificate.rendering import render_certificate
from hms_certificate.signing import (
    NullSigner,
    PdfSigner,
    _resolve_signer_paths,
    build_signer,
)


def _unsigned(sample_data: CertificateData, settings: Settings) -> bytes:
    vh = compute_verification_hash(sample_data)
    return render_certificate(sample_data, vh, settings).pdf


def test_signature_is_intact_and_trusted(
    sample_data: CertificateData, settings: Settings
) -> None:
    signer = PdfSigner(settings)
    result = signer.sign(_unsigned(sample_data, settings))
    assert result.signed is True
    assert result.signer_common_name

    material = _resolve_signer_paths(settings)
    assert material.trust_anchor_path is not None
    trust_root = load_cert_from_pemder(str(material.trust_anchor_path))
    vc = ValidationContext(
        trust_roots=[trust_root], allow_fetching=False, revocation_mode="soft-fail"
    )
    reader = PdfFileReader(BytesIO(result.pdf))
    sig = reader.embedded_signatures[0]
    status = validate_pdf_signature(sig, vc)
    assert status.intact is True
    assert status.valid is True
    assert status.trusted is True


def test_tampering_breaks_signature(
    sample_data: CertificateData, settings: Settings
) -> None:
    signer = PdfSigner(settings)
    result = signer.sign(_unsigned(sample_data, settings))

    tampered = bytearray(result.pdf)
    # Flip a byte in the middle of the content stream region.
    idx = len(tampered) // 2
    tampered[idx] ^= 0xFF

    material = _resolve_signer_paths(settings)
    trust_root = load_cert_from_pemder(str(material.trust_anchor_path))
    vc = ValidationContext(
        trust_roots=[trust_root], allow_fetching=False, revocation_mode="soft-fail"
    )
    reader = PdfFileReader(BytesIO(bytes(tampered)))
    sig = reader.embedded_signatures[0]
    status = validate_pdf_signature(sig, vc)
    assert status.intact is False


def test_disabled_signing_returns_unsigned(
    sample_data: CertificateData, settings: Settings
) -> None:
    disabled = settings.model_copy(update={"signing_enabled": False})
    signer = build_signer(disabled)
    assert isinstance(signer, NullSigner)
    result = signer.sign(_unsigned(sample_data, settings))
    assert result.signed is False
    assert result.pdf.startswith(b"%PDF")
