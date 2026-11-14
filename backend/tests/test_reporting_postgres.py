"""Dashboard, Analytics and activity counts against real PostgreSQL.

The SQLite suite proves the definitions; this proves the same SQL (CASE aggregation,
DATE/TIMESTAMPTZ comparisons, FOR UPDATE ... OF) behaves identically on the production
engine, at a volume far above any row limit.

These tests run in their own disposable database, migrated to head and dropped
afterwards. They must not share the CI database: they insert thousands of assets, and
the escalation endpoint acts on every eligible overdue schedule an admin can see, so in
a shared database they would both skew bounded projections (My Work) and escalate other
tests' records. Audit events are only ever written by the application's own writer
through the API, so the hash chain stays valid; this module asserts that too.
"""

# ruff: noqa: F811
from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from test_core_records_api import api_client, org_today

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.models.base import Base
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

BACKEND = Path(__file__).resolve().parents[1]
POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

ASSETS = 4_000
START = datetime(2026, 5, 1, 0, 0, tzinfo=UTC)
END = datetime(2026, 5, 31, 0, 0, tzinfo=UTC)

ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)


@pytest_asyncio.fixture(scope="module")
async def disposable_database() -> AsyncIterator[str]:
    """A database of this module's own, migrated to head and dropped afterwards."""
    assert POSTGRES_URL is not None
    base = make_url(POSTGRES_URL)
    name = f"hms_reporting_{uuid4().hex[:10]}_test"
    admin = create_async_engine(base, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name).render_as_string(hide_password=False)
    try:
        # Inside the try: a failed or timed-out migration must still drop the database,
        # or a broken run would leave one behind on every attempt.
        migrate = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=BACKEND,
            env={**os.environ, "DATABASE_URL": url},
            capture_output=True,
            text=True,
            timeout=600,
        )
        assert migrate.returncode == 0, migrate.stderr
        yield url
    finally:
        async with admin.connect() as connection:
            await connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :name AND pid <> pg_backend_pid()"
                ),
                {"name": name},
            )
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        await admin.dispose()


@pytest_asyncio.fixture
async def database(
    disposable_database: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """An empty schema per test, so each one's counts are exact."""
    engine = create_async_engine(disposable_database, pool_size=4)
    tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _seed(database: async_sessionmaker[AsyncSession]) -> dict[str, object]:
    """One customer, created and inspected on a known, awkward cadence."""
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
        await session.commit()
        return {
            "customer_id": customer.id,
            "created": created,
            "submitted": submitted,
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
    created, submitted = seeded["created"], seeded["submitted"]
    assert isinstance(created, list) and isinstance(submitted, list)
    assert _inside(created, START, END) > 3_000  # not capped at any page size
    assert body["totals"]["assets_added"] == _inside(created, START, END)
    assert body["totals"]["inspections_submitted"] == _inside(submitted, START, END)
    for bucket in body["buckets"]:
        b_start = datetime.fromisoformat(bucket["start"])
        b_end = datetime.fromisoformat(bucket["end"])
        assert bucket["assets_added"] == _inside(created, b_start, b_end)
        assert bucket["inspections_submitted"] == _inside(submitted, b_start, b_end)
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
    windows: list[dict[str, str]] = [
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


@pytest.mark.asyncio
async def test_escalation_counts_every_event_and_keeps_the_audit_chain_valid(
    database: async_sessionmaker[AsyncSession],
) -> None:
    """Escalation writes through the application's audit writer, never around it.

    Each escalation is a separate audit event, which is why the activity series counts
    them from the chain rather than from ``RetestSchedule.escalated_at`` (that column
    keeps only the latest one).
    """
    seeded = await _seed(database)
    overdue = int(str(seeded["overdue"]))
    window_start = datetime.now(UTC) - timedelta(minutes=5)

    async with api_client(database, ADMIN) as client:
        first = await client.post("/api/v1/retest-schedules/escalate-overdue")
        repeat = await client.post("/api/v1/retest-schedules/escalate-overdue")
        dashboard = (await client.get("/api/v1/dashboard")).json()
        activity = (
            await client.get(
                "/api/v1/reporting/activity",
                params={
                    "start_at": window_start.isoformat(),
                    "end_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
                },
            )
        ).json()

    assert first.json() == {"dispatched": overdue, "eligible": overdue}
    assert repeat.json() == {"dispatched": 0, "eligible": 0}
    assert dashboard["escalation_eligible_total"] == 0
    assert dashboard["escalated_today"] == overdue
    assert activity["totals"]["retests_escalated"] == overdue
    assert sum(b["retests_escalated"] for b in activity["buckets"]) == overdue

    async with database() as session:
        assert await verify_audit_chain(session) is True
