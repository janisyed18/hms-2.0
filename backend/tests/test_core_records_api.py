from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
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
