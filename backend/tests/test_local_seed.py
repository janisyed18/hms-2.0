import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.inspections.models import Inspection, PressureTestResult
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import (
    AttachMethod,
    Coupling,
    CouplingAddOn,
    Material,
    NominalBore,
    Standard,
)
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
            "certificates": 1,
            "users": 3,
        }
        assert await _count(session, Standard) == 2
        assert await _count(session, Customer) == 3
        assert await _count(session, CustomerLocation) == 3
        assert await _count(session, CustomerContact) == 3
        assert await _count(session, Asset) == 2
        assert await _count(session, RetestSchedule) == 2
        assert await _count(session, Inspection) == 3
        assert await _count(session, PressureTestResult) == 2
        assert await _count(session, Certificate) == 1
        assert await _count(session, Product) == 18
        assert await _count(session, Coupling) == 20
        assert await _count(session, CouplingAddOn) == 7
        assert await _count(session, AttachMethod) == 7
        assert await _count(session, Material) == 10
        assert await _count(session, NominalBore) == 15
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Product)
                .where(Product.code == "NA")
            )
            == 2
        )
        assert await session.scalar(
            select(Product.id).where(
                Product.code == "RWFD20",
                Product.name == "SAHARA",
            )
        )
        assert await session.scalar(
            select(Coupling.id).where(Coupling.code == "LEGACY-37")
        )
        assert await session.scalar(
            select(CouplingAddOn.id).where(CouplingAddOn.code == "NO_ADDITIONAL")
        )
        assert await session.scalar(
            select(AttachMethod.id).where(AttachMethod.code == "WIRE_WHIPPED")
        )
        assert await session.scalar(
            select(Material.id).where(Material.code == "POLYPROPYLENE")
        )
        assert await session.scalar(
            select(NominalBore.id).where(NominalBore.code == "200NB")
        )
        users = (await session.scalars(select(User).order_by(User.oidc_subject))).all()
        assert [(user.oidc_subject, user.role) for user in users] == [
            ("inspector-1", "INSPECTOR"),
            ("reviewer-1", "REVIEWER"),
            ("staff-ui-dev", "HMS_ADMIN"),
        ]

    await engine.dispose()
