from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel as PydanticBaseModel
from pydantic import ConfigDict, Field, field_validator, model_validator

from hms_backend.app.modules.inspections.measurements import (
    normalize_measurements,
    validate_inspection_result,
)


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(extra="forbid")


PpeRequirement = Literal[
    "High Vis",
    "Long Sleeve",
    "Long Pants",
    "Safety Boots",
    "Hard Hat",
    "Safety Glasses",
    "Gloves",
    "Ear Protection",
]
AdditionalRequirement = Literal[
    "2-way radio",
    "Vehicle flashing lights",
    "Vehicle Site Approval",
    "Mobile phone restrictions",
]


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


class AssetConfigurationLookupsRead(BaseModel):
    materials: list[LookupRead]
    couplings: list[LookupRead]
    coupling_add_ons: list[LookupRead]
    attach_methods: list[LookupRead]
    nominal_bores: list[LookupRead]


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
    site_contact_name: str | None
    site_contact_mobile: str | None
    site_contact_email: str | None
    ppe_requirements: list[PpeRequirement]
    additional_requirements: list[AdditionalRequirement]
    scheduling_timezone: str
    scheduling_open_time: str
    scheduling_close_time: str
    scheduling_weekdays: list[int]
    scheduling_blackout_dates: list[date]


class CustomerContactRead(BaseModel):
    id: str
    name: str
    email: str | None
    phone: str | None
    role: str | None
    receives_retest_reminders: bool


class CustomerMetricsRead(BaseModel):
    """Per-customer asset counts, aggregated by the server.

    ``asset_count`` is the number of assets assigned to the customer and visible to
    the caller, defined exactly as the asset list defines it (not deleted, any
    lifecycle status), so a customer card and the customer detail always agree.
    """

    asset_count: int
    in_service_count: int


class CustomerRead(BaseModel):
    id: str
    code: str
    name: str
    notes: str | None
    retest_enabled: bool
    default_retest_months: int | None
    locations: list[CustomerLocationRead]
    contacts: list[CustomerContactRead]
    metrics: CustomerMetricsRead


class CustomerListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[CustomerRead]


