"""Certificate generation + public verification integration tests.

The certificate engine (gRPC) is faked so these run without a live service, but
the fake computes the verification hash with the SAME backend algorithm the public
verify endpoint uses and returns a genuinely signed PDF, so the round-trip
(issue → verify) exercises hash agreement and real signature validation.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from certificate_support import Pki, SigningFakeEngine, build_pki
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.records as records_module
import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.issuance import regenerate_certificate_pdf
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard


@pytest.fixture(scope="module")
def _pki(tmp_path_factory) -> Pki:
    return build_pki(tmp_path_factory.mktemp("pki"))


@pytest.fixture(autouse=True)
def _trust_anchor(_pki, monkeypatch) -> None:
    # One shared settings singleton backs issuance, the routes and verification.
    monkeypatch.setattr(
        app_settings, "certificate_trust_anchor_path", str(_pki.anchor_path)
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
            customer=customer,
            name="North Pit",
            city="Kalgoorlie",
            state="WA",
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
def _engine(monkeypatch, _pki) -> SigningFakeEngine:
    fake = SigningFakeEngine(_pki.signer)
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
        assert result["integrity"] == "VERIFIED"
        assert result["hash_matches"] is True
        assert result["artifact_verified"] is True
        assert result["signed"] is True
        assert result["expired"] is False
        assert result["verification_hash"] == stored_hash
        assert result["asset_number"] == "HA-00123"
        assert result["customer_name"] == "Acme Mining Pty Ltd"

        # The signed PDF is downloadable by token.
        pdf = await client.get(f"/api/v1/certificates/verify/{token}/pdf")
        assert pdf.status_code == 200
        assert pdf.headers["content-type"] == "application/pdf"
        assert pdf.content.startswith(b"%PDF")

        downloaded_pdf = await client.get(
            f"/api/v1/certificates/verify/{token}/pdf?download=true"
        )
        assert downloaded_pdf.status_code == 200
        assert downloaded_pdf.headers["content-disposition"] == (
            f'attachment; filename="{body["number"]}.pdf"'
        )


@pytest.mark.asyncio
async def test_regenerate_certificate_pdf_repairs_legacy_storage_and_hash(
    session_factory, approved_inspection_id, _storage, _engine
) -> None:
    """A legacy record can be repaired without changing its public identity."""
    async with _client(session_factory, _REVIEWER) as client:
        issue = await client.post(
            f"/api/v1/inspections/{approved_inspection_id}/certificate", json={}
        )
        assert issue.status_code == 201
        issued = issue.json()

    async with session_factory() as session:
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.number == issued["number"])
            )
        ).one()
        original_token = certificate.public_token
        original_object_key = certificate.pdf_object_key
        original_issued_at = certificate.issued_at
        # Only certificates without issuance evidence (legacy) may be re-rendered.
        certificate.issuance_facts = None
        certificate.pdf_sha256 = None
        certificate.verification_hash = "stale-hash"
        await session.commit()

    async with session_factory() as session:
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.number == issued["number"])
            )
        ).one()
        repaired = await regenerate_certificate_pdf(
            session,
            certificate,
            actor_id="system-certificate-repair",
            engine=_engine,
            storage=_storage,
        )
        await session.commit()
        assert repaired.public_token == original_token
        assert repaired.pdf_object_key == original_object_key
        assert repaired.issued_at == original_issued_at
        assert repaired.verification_hash != "stale-hash"
        assert _storage.exists(original_object_key)

        audit = (
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == "certificate.pdf_regenerated"
                )
            )
        ).one()
        assert audit.actor_id == "system-certificate-repair"
        assert audit.entity_id == repaired.id

    async with _client(session_factory, _REVIEWER) as client:
        verify = await client.get(f"/api/v1/certificates/verify/{original_token}")
        assert verify.status_code == 200
        # Repaired legacy records stay unverified: no issuance evidence exists.
        assert verify.json()["valid"] is False
        assert verify.json()["integrity"] == "LEGACY_UNVERIFIED"


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


@pytest.mark.parametrize("blocked_status", ["CONDEMNED", "RETIRED"])
@pytest.mark.asyncio
async def test_generate_refused_for_condemned_or_retired_asset(
    session_factory, _storage, _engine, blocked_status
) -> None:
    async with session_factory() as session:
        product = Product(category="Hydraulic", code="HPX", name="Hose")
        customer = Customer(code="CX", name="Cust X")
        asset = Asset(
            customer=customer,
            product=product,
            asset_number="HA-BLOCKED",
            lifecycle_status=blocked_status,
        )
        inspection = Inspection(
            asset=asset,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.APPROVED.value,
            result="PASS",
            inspector_user_id="inspector-1",
            reviewer_user_id="reviewer-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    async with _client(session_factory, _REVIEWER) as client:
        response = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )

    assert response.status_code == 409
    assert blocked_status.lower() in response.json()["detail"].lower()
    # The engine must never be called and no certificate/PDF should exist.
    assert _engine.calls == 0
    async with session_factory() as session:
        certs = (
            await session.scalars(
                select(Certificate).where(Certificate.inspection_id == inspection_id)
            )
        ).all()
        assert certs == []
