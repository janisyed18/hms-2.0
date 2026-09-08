import type {
  ApiListResult,
  AdminUserFormValues,
  AdminUserCreateResult,
  AdminUserRecord,
  AnalyticsOverview,
  AdminUserUpdateValues,
  AssetConfigurationOptions,
  TemporaryPasswordResult,
  AssetEndValues,
  AssetLocationSummary,
  AssetFormValues,
  AssetRecord,
  AssetRetestSummary,
  AssetProductSummary,
  AuditEventRecord,
  CertificateIssueValues,
  CertificateRecord,
  CertificateStatus,
  CustomerContact,
  CustomerFormValues,
  CustomerLocation,
  CustomerRecord,
  DashboardRecord,
  DeviceRecord,
  DeviceUpdateValues,
  InspectionCreateValues,
  InspectionBookingCreateValues,
  InspectionBookingRecord,
  InspectionBookingStatus,
  InspectionRecord,
  InspectionStatus,
  InspectionType,
  InspectionUpdateValues,
  NotificationFeedResult,
  NotificationRecord,
  ProductFormValues,
  ProductRecord,
  PressureTestRecord,
  PressureTestValues,
  RecordSummary,
  ReferenceCatalogFormValues,
  ReferenceCatalogKey,
  ReferenceCatalogRecord,
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues,
  StaffPermission,
  StaffRole,
  StaffSession
} from "../domain/types";

interface ApiLocation {
  id: string;
  name: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  site_contact_name: string | null;
  site_contact_mobile: string | null;
  site_contact_email: string | null;
}

interface ApiContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  receives_retest_reminders: boolean;
}

interface ApiCustomer {
  id: string;
  code: string;
  name: string;
  notes: string | null;
  retest_enabled: boolean;
  default_retest_months: number | null;
  ppe_requirements?: string[];
  additional_requirements?: string[];
  locations: ApiLocation[];
  contacts: ApiContact[];
}

interface ApiCustomerList {
  total: number;
  limit: number;
  offset: number;
  items: ApiCustomer[];
}

interface ApiDashboardRetest {
  asset_id: string;
  asset_number: string;
  customer_name: string;
  product_name: string;
  due_at: string;
  days_overdue: number;
  status: string;
}

interface ApiDashboardDue {
  asset_id: string;
  asset_number: string;
  customer_name: string;
  due_at: string;
}

interface ApiDashboardReview {
  inspection_id: string;
  asset_id: string;
  asset_number: string;
  inspection_type: string;
  status: string;
  result: string | null;
}

interface ApiDashboard {
  total_assets: number;
  total_customers: number;
  in_service_assets: number;
  due_soon_assets: number;
  overdue_assets: number;
  awaiting_review_inspections: number;
  overdue_total: number;
  overdue_limit: number;
  overdue_offset: number;
  overdue_retests: ApiDashboardRetest[];
  due_this_week: ApiDashboardDue[];
  awaiting_review: ApiDashboardReview[];
}

interface ApiAnalyticsOverview {
  generated_at: string;
  total_assets: number;
  in_service_assets: number;
  due_soon_assets: number;
  overdue_assets: number;
  awaiting_review_inspections: number;
  fleet_posture: {
    clear: number;
    due_soon: number;
    overdue: number;
  };
  certificate_coverage: {
    covered_assets: number;
    coverage_percent: number;
    expiring_soon: number;
    expired: number;
    issued: number;
    missing_assets: number;
  };
  customer_risk: Array<{
    customer_id: string;
    customer_name: string;
    overdue: number;
    due_soon: number;
    risk: "HIGH" | "WATCH";
  }>;
  inspection_outcomes: Array<{
    inspection_type: string;
    submitted: number;
    approved: number;
    rejected: number;
  }>;
}

interface ApiRetestEscalation {
  dispatched: number;
}

interface ApiNotification {
  id: string;
  category: string;
  tier: string;
  subject: string | null;
  body: string;
  customer_id: string | null;
  asset_id: string | null;
  created_at: string;
  read_at: string | null;
}

interface ApiNotificationList {
  total: number;
  unread_total: number;
  limit: number;
  offset: number;
  items: ApiNotification[];
}

interface ApiReferenceStandard {
  id: string;
  code: string;
  name: string;
}

interface ApiReferenceStandardList {
  items: ApiReferenceStandard[];
}

interface ApiProduct {
  id: string;
  code: string;
  name: string;
  category: string;
  sub_category: string | null;
  standard_code: string | null;
}

interface ApiProductList {
  total: number;
  limit: number;
  offset: number;
  items: ApiProduct[];
}

interface ApiSummary {
  id: string;
  code: string;
  name: string;
}

interface ApiProductSummary extends ApiSummary {
  category: string;
}

