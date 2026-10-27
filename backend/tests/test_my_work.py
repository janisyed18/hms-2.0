from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentStatus,
    InspectionBooking,
    InspectionBookingAsset,
    InspectionBookingStatus,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.work.service import MAX_SOURCE_ASSETS


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


@pytest_asyncio.fixture
async def work_world(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, str]:
    async with session_factory() as session:
        product = Product(category="Composite", code="P1", name="Hose")
        mine = Customer(code="MINE", name="Mine Ltd")
        theirs = Customer(code="THEIRS", name="Theirs Ltd")
        draft = Asset(
            customer=mine,
            product=product,
            asset_number="A-DRAFT",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        review = Asset(
            customer=mine,
            product=product,
            asset_number="A-REVIEW",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        settled = Asset(
            customer=mine,
            product=product,
            asset_number="A-SETTLED",
            lifecycle_status=AssetLifecycleStatus.RETIRED.value,
        )
        foreign = Asset(
            customer=theirs,
            product=product,
            asset_number="A-FOREIGN",
            lifecycle_status=AssetLifecycleStatus.RETIRED.value,
        )
        due_mine = Asset(
            customer=mine,
            product=product,
            asset_number="A-DUE-MINE",
            lifecycle_status=AssetLifecycleStatus.DUE.value,
        )
        due_theirs = Asset(
            customer=theirs,
            product=product,
            asset_number="A-DUE-THEIRS",
            lifecycle_status=AssetLifecycleStatus.DUE.value,
        )
        session.add_all(
            [
                Inspection(
                    asset=draft,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.DRAFT.value,
                    created_at=datetime(2026, 10, 1, tzinfo=UTC),
                ),
                Inspection(
                    asset=review,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.SUBMITTED.value,
                    submitted_at=datetime(2026, 10, 2, tzinfo=UTC),
                ),
                Inspection(
                    asset=settled,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.APPROVED.value,
                    approved_at=datetime(2026, 10, 3, tzinfo=UTC),
                ),
                Inspection(
                    asset=foreign,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.SUBMITTED.value,
                    submitted_at=datetime(2026, 10, 4, tzinfo=UTC),
                ),
            ]
        )
        await session.commit()
        return {
            "mine": mine.id,
            "theirs": theirs.id,
            "due_mine": due_mine.id,
            "due_theirs": due_theirs.id,
        }


def principal(role: Role, customers: frozenset[str] = frozenset()) -> Principal:
    return Principal(
        user_id=f"{role.value}-1",
        roles=frozenset({role}),
        customer_ids=customers,
    )


@pytest.mark.asyncio
async def test_my_work_uses_authoritative_actions_and_excludes_settled_work(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with api_client(session_factory, principal(Role.REVIEWER)) as client:
        response = await client.get("/api/v1/work/me")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["total"] == 1
    assert [(item["state"], item["next_action"]["code"]) for item in body["items"]] == [
        ("AWAITING_REVIEW", "REVIEW_INSPECTION")
    ]
    assert body["items"][0]["customer_id"] == work_world["mine"]
    assert body["items"][0]["next_action"]["target_type"] == "INSPECTION"


@pytest.mark.asyncio
async def test_my_work_scopes_customer_actions_to_authorized_customers(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with api_client(
        session_factory,
        principal(Role.CUSTOMER_USER, frozenset({work_world["theirs"]})),
    ) as client:
        response = await client.get("/api/v1/work/me")

    assert response.status_code == 200
    items = response.json()["items"]
    assert [(item["customer_id"], item["next_action"]["code"]) for item in items] == [
        (work_world["theirs"], "BOOK_INSPECTION")
    ]


@pytest.mark.asyncio
async def test_my_work_returns_schedule_review_only_to_a_staff_principal(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with session_factory() as session:
        booking = InspectionBooking(
            customer_id=work_world["mine"],
            location_id="location-1",
            scheduled_at=datetime(2026, 10, 5, tzinfo=UTC),
            status=InspectionBookingStatus.PENDING_APPROVAL.value,
            requested_by_user_id="customer-user",
        )
        booking.assets.append(InspectionBookingAsset(asset_id=work_world["due_mine"]))
        session.add(booking)
        await session.commit()

    async with api_client(session_factory, principal(Role.HMS_ADMIN)) as client:
        body = (await client.get("/api/v1/work/me")).json()

    assert any(
        item["next_action"]["code"] == "REVIEW_SCHEDULE_REQUEST"
        and item["booking_id"] == booking.id
        for item in body["items"]
    )


@pytest.mark.asyncio
async def test_my_work_deduplicates_a_single_booking_action_for_multiple_assets(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with session_factory() as session:
        mine = await session.get(Customer, work_world["mine"])
        product = await session.scalar(select(Product))
        assert mine is not None and product is not None
        second_asset = Asset(
            customer=mine,
            product=product,
            asset_number="A-DUE-SECOND",
            lifecycle_status=AssetLifecycleStatus.DUE.value,
        )
        booking = InspectionBooking(
            customer_id=work_world["mine"],
            location_id="location-1",
            scheduled_at=datetime(2026, 10, 5, tzinfo=UTC),
            status=InspectionBookingStatus.PENDING_APPROVAL.value,
            requested_by_user_id="customer-user",
        )
        booking.assets.extend(
            [
                InspectionBookingAsset(asset_id=work_world["due_mine"]),
                InspectionBookingAsset(asset=second_asset),
            ]
        )
        session.add(booking)
        await session.commit()

    async with api_client(session_factory, principal(Role.HMS_ADMIN)) as client:
        body = (await client.get("/api/v1/work/me")).json()

    schedule_actions = [
        item
        for item in body["items"]
        if item["next_action"]["code"] == "REVIEW_SCHEDULE_REQUEST"
    ]
    assert [item["booking_id"] for item in schedule_actions] == [booking.id]


@pytest.mark.asyncio
async def test_my_work_limit_keeps_priority_order_deterministic(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with session_factory() as session:
        mine = await session.get(Customer, work_world["mine"])
        product = await session.scalar(select(Product))
        assert mine is not None and product is not None
        session.add(
            Asset(
                customer=mine,
                product=product,
                asset_number="A-OVERDUE",
                lifecycle_status=AssetLifecycleStatus.OVERDUE.value,
            )
        )
        await session.commit()

    async with api_client(session_factory, principal(Role.HMS_ADMIN)) as client:
        response = await client.get("/api/v1/work/me?limit=1")

    assert response.status_code == 200
    assert response.json()["summary"]["total"] >= 2
    assert response.json()["items"][0]["priority"] == "URGENT"


@pytest.mark.asyncio
async def test_my_work_marks_an_empty_bounded_scan_as_partial(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An actionable asset after the scan boundary must not look like an empty queue."""
    async with session_factory() as session:
        product = Product(category="Composite", code="BOUND", name="Hose")
        customer = Customer(code="BOUND", name="Bounded scan customer")
        assets = [
            Asset(
                id=f"my-work-boundary-{index:04d}",
                customer=customer,
                product=product,
                asset_number=f"BOUND-{index:04d}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
            for index in range(MAX_SOURCE_ASSETS + 1)
        ]
        session.add_all(assets)
        session.add(
            Inspection(
                asset=assets[-1],
                inspection_type=InspectionType.SERVICE.value,
                status=InspectionStatus.SUBMITTED.value,
            )
        )
        await session.commit()

    async with api_client(session_factory, principal(Role.REVIEWER)) as client:
        response = await client.get("/api/v1/work/me")

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["summary"]["total"] == 0
    assert body["source_limited"] is True
    assert body["source_limit"] == MAX_SOURCE_ASSETS


@pytest.mark.asyncio
async def test_my_work_uses_inspection_activity_not_asset_activity_for_review_order(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    old_asset_time = datetime(2026, 9, 1, tzinfo=UTC)
    older_submission = datetime(2026, 10, 27, 10, tzinfo=UTC)
    newer_submission = datetime(2026, 10, 28, 10, tzinfo=UTC)
    async with session_factory() as session:
        product = Product(category="Composite", code="ACTIVITY", name="Hose")
        customer = Customer(code="ACTIVITY", name="Activity customer")
        older_asset = Asset(
            customer=customer,
            product=product,
            asset_number="ACTIVITY-OLDER",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            created_at=old_asset_time,
            updated_at=old_asset_time,
        )
        newer_asset = Asset(
            customer=customer,
            product=product,
            asset_number="ACTIVITY-NEWER",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            created_at=old_asset_time,
            updated_at=old_asset_time,
        )
        session.add_all(
            [
                Inspection(
                    asset=older_asset,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.SUBMITTED.value,
                    created_at=old_asset_time,
                    updated_at=older_submission,
                    submitted_at=older_submission,
                ),
                Inspection(
                    asset=newer_asset,
                    inspection_type=InspectionType.SERVICE.value,
                    status=InspectionStatus.SUBMITTED.value,
                    created_at=old_asset_time,
                    updated_at=newer_submission,
                    submitted_at=newer_submission,
                ),
            ]
        )
        await session.commit()

    async with api_client(session_factory, principal(Role.REVIEWER)) as client:
        response = await client.get("/api/v1/work/me")

    assert response.status_code == 200
    reviews = [
        item
        for item in response.json()["items"]
        if item["asset_number"].startswith("ACTIVITY-")
    ]
    assert [item["asset_number"] for item in reviews] == [
        "ACTIVITY-NEWER",
        "ACTIVITY-OLDER",
    ]
    assert reviews[0]["updated_at"].startswith("2026-10-28T10:00:00")
    assert reviews[1]["updated_at"].startswith("2026-10-27T10:00:00")


@pytest.mark.asyncio
async def test_my_work_uses_rejection_activity_not_an_old_asset_timestamp(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    old_asset_time = datetime(2026, 9, 1, tzinfo=UTC)
    rejected_at = datetime(2026, 10, 28, 11, tzinfo=UTC)
    async with session_factory() as session:
        product = Product(category="Composite", code="REJECTED", name="Hose")
        customer = Customer(code="REJECTED", name="Rejected work customer")
        asset = Asset(
            customer=customer,
            product=product,
            asset_number="REJECTED-ACTIVITY",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            created_at=old_asset_time,
            updated_at=old_asset_time,
        )
        session.add(
            Inspection(
                asset=asset,
                inspection_type=InspectionType.SERVICE.value,
                status=InspectionStatus.REJECTED.value,
                created_at=old_asset_time,
                updated_at=rejected_at,
                rejected_at=rejected_at,
            )
        )
        await session.commit()

    async with api_client(session_factory, principal(Role.SUPER_ADMIN)) as client:
        response = await client.get("/api/v1/work/me")

    assert response.status_code == 200
    rejected_item = next(
        item
        for item in response.json()["items"]
        if item["asset_number"] == "REJECTED-ACTIVITY"
    )
    assert rejected_item["next_action"]["code"] == "REWORK_INSPECTION"
    assert rejected_item["updated_at"].startswith("2026-10-28T11:00:00")


@pytest.mark.asyncio
async def test_my_work_limits_an_inspector_to_their_confirmed_assignment(
    session_factory: async_sessionmaker[AsyncSession], work_world: dict[str, str]
) -> None:
    async with session_factory() as session:
        booking = InspectionBooking(
            customer_id=work_world["mine"],
            location_id="location-1",
            scheduled_at=datetime(2026, 10, 5, tzinfo=UTC),
            status=InspectionBookingStatus.APPROVED.value,
            requested_by_user_id="customer-user",
            inspector_user_id="inspector-record-1",
        )
        booking.assets.append(InspectionBookingAsset(asset_id=work_world["due_mine"]))
        booking.appointment = InspectionAppointment(
            customer_id=work_world["mine"],
            location_id="location-1",
            status=InspectionAppointmentStatus.CONFIRMED.value,
        )
        session.add(
            Inspection(
                asset_id=work_world["due_mine"],
                booking=booking,
                inspection_type=InspectionType.SERVICE.value,
                status=InspectionStatus.DRAFT.value,
            )
        )
        await session.commit()

    inspector = Principal(
        user_id="inspector-subject-1",
        record_user_id="inspector-record-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, inspector) as client:
        body = (await client.get("/api/v1/work/me")).json()

    visible_actions = [
        (item["asset_id"], item["next_action"]["code"]) for item in body["items"]
    ]
    assert visible_actions == [(work_world["due_mine"], "CONTINUE_INSPECTION")]
