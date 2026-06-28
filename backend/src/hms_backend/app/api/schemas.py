from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class LookupRead(BaseModel):
    id: str
    code: str
    name: str


class StandardCreate(BaseModel):
    code: str
    name: str
    enabled: bool = True


class StandardUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    enabled: bool | None = None


class LookupListResponse(BaseModel):
    items: list[LookupRead]


class ProductRead(BaseModel):
    id: str
    code: str
    name: str
    category: str
    sub_category: str | None
    standard_code: str | None


class ProductListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[ProductRead]


class ProductCreate(BaseModel):
    category: str
    sub_category: str | None = None
    code: str
    name: str
    standard_id: str | None = None
    enabled: bool = True


class ProductUpdate(BaseModel):
    category: str | None = None
    sub_category: str | None = None
    code: str | None = None
    name: str | None = None
    standard_id: str | None = None
    enabled: bool | None = None


class CustomerSummary(BaseModel):
    id: str
    code: str
    name: str


class LocationSummary(BaseModel):
    id: str
    name: str
    city: str | None
    state: str | None
    country: str | None


class ProductSummary(BaseModel):
    id: str
    code: str
    name: str
    category: str


class RetestScheduleSummary(BaseModel):
    due_at: date
    status: str


class AssetRead(BaseModel):
    id: str
    asset_number: str
    customer_serial_no: str | None
    tag: str | None
    lifecycle_status: str
    manufacture_date: date | None
    next_retest_due_at: date | None
    condemned_at: date | None
    length_m: Decimal | None
    customer: CustomerSummary
    product: ProductSummary
    location: LocationSummary | None
    retest_schedule: RetestScheduleSummary | None


class AssetListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[AssetRead]
