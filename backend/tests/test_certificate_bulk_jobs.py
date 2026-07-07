"""Bulk certificate generation (Celery) tests.

Two layers:
  * ``_run_batch`` executed directly against the test DB with a mocked engine —
    exercises per-item success, partial failure, and final status roll-up.
  * The enqueue/poll API with the Celery dispatch mocked — exercises job
    creation, eligible-inspection selection, and status retrieval.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.jobs as jobs_module
import hms_backend.app.core.object_storage as storage_module
import hms_backend.app.modules.certificates.issuance as issuance_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.engine_client import RenderedCertificate
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.certificates.tasks import _run_batch
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.jobs.models import CertificateBatchJob, JobStatus
from hms_backend.app.modules.products.models import Product


class _FakeEngine:
    def __init__(self) -> None:
        self.calls = 0

    async def render(self, certificate) -> RenderedCertificate:  # noqa: ANN001
        self.calls += 1
        return RenderedCertificate(
            pdf=b"%PDF-1.7\n%bulk\n",
            verification_hash=f"hash-{certificate.certificate_number}",
            page_count=1,
            signer_common_name="Test Signer",
            signed_at="2026-07-07T00:00:00Z",
            signed=True,
        )


_REVIEWER = Principal(
    user_id="reviewer-1", roles=frozenset({Role.REVIEWER}), customer_ids=frozenset()
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.fixture(autouse=True)
def _wire_engine_and_storage(tmp_path, monkeypatch) -> _FakeEngine:
    fake = _FakeEngine()
    monkeypatch.setattr(issuance_module, "get_certificate_engine", lambda: fake)
    monkeypatch.setattr(
        storage_module, "_storage", LocalObjectStorage(tmp_path / "objects")
    )
    return fake


async def _make_inspection(
    session: AsyncSession,
    *,
    asset_number: str,
    status: str = InspectionStatus.APPROVED.value,
    with_certificate: bool = False,
    lifecycle_status: str = AssetLifecycleStatus.IN_SERVICE.value,
) -> str:
    product = Product(category="Hydraulic", code=f"P-{asset_number}", name="Hose")
    customer = Customer(code=f"C-{asset_number}", name="Cust")
    asset = Asset(
        customer=customer,
        product=product,
        asset_number=asset_number,
        lifecycle_status=lifecycle_status,
    )
    inspection = Inspection(
        asset=asset,
        inspection_type=InspectionType.SERVICE.value,
        status=status,
        result="PASS",
        inspector_user_id="inspector-1",
        reviewer_user_id="reviewer-1",
    )
    session.add(inspection)
    await session.flush()
    if with_certificate:
        session.add(
            Certificate.issue_from_inspection(
                inspection,
                number=f"CERT-{asset_number}",
                pdf_object_key=f"certificates/{asset_number}.pdf",
                verification_hash="preexisting",
                public_token=f"tok-{asset_number}",
                issued_by_user_id="reviewer-1",
                valid_until=None,
            )
        )
    await session.commit()
    return inspection.id


async def _make_job(
    session_factory: async_sessionmaker[AsyncSession], inspection_ids: list[str]
) -> str:
    async with session_factory() as session:
        job = CertificateBatchJob(
            status=JobStatus.PENDING.value,
            requested_by_user_id="reviewer-1",
            total=len(inspection_ids),
            inspection_ids=inspection_ids,
            results=[],
        )
        session.add(job)
        await session.commit()
        return job.id


@pytest.mark.asyncio
async def test_run_batch_all_succeed(session_factory, _wire_engine_and_storage) -> None:
    async with session_factory() as session:
        ids = [
            await _make_inspection(session, asset_number=f"HA-{i}") for i in range(3)
        ]
    job_id = await _make_job(session_factory, ids)

    result = await _run_batch(job_id, session_factory)

    assert result == {"succeeded": 3, "failed": 0}
    assert _wire_engine_and_storage.calls == 3
    async with session_factory() as session:
        job = await session.get(CertificateBatchJob, job_id)
        assert job.status == JobStatus.COMPLETED.value
        assert job.succeeded == 3
        assert job.failed == 0
        assert len(job.results) == 3
        assert all(r["status"] == "issued" for r in job.results)
        certs = (await session.scalars(select(Certificate))).all()
        assert len(certs) == 3


@pytest.mark.asyncio
async def test_run_batch_partial_failure(
    session_factory, _wire_engine_and_storage
) -> None:
    async with session_factory() as session:
        ok = await _make_inspection(session, asset_number="OK-1")
        not_approved = await _make_inspection(
            session, asset_number="SUB-1", status=InspectionStatus.SUBMITTED.value
        )
        already = await _make_inspection(
            session, asset_number="DONE-1", with_certificate=True
        )
    job_id = await _make_job(session_factory, [ok, not_approved, already, "missing-id"])

    result = await _run_batch(job_id, session_factory)

    assert result == {"succeeded": 1, "failed": 3}
    async with session_factory() as session:
        job = await session.get(CertificateBatchJob, job_id)
        assert job.status == JobStatus.COMPLETED_WITH_ERRORS.value
        by_status = {r["inspection_id"]: r["status"] for r in job.results}
        assert by_status[ok] == "issued"
        assert by_status[not_approved] == "failed"
        assert by_status[already] == "failed"
        assert by_status["missing-id"] == "failed"


@pytest.mark.asyncio
async def test_run_batch_all_fail_marks_failed(
    session_factory, _wire_engine_and_storage
) -> None:
    job_id = await _make_job(session_factory, ["nope-1", "nope-2"])
    result = await _run_batch(job_id, session_factory)
    assert result == {"succeeded": 0, "failed": 2}
    async with session_factory() as session:
        job = await session.get(CertificateBatchJob, job_id)
        assert job.status == JobStatus.FAILED.value


# --- API layer (dispatch mocked) ------------------------------------------------


@asynccontextmanager
async def _client(session_factory, principal) -> AsyncGenerator[httpx.AsyncClient]:
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


class _FakeAsyncResult:
    id = "task-123"


@pytest.fixture
def _mock_dispatch(monkeypatch):
    monkeypatch.setattr(
        jobs_module.generate_certificate_batch,
        "delay",
        lambda job_id: _FakeAsyncResult(),
    )


@pytest.mark.asyncio
async def test_bulk_generate_auto_selects_eligible(
    session_factory, _mock_dispatch
) -> None:
    async with session_factory() as session:
        await _make_inspection(session, asset_number="E-1")
        await _make_inspection(session, asset_number="E-2")
        # Not eligible: not approved, and already-certified.
        await _make_inspection(
            session, asset_number="E-3", status=InspectionStatus.DRAFT.value
        )
        await _make_inspection(session, asset_number="E-4", with_certificate=True)

    async with _client(session_factory, _REVIEWER) as client:
        response = await client.post("/api/v1/certificates/bulk-generate", json={})

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["total"] == 2
    assert body["status"] == "PENDING"
    assert body["task_id"] == "task-123"

    async with _client(session_factory, _REVIEWER) as client:
        got = await client.get(f"/api/v1/jobs/certificate-batches/{body['id']}")
    assert got.status_code == 200
    assert got.json()["total"] == 2


@pytest.mark.asyncio
async def test_bulk_auto_select_excludes_condemned_and_retired(
    session_factory, _mock_dispatch
) -> None:
    async with session_factory() as session:
        await _make_inspection(session, asset_number="OK-1")
        await _make_inspection(
            session,
            asset_number="COND-1",
            lifecycle_status=AssetLifecycleStatus.CONDEMNED.value,
        )
        await _make_inspection(
            session,
            asset_number="RET-1",
            lifecycle_status=AssetLifecycleStatus.RETIRED.value,
        )

    async with _client(session_factory, _REVIEWER) as client:
        response = await client.post("/api/v1/certificates/bulk-generate", json={})

    assert response.status_code == 202, response.text
    # Only the IN_SERVICE asset is eligible; condemned/retired are excluded.
    assert response.json()["total"] == 1


@pytest.mark.asyncio
async def test_bulk_generate_no_eligible_returns_400(
    session_factory, _mock_dispatch
) -> None:
    async with _client(session_factory, _REVIEWER) as client:
        response = await client.post("/api/v1/certificates/bulk-generate", json={})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_bulk_generate_requires_permission(
    session_factory, _mock_dispatch
) -> None:
    customer_user = Principal(
        user_id="cust-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({"c1"}),
    )
    async with _client(session_factory, customer_user) as client:
        response = await client.post(
            "/api/v1/certificates/bulk-generate", json={"inspection_ids": ["x"]}
        )
    assert response.status_code == 403