interface ApiLocationSummary {
  id: string;
  name: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiAssetRetestSchedule {
  due_at: string;
  status: string;
}

interface ApiAssetEnd {
  fitting: string | null;
  size: string | null;
  nominal_bore?: ApiSummary | null;
  material?: ApiSummary | null;
  coupling?: ApiSummary | null;
  coupling_add_on?: ApiSummary | null;
  attach_method?: ApiSummary | null;
}

interface ApiAssetConfigurationOptions {
  materials: ApiSummary[];
  couplings: ApiSummary[];
  coupling_add_ons: ApiSummary[];
  attach_methods: ApiSummary[];
  nominal_bores: ApiSummary[];
}

interface ApiAsset {
  id: string;
  asset_number: string;
  asset_name?: string | null;
  customer_serial_no: string | null;
  purchase_order_number?: string | null;
  tag: string | null;
  lifecycle_status: string;
  manufacture_date: string | null;
  installation_date?: string | null;
  grave_date?: string | null;
  next_retest_due_at: string | null;
  condemned_at: string | null;
  length_m: string | null;
  notes: string | null;
  description?: string | null;
  customer: ApiSummary;
  product: ApiProductSummary;
  location: ApiLocationSummary | null;
  retest_schedule: ApiAssetRetestSchedule | null;
  a_end?: ApiAssetEnd | null;
  b_end?: ApiAssetEnd | null;
}

interface ApiAssetList {
  total: number;
  limit: number;
  offset: number;
  items: ApiAsset[];
}

interface ApiInspectionAssetSummary {
  id: string;
  asset_number: string;
  tag: string | null;
  lifecycle_status: string;
}

interface ApiPressureTest {
  id: string;
  applied_pressure_kpa: number;
  hold_time_seconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

interface ApiInspection {
  id: string;
  asset_id: string;
  inspection_type: InspectionType;
  status: InspectionStatus;
  result: string | null;
  inspector_user_id: string | null;
  reviewer_user_id: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
  pressure_test: ApiPressureTest | null;
}

interface ApiInspectionList {
  total: number;
  limit: number;
  offset: number;
  items: ApiInspection[];
}

interface ApiInspectionBooking {
  id: string;
  customer: ApiSummary;
  location: ApiLocationSummary;
  assets: ApiInspectionAssetSummary[];
  scheduled_at: string;
  additional_information: string | null;
  status: InspectionBookingStatus;
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

interface ApiInspectionBookingList {
  total: number;
  limit: number;
  offset: number;
  items: ApiInspectionBooking[];
}

interface ApiRetestSchedule {
  id: string;
  asset_id: string;
  customer_id: string;
  due_at: string;
  status: RetestScheduleStatus;
  reminder_interval_days: number;
  escalation_interval_days: number;
  last_reminded_at: string | null;
  escalated_at: string | null;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
}

interface ApiRetestScheduleList {
  total: number;
  limit: number;
  offset: number;
  items: ApiRetestSchedule[];
}

interface ApiCertificateInspectionSummary {
  id: string;
  inspection_type: InspectionType;
  status: InspectionStatus;
  result: string | null;
  approved_at: string | null;
}

interface ApiCertificate {
  id: string;
  inspection_id: string;
  asset_id: string;
  number: string;
  certificate_version: number;
  issued_at: string;
  valid_until: string | null;
  pdf_object_key: string;
  verification_hash: string;
  public_token: string;
  issued_by_user_id: string;
  status: CertificateStatus;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
  inspection: ApiCertificateInspectionSummary;
}

interface ApiCertificateList {
  total: number;
  limit: number;
  offset: number;
  items: ApiCertificate[];
}

interface ApiAdminUser {
  id: string;
  oidc_subject: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  customer_id: string | null;
  account_status?: "ACTIVE" | "LOCKED" | "DISABLED";
  must_change_password?: boolean;
  mfa_enabled?: boolean;
  locked_until?: string | null;
  last_login_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface ApiAdminUserList {
  total: number;
  limit: number;
  offset: number;
  items: ApiAdminUser[];
}

interface ApiAdminUserCreateResult {
  user: ApiAdminUser;
  temporary_password: string;
}

interface ApiTemporaryPasswordResult {
  user_id: string;
  temporary_password: string;
}

interface ApiDevice {
  device_id: string;
  user_id: string;
  platform: string;
  app_version: string;
  last_sync_at: string | null;
  offline_window_days: number;
  revoked: boolean;
}

interface ApiDeviceList {
  total: number;
  limit: number;
  offset: number;
  items: ApiDevice[];
}

interface ApiAuditEvent {
  sequence: number;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  timestamp: string;
  hash: string;
}

interface ApiAuditEventList {
  total: number;
  limit: number;
  offset: number;
  items: ApiAuditEvent[];
}

export interface HmsClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  identity?: {
    accessToken?: string;
    userId?: string;
    roles?: string;
    customerIds?: string;
  };
}

interface HmsRuntimeAuth {
  getAccessToken: () => string | null;
  refreshAccessToken: () => Promise<string>;
  onAuthFailure: () => void;
}

let runtimeAuth: HmsRuntimeAuth | null = null;

export function configureHmsRuntimeAuth(auth: HmsRuntimeAuth): () => void {
  runtimeAuth = auth;
  return () => {
    if (runtimeAuth === auth) {
      runtimeAuth = null;
    }
  };
}

interface ApiAuthSession {
  user_id: string;
  roles: string[];
  permissions: string[];
  customer_ids: string[];
  auth_mode: string;
}

interface ListCustomerOptions {
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListProductOptions {
  category?: string;
  standardCode?: string;
  enabled?: boolean;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListAssetOptions {
  search?: string;
  status?: string;
  customerId?: string;
  productId?: string;
  locationId?: string;
  dueFrom?: string;
  dueTo?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListInspectionOptions {
  search?: string;
  status?: InspectionStatus;
  inspectionType?: InspectionType;
  result?: string;
  assetId?: string;
  customerId?: string;
  productId?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListInspectionBookingOptions {
  status?: InspectionBookingStatus;
  customerId?: string;
  limit?: number;
  offset?: number;
}

interface ListRetestScheduleOptions {
  search?: string;
  status?: RetestScheduleStatus;
  assetId?: string;
  customerId?: string;
  productId?: string;
  dueFrom?: string;
  dueTo?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListCertificateOptions {
  search?: string;
  status?: CertificateStatus;
  assetId?: string;
  customerId?: string;
  productId?: string;
  inspectionId?: string;
  validFrom?: string;
  validTo?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListAdminUserOptions {
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListDeviceOptions {
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListAuditEventOptions {
  entity?: string;
  actorId?: string;
  action?: string;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface HmsApiResponse<T> {
  data: T;
  etag: string | null;
}

export class HmsApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.name = "HmsApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const defaultIdentity = {
  userId: "staff-ui-dev",
  roles: "HMS_ADMIN,INSPECTOR,REVIEWER"
};

function withEtag<TRecord extends object>(
  record: TRecord,
  etag: string | null
): TRecord & { etag: string | null } {
  return {
    ...record,
    etag
  };
}

function toLocation(location: ApiLocation): CustomerLocation {
  return {
    id: location.id,
    name: location.name,
    address1: location.address_1,
    address2: location.address_2,
    city: location.city,
    state: location.state,
    country: location.country,
    siteContactName: location.site_contact_name,
    siteContactMobile: location.site_contact_mobile,
    siteContactEmail: location.site_contact_email
  };
}

function toContact(contact: ApiContact): CustomerContact {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    role: contact.role,
    receivesRetestReminders: contact.receives_retest_reminders
  };
}

function toDashboard(dashboard: ApiDashboard): DashboardRecord {
  return {
    totalAssets: dashboard.total_assets,
    totalCustomers: dashboard.total_customers,
    inServiceAssets: dashboard.in_service_assets,
    dueSoonAssets: dashboard.due_soon_assets,
    overdueAssets: dashboard.overdue_assets,
    awaitingReviewInspections: dashboard.awaiting_review_inspections,
    overdueTotal: dashboard.overdue_total,
    overdueLimit: dashboard.overdue_limit,
    overdueOffset: dashboard.overdue_offset,
    overdueRetests: dashboard.overdue_retests.map((retest) => ({
      assetId: retest.asset_id,
      assetNumber: retest.asset_number,
      customerName: retest.customer_name,
      productName: retest.product_name,
      dueAt: retest.due_at,
      daysOverdue: retest.days_overdue,
      status: retest.status
    })),
    dueThisWeek: dashboard.due_this_week.map((item) => ({
      assetId: item.asset_id,
      assetNumber: item.asset_number,
      customerName: item.customer_name,
      dueAt: item.due_at
    })),
    awaitingReview: dashboard.awaiting_review.map((inspection) => ({
      inspectionId: inspection.inspection_id,
      assetId: inspection.asset_id,
      assetNumber: inspection.asset_number,
      inspectionType: inspection.inspection_type,
      status: inspection.status,
      result: inspection.result
    }))
  };
}

function toAnalyticsOverview(overview: ApiAnalyticsOverview): AnalyticsOverview {
  return {
    generatedAt: overview.generated_at,
    totalAssets: overview.total_assets,
    inServiceAssets: overview.in_service_assets,
    dueSoonAssets: overview.due_soon_assets,
    overdueAssets: overview.overdue_assets,
    awaitingReviewInspections: overview.awaiting_review_inspections,
    fleetPosture: {
      clear: overview.fleet_posture.clear,
      dueSoon: overview.fleet_posture.due_soon,
      overdue: overview.fleet_posture.overdue
    },
    certificateCoverage: {
      coveredAssets: overview.certificate_coverage.covered_assets,
      coveragePercent: overview.certificate_coverage.coverage_percent,
      expiringSoon: overview.certificate_coverage.expiring_soon,
      expired: overview.certificate_coverage.expired,
      issued: overview.certificate_coverage.issued,
      missingAssets: overview.certificate_coverage.missing_assets
    },
    customerRisk: overview.customer_risk.map((risk) => ({
      customerId: risk.customer_id,
      customerName: risk.customer_name,
      overdue: risk.overdue,
      dueSoon: risk.due_soon,
      risk: risk.risk
    })),
    inspectionOutcomes: overview.inspection_outcomes.map((outcome) => ({
      inspectionType: outcome.inspection_type,
      submitted: outcome.submitted,
      approved: outcome.approved,
      rejected: outcome.rejected
    }))
  };
}

function toNotification(notification: ApiNotification): NotificationRecord {
  return {
    id: notification.id,
    category: notification.category,
    tier: notification.tier,
    subject: notification.subject,
    body: notification.body,
    customerId: notification.customer_id,
    assetId: notification.asset_id,
    createdAt: notification.created_at,
    readAt: notification.read_at
  };
}

function toCustomer(customer: ApiCustomer, etag: string | null = null): CustomerRecord {
  return withEtag(
    {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        notes: customer.notes,
        retestEnabled: customer.retest_enabled,
        defaultRetestMonths: customer.default_retest_months,
        ppeRequirements: customer.ppe_requirements ?? [],
        additionalRequirements: customer.additional_requirements ?? [],
        locations: customer.locations.map(toLocation),
        contacts: customer.contacts.map(toContact),
        status: "Active",
        riskLevel: "Low",
        industry: "Marine Operations",
        paymentTerms: "Net 30",
        contractStart: "Not set",
        contractEnd: "Not set",
        lastActivity: "Synced",
        metrics: {
          assetCount: 0,
          inServiceCount: 0,
          outOfServiceCount: 0,
          inspectionDueCount: 0,
          inspectionDueLabel: "Not available",
          certificateValidPercent: 0,
          certificateStatusLabel: "Not available",
          recentInspections: [],
          activity: []
        }
      },
      etag
    )
}

function toReferenceCatalog(
  standard: ApiReferenceStandard,
  etag: string | null = null
): ReferenceCatalogRecord {
  return withEtag(
    {
      id: standard.id,
      code: standard.code,
      name: standard.name
    },
    etag
  );
}

function referenceCatalogPath(category: ReferenceCatalogKey): string {
  return `/api/v1/reference/catalog/${category}`;
}

function toProduct(product: ApiProduct, etag: string | null = null): ProductRecord {
  return withEtag(
    {
      id: product.id,
      code: product.code,
      name: product.name,
      category: product.category,
      subCategory: product.sub_category,
      standardCode: product.standard_code
    },
    etag
  );
}

function toSummary(summary: ApiSummary): RecordSummary {
  return {
    id: summary.id,
    code: summary.code,
    name: summary.name
  };
}

function toProductSummary(summary: ApiProductSummary): AssetProductSummary {
  return {
    id: summary.id,
    code: summary.code,
    name: summary.name,
    category: summary.category
  };
}

function toLocationSummary(
  location: ApiLocationSummary | null
): AssetLocationSummary | null {
  if (location === null) {
    return null;
  }
  return {
    id: location.id,
    name: location.name,
    address1: location.address_1,
    address2: location.address_2,
    city: location.city,
    state: location.state,
    country: location.country
  };
}

function toAssetRetestSummary(
  schedule: ApiAssetRetestSchedule | null
): AssetRetestSummary | null {
  if (schedule === null) {
    return null;
  }
  return {
    dueAt: schedule.due_at,
    status: schedule.status
  };
}

function toAssetEnd(end: ApiAssetEnd | null | undefined): AssetEndValues {
  return {
    fitting: end?.fitting ?? "",
    size: end?.size ?? "",
    nominalBore: end?.nominal_bore ? toSummary(end.nominal_bore) : null,
    material: end?.material ? toSummary(end.material) : null,
    coupling: end?.coupling ? toSummary(end.coupling) : null,
    couplingAddOn: end?.coupling_add_on ? toSummary(end.coupling_add_on) : null,
    attachMethod: end?.attach_method ? toSummary(end.attach_method) : null
  };
}

function toAssetConfigurationOptions(
  options: ApiAssetConfigurationOptions
): AssetConfigurationOptions {
  return {
    materials: options.materials.map(toSummary),
    couplings: options.couplings.map(toSummary),
    couplingAddOns: options.coupling_add_ons.map(toSummary),
    attachMethods: options.attach_methods.map(toSummary),
    nominalBores: options.nominal_bores.map(toSummary)
  };
}

function toAsset(asset: ApiAsset, etag: string | null = null): AssetRecord {
  return withEtag(
    {
      id: asset.id,
      assetNumber: asset.asset_number,
      assetName: asset.asset_name ?? asset.asset_number,
      customerSerialNo: asset.customer_serial_no,
      purchaseOrderNumber: asset.purchase_order_number ?? null,
      tag: asset.tag,
      lifecycleStatus: asset.lifecycle_status,
      manufactureDate: asset.manufacture_date,
      installationDate: asset.installation_date ?? null,
      graveDate: asset.grave_date ?? null,
      nextRetestDueAt: asset.next_retest_due_at,
      condemnedAt: asset.condemned_at,
      lengthM: asset.length_m,
      notes: asset.notes,
      description: asset.description ?? asset.notes,
      customer: toSummary(asset.customer),
      product: toProductSummary(asset.product),
      location: toLocationSummary(asset.location),
      retestSchedule: toAssetRetestSummary(asset.retest_schedule),
      aEnd: toAssetEnd(asset.a_end),
      bEnd: toAssetEnd(asset.b_end)
    },
    etag
  );
}

function toPressureTest(
  pressureTest: ApiPressureTest | null
): PressureTestRecord | null {
  if (pressureTest === null) {
    return null;
  }
  return {
    id: pressureTest.id,
    appliedPressureKpa: pressureTest.applied_pressure_kpa,
    holdTimeSeconds: pressureTest.hold_time_seconds,
    passed: pressureTest.passed,
    measurements: pressureTest.measurements
  };
}

function toInspection(
  inspection: ApiInspection,
  etag: string | null = null
): InspectionRecord {
  return withEtag(
    {
      id: inspection.id,
      assetId: inspection.asset_id,
      inspectionType: inspection.inspection_type,
      status: inspection.status,
      result: inspection.result,
      inspectorUserId: inspection.inspector_user_id,
      reviewerUserId: inspection.reviewer_user_id,
      submittedAt: inspection.submitted_at,
      approvedAt: inspection.approved_at,
      rejectedAt: inspection.rejected_at,
      asset: {
        id: inspection.asset.id,
        assetNumber: inspection.asset.asset_number,
        tag: inspection.asset.tag,
        lifecycleStatus: inspection.asset.lifecycle_status
      },
      customer: toSummary(inspection.customer),
      product: toProductSummary(inspection.product),
      pressureTest: toPressureTest(inspection.pressure_test)
    },
    etag
  );
}

function toInspectionBooking(booking: ApiInspectionBooking): InspectionBookingRecord {
  return {
    id: booking.id,
    customer: toSummary(booking.customer),
    location: toLocationSummary(booking.location)!,
    assets: booking.assets.map(toInspectionAssetSummary),
    scheduledAt: booking.scheduled_at,
    additionalInformation: booking.additional_information,
    status: booking.status,
    requestedByUserId: booking.requested_by_user_id,
    reviewedByUserId: booking.reviewed_by_user_id,
    reviewedAt: booking.reviewed_at,
    rejectionReason: booking.rejection_reason,
    createdAt: booking.created_at
  };
}

function toInspectionAssetSummary(
  asset: ApiInspectionAssetSummary
): InspectionRecord["asset"] {
  return {
    id: asset.id,
    assetNumber: asset.asset_number,
    tag: asset.tag,
    lifecycleStatus: asset.lifecycle_status
  };
}

function toRetestScheduleRecord(
  schedule: ApiRetestSchedule,
  etag: string | null = null
): RetestScheduleRecord {
  return withEtag(
    {
      id: schedule.id,
      assetId: schedule.asset_id,
      customerId: schedule.customer_id,
      dueAt: schedule.due_at,
      status: schedule.status,
      reminderIntervalDays: schedule.reminder_interval_days,
      escalationIntervalDays: schedule.escalation_interval_days,
      lastRemindedAt: schedule.last_reminded_at,
      escalatedAt: schedule.escalated_at,
      asset: toInspectionAssetSummary(schedule.asset),
      customer: toSummary(schedule.customer),
      product: toProductSummary(schedule.product)
    },
    etag
  );
}

function toCertificate(
  certificate: ApiCertificate,
  etag: string | null = null
): CertificateRecord {
  return withEtag(
    {
      id: certificate.id,
      inspectionId: certificate.inspection_id,
      assetId: certificate.asset_id,
      number: certificate.number,
      certificateVersion: certificate.certificate_version,
      issuedAt: certificate.issued_at,
      validUntil: certificate.valid_until,
      pdfObjectKey: certificate.pdf_object_key,
      verificationHash: certificate.verification_hash,
      publicToken: certificate.public_token,
      issuedByUserId: certificate.issued_by_user_id,
      status: certificate.status,
      asset: toInspectionAssetSummary(certificate.asset),
      customer: toSummary(certificate.customer),
      product: toProductSummary(certificate.product),
      inspection: {
        id: certificate.inspection.id,
        inspectionType: certificate.inspection.inspection_type,
        status: certificate.inspection.status,
        result: certificate.inspection.result,
        approvedAt: certificate.inspection.approved_at
      }
    },
    etag
  );
}

function displayName(user: ApiAdminUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
}

function toAdminUser(
  user: ApiAdminUser,
  etag: string | null = null
): AdminUserRecord {
  return withEtag(
    {
      id: user.id,
      oidcSubject: user.oidc_subject,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      displayName: displayName(user),
      role: user.role,
      customerId: user.customer_id,
      accountStatus: user.account_status ?? "ACTIVE",
      mustChangePassword: user.must_change_password ?? false,
      mfaEnabled: user.mfa_enabled ?? false,
      lockedUntil: user.locked_until ?? null,
      lastLoginAt: user.last_login_at ?? null,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    },
    etag
  );
}

function deviceState(device: ApiDevice): string {
  if (device.revoked) {
    return "Revoked";
  }
  return device.last_sync_at ? "Active" : "Pending";
}

function toDevice(device: ApiDevice, etag: string | null = null): DeviceRecord {
  return withEtag(
    {
      deviceId: device.device_id,
      displayName: device.device_id,
      userId: device.user_id,
      platform: device.platform,
      appVersion: device.app_version,
      lastSyncAt: device.last_sync_at,
      offlineWindowDays: device.offline_window_days,
      revoked: device.revoked,
      state: deviceState(device)
    },
    etag
  );
}

function toAuditEvent(event: ApiAuditEvent): AuditEventRecord {
  return {
    sequence: event.sequence,
    actorId: event.actor_id,
    action: event.action,
    entity: event.entity,
    entityId: event.entity_id,
    before: event.before,
    after: event.after,
    timestamp: event.timestamp,
    hash: event.hash
  };
}

function toStaffSession(session: ApiAuthSession): StaffSession {
  return {
    userId: session.user_id,
    displayName: session.user_id,
    roles: session.roles as StaffRole[],
    permissions: session.permissions as StaffPermission[],
    customerIds: session.customer_ids,
    authMode: session.auth_mode
  };
}

function pressureTestPayload(
  pressureTest: PressureTestValues | null
): Record<string, unknown> | null {
  if (pressureTest === null) {
    return null;
  }
  return {
    applied_pressure_kpa: pressureTest.appliedPressureKpa,
    hold_time_seconds: pressureTest.holdTimeSeconds,
    passed: pressureTest.passed,
    measurements: pressureTest.measurements
  };
}

function assetEndPayload(end: AssetEndValues): Record<string, string | null> {
  return {
    fitting: end.fitting.trim() || null,
    size: end.size.trim() || null,
    coupling_id: end.coupling?.id ?? null,
    coupling_add_on_id: end.couplingAddOn?.id ?? null,
    attach_method_id: end.attachMethod?.id ?? null
  };
}

function assetPayload(values: AssetFormValues) {
  return {
    customer_id: values.customerId,
    location_id: values.locationId,
    product_id: values.productId,
    asset_name: values.assetName,
    serial_number: values.serialNumber,
    description: values.description,
    purchase_order_number: values.purchaseOrderNumber || null,
    installation_date: values.installationDate,
    grave_date: values.graveDate,
    next_inspection_date: values.nextInspectionDate,
    length_m: values.lengthM,
    material_id: values.materialId,
    nominal_bore_id: values.nominalBoreId,
    retest_schedule: values.nextInspectionDate
      ? {
          due_at: values.nextInspectionDate,
          status: "UPCOMING"
        }
      : null,
    a_end: assetEndPayload(values.aEnd),
    b_end: assetEndPayload(values.bEnd)
  };
}

function certificateIssuePayload(values: CertificateIssueValues) {
  return {
    number: values.number,
    valid_until: values.validUntil
  };
}

function adminUserPayload(values: AdminUserFormValues) {
  return {
    ...(values.oidcSubject ? { oidc_subject: values.oidcSubject } : {}),
    email: values.email,
    first_name: values.firstName,
    last_name: values.lastName,
    role: values.role,
    customer_id: values.customerId
  };
}

function adminUserUpdatePayload(values: AdminUserUpdateValues) {
  return {
    ...(values.email !== undefined ? { email: values.email } : {}),
    ...(values.firstName !== undefined ? { first_name: values.firstName } : {}),
    ...(values.lastName !== undefined ? { last_name: values.lastName } : {}),
    ...(values.role !== undefined ? { role: values.role } : {}),
    ...(values.customerId !== undefined ? { customer_id: values.customerId } : {})
  };
}

function deviceUpdatePayload(values: DeviceUpdateValues) {
  return {
    ...(values.revoked !== undefined ? { revoked: values.revoked } : {}),
    ...(values.offlineWindowDays !== undefined
      ? { offline_window_days: values.offlineWindowDays }
      : {})
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  return `${baseUrl}${path}${query ? `?${query}` : ""}`;
}

function identityHeaders(options: HmsClientOptions): Record<string, string> {
  if (options.identity?.accessToken) {
    return {
      "Content-Type": "application/json",
      authorization: `Bearer ${options.identity.accessToken}`
    };
  }

  if (options.identity === undefined && runtimeAuth !== null) {
    const accessToken = runtimeAuth.getAccessToken();
    return {
      "Content-Type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    };
  }

  return {
    "Content-Type": "application/json",
    "x-hms-user-id": options.identity?.userId ?? defaultIdentity.userId,
    "x-hms-roles": options.identity?.roles ?? defaultIdentity.roles,
    ...(options.identity?.customerIds
      ? { "x-hms-customer-ids": options.identity.customerIds }
      : {})
  };
}

function readEtag(response: Response): string | null {
  return response.headers?.get("ETag") ?? response.headers?.get("etag") ?? null;
}

function ifMatchHeader(etag?: string | null): Record<string, string> {
  return etag ? { "If-Match": etag } : {};
}

function customerPayload(values: CustomerFormValues) {
  return {
    name: values.name.trim(),
    locations: values.locations.map((location) => ({
      ...(location.id ? { id: location.id } : {}),
      name: location.name.trim(),
      ...(location.siteContactName ? { site_contact_name: location.siteContactName.trim() } : {}),
      ...(location.siteContactMobile ? { site_contact_mobile: location.siteContactMobile.trim() } : {}),
      ...(location.siteContactEmail ? { site_contact_email: location.siteContactEmail.trim() } : {})
    })),
    phone: values.phone.trim() || null,
    email: values.email.trim() || null,
    ppe_requirements: values.ppeRequirements,
    additional_requirements: values.additionalRequirements
  };
}

export function createHmsClient(options: HmsClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<HmsApiResponse<T>> {
    const url = buildUrl(baseUrl, path, params);
    const send = () =>
      fetcher(url, {
        ...init,
        headers: {
          ...identityHeaders(options),
          ...init.headers
        }
      });
    let response = await send();
    if (response.status === 401 && options.identity === undefined && runtimeAuth !== null) {
      try {
        await runtimeAuth.refreshAccessToken();
        response = await send();
      } catch {
        runtimeAuth.onAuthFailure();
      }
      if (response.status === 401) {
        runtimeAuth.onAuthFailure();
      }
    }

    if (!response.ok) {
      let code = "http_error";
      let message = `HMS API request failed: ${response.status}`;
      let details: unknown = null;
      try {
        const body = (await response.json()) as {
          error?: {
            code?: string;
            message?: string;
            details?: unknown;
          };
          detail?: unknown;
        };
        if (body.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          details = body.error.details ?? null;
        } else if (typeof body.detail === "string") {
          message = body.detail;
        } else if (body.detail !== undefined) {
          details = body.detail;
        }
      } catch {
        // Keep the status-derived fallback when the body is unavailable.
      }
      throw new HmsApiError(response.status, code, message, details);
    }

    if (response.status === 204) {
      return {
        data: undefined as T,
        etag: readEtag(response)
      };
    }

    return {
      data: (await response.json()) as T,
      etag: readEtag(response)
    };
  }

  return {
    async getAuthSession(): Promise<StaffSession> {
      const response = await request<ApiAuthSession>("/api/v1/auth/me");
      return toStaffSession(response.data);
    },

    async getDashboard(limit = 5, offset = 0): Promise<DashboardRecord> {
      const response = await request<ApiDashboard>("/api/v1/dashboard", {}, { limit, offset });
      return toDashboard(response.data);
    },

    async getAnalyticsOverview(): Promise<AnalyticsOverview> {
      const response = await request<ApiAnalyticsOverview>("/api/v1/analytics/overview");
      return toAnalyticsOverview(response.data);
    },

    async escalateOverdueRetests(): Promise<number> {
      const response = await request<ApiRetestEscalation>(
        "/api/v1/retest-schedules/escalate-overdue",
        { method: "POST" }
      );
      return response.data.dispatched;
    },

    async listNotifications(): Promise<NotificationFeedResult> {
      const response = await request<ApiNotificationList>("/api/v1/notifications/me", {}, {
        limit: 12,
        offset: 0
      });
      return {
        total: response.data.total,
        unreadTotal: response.data.unread_total,
        items: response.data.items.map(toNotification)
      };
    },

    async markNotificationRead(id: string): Promise<NotificationRecord> {
      const response = await request<ApiNotification>(
        `/api/v1/notifications/${encodeURIComponent(id)}/read`,
        { method: "POST" }
      );
      return toNotification(response.data);
    },

    async listCustomers(
      searchOrOptions: string | ListCustomerOptions = {}
    ): Promise<ApiListResult<CustomerRecord>> {
      const listOptions =
        typeof searchOrOptions === "string"
          ? { search: searchOrOptions }
          : searchOrOptions;
      const response = await request<ApiCustomerList>("/api/v1/customers", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((customer) =>
          toCustomer(customer, response.etag)
        )
      };
    },

    async createCustomer(values: CustomerFormValues): Promise<CustomerRecord> {
      const response = await request<ApiCustomer>(
        "/api/v1/customers",
        {
          method: "POST",
          body: JSON.stringify(customerPayload(values))
        }
      );
      return toCustomer(response.data, response.etag);
    },

    async updateCustomer(
      id: string,
      values: CustomerFormValues,
      etag?: string | null
    ): Promise<CustomerRecord> {
      const response = await request<ApiCustomer>(
        `/api/v1/customers/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify(customerPayload(values))
        }
      );
      return toCustomer(response.data, response.etag);
    },

    async listProducts(
      listOptions: ListProductOptions = {}
    ): Promise<ApiListResult<ProductRecord>> {
      const response = await request<ApiProductList>("/api/v1/products", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        category: listOptions.category?.trim() || undefined,
        standard_code: listOptions.standardCode?.trim() || undefined,
        enabled: listOptions.enabled,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((product) =>
          toProduct(product, response.etag)
        )
      };
    },

    async createProduct(values: ProductFormValues): Promise<ProductRecord> {
      const response = await request<ApiProduct>(
        "/api/v1/products",
        {
          method: "POST",
          body: JSON.stringify({
            category: values.category,
            sub_category: values.subCategory,
            code: values.code,
            name: values.name,
            standard_id: values.standardId,
            enabled: true
          })
        }
      );
      return toProduct(response.data, response.etag);
    },

    async updateProduct(
      id: string,
      values: ProductFormValues,
      etag?: string | null
    ): Promise<ProductRecord> {
      const response = await request<ApiProduct>(
        `/api/v1/products/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            category: values.category,
            sub_category: values.subCategory,
            code: values.code,
            name: values.name,
            standard_id: values.standardId,
            enabled: true
          })
        }
      );
      return toProduct(response.data, response.etag);
    },

    async listAssets(
      listOptions: ListAssetOptions = {}
    ): Promise<ApiListResult<AssetRecord>> {
      const response = await request<ApiAssetList>("/api/v1/assets", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        status: listOptions.status,
        customer_id: listOptions.customerId,
        product_id: listOptions.productId,
        location_id: listOptions.locationId,
        due_from: listOptions.dueFrom,
        due_to: listOptions.dueTo,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((asset) => toAsset(asset, response.etag))
      };
    },

    async getAsset(id: string): Promise<AssetRecord> {
      const response = await request<ApiAsset>(
        `/api/v1/assets/${encodeURIComponent(id)}`
      );
      return toAsset(response.data, response.etag);
    },

    async getAssetConfigurationOptions(): Promise<AssetConfigurationOptions> {
      const response = await request<ApiAssetConfigurationOptions>(
        "/api/v1/reference/asset-configuration"
      );
      return toAssetConfigurationOptions(response.data);
    },

    async createAsset(values: AssetFormValues): Promise<AssetRecord> {
      const response = await request<ApiAsset>(
        "/api/v1/assets",
        {
          method: "POST",
          body: JSON.stringify(assetPayload(values))
        }
      );
      return toAsset(response.data, response.etag);
    },

    async updateAsset(
      id: string,
      values: AssetFormValues,
      etag?: string | null
    ): Promise<AssetRecord> {
      const response = await request<ApiAsset>(
        `/api/v1/assets/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify(assetPayload(values))
        }
      );
      return toAsset(response.data, response.etag);
    },

    async listInspections(
      listOptions: ListInspectionOptions = {}
    ): Promise<ApiListResult<InspectionRecord>> {
      const response = await request<ApiInspectionList>("/api/v1/inspections", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        status: listOptions.status,
        inspection_type: listOptions.inspectionType,
        result: listOptions.result?.trim() || undefined,
        asset_id: listOptions.assetId,
        customer_id: listOptions.customerId,
        product_id: listOptions.productId,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((inspection) =>
          toInspection(inspection, response.etag)
        )
      };
    },

    async listInspectionBookings(
      listOptions: ListInspectionBookingOptions = {}
    ): Promise<ApiListResult<InspectionBookingRecord>> {
      const response = await request<ApiInspectionBookingList>(
        "/api/v1/inspection-bookings",
        {},
        {
          limit: listOptions.limit ?? 50,
          offset: listOptions.offset ?? 0,
          status: listOptions.status,
          customer_id: listOptions.customerId
        }
      );
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map(toInspectionBooking)
      };
    },

    async createInspectionBooking(
      values: InspectionBookingCreateValues
    ): Promise<InspectionBookingRecord> {
      const response = await request<ApiInspectionBooking>(
        "/api/v1/inspection-bookings",
        {
          method: "POST",
          body: JSON.stringify({
            customer_id: values.customerId,
            location_id: values.locationId,
            asset_ids: values.assetIds,
            scheduled_at: values.scheduledAt,
            additional_information: values.additionalInformation
          })
        }
      );
      return toInspectionBooking(response.data);
    },

    async approveInspectionBooking(id: string): Promise<InspectionBookingRecord> {
      const response = await request<ApiInspectionBooking>(
        `/api/v1/inspection-bookings/${encodeURIComponent(id)}/approve`,
        { method: "POST" }
      );
      return toInspectionBooking(response.data);
    },

    async rejectInspectionBooking(
      id: string,
      reason: string | null = null
    ): Promise<InspectionBookingRecord> {
      const response = await request<ApiInspectionBooking>(
        `/api/v1/inspection-bookings/${encodeURIComponent(id)}/reject`,
        {
          method: "POST",
          body: JSON.stringify({ reason })
        }
      );
      return toInspectionBooking(response.data);
    },

    async createInspection(
      values: InspectionCreateValues
    ): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/assets/${encodeURIComponent(values.assetId)}/inspections`,
        {
          method: "POST",
          body: JSON.stringify({
            inspection_type: values.inspectionType,
            result: values.result,
            pressure_test: pressureTestPayload(values.pressureTest)
          })
        }
      );
      return toInspection(response.data, response.etag);
    },

    async updateInspection(
      id: string,
      values: InspectionUpdateValues
    ): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            result: values.result,
            pressure_test: pressureTestPayload(values.pressureTest)
          })
        }
      );
      return toInspection(response.data, response.etag);
    },

    async submitInspection(id: string): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}/submit`,
        {
          method: "POST"
        }
      );
      return toInspection(response.data, response.etag);
    },

    async approveInspection(id: string): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}/approve`,
        {
          method: "POST"
        }
      );
      return toInspection(response.data, response.etag);
    },

