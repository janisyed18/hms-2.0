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
    notes: str | None
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
    notes: str | None = None
    retest_enabled: bool = False
    default_retest_months: int | None = None


class CustomerUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    notes: str | None = None
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
    address_1: str | None
    address_2: str | None
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


class RetestScheduleUpdate(BaseModel):
    due_at: date | None = None
    status: str | None = None
    reminder_interval_days: int | None = None
    escalation_interval_days: int | None = None


class AssetEndRead(BaseModel):
    fitting: str | None
    size: str | None


class AssetEndWrite(BaseModel):
    fitting: str | None = None
    size: str | None = None


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
    notes: str | None
    customer: CustomerSummary
    product: ProductSummary
    location: LocationSummary | None
    retest_schedule: RetestScheduleSummary | None
    a_end: AssetEndRead | None
    b_end: AssetEndRead | None


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
    notes: str | None = None
    retest_schedule: RetestScheduleWrite | None = None
    a_end: AssetEndWrite | None = None
    b_end: AssetEndWrite | None = None


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
    notes: str | None = None
    retest_schedule: RetestScheduleWrite | None = None
    a_end: AssetEndWrite | None = None
    b_end: AssetEndWrite | None = None


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


class InspectionRejectRequest(BaseModel):
    reason: str | None = None


class InspectionAssetSummary(BaseModel):
    id: str
    asset_number: str
    tag: str | None
    lifecycle_status: str


class RetestScheduleRead(BaseModel):
    id: str
    asset_id: str
    customer_id: str
    due_at: date
    status: str
    reminder_interval_days: int
    escalation_interval_days: int
    last_reminded_at: datetime | None
    escalated_at: datetime | None
    asset: InspectionAssetSummary
    customer: CustomerSummary
    product: ProductSummary


class RetestScheduleListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[RetestScheduleRead]


class RetestEscalationResponse(BaseModel):
    dispatched: int


class DashboardRetestRead(BaseModel):
    asset_id: str
    asset_number: str
    customer_name: str
    product_name: str
    due_at: date
    days_overdue: int
    status: str


class DashboardDueRead(BaseModel):
    asset_id: str
    asset_number: str
    customer_name: str
    due_at: date


class DashboardReviewRead(BaseModel):
    inspection_id: str
    asset_id: str
    asset_number: str
    inspection_type: str
    status: str
    result: str | None


class DashboardRead(BaseModel):
    total_assets: int
    total_customers: int
    in_service_assets: int
    due_soon_assets: int
    overdue_assets: int
    awaiting_review_inspections: int
    overdue_total: int
    overdue_limit: int
    overdue_offset: int
    overdue_retests: list[DashboardRetestRead]
    due_this_week: list[DashboardDueRead]
    awaiting_review: list[DashboardReviewRead]


class AnalyticsCertificateCoverageRead(BaseModel):
    covered_assets: int
    coverage_percent: int
    expiring_soon: int
    expired: int
    issued: int
    missing_assets: int


class AnalyticsFleetPostureRead(BaseModel):
    clear: int
    due_soon: int
    overdue: int


class AnalyticsInspectionOutcomeRead(BaseModel):
    inspection_type: str
    submitted: int
    approved: int
    rejected: int


class AnalyticsCustomerRiskRead(BaseModel):
    customer_id: str
    customer_name: str
    overdue: int
    due_soon: int
    risk: str


class AnalyticsOverviewRead(BaseModel):
    generated_at: datetime
    total_assets: int
    in_service_assets: int
    due_soon_assets: int
    overdue_assets: int
    awaiting_review_inspections: int
    fleet_posture: AnalyticsFleetPostureRead
    certificate_coverage: AnalyticsCertificateCoverageRead
    customer_risk: list[AnalyticsCustomerRiskRead]
    inspection_outcomes: list[AnalyticsInspectionOutcomeRead]


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
    # When these are omitted the server renders + signs the PDF via the
    # certificate engine and generates the object key, verification hash, and
    # public token itself (the normal path). Supplying pdf_object_key keeps the
    # legacy "bring your own artifact" behaviour for imports/backfills.
    number: str | None = None
    pdf_object_key: str | None = None
    verification_hash: str | None = None
    public_token: str | None = None
    valid_until: date | None = None


