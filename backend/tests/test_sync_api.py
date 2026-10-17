from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import (
    AuditEvent,
    Device,
    IdempotencyKey,
    SyncChange,
)
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentRevision,
    InspectionBooking,
    InspectionBookingAsset,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
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
async def seeded_sync_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[dict[str, str]]:
    async with session_factory() as session:
        standard = Standard(code="AS2683", name="AS2683")
        product = Product(
            category="Composite",
            sub_category="Petrol & Oil",
            code="1000GY",
            name="FUELFLEX GREEN",
            standard=standard,
        )
        other_product = Product(
            category="Stainless Steel",
            sub_category="Convoluted",
            code="SS1",
            name="SS1 CONV",
            standard=standard,
        )
        vopak = Customer(code="VOPA", name="Vopak", retest_enabled=True)
        orica = Customer(code="ORIC", name="Orica")
        location = CustomerLocation(
            customer=vopak,
            name="Site A",
            city="Port Botany",
            state="NSW",
            country="AU",
        )
        vopak_asset = Asset(
            customer=vopak,
            location=location,
            product=product,
            asset_number="997950",
            customer_serial_no="VOPA-SN-1",
            tag="HMS-997950",
            lifecycle_status=AssetLifecycleStatus.OVERDUE.value,
            manufacture_date=date(2023, 5, 2),
            next_retest_due_at=date(2023, 11, 2),
        )
        orica_asset = Asset(
            customer=orica,
            product=other_product,
            asset_number="ORIC-100",
            customer_serial_no="ORIC-SN-1",
            tag="HMS-ORIC-100",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        schedule = RetestSchedule(
            customer=vopak,
            asset=vopak_asset,
            due_at=date(2023, 11, 2),
            status=RetestScheduleStatus.OVERDUE.value,
            reminder_interval_days=30,
            escalation_interval_days=7,
        )
        session.add_all(
            [standard, product, other_product, vopak_asset, orica_asset, schedule]
        )
        await session.commit()

        yield {
            "vopak_id": vopak.id,
            "orica_id": orica.id,
            "vopak_asset_id": vopak_asset.id,
            "orica_asset_id": orica_asset.id,
            "product_id": product.id,
            "standard_id": standard.id,
        }


@asynccontextmanager
async def api_client(
    session_factory: async_sessionmaker[AsyncSession],
    principal: Principal,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        yield client


def sync_headers(device_id: str = "field-tablet-01") -> dict[str, str]:
    return {
        "X-HMS-Device-Id": device_id,
        "X-HMS-Device-Platform": "ios",
        "X-HMS-App-Version": "0.1.0",
    }


@pytest_asyncio.fixture
async def assigned_inspector_booking(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
) -> str:
    async with session_factory() as session:
        asset = await session.get(Asset, seeded_sync_session["vopak_asset_id"])
        assert asset is not None and asset.location_id is not None
        booking = InspectionBooking(
            customer_id=asset.customer_id,
            location_id=asset.location_id,
            scheduled_at=datetime(2026, 10, 20, tzinfo=UTC),
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id="inspector-1",
        )
        session.add(booking)
        await session.flush()
        appointment = InspectionAppointment(
            booking_id=booking.id,
            customer_id=asset.customer_id,
            location_id=asset.location_id,
            status="CONFIRMED",
        )
        session.add_all(
            [
                InspectionBookingAsset(booking_id=booking.id, asset_id=asset.id),
                appointment,
            ]
        )
        await session.flush()
        session.add(
            InspectionAppointmentRevision(
                appointment_id=appointment.id,
                revision_number=1,
                starts_at=datetime(2026, 10, 20, tzinfo=UTC),
                ends_at=datetime(2026, 10, 20, 1, tzinfo=UTC),
                timezone_id="UTC",
                local_start_snapshot="2026-10-20T00:00:00",
                local_end_snapshot="2026-10-20T01:00:00",
                utc_offset_start="+00:00",
                utc_offset_end="+00:00",
                tzdata_version="test",
                inspector_user_id="inspector-1",
                created_by_user_id="admin",
            )
        )
        await session.commit()
        return booking.id


@pytest.mark.asyncio
async def test_unassigned_inspector_cannot_read_or_update_asset_via_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="unassigned-inspector",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    asset_id = seeded_sync_session["vopak_asset_id"]
    async with api_client(session_factory, principal) as client:
        bootstrap = await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        assets = await client.get("/api/v1/assets")
        push = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "unassigned-update",
                        "idempotency_key": "unassigned-update",
                        "entity": "Asset",
                        "entity_id": asset_id,
                        "op": "update",
                        "base_version": 1,
                        "payload": {"tag": "unauthorised"},
                    }
                ]
            },
        )
    assert bootstrap.status_code == 200
    assert not any(
        record["entity"] == "Asset" for record in bootstrap.json()["records"]
    )
    assert assets.status_code == 200
    assert assets.json()["items"] == []
    assert push.status_code == 200
    assert push.json()["results"][0]["status"] == "rejected"


