"""The customer list reports each customer's true assigned-asset count.

The Customers screen used to count assets in the browser from the first 100 assets of
the whole system, so a customer whose assets fell outside that page showed 0 while the
customer detail (which asks for that customer's own assets) showed the real number.
The count now comes from the API, in one grouped query, with the same definition of
"assigned asset" the asset list uses: not deleted, any lifecycle status, within the
caller's visibility.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

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

ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def api_as(
    factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def _seed(factory: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    """TH-like customer (2 assets, 2 sites), one with 1, one with 0, and a big one."""
    async with factory() as session:
        product = Product(category="Hydraulic", code="P1", name="Hose")
        th = Customer(code="TH", name="TH Industries")
        single = Customer(code="ONE", name="Single Asset Ltd")
        empty = Customer(code="NONE", name="No Assets Ltd")
        bulk = Customer(code="BULK", name="Bulk Co")
        harris = CustomerLocation(customer=th, name="Harris Park")
        preston = CustomerLocation(customer=th, name="Preston")
        session.add_all([product, th, single, empty, bulk, harris, preston])
        await session.flush()
        # The bulk customer's 120 assets are created FIRST and TH's last, so a count
        # taken from the first 100 assets in the system never sees TH's.
        for n in range(120):
            session.add(
                Asset(
                    customer_id=bulk.id,
                    product_id=product.id,
                    asset_number=f"A-BULK-{n:03d}",
                    lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                )
            )
        await session.flush()
        session.add_all(
            [
                Asset(
                    customer_id=th.id,
                    location_id=preston.id,
                    product_id=product.id,
                    asset_number="Z-TH-1",
                    lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                ),
                Asset(
                    customer_id=th.id,
                    location_id=preston.id,
                    product_id=product.id,
                    asset_number="Z-TH-2",
                    lifecycle_status=AssetLifecycleStatus.RETIRED.value,
                ),
                Asset(
                    customer_id=single.id,
                    product_id=product.id,
                    asset_number="Z-ONE-1",
                    lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                ),
                Asset(  # soft-deleted: not an assigned asset
                    customer_id=single.id,
                    product_id=product.id,
                    asset_number="Z-ONE-DELETED",
                    lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                    deleted_at=datetime.now(UTC),
                ),
            ]
        )
        await session.commit()
        return {"th": th.id, "single": single.id, "empty": empty.id, "bulk": bulk.id}


def _by_code(items: list[dict[str, object]]) -> dict[str, dict[str, int]]:
    return {str(item["code"]): item["metrics"] for item in items}  # type: ignore[misc]


@pytest.mark.asyncio
async def test_each_customer_reports_its_own_count_beyond_the_first_100_assets(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed(session_factory)
    async with api_as(session_factory, ADMIN) as client:
        response = await client.get("/api/v1/customers", params={"limit": 100})
    assert response.status_code == 200, response.text
    metrics = _by_code(response.json()["items"])

    assert metrics["TH"]["asset_count"] == 2  # was 0 on the card
    assert metrics["ONE"]["asset_count"] == 1  # the deleted asset is not counted
    assert metrics["NONE"]["asset_count"] == 0
    assert metrics["BULK"]["asset_count"] == 120


@pytest.mark.asyncio
async def test_retired_assets_stay_assigned_and_in_service_is_counted_separately(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed(session_factory)
    async with api_as(session_factory, ADMIN) as client:
        metrics = _by_code(
            (await client.get("/api/v1/customers", params={"limit": 100})).json()[
                "items"
            ]
        )
    # The asset list (and so the customer detail) does not filter by lifecycle, so a
    # retired asset is still assigned to the customer; only "in service" excludes it.
    assert metrics["TH"] == {"asset_count": 2, "in_service_count": 1}
    assert metrics["ONE"] == {"asset_count": 1, "in_service_count": 1}
    assert metrics["NONE"] == {"asset_count": 0, "in_service_count": 0}


@pytest.mark.asyncio
async def test_the_card_count_agrees_with_the_detail_and_the_asset_list(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ids = await _seed(session_factory)
    async with api_as(session_factory, ADMIN) as client:
        listed = _by_code(
            (await client.get("/api/v1/customers", params={"limit": 100})).json()[
                "items"
            ]
        )
        for code, customer_id in (("TH", ids["th"]), ("BULK", ids["bulk"])):
            detail = (await client.get(f"/api/v1/customers/{customer_id}")).json()
            asset_total = (
                await client.get(
                    "/api/v1/assets", params={"customer_id": customer_id, "limit": 1}
                )
            ).json()["total"]
            assert detail["metrics"] == listed[code]
            assert detail["metrics"]["asset_count"] == asset_total


@pytest.mark.asyncio
async def test_search_and_paging_do_not_change_a_customers_count(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed(session_factory)
    async with api_as(session_factory, ADMIN) as client:
        searched = (
            await client.get("/api/v1/customers", params={"search": "th industries"})
        ).json()
        first_page = (
            await client.get("/api/v1/customers", params={"limit": 1, "sort": "code"})
        ).json()
        last_page = (
            await client.get(
                "/api/v1/customers", params={"limit": 1, "offset": 3, "sort": "code"}
            )
        ).json()
    assert [i["code"] for i in searched["items"]] == ["TH"]
    assert searched["items"][0]["metrics"]["asset_count"] == 2
    assert first_page["items"][0]["code"] == "BULK"
    assert first_page["items"][0]["metrics"]["asset_count"] == 120
    assert last_page["items"][0]["code"] == "TH"
    assert last_page["items"][0]["metrics"]["asset_count"] == 2


@pytest.mark.asyncio
async def test_a_scoped_user_only_counts_what_they_can_see(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ids = await _seed(session_factory)
    customer_user = Principal(
        user_id="cu-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({ids["th"]}),
    )
    async with api_as(session_factory, customer_user) as client:
        items = (await client.get("/api/v1/customers")).json()["items"]
    assert [i["code"] for i in items] == ["TH"]
    assert items[0]["metrics"]["asset_count"] == 2


@pytest.mark.asyncio
async def test_a_new_customer_starts_at_zero(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with api_as(session_factory, ADMIN) as client:
        created = await client.post(
            "/api/v1/customers", json={"name": "Fresh Customer Pty Ltd"}
        )
    assert created.status_code == 201, created.text
    assert created.json()["metrics"] == {"asset_count": 0, "in_service_count": 0}
