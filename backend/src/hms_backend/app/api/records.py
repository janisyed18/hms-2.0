from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    AssetCreate,
    AssetListResponse,
    AssetRead,
    AssetUpdate,
    CertificateCreate,
    CertificateRead,
    CustomerSummary,
    InspectionCreate,
    InspectionRead,
    LocationSummary,
    LookupListResponse,
    LookupRead,
    PressureTestRead,
    ProductCreate,
    ProductListResponse,
    ProductRead,
    ProductSummary,
    ProductUpdate,
    RetestScheduleSummary,
    RetestScheduleWrite,
    StandardCreate,
    StandardUpdate,
)
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.core.repository import record_create, record_update
from hms_backend.app.models.base import utc_now
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import (
    Certificate,
    CertificateIssueError,
)
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import RetestSchedule

router = APIRouter()

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=100)]
OffsetParam = Annotated[int, Query(ge=0)]


def _require_asset_read(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.ASSET_READ)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_reference_admin(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.REFERENCE_ADMIN)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_asset_write(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.ASSET_WRITE)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_inspection_write(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.INSPECTION_WRITE)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_certificate_approve(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.CERTIFICATE_APPROVE)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


async def _count(session: AsyncSession, statement: Select[Any]) -> int:
    count_statement = select(func.count()).select_from(
        statement.order_by(None).subquery()
    )
    return await session.scalar(count_statement) or 0


