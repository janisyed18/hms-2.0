"""Inspection lifecycle races on a dedicated, migrated PostgreSQL database.

Two requests that read the same state must not both succeed. The transitions take a row
lock on the inspection, so the second waits, sees what the first did, and gets a 409.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from test_inspection_form import complete

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    PressureTestResult,
)
from hms_backend.app.modules.notifications.models import OutboxEvent
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

WORKER = Principal(
    user_id="lifecycle-worker",
    roles=frozenset({Role.SUPER_ADMIN}),
    customer_ids=frozenset(),
)
REVIEWER = Principal(
    user_id="lifecycle-reviewer",
    roles=frozenset({Role.REVIEWER}),
    customer_ids=frozenset(),
)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("Race tests require a dedicated async PostgreSQL database")
    name = make_url(POSTGRES_URL).database
    if name is None or not name.endswith("_test"):
        raise ValueError("Race tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=8)
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


@asynccontextmanager
async def client_for(
    database: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with database() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def make_inspection(
    database: async_sessionmaker[AsyncSession], status: str
) -> str:
    token = uuid4().hex[:12]
    async with database() as session:
        standard = Standard(code=f"S-{token}", name="Lifecycle standard")
        product = Product(
            category="Hose",
            sub_category="Test",
            code=f"P-{token}",
            name="Lifecycle product",
            standard=standard,
        )
        customer = Customer(code=f"C-{token}", name="Lifecycle customer")
        location = CustomerLocation(customer=customer, name="Lifecycle site")
        asset = Asset(
            customer=customer,
            location=location,
            product=product,
            asset_number=f"A-{token}",
            lifecycle_status="IN_SERVICE",
        )
        inspection = Inspection(
            asset=asset,
            inspection_type="SERVICE",
            status=status,
            result="PASS",
            inspector_user_id="lifecycle-worker",
        )
        inspection.pressure_test = PressureTestResult(
            applied_pressure_kpa=2250,
            hold_time_seconds=300,
            passed=True,
            measurements=complete(),
        )
        session.add_all([asset, inspection])
        await session.commit()
        return inspection.id


async def both(
    database: async_sessionmaker[AsyncSession],
    calls: list[tuple[Principal, str, dict[str, Any] | None]],
) -> list[int]:
    """Fire the requests at the same moment, each on its own connection."""
    async with asyncio.TaskGroup() as group:

        async def one(
            principal: Principal, path: str, body: dict[str, Any] | None
        ) -> int:
            async with client_for(database, principal) as client:
                response = await client.post(path, json=body)
                return response.status_code

        tasks = [group.create_task(one(*call)) for call in calls]
    return [task.result() for task in tasks]


async def facts(
    database: async_sessionmaker[AsyncSession], inspection_id: str
) -> tuple[Inspection, list[str], list[str]]:
    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        actions = list(
            (
                await session.scalars(
                    select(AuditEvent.action)
                    .where(AuditEvent.entity_id == inspection_id)
                    .order_by(AuditEvent.sequence)
                )
            ).all()
        )
        events = list(
            (
                await session.scalars(
                    select(OutboxEvent.event_type).where(
                        OutboxEvent.aggregate_id == inspection_id
                    )
                )
            ).all()
        )
        assert await verify_audit_chain(session)
        return inspection, actions, events


def path(inspection_id: str, action: str) -> str:
    return f"/api/v1/inspections/{inspection_id}/{action}"


@pytest.mark.asyncio
async def test_approve_and_reject_cannot_both_win(
    database: async_sessionmaker[AsyncSession],
) -> None:
    inspection_id = await make_inspection(database, InspectionStatus.SUBMITTED.value)
    statuses = await both(
        database,
        [
            (REVIEWER, path(inspection_id, "approve"), None),
            (REVIEWER, path(inspection_id, "reject"), {"reason": "Racing reviewer"}),
        ],
    )
    assert sorted(statuses) == [200, 409], statuses
    inspection, actions, _ = await facts(database, inspection_id)
    decisions = [
        a for a in actions if a in {"inspection.approved", "inspection.rejected"}
    ]
    assert len(decisions) == 1
    assert inspection.status == (
        "APPROVED" if decisions == ["inspection.approved"] else "REJECTED"
    )
    if inspection.status == "REJECTED":
        assert inspection.rejection_reason == "Racing reviewer"
        assert inspection.approved_at is None
    else:
        assert inspection.rejected_at is None and inspection.rejection_reason is None


@pytest.mark.asyncio
async def test_two_approvals_apply_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    inspection_id = await make_inspection(database, InspectionStatus.SUBMITTED.value)
    statuses = await both(
        database,
        [(REVIEWER, path(inspection_id, "approve"), None)] * 2,
    )
    assert sorted(statuses) == [200, 409], statuses
    _, actions, events = await facts(database, inspection_id)
    assert actions.count("inspection.approved") == 1
    assert events.count("INSPECTION_APPROVED") == 1


@pytest.mark.asyncio
async def test_two_submits_apply_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    inspection_id = await make_inspection(database, InspectionStatus.IN_PROGRESS.value)
    statuses = await both(database, [(WORKER, path(inspection_id, "submit"), None)] * 2)
    assert sorted(statuses) == [200, 409], statuses
    inspection, actions, events = await facts(database, inspection_id)
    assert inspection.status == "SUBMITTED"
    assert actions.count("inspection.submitted") == 1
    assert events.count("INSPECTION_SUBMITTED") == 1  # the reviewers are told once


@pytest.mark.asyncio
async def test_two_starts_set_started_at_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    inspection_id = await make_inspection(database, InspectionStatus.DRAFT.value)
    statuses = await both(database, [(WORKER, path(inspection_id, "start"), None)] * 3)
    assert sorted(statuses) == [200, 409, 409], statuses
    inspection, actions, _ = await facts(database, inspection_id)
    assert inspection.status == "IN_PROGRESS" and inspection.started_at is not None
    assert actions.count("inspection.started") == 1


@pytest.mark.asyncio
async def test_two_reworks_begin_once_and_keep_started_at(
    database: async_sessionmaker[AsyncSession],
) -> None:
    inspection_id = await make_inspection(database, InspectionStatus.REJECTED.value)
    statuses = await both(database, [(WORKER, path(inspection_id, "rework"), None)] * 2)
    assert sorted(statuses) == [200, 409], statuses
    inspection, actions, _ = await facts(database, inspection_id)
    assert inspection.status == "IN_PROGRESS"
    assert actions.count("inspection.rework_started") == 1


@pytest.mark.asyncio
async def test_a_submit_racing_a_rework_never_leaves_an_inconsistent_record(
    database: async_sessionmaker[AsyncSession],
) -> None:
    """From REJECTED, submit is only valid after rework: whichever order the lock gives,
    the result is a state the lifecycle allows and each applied step left its event."""
    inspection_id = await make_inspection(database, InspectionStatus.REJECTED.value)
    statuses = await both(
        database,
        [
            (WORKER, path(inspection_id, "submit"), None),
            (WORKER, path(inspection_id, "rework"), None),
        ],
    )
    inspection, actions, _ = await facts(database, inspection_id)
    assert 200 in statuses
    if statuses == [409, 200]:  # submit first: refused; rework then applied
        assert inspection.status == "IN_PROGRESS"
        assert "inspection.submitted" not in actions
    else:  # rework first, then the submit saw IN_PROGRESS and succeeded
        assert statuses == [200, 200]
        assert inspection.status == "SUBMITTED"
        assert actions.index("inspection.rework_started") < actions.index(
            "inspection.submitted"
        )
