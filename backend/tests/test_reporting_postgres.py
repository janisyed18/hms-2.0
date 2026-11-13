"""Dashboard, Analytics and activity counts against real PostgreSQL.

The SQLite suite proves the definitions; this proves the same SQL (CASE aggregation,
DATE/TIMESTAMPTZ comparisons, FOR UPDATE ... OF) behaves identically on the production
engine, at a volume far above any row limit, and stays scoped to one customer in a
shared database.
"""

# ruff: noqa: F811
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from test_core_records_api import api_client, org_today

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

ASSETS = 4_000
START = datetime(2026, 5, 1, 0, 0, tzinfo=UTC)
END = datetime(2026, 5, 31, 0, 0, tzinfo=UTC)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
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


async def _seed(database: async_sessionmaker[AsyncSession]) -> dict[str, object]:
    """One private customer: created/inspected on a known, awkward cadence."""
    tag = uuid4().hex[:10]
    async with database() as session:
        product = Product(category="C", code=f"P{tag}", name=f"Product {tag}")
        customer = Customer(code=f"R{tag}", name=f"Reporting {tag}")
        session.add_all([product, customer])
        await session.flush()
        today = org_today()
        created: list[datetime] = []
        submitted: list[datetime] = []
        for n in range(ASSETS):
            stamp = START + timedelta(minutes=11 * n + 3)
            created.append(stamp)
            asset = Asset(
                customer_id=customer.id,
                product_id=product.id,
                asset_number=f"{tag}-{n}",
                customer_serial_no=f"S{tag}{n}",
                tag=f"T{tag}{n}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                created_at=stamp,
            )
            session.add(asset)
            await session.flush()
            if n % 4 == 0:
                submitted_at = stamp + timedelta(hours=5)
                submitted.append(submitted_at)
                session.add(
                    Inspection(
                        asset_id=asset.id,
                        inspection_type=InspectionType.SERVICE.value,
                        status=InspectionStatus.SUBMITTED.value,
                        inspector_user_id="inspector-1",
                        submitted_at=submitted_at,
                    )
                )
            if n % 8 == 0:
                # due yesterday, today, +7 and +8 days, cycling: all four boundaries.
                offset = (-1, 0, 7, 8)[(n // 8) % 4]
                session.add(
                    RetestSchedule(
                        customer_id=customer.id,
                        asset_id=asset.id,
                        due_at=today + timedelta(days=offset),
                        status=RetestScheduleStatus.UPCOMING.value,
                    )
                )
        await session.flush()
        schedules = (
            await session.scalars(
                select(RetestSchedule).where(RetestSchedule.customer_id == customer.id)
            )
        ).all()
        escalated: list[datetime] = []
        for index, schedule in enumerate(schedules[:300]):
            stamp = START + timedelta(hours=2 * index + 1)
            escalated.append(stamp)
            session.add(
                AuditEvent(
                    actor_id="seed",
                    action="retest_schedule.escalated",
                    entity="RetestSchedule",
                    entity_id=schedule.id,
                    timestamp=stamp,
                    hash=f"seed-{tag}-{index}",
                )
            )
        await session.commit()
        return {
            "customer_id": customer.id,
            "created": created,
            "submitted": submitted,
            "escalated": escalated,
            "overdue": sum(1 for s in schedules if s.due_at < today),
            "due_soon": sum(
                1 for s in schedules if today <= s.due_at <= today + timedelta(days=7)
            ),
            "on_track": sum(
                1 for s in schedules if s.due_at > today + timedelta(days=7)
            ),
            "schedules": len(schedules),
        }


def _inside(stamps: list[datetime], start: datetime, end: datetime) -> int:
    return sum(1 for stamp in stamps if start <= stamp < end)


@pytest.mark.asyncio
async def test_activity_reconciles_with_records_on_postgres(
    database: async_sessionmaker[AsyncSession],
) -> None:
    seeded = await _seed(database)
    user = Principal(
        user_id="customer-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({str(seeded["customer_id"])}),
    )
    async with api_client(database, user) as client:
        response = await client.get(
            "/api/v1/reporting/activity",
            params={"start_at": START.isoformat(), "end_at": END.isoformat()},
        )
    body = response.json()

    assert response.status_code == 200
    created, submitted, escalated = (
        seeded["created"],
        seeded["submitted"],
        seeded["escalated"],
    )
    assert isinstance(created, list) and isinstance(submitted, list)
    assert isinstance(escalated, list)
    assert _inside(created, START, END) > 3_000  # not capped at any page size
    assert body["totals"]["assets_added"] == _inside(created, START, END)
    assert body["totals"]["inspections_submitted"] == _inside(submitted, START, END)
    assert body["totals"]["retests_escalated"] == _inside(escalated, START, END)
    for bucket in body["buckets"]:
        b_start = datetime.fromisoformat(bucket["start"])
        b_end = datetime.fromisoformat(bucket["end"])
        assert bucket["assets_added"] == _inside(created, b_start, b_end)
        assert bucket["inspections_submitted"] == _inside(submitted, b_start, b_end)
        assert bucket["retests_escalated"] == _inside(escalated, b_start, b_end)
    assert (
        sum(b["assets_added"] for b in body["buckets"])
        == body["totals"]["assets_added"]
    )


@pytest.mark.asyncio
async def test_snapshot_matches_between_dashboard_and_analytics_on_postgres(
    database: async_sessionmaker[AsyncSession],
) -> None:
    seeded = await _seed(database)
    user = Principal(
        user_id="customer-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({str(seeded["customer_id"])}),
    )
    windows = [
        {},
        {"start_at": "2026-05-01T00:00:00Z", "end_at": "2026-05-08T00:00:00Z"},
        {"start_at": "2099-01-01T00:00:00Z", "end_at": "2099-01-02T00:00:00Z"},
    ]
    async with api_client(database, user) as client:
        pairs = [
            (
                (await client.get("/api/v1/dashboard", params=window)).json(),
                (await client.get("/api/v1/analytics/overview", params=window)).json(),
            )
            for window in windows
        ]
        eligible_before = pairs[0][0]["escalation_eligible_total"]
    admin = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    async with api_client(database, admin) as client:
        # Exercises SELECT ... FOR UPDATE OF on PostgreSQL. The database is shared, so
        # other tests' overdue schedules may be included: assert at least ours.
        escalation = await client.post("/api/v1/retest-schedules/escalate-overdue")
        repeat = await client.post("/api/v1/retest-schedules/escalate-overdue")
    async with api_client(database, user) as client:
        after = (await client.get("/api/v1/dashboard")).json()

    status = pairs[0][0]["fleet_status"]
    assert status["overdue"] == seeded["overdue"]
    assert status["due_soon"] == seeded["due_soon"]
    assert status["on_track"] == seeded["on_track"]
    assert status["unscheduled"] == ASSETS - int(str(seeded["schedules"]))
    assert status["total"] == ASSETS
    for dashboard, analytics in pairs:
        # Identical numbers whatever the period, and identical across both pages.
        assert dashboard["fleet_status"] == analytics["fleet_status"] == status
        assert dashboard["overdue_assets"] == analytics["overdue_assets"]
        assert dashboard["due_soon_assets"] == analytics["due_soon_assets"]
        assert (
            dashboard["awaiting_review_inspections"]
            == (analytics["awaiting_review_inspections"])
        )
    assert eligible_before == seeded["overdue"]
    assert escalation.status_code == 200
    assert escalation.json()["dispatched"] == escalation.json()["eligible"]
    assert escalation.json()["dispatched"] >= seeded["overdue"]
    assert repeat.json() == {"dispatched": 0, "eligible": 0}
    assert after["escalation_eligible_total"] == 0
    assert after["escalated_today"] == seeded["overdue"]