@router.post(
    "/reference/standards",
    response_model=LookupRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_standard(
    payload: StandardCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> LookupRead:
    _require_reference_admin(principal)
    standard = Standard(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        enabled=payload.enabled,
    )
    session.add(standard)
    await record_create(
        session,
        standard,
        actor_id=principal.user_id,
        action="standard.created",
    )
    await session.commit()
    return LookupRead(id=standard.id, code=standard.code, name=standard.name)


@router.get("/reference/standards", response_model=LookupListResponse)
async def list_standards(
    session: SessionDep,
    principal: PrincipalDep,
) -> LookupListResponse:
    _require_asset_read(principal)
    standards = (
        await session.scalars(
            select(Standard)
            .where(Standard.enabled.is_(True), Standard.deleted_at.is_(None))
            .order_by(Standard.code)
        )
    ).all()

    return LookupListResponse(
        items=[
            LookupRead(id=standard.id, code=standard.code, name=standard.name)
            for standard in standards
        ]
    )


@router.patch("/reference/standards/{standard_id}", response_model=LookupRead)
async def update_standard(
    standard_id: str,
    payload: StandardUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> LookupRead:
    _require_reference_admin(principal)
    standard = await session.get(Standard, standard_id)
    if standard is None or standard.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Standard not found",
        )

    before = standard.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)
    if "code" in updates and payload.code is not None:
        standard.code = payload.code.strip().upper()
    if "name" in updates and payload.name is not None:
        standard.name = payload.name.strip()
    if "enabled" in updates and payload.enabled is not None:
        standard.enabled = payload.enabled

    await record_update(
        session,
        standard,
        actor_id=principal.user_id,
        action="standard.updated",
        before=before,
    )
    await session.commit()
    return LookupRead(id=standard.id, code=standard.code, name=standard.name)


@router.post(
    "/products",
    response_model=ProductRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_product(
    payload: ProductCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> ProductRead:
    _require_reference_admin(principal)
    standard = await _get_standard_or_404(session, payload.standard_id)
    product = Product(
        category=payload.category.strip(),
        sub_category=payload.sub_category.strip() if payload.sub_category else None,
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        standard=standard,
        enabled=payload.enabled,
    )
    session.add(product)
    await record_create(
        session,
        product,
        actor_id=principal.user_id,
        action="product.created",
    )
    await session.commit()
    return _product_read(product)


@router.post(
    "/assets",
    response_model=AssetRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_asset(
    payload: AssetCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> AssetRead:
    _require_asset_write(principal)
    customer = await _get_customer_or_404(session, payload.customer_id)
    product = await _get_product_or_404(session, payload.product_id)
    location = await _get_location_or_400(
        session,
        payload.location_id,
        customer_id=customer.id,
    )
    asset = Asset(
        customer=customer,
        location=location,
        product=product,
        asset_number=payload.asset_number.strip(),
        customer_serial_no=_clean_optional(payload.customer_serial_no),
        tag=_clean_optional(payload.tag),
        lifecycle_status=payload.lifecycle_status,
        manufacture_date=payload.manufacture_date,
        next_retest_due_at=payload.next_retest_due_at,
        condemned_at=payload.condemned_at,
        length_m=payload.length_m,
    )
    session.add(asset)
    await record_create(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.created",
    )
    if payload.retest_schedule is not None:
        schedule = _build_retest_schedule(
            payload.retest_schedule,
            customer=customer,
            asset=asset,
        )
        session.add(schedule)
        await record_create(
            session,
            schedule,
            actor_id=principal.user_id,
            action="retest_schedule.created",
        )
    await session.commit()
    loaded = await _get_visible_asset_or_404(session, asset.id, principal)
    return _asset_read(loaded)


@router.post(
    "/assets/{asset_id}/inspections",
    response_model=InspectionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_inspection(
    asset_id: str,
    payload: InspectionCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_inspection_write(principal)
    asset = await _get_visible_asset_or_404(session, asset_id, principal)
    inspection = Inspection(
        asset=asset,
        inspection_type=payload.inspection_type,
        status=InspectionStatus.DRAFT.value,
        result=_clean_optional(payload.result),
        inspector_user_id=principal.user_id,
    )
    session.add(inspection)
    await record_create(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.created",
    )

    if payload.pressure_test is not None:
        pressure_test = PressureTestResult(
            inspection=inspection,
            applied_pressure_kpa=payload.pressure_test.applied_pressure_kpa,
            hold_time_seconds=payload.pressure_test.hold_time_seconds,
            passed=payload.pressure_test.passed,
            measurements=payload.pressure_test.measurements,
        )
        session.add(pressure_test)
        await record_create(
            session,
            pressure_test,
            actor_id=principal.user_id,
            action="pressure_test_result.created",
        )

    await session.commit()
    return _inspection_read(inspection)


@router.post("/inspections/{inspection_id}/submit", response_model=InspectionRead)
async def submit_inspection(
    inspection_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_inspection_write(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.status != InspectionStatus.DRAFT.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Inspection must be in draft status before submission",
        )

    before = inspection.to_audit_dict()
    inspection.status = InspectionStatus.SUBMITTED.value
    inspection.submitted_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.submitted",
        before=before,
    )
    await session.commit()
    return _inspection_read(inspection)


@router.post("/inspections/{inspection_id}/approve", response_model=InspectionRead)
async def approve_inspection(
    inspection_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_certificate_approve(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.status != InspectionStatus.SUBMITTED.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Inspection must be submitted before approval",
        )

    before = inspection.to_audit_dict()
    inspection.status = InspectionStatus.APPROVED.value
    inspection.reviewer_user_id = principal.user_id
    inspection.approved_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.approved",
        before=before,
    )
    await session.commit()
    return _inspection_read(inspection)


@router.post(
    "/inspections/{inspection_id}/certificate",
    response_model=CertificateRead,
    status_code=status.HTTP_201_CREATED,
)
async def issue_certificate(
    inspection_id: str,
    payload: CertificateCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateRead:
    _require_certificate_approve(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.certificate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Certificate already issued for inspection",
        )

    try:
        certificate = Certificate.issue_from_inspection(
            inspection,
            number=payload.number.strip(),
            pdf_object_key=payload.pdf_object_key.strip(),
            verification_hash=payload.verification_hash.strip(),
            public_token=payload.public_token.strip(),
            issued_by_user_id=principal.user_id,
            valid_until=payload.valid_until,
        )
    except CertificateIssueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    session.add(certificate)
    await record_create(
        session,
        certificate,
        actor_id=principal.user_id,
        action="certificate.issued",
    )
    await session.commit()
    return _certificate_read(certificate)


@router.get("/products", response_model=ProductListResponse)
async def list_products(
    session: SessionDep,
    principal: PrincipalDep,
    category: str | None = None,
    search: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> ProductListResponse:
    _require_asset_read(principal)
    statement = (
        select(Product)
        .options(selectinload(Product.standard))
        .where(Product.enabled.is_(True), Product.deleted_at.is_(None))
    )
    if category:
        statement = statement.where(func.lower(Product.category) == category.lower())
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Product.code).like(search_pattern),
                func.lower(Product.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    products = (
        await session.scalars(
            statement.order_by(Product.code).offset(offset).limit(limit)
        )
    ).all()
    return ProductListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_product_read(product) for product in products],
    )


@router.patch("/products/{product_id}", response_model=ProductRead)
async def update_product(
    product_id: str,
    payload: ProductUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> ProductRead:
    _require_reference_admin(principal)
    product = await session.get(Product, product_id)
    if product is None or product.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )

    before = product.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)
    if "category" in updates and payload.category is not None:
        product.category = payload.category.strip()
    if "sub_category" in updates:
        product.sub_category = (
            payload.sub_category.strip() if payload.sub_category else None
        )
    if "code" in updates and payload.code is not None:
        product.code = payload.code.strip().upper()
    if "name" in updates and payload.name is not None:
        product.name = payload.name.strip()
    if "standard_id" in updates:
        product.standard = await _get_standard_or_404(session, payload.standard_id)
    if "enabled" in updates and payload.enabled is not None:
        product.enabled = payload.enabled

    await record_update(
        session,
        product,
        actor_id=principal.user_id,
        action="product.updated",
        before=before,
    )
    await session.commit()
    return _product_read(product)


@router.get("/assets", response_model=AssetListResponse)
async def list_assets(
    session: SessionDep,
    principal: PrincipalDep,
    search: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    customer_id: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> AssetListResponse:
    _require_asset_read(principal)
    statement = (
        _asset_statement().join(Asset.customer).where(Asset.deleted_at.is_(None))
    )
    statement = _apply_asset_scope(statement, principal)

    if customer_id:
        statement = statement.where(Asset.customer_id == customer_id)
    if status_filter:
        statement = statement.where(Asset.lifecycle_status == status_filter)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Asset.asset_number).like(search_pattern),
                func.lower(Asset.customer_serial_no).like(search_pattern),
                func.lower(Asset.tag).like(search_pattern),
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    assets = (
        await session.scalars(
            statement.order_by(Asset.asset_number).offset(offset).limit(limit)
        )
    ).all()
    return AssetListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_asset_read(asset) for asset in assets],
    )


@router.patch("/assets/{asset_id}", response_model=AssetRead)
async def update_asset(
    asset_id: str,
    payload: AssetUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> AssetRead:
    _require_asset_write(principal)
    asset = await _get_visible_asset_or_404(session, asset_id, principal)
    before = asset.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)

    target_customer = asset.customer
    if "customer_id" in updates and payload.customer_id is not None:
        target_customer = await _get_customer_or_404(session, payload.customer_id)
        asset.customer = target_customer
    if "product_id" in updates and payload.product_id is not None:
        asset.product = await _get_product_or_404(session, payload.product_id)
    if "location_id" in updates:
        asset.location = await _get_location_or_400(
            session,
            payload.location_id,
            customer_id=target_customer.id,
        )
    if "asset_number" in updates and payload.asset_number is not None:
        asset.asset_number = payload.asset_number.strip()
    if "customer_serial_no" in updates:
        asset.customer_serial_no = _clean_optional(payload.customer_serial_no)
    if "tag" in updates:
        asset.tag = _clean_optional(payload.tag)
    if "lifecycle_status" in updates and payload.lifecycle_status is not None:
        asset.lifecycle_status = payload.lifecycle_status
    if "manufacture_date" in updates:
        asset.manufacture_date = payload.manufacture_date
    if "next_retest_due_at" in updates:
        asset.next_retest_due_at = payload.next_retest_due_at
    if "condemned_at" in updates:
        asset.condemned_at = payload.condemned_at
    if "length_m" in updates:
        asset.length_m = payload.length_m

    await record_update(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.updated",
        before=before,
    )
    if "retest_schedule" in updates and payload.retest_schedule is not None:
        await _upsert_retest_schedule(
            session,
            payload.retest_schedule,
            asset=asset,
            customer=target_customer,
            actor_id=principal.user_id,
        )
    await session.commit()
    loaded = await _get_visible_asset_or_404(session, asset.id, principal)
    return _asset_read(loaded)


@router.get("/assets/{asset_id}", response_model=AssetRead)
async def get_asset(
    asset_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> AssetRead:
    _require_asset_read(principal)
    statement = _asset_statement().where(
        Asset.id == asset_id,
        Asset.deleted_at.is_(None),
    )
    statement = _apply_asset_scope(statement, principal)
    asset = (await session.scalars(statement)).first()
    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Asset not found",
        )
    return _asset_read(asset)


def _asset_statement() -> Select[tuple[Asset]]:
    return select(Asset).options(
        selectinload(Asset.customer),
        selectinload(Asset.location),
        selectinload(Asset.product),
        selectinload(Asset.retest_schedule),
    )


def _apply_asset_scope[StatementT: Select[Any]](
    statement: StatementT,
    principal: Principal,
) -> StatementT:
    if not is_customer_scoped(principal):
        return statement
    if not principal.customer_ids:
        return statement.where(false())
    return statement.where(Asset.customer_id.in_(principal.customer_ids))


def _product_read(product: Product) -> ProductRead:
    standard_code = product.standard.code if product.standard is not None else None
    return ProductRead(
        id=product.id,
        code=product.code,
        name=product.name,
        category=product.category,
        sub_category=product.sub_category,
        standard_code=standard_code,
    )


async def _get_standard_or_404(
    session: AsyncSession,
    standard_id: str | None,
) -> Standard | None:
    if standard_id is None:
        return None
    standard = await session.get(Standard, standard_id)
    if standard is None or standard.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Standard not found",
        )
    return standard


async def _get_customer_or_404(session: AsyncSession, customer_id: str) -> Customer:
    customer = await session.get(Customer, customer_id)
    if customer is None or customer.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found",
        )
    return customer


async def _get_product_or_404(session: AsyncSession, product_id: str) -> Product:
    product = await session.get(Product, product_id)
    if product is None or product.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )
    return product


async def _get_location_or_400(
    session: AsyncSession,
    location_id: str | None,
    *,
    customer_id: str,
) -> CustomerLocation | None:
    if location_id is None:
        return None
    location = await session.get(CustomerLocation, location_id)
    if location is None or location.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found",
        )
    if location.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Location does not belong to customer",
        )
    return location