class LocationSchedulingValidation(BaseModel):
    @field_validator("scheduling_timezone", check_fields=False)
    @classmethod
    def validate_scheduling_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(
                "scheduling_timezone must be a valid IANA timezone"
            ) from exc
        return value

    @field_validator(
        "scheduling_open_time", "scheduling_close_time", check_fields=False
    )
    @classmethod
    def validate_scheduling_time(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = time.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("scheduling times must use HH:MM") from exc
        if parsed.second or parsed.microsecond:
            raise ValueError("scheduling times must use HH:MM")
        return value

    @field_validator("scheduling_weekdays", check_fields=False)
    @classmethod
    def validate_scheduling_weekdays(
        cls, value: list[int] | None
    ) -> list[int] | None:
        if value is None:
            return None
        if (
            not value
            or len(set(value)) != len(value)
            or any(day not in range(7) for day in value)
        ):
            raise ValueError(
                "scheduling_weekdays must contain unique values from 0 to 6"
            )
        return sorted(value)

    @field_validator("scheduling_blackout_dates", check_fields=False)
    @classmethod
    def validate_scheduling_blackout_dates(
        cls, value: list[date] | None
    ) -> list[date] | None:
        if value is None:
            return None
        if len(set(value)) != len(value):
            raise ValueError("scheduling_blackout_dates must not contain duplicates")
        return sorted(value)


class CustomerLocationWrite(LocationSchedulingValidation):
    id: str | None = None
    name: str = Field(min_length=1, max_length=160)
    site_contact_name: str | None = None
    site_contact_mobile: str | None = None
    site_contact_email: str | None = None
    ppe_requirements: list[PpeRequirement] | None = None
    additional_requirements: list[AdditionalRequirement] | None = None
    scheduling_timezone: str = "UTC"
    scheduling_open_time: str = "08:00"
    scheduling_close_time: str = "17:00"
    scheduling_weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    scheduling_blackout_dates: list[date] = Field(default_factory=list)


class CustomerCreate(BaseModel):
    code: str | None = None
    name: str
    notes: str | None = None
    retest_enabled: bool = False
    default_retest_months: int | None = None
    locations: list[CustomerLocationWrite] = Field(default_factory=list)


class CustomerUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    notes: str | None = None
    retest_enabled: bool | None = None
    default_retest_months: int | None = None
    locations: list[CustomerLocationWrite] | None = None


class CustomerLocationCreate(LocationSchedulingValidation):
    name: str
    address_1: str | None = None
    address_2: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    site_contact_name: str | None = None
    site_contact_mobile: str | None = None
    site_contact_email: str | None = None
    ppe_requirements: list[PpeRequirement] = Field(default_factory=list)
    additional_requirements: list[AdditionalRequirement] = Field(default_factory=list)
    scheduling_timezone: str = "UTC"
    scheduling_open_time: str = "08:00"
    scheduling_close_time: str = "17:00"
    scheduling_weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    scheduling_blackout_dates: list[date] = Field(default_factory=list)


class CustomerLocationUpdate(LocationSchedulingValidation):
    name: str | None = None
    address_1: str | None = None
    address_2: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    site_contact_name: str | None = None
    site_contact_mobile: str | None = None
    site_contact_email: str | None = None
    ppe_requirements: list[PpeRequirement] | None = None
    additional_requirements: list[AdditionalRequirement] | None = None
    scheduling_timezone: str | None = None
    scheduling_open_time: str | None = None
    scheduling_close_time: str | None = None
    scheduling_weekdays: list[int] | None = None
    scheduling_blackout_dates: list[date] | None = None


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
    scheduling_timezone: str


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
    nominal_bore: LookupRead | None = None
    material: LookupRead | None = None
    coupling: LookupRead | None = None
    coupling_add_on: LookupRead | None = None
    attach_method: LookupRead | None = None


class AssetEndWrite(BaseModel):
    fitting: str | None = None
    size: str | None = None
    nominal_bore_id: str | None = None
    material_id: str | None = None
    coupling_id: str | None = None
    coupling_add_on_id: str | None = None
    attach_method_id: str | None = None


class AssetInspectionHistoryRead(BaseModel):
    id: str
    inspection_type: str
    status: str
    result: str | None
    submitted_at: datetime | None
    approved_at: datetime | None


class AssetCertificateHistoryRead(BaseModel):
    id: str
    number: str
    certificate_version: int
    status: str
    issued_at: datetime
    valid_until: date | None


class AssetPressureRatingRead(BaseModel):
    """The product's rated pressures for this asset's nominal bore."""

    nominal_bore_id: str
    working_pressure_kpa: int
    test_pressure_kpa: int


class AssetRead(BaseModel):
    id: str
    asset_number: str
    asset_name: str | None
    customer_serial_no: str | None
    purchase_order_number: str | None
    tag: str | None
    lifecycle_status: str
    manufacture_date: date | None
    installation_date: date | None
    grave_date: date | None
    next_retest_due_at: date | None
    condemned_at: date | None
    length_m: Decimal | None
    notes: str | None
    description: str | None
    customer: CustomerSummary
    product: ProductSummary
    location: LocationSummary | None
    retest_schedule: RetestScheduleSummary | None
    a_end: AssetEndRead | None
    b_end: AssetEndRead | None
    # None when the product has no rating for the asset's bore (or the asset has no
    # bore): callers must then ask for the pressures rather than assume defaults.
    pressure_rating: AssetPressureRatingRead | None = None
    inspection_history: list[AssetInspectionHistoryRead] = Field(default_factory=list)
    certificate_history: list[AssetCertificateHistoryRead] = Field(default_factory=list)


class AssetListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[AssetRead]


class AssetCreate(BaseModel):
    customer_id: str
    location_id: str | None = None
    product_id: str
    asset_number: str | None = None
    asset_name: str | None = None
    customer_serial_no: str | None = None
    serial_number: str | None = None
    purchase_order_number: str | None = None
    tag: str | None = None
    lifecycle_status: str = "IN_SERVICE"
    manufacture_date: date | None = None
    installation_date: date | None = None
    grave_date: date | None = None
    next_retest_due_at: date | None = None
    next_inspection_date: date | None = None
    condemned_at: date | None = None
    length_m: Decimal | None = None
    notes: str | None = None
    description: str | None = None
    material_id: str | None = None
    nominal_bore_id: str | None = None
    retest_schedule: RetestScheduleWrite | None = None
    a_end: AssetEndWrite | None = None
    b_end: AssetEndWrite | None = None


class AssetUpdate(BaseModel):
    customer_id: str | None = None
    location_id: str | None = None
    product_id: str | None = None
    asset_number: str | None = None
    asset_name: str | None = None
    customer_serial_no: str | None = None
    serial_number: str | None = None
    purchase_order_number: str | None = None
    tag: str | None = None
    lifecycle_status: str | None = None
    manufacture_date: date | None = None
    installation_date: date | None = None
    grave_date: date | None = None
    next_retest_due_at: date | None = None
    next_inspection_date: date | None = None
    condemned_at: date | None = None
    length_m: Decimal | None = None
    notes: str | None = None
    description: str | None = None
    material_id: str | None = None
    nominal_bore_id: str | None = None
    retest_schedule: RetestScheduleWrite | None = None
    a_end: AssetEndWrite | None = None
    b_end: AssetEndWrite | None = None


class PressureTestWrite(BaseModel):
    applied_pressure_kpa: int
    hold_time_seconds: int
    passed: bool
    measurements: dict[str, Any] | None = None

    @field_validator("measurements")
    @classmethod
    def validate_measurements(
        cls, value: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        return normalize_measurements(value)

    @model_validator(mode="after")
    def validate_test_duration(self) -> PressureTestWrite:
        minutes = (self.measurements or {}).get("test_duration_minutes")
        if minutes is not None and self.hold_time_seconds != minutes * 60:
            raise ValueError("test_duration_minutes must match hold_time_seconds")
        return self


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

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: str | None) -> str | None:
        # A blank result means "not set", as the endpoints always treated it.
        return validate_inspection_result(value if value and value.strip() else None)


class InspectionUpdate(BaseModel):
    result: str | None = None
    pressure_test: PressureTestWrite | None = None

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: str | None) -> str | None:
        # A blank result means "not set", as the endpoints always treated it.
        return validate_inspection_result(value if value and value.strip() else None)


