from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import desc, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    AssetCreate,
    AssetEndRead,
    AssetEndWrite,
    AssetListResponse,
    AssetRead,
    AssetUpdate,
    CertificateCreate,
    CertificateInspectionSummary,
    CertificateListResponse,
    CertificateRead,
    CustomerContactCreate,
    CustomerContactRead,
    CustomerContactUpdate,
    CustomerCreate,
    CustomerListResponse,
    CustomerLocationCreate,
    CustomerLocationRead,
    CustomerLocationUpdate,
    CustomerRead,
    CustomerSummary,
    CustomerUpdate,
    DashboardDueRead,
    DashboardRead,
    DashboardRetestRead,
    DashboardReviewRead,
    InspectionAssetSummary,
    InspectionCreate,
    InspectionListResponse,
    InspectionRead,
    InspectionRejectRequest,
    InspectionUpdate,
    LocationSummary,
    LookupListResponse,
    LookupRead,
    PressureTestRead,
    PressureTestWrite,
    ProductCreate,
    ProductListResponse,
    ProductRead,
    ProductSummary,
    ProductUpdate,
    RetestScheduleListResponse,
    RetestScheduleRead,
    RetestScheduleSummary,
    RetestScheduleUpdate,
    RetestScheduleWrite,
    StandardCreate,
    StandardUpdate,
)
from hms_backend.app.core.cache import (
    cache_delete_prefix,
    cache_get_json,
    cache_set_json,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.core.repository import record_create, record_update, soft_delete
from hms_backend.app.models.base import utc_now
from hms_backend.app.modules.assets.models import Asset, AssetEndConfiguration
from hms_backend.app.modules.certificates.engine_client import (
    CertificateEngineError,
    get_certificate_engine,
)
from hms_backend.app.modules.certificates.issuance import (
    AssetNotCertifiableError,
    CertificateAlreadyIssuedError,
    InspectionNotApprovedError,
    generate_and_store_certificate,
    generate_certificate_number,
    generate_public_token,
)
from hms_backend.app.modules.certificates.models import (
    Certificate,
    CertificateIssueError,
    CertificateStatus,
)
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    PressureTestResult,
)
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

router = APIRouter()

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=100)]
OffsetParam = Annotated[int, Query(ge=0)]
IfMatchHeader = Annotated[str | None, Header(alias="If-Match")]


def _require_asset_read(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.ASSET_READ)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_customer_read(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.CUSTOMER_READ)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_customer_write(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.CUSTOMER_WRITE)
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


def _etag_for_version(version: int) -> str:
    return f'"{version}"'


def _set_etag(response: Response, version: int) -> None:
    response.headers["ETag"] = _etag_for_version(version)


def _enforce_if_match(if_match: str | None, version: int) -> None:
    if if_match is None:
        return

    requested_tags = {tag.strip() for tag in if_match.split(",")}
    if "*" in requested_tags or _etag_for_version(version) in requested_tags:
        return

    raise HTTPException(
        status_code=status.HTTP_412_PRECONDITION_FAILED,
        detail="Resource version does not match",
    )


def _apply_sort(
    statement: Select[Any],
    model: type[Any],
    sort: str | None,
    allowed_fields: frozenset[str],
    *,
    default: str,
) -> Select[Any]:
    requested_sort = sort or default
    descending = requested_sort.startswith("-")
    field_name = requested_sort[1:] if descending else requested_sort
    if field_name not in allowed_fields:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported sort field: {field_name}",
        )

    sort_column = getattr(model, field_name)
    return statement.order_by(sort_column.desc() if descending else sort_column.asc())


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
    await cache_delete_prefix(_STANDARDS_CACHE_PREFIX)
    return LookupRead(id=standard.id, code=standard.code, name=standard.name)


_STANDARDS_CACHE_PREFIX = "reference:standards:"


@router.get("/reference/standards", response_model=LookupListResponse)
async def list_standards(
    session: SessionDep,
    principal: PrincipalDep,
    sort: str | None = None,
) -> LookupListResponse:
    _require_asset_read(principal)

    # Reference standards are global (not customer-scoped) and change rarely, so
    # the enabled list is cached and invalidated on any standard mutation.
    cache_key = f"{_STANDARDS_CACHE_PREFIX}{sort or 'default'}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        return LookupListResponse.model_validate(cached)

    statement = select(Standard).where(
        Standard.enabled.is_(True),
        Standard.deleted_at.is_(None),
    )
    statement = _apply_sort(
        statement,
        Standard,
        sort,
        frozenset({"code", "name", "created_at", "updated_at"}),
        default="code",
    )
    standards = (await session.scalars(statement)).all()

    result = LookupListResponse(
        items=[
            LookupRead(id=standard.id, code=standard.code, name=standard.name)
            for standard in standards
        ]
    )
    await cache_set_json(cache_key, result.model_dump(mode="json"))
    return result


@router.patch("/reference/standards/{standard_id}", response_model=LookupRead)
async def update_standard(
    standard_id: str,
    payload: StandardUpdate,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
    if_match: IfMatchHeader = None,
) -> LookupRead:
    _require_reference_admin(principal)
    standard = await session.get(Standard, standard_id)
    if standard is None or standard.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Standard not found",
        )
    _enforce_if_match(if_match, standard.version)

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
    await cache_delete_prefix(_STANDARDS_CACHE_PREFIX)
    _set_etag(response, standard.version)
    return LookupRead(id=standard.id, code=standard.code, name=standard.name)