async def _get_visible_asset_or_404(
    session: AsyncSession,
    asset_id: str,
    principal: Principal,
) -> Asset:
    statement = _asset_statement().where(
        Asset.id == asset_id,
        Asset.deleted_at.is_(None),
    )
    statement = _apply_asset_scope(statement, principal)
    asset = (await session.scalars(statement)).first()
    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Asset not found",
        )
    return asset


async def _get_inspection_or_404(
    session: AsyncSession,
    inspection_id: str,
    principal: Principal,
) -> Inspection:
    statement = (
        select(Inspection)
        .join(Inspection.asset)
        .options(
            selectinload(Inspection.asset),
            selectinload(Inspection.pressure_test),
            selectinload(Inspection.certificate),
        )
        .where(
            Inspection.id == inspection_id,
            Inspection.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
        )
    )
    statement = _apply_asset_scope(statement, principal)
    inspection = (await session.scalars(statement)).first()
    if inspection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Inspection not found",
        )
    return inspection


def _build_retest_schedule(
    payload: RetestScheduleWrite,
    *,
    customer: Customer,
    asset: Asset,
) -> RetestSchedule:
    return RetestSchedule(
        customer=customer,
        asset=asset,
        due_at=payload.due_at,
        status=payload.status,
        reminder_interval_days=payload.reminder_interval_days,
        escalation_interval_days=payload.escalation_interval_days,
    )


