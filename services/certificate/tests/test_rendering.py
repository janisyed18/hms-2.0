from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader

from hms_certificate.config import Settings
from hms_certificate.domain import CertificateData, compute_verification_hash
from hms_certificate.rendering import render_certificate


def test_render_produces_pdf(sample_data: CertificateData, settings: Settings) -> None:
    vh = compute_verification_hash(sample_data)
    result = render_certificate(sample_data, vh, settings)
    assert result.pdf.startswith(b"%PDF")
    assert result.page_count >= 1


def test_render_embeds_key_content(
    sample_data: CertificateData, settings: Settings
) -> None:
    vh = compute_verification_hash(sample_data)
    result = render_certificate(sample_data, vh, settings)
    reader = PdfReader(BytesIO(result.pdf))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert sample_data.certificate_number in text
    assert sample_data.asset_number in text
    assert sample_data.customer_name in text
    # The verification hash appears (wrapped) in the document.
    assert vh[:32] in text.replace("\n", "")


def test_render_metadata(sample_data: CertificateData, settings: Settings) -> None:
    vh = compute_verification_hash(sample_data)
    result = render_certificate(sample_data, vh, settings)
    reader = PdfReader(BytesIO(result.pdf))
    meta = reader.metadata
    assert meta is not None
    assert sample_data.certificate_number in (meta.title or "")
