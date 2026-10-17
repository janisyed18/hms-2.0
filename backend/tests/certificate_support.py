"""Shared helpers for certificate tests: a throwaway PKI and a signing engine fake.

The fake engine produces a *really signed* PDF (pyHanko, PAdES) so the backend's
signature verification is exercised end to end instead of being mocked away.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from unittest import mock

import pyhanko.sign.signers.pdf_cms as pdf_cms_module
import pyhanko.sign.signers.pdf_signer as pdf_signer_module
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter, append_signature_field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hms_backend.app.modules.assets.models import (
    Asset,
    AssetEndConfiguration,
    AssetLifecycleStatus,
)
from hms_backend.app.modules.certificates.engine_client import (
    CertificateEngineClient,
    RenderedCertificate,
)
from hms_backend.app.modules.certificates.enginepb import certificate_pb2 as pb
from hms_backend.app.modules.certificates.mapping import (
    facts_to_snapshot,  # noqa: F401  (re-exported for tests)
)
from hms_backend.app.modules.certificates.verification import (
    EndInput,
    PressureInput,
    VerificationInput,
    compute_verification_hash,
)
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard


def _name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "HMS Test"),
        ]
    )


@dataclass(frozen=True)
class Pki:
    anchor_path: Path  # public CA certificate (the configured trust anchor)
    cert_path: Path  # leaf signing certificate
    key_path: Path  # leaf private key
    signer: signers.SimpleSigner


def build_pki(
    directory: Path,
    *,
    label: str = "HMS Test",
    leaf_valid_days: tuple[int, int] = (-1, 825),
    ca_valid_days: tuple[int, int] = (-1, 3650),
) -> Pki:
    """Create a CA + leaf signer under ``directory`` (2048-bit keys for speed)."""
    directory.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.UTC)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = _name(f"{label} Root CA")
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now + dt.timedelta(days=ca_valid_days[0]))
        .not_valid_after(now + dt.timedelta(days=ca_valid_days[1]))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(_name(f"{label} Certificate Signer"))
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now + dt.timedelta(days=leaf_valid_days[0]))
        .not_valid_after(now + dt.timedelta(days=leaf_valid_days[1]))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    anchor_path = directory / "ca.cert.pem"
    cert_path = directory / "signer.cert.pem"
    key_path = directory / "signer.key.pem"
    anchor_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    cert_path.write_bytes(leaf_cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    signer = signers.SimpleSigner.load(str(key_path), str(cert_path))  # type: ignore[no-untyped-call]
    assert signer is not None
    return Pki(anchor_path, cert_path, key_path, signer)


def blank_pdf(marker: str) -> bytes:
    """A minimal valid one-page PDF; ``marker`` makes each document distinct."""
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
        f"<< /Title ({marker}) >>",
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 4 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def sign_pdf(
    pdf: bytes,
    signer: signers.SimpleSigner,
    *,
    claimed_signing_time: dt.datetime | None = None,
) -> bytes:
    """Sign ``pdf``; ``claimed_signing_time`` forges the self-reported signing time.

    pyHanko stamps "now" into the signature; anyone holding the key can claim any
    time, which is exactly the attack the verifier must not trust.
    """
    if claimed_signing_time is None:
        return _sign_pdf(pdf, signer)

    forged_epoch = claimed_signing_time.timestamp()

    class _Forged(dt.datetime):
        @classmethod
        def now(cls, tz: dt.tzinfo | None = None) -> _Forged:
            return cls.fromtimestamp(forged_epoch, tz or dt.UTC)

    with (
        mock.patch.object(pdf_signer_module, "datetime", _Forged),
        mock.patch.object(pdf_cms_module, "datetime", _Forged),
    ):
        return _sign_pdf(pdf, signer)


def _sign_pdf(pdf: bytes, signer: signers.SimpleSigner) -> bytes:
    writer = IncrementalPdfFileWriter(BytesIO(pdf))
    append_signature_field(
        writer,
        SigFieldSpec(
            sig_field_name="CertificateSignature", on_page=-1, box=(40, 40, 300, 108)
        ),
    )
    meta = signers.PdfSignatureMetadata(
        field_name="CertificateSignature",
        subfilter=SigSeedSubFilter.PADES,
        embed_validation_info=False,
    )
    signed: bytes = signers.sign_pdf(writer, meta, signer=signer).getvalue()
    return signed


def hash_from_proto(cert: pb.CertificateData) -> str:
    """Reproduce the engine's verification hash using the backend algorithm."""
    pt = cert.pressure_test if cert.HasField("pressure_test") else None
    return compute_verification_hash(
        VerificationInput(
            certificate_number=cert.certificate_number,
            certificate_version=cert.certificate_version,
            issued_at=cert.issued_at,
            valid_until=cert.valid_until,
            public_token=cert.public_token,
            customer_code=cert.customer_code,
            customer_name=cert.customer_name,
            asset_number=cert.asset_number,
            asset_tag=cert.asset_tag,
            customer_serial_no=cert.customer_serial_no,
            manufacture_date=cert.manufacture_date,
            length_m=cert.length_m,
            product_code=cert.product_code,
            product_name=cert.product_name,
            product_category=cert.product_category,
            standard_code=cert.standard_code,
            ends=tuple(
                EndInput(
                    end=e.end,
                    nominal_bore=e.nominal_bore,
                    material=e.material,
                    coupling=e.coupling,
                    coupling_add_on=e.coupling_add_on,
                    attach_method=e.attach_method,
                )
                for e in cert.ends
            ),
            pressure_test=(
                None
                if pt is None
                else PressureInput(
                    working_pressure_kpa=pt.working_pressure_kpa,
                    test_pressure_kpa=pt.test_pressure_kpa,
                    applied_pressure_kpa=pt.applied_pressure_kpa,
                    hold_time_seconds=pt.hold_time_seconds,
                    passed=pt.passed,
                    medium=pt.medium,
                )
            ),
            inspection_id=cert.inspection_id,
            inspection_type=cert.inspection_type,
            inspection_result=cert.inspection_result,
            approved_at=cert.approved_at,
            issuer_name=cert.issuer.name,
            issuer_identifier=cert.issuer.identifier,
        )
    )


