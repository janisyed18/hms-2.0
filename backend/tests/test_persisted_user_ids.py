"""Persisted ``*_user_id`` columns must hold ``users.id``, not the auth subject.

Browser-auth users get an external subject ``local:<uuid>`` (42 characters) while
domain columns such as ``Inspection.reviewer_user_id`` are 36-character references
to ``users.id``. SQLite does not enforce VARCHAR length, so these tests assert the
*value* written (the user's UUID, never the subject); PostgreSQL would reject the
subject outright. Authentication goes through the real bearer path so that
``Principal.record_user_id`` is populated exactly as in deployment.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from certificate_support import SigningFakeEngine, build_pki, seed_approved_inspection
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from test_auth_boundary import sign_token
from uuid6 import uuid7

import hms_backend.app.api.jobs as jobs_module
import hms_backend.app.api.records as records_module
import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.jobs.models import CertificateBatchJob

SUBJECT_PREFIX = "local:"


def test_persisted_user_id_prefers_the_database_user_id() -> None:
    user_id = str(uuid7())
    principal = Principal(
        user_id=f"{SUBJECT_PREFIX}{user_id}",
        roles=frozenset({Role.REVIEWER}),
        customer_ids=frozenset(),
        record_user_id=user_id,
    )
    assert principal.persisted_user_id == user_id
    assert principal.user_id != principal.persisted_user_id
    assert principal.assignment_user_id == user_id


def test_persisted_user_id_falls_back_for_identities_without_a_user_row() -> None:
    principal = Principal(
        user_id="dev-user", roles=frozenset({Role.REVIEWER}), customer_ids=frozenset()
    )
    assert principal.persisted_user_id == "dev-user"


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture(autouse=True)
def bearer_and_certificates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> SigningFakeEngine:
    monkeypatch.setattr(settings, "auth_mode", "bearer", raising=False)
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "test-secret")
    monkeypatch.setattr(settings, "auth_bearer_issuer", "bat-hms-tests")
    monkeypatch.setattr(settings, "auth_bearer_audience", "staff-web")
    pki = build_pki(tmp_path / "pki")
    monkeypatch.setattr(settings, "certificate_trust_anchor_path", str(pki.anchor_path))
    engine = SigningFakeEngine(pki.signer)
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: engine)
    monkeypatch.setattr(
        storage_module, "_storage", LocalObjectStorage(tmp_path / "objects")
    )
    monkeypatch.setattr(
        jobs_module.generate_certificate_batch, "delay", lambda job_id: _Result()
    )
    return engine


class _Result:
    id = "task-1"


async def make_user(
    session_factory: async_sessionmaker[AsyncSession], role: Role
) -> User:
    user_id = str(uuid7())
    async with session_factory() as session:
        user = User(
            id=user_id,
            oidc_subject=f"{SUBJECT_PREFIX}{uuid7()}",
            email=f"{role.value.lower()}-{user_id[-12:]}@example.test",
            first_name="Test",
            last_name=role.value,
            role=role.value,
        )
        session.add(user)
        await session.commit()
    # The production shape that broke: subject is longer than the 36-char columns.
    assert len(user.id) == 36 and len(user.oidc_subject) > 36
    return user


@asynccontextmanager
async def client_for(
    session_factory: async_sessionmaker[AsyncSession], user: User
) -> AsyncGenerator[httpx.AsyncClient]:
    token = sign_token(
        {
            "sub": user.oidc_subject,
            "iss": "bat-hms-tests",
            "aud": "staff-web",
            "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        },
        "test-secret",
    )
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {token}"},
    ) as client:
        yield client


async def submitted_inspection(
    session_factory: async_sessionmaker[AsyncSession], tag: str
) -> str:
    inspection_id = await seed_approved_inspection(session_factory, tag)
    async with session_factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        inspection.status = InspectionStatus.SUBMITTED.value
        await session.commit()
    return inspection_id


@pytest.mark.asyncio
async def test_bearer_principal_carries_both_identities(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    reviewer = await make_user(session_factory, Role.REVIEWER)
    async with client_for(session_factory, reviewer) as client:
        response = await client.get("/api/v1/auth/me")
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == reviewer.oidc_subject
    assert "certificate:approve" in body["permissions"]


@pytest.mark.asyncio
async def test_approve_then_issue_store_the_user_id_and_audit_the_subject(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    reviewer = await make_user(session_factory, Role.REVIEWER)
    inspection_id = await submitted_inspection(session_factory, "U1")

    async with client_for(session_factory, reviewer) as client:
        approved = await client.post(f"/api/v1/inspections/{inspection_id}/approve")
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "APPROVED"
        issued = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )
        assert issued.status_code == 201, issued.text
        assert issued.json()["status"] == "ISSUED"

    async with session_factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.inspection_id == inspection_id)
            )
        ).one()
        assert inspection is not None
        assert inspection.reviewer_user_id == reviewer.id
        assert inspection.reviewer_user_id != reviewer.oidc_subject
        assert certificate.issued_by_user_id == reviewer.id
        assert certificate.issued_by_user_id != reviewer.oidc_subject
        # Authentication/audit identity keeps the external subject.
        actors = {
            event.action: event.actor_id
            for event in (await session.scalars(select(AuditEvent))).all()
        }
        assert actors["inspection.approved"] == reviewer.oidc_subject
        assert actors["certificate.issued"] == reviewer.oidc_subject


@pytest.mark.asyncio
async def test_reject_stores_the_user_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    reviewer = await make_user(session_factory, Role.REVIEWER)
    inspection_id = await submitted_inspection(session_factory, "U2")

    async with client_for(session_factory, reviewer) as client:
        rejected = await client.post(
            f"/api/v1/inspections/{inspection_id}/reject", json={"reason": "retest"}
        )
    assert rejected.status_code == 200, rejected.text

    async with session_factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        assert inspection.reviewer_user_id == reviewer.id


@pytest.mark.asyncio
async def test_bulk_job_stores_the_requesting_users_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    reviewer = await make_user(session_factory, Role.REVIEWER)
    inspection_id = await seed_approved_inspection(session_factory, "U3")

    async with client_for(session_factory, reviewer) as client:
        response = await client.post(
            "/api/v1/certificates/bulk-generate",
            json={"inspection_ids": [inspection_id]},
        )
    assert response.status_code == 202, response.text

    async with session_factory() as session:
        job = (await session.scalars(select(CertificateBatchJob))).one()
        assert job.requested_by_user_id == reviewer.id
        assert job.requested_by_user_id != reviewer.oidc_subject


@pytest.mark.asyncio
async def test_staff_created_inspection_stores_the_users_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await make_user(session_factory, Role.SUPER_ADMIN)
    inspection_id = await seed_approved_inspection(session_factory, "U4")
    async with session_factory() as session:
        asset_id = (await session.get(Inspection, inspection_id)).asset_id  # type: ignore[union-attr]

    async with client_for(session_factory, admin) as client:
        created = await client.post(
            f"/api/v1/assets/{asset_id}/inspections",
            json={
                "inspection_type": "SERVICE",
                "pressure_test": {
                    "applied_pressure_kpa": 42000,
                    "hold_time_seconds": 120,
                    "passed": True,
                },
            },
        )
    assert created.status_code == 201, created.text

    async with session_factory() as session:
        inspection = await session.get(Inspection, created.json()["id"])
        assert inspection is not None
        assert inspection.inspector_user_id == admin.id
        assert inspection.inspector_user_id != admin.oidc_subject
