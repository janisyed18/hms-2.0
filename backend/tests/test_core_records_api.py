from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent, SyncChange
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
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
async def seeded_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[dict[str, str]]:
    async with session_factory() as session:
        standard = Standard(code="AS2683", name="AS2683")
        hidden_standard = Standard(code="DISABLED", name="Disabled", enabled=False)
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
        vopak = Customer(code="VOPA", name="Vopak")
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
            [
                standard,
                hidden_standard,
                product,
                other_product,
                vopak_asset,
                orica_asset,
                schedule,
            ]
        )
        await session.commit()

        yield {
            "vopak_id": vopak.id,
            "orica_id": orica.id,
            "product_id": product.id,
            "other_product_id": other_product.id,
            "vopak_location_id": location.id,
            "vopak_asset_id": vopak_asset.id,
            "orica_asset_id": orica_asset.id,
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


@pytest.mark.asyncio
async def test_reference_standards_endpoint_returns_enabled_standards_only(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get("/api/v1/reference/standards")

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "id": response.json()["items"][0]["id"],
                "code": "AS2683",
                "name": "AS2683",
            }
        ]
    }


@pytest.mark.asyncio
async def test_products_endpoint_filters_by_category_and_search(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get(
            "/api/v1/products",
            params={"category": "Composite", "search": "fuel"},
        )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["code"] == "1000GY"
    assert response.json()["items"][0]["standard_code"] == "AS2683"


@pytest.mark.asyncio
async def test_assets_endpoint_searches_and_scopes_customer_user(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        list_response = await client.get("/api/v1/assets", params={"search": "997"})
        hidden_detail_response = await client.get(
            f"/api/v1/assets/{seeded_session['orica_asset_id']}"
        )

    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["asset_number"] == "997950"
    assert hidden_detail_response.status_code == 404


@pytest.mark.asyncio
async def test_asset_detail_includes_customer_product_location_and_retest_status(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}"
        )

    assert response.status_code == 200
    body = response.json()
    assert body["asset_number"] == "997950"
    assert body["customer"]["code"] == "VOPA"
    assert body["product"]["code"] == "1000GY"
    assert body["location"]["name"] == "Site A"
    assert body["retest_schedule"]["status"] == "OVERDUE"


@pytest.mark.asyncio
async def test_customer_user_cannot_create_reference_standard(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/reference/standards",
            json={"code": "ISO10380", "name": "ISO 10380", "enabled": True},
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_reference_standard_writes_sync_change_and_audit_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/reference/standards",
            json={"code": "ISO10380", "name": "ISO 10380", "enabled": True},
        )

    assert response.status_code == 201
    assert response.json()["code"] == "ISO10380"

    async with session_factory() as session:
        standard = (
            await session.scalars(select(Standard).where(Standard.code == "ISO10380"))
        ).one()
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert standard.version == 1
        assert sync_change.entity == "Standard"
        assert sync_change.entity_id == standard.id
        assert sync_change.op == "create"
        assert sync_change.version == 1
        assert audit_event.actor_id == "admin-1"
        assert audit_event.action == "standard.created"
        assert audit_event.entity == "Standard"
        assert audit_event.entity_id == standard.id
        assert audit_event.before is None
        assert audit_event.after is not None
        assert audit_event.after["code"] == "ISO10380"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_update_reference_standard_writes_sync_change_and_audit_event(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with session_factory() as session:
        standard_id = (
            await session.scalars(select(Standard.id).where(Standard.code == "AS2683"))
        ).one()

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/reference/standards/{standard_id}",
            json={"name": "AS 2683:2020", "enabled": False},
        )

    assert response.status_code == 200
    assert response.json()["name"] == "AS 2683:2020"

    async with session_factory() as session:
        standard = await session.get(Standard, standard_id)
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert standard is not None
        assert standard.version == 2
        assert standard.enabled is False
        assert sync_change.entity == "Standard"
        assert sync_change.op == "update"
        assert sync_change.version == 2
        assert audit_event.action == "standard.updated"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "AS2683"
        assert audit_event.after is not None
        assert audit_event.after["name"] == "AS 2683:2020"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_create_product_links_standard_and_writes_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    async with session_factory() as session:
        standard_id = (
            await session.scalars(select(Standard.id).where(Standard.code == "AS2683"))
        ).one()

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/products",
            json={
                "category": "Rubber",
                "sub_category": "Water",
                "code": "RUB-WATER",
                "name": "Rubber Water Hose",
                "standard_id": standard_id,
                "enabled": True,
            },
        )

    assert response.status_code == 201
    assert response.json()["code"] == "RUB-WATER"
    assert response.json()["standard_code"] == "AS2683"

    async with session_factory() as session:
        product = (
            await session.scalars(select(Product).where(Product.code == "RUB-WATER"))
        ).one()
        sync_change = (
            await session.scalars(
                select(SyncChange).where(SyncChange.entity == "Product")
            )
        ).one()
        audit_event = (
            await session.scalars(
                select(AuditEvent).where(AuditEvent.entity == "Product")
            )
        ).one()

        assert product.standard_id == standard_id
        assert sync_change.op == "create"
        assert sync_change.entity_id == product.id
        assert audit_event.action == "product.created"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_update_product_writes_sync_change_and_audit_event(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    async with session_factory() as session:
        product_id = (
            await session.scalars(select(Product.id).where(Product.code == "1000GY"))
        ).one()

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/products/{product_id}",
            json={"name": "FUELFLEX GREEN UPDATED", "enabled": False},
        )

    assert response.status_code == 200
    assert response.json()["name"] == "FUELFLEX GREEN UPDATED"

    async with session_factory() as session:
        product = await session.get(Product, product_id)
        sync_change = (
            await session.scalars(
                select(SyncChange).where(SyncChange.entity == "Product")
            )
        ).one()
        audit_event = (
            await session.scalars(
                select(AuditEvent).where(AuditEvent.entity == "Product")
            )
        ).one()

        assert product is not None
        assert product.version == 2
        assert product.enabled is False
        assert sync_change.op == "update"
        assert sync_change.version == 2
        assert audit_event.action == "product.updated"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "FUELFLEX GREEN"
        assert audit_event.after is not None
        assert audit_event.after["name"] == "FUELFLEX GREEN UPDATED"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_customer_user_cannot_create_asset(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/assets",
            json={
                "customer_id": seeded_session["vopak_id"],
                "product_id": seeded_session["product_id"],
                "asset_number": "NEW-100",
                "lifecycle_status": "IN_SERVICE",
            },
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_asset_with_retest_schedule_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/assets",
            json={
                "customer_id": seeded_session["vopak_id"],
                "location_id": seeded_session["vopak_location_id"],
                "product_id": seeded_session["product_id"],
                "asset_number": "NEW-100",
                "customer_serial_no": "SER-100",
                "tag": "HMS-NEW-100",
                "lifecycle_status": "DUE",
                "manufacture_date": "2026-01-15",
                "next_retest_due_at": "2026-07-15",
                "length_m": "6.100",
                "retest_schedule": {
                    "due_at": "2026-07-15",
                    "status": "DUE",
                    "reminder_interval_days": 30,
                    "escalation_interval_days": 7,
                },
            },
        )

    assert response.status_code == 201
    body = response.json()
    assert body["asset_number"] == "NEW-100"
    assert body["customer"]["code"] == "VOPA"
    assert body["location"]["name"] == "Site A"
    assert body["retest_schedule"]["status"] == "DUE"

    async with session_factory() as session:
        asset = (
            await session.scalars(select(Asset).where(Asset.asset_number == "NEW-100"))
        ).one()
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert asset.version == 1
        assert asset.customer_id == seeded_session["vopak_id"]
        assert [change.entity for change in sync_changes] == ["Asset", "RetestSchedule"]
        assert [change.op for change in sync_changes] == ["create", "create"]
        assert [event.action for event in audit_events] == [
            "asset.created",
            "retest_schedule.created",
        ]
        assert audit_events[0].after is not None
        assert audit_events[0].after["asset_number"] == "NEW-100"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_create_asset_rejects_location_from_another_customer(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/assets",
            json={
                "customer_id": seeded_session["orica_id"],
                "location_id": seeded_session["vopak_location_id"],
                "product_id": seeded_session["product_id"],
                "asset_number": "BAD-LOCATION",
                "lifecycle_status": "IN_SERVICE",
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Location does not belong to customer"


@pytest.mark.asyncio
async def test_update_asset_and_retest_schedule_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}",
            json={
                "lifecycle_status": "IN_SERVICE",
                "next_retest_due_at": "2027-01-15",
                "retest_schedule": {
                    "due_at": "2027-01-15",
                    "status": "UPCOMING",
                    "reminder_interval_days": 45,
                    "escalation_interval_days": 10,
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["lifecycle_status"] == "IN_SERVICE"
    assert body["retest_schedule"]["status"] == "UPCOMING"

    async with session_factory() as session:
        asset = await session.get(Asset, seeded_session["vopak_asset_id"])
        schedule = (
            await session.scalars(
                select(RetestSchedule).where(
                    RetestSchedule.asset_id == seeded_session["vopak_asset_id"]
                )
            )
        ).one()
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert asset is not None
        assert asset.version == 2
        assert asset.lifecycle_status == "IN_SERVICE"
        assert schedule.version == 2
        assert schedule.status == "UPCOMING"
        assert [change.entity for change in sync_changes] == ["Asset", "RetestSchedule"]
        assert [change.op for change in sync_changes] == ["update", "update"]
        assert [event.action for event in audit_events] == [
            "asset.updated",
            "retest_schedule.updated",
        ]
        assert audit_events[0].before is not None
        assert audit_events[0].before["lifecycle_status"] == "OVERDUE"
        assert audit_events[0].after is not None
        assert audit_events[0].after["lifecycle_status"] == "IN_SERVICE"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_customer_user_cannot_create_inspection(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}/inspections",
            json={"inspection_type": "SERVICE", "result": "PASS"},
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_service_inspection_with_pressure_test_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}/inspections",
            json={
                "inspection_type": "SERVICE",
                "result": "PASS",
                "pressure_test": {
                    "applied_pressure_kpa": 1500,
                    "hold_time_seconds": 300,
                    "passed": True,
                    "measurements": {"leak": "none"},
                },
            },
        )

    assert response.status_code == 201
    body = response.json()
    assert body["asset_id"] == seeded_session["vopak_asset_id"]
    assert body["inspection_type"] == "SERVICE"
    assert body["status"] == "DRAFT"
    assert body["result"] == "PASS"
    assert body["pressure_test"]["passed"] is True
    assert body["pressure_test"]["measurements"] == {"leak": "none"}

    async with session_factory() as session:
        inspection = (
            await session.scalars(
                select(Inspection).where(
                    Inspection.asset_id == seeded_session["vopak_asset_id"]
                )
            )
        ).one()
        pressure_test = (
            await session.scalars(
                select(PressureTestResult).where(
                    PressureTestResult.inspection_id == inspection.id
                )
            )
        ).one()
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert inspection.version == 1
        assert inspection.status == InspectionStatus.DRAFT.value
        assert inspection.inspector_user_id == "inspector-1"
        assert pressure_test.applied_pressure_kpa == 1500
        assert [change.entity for change in sync_changes] == [
            "Inspection",
            "PressureTestResult",
        ]
        assert [change.op for change in sync_changes] == ["create", "create"]
        assert [event.action for event in audit_events] == [
            "inspection.created",
            "pressure_test_result.created",
        ]
        assert audit_events[0].after is not None
        assert audit_events[0].after["status"] == InspectionStatus.DRAFT.value
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_submit_and_approve_inspection_transitions_with_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.DRAFT.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    inspector = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, inspector) as client:
        submit_response = await client.post(
            f"/api/v1/inspections/{inspection_id}/submit"
        )

    assert submit_response.status_code == 200
    assert submit_response.json()["status"] == InspectionStatus.SUBMITTED.value
    assert submit_response.json()["submitted_at"] is not None

    reviewer = Principal(
        user_id="reviewer-1",
        roles=frozenset({Role.REVIEWER}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, reviewer) as client:
        approve_response = await client.post(
            f"/api/v1/inspections/{inspection_id}/approve"
        )

    assert approve_response.status_code == 200
    assert approve_response.json()["status"] == InspectionStatus.APPROVED.value
    assert approve_response.json()["reviewer_user_id"] == "reviewer-1"
    assert approve_response.json()["approved_at"] is not None

    async with session_factory() as session:
        loaded_inspection = await session.get(Inspection, inspection_id)
        sync_changes = (
            await session.scalars(
                select(SyncChange)
                .where(SyncChange.entity == "Inspection")
                .order_by(SyncChange.seq)
            )
        ).all()
        audit_events = (
            await session.scalars(
                select(AuditEvent)
                .where(AuditEvent.entity == "Inspection")
                .order_by(AuditEvent.sequence)
            )
        ).all()

        assert loaded_inspection is not None
        assert loaded_inspection.version == 3
        assert loaded_inspection.status == InspectionStatus.APPROVED.value
        assert loaded_inspection.reviewer_user_id == "reviewer-1"
        assert [change.op for change in sync_changes] == ["update", "update"]
        assert [event.action for event in audit_events] == [
            "inspection.submitted",
            "inspection.approved",
        ]
        assert audit_events[0].before is not None
        assert audit_events[0].before["status"] == InspectionStatus.DRAFT.value
        assert audit_events[0].after is not None
        assert audit_events[0].after["status"] == InspectionStatus.SUBMITTED.value
        assert audit_events[1].after is not None
        assert audit_events[1].after["status"] == InspectionStatus.APPROVED.value
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_certificate_cannot_be_issued_before_inspection_approval(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="reviewer-1",
        roles=frozenset({Role.REVIEWER}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate",
            json={
                "number": "CERT-997950-1",
                "pdf_object_key": "certificates/CERT-997950-1.pdf",
                "verification_hash": "hash-997950-1",
                "public_token": "public-token-997950-1",
                "valid_until": "2027-06-28",
            },
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_issue_certificate_from_approved_inspection_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.APPROVED.value,
            result="PASS",
            inspector_user_id="inspector-1",
            reviewer_user_id="reviewer-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="reviewer-1",
        roles=frozenset({Role.REVIEWER}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate",
            json={
                "number": "CERT-997950-1",
                "pdf_object_key": "certificates/CERT-997950-1.pdf",
                "verification_hash": "hash-997950-1",
                "public_token": "public-token-997950-1",
                "valid_until": "2027-06-28",
            },
        )

    assert response.status_code == 201
    body = response.json()
    assert body["inspection_id"] == inspection_id
    assert body["asset_id"] == seeded_session["vopak_asset_id"]
    assert body["number"] == "CERT-997950-1"
    assert body["certificate_version"] == 1
    assert body["status"] == "ISSUED"
    assert body["valid_until"] == "2027-06-28"

    async with session_factory() as session:
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.inspection_id == inspection_id)
            )
        ).one()
        sync_change = (
            await session.scalars(
                select(SyncChange).where(SyncChange.entity == "Certificate")
            )
        ).one()
        audit_event = (
            await session.scalars(
                select(AuditEvent).where(AuditEvent.entity == "Certificate")
            )
        ).one()

        assert certificate.version == 1
        assert certificate.status == "ISSUED"
        assert certificate.issued_by_user_id == "reviewer-1"
        assert sync_change.op == "create"
        assert sync_change.entity_id == certificate.id
        assert audit_event.action == "certificate.issued"
        assert audit_event.after is not None
        assert audit_event.after["number"] == "CERT-997950-1"
        assert await verify_audit_chain(session)