async def _upsert_retest_schedule(
    session: AsyncSession,
    payload: RetestScheduleWrite,
    *,
    asset: Asset,
    customer: Customer,
    actor_id: str,
) -> None:
    schedule = asset.retest_schedule
    if schedule is None:
        schedule = _build_retest_schedule(payload, customer=customer, asset=asset)
        session.add(schedule)
        await record_create(
            session,
            schedule,
            actor_id=actor_id,
            action="retest_schedule.created",
        )
        return

    before = schedule.to_audit_dict()
    schedule.customer = customer
    schedule.due_at = payload.due_at
    schedule.status = payload.status
    schedule.reminder_interval_days = payload.reminder_interval_days
    schedule.escalation_interval_days = payload.escalation_interval_days
    await record_update(
        session,
        schedule,
        actor_id=actor_id,
        action="retest_schedule.updated",
        before=before,
    )


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _pressure_test_read(pressure_test: PressureTestResult) -> PressureTestRead:
    return PressureTestRead(
        id=pressure_test.id,
        applied_pressure_kpa=pressure_test.applied_pressure_kpa,
        hold_time_seconds=pressure_test.hold_time_seconds,
        passed=pressure_test.passed,
        measurements=pressure_test.measurements,
    )


def _inspection_read(inspection: Inspection) -> InspectionRead:
    return InspectionRead(
        id=inspection.id,
        asset_id=inspection.asset_id,
        inspection_type=inspection.inspection_type,
        status=inspection.status,
        result=inspection.result,
        inspector_user_id=inspection.inspector_user_id,
        reviewer_user_id=inspection.reviewer_user_id,
        submitted_at=inspection.submitted_at,
        approved_at=inspection.approved_at,
        rejected_at=inspection.rejected_at,
        pressure_test=(
            _pressure_test_read(inspection.pressure_test)
            if inspection.pressure_test is not None
            else None
        ),
    )