@router.delete(
    "/reference/standards/{standard_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_standard(
    standard_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    if_match: IfMatchHeader = None,
) -> Response:
    _require_reference_admin(principal)
    standard = await _get_standard_or_404(session, standard_id)
    if standard is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Standard not found",
        )
    _enforce_if_match(if_match, standard.version)

    await soft_delete(
        session,
        standard,
        actor_id=principal.user_id,
        action="standard.deleted",
    )
    await session.commit()
    await cache_delete_prefix(_STANDARDS_CACHE_PREFIX)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/customers",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_customer(
    payload: CustomerCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CustomerRead:
    _require_customer_write(principal)
    customer = Customer(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        notes=_clean_optional(payload.notes),
        retest_enabled=payload.retest_enabled,
        default_retest_months=payload.default_retest_months,
    )
    session.add(customer)
    await record_create(
        session,
        customer,
        actor_id=principal.user_id,
        action="customer.created",
    )
    await session.commit()
    loaded = await _get_visible_customer_or_404(session, customer.id, principal)
    return _customer_read(loaded)


@router.get("/customers", response_model=CustomerListResponse)
async def list_customers(
    session: SessionDep,
    principal: PrincipalDep,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> CustomerListResponse:
    _require_customer_read(principal)
    statement = _customer_statement().where(Customer.deleted_at.is_(None))
    statement = _apply_customer_scope(statement, principal)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Customer,
        sort,
        frozenset({"code", "name", "created_at", "updated_at"}),
        default="code",
    )
    customers = (
        await session.scalars(statement.offset(offset).limit(limit))
    ).all()
    return CustomerListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_customer_read(customer) for customer in customers],
    )


