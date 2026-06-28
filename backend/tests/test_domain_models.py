from collections.abc import AsyncGenerator
from datetime import date

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import (
    Asset,
    AssetEnd,
    AssetEndConfiguration,
    AssetLifecycleStatus,
)
from hms_backend.app.modules.certificates.models import (
    Certificate,
    CertificateIssueError,
    CertificateStatus,
)
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product, ProductPressureRating
from hms_backend.app.modules.reference.models import (
    AttachMethod,
    Coupling,
    Material,
    NominalBore,
    Standard,
)
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as test_session:
        yield test_session

    await engine.dispose()


@pytest.mark.asyncio
async def test_asset_links_customer_location_product_structured_ends_and_schedule(
    session: AsyncSession,
) -> None:
    customer = Customer(
        code="VOPA",
        name="Vopak",
        retest_enabled=True,
        default_retest_months=6,
    )
    location = CustomerLocation(
        customer=customer,
        name="Site A",
        city="Port Botany",
        state="NSW",
        country="AU",
    )
    standard = Standard(code="AS2683", name="AS2683")
    bore = NominalBore(code="75NB", label="75NB")
    material = Material(code="SS", name="Stainless Steel")
    coupling = Coupling(code="CAMLOCK", name="Camlock")
    attach_method = AttachMethod(code="CRIMP", name="Crimp")
    product = Product(
        category="Composite",
        sub_category="Petrol & Oil",
        code="1000GY",
        name="FUELFLEX GREEN",
        standard=standard,
    )
    pressure_rating = ProductPressureRating(
        product=product,
        nominal_bore=bore,
        working_pressure_kpa=1000,
        test_pressure_kpa=1500,
    )
    asset = Asset(
        customer=customer,
        location=location,
        product=product,
        asset_number="997950",
        customer_serial_no="",
        tag="HMS-997950",
        lifecycle_status=AssetLifecycleStatus.OVERDUE.value,
        manufacture_date=date(2023, 5, 2),
        next_retest_due_at=date(2023, 11, 2),
    )
    end_a = AssetEndConfiguration(
        asset=asset,
        end=AssetEnd.A.value,
        nominal_bore=bore,
        material=material,
        coupling=coupling,
        attach_method=attach_method,
    )
    end_b = AssetEndConfiguration(
        asset=asset,
        end=AssetEnd.B.value,
        nominal_bore=bore,
        material=material,
        coupling=coupling,
        attach_method=attach_method,
    )
    schedule = RetestSchedule(
        customer=customer,
        asset=asset,
        due_at=date(2023, 11, 2),
        status=RetestScheduleStatus.OVERDUE.value,
        reminder_interval_days=30,
        escalation_interval_days=7,
    )

    session.add_all([pressure_rating, asset, end_a, end_b, schedule])
    await session.flush()

    persisted = (
        await session.scalars(
            select(Asset)
            .where(Asset.asset_number == "997950")
            .options(
                selectinload(Asset.customer),
                selectinload(Asset.location),
                selectinload(Asset.product).selectinload(Product.pressure_ratings),
                selectinload(Asset.ends),
                selectinload(Asset.retest_schedule),
            )
        )
    ).one()

    assert persisted.customer.code == "VOPA"
    assert persisted.location is not None
    assert persisted.location.name == "Site A"
    assert persisted.product.code == "1000GY"
    assert persisted.lifecycle_status == AssetLifecycleStatus.OVERDUE.value
    assert {asset_end.end for asset_end in persisted.ends} == {"A", "B"}
    assert persisted.product.pressure_ratings[0].nominal_bore_id == bore.id
    assert persisted.retest_schedule is not None
    assert persisted.retest_schedule.status == RetestScheduleStatus.OVERDUE.value


@pytest.mark.asyncio
async def test_certificate_can_only_be_issued_from_approved_inspection(
    session: AsyncSession,
) -> None:
    customer = Customer(code="VOPA", name="Vopak")
    standard = Standard(code="AS2683", name="AS2683")
    product = Product(
        category="Composite",
        sub_category="Petrol & Oil",
        code="1000GY",
        name="FUELFLEX GREEN",
        standard=standard,
    )
    asset = Asset(
        customer=customer,
        product=product,
        asset_number="997950",
        tag="HMS-997950",
        lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
    )
    inspection = Inspection(
        asset=asset,
        inspection_type=InspectionType.SERVICE.value,
        status=InspectionStatus.SUBMITTED.value,
        result="PASS",
        inspector_user_id="inspector-1",
    )
    pressure_test = PressureTestResult(
        inspection=inspection,
        applied_pressure_kpa=1500,
        hold_time_seconds=300,
        passed=True,
    )
    session.add_all([inspection, pressure_test])
    await session.flush()

    with pytest.raises(CertificateIssueError):
        Certificate.issue_from_inspection(
            inspection,
            number="CERT-997950-1",
            pdf_object_key="certificates/CERT-997950-1.pdf",
            verification_hash="abc123",
            public_token="public-token",
            issued_by_user_id="reviewer-1",
            valid_until=date(2026, 11, 2),
        )

    inspection.status = InspectionStatus.APPROVED.value
    certificate = Certificate.issue_from_inspection(
        inspection,
        number="CERT-997950-1",
        pdf_object_key="certificates/CERT-997950-1.pdf",
        verification_hash="abc123",
        public_token="public-token",
        issued_by_user_id="reviewer-1",
        valid_until=date(2026, 11, 2),
    )
    session.add(certificate)
    await session.flush()

    assert certificate.asset_id == asset.id
    assert certificate.inspection_id == inspection.id
    assert certificate.status == CertificateStatus.ISSUED.value
