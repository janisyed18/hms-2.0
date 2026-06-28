from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

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


class RetestScheduleWrite(BaseModel):
    due_at: date
    status: str
    reminder_interval_days: int = 30
    escalation_interval_days: int = 7


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


class AssetCreate(BaseModel):
    customer_id: str
    location_id: str | None = None
    product_id: str
    asset_number: str
    customer_serial_no: str | None = None
    tag: str | None = None
    lifecycle_status: str
    manufacture_date: date | None = None
    next_retest_due_at: date | None = None
    condemned_at: date | None = None
    length_m: Decimal | None = None
    retest_schedule: RetestScheduleWrite | None = None


class AssetUpdate(BaseModel):
    customer_id: str | None = None
    location_id: str | None = None
    product_id: str | None = None
    asset_number: str | None = None
    customer_serial_no: str | None = None
    tag: str | None = None
    lifecycle_status: str | None = None
    manufacture_date: date | None = None
    next_retest_due_at: date | None = None
    condemned_at: date | None = None
    length_m: Decimal | None = None
    retest_schedule: RetestScheduleWrite | None = None


class PressureTestWrite(BaseModel):
    applied_pressure_kpa: int
    hold_time_seconds: int
    passed: bool
    measurements: dict[str, Any] | None = None


class PressureTestRead(BaseModel):
    id: str
    applied_pressure_kpa: int
    hold_time_seconds: int
    passed: bool
    measurements: dict[str, Any] | None


class InspectionCreate(BaseModel):
    inspection_type: str
    result: str | None = None
    pressure_test: PressureTestWrite | None = None


class InspectionRead(BaseModel):
    id: str
    asset_id: str
    inspection_type: str
    status: str
    result: str | None
    inspector_user_id: str
    reviewer_user_id: str | None
    submitted_at: datetime | None
    approved_at: datetime | None
    rejected_at: datetime | None
    pressure_test: PressureTestRead | None


class CertificateCreate(BaseModel):
    number: str
    pdf_object_key: str
    verification_hash: str
    public_token: str
    valid_until: date | None = None


class CertificateRead(BaseModel):
    id: str
    inspection_id: str
    asset_id: str
    number: str
    certificate_version: int
    issued_at: datetime
    valid_until: date | None
    pdf_object_key: str
    verification_hash: str
    public_token: str
    issued_by_user_id: str
    status: str