class SigningFakeEngine(CertificateEngineClient):
    """Stands in for the gRPC engine but returns a genuinely signed PDF."""

    def __init__(
        self,
        signer: signers.SimpleSigner | None,
        *,
        claimed_signing_time: dt.datetime | None = None,
    ) -> None:
        super().__init__("fake:0", 0.0)
        self.calls = 0
        self._signer = signer
        self._claimed_signing_time = claimed_signing_time
        # Hook for tests to interleave work between "render" and the caller's flush.
        self.on_render: Callable[[], Awaitable[None]] | None = None

    async def render(self, certificate: pb.CertificateData) -> RenderedCertificate:
        self.calls += 1
        if self.on_render is not None:
            await self.on_render()
        pdf = blank_pdf(f"{certificate.certificate_number}-{self.calls}")
        signed = self._signer is not None
        if self._signer is not None:
            pdf = await asyncio.to_thread(
                lambda: sign_pdf(
                    pdf,
                    self._signer,  # type: ignore[arg-type]
                    claimed_signing_time=self._claimed_signing_time,
                )
            )
        return RenderedCertificate(
            pdf=pdf,
            verification_hash=hash_from_proto(certificate),
            page_count=1,
            signer_common_name="HMS Test Certificate Signer" if signed else "",
            signed_at="2026-07-07T00:00:00Z" if signed else "",
            signed=signed,
        )


async def seed_approved_inspection(
    factory: async_sessionmaker[AsyncSession], tag: str
) -> str:
    """Create an APPROVED inspection (own customer/asset/product) and return its id."""
    async with factory() as session:
        standard = Standard(code=f"AS-{tag}", name="Hydraulic hose")
        product = Product(
            category="Hydraulic",
            code=f"HP-{tag}",
            name="2-Wire Hose",
            standard=standard,
        )
        customer = Customer(code=f"C-{tag}", name="Acme Mining Pty Ltd")
        location = CustomerLocation(
            customer=customer, name="North Pit", city="Kalgoorlie", state="WA"
        )
        asset = Asset(
            customer=customer,
            location=location,
            product=product,
            asset_number=f"HA-{tag}",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        asset.ends.append(AssetEndConfiguration(end="A"))
        inspection = Inspection(
            asset=asset,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.APPROVED.value,
            result="PASS",
            inspector_user_id="inspector-1",
            reviewer_user_id="reviewer-1",
        )
        inspection.pressure_test = PressureTestResult(
            applied_pressure_kpa=42000, hold_time_seconds=120, passed=True
        )
        session.add(inspection)
        await session.commit()
        return inspection.id