@pytest.mark.asyncio
async def test_inspector_assignments_isolate_reads_writes_and_reassignment(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        location = CustomerLocation(
            customer_id=seeded_sync_session["orica_id"], name="Site B"
        )
        session.add(location)
        await session.flush()
        vopak = await session.get(Asset, seeded_sync_session["vopak_asset_id"])
        assert vopak is not None and vopak.location_id is not None
        bookings = []
        for owner, customer, location_id, asset in [
            (
                "inspector-a",
                seeded_sync_session["vopak_id"],
                vopak.location_id,
                seeded_sync_session["vopak_asset_id"],
            ),
            (
                "inspector-b",
                seeded_sync_session["orica_id"],
                location.id,
                seeded_sync_session["orica_asset_id"],
            ),
        ]:
            booking = InspectionBooking(
                customer_id=customer,
                location_id=location_id,
                scheduled_at=datetime(2026, 10, 20, tzinfo=UTC),
                status="APPROVED",
                requested_by_user_id="customer",
                inspector_user_id=owner,
            )
            session.add(booking)
            await session.flush()
            appointment = InspectionAppointment(
                booking_id=booking.id,
                customer_id=customer,
                location_id=location_id,
                status="CONFIRMED",
            )
            session.add_all(
                [
                    InspectionBookingAsset(booking_id=booking.id, asset_id=asset),
                    appointment,
                ]
            )
            await session.flush()
            session.add(
                InspectionAppointmentRevision(
                    appointment_id=appointment.id,
                    revision_number=1,
                    starts_at=datetime(2026, 10, 20, tzinfo=UTC),
                    ends_at=datetime(2026, 10, 20, 1, tzinfo=UTC),
                    timezone_id="UTC",
                    local_start_snapshot="2026-10-20T00:00:00",
                    local_end_snapshot="2026-10-20T01:00:00",
                    utc_offset_start="+00:00",
                    utc_offset_end="+00:00",
                    tzdata_version="test",
                    inspector_user_id=owner,
                    created_by_user_id="admin",
                )
            )
            bookings.append(booking.id)
        historical_inspection = Inspection(
            asset_id=seeded_sync_session["vopak_asset_id"],
            inspector_user_id="inspector-b",
            inspection_type="SERVICE",
            status="DRAFT",
        )
        session.add(historical_inspection)
        await session.commit()
        historical_inspection_id = historical_inspection.id

    inspector_a = Principal(
        user_id="inspector-a",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    inspector_b = Principal(
        user_id="inspector-b",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    operation = {
        "operations": [
            {
                "op_id": "a-update",
                "idempotency_key": "a-update",
                "entity": "Asset",
                "entity_id": seeded_sync_session["vopak_asset_id"],
                "op": "update",
                "base_version": 1,
                "payload": {"tag": "assigned"},
            }
        ]
    }
    async with api_client(session_factory, inspector_a) as client:
        a_bootstrap = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()
        a_records = a_bootstrap["records"]
        context = a_bootstrap["work_contexts"][0]
        operation["operations"][0]["work_context"] = context
        a_bookings = (await client.get("/api/v1/inspection-bookings")).json()["items"]
        asset_read = await client.get(
            f"/api/v1/assets/{seeded_sync_session['vopak_asset_id']}"
        )
        other_inspection = await client.get(
            f"/api/v1/inspections/{historical_inspection_id}"
        )
        first = await client.post(
            "/api/v1/sync/push", headers=sync_headers(), json=operation
        )
        reused_key = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "different-operation",
                        "idempotency_key": "a-update",
                        "entity": "Inspection",
                        "entity_id": "new-inspection",
                        "op": "create",
                        "work_context": context,
                        "payload": {"asset_id": seeded_sync_session["vopak_asset_id"]},
                    }
                ]
            },
        )
    async with api_client(session_factory, inspector_b) as client:
        b_records = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["records"]
        denied = await client.post(
            "/api/v1/sync/push", headers=sync_headers(), json=operation
        )
    assert {r["entity_id"] for r in a_records if r["entity"] == "Asset"} == {
        seeded_sync_session["vopak_asset_id"]
    }
    assert {r["entity_id"] for r in b_records if r["entity"] == "Asset"} == {
        seeded_sync_session["orica_asset_id"]
    }
    assert {booking["id"] for booking in a_bookings} == {bookings[0]}
    assert asset_read.json()["inspection_history"] == []
    assert other_inspection.status_code == 404
    assert not any(r["entity_id"] == historical_inspection_id for r in a_records)
    assert first.json()["results"][0]["status"] == "applied"
    assert reused_key.json()["results"][0]["status"] == "rejected"
    assert denied.json()["results"][0]["status"] == "rejected"

    async with session_factory() as session:
        reassigned_booking = await session.get(InspectionBooking, bookings[0])
        assert reassigned_booking is not None
        reassigned_booking.inspector_user_id = "inspector-b"
        await session.commit()
    async with api_client(session_factory, inspector_a) as client:
        after = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["records"]
        after_bookings = (await client.get("/api/v1/inspection-bookings")).json()[
            "items"
        ]
        retry = await client.post(
            "/api/v1/sync/push", headers=sync_headers(), json=operation
        )
    assert not any(r["entity"] == "Asset" for r in after)
    assert after_bookings == []
    assert retry.json()["results"][0]["status"] == "rejected"


