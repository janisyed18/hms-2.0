import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.inspections.models import Inspection, PressureTestResult
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import RetestSchedule
from hms_backend.app.tooling.local_seed import seed_local_demo_data


async def _count(session: AsyncSession, model: type[object]) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


@pytest.mark.asyncio
async def test_seed_local_demo_data_creates_idempotent_core_records() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        first_summary = await seed_local_demo_data(session)
        await seed_local_demo_data(session)

        assert first_summary == {
            "standards": 2,
            "customers": 3,
            "customer_locations": 3,
            "customer_contacts": 3,
            "products": 2,
            "assets": 2,
            "retest_schedules": 2,
            "inspections": 3,
            "pressure_test_results": 2,
        }
        assert await _count(session, Standard) == 2
        assert await _count(session, Customer) == 3
        assert await _count(session, CustomerLocation) == 3
        assert await _count(session, CustomerContact) == 3
        assert await _count(session, Product) == 2
        assert await _count(session, Asset) == 2
        assert await _count(session, RetestSchedule) == 2
        assert await _count(session, Inspection) == 3
        assert await _count(session, PressureTestResult) == 2

    await engine.dispose()
