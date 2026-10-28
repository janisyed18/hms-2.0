"""My Work aggregation against the migrated PostgreSQL schema."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.work.service import get_my_work

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL)
    try:
        async with engine.connect() as connection:
            assert await connection.scalar(text("SELECT 1")) == 1
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_my_work_returns_a_review_action_from_the_migrated_postgres_schema(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:10]
    async with session_factory() as session:
        product = Product(category="Composite", code=f"P{tag}", name="Hose")
        customer = Customer(code=f"C{tag}", name="Postgres customer")
        asset = Asset(
            # The PostgreSQL follow-up shares a migrated database with earlier suites.
            # Keep this fixture inside the bounded projection's deterministic scan.
            id=f"00000000-0000-0000-0000-00{tag}",
            customer=customer,
            product=product,
            asset_number=f"A{tag}",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        inspection = Inspection(
            asset=asset,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    async with session_factory() as session:
        result = await get_my_work(
            session,
            Principal(
                user_id=f"reviewer-{tag}",
                roles=frozenset({Role.REVIEWER}),
                customer_ids=frozenset(),
            ),
            limit=10,
        )

    seeded_items = [
        item for item in result.items if item.inspection_id == inspection_id
    ]
    assert [(item.state, item.next_action.code) for item in seeded_items] == [
        ("AWAITING_REVIEW", "REVIEW_INSPECTION")
    ]
