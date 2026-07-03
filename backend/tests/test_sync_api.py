from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date

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
from hms_backend.app.modules.inspections.models import Inspection, PressureTestResult
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
async def test_sync_push_applies_inspection_create_idempotently_and_reports_conflict(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_sync_session: dict[str, str],
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