@pytest.mark.asyncio
async def test_sync_bootstrap_registers_device_and_returns_scoped_records(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_sync_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get("/api/v1/sync/bootstrap", headers=sync_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["device"] == {
        "device_id": "field-tablet-01",
        "platform": "ios",
        "app_version": "0.1.0",
        "offline_window_days": 7,
        "revoked": False,
    }
    assert body["cursor"] == 0
    assert body["has_more"] is False

    records = body["records"]
    customers = [item for item in records if item["entity"] == "Customer"]
    assets = [item for item in records if item["entity"] == "Asset"]
    standards = [item for item in records if item["entity"] == "Standard"]
    products = [item for item in records if item["entity"] == "Product"]

    assert [item["payload"]["code"] for item in customers] == ["VOPA"]
    assert [item["payload"]["asset_number"] for item in assets] == ["997950"]
    assert standards[0]["payload"]["code"] == "AS2683"
    assert {item["payload"]["code"] for item in products} == {"1000GY", "SS1"}

    async with session_factory() as session:
        device = await session.get(Device, "field-tablet-01")
        assert device is not None
        assert device.user_id == "customer-user-1"
        assert device.last_sync_at is not None


@pytest.mark.asyncio
async def test_sync_changes_returns_monotonic_upserts_and_tombstones(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="assembly-1",
        roles=frozenset({Role.ASSEMBLY}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        update_response = await client.patch(
            f"/api/v1/assets/{seeded_sync_session['vopak_asset_id']}",
            json={"lifecycle_status": AssetLifecycleStatus.DUE.value},
        )
        delete_response = await client.delete(
            f"/api/v1/assets/{seeded_sync_session['orica_asset_id']}"
        )
        changes_response = await client.get(
            "/api/v1/sync/changes",
            params={"since": 0},
            headers=sync_headers(),
        )

    assert update_response.status_code == 200
    assert delete_response.status_code == 204
    assert changes_response.status_code == 200

    body = changes_response.json()
    assert body["cursor"] == 2
    assert body["has_more"] is False
    assert [item["seq"] for item in body["changes"]] == [1, 2]
    assert body["changes"][0]["op"] == "upsert"
    assert body["changes"][0]["entity"] == "Asset"
    assert body["changes"][0]["payload"]["asset_number"] == "997950"
    assert body["changes"][0]["payload"]["lifecycle_status"] == "DUE"
    assert body["changes"][1]["op"] == "delete"
    assert body["changes"][1]["entity_id"] == seeded_sync_session["orica_asset_id"]
    assert body["changes"][1]["payload"] is None


@pytest.mark.asyncio
async def test_sync_draft_requires_exact_appointment_revision_and_idempotency(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, principal) as client:
        bootstrap = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()
        context = bootstrap["work_contexts"][0]
        assert context["asset_id"] == seeded_sync_session["vopak_asset_id"]
        operation = {
            "op_id": "draft-one",
            "idempotency_key": "draft-one",
            "entity": "Inspection",
            "entity_id": "test-bound-draft",
            "op": "create",
            "work_context": context,
            "payload": {"asset_id": context["asset_id"], "inspection_type": "SERVICE"},
        }
        first = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={"operations": [operation]},
        )
        retry = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={"operations": [operation]},
        )
        changed = {**operation, "payload": {**operation["payload"], "notes": "changed"}}
        reused = await client.post(
            "/api/v1/sync/push", headers=sync_headers(), json={"operations": [changed]}
        )
    assert first.json()["results"][0]["status"] == "applied"
    assert retry.json()["results"][0]["status"] == "applied"
    assert reused.json()["results"][0]["status"] == "rejected"
    assert reused.json()["results"][0]["error_code"] == "IDEMPOTENCY_KEY_REUSED"


@pytest.mark.asyncio
async def test_idempotency_key_cannot_be_reused_for_another_appointment(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    async with session_factory() as session:
        first = await session.get(InspectionBooking, assigned_inspector_booking)
        assert first is not None
        second = InspectionBooking(
            customer_id=first.customer_id,
            location_id=first.location_id,
            scheduled_at=datetime(2026, 10, 22, tzinfo=UTC),
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id="inspector-1",
        )
        session.add(second)
        await session.flush()
        appointment = InspectionAppointment(
            booking_id=second.id,
            customer_id=second.customer_id,
            location_id=second.location_id,
            status="CONFIRMED",
        )
        session.add_all(
            [
                appointment,
                InspectionBookingAsset(
                    booking_id=second.id, asset_id=seeded_sync_session["vopak_asset_id"]
                ),
            ]
        )
        await session.flush()
        session.add(
            InspectionAppointmentRevision(
                appointment_id=appointment.id,
                revision_number=1,
                starts_at=datetime(2026, 10, 22, tzinfo=UTC),
                ends_at=datetime(2026, 10, 22, 1, tzinfo=UTC),
                timezone_id="UTC",
                local_start_snapshot="2026-10-22T00:00:00",
                local_end_snapshot="2026-10-22T01:00:00",
                utc_offset_start="+00:00",
                utc_offset_end="+00:00",
                tzdata_version="test",
                inspector_user_id="inspector-1",
                created_by_user_id="admin",
            )
        )
        await session.commit()
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, principal) as client:
        contexts = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"]
        assert len(contexts) == 2
        operation = {
            "op_id": "one",
            "idempotency_key": "same-key",
            "entity": "Asset",
            "entity_id": seeded_sync_session["vopak_asset_id"],
            "op": "update",
            "base_version": 1,
            "payload": {"tag": "same"},
            "work_context": contexts[0],
        }
        first_result = (
            await client.post(
                "/api/v1/sync/push",
                headers=sync_headers(),
                json={"operations": [operation]},
            )
        ).json()["results"][0]
        second_result = (
            await client.post(
                "/api/v1/sync/push",
                headers=sync_headers(),
                json={"operations": [{**operation, "work_context": contexts[1]}]},
            )
        ).json()["results"][0]
    assert first_result["status"] == "applied"
    assert second_result["status"] == "rejected"
    assert second_result["error_code"] == "IDEMPOTENCY_KEY_REUSED"


@pytest.mark.asyncio
async def test_old_work_cannot_follow_reassignment_or_later_appointment(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    inspector_a = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    inspector_b = Principal(
        user_id="inspector-2",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, inspector_a) as client:
        original = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"][0]
    operation = {
        "op_id": "old-draft",
        "idempotency_key": "old-draft",
        "entity": "Inspection",
        "entity_id": "018f0000-0000-7000-8000-000000000077",
        "op": "create",
        "work_context": original,
        "payload": {"asset_id": original["asset_id"], "inspection_type": "SERVICE"},
    }
    async with session_factory() as session:
        booking = await session.get(InspectionBooking, assigned_inspector_booking)
        appointment = await session.get(
            InspectionAppointment, original["appointment_id"]
        )
        assert booking is not None and appointment is not None
        previous_inspection = Inspection(
            asset_id=original["asset_id"],
            booking_id=booking.id,
            inspector_user_id="inspector-1",
            inspection_type="SERVICE",
            status="SUBMITTED",
        )
        session.add(previous_inspection)
        booking.inspector_user_id = "inspector-2"
        appointment.current_revision_number = 2
        session.add(
            InspectionAppointmentRevision(
                appointment_id=appointment.id,
                revision_number=2,
                starts_at=datetime(2026, 10, 21, tzinfo=UTC),
                ends_at=datetime(2026, 10, 21, 1, tzinfo=UTC),
                timezone_id="UTC",
                local_start_snapshot="2026-10-21T00:00:00",
                local_end_snapshot="2026-10-21T01:00:00",
                utc_offset_start="+00:00",
                utc_offset_end="+00:00",
                tzdata_version="test",
                inspector_user_id="inspector-2",
                created_by_user_id="admin",
            )
        )
        later = InspectionBooking(
            customer_id=booking.customer_id,
            location_id=booking.location_id,
            scheduled_at=datetime(2026, 10, 22, tzinfo=UTC),
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id="inspector-1",
        )
        session.add(later)
        await session.flush()
        next_appointment = InspectionAppointment(
            booking_id=later.id,
            customer_id=later.customer_id,
            location_id=later.location_id,
            status="CONFIRMED",
        )
        session.add_all(
            [
                next_appointment,
                InspectionBookingAsset(
                    booking_id=later.id, asset_id=original["asset_id"]
                ),
            ]
        )
        await session.flush()
        session.add(
            InspectionAppointmentRevision(
                appointment_id=next_appointment.id,
                revision_number=1,
                starts_at=datetime(2026, 10, 22, tzinfo=UTC),
                ends_at=datetime(2026, 10, 22, 1, tzinfo=UTC),
                timezone_id="UTC",
                local_start_snapshot="2026-10-22T00:00:00",
                local_end_snapshot="2026-10-22T01:00:00",
                utc_offset_start="+00:00",
                utc_offset_end="+00:00",
                tzdata_version="test",
                inspector_user_id="inspector-1",
                created_by_user_id="admin",
            )
        )
        await session.commit()
        previous_inspection_id = previous_inspection.id
    async with api_client(session_factory, inspector_a) as client:
        contexts_a = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"]
        denied = (
            await client.post(
                "/api/v1/sync/push",
                headers=sync_headers(),
                json={"operations": [operation]},
            )
        ).json()["results"][0]
        old_inspection = await client.get(
            f"/api/v1/inspections/{previous_inspection_id}"
        )
    async with api_client(session_factory, inspector_b) as client:
        contexts_b = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"]
        reassigned_inspection = await client.get(
            f"/api/v1/inspections/{previous_inspection_id}"
        )
    assert {item["appointment_id"] for item in contexts_a} == {next_appointment.id}
    assert {item["appointment_id"] for item in contexts_b} == {
        original["appointment_id"]
    }
    assert denied["status"] == "rejected"
    assert denied["error_code"] == "WORK_CONTEXT_STALE"
    assert old_inspection.status_code == 404
    assert reassigned_inspection.status_code == 200


@pytest.mark.asyncio
async def test_inspector_cannot_create_draft_for_stale_assignment(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "stale-assignment",
                        "idempotency_key": "stale-assignment",
                        "entity": "Inspection",
                        "entity_id": "018f0000-0000-7000-8000-000000000099",
                        "op": "create",
                        "payload": {
                            "asset_id": seeded_sync_session["vopak_asset_id"],
                            "booking_id": "old-reassigned-booking",
                            "inspection_type": "SERVICE",
                        },
                    }
                ]
            },
        )
    assert response.json()["results"][0]["status"] == "rejected"