class InspectionRejectRequest(BaseModel):
    reason: str | None = None


class InspectionBookingCreate(BaseModel):
    customer_id: str
    location_id: str
    asset_ids: list[str] = Field(min_length=1)
    availability_quote_id: str
    additional_information: str | None = None


class InspectionBookingApproval(BaseModel):
    inspector_user_id: str


class InspectionBookingRejectRequest(BaseModel):
    reason: str | None = None


class InspectionBookingCancelRequest(BaseModel):
    reason: str | None = None


class InspectionAvailabilityRead(BaseModel):
    quote_id: str
    starts_at: datetime
    ends_at: datetime
    expires_at: datetime


class InspectionAvailabilityListResponse(BaseModel):
    items: list[InspectionAvailabilityRead]


class InspectionAppointmentRead(BaseModel):
    id: str
    status: str
    starts_at: datetime
    ends_at: datetime
    revision_number: int
    timezone_id: str
    local_start_snapshot: str
    local_end_snapshot: str
    utc_offset_start: str
    utc_offset_end: str
    tzdata_version: str


class InspectionAppointmentChangeRequestCreate(BaseModel):
    availability_quote_id: str
    reason: str | None = None
    inspector_user_id: str | None = None
    emergency: bool = False


class InspectionAppointmentChangeRequestApproval(BaseModel):
    inspector_user_id: str


class InspectionAppointmentChangeRequestRead(BaseModel):
    id: str
    status: str
    starts_at: datetime
    ends_at: datetime
    reason: str | None
    emergency: bool
    created_at: datetime


class InspectionAssetSummary(BaseModel):
    id: str
    asset_number: str
    asset_name: str | None = None
    tag: str | None
    lifecycle_status: str


class InspectionBookingRead(BaseModel):
    id: str
    customer: CustomerSummary
    location: LocationSummary
    assets: list[InspectionAssetSummary]
    scheduled_at: datetime
    scheduled_end_at: datetime | None
    additional_information: str | None
    status: str
    requested_by_user_id: str
    inspector_user_id: str | None
    reviewed_by_user_id: str | None
    reviewed_at: datetime | None
    rejection_reason: str | None
    created_at: datetime
    appointment: InspectionAppointmentRead | None = None
    change_requests: list[InspectionAppointmentChangeRequestRead] = []


class InspectionBookingListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[InspectionBookingRead]


class ScheduleInspectorRead(BaseModel):
    id: str
    display_name: str


class InspectionScheduleResponse(BaseModel):
    """Bookings overlapping ``[start, end)``, plus who the inspectors in them are."""

    start: datetime
    end: datetime
    total: int
    limit: int
    items: list[InspectionBookingRead]
    inspectors: list[ScheduleInspectorRead]


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
    inspector_user_id: str | None
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
    # Authenticity of the document: VERIFIED (genuine and unmodified, even if revoked
    # or expired), LEGACY_UNVERIFIED (no integrity evidence) or FAILED (tampered).
    # Whether it may still be relied on is ``valid``.
    integrity: str
    hash_matches: bool
    artifact_verified: bool
    # True only when the PDF signature was validated against the trust anchor.
    signed: bool
    expired: bool
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
    customer_ids: list[str] = Field(default_factory=list)
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
    next_after: str | None = None


class UserCreate(BaseModel):
    email: str
    # Required for new users so every account has a name to show; legacy users without
    # one stay readable and editable (UserUpdate keeps these optional).
    first_name: str
    last_name: str
    role: str
    customer_id: str | None = None
    customer_ids: list[str] | None = None
    # Local users get a server-generated subject; an explicit one is accepted only
    # for provisioning an external-IdP identity.
    oidc_subject: str | None = None

    @field_validator("first_name", "last_name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("must not be blank")
        return cleaned


class UserSummary(BaseModel):
    total: int
    by_role: dict[str, int]
    active: int
    locked: int
    disabled: int
    mfa_enabled: int
    mfa_setup_required: int


class UserUpdate(BaseModel):
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    role: str | None = None
    customer_id: str | None = None
    customer_ids: list[str] | None = None


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