class CertificateVerifyResponse(BaseModel):
    """Public, unauthenticated verification result for a certificate token."""

    valid: bool
    status: str
    hash_matches: bool
    signed: bool
    certificate_number: str
    certificate_version: int
    issued_at: datetime
    valid_until: date | None
    verification_hash: str
    asset_number: str
    customer_name: str
    product_name: str
    standard_code: str | None
    inspection_result: str | None
    message: str


class BulkCertificateGenerateRequest(BaseModel):
    # Explicit inspection ids to generate certificates for. When omitted, the
    # server targets every eligible APPROVED inspection without a certificate
    # (respecting the caller's customer scope).
    inspection_ids: list[str] | None = None


class CertificateBatchJobRead(BaseModel):
    id: str
    status: str
    requested_by_user_id: str
    task_id: str | None
    total: int
    succeeded: int
    failed: int
    results: list[dict[str, Any]]
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class CertificateBatchJobListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[CertificateBatchJobRead]


# --- Notifications ---


class NotificationRead(BaseModel):
    id: str
    event_ref: str
    category: str
    tier: str
    channel: str
    recipient_type: str
    recipient_id: str
    recipient_address: str | None
    subject: str | None
    body: str
    status: str
    attempts: int
    provider_message_id: str | None
    error: str | None
    customer_id: str | None
    asset_id: str | None
    created_at: datetime
    sent_at: datetime | None
    read_at: datetime | None


class NotificationListResponse(BaseModel):
    total: int
    unread_total: int = 0
    limit: int
    offset: int
    items: list[NotificationRead]


class NotificationPreferenceItem(BaseModel):
    category: str
    channel: str
    opted_in: bool


class NotificationPreferenceUpdate(BaseModel):
    category: str
    channel: str
    opted_in: bool


class NotificationPreferenceListResponse(BaseModel):
    items: list[NotificationPreferenceItem]


class PhoneVerificationRequest(BaseModel):
    phone_e164: str


class PhoneVerificationConfirm(BaseModel):
    code: str


class MessageResponse(BaseModel):
    message: str
    ok: bool = True


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


class UserRead(BaseModel):
    id: str
    oidc_subject: str
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    customer_id: str | None
    account_status: str = "ACTIVE"
    must_change_password: bool = False
    mfa_enabled: bool = False
    locked_until: datetime | None = None
    last_login_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[UserRead]


class UserCreate(BaseModel):
    email: str
    first_name: str | None = None
    last_name: str | None = None
    role: str
    customer_id: str | None = None
    # Local users get a server-generated subject; an explicit one is accepted only
    # for provisioning an external-IdP identity.
    oidc_subject: str | None = None


class UserUpdate(BaseModel):
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    role: str | None = None
    customer_id: str | None = None


class UserCreateResult(BaseModel):
    user: UserRead
    temporary_password: str


class TemporaryPasswordResult(BaseModel):
    user_id: str
    temporary_password: str


class DeviceRead(BaseModel):
    device_id: str
    user_id: str
    platform: str
    app_version: str
    last_sync_at: datetime | None
    offline_window_days: int
    revoked: bool


class DeviceListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[DeviceRead]


class DeviceUpdate(BaseModel):
    offline_window_days: int | None = None
    revoked: bool | None = None


class AuditEventRead(BaseModel):
    sequence: int
    actor_id: str
    action: str
    entity: str
    entity_id: str
    before: dict[str, object] | None
    after: dict[str, object] | None
    timestamp: datetime
    hash: str


class AuditEventListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[AuditEventRead]