@pytest.mark.asyncio
async def test_sync_push_applies_inspection_create_idempotently_and_reports_conflict(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    inspection_id = "018f0000-0000-7000-8000-000000000001"
    create_payload = {
        "operations": [
            {
                "op_id": "op-create-inspection",
                "idempotency_key": "idem-create-inspection",
                "entity": "Inspection",
                "entity_id": inspection_id,
                "op": "create",
                "base_version": None,
                "payload": {
                    "asset_id": seeded_sync_session["vopak_asset_id"],
                    "inspection_type": "SERVICE",
                    "result": "REVIEW",
                    "pressure_test": {
                        "applied_pressure_kpa": 1750,
                        "hold_time_seconds": 360,
                        "passed": True,
                        "measurements": {"leak": "none"},
                    },
                },
            }
        ]
    }
    stale_update_payload = {
        "operations": [
            {
                "op_id": "op-stale-update",
                "idempotency_key": "idem-stale-update",
                "entity": "Inspection",
                "entity_id": inspection_id,
                "op": "update",
                "base_version": 0,
                "payload": {"result": "PASS"},
            }
        ]
    }

    async with api_client(session_factory, principal) as client:
        context = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"][0]
        create_payload["operations"][0]["work_context"] = context
        stale_update_payload["operations"][0]["work_context"] = context
        create_response = await client.post(
            "/api/v1/sync/push",
            json=create_payload,
            headers=sync_headers(),
        )
        replay_response = await client.post(
            "/api/v1/sync/push",
            json=create_payload,
            headers=sync_headers(),
        )
        conflict_response = await client.post(
            "/api/v1/sync/push",
            json=stale_update_payload,
            headers=sync_headers(),
        )

    assert create_response.status_code == 200
    create_result = create_response.json()["results"][0]
    assert create_result["status"] == "applied"
    assert create_result["entity"] == "Inspection"
    assert create_result["entity_id"] == inspection_id
    assert create_result["version"] == 1
    assert create_result["payload"]["result"] == "REVIEW"

    assert replay_response.status_code == 200
    assert replay_response.json()["results"] == [create_result]

    assert conflict_response.status_code == 200
    conflict_result = conflict_response.json()["results"][0]
    assert conflict_result["status"] == "conflict"
    assert conflict_result["current_version"] == 1
    assert conflict_result["payload"]["status"] == "DRAFT"

    async with session_factory() as session:
        inspection_count = await session.scalar(
            select(func.count()).select_from(Inspection)
        )
        pressure_count = await session.scalar(
            select(func.count()).select_from(PressureTestResult)
        )
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()
        idempotency_count = await session.scalar(
            select(func.count()).select_from(IdempotencyKey)
        )

        assert inspection_count == 1
        assert pressure_count == 1
        assert [(change.entity, change.op) for change in sync_changes] == [
            ("Inspection", "create"),
            ("PressureTestResult", "create"),
        ]
        assert [event.action for event in audit_events] == [
            "inspection.created",
            "pressure_test_result.created",
        ]
        assert idempotency_count == 2


@pytest.mark.asyncio
async def test_sync_push_updates_asset_safe_fields_idempotently_and_reports_conflict(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    update_payload = {
        "operations": [
            {
                "op_id": "op-update-asset",
                "idempotency_key": "idem-update-asset",
                "entity": "Asset",
                "entity_id": seeded_sync_session["vopak_asset_id"],
                "op": "update",
                "base_version": 1,
                "payload": {
                    "customer_serial_no": "FIELD-SN-997950",
                    "tag": "FIELD-TAG-997950",
                },
            }
        ]
    }
    stale_update_payload = {
        "operations": [
            {
                "op_id": "op-stale-asset",
                "idempotency_key": "idem-stale-asset",
                "entity": "Asset",
                "entity_id": seeded_sync_session["vopak_asset_id"],
                "op": "update",
                "base_version": 1,
                "payload": {"tag": "STALE-TAG"},
            }
        ]
    }
    unsafe_update_payload = {
        "operations": [
            {
                "op_id": "op-unsafe-asset",
                "idempotency_key": "idem-unsafe-asset",
                "entity": "Asset",
                "entity_id": seeded_sync_session["vopak_asset_id"],
                "op": "update",
                "base_version": 2,
                "payload": {"product_id": seeded_sync_session["product_id"]},
            }
        ]
    }

    async with api_client(session_factory, principal) as client:
        context = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"][0]
        for payload in (update_payload, stale_update_payload, unsafe_update_payload):
            payload["operations"][0]["work_context"] = context
        update_response = await client.post(
            "/api/v1/sync/push",
            json=update_payload,
            headers=sync_headers(),
        )
        replay_response = await client.post(
            "/api/v1/sync/push",
            json=update_payload,
            headers=sync_headers(),
        )
        conflict_response = await client.post(
            "/api/v1/sync/push",
            json=stale_update_payload,
            headers=sync_headers(),
        )
        unsafe_response = await client.post(
            "/api/v1/sync/push",
            json=unsafe_update_payload,
            headers=sync_headers(),
        )

    assert update_response.status_code == 200
    update_result = update_response.json()["results"][0]
    assert update_result["status"] == "applied"
    assert update_result["entity"] == "Asset"
    assert update_result["version"] == 2
    assert update_result["payload"]["customer_serial_no"] == "FIELD-SN-997950"
    assert update_result["payload"]["tag"] == "FIELD-TAG-997950"

    assert replay_response.status_code == 200
    assert replay_response.json()["results"] == [update_result]

    assert conflict_response.status_code == 200
    conflict_result = conflict_response.json()["results"][0]
    assert conflict_result["status"] == "conflict"
    assert conflict_result["current_version"] == 2
    assert conflict_result["payload"]["tag"] == "FIELD-TAG-997950"

    assert unsafe_response.status_code == 200
    unsafe_result = unsafe_response.json()["results"][0]
    assert unsafe_result["status"] == "rejected"
    assert "Unsupported Asset sync field" in unsafe_result["error"]

    async with session_factory() as session:
        asset = await session.get(Asset, seeded_sync_session["vopak_asset_id"])
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

    assert asset is not None
    assert asset.customer_serial_no == "FIELD-SN-997950"
    assert asset.tag == "FIELD-TAG-997950"
    assert [(change.entity, change.op) for change in sync_changes] == [
        ("Asset", "update"),
    ]
    assert [event.action for event in audit_events] == ["asset.updated"]


@pytest.mark.asyncio
async def test_sync_push_creates_and_updates_pressure_test_result_as_child_record(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
    assigned_inspector_booking: str,
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    inspection_id = "018f0000-0000-7000-8000-000000000002"
    pressure_test_id = "018f0000-0000-7000-8000-000000000003"

    async with session_factory() as session:
        inspection = Inspection(
            id=inspection_id,
            asset_id=seeded_sync_session["vopak_asset_id"],
            booking_id=assigned_inspector_booking,
            inspection_type="SERVICE",
            status="DRAFT",
            result="REVIEW",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()

    create_payload = {
        "operations": [
            {
                "op_id": "op-create-pressure-test",
                "idempotency_key": "idem-create-pressure-test",
                "entity": "PressureTestResult",
                "entity_id": pressure_test_id,
                "op": "create",
                "base_version": None,
                "payload": {
                    "inspection_id": inspection_id,
                    "applied_pressure_kpa": 1750,
                    "hold_time_seconds": 360,
                    "passed": True,
                    "measurements": {"leak": "none"},
                },
            }
        ]
    }
    update_payload = {
        "operations": [
            {
                "op_id": "op-update-pressure-test",
                "idempotency_key": "idem-update-pressure-test",
                "entity": "PressureTestResult",
                "entity_id": pressure_test_id,
                "op": "update",
                "base_version": 1,
                "payload": {
                    "applied_pressure_kpa": 1800,
                    "hold_time_seconds": 420,
                    "passed": False,
                    "measurements": {"leak": "minor"},
                },
            }
        ]
    }
    stale_update_payload = {
        "operations": [
            {
                "op_id": "op-stale-pressure-test",
                "idempotency_key": "idem-stale-pressure-test",
                "entity": "PressureTestResult",
                "entity_id": pressure_test_id,
                "op": "update",
                "base_version": 1,
                "payload": {"applied_pressure_kpa": 1850},
            }
        ]
    }

    async with api_client(session_factory, principal) as client:
        context = (
            await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        ).json()["work_contexts"][0]
        for payload in (create_payload, update_payload, stale_update_payload):
            payload["operations"][0]["work_context"] = context
        create_response = await client.post(
            "/api/v1/sync/push",
            json=create_payload,
            headers=sync_headers(),
        )
        update_response = await client.post(
            "/api/v1/sync/push",
            json=update_payload,
            headers=sync_headers(),
        )
        conflict_response = await client.post(
            "/api/v1/sync/push",
            json=stale_update_payload,
            headers=sync_headers(),
        )

    assert create_response.status_code == 200
    create_result = create_response.json()["results"][0]
    assert create_result["status"] == "applied"
    assert create_result["entity"] == "PressureTestResult"
    assert create_result["version"] == 1
    assert create_result["payload"]["applied_pressure_kpa"] == 1750

    assert update_response.status_code == 200
    update_result = update_response.json()["results"][0]
    assert update_result["status"] == "applied"
    assert update_result["version"] == 2
    assert update_result["payload"]["passed"] is False
    assert update_result["payload"]["measurements"] == {"leak": "minor"}

    assert conflict_response.status_code == 200
    conflict_result = conflict_response.json()["results"][0]
    assert conflict_result["status"] == "conflict"
    assert conflict_result["current_version"] == 2
    assert conflict_result["payload"]["applied_pressure_kpa"] == 1800

    async with session_factory() as session:
        pressure_test = await session.get(PressureTestResult, pressure_test_id)
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

    assert pressure_test is not None
    assert pressure_test.applied_pressure_kpa == 1800
    assert pressure_test.version == 2
    assert [(change.entity, change.op) for change in sync_changes] == [
        ("PressureTestResult", "create"),
        ("PressureTestResult", "update"),
    ]
    assert [event.action for event in audit_events] == [
        "pressure_test_result.created",
        "pressure_test_result.updated",
    ]
