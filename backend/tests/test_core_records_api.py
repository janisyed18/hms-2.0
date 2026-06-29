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
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
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
        contact = CustomerContact(
            customer=vopak,
            name="Retest Coordinator",
            email="retest@example.com",
            phone="+61 2 5555 0100",
            role="Maintenance",
            receives_retest_reminders=True,
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
                contact,
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
            "vopak_contact_id": contact.id,
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
async def test_reference_standards_endpoint_supports_allow_listed_sorting(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    async with session_factory() as session:
        session.add(Standard(code="ISO10380", name="ISO 10380"))
        await session.commit()

    async with api_client(session_factory, principal) as client:
        ascending_response = await client.get(
            "/api/v1/reference/standards",
            params={"sort": "code"},
        )
        descending_response = await client.get(
            "/api/v1/reference/standards",
            params={"sort": "-code"},
        )
        rejected_response = await client.get(
            "/api/v1/reference/standards",
            params={"sort": "deleted_at"},
        )

    assert ascending_response.status_code == 200
    assert [item["code"] for item in ascending_response.json()["items"]] == [
        "AS2683",
        "ISO10380",
    ]
    assert descending_response.status_code == 200
    assert [item["code"] for item in descending_response.json()["items"]] == [
        "ISO10380",
        "AS2683",
    ]
    assert rejected_response.status_code == 400
    assert rejected_response.json()["detail"] == "Unsupported sort field: deleted_at"


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
async def test_products_and_assets_support_allow_listed_sorting(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        product_ascending_response = await client.get(
            "/api/v1/products",
            params={"sort": "code"},
        )
        product_descending_response = await client.get(
            "/api/v1/products",
            params={"sort": "-code"},
        )
        product_rejected_response = await client.get(
            "/api/v1/products",
            params={"sort": "deleted_at"},
        )
        asset_ascending_response = await client.get(
            "/api/v1/assets",
            params={"sort": "asset_number"},
        )
        asset_descending_response = await client.get(
            "/api/v1/assets",
            params={"sort": "-asset_number"},
        )
        asset_rejected_response = await client.get(
            "/api/v1/assets",
            params={"sort": "customer_id"},
        )

    assert product_ascending_response.status_code == 200
    assert [item["code"] for item in product_ascending_response.json()["items"]] == [
        "1000GY",
        "SS1",
    ]
    assert product_descending_response.status_code == 200
    assert [item["code"] for item in product_descending_response.json()["items"]] == [
        "SS1",
        "1000GY",
    ]
    assert product_rejected_response.status_code == 400
    assert (
        product_rejected_response.json()["detail"]
        == "Unsupported sort field: deleted_at"
    )

    assert asset_ascending_response.status_code == 200
    assert [
        item["asset_number"] for item in asset_ascending_response.json()["items"]
    ] == ["997950", "ORIC-100"]
    assert asset_descending_response.status_code == 200
    assert [
        item["asset_number"] for item in asset_descending_response.json()["items"]
    ] == ["ORIC-100", "997950"]
    assert asset_rejected_response.status_code == 400
    assert asset_rejected_response.json()["detail"] == (
        "Unsupported sort field: customer_id"
    )


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
async def test_customers_endpoint_scopes_customer_user(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        list_response = await client.get("/api/v1/customers")
        visible_detail_response = await client.get(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )
        hidden_detail_response = await client.get(
            f"/api/v1/customers/{seeded_session['orica_id']}"
        )

    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["code"] == "VOPA"
    assert visible_detail_response.status_code == 200
    assert visible_detail_response.json()["locations"][0]["name"] == "Site A"
    assert visible_detail_response.json()["contacts"][0]["name"] == "Retest Coordinator"
    assert hidden_detail_response.status_code == 404


@pytest.mark.asyncio
async def test_customers_endpoint_supports_allow_listed_sorting(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        ascending_response = await client.get(
            "/api/v1/customers",
            params={"sort": "name"},
        )
        descending_response = await client.get(
            "/api/v1/customers",
            params={"sort": "-name"},
        )
        rejected_response = await client.get(
            "/api/v1/customers",
            params={"sort": "deleted_at"},
        )

    assert ascending_response.status_code == 200
    assert [item["name"] for item in ascending_response.json()["items"]] == [
        "Orica",
        "Vopak",
    ]
    assert descending_response.status_code == 200
    assert [item["name"] for item in descending_response.json()["items"]] == [
        "Vopak",
        "Orica",
    ]
    assert rejected_response.status_code == 400
    assert rejected_response.json()["detail"] == "Unsupported sort field: deleted_at"


@pytest.mark.asyncio
async def test_customer_user_cannot_create_customer(
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
            "/api/v1/customers",
            json={"code": "NEWC", "name": "New Customer"},
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_customer_writes_sync_change_and_audit_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.post(
            "/api/v1/customers",
            json={
                "code": " acme ",
                "name": " ACME Mining ",
                "retest_enabled": True,
                "default_retest_months": 6,
            },
        )

    assert response.status_code == 201
    body = response.json()
    assert body["code"] == "ACME"
    assert body["name"] == "ACME Mining"
    assert body["retest_enabled"] is True
    assert body["default_retest_months"] == 6
    assert body["locations"] == []
    assert body["contacts"] == []

    async with session_factory() as session:
        customer = (
            await session.scalars(select(Customer).where(Customer.code == "ACME"))
        ).one()
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert customer.version == 1
        assert customer.name == "ACME Mining"
        assert sync_change.entity == "Customer"
        assert sync_change.entity_id == customer.id
        assert sync_change.op == "create"
        assert sync_change.version == 1
        assert audit_event.actor_id == "admin-1"
        assert audit_event.action == "customer.created"
        assert audit_event.entity == "Customer"
        assert audit_event.entity_id == customer.id
        assert audit_event.before is None
        assert audit_event.after is not None
        assert audit_event.after["code"] == "ACME"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_update_customer_writes_sync_change_and_audit_event(
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
            f"/api/v1/customers/{seeded_session['vopak_id']}",
            json={
                "name": "Vopak Updated",
                "retest_enabled": True,
                "default_retest_months": 12,
            },
        )

    assert response.status_code == 200
    assert response.json()["name"] == "Vopak Updated"
    assert response.json()["retest_enabled"] is True
    assert response.json()["default_retest_months"] == 12

    async with session_factory() as session:
        customer = await session.get(Customer, seeded_session["vopak_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert customer is not None
        assert customer.version == 2
        assert customer.name == "Vopak Updated"
        assert sync_change.entity == "Customer"
        assert sync_change.op == "update"
        assert sync_change.version == 2
        assert audit_event.action == "customer.updated"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "Vopak"
        assert audit_event.after is not None
        assert audit_event.after["name"] == "Vopak Updated"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_customer_detail_returns_etag_and_patch_enforces_if_match(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        detail_response = await client.get(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )
        stale_response = await client.patch(
            f"/api/v1/customers/{seeded_session['vopak_id']}",
            headers={"If-Match": '"0"'},
            json={"name": "Stale Name"},
        )
        update_response = await client.patch(
            f"/api/v1/customers/{seeded_session['vopak_id']}",
            headers={"If-Match": '"1"'},
            json={"name": "Vopak Matched"},
        )

    assert detail_response.status_code == 200
    assert detail_response.headers.get("etag") == '"1"'
    assert stale_response.status_code == 412
    assert stale_response.json()["detail"] == "Resource version does not match"
    assert update_response.status_code == 200
    assert update_response.headers["etag"] == '"2"'
    assert update_response.json()["name"] == "Vopak Matched"

    async with session_factory() as session:
        customer = await session.get(Customer, seeded_session["vopak_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert customer is not None
        assert customer.version == 2
        assert customer.name == "Vopak Matched"
        assert sync_change.op == "update"
        assert sync_change.version == 2
        assert audit_event.action == "customer.updated"
        assert audit_event.after is not None
        assert audit_event.after["name"] == "Vopak Matched"


@pytest.mark.asyncio
async def test_soft_delete_customer_writes_tombstone_sync_and_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        delete_response = await client.delete(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )
        list_response = await client.get("/api/v1/customers")

    assert delete_response.status_code == 204
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert {item["code"] for item in list_response.json()["items"]} == {"ORIC"}

    async with session_factory() as session:
        customer = await session.get(Customer, seeded_session["vopak_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert customer is not None
        assert customer.deleted_at is not None
        assert customer.version == 2
        assert sync_change.entity == "Customer"
        assert sync_change.entity_id == customer.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "customer.deleted"
        assert audit_event.entity == "Customer"
        assert audit_event.entity_id == customer.id
        assert audit_event.before is not None
        assert audit_event.before["name"] == "Vopak"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_customer_user_cannot_delete_customer(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.delete(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_and_update_customer_location_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        create_response = await client.post(
            f"/api/v1/customers/{seeded_session['vopak_id']}/locations",
            json={
                "name": "Newcastle Depot",
                "address_1": "1 Wharf Road",
                "city": "Newcastle",
                "state": "NSW",
                "country": "AU",
            },
        )
        assert create_response.status_code == 201
        location_id = create_response.json()["id"]
        update_response = await client.patch(
            f"/api/v1/customers/{seeded_session['vopak_id']}/locations/{location_id}",
            json={"city": "Carrington", "address_2": "Gate 3"},
        )

    assert create_response.json()["name"] == "Newcastle Depot"
    assert update_response.status_code == 200
    assert update_response.json()["city"] == "Carrington"
    assert update_response.json()["address_2"] == "Gate 3"

    async with session_factory() as session:
        location = await session.get(CustomerLocation, location_id)
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert location is not None
        assert location.version == 2
        assert location.customer_id == seeded_session["vopak_id"]
        assert [change.entity for change in sync_changes] == [
            "CustomerLocation",
            "CustomerLocation",
        ]
        assert [change.op for change in sync_changes] == ["create", "update"]
        assert [event.action for event in audit_events] == [
            "customer_location.created",
            "customer_location.updated",
        ]
        assert audit_events[1].before is not None
        assert audit_events[1].before["city"] == "Newcastle"
        assert audit_events[1].after is not None
        assert audit_events[1].after["city"] == "Carrington"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_soft_delete_customer_location_writes_tombstone_sync_and_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        delete_response = await client.delete(
            "/api/v1/customers/"
            f"{seeded_session['vopak_id']}/locations/"
            f"{seeded_session['vopak_location_id']}"
        )
        customer_response = await client.get(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )

    assert delete_response.status_code == 204
    assert customer_response.status_code == 200
    assert customer_response.json()["locations"] == []

    async with session_factory() as session:
        location = await session.get(
            CustomerLocation,
            seeded_session["vopak_location_id"],
        )
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert location is not None
        assert location.deleted_at is not None
        assert location.version == 2
        assert sync_change.entity == "CustomerLocation"
        assert sync_change.entity_id == location.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "customer_location.deleted"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "Site A"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_create_and_update_customer_contact_writes_audit_and_sync(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        create_response = await client.post(
            f"/api/v1/customers/{seeded_session['vopak_id']}/contacts",
            json={
                "name": "Jane Manager",
                "email": " jane.manager@example.com ",
                "phone": "+61 2 5555 0200",
                "role": "Maintenance Manager",
                "receives_retest_reminders": True,
            },
        )
        assert create_response.status_code == 201
        contact_id = create_response.json()["id"]
        update_response = await client.patch(
            f"/api/v1/customers/{seeded_session['vopak_id']}/contacts/{contact_id}",
            json={"role": "Operations Manager", "receives_retest_reminders": False},
        )

    assert create_response.json()["email"] == "jane.manager@example.com"
    assert update_response.status_code == 200
    assert update_response.json()["role"] == "Operations Manager"
    assert update_response.json()["receives_retest_reminders"] is False

    async with session_factory() as session:
        contact = await session.get(CustomerContact, contact_id)
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert contact is not None
        assert contact.version == 2
        assert contact.customer_id == seeded_session["vopak_id"]
        assert [change.entity for change in sync_changes] == [
            "CustomerContact",
            "CustomerContact",
        ]
        assert [change.op for change in sync_changes] == ["create", "update"]
        assert [event.action for event in audit_events] == [
            "customer_contact.created",
            "customer_contact.updated",
        ]
        assert audit_events[1].before is not None
        assert audit_events[1].before["role"] == "Maintenance Manager"
        assert audit_events[1].after is not None
        assert audit_events[1].after["role"] == "Operations Manager"
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_soft_delete_customer_contact_writes_tombstone_sync_and_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        delete_response = await client.delete(
            "/api/v1/customers/"
            f"{seeded_session['vopak_id']}/contacts/"
            f"{seeded_session['vopak_contact_id']}"
        )
        customer_response = await client.get(
            f"/api/v1/customers/{seeded_session['vopak_id']}"
        )

    assert delete_response.status_code == 204
    assert customer_response.status_code == 200
    assert customer_response.json()["contacts"] == []

    async with session_factory() as session:
        contact = await session.get(CustomerContact, seeded_session["vopak_contact_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert contact is not None
        assert contact.deleted_at is not None
        assert contact.version == 2
        assert sync_change.entity == "CustomerContact"
        assert sync_change.entity_id == contact.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "customer_contact.deleted"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "Retest Coordinator"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
        assert await verify_audit_chain(session)


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
async def test_soft_delete_reference_standard_writes_tombstone_sync_and_audit(
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
        delete_response = await client.delete(
            f"/api/v1/reference/standards/{standard_id}"
        )
        list_response = await client.get("/api/v1/reference/standards")

    assert delete_response.status_code == 204
    assert list_response.status_code == 200
    assert list_response.json()["items"] == []

    async with session_factory() as session:
        standard = await session.get(Standard, standard_id)
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert standard is not None
        assert standard.deleted_at is not None
        assert standard.version == 2
        assert sync_change.entity == "Standard"
        assert sync_change.entity_id == standard.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "standard.deleted"
        assert audit_event.before is not None
        assert audit_event.before["code"] == "AS2683"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
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
async def test_soft_delete_product_writes_tombstone_sync_and_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        delete_response = await client.delete(
            f"/api/v1/products/{seeded_session['product_id']}"
        )
        list_response = await client.get("/api/v1/products")

    assert delete_response.status_code == 204
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert {item["code"] for item in list_response.json()["items"]} == {"SS1"}

    async with session_factory() as session:
        product = await session.get(Product, seeded_session["product_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert product is not None
        assert product.deleted_at is not None
        assert product.version == 2
        assert sync_change.entity == "Product"
        assert sync_change.entity_id == product.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "product.deleted"
        assert audit_event.before is not None
        assert audit_event.before["name"] == "FUELFLEX GREEN"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
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
async def test_soft_delete_asset_writes_tombstone_sync_and_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        delete_response = await client.delete(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}"
        )
        list_response = await client.get("/api/v1/assets")

    assert delete_response.status_code == 204
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert {item["asset_number"] for item in list_response.json()["items"]} == {
        "ORIC-100"
    }

    async with session_factory() as session:
        asset = await session.get(Asset, seeded_session["vopak_asset_id"])
        sync_change = (await session.scalars(select(SyncChange))).one()
        audit_event = (await session.scalars(select(AuditEvent))).one()

        assert asset is not None
        assert asset.deleted_at is not None
        assert asset.version == 2
        assert sync_change.entity == "Asset"
        assert sync_change.entity_id == asset.id
        assert sync_change.op == "delete"
        assert sync_change.version == 2
        assert audit_event.action == "asset.deleted"
        assert audit_event.before is not None
        assert audit_event.before["asset_number"] == "997950"
        assert audit_event.after is not None
        assert audit_event.after["deleted_at"] is not None
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_standard_product_and_asset_mutations_enforce_if_match(
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
        asset_detail_response = await client.get(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}"
        )
        stale_standard_response = await client.patch(
            f"/api/v1/reference/standards/{standard_id}",
            headers={"If-Match": '"0"'},
            json={"name": "Stale Standard"},
        )
        standard_response = await client.patch(
            f"/api/v1/reference/standards/{standard_id}",
            headers={"If-Match": '"1"'},
            json={"name": "AS 2683 Matched"},
        )
        stale_product_response = await client.patch(
            f"/api/v1/products/{seeded_session['product_id']}",
            headers={"If-Match": '"0"'},
            json={"name": "Stale Product"},
        )
        product_response = await client.patch(
            f"/api/v1/products/{seeded_session['product_id']}",
            headers={"If-Match": '"1"'},
            json={"name": "FUELFLEX MATCHED"},
        )
        stale_asset_response = await client.patch(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}",
            headers={"If-Match": '"0"'},
            json={"lifecycle_status": "IN_SERVICE"},
        )
        asset_response = await client.patch(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}",
            headers={"If-Match": '"1"'},
            json={"lifecycle_status": "IN_SERVICE"},
        )

    assert asset_detail_response.status_code == 200
    assert asset_detail_response.headers.get("etag") == '"1"'
    assert stale_standard_response.status_code == 412
    assert standard_response.status_code == 200
    assert standard_response.headers.get("etag") == '"2"'
    assert stale_product_response.status_code == 412
    assert product_response.status_code == 200
    assert product_response.headers.get("etag") == '"2"'
    assert stale_asset_response.status_code == 412
    assert asset_response.status_code == 200
    assert asset_response.headers.get("etag") == '"2"'


@pytest.mark.asyncio
async def test_delete_routes_enforce_if_match_when_supplied(
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
        standard_response = await client.delete(
            f"/api/v1/reference/standards/{standard_id}",
            headers={"If-Match": '"0"'},
        )
        customer_response = await client.delete(
            f"/api/v1/customers/{seeded_session['vopak_id']}",
            headers={"If-Match": '"0"'},
        )
        product_response = await client.delete(
            f"/api/v1/products/{seeded_session['product_id']}",
            headers={"If-Match": '"0"'},
        )
        asset_response = await client.delete(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}",
            headers={"If-Match": '"0"'},
        )

    assert standard_response.status_code == 412
    assert customer_response.status_code == 412
    assert product_response.status_code == 412
    assert asset_response.status_code == 412

    async with session_factory() as session:
        sync_changes = (await session.scalars(select(SyncChange))).all()
        audit_events = (await session.scalars(select(AuditEvent))).all()

        assert sync_changes == []
        assert audit_events == []


@pytest.mark.asyncio
async def test_customer_user_cannot_delete_core_records(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )
    async with session_factory() as session:
        standard_id = (
            await session.scalars(select(Standard.id).where(Standard.code == "AS2683"))
        ).one()

    async with api_client(session_factory, principal) as client:
        standard_response = await client.delete(
            f"/api/v1/reference/standards/{standard_id}"
        )
        product_response = await client.delete(
            f"/api/v1/products/{seeded_session['product_id']}"
        )
        asset_response = await client.delete(
            f"/api/v1/assets/{seeded_session['vopak_asset_id']}"
        )

    assert standard_response.status_code == 403
    assert product_response.status_code == 403
    assert asset_response.status_code == 403


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
async def test_inspections_endpoint_lists_with_asset_customer_product_context(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        draft = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.DRAFT.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        submitted = Inspection(
            asset_id=seeded_session["orica_asset_id"],
            inspection_type=InspectionType.NEW_ASSET.value,
            status=InspectionStatus.SUBMITTED.value,
            result="REVIEW",
            inspector_user_id="inspector-2",
        )
        session.add_all([draft, submitted])
        await session.commit()

    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get(
            "/api/v1/inspections",
            params={"sort": "created_at"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["items"][0]["asset"]["asset_number"] == "997950"
    assert body["items"][0]["customer"]["code"] == "VOPA"
    assert body["items"][0]["product"]["code"] == "1000GY"
    assert body["items"][1]["asset"]["asset_number"] == "ORIC-100"
    assert body["items"][1]["status"] == InspectionStatus.SUBMITTED.value


@pytest.mark.asyncio
async def test_inspections_endpoint_filters_and_returns_detail(
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
        await session.flush()
        pressure_test = PressureTestResult(
            inspection=inspection,
            applied_pressure_kpa=1500,
            hold_time_seconds=300,
            passed=True,
            measurements={"leak": "none"},
        )
        session.add(pressure_test)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        list_response = await client.get(
            "/api/v1/inspections",
            params={
                "status": "SUBMITTED",
                "inspection_type": "SERVICE",
                "customer_id": seeded_session["vopak_id"],
                "search": "997",
            },
        )
        detail_response = await client.get(f"/api/v1/inspections/{inspection_id}")

    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["id"] == inspection_id
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["id"] == inspection_id
    assert detail["asset"]["asset_number"] == "997950"
    assert detail["pressure_test"]["applied_pressure_kpa"] == 1500
    assert detail["pressure_test"]["measurements"] == {"leak": "none"}


@pytest.mark.asyncio
async def test_patch_draft_inspection_updates_result_and_pressure_test_with_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.DRAFT.value,
            result="REVIEW",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={
                "result": "PASS",
                "pressure_test": {
                    "applied_pressure_kpa": 1750,
                    "hold_time_seconds": 360,
                    "passed": True,
                    "measurements": {"leak": "none", "visual": "ok"},
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["result"] == "PASS"
    assert body["pressure_test"]["applied_pressure_kpa"] == 1750
    assert body["pressure_test"]["measurements"]["visual"] == "ok"

    async with session_factory() as session:
        loaded = await session.get(Inspection, inspection_id)
        pressure_test = (
            await session.scalars(
                select(PressureTestResult).where(
                    PressureTestResult.inspection_id == inspection_id
                )
            )
        ).one()
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert loaded is not None
        assert loaded.version == 2
        assert pressure_test.version == 1
        assert [change.entity for change in sync_changes] == [
            "Inspection",
            "PressureTestResult",
        ]
        assert [event.action for event in audit_events] == [
            "inspection.updated",
            "pressure_test_result.created",
        ]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_patch_inspection_rejects_non_draft_status(
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
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={"result": "FAIL"},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Only draft inspections can be edited"


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
