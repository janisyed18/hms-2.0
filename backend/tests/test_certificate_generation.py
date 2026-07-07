"""Certificate generation + public verification integration tests.

The certificate engine (gRPC) is mocked so these run without a live service, but
the mock computes the verification hash with the SAME backend algorithm the
public verify endpoint uses — so the round-trip (issue → verify) is exercised
end to end, including hash agreement and tamper detection.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.records as records_module
import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.engine_client import RenderedCertificate
from hms_backend.app.modules.certificates.enginepb import certificate_pb2 as pb
from hms_backend.app.modules.certificates.models import Certificate
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


def _hash_from_proto(cert: pb.CertificateData) -> str:
    """Reproduce the engine's hash from the proto using the backend algorithm."""
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


class _FakeEngine:
    def __init__(self) -> None:
        self.calls = 0

    async def render(self, certificate: pb.CertificateData) -> RenderedCertificate:
        self.calls += 1
        return RenderedCertificate(
            pdf=b"%PDF-1.7\n%fake signed pdf\n",
            verification_hash=_hash_from_proto(certificate),
            page_count=1,
            signer_common_name="BAT Engineering Pty Ltd Certificate Signer",
            signed_at="2026-07-07T00:00:00Z",
            signed=True,
        )


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest_asyncio.fixture
async def approved_inspection_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> str:
    async with session_factory() as session:
        standard = Standard(code="AS3862", name="Hydraulic hose")
        product = Product(
            category="Hydraulic", code="HP-2W", name="2-Wire Hose", standard=standard
        )
        customer = Customer(code="ACME", name="Acme Mining Pty Ltd")
        location = CustomerLocation(
            customer=customer, name="North Pit", city="Kalgoorlie", state="WA",
            country="Australia",
        )
        asset = Asset(
            customer=customer,
            location=location,
            product=product,
            asset_number="HA-00123",
            tag="TAG-88",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
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


@asynccontextmanager
async def _client(
    session_factory: async_sessionmaker[AsyncSession],
    principal: Principal,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: principal
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as c:
        yield c


_REVIEWER = Principal(
    user_id="reviewer-1",
    roles=frozenset({Role.REVIEWER}),
    customer_ids=frozenset(),
)


@pytest.fixture
def _storage(tmp_path, monkeypatch) -> LocalObjectStorage:
    store = LocalObjectStorage(tmp_path / "objects")
    monkeypatch.setattr(storage_module, "_storage", store)
    return store


@pytest.fixture
def _engine(monkeypatch) -> _FakeEngine:
    fake = _FakeEngine()
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: fake)
    return fake


@pytest.mark.asyncio
async def test_generate_certificate_renders_signs_stores_and_verifies(
    session_factory, approved_inspection_id, _storage, _engine
) -> None:
    async with _client(session_factory, _REVIEWER) as client:
        # No pdf_object_key -> server renders + signs via the (mocked) engine.
        issue = await client.post(
            f"/api/v1/inspections/{approved_inspection_id}/certificate",
            json={"valid_until": "2027-07-07"},
        )
        assert issue.status_code == 201, issue.text
        body = issue.json()
        assert body["status"] == "ISSUED"
        assert body["number"].startswith("CERT-HA-00123-")
        assert _engine.calls == 1

    # The PDF was stored under the generated key.
    async with session_factory() as session:
        cert = (
            await session.scalars(
                select(Certificate).where(
                    Certificate.inspection_id == approved_inspection_id
                )
            )
        ).one()
        assert _storage.exists(cert.pdf_object_key)
        assert _storage.get(cert.pdf_object_key).startswith(b"%PDF")
        token = cert.public_token
        stored_hash = cert.verification_hash

    # Public verify (unauthenticated) agrees with the stored hash.
    async with _client(session_factory, _REVIEWER) as client:
        verify = await client.get(f"/api/v1/certificates/verify/{token}")
        assert verify.status_code == 200, verify.text
        result = verify.json()
        assert result["valid"] is True
        assert result["hash_matches"] is True
        assert result["verification_hash"] == stored_hash
        assert result["asset_number"] == "HA-00123"
        assert result["customer_name"] == "Acme Mining Pty Ltd"

        # The signed PDF is downloadable by token.
        pdf = await client.get(f"/api/v1/certificates/verify/{token}/pdf")
        assert pdf.status_code == 200
        assert pdf.headers["content-type"] == "application/pdf"
        assert pdf.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_tampered_certificate_fails_verification(
    session_factory, approved_inspection_id, _storage, _engine
) -> None:
    async with _client(session_factory, _REVIEWER) as client:
        issue = await client.post(
            f"/api/v1/inspections/{approved_inspection_id}/certificate",
            json={},
        )
        assert issue.status_code == 201

    # Tamper with the stored asset number after issuance.
    async with session_factory() as session:
        cert = (
            await session.scalars(
                select(Certificate).where(
                    Certificate.inspection_id == approved_inspection_id
                )
            )
        ).one()
        token = cert.public_token
        asset = (
            await session.scalars(select(Asset).where(Asset.id == cert.asset_id))
        ).one()
        asset.asset_number = "HA-TAMPERED"
        await session.commit()

    async with _client(session_factory, _REVIEWER) as client:
        verify = await client.get(f"/api/v1/certificates/verify/{token}")
        assert verify.status_code == 200
        result = verify.json()
        assert result["hash_matches"] is False
        assert result["valid"] is False


@pytest.mark.asyncio
async def test_generate_requires_approved_inspection(
    session_factory, _storage, _engine
) -> None:
    async with session_factory() as session:
        product = Product(category="Hydraulic", code="HP", name="Hose")
        customer = Customer(code="C1", name="Cust One")
        asset = Asset(customer=customer, product=product, asset_number="HA-1")
        inspection = Inspection(
            asset=asset,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    async with _client(session_factory, _REVIEWER) as client:
        response = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )
    assert response.status_code == 409
    assert _engine.calls == 0