    async listRetestSchedules(
      listOptions: ListRetestScheduleOptions = {}
    ): Promise<ApiListResult<RetestScheduleRecord>> {
      const response = await request<ApiRetestScheduleList>(
        "/api/v1/retest-schedules",
        {},
        {
          limit: listOptions.limit ?? 50,
          offset: listOptions.offset ?? 0,
          status: listOptions.status,
          asset_id: listOptions.assetId,
          customer_id: listOptions.customerId,
          product_id: listOptions.productId,
          due_from: listOptions.dueFrom,
          due_to: listOptions.dueTo,
          search: listOptions.search?.trim() || undefined,
          sort: listOptions.sort
        }
      );
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((schedule) =>
          toRetestScheduleRecord(schedule, response.etag)
        )
      };
    },

    async updateRetestSchedule(
      id: string,
      values: RetestScheduleUpdateValues,
      etag?: string | null
    ): Promise<RetestScheduleRecord> {
      const response = await request<ApiRetestSchedule>(
        `/api/v1/retest-schedules/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            due_at: values.dueAt,
            status: values.status,
            reminder_interval_days: values.reminderIntervalDays,
            escalation_interval_days: values.escalationIntervalDays
          })
        }
      );
      return toRetestScheduleRecord(response.data, response.etag);
    },

    async listCertificates(
      listOptions: ListCertificateOptions = {}
    ): Promise<ApiListResult<CertificateRecord>> {
      const response = await request<ApiCertificateList>("/api/v1/certificates", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        status: listOptions.status,
        asset_id: listOptions.assetId,
        customer_id: listOptions.customerId,
        product_id: listOptions.productId,
        inspection_id: listOptions.inspectionId,
        valid_from: listOptions.validFrom,
        valid_to: listOptions.validTo,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((certificate) =>
          toCertificate(certificate, response.etag)
        )
      };
    },

    async issueCertificate(
      values: CertificateIssueValues
    ): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/inspections/${encodeURIComponent(values.inspectionId)}/certificate`,
        {
          method: "POST",
          body: JSON.stringify(certificateIssuePayload(values))
        }
      );
      return toCertificate(response.data, response.etag);
    },

