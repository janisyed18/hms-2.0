"""The real failure mode: PostgreSQL enforces the 36-character user-id columns.

SQLite accepts any length, so only a migrated PostgreSQL database proves that a
browser-auth reviewer (subject ``local:<uuid>``, 42 characters) can approve an
inspection and issue a certificate without a ``value too long`` error.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from certificate_support import seed_approved_inspection
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Reuse the auth/certificate wiring and helpers from the SQLite regression module.
from test_persisted_user_ids import (  # noqa: F401
    bearer_and_certificates,
    client_for,
    make_user,
    submitted_inspection,
)

from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.identity import models as _identity_models  # noqa: F401
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.jobs.models import CertificateBatchJob

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=4)
    try:
        async with engine.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_browser_reviewer_can_approve_and_issue_on_postgresql(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    from uuid import uuid4

    tag = uuid4().hex[:10].upper()
    reviewer = await make_user(session_factory, Role.REVIEWER)
    inspection_id = await submitted_inspection(session_factory, f"PG{tag}")

    async with client_for(session_factory, reviewer) as client:
        approved = await client.post(f"/api/v1/inspections/{inspection_id}/approve")
        assert approved.status_code == 200, approved.text
        issued = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )
        assert issued.status_code == 201, issued.text

    async with session_factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.inspection_id == inspection_id)
            )
        ).one()
        assert inspection is not None
        assert inspection.reviewer_user_id == reviewer.id
        assert certificate.issued_by_user_id == reviewer.id


@pytest.mark.asyncio
async def test_browser_reviewer_can_queue_a_bulk_job_on_postgresql(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    from uuid import uuid4

    reviewer = await make_user(session_factory, Role.REVIEWER)
    inspection_id = await seed_approved_inspection(
        session_factory, f"PJ{uuid4().hex[:10].upper()}"
    )

    async with client_for(session_factory, reviewer) as client:
        response = await client.post(
            "/api/v1/certificates/bulk-generate",
            json={"inspection_ids": [inspection_id]},
        )
    assert response.status_code == 202, response.text

    async with session_factory() as session:
        job = (
            await session.scalars(
                select(CertificateBatchJob).where(
                    CertificateBatchJob.requested_by_user_id == reviewer.id
                )
            )
        ).one()
        assert job.requested_by_user_id == reviewer.id
