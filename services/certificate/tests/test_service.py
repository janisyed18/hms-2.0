from __future__ import annotations

from io import BytesIO
from unittest.mock import MagicMock

from pypdf import PdfReader

from hms_certificate.config import Settings
from hms_certificate.domain import CertificateData, compute_verification_hash
from hms_certificate.proto import certificate_pb2 as pb
from hms_certificate.service import CertificateEngineServicer


def _to_proto(data: CertificateData) -> pb.CertificateData:
    msg = pb.CertificateData(
        certificate_number=data.certificate_number,
        certificate_version=data.certificate_version,
        status=data.status,
        issued_at=data.issued_at,
        valid_until=data.valid_until,
        customer_code=data.customer_code,
        customer_name=data.customer_name,
        asset_number=data.asset_number,
        product_code=data.product_code,
        public_token=data.public_token,
        verify_url=data.verify_url,
    )
    for e in data.ends:
        msg.ends.add(end=e.end, nominal_bore=e.nominal_bore, material=e.material)
    if data.pressure_test is not None:
        pt = data.pressure_test
        msg.pressure_test.working_pressure_kpa = pt.working_pressure_kpa
        msg.pressure_test.test_pressure_kpa = pt.test_pressure_kpa
        msg.pressure_test.applied_pressure_kpa = pt.applied_pressure_kpa
        msg.pressure_test.hold_time_seconds = pt.hold_time_seconds
        msg.pressure_test.passed = pt.passed
    return msg


def test_render_rpc_returns_signed_pdf(
    sample_data: CertificateData, settings: Settings
) -> None:
    servicer = CertificateEngineServicer(settings)
    request = pb.RenderRequest(certificate=_to_proto(sample_data))
    context = MagicMock()

    response = servicer.Render(request, context)

    context.abort.assert_not_called()
    assert response.pdf.startswith(b"%PDF")
    assert response.signed is True
    assert response.page_count >= 1
    assert response.verification_hash == compute_verification_hash(
        CertificateData.from_proto(request.certificate)
    )
    # PDF is readable and carries the signature field.
    reader = PdfReader(BytesIO(response.pdf))
    assert reader.get_fields()


def test_render_rpc_requires_certificate_number(settings: Settings) -> None:
    servicer = CertificateEngineServicer(settings)
    request = pb.RenderRequest(certificate=pb.CertificateData(certificate_number=""))
    context = MagicMock()
    context.abort.side_effect = RuntimeError("aborted")

    try:
        servicer.Render(request, context)
    except RuntimeError:
        pass
    context.abort.assert_called()
