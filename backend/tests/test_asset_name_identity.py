"""An asset's name travels with its number wherever the API names an asset to a person.

The name is presentation data only: nothing is looked up, authorised or keyed by it.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.config import Settings
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
)
from hms_backend.app.modules.notifications.models import OutboxEvent
from hms_backend.app.modules.notifications.service import _emit_for_schedule
from hms_backend.app.modules.notifications.templates import render
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

NAMED = "Main Transfer Hose"


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def api_client(
    session_factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


def staff(role: Role = Role.HMS_ADMIN) -> Principal:
    return Principal(
        user_id=f"{role.value}-1", roles=frozenset({role}), customer_ids=frozenset()
    )


@pytest_asyncio.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    today = datetime.now(UTC).date()
    async with session_factory() as session:
        product = Product(category="Composite", code="P1", name="Hose")
        mine = Customer(code="MINE", name="Mine Ltd")
        theirs = Customer(code="THEIRS", name="Theirs Ltd")
        named = Asset(
            customer=mine,
            product=product,
            asset_number="HMS-NAMED-1",
            asset_name=NAMED,
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        unnamed = Asset(
            customer=mine,
            product=product,
            asset_number="HMS-PLAIN-2",
            asset_name=None,
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        certified = Asset(
            customer=mine,
            product=product,
            asset_number="HMS-CERT-4",
            asset_name="Main Transfer Hose Certified",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        foreign = Asset(
            customer=theirs,
            product=product,
            asset_number="HMS-FOREIGN-3",
            asset_name="Transfer Hose Elsewhere",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        named_review = Inspection(
            asset=named,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            submitted_at=datetime(2026, 10, 2, tzinfo=UTC),
        )
        unnamed_review = Inspection(
            asset=unnamed,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            submitted_at=datetime(2026, 10, 3, tzinfo=UTC),
        )
        foreign_review = Inspection(
            asset=foreign,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            submitted_at=datetime(2026, 10, 4, tzinfo=UTC),
        )
        approved = Inspection(
            asset=certified,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.APPROVED.value,
            result="PASS",
            inspector_user_id="i-1",
        )
        overdue = RetestSchedule(
            customer=mine,
            asset=named,
            due_at=today - timedelta(days=10),
            status=RetestScheduleStatus.OVERDUE.value,
        )
        due_soon = RetestSchedule(
            customer=mine,
            asset=unnamed,
            due_at=today + timedelta(days=3),
            status=RetestScheduleStatus.DUE.value,
        )
        foreign_schedule = RetestSchedule(
            customer=theirs,
            asset=foreign,
            due_at=today + timedelta(days=4),
            status=RetestScheduleStatus.DUE.value,
        )
        session.add_all(
            [
                named_review,
                unnamed_review,
                foreign_review,
                approved,
                overdue,
                due_soon,
                foreign_schedule,
            ]
        )
        await session.flush()
        certificate = Certificate.issue_from_inspection(
            approved,
            number="CERT-NAMED-1",
            pdf_object_key="certificates/named.pdf",
            verification_hash="named-hash",
            public_token="named-token",
            issued_by_user_id="reviewer-1",
            valid_until=date(2027, 1, 1),
        )
        session.add(certificate)
        await session.commit()
        return {
            "mine": mine.id,
            "theirs": theirs.id,
            "named": named.id,
            "unnamed": unnamed.id,
        }


# --- My Work and the dashboard carry the name, and its absence ---


@pytest.mark.asyncio
async def test_my_work_items_carry_the_asset_name_beside_the_number(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, staff(Role.REVIEWER)) as client:
        body = (await client.get("/api/v1/work/me")).json()

    by_number = {item["asset_number"]: item for item in body["items"]}
    assert by_number["HMS-NAMED-1"]["asset_name"] == NAMED
    assert by_number["HMS-PLAIN-2"]["asset_name"] is None


@pytest.mark.asyncio
async def test_dashboard_lists_carry_the_asset_name_beside_the_number(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, staff()) as client:
        body = (await client.get("/api/v1/dashboard", params={"limit": 10})).json()

    assert [(r["asset_number"], r["asset_name"]) for r in body["overdue_retests"]] == [
        ("HMS-NAMED-1", NAMED)
    ]
    due = {r["asset_number"]: r["asset_name"] for r in body["due_this_week"]}
    assert due["HMS-PLAIN-2"] is None
    reviews = {r["asset_number"]: r["asset_name"] for r in body["awaiting_review"]}
    assert reviews["HMS-NAMED-1"] == NAMED
    assert reviews["HMS-PLAIN-2"] is None


# --- search ---


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("transfer", {"HMS-NAMED-1", "HMS-CERT-4", "HMS-FOREIGN-3"}),
        ("MAIN TRANSFER", {"HMS-NAMED-1", "HMS-CERT-4"}),
        ("main transfer hose certified", {"HMS-CERT-4"}),
        ("hms-named-1", {"HMS-NAMED-1"}),
        ("HMS-PLAIN", {"HMS-PLAIN-2"}),
        ("no such asset", set()),
    ],
)
async def test_asset_search_finds_by_name_and_still_by_number(
    session_factory: async_sessionmaker[AsyncSession],
    world: dict[str, str],
    term: str,
    expected: set[str],
) -> None:
    async with api_client(session_factory, staff()) as client:
        body = (await client.get("/api/v1/assets", params={"search": term})).json()
    assert {item["asset_number"] for item in body["items"]} == expected
    assert body["total"] == len(expected)


@pytest.mark.asyncio
async def test_asset_search_by_name_keeps_to_the_customer_the_caller_may_see(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    customer_user = Principal(
        user_id="customer-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({world["mine"]}),
    )
    async with api_client(session_factory, customer_user) as client:
        broad = (
            await client.get("/api/v1/assets", params={"search": "transfer"})
        ).json()
        elsewhere = (
            await client.get("/api/v1/assets", params={"search": "elsewhere"})
        ).json()
        by_number = (
            await client.get("/api/v1/assets", params={"search": "HMS-FOREIGN"})
        ).json()

    assert sorted(item["asset_number"] for item in broad["items"]) == [
        "HMS-CERT-4",
        "HMS-NAMED-1",
    ]
    assert elsewhere["total"] == 0 and elsewhere["items"] == []
    assert by_number["total"] == 0


@pytest.mark.asyncio
async def test_inspection_certificate_and_retest_searches_also_match_the_asset_name(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, staff()) as client:
        inspections = (
            await client.get("/api/v1/inspections", params={"search": "main transfer"})
        ).json()
        certificates = (
            await client.get("/api/v1/certificates", params={"search": "main transfer"})
        ).json()
        retests = (
            await client.get(
                "/api/v1/retest-schedules", params={"search": "main transfer"}
            )
        ).json()

    assert {item["asset"]["asset_number"] for item in inspections["items"]} == {
        "HMS-NAMED-1",
        "HMS-CERT-4",
    }
    assert [item["number"] for item in certificates["items"]] == ["CERT-NAMED-1"]
    assert {item["asset"]["asset_number"] for item in retests["items"]} == {
        "HMS-NAMED-1"
    }


@pytest.mark.asyncio
async def test_other_customers_records_do_not_surface_by_name_in_scoped_searches(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    customer_user = Principal(
        user_id="customer-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({world["mine"]}),
    )
    async with api_client(session_factory, customer_user) as client:
        inspections = (
            await client.get("/api/v1/inspections", params={"search": "elsewhere"})
        ).json()
        retests = (
            await client.get("/api/v1/retest-schedules", params={"search": "elsewhere"})
        ).json()
    assert inspections["total"] == 0
    assert retests["total"] == 0


# --- notifications ---


def _render(
    category: NotificationCategory, channel: NotificationChannel, **context: object
) -> str:
    message = render(category, channel, dict(context))
    return f"{message.subject}\n{message.body_text}"


@pytest.mark.parametrize(
    ("channel", "category"),
    [
        (NotificationChannel.EMAIL, NotificationCategory.INSPECTION_FAILED),
        (NotificationChannel.SMS, NotificationCategory.INSPECTION_FAILED),
        (NotificationChannel.EMAIL, NotificationCategory.RETEST_OVERDUE),
        (NotificationChannel.EMAIL, NotificationCategory.CERTIFICATE_ISSUED),
        (NotificationChannel.EMAIL, NotificationCategory.ASSET_CONDEMNED),
    ],
)
def test_a_notification_names_the_asset_by_name_and_number(
    channel: NotificationChannel, category: NotificationCategory
) -> None:
    text = _render(
        category,
        channel,
        asset_number="HMS-1",
        asset_name=NAMED,
        certificate_number="C-1",
        due_date="2026-11-01",
        days_overdue=3,
        link="https://hms.test",
    )
    assert f"{NAMED} — HMS-1" in text


@pytest.mark.parametrize("name", [None, "", "   ", "HMS-1", " HMS-1 "])
def test_a_notification_reads_exactly_as_before_when_there_is_no_distinct_name(
    name: str | None,
) -> None:
    text = _render(
        NotificationCategory.INSPECTION_FAILED,
        NotificationChannel.EMAIL,
        asset_number="HMS-1",
        asset_name=name,
        customer_name="Mine Ltd",
    )
    assert "SAFETY: asset HMS-1 failed inspection" in text
    assert "Asset HMS-1 (Mine Ltd) failed inspection" in text


def test_an_event_written_before_names_were_carried_still_renders() -> None:
    text = _render(
        NotificationCategory.INSPECTION_APPROVED,
        NotificationChannel.EMAIL,
        asset_number="HMS-9",
    )
    assert "Your inspection for asset HMS-9 has been approved." in text


@pytest.mark.asyncio
async def test_events_raised_for_an_asset_carry_its_name(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, staff()) as client:
        escalated = await client.post("/api/v1/retest-schedules/escalate-overdue")
        condemned = await client.patch(
            f"/api/v1/assets/{world['named']}",
            json={"lifecycle_status": "CONDEMNED"},
            headers={"If-Match": '"1"'},
        )
    assert escalated.status_code == 200
    assert condemned.status_code == 200

    async with session_factory() as session:
        events = (
            await session.scalars(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == world["named"])
            )
        ).all()
    payloads = {event.event_type: event.payload for event in events}
    assert payloads["RETEST_OVERDUE"]["asset_name"] == NAMED
    assert payloads["RETEST_OVERDUE"]["asset_number"] == "HMS-NAMED-1"
    assert payloads["ASSET_CONDEMNED"]["asset_name"] == NAMED


@pytest.mark.asyncio
async def test_the_retest_scheduler_raises_its_events_with_the_asset_name(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    today = datetime.now(UTC).date()
    async with session_factory() as session:
        schedule = await session.scalar(
            select(RetestSchedule)
            .where(RetestSchedule.asset_id == world["named"])
            .options(selectinload(RetestSchedule.asset))
        )
        assert schedule is not None
        schedule.due_at = today  # due today: the scheduler's RETEST_DUE branch
        emitted = await _emit_for_schedule(session, schedule, Settings(), today)
        await session.commit()
        events = (
            await session.scalars(
                select(OutboxEvent).where(OutboxEvent.event_type == "RETEST_DUE")
            )
        ).all()

    assert emitted == 1
    assert [(e.payload["asset_number"], e.payload["asset_name"]) for e in events] == [
        ("HMS-NAMED-1", NAMED)
    ]
