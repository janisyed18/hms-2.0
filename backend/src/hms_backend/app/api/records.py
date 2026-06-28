from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    AssetListResponse,
    AssetRead,
    CustomerSummary,
    LocationSummary,
    LookupListResponse,
    LookupRead,
    ProductListResponse,
    ProductRead,
    ProductSummary,
    RetestScheduleSummary,
)
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard

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


async def _count(session: AsyncSession, statement: Select[Any]) -> int:
    count_statement = select(func.count()).select_from(
        statement.order_by(None).subquery()
    )
    return await session.scalar(count_statement) or 0


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


def _apply_asset_scope(
    statement: Select[tuple[Asset]],
    principal: Principal,
) -> Select[tuple[Asset]]:
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