    async revokeCertificate(id: string): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/certificates/${encodeURIComponent(id)}/revoke`,
        {
          method: "POST"
        }
      );
      return toCertificate(response.data, response.etag);
    },

    async supersedeCertificate(id: string): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/certificates/${encodeURIComponent(id)}/supersede`,
        {
          method: "POST"
        }
      );
      return toCertificate(response.data, response.etag);
    },

    async listReferenceCatalog(
      category: ReferenceCatalogKey
    ): Promise<ApiListResult<ReferenceCatalogRecord>> {
      const response = await request<ApiReferenceStandardList>(
        referenceCatalogPath(category)
      );
      return {
        total: response.data.items.length,
        etag: response.etag,
        items: response.data.items.map((item) => toReferenceCatalog(item, response.etag))
      };
    },

    async createReferenceCatalogItem(
      category: ReferenceCatalogKey,
      values: ReferenceCatalogFormValues
    ): Promise<ReferenceCatalogRecord> {
      const response = await request<ApiReferenceStandard>(
        referenceCatalogPath(category),
        {
          method: "POST",
          body: JSON.stringify({
            code: values.code,
            name: values.name,
            enabled: true
          })
        }
      );
      return toReferenceCatalog(response.data, response.etag);
    },

    async updateReferenceCatalogItem(
      category: ReferenceCatalogKey,
      id: string,
      values: ReferenceCatalogFormValues,
      etag?: string | null
    ): Promise<ReferenceCatalogRecord> {
      const response = await request<ApiReferenceStandard>(
        `${referenceCatalogPath(category)}/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({ code: values.code, name: values.name })
        }
      );
      return toReferenceCatalog(response.data, response.etag);
    },

    async archiveReferenceCatalogItem(
      category: ReferenceCatalogKey,
      id: string,
      etag?: string | null
    ): Promise<void> {
      await request<void>(
        `${referenceCatalogPath(category)}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: ifMatchHeader(etag) }
      );
    },

    async listAdminUsers(
      listOptions: ListAdminUserOptions = {}
    ): Promise<ApiListResult<AdminUserRecord>> {
      const response = await request<ApiAdminUserList>("/api/v1/admin/users", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((user) => toAdminUser(user, response.etag))
      };
    },

    async createAdminUser(
      values: AdminUserFormValues
    ): Promise<AdminUserCreateResult> {
      const response = await request<ApiAdminUserCreateResult>(
        "/api/v1/admin/users",
        {
          method: "POST",
          body: JSON.stringify(adminUserPayload(values))
        }
      );
      return {
        user: toAdminUser(response.data.user, response.etag),
        temporaryPassword: response.data.temporary_password
      };
    },

    async updateAdminUser(
      id: string,
      values: AdminUserUpdateValues
    ): Promise<AdminUserRecord> {
      const response = await request<ApiAdminUser>(
        `/api/v1/admin/users/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(adminUserUpdatePayload(values))
        }
      );
      return toAdminUser(response.data, response.etag);
    },

    async archiveAdminUser(id: string): Promise<void> {
      await request<void>(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
    },

    async disableAdminUser(id: string): Promise<AdminUserRecord> {
      const response = await request<ApiAdminUser>(
        `/api/v1/admin/users/${encodeURIComponent(id)}/disable`,
        { method: "POST" }
      );
      return toAdminUser(response.data, response.etag);
    },

    async enableAdminUser(id: string): Promise<AdminUserRecord> {
      const response = await request<ApiAdminUser>(
        `/api/v1/admin/users/${encodeURIComponent(id)}/enable`,
        { method: "POST" }
      );
      return toAdminUser(response.data, response.etag);
    },

    async unlockAdminUser(id: string): Promise<AdminUserRecord> {
      const response = await request<ApiAdminUser>(
        `/api/v1/admin/users/${encodeURIComponent(id)}/unlock`,
        { method: "POST" }
      );
      return toAdminUser(response.data, response.etag);
    },

    async resetAdminUserPassword(id: string): Promise<TemporaryPasswordResult> {
      const response = await request<ApiTemporaryPasswordResult>(
        `/api/v1/admin/users/${encodeURIComponent(id)}/password-reset`,
        { method: "POST" }
      );
      return {
        userId: response.data.user_id,
        temporaryPassword: response.data.temporary_password
      };
    },

    async resetAdminUserMfa(id: string): Promise<AdminUserRecord> {
      const response = await request<ApiAdminUser>(
        `/api/v1/admin/users/${encodeURIComponent(id)}/mfa-reset`,
        { method: "POST" }
      );
      return toAdminUser(response.data, response.etag);
    },

    async listDevices(
      listOptions: ListDeviceOptions = {}
    ): Promise<ApiListResult<DeviceRecord>> {
      const response = await request<ApiDeviceList>("/api/v1/admin/devices", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((device) => toDevice(device, response.etag))
      };
    },

    async updateDevice(
      id: string,
      values: DeviceUpdateValues
    ): Promise<DeviceRecord> {
      const response = await request<ApiDevice>(
        `/api/v1/admin/devices/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(deviceUpdatePayload(values))
        }
      );
      return toDevice(response.data, response.etag);
    },

    async listAuditEvents(
      listOptions: ListAuditEventOptions = {}
    ): Promise<ApiListResult<AuditEventRecord>> {
      const response = await request<ApiAuditEventList>(
        "/api/v1/admin/audit-events",
        {},
        {
          limit: listOptions.limit ?? 50,
          offset: listOptions.offset ?? 0,
          entity: listOptions.entity?.trim() || undefined,
          actor_id: listOptions.actorId?.trim() || undefined,
          action: listOptions.action?.trim() || undefined,
          search: listOptions.search?.trim() || undefined,
          sort: listOptions.sort
        }
      );
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map(toAuditEvent)
      };
    },

    async archiveCustomer(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/customers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },

    async archiveProduct(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/products/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },

    async archiveAsset(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/assets/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },


  };
}