def _certificate_read(certificate: Certificate) -> CertificateRead:
    return CertificateRead(
        id=certificate.id,
        inspection_id=certificate.inspection_id,
        asset_id=certificate.asset_id,
        number=certificate.number,
        certificate_version=certificate.certificate_version,
        issued_at=certificate.issued_at,
        valid_until=certificate.valid_until,
        pdf_object_key=certificate.pdf_object_key,
        verification_hash=certificate.verification_hash,
        public_token=certificate.public_token,
        issued_by_user_id=certificate.issued_by_user_id,
        status=certificate.status,
    )


def _asset_read(asset: Asset) -> AssetRead:
    return AssetRead(
        id=asset.id,
        asset_number=asset.asset_number,
        customer_serial_no=asset.customer_serial_no,
        tag=asset.tag,
        lifecycle_status=asset.lifecycle_status,
        manufacture_date=asset.manufacture_date,
        next_retest_due_at=asset.next_retest_due_at,
        condemned_at=asset.condemned_at,
        length_m=asset.length_m,
        customer=CustomerSummary(
            id=asset.customer.id,
            code=asset.customer.code,
            name=asset.customer.name,
        ),
        product=ProductSummary(
            id=asset.product.id,
            code=asset.product.code,
            name=asset.product.name,
            category=asset.product.category,
        ),
        location=(
            LocationSummary(
                id=asset.location.id,
                name=asset.location.name,
                city=asset.location.city,
                state=asset.location.state,
                country=asset.location.country,
            )
            if asset.location is not None
            else None
        ),
        retest_schedule=(
            RetestScheduleSummary(
                due_at=asset.retest_schedule.due_at,
                status=asset.retest_schedule.status,
            )
            if asset.retest_schedule is not None
            else None
        ),
    )
