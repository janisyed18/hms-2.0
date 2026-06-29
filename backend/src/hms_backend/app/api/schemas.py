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


class CustomerLocationRead(BaseModel):
    id: str
    name: str
    address_1: str | None
    address_2: str | None
    city: str | None
    state: str | None
    country: str | None


class CustomerContactRead(BaseModel):
    id: str
    name: str
    email: str | None
    phone: str | None
    role: str | None
    receives_retest_reminders: bool


class CustomerRead(BaseModel):
    id: str
    code: str
    name: str
    retest_enabled: bool
    default_retest_months: int | None
    locations: list[CustomerLocationRead]
    contacts: list[CustomerContactRead]


class CustomerListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[CustomerRead]


class CustomerCreate(BaseModel):
    code: str
    name: str
    retest_enabled: bool = False
    default_retest_months: int | None = None


class CustomerUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    retest_enabled: bool | None = None
    default_retest_months: int | None = None


class CustomerLocationCreate(BaseModel):
    name: str
    address_1: str | None = None
    address_2: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None


class CustomerLocationUpdate(BaseModel):
    name: str | None = None
    address_1: str | None = None
    address_2: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None


class CustomerContactCreate(BaseModel):
    name: str
    email: str | None = None
    phone: str | None = None
    role: str | None = None
    receives_retest_reminders: bool = True


class CustomerContactUpdate(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    role: str | None = None
    receives_retest_reminders: bool | None = None


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


class InspectionUpdate(BaseModel):
    result: str | None = None
    pressure_test: PressureTestWrite | None = None


class InspectionAssetSummary(BaseModel):
    id: str
    asset_number: str
    tag: str | None
    lifecycle_status: str


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
    asset: InspectionAssetSummary
    customer: CustomerSummary
    product: ProductSummary
    pressure_test: PressureTestRead | None


class InspectionListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[InspectionRead]


class CertificateCreate(BaseModel):
    number: str
    pdf_object_key: str
    verification_hash: str
    public_token: str
    valid_until: date | None = None


class CertificateInspectionSummary(BaseModel):
    id: str
    inspection_type: str
    status: str
    result: str | None
    approved_at: datetime | None


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
    asset: InspectionAssetSummary
    customer: CustomerSummary
    product: ProductSummary
    inspection: CertificateInspectionSummary


class CertificateListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[CertificateRead]