@router.post(
    "/customers/{customer_id}/locations",
    response_model=CustomerLocationRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_customer_location(
    customer_id: str,
    payload: CustomerLocationCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CustomerLocationRead:
    _require_customer_write(principal)
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    location = CustomerLocation(
        customer=customer,
        name=payload.name.strip(),
        address_1=_clean_optional(payload.address_1),
        address_2=_clean_optional(payload.address_2),
        city=_clean_optional(payload.city),
        state=_clean_optional(payload.state),
        country=_clean_optional(payload.country),
    )
    session.add(location)
    await record_create(
        session,
        location,
        actor_id=principal.user_id,
        action="customer_location.created",
    )
    await session.commit()
    return _customer_location_read(location)


@router.patch(
    "/customers/{customer_id}/locations/{location_id}",
    response_model=CustomerLocationRead,
)
async def update_customer_location(
    customer_id: str,
    location_id: str,
    payload: CustomerLocationUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CustomerLocationRead:
    _require_customer_write(principal)
    location = await _get_visible_customer_location_or_404(
        session,
        customer_id,
        location_id,
        principal,
    )
    before = location.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and payload.name is not None:
        location.name = payload.name.strip()
    if "address_1" in updates:
        location.address_1 = _clean_optional(payload.address_1)
    if "address_2" in updates:
        location.address_2 = _clean_optional(payload.address_2)
    if "city" in updates:
        location.city = _clean_optional(payload.city)
    if "state" in updates:
        location.state = _clean_optional(payload.state)
    if "country" in updates:
        location.country = _clean_optional(payload.country)

    await record_update(
        session,
        location,
        actor_id=principal.user_id,
        action="customer_location.updated",
        before=before,
    )
    await session.commit()
    return _customer_location_read(location)


@router.delete(
    "/customers/{customer_id}/locations/{location_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_customer_location(
    customer_id: str,
    location_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> Response:
    _require_customer_write(principal)
    location = await _get_visible_customer_location_or_404(
        session,
        customer_id,
        location_id,
        principal,
    )
    await soft_delete(
        session,
        location,
        actor_id=principal.user_id,
        action="customer_location.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/customers/{customer_id}/contacts",
    response_model=CustomerContactRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_customer_contact(
    customer_id: str,
    payload: CustomerContactCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CustomerContactRead:
    _require_customer_write(principal)
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    contact = CustomerContact(
        customer=customer,
        name=payload.name.strip(),
        email=_clean_optional(payload.email),
        phone=_clean_optional(payload.phone),
        role=_clean_optional(payload.role),
        receives_retest_reminders=payload.receives_retest_reminders,
    )
    session.add(contact)
    await record_create(
        session,
        contact,
        actor_id=principal.user_id,
        action="customer_contact.created",
    )
    await session.commit()
    return _customer_contact_read(contact)


@router.patch(
    "/customers/{customer_id}/contacts/{contact_id}",
    response_model=CustomerContactRead,
)
async def update_customer_contact(
    customer_id: str,
    contact_id: str,
    payload: CustomerContactUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> CustomerContactRead:
    _require_customer_write(principal)
    contact = await _get_visible_customer_contact_or_404(
        session,
        customer_id,
        contact_id,
        principal,
    )
    before = contact.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and payload.name is not None:
        contact.name = payload.name.strip()
    if "email" in updates:
        contact.email = _clean_optional(payload.email)
    if "phone" in updates:
        contact.phone = _clean_optional(payload.phone)
    if "role" in updates:
        contact.role = _clean_optional(payload.role)
    if (
        "receives_retest_reminders" in updates
        and payload.receives_retest_reminders is not None
    ):
        contact.receives_retest_reminders = payload.receives_retest_reminders

    await record_update(
        session,
        contact,
        actor_id=principal.user_id,
        action="customer_contact.updated",
        before=before,
    )
    await session.commit()
    return _customer_contact_read(contact)


@router.delete(
    "/customers/{customer_id}/contacts/{contact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_customer_contact(
    customer_id: str,
    contact_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> Response:
    _require_customer_write(principal)
    contact = await _get_visible_customer_contact_or_404(
        session,
        customer_id,
        contact_id,
        principal,
    )
    await soft_delete(
        session,
        contact,
        actor_id=principal.user_id,
        action="customer_contact.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/customers/{customer_id}", response_model=CustomerRead)
async def update_customer(
    customer_id: str,
    payload: CustomerUpdate,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
    if_match: IfMatchHeader = None,
) -> CustomerRead:
    _require_customer_write(principal)
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    _enforce_if_match(if_match, customer.version)
    before = customer.to_audit_dict()
    updates = payload.model_dump(exclude_unset=True)
    if "code" in updates and payload.code is not None:
        customer.code = payload.code.strip().upper()
    if "name" in updates and payload.name is not None:
        customer.name = payload.name.strip()
    if "notes" in updates:
        customer.notes = _clean_optional(payload.notes)
    if "retest_enabled" in updates and payload.retest_enabled is not None:
        customer.retest_enabled = payload.retest_enabled
    if "default_retest_months" in updates:
        customer.default_retest_months = payload.default_retest_months

    await record_update(
        session,
        customer,
        actor_id=principal.user_id,
        action="customer.updated",
        before=before,
    )
    await session.commit()
    _set_etag(response, customer.version)
    return _customer_read(customer)


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_customer(
    customer_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    if_match: IfMatchHeader = None,
) -> Response:
    _require_customer_write(principal)
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    _enforce_if_match(if_match, customer.version)
    await soft_delete(
        session,
        customer,
        actor_id=principal.user_id,
        action="customer.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/customers/{customer_id}", response_model=CustomerRead)
async def get_customer(
    customer_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
) -> CustomerRead:
    _require_customer_read(principal)
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    _set_etag(response, customer.version)
    return _customer_read(customer)


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
        notes=_clean_optional(payload.notes),
    )
    session.add(asset)
    await record_create(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.created",
    )
    await _upsert_asset_end(
        session,
        payload.a_end,
        asset=asset,
        end="A",
        actor_id=principal.user_id,
    )
    await _upsert_asset_end(
        session,
        payload.b_end,
        asset=asset,
        end="B",
        actor_id=principal.user_id,
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


@router.get("/dashboard", response_model=DashboardRead)
async def get_dashboard(
    session: SessionDep,
    principal: PrincipalDep,
    limit: LimitParam = 5,
    offset: OffsetParam = 0,
) -> DashboardRead:
    _require_asset_read(principal)
    today = datetime.now(UTC).date()
    week_end = today + timedelta(days=7)

    assets = _apply_asset_scope(
        select(Asset).where(Asset.deleted_at.is_(None)), principal
    )
    schedules = _apply_asset_scope(_retest_schedule_statement(), principal)
    active_schedules = schedules.where(
        RetestSchedule.status != RetestScheduleStatus.SUSPENDED.value
    )
    overdue_schedules = active_schedules.where(RetestSchedule.due_at < today)
    due_soon_schedules = active_schedules.where(
        RetestSchedule.due_at.between(today, week_end)
    )
    reviews = _apply_asset_scope(_inspection_statement(), principal).where(
        Inspection.status == InspectionStatus.SUBMITTED.value
    )

    total_assets = await _count(session, assets)
    total_customers = await _count(
        session,
        _apply_customer_scope(
            select(Customer).where(Customer.deleted_at.is_(None)), principal
        ),
    )
    in_service_assets = await _count(
        session,
        assets.where(Asset.lifecycle_status == "IN_SERVICE"),
    )
    overdue_total = await _count(session, overdue_schedules)
    due_soon_assets = await _count(session, due_soon_schedules)
    awaiting_review_inspections = await _count(session, reviews)

    overdue_items = (
        await session.scalars(
            overdue_schedules.order_by(RetestSchedule.due_at, Asset.asset_number)
            .offset(offset)
            .limit(limit)
        )
    ).all()
    due_items = (
        await session.scalars(
            due_soon_schedules.order_by(
                RetestSchedule.due_at, Asset.asset_number
            ).limit(4)
        )
    ).all()
    review_items = (
        await session.scalars(
            reviews.order_by(
                desc(Inspection.submitted_at), desc(Inspection.created_at)
            ).limit(3)
        )
    ).all()

    return DashboardRead(
        total_assets=total_assets,
        total_customers=total_customers,
        in_service_assets=in_service_assets,
        due_soon_assets=due_soon_assets,
        overdue_assets=overdue_total,
        awaiting_review_inspections=awaiting_review_inspections,
        overdue_total=overdue_total,
        overdue_limit=limit,
        overdue_offset=offset,
        overdue_retests=[
            DashboardRetestRead(
                asset_id=schedule.asset.id,
                asset_number=schedule.asset.asset_number,
                customer_name=schedule.asset.customer.name,
                product_name=schedule.asset.product.name,
                due_at=schedule.due_at,
                days_overdue=(today - schedule.due_at).days,
                status="ESCALATED" if schedule.escalated_at else "OVERDUE",
            )
            for schedule in overdue_items
        ],
        due_this_week=[
            DashboardDueRead(
                asset_id=schedule.asset.id,
                asset_number=schedule.asset.asset_number,
                customer_name=schedule.asset.customer.name,
                due_at=schedule.due_at,
            )
            for schedule in due_items
        ],
        awaiting_review=[
            DashboardReviewRead(
                inspection_id=inspection.id,
                asset_id=inspection.asset.id,
                asset_number=inspection.asset.asset_number,
                inspection_type=inspection.inspection_type,
                status=inspection.status,
                result=inspection.result,
            )
            for inspection in review_items
        ],
    )


@router.get("/retest-schedules", response_model=RetestScheduleListResponse)
async def list_retest_schedules(
    session: SessionDep,
    principal: PrincipalDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    asset_id: str | None = None,
    customer_id: str | None = None,
    product_id: str | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> RetestScheduleListResponse:
    _require_asset_read(principal)
    statement = _retest_schedule_statement()
    statement = _apply_asset_scope(statement, principal)
    if status_filter:
        statement = statement.where(RetestSchedule.status == status_filter)
    if asset_id:
        statement = statement.where(RetestSchedule.asset_id == asset_id)
    if customer_id:
        statement = statement.where(RetestSchedule.customer_id == customer_id)
    if product_id:
        statement = statement.where(Asset.product_id == product_id)
    if due_from:
        statement = statement.where(RetestSchedule.due_at >= due_from)
    if due_to:
        statement = statement.where(RetestSchedule.due_at <= due_to)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Asset.asset_number).like(search_pattern),
                func.lower(Asset.tag).like(search_pattern),
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
                func.lower(Product.code).like(search_pattern),
                func.lower(Product.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        RetestSchedule,
        sort,
        frozenset({"due_at", "status", "created_at", "updated_at"}),
        default="due_at",
    )
    schedules = (await session.scalars(statement.offset(offset).limit(limit))).all()
    return RetestScheduleListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_retest_schedule_read(schedule) for schedule in schedules],
    )


@router.get("/retest-schedules/{schedule_id}", response_model=RetestScheduleRead)
async def get_retest_schedule(
    schedule_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
) -> RetestScheduleRead:
    _require_asset_read(principal)
    schedule = await _get_retest_schedule_or_404(session, schedule_id, principal)
    _set_etag(response, schedule.version)
    return _retest_schedule_read(schedule)


@router.patch("/retest-schedules/{schedule_id}", response_model=RetestScheduleRead)
async def update_retest_schedule(
    schedule_id: str,
    payload: RetestScheduleUpdate,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
    if_match: IfMatchHeader = None,
) -> RetestScheduleRead:
    _require_asset_write(principal)
    schedule = await _get_retest_schedule_or_404(session, schedule_id, principal)
    _enforce_if_match(if_match, schedule.version)

    updates = payload.model_dump(exclude_unset=True)
    before = schedule.to_audit_dict()
    asset_before = None
    if "due_at" in updates and payload.due_at is not None:
        schedule.due_at = payload.due_at
        if schedule.asset.next_retest_due_at != payload.due_at:
            asset_before = schedule.asset.to_audit_dict()
            schedule.asset.next_retest_due_at = payload.due_at
    if "status" in updates and payload.status is not None:
        schedule.status = payload.status
    if (
        "reminder_interval_days" in updates
        and payload.reminder_interval_days is not None
    ):
        schedule.reminder_interval_days = payload.reminder_interval_days
    if (
        "escalation_interval_days" in updates
        and payload.escalation_interval_days is not None
    ):
        schedule.escalation_interval_days = payload.escalation_interval_days

    await record_update(
        session,
        schedule,
        actor_id=principal.user_id,
        action="retest_schedule.updated",
        before=before,
    )
    if asset_before is not None:
        await record_update(
            session,
            schedule.asset,
            actor_id=principal.user_id,
            action="asset.retest_due_synced",
            before=asset_before,
        )
    await session.commit()
    _set_etag(response, schedule.version)
    return _retest_schedule_read(schedule)


@router.get("/inspections", response_model=InspectionListResponse)
async def list_inspections(
    session: SessionDep,
    principal: PrincipalDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    inspection_type: str | None = None,
    result: str | None = None,
    asset_id: str | None = None,
    customer_id: str | None = None,
    product_id: str | None = None,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> InspectionListResponse:
    _require_asset_read(principal)
    statement = _inspection_statement()
    statement = _apply_asset_scope(statement, principal)
    if status_filter:
        statement = statement.where(Inspection.status == status_filter)
    if inspection_type:
        statement = statement.where(Inspection.inspection_type == inspection_type)
    if result:
        statement = statement.where(Inspection.result == result)
    if asset_id:
        statement = statement.where(Inspection.asset_id == asset_id)
    if customer_id:
        statement = statement.where(Asset.customer_id == customer_id)
    if product_id:
        statement = statement.where(Asset.product_id == product_id)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Asset.asset_number).like(search_pattern),
                func.lower(Asset.tag).like(search_pattern),
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
                func.lower(Inspection.inspector_user_id).like(search_pattern),
                func.lower(Inspection.reviewer_user_id).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Inspection,
        sort,
        frozenset(
            {
                "status",
                "inspection_type",
                "submitted_at",
                "approved_at",
                "created_at",
                "updated_at",
            }
        ),
        default="-created_at",
    )
    inspections = (await session.scalars(statement.offset(offset).limit(limit))).all()
    return InspectionListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_inspection_read(inspection) for inspection in inspections],
    )


@router.get("/inspections/{inspection_id}", response_model=InspectionRead)
async def get_inspection(
    inspection_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_asset_read(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    return _inspection_read(inspection)


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


@router.patch("/inspections/{inspection_id}", response_model=InspectionRead)
async def update_inspection(
    inspection_id: str,
    payload: InspectionUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_inspection_write(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.status != InspectionStatus.DRAFT.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only draft inspections can be edited",
        )

    updates = payload.model_dump(exclude_unset=True)
    if "result" in updates:
        before = inspection.to_audit_dict()
        inspection.result = _clean_optional(payload.result)
        await record_update(
            session,
            inspection,
            actor_id=principal.user_id,
            action="inspection.updated",
            before=before,
        )
    if payload.pressure_test is not None:
        await _upsert_pressure_test(
            session,
            payload.pressure_test,
            inspection=inspection,
            actor_id=principal.user_id,
        )

    await session.commit()
    loaded = await _get_inspection_or_404(session, inspection.id, principal)
    return _inspection_read(loaded)


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
    await emit_event(
        session,
        category=NotificationCategory.INSPECTION_SUBMITTED,
        aggregate_type="inspection",
        aggregate_id=inspection.id,
        payload={
            "inspection_id": inspection.id,
            "asset_id": inspection.asset.id,
            "asset_number": inspection.asset.asset_number,
            "customer_id": inspection.asset.customer_id,
            "reviewer_user_id": inspection.reviewer_user_id,
            "link": settings.public_base_url.rstrip("/"),
        },
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
    payload = _inspection_event_payload(inspection)
    await emit_event(
        session,
        category=NotificationCategory.INSPECTION_APPROVED,
        aggregate_type="inspection",
        aggregate_id=inspection.id,
        payload=payload,
    )
    # A failed result is a safety event to the customer/owner/reviewer.
    if (inspection.result or "").upper() in {"FAIL", "FAILED"}:
        await emit_event(
            session,
            category=NotificationCategory.INSPECTION_FAILED,
            aggregate_type="inspection",
            aggregate_id=inspection.id,
            payload={**payload, "reviewer_user_id": principal.user_id},
        )
    await session.commit()
    return _inspection_read(inspection)


@router.post("/inspections/{inspection_id}/reject", response_model=InspectionRead)
async def reject_inspection(
    inspection_id: str,
    payload: InspectionRejectRequest,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_certificate_approve(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.status != InspectionStatus.SUBMITTED.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Inspection must be submitted before rejection",
        )

    before = inspection.to_audit_dict()
    inspection.status = InspectionStatus.REJECTED.value
    inspection.reviewer_user_id = principal.user_id
    inspection.rejected_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.rejected",
        before=before,
    )
    event_payload = _inspection_event_payload(inspection)
    event_payload["reason"] = (payload.reason or "").strip()
    await emit_event(
        session,
        category=NotificationCategory.INSPECTION_REJECTED,
        aggregate_type="inspection",
        aggregate_id=inspection.id,
        payload=event_payload,
    )
    await session.commit()
    return _inspection_read(inspection)


def _inspection_event_payload(inspection: Inspection) -> dict[str, object]:
    asset = inspection.asset
    return {
        "inspection_id": inspection.id,
        "asset_id": asset.id if asset else None,
        "asset_number": asset.asset_number if asset else None,
        "customer_id": asset.customer_id if asset else None,
        "inspector_user_id": inspection.inspector_user_id,
        "reviewer_user_id": inspection.reviewer_user_id,
        "link": settings.public_base_url.rstrip("/"),
    }


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
    if inspection.status != InspectionStatus.APPROVED.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="certificate can only be issued from an approved inspection",
        )

    if payload.pdf_object_key:
        # Legacy path: caller brings a pre-rendered artifact + hash (imports).
        issued_at = datetime.now(UTC).replace(microsecond=0)
        number = (payload.number or "").strip() or generate_certificate_number(
            inspection, issued_at
        )
        public_token = (payload.public_token or "").strip() or generate_public_token()
        verification_hash = (payload.verification_hash or "").strip()
        if not verification_hash:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="verification_hash is required when pdf_object_key is supplied",
            )
        try:
            certificate = Certificate.issue_from_inspection(
                inspection,
                number=number,
                pdf_object_key=payload.pdf_object_key.strip(),
                verification_hash=verification_hash,
                public_token=public_token,
                issued_by_user_id=principal.user_id,
                valid_until=payload.valid_until,
            )
        except CertificateIssueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
        certificate.issued_at = issued_at
        session.add(certificate)
        await record_create(
            session,
            certificate,
            actor_id=principal.user_id,
            action="certificate.issued",
        )
    else:
        # Standard path: render + sign via the certificate engine, then store.
        try:
            certificate = await generate_and_store_certificate(
                session,
                inspection,
                actor_id=principal.user_id,
                valid_until=payload.valid_until,
                number=payload.number,
                public_token=payload.public_token,
                engine=get_certificate_engine(),
            )
        except CertificateEngineError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Certificate engine unavailable: {exc}",
            ) from exc
        except (
            CertificateAlreadyIssuedError,
            InspectionNotApprovedError,
            AssetNotCertifiableError,
            CertificateIssueError,
        ) as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc

    await session.commit()
    return _certificate_read(certificate)


@router.get("/certificates", response_model=CertificateListResponse)
async def list_certificates(
    session: SessionDep,
    principal: PrincipalDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    asset_id: str | None = None,
    customer_id: str | None = None,
    product_id: str | None = None,
    inspection_id: str | None = None,
    valid_from: date | None = None,
    valid_to: date | None = None,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> CertificateListResponse:
    _require_asset_read(principal)
    statement = _certificate_statement()
    statement = _apply_asset_scope(statement, principal)
    if status_filter:
        statement = statement.where(Certificate.status == status_filter)
    if asset_id:
        statement = statement.where(Certificate.asset_id == asset_id)
    if customer_id:
        statement = statement.where(Asset.customer_id == customer_id)
    if product_id:
        statement = statement.where(Asset.product_id == product_id)
    if inspection_id:
        statement = statement.where(Certificate.inspection_id == inspection_id)
    if valid_from:
        statement = statement.where(Certificate.valid_until >= valid_from)
    if valid_to:
        statement = statement.where(Certificate.valid_until <= valid_to)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Certificate.number).like(search_pattern),
                func.lower(Certificate.pdf_object_key).like(search_pattern),
                func.lower(Certificate.verification_hash).like(search_pattern),
                func.lower(Certificate.public_token).like(search_pattern),
                func.lower(Certificate.issued_by_user_id).like(search_pattern),
                func.lower(Asset.asset_number).like(search_pattern),
                func.lower(Asset.tag).like(search_pattern),
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Certificate,
        sort,
        frozenset(
            {
                "number",
                "status",
                "issued_at",
                "valid_until",
                "created_at",
                "updated_at",
            }
        ),
        default="-issued_at",
    )
    certificates = (
        await session.scalars(statement.offset(offset).limit(limit))
    ).all()
    return CertificateListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_certificate_read(certificate) for certificate in certificates],
    )


@router.get("/certificates/{certificate_id}", response_model=CertificateRead)
async def get_certificate(
    certificate_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateRead:
    _require_asset_read(principal)
    certificate = await _get_certificate_or_404(session, certificate_id, principal)
    return _certificate_read(certificate)


@router.post("/certificates/{certificate_id}/revoke", response_model=CertificateRead)
async def revoke_certificate(
    certificate_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateRead:
    _require_certificate_approve(principal)
    certificate = await _get_certificate_or_404(session, certificate_id, principal)
    await _transition_certificate_status(
        session,
        certificate,
        actor_id=principal.user_id,
        action="certificate.revoked",
        next_status=CertificateStatus.REVOKED.value,
    )
    await emit_event(
        session,
        category=NotificationCategory.CERTIFICATE_REVOKED,
        aggregate_type="certificate",
        aggregate_id=certificate.id,
        payload={
            "customer_id": certificate.asset.customer_id,
            "asset_id": certificate.asset_id,
            "asset_number": certificate.asset.asset_number,
            "certificate_number": certificate.number,
            "link": settings.public_base_url.rstrip("/"),
        },
    )
    await session.commit()
    return _certificate_read(certificate)


@router.post("/certificates/{certificate_id}/supersede", response_model=CertificateRead)
async def supersede_certificate(
    certificate_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateRead:
    _require_certificate_approve(principal)
    certificate = await _get_certificate_or_404(session, certificate_id, principal)
    await _transition_certificate_status(
        session,
        certificate,
        actor_id=principal.user_id,
        action="certificate.superseded",
        next_status=CertificateStatus.SUPERSEDED.value,
    )
    await session.commit()
    return _certificate_read(certificate)


@router.get("/products", response_model=ProductListResponse)
async def list_products(
    session: SessionDep,
    principal: PrincipalDep,
    category: str | None = None,
    standard_code: str | None = None,
    enabled: bool | None = True,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> ProductListResponse:
    _require_asset_read(principal)
    statement = (
        select(Product)
        .options(selectinload(Product.standard))
        .where(Product.deleted_at.is_(None))
    )
    if enabled is not None:
        statement = statement.where(Product.enabled.is_(enabled))
    if category:
        statement = statement.where(func.lower(Product.category) == category.lower())
    if standard_code:
        statement = statement.where(
            Product.standard.has(func.lower(Standard.code) == standard_code.lower())
        )
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Product.code).like(search_pattern),
                func.lower(Product.name).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Product,
        sort,
        frozenset({"code", "name", "category", "created_at", "updated_at"}),
        default="code",
    )
    products = (
        await session.scalars(statement.offset(offset).limit(limit))
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
    response: Response,
    if_match: IfMatchHeader = None,
) -> ProductRead:
    _require_reference_admin(principal)
    product = await session.get(Product, product_id)
    if product is None or product.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )
    _enforce_if_match(if_match, product.version)

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
    _set_etag(response, product.version)
    return _product_read(product)


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_product(
    product_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    if_match: IfMatchHeader = None,
) -> Response:
    _require_reference_admin(principal)
    product = await _get_product_or_404(session, product_id)
    _enforce_if_match(if_match, product.version)
    await soft_delete(
        session,
        product,
        actor_id=principal.user_id,
        action="product.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/assets", response_model=AssetListResponse)
async def list_assets(
    session: SessionDep,
    principal: PrincipalDep,
    search: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    customer_id: str | None = None,
    product_id: str | None = None,
    location_id: str | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    sort: str | None = None,
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
    if product_id:
        statement = statement.where(Asset.product_id == product_id)
    if location_id:
        statement = statement.where(Asset.location_id == location_id)
    if status_filter:
        statement = statement.where(Asset.lifecycle_status == status_filter)
    if due_from:
        statement = statement.where(Asset.next_retest_due_at >= due_from)
    if due_to:
        statement = statement.where(Asset.next_retest_due_at <= due_to)
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
    statement = _apply_sort(
        statement,
        Asset,
        sort,
        frozenset(
            {
                "asset_number",
                "lifecycle_status",
                "next_retest_due_at",
                "created_at",
                "updated_at",
            }
        ),
        default="asset_number",
    )
    assets = (
        await session.scalars(statement.offset(offset).limit(limit))
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
    response: Response,
    if_match: IfMatchHeader = None,
) -> AssetRead:
    _require_asset_write(principal)
    asset = await _get_visible_asset_or_404(session, asset_id, principal)
    _enforce_if_match(if_match, asset.version)
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
    if "notes" in updates:
        asset.notes = _clean_optional(payload.notes)

    await record_update(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.updated",
        before=before,
    )
    # Safety event: newly condemned asset (spec §7 — Critical/safety).
    if (
        asset.lifecycle_status == "CONDEMNED"
        and before.get("lifecycle_status") != "CONDEMNED"
    ):
        await emit_event(
            session,
            category=NotificationCategory.ASSET_CONDEMNED,
            aggregate_type="asset",
            aggregate_id=asset.id,
            payload={
                "customer_id": asset.customer_id,
                "asset_id": asset.id,
                "asset_number": asset.asset_number,
                "link": settings.public_base_url.rstrip("/"),
            },
        )
    if "retest_schedule" in updates and payload.retest_schedule is not None:
        await _upsert_retest_schedule(
            session,
            payload.retest_schedule,
            asset=asset,
            customer=target_customer,
            actor_id=principal.user_id,
        )
    if "a_end" in updates:
        await _upsert_asset_end(
            session,
            payload.a_end,
            asset=asset,
            end="A",
            actor_id=principal.user_id,
        )
    if "b_end" in updates:
        await _upsert_asset_end(
            session,
            payload.b_end,
            asset=asset,
            end="B",
            actor_id=principal.user_id,
        )
    await session.commit()
    loaded = await _get_visible_asset_or_404(session, asset.id, principal)
    _set_etag(response, loaded.version)
    return _asset_read(loaded)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    if_match: IfMatchHeader = None,
) -> Response:
    _require_asset_write(principal)
    asset = await _get_visible_asset_or_404(session, asset_id, principal)
    _enforce_if_match(if_match, asset.version)
    await soft_delete(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/assets/{asset_id}", response_model=AssetRead)
async def get_asset(
    asset_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    response: Response,
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
    _set_etag(response, asset.version)
    return _asset_read(asset)


def _asset_statement() -> Select[tuple[Asset]]:
    return select(Asset).options(
        selectinload(Asset.customer),
        selectinload(Asset.location),
        selectinload(Asset.product),
        selectinload(Asset.ends),
        selectinload(Asset.retest_schedule),
    )


def _inspection_statement() -> Select[tuple[Inspection]]:
    return (
        select(Inspection)
        .join(Inspection.asset)
        .join(Asset.customer)
        .options(
            selectinload(Inspection.asset).selectinload(Asset.customer),
            selectinload(Inspection.asset).selectinload(Asset.product),
            selectinload(Inspection.pressure_test),
            selectinload(Inspection.certificate),
        )
        .where(
            Inspection.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
        )
    )


def _retest_schedule_statement() -> Select[tuple[RetestSchedule]]:
    return (
        select(RetestSchedule)
        .join(RetestSchedule.asset)
        .join(Asset.customer)
        .join(Asset.product)
        .options(
            selectinload(RetestSchedule.asset).selectinload(Asset.customer),
            selectinload(RetestSchedule.asset).selectinload(Asset.product),
            selectinload(RetestSchedule.customer),
        )
        .where(
            RetestSchedule.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
            Customer.deleted_at.is_(None),
        )
    )


def _certificate_statement() -> Select[tuple[Certificate]]:
    return (
        select(Certificate)
        .join(Certificate.asset)
        .join(Asset.customer)
        .join(Certificate.inspection)
        .options(
            selectinload(Certificate.asset).selectinload(Asset.customer),
            selectinload(Certificate.asset).selectinload(Asset.product),
            selectinload(Certificate.inspection),
        )
        .where(
            Certificate.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
            Inspection.deleted_at.is_(None),
        )
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


def _customer_statement() -> Select[tuple[Customer]]:
    return select(Customer).options(
        selectinload(Customer.locations),
        selectinload(Customer.contacts),
    )


def _apply_customer_scope[StatementT: Select[Any]](
    statement: StatementT,
    principal: Principal,
) -> StatementT:
    if not is_customer_scoped(principal):
        return statement
    if not principal.customer_ids:
        return statement.where(false())
    return statement.where(Customer.id.in_(principal.customer_ids))


def _customer_location_read(location: CustomerLocation) -> CustomerLocationRead:
    return CustomerLocationRead(
        id=location.id,
        name=location.name,
        address_1=location.address_1,
        address_2=location.address_2,
        city=location.city,
        state=location.state,
        country=location.country,
    )


def _customer_contact_read(contact: CustomerContact) -> CustomerContactRead:
    return CustomerContactRead(
        id=contact.id,
        name=contact.name,
        email=contact.email,
        phone=contact.phone,
        role=contact.role,
        receives_retest_reminders=contact.receives_retest_reminders,
    )


def _customer_read(customer: Customer) -> CustomerRead:
    locations = sorted(
        (
            location
            for location in customer.locations
            if location.deleted_at is None
        ),
        key=lambda location: location.name,
    )
    contacts = sorted(
        (contact for contact in customer.contacts if contact.deleted_at is None),
        key=lambda contact: contact.name,
    )
    return CustomerRead(
        id=customer.id,
        code=customer.code,
        name=customer.name,
        notes=customer.notes,
        retest_enabled=customer.retest_enabled,
        default_retest_months=customer.default_retest_months,
        locations=[_customer_location_read(location) for location in locations],
        contacts=[_customer_contact_read(contact) for contact in contacts],
    )


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


async def _get_visible_customer_or_404(
    session: AsyncSession,
    customer_id: str,
    principal: Principal,
) -> Customer:
    statement = _customer_statement().where(
        Customer.id == customer_id,
        Customer.deleted_at.is_(None),
    )
    statement = _apply_customer_scope(statement, principal)
    customer = (await session.scalars(statement)).first()
    if customer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found",
        )
    return customer


async def _get_visible_customer_location_or_404(
    session: AsyncSession,
    customer_id: str,
    location_id: str,
    principal: Principal,
) -> CustomerLocation:
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    location = await session.get(CustomerLocation, location_id)
    if (
        location is None
        or location.deleted_at is not None
        or location.customer_id != customer.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found",
        )
    return location


async def _get_visible_customer_contact_or_404(
    session: AsyncSession,
    customer_id: str,
    contact_id: str,
    principal: Principal,
) -> CustomerContact:
    customer = await _get_visible_customer_or_404(session, customer_id, principal)
    contact = await session.get(CustomerContact, contact_id)
    if (
        contact is None
        or contact.deleted_at is not None
        or contact.customer_id != customer.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Contact not found",
        )
    return contact


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


async def _get_retest_schedule_or_404(
    session: AsyncSession,
    schedule_id: str,
    principal: Principal,
) -> RetestSchedule:
    statement = _retest_schedule_statement().where(RetestSchedule.id == schedule_id)
    statement = _apply_asset_scope(statement, principal)
    schedule = (await session.scalars(statement)).first()
    if schedule is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Retest schedule not found",
        )
    return schedule


async def _get_inspection_or_404(
    session: AsyncSession,
    inspection_id: str,
    principal: Principal,
) -> Inspection:
    statement = _inspection_statement().where(Inspection.id == inspection_id)
    statement = _apply_asset_scope(statement, principal)
    inspection = (await session.scalars(statement)).first()
    if inspection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Inspection not found",
        )
    return inspection


async def _get_certificate_or_404(
    session: AsyncSession,
    certificate_id: str,
    principal: Principal,
) -> Certificate:
    statement = _certificate_statement().where(Certificate.id == certificate_id)
    statement = _apply_asset_scope(statement, principal)
    certificate = (await session.scalars(statement)).first()
    if certificate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Certificate not found",
        )
    return certificate


async def _transition_certificate_status(
    session: AsyncSession,
    certificate: Certificate,
    *,
    actor_id: str,
    action: str,
    next_status: str,
) -> None:
    if certificate.status != CertificateStatus.ISSUED.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only issued certificates can change lifecycle status",
        )

    before = certificate.to_audit_dict()
    certificate.status = next_status
    await record_update(
        session,
        certificate,
        actor_id=actor_id,
        action=action,
        before=before,
    )


async def _upsert_pressure_test(
    session: AsyncSession,
    payload: PressureTestWrite,
    *,
    inspection: Inspection,
    actor_id: str,
) -> None:
    pressure_test = inspection.pressure_test
    if pressure_test is None:
        pressure_test = PressureTestResult(
            inspection=inspection,
            applied_pressure_kpa=payload.applied_pressure_kpa,
            hold_time_seconds=payload.hold_time_seconds,
            passed=payload.passed,
            measurements=payload.measurements,
        )
        session.add(pressure_test)
        await record_create(
            session,
            pressure_test,
            actor_id=actor_id,
            action="pressure_test_result.created",
        )
        return

    before = pressure_test.to_audit_dict()
    pressure_test.applied_pressure_kpa = payload.applied_pressure_kpa
    pressure_test.hold_time_seconds = payload.hold_time_seconds
    pressure_test.passed = payload.passed
    pressure_test.measurements = payload.measurements
    await record_update(
        session,
        pressure_test,
        actor_id=actor_id,
        action="pressure_test_result.updated",
        before=before,
    )


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


async def _upsert_asset_end(
    session: AsyncSession,
    payload: AssetEndWrite | None,
    *,
    asset: Asset,
    end: str,
    actor_id: str,
) -> None:
    if payload is None:
        return

    fitting = _clean_optional(payload.fitting)
    size = _clean_optional(payload.size)
    existing = (
        await session.scalars(
            select(AssetEndConfiguration).where(
                AssetEndConfiguration.asset_id == asset.id,
                AssetEndConfiguration.end == end,
                AssetEndConfiguration.deleted_at.is_(None),
            )
        )
    ).first()
    if existing is None:
        if fitting is None and size is None:
            return
        configuration = AssetEndConfiguration(
            asset=asset,
            end=end,
            fitting=fitting,
            size=size,
        )
        session.add(configuration)
        await record_create(
            session,
            configuration,
            actor_id=actor_id,
            action="asset_end_configuration.created",
        )
        return

    before = existing.to_audit_dict()
    existing.fitting = fitting
    existing.size = size
    await record_update(
        session,
        existing,
        actor_id=actor_id,
        action="asset_end_configuration.updated",
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


def _retest_schedule_read(schedule: RetestSchedule) -> RetestScheduleRead:
    return RetestScheduleRead(
        id=schedule.id,
        asset_id=schedule.asset_id,
        customer_id=schedule.customer_id,
        due_at=schedule.due_at,
        status=schedule.status,
        reminder_interval_days=schedule.reminder_interval_days,
        escalation_interval_days=schedule.escalation_interval_days,
        last_reminded_at=schedule.last_reminded_at,
        escalated_at=schedule.escalated_at,
        asset=InspectionAssetSummary(
            id=schedule.asset.id,
            asset_number=schedule.asset.asset_number,
            tag=schedule.asset.tag,
            lifecycle_status=schedule.asset.lifecycle_status,
        ),
        customer=CustomerSummary(
            id=schedule.asset.customer.id,
            code=schedule.asset.customer.code,
            name=schedule.asset.customer.name,
        ),
        product=ProductSummary(
            id=schedule.asset.product.id,
            code=schedule.asset.product.code,
            name=schedule.asset.product.name,
            category=schedule.asset.product.category,
        ),
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
        asset=InspectionAssetSummary(
            id=inspection.asset.id,
            asset_number=inspection.asset.asset_number,
            tag=inspection.asset.tag,
            lifecycle_status=inspection.asset.lifecycle_status,
        ),
        customer=CustomerSummary(
            id=inspection.asset.customer.id,
            code=inspection.asset.customer.code,
            name=inspection.asset.customer.name,
        ),
        product=ProductSummary(
            id=inspection.asset.product.id,
            code=inspection.asset.product.code,
            name=inspection.asset.product.name,
            category=inspection.asset.product.category,
        ),
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
        asset=InspectionAssetSummary(
            id=certificate.asset.id,
            asset_number=certificate.asset.asset_number,
            tag=certificate.asset.tag,
            lifecycle_status=certificate.asset.lifecycle_status,
        ),
        customer=CustomerSummary(
            id=certificate.asset.customer.id,
            code=certificate.asset.customer.code,
            name=certificate.asset.customer.name,
        ),
        product=ProductSummary(
            id=certificate.asset.product.id,
            code=certificate.asset.product.code,
            name=certificate.asset.product.name,
            category=certificate.asset.product.category,
        ),
        inspection=CertificateInspectionSummary(
            id=certificate.inspection.id,
            inspection_type=certificate.inspection.inspection_type,
            status=certificate.inspection.status,
            result=certificate.inspection.result,
            approved_at=certificate.inspection.approved_at,
        ),
    )


def _asset_end_read(configuration: AssetEndConfiguration | None) -> AssetEndRead | None:
    if configuration is None:
        return None
    return AssetEndRead(
        fitting=configuration.fitting,
        size=configuration.size,
    )


def _asset_read(asset: Asset) -> AssetRead:
    ends = {
        configuration.end: configuration
        for configuration in asset.ends
        if configuration.deleted_at is None
    }
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
        notes=asset.notes,
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
                address_1=asset.location.address_1,
                address_2=asset.location.address_2,
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
        a_end=_asset_end_read(ends.get("A")),
        b_end=_asset_end_read(ends.get("B")),
    )
