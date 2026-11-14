export interface DashboardRetestRecord {
  assetId: string;
  assetNumber: string;
  assetName?: string | null;
  customerName: string;
  productName: string;
  dueAt: string;
  daysOverdue: number;
  status: string;
}

export interface DashboardDueRecord {
  assetId: string;
  assetNumber: string;
  assetName?: string | null;
  customerName: string;
  dueAt: string;
}

export interface DashboardReviewRecord {
  inspectionId: string;
  assetId: string;
  assetNumber: string;
  assetName?: string | null;
  inspectionType: string;
  status: string;
  result: string | null;
}

/**
 * Retest status of the eligible fleet. The five categories are mutually exclusive and
 * sum to `total`, so they can be shown as one partition.
 */
export interface FleetStatus {
  onTrack: number;
  dueSoon: number;
  overdue: number;
  suspended: number;
  unscheduled: number;
  total: number;
  /** Share of the eligible fleet on track. Null when there is no eligible fleet. */
  onTrackPercent: number | null;
}

export interface DashboardRecord {
  /** The instant the snapshot figures were measured, and the organisation timezone. */
  asOf: string;
  timezone: string;
  totalAssets: number;
  totalCustomers: number;
  inServiceAssets: number;
  fleetStatus: FleetStatus;
  dueSoonAssets: number;
  /** Distinct eligible assets with an overdue schedule. */
  overdueAssets: number;
  /** Overdue schedules: the queue total. */
  overdueSchedules: number;
  overdueEscalated: number;
  /** What a send-escalation request would act on now. Authoritative count: the server. */
  escalationEligibleTotal: number;
  escalatedToday: number;
  awaitingReviewInspections: number;
  overdueTotal: number;
  overdueLimit: number;
  overdueOffset: number;
  overdueRetests: DashboardRetestRecord[];
  dueThisWeek: DashboardDueRecord[];
  awaitingReview: DashboardReviewRecord[];
}

export interface MyWorkAction {
  code: string;
  label: string;
  targetType: "ASSET" | "SCHEDULING" | "INSPECTION" | "CERTIFICATES" | string;
  targetId: string | null;
  inspectionId: string | null;
}

export interface MyWorkItem {
  id: string;
  kind: string;
  state: string;
  priority: "URGENT" | "DUE_SOON" | "NORMAL" | string;
  title: string;
  summary: string;
  customerId: string;
  customerName: string;
  assetId: string;
  assetNumber: string;
  assetName?: string | null;
  inspectionId: string | null;
  bookingId: string | null;
  certificateId: string | null;
  dueAt: string | null;
  updatedAt: string;
  nextAction: MyWorkAction;
}

export interface MyWorkRecord {
  summary: { total: number; urgent: number; dueSoon: number; normal: number };
  items: MyWorkItem[];
  limit: number;
  sourceLimit: number;
  sourceLimited: boolean;
}

export interface AnalyticsCertificateCoverage {
  /**
   * Asset-level coverage over the eligible fleet: covered + unverified + expired +
   * missing equals eligibleAssets. "Unverified" means the asset's only usable
   * certificates carry no expiry date, so their validity is unknown.
   */
  eligibleAssets: number;
  coveredAssets: number;
  unverifiedAssets: number;
  expiredAssets: number;
  missingAssets: number;
  expiringAssets: number;
  coveragePercent: number;
  /** Certificate-level counts, which are not asset counts. */
  issued: number;
  expiringSoon: number;
  expired: number;
  /** Activity: certificates issued in the selected period. Null without a period. */
  issuedInPeriod: number | null;
}

export interface AnalyticsFleetPosture {
  clear: number;
  dueSoon: number;
  overdue: number;
}

export interface AnalyticsInspectionOutcome {
  inspectionType: string;
  submitted: number;
  approved: number;
  rejected: number;
}

export interface AnalyticsCustomerRisk {
  customerId: string;
  customerName: string;
  overdue: number;
  dueSoon: number;
  risk: "HIGH" | "WATCH";
}

export interface AnalyticsOverview {
  generatedAt: string;
  asOf: string;
  timezone: string;
  totalAssets: number;
  inServiceAssets: number;
  dueSoonAssets: number;
  overdueAssets: number;
  awaitingReviewInspections: number;
  /** The same partition the Dashboard shows: one source of truth for fleet status. */
  fleetStatus: FleetStatus;
  fleetPosture: AnalyticsFleetPosture;
  certificateCoverage: AnalyticsCertificateCoverage;
  customerRisk: AnalyticsCustomerRisk[];
  inspectionOutcomes: AnalyticsInspectionOutcome[];
}

/** The six activity series the reporting API exposes, each from an exact timestamp. */
export interface ActivityCounts {
  assetsAdded: number;
  inspectionsSubmitted: number;
  inspectionsApproved: number;
  inspectionsRejected: number;
  certificatesIssued: number;
  retestsEscalated: number;
}

export interface ActivityBucket extends ActivityCounts {
  start: string;
  end: string;
}

export interface ActivityReport {
  generatedAt: string;
  startAt: string;
  endAt: string;
  timezone: string;
  granularity: "hour" | "day" | "week" | string;
  buckets: ActivityBucket[];
  totals: ActivityCounts;
}

export interface RetestEscalationResult {
  /** What the server actually sent. Authoritative over any count shown beforehand. */
  dispatched: number;
  eligible: number;
}

export interface NotificationRecord {
  id: string;
  category: string;
  tier: string;
  subject: string | null;
  body: string;
  customerId: string | null;
  assetId: string | null;
  /** What it is about, from the event: "inspection", "asset", "inspection_booking", ... */
  subjectType: string | null;
  subjectId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationFeedResult {
  total: number;
  unreadTotal: number;
  items: NotificationRecord[];
}

export type StaffRole =
  | "SUPER_ADMIN"
  | "HMS_ADMIN"
  | "INSPECTOR"
  | "ASSEMBLY"
  | "REVIEWER"
  | "CUSTOMER_USER";

export type StaffPermission =
  | "customer:read"
  | "customer:write"
  | "asset:read"
  | "asset:write"
  | "inspection:book"
  | "inspection:write"
  | "certificate:approve"
  | "reference:admin"
  | "user:admin"
  | "device:admin"
  | "audit:read";

export interface StaffSession {
  userId: string;
  displayName: string;
  email?: string;
  roles: StaffRole[];
  permissions: StaffPermission[];
  customerIds: string[];
  authMode: "dev" | "bearer" | string;
}

export type CustomerStatus = "Active" | "Archived";

export type InspectionState = "Overdue" | "Due Soon" | "Current";

export interface CustomerLocation {
  id: string;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  siteContactName: string | null;
  siteContactMobile: string | null;
  siteContactEmail: string | null;
  notes?: string | null;
  contacts?: LocationContact[];
  ppeRequirements: string[];
  additionalRequirements: string[];
  schedulingTimezone?: string;
  schedulingOpenTime?: string;
  schedulingCloseTime?: string;
  schedulingWeekdays?: number[];
  schedulingBlackoutDates?: string[];
}

export interface LocationContact {
  id?: string;
  name: string;
  role: string;
  phone: string;
  email: string;
}

export interface CustomerContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  receivesRetestReminders: boolean;
}

export interface RecentInspection {
  id: string;
  status: InspectionState;
  asset: string;
  date: string;
  locationCode: string;
}

export interface ActivityItem {
  id: string;
  type: "inspection" | "certificate" | "contact" | "asset";
  title: string;
  meta: string;
  status?: InspectionState | "Valid";
  time: string;
}

export interface CustomerMetrics {
  /** Assigned assets, counted by the API with the same definition as the asset list. */
  assetCount: number;
  inServiceCount: number;
  /** null means the API does not provide the figure, which is not the same as zero. */
  inspectionDueCount: number | null;
  inspectionDueLabel: string;
  /** null means the API does not provide the figure, which is not the same as zero. */
  certificateValidPercent: number | null;
  certificateStatusLabel: string;
  recentInspections: RecentInspection[];
  activity: ActivityItem[];
}

export interface CustomerRecord {
  id: string;
  code: string;
  name: string;
  etag?: string | null;
  notes: string | null;
  retestEnabled: boolean;
  defaultRetestMonths: number | null;
  locations: CustomerLocation[];
  contacts: CustomerContact[];
  status: CustomerStatus;
  /** When the customer was archived; null while it is active. */
  archivedAt: string | null;
  metrics: CustomerMetrics;
}

/** What the server says about giving a confirmed booking to a different inspector, before anything changes. */
export interface InspectorAvailability {
  /** False when the booking cannot be reassigned at all (inspection history), whoever is chosen. */
  eligible: boolean;
  blockedReason: string | null;
  /** Null when no inspector was asked about. */
  available: boolean | null;
  reason: "inspector_busy" | "asset_unavailable" | null;
  /** Up to three other inspectors who are free for the booking's existing time. */
  suggestedInspectorIds: string[];
}

/** One kind of record that still refers to a customer and so blocks deleting it. */
export interface CustomerDeletionBlocker {
  kind: string;
  label: string;
  count: number;
  /** A few named examples (assets, for instance); empty when the kind has no useful name. */
  records: { id: string; name: string }[];
}

export interface CustomerDeletionImpactItem {
  kind: string;
  label: string;
  count: number;
  /** How many of `count` were already deleted before this customer was; they are archived too. */
  previously_deleted?: number;
}

/** What deleting would remove from active HMS, as the server counted it (Super Admin only). */
export interface CustomerDeletionCheck {
  canDelete: boolean;
  archived: boolean;
  blockers: CustomerDeletionBlocker[];
  customerName: string;
  customerCode: string;
  /** Related records only: the customer itself is not counted. */
  totalRecords: number;
  items: CustomerDeletionImpactItem[];
  evidenceFiles: number;
  /** Echoed back on delete so records added after this review are noticed. */
  fingerprint: string;
  retentionYears: number;
  /** False when this environment has not switched on "Delete Customer and Related Data". */
  deletionEnabled: boolean;
}

/** One deletion batch in the read-only historical archive. */
export interface CustomerDeletionSummary {
  id: string;
  deletionNumber: string;
  status: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  actorName: string;
  reason: string | null;
  deletedAt: string;
  totalRecords: number;
  recordCounts: CustomerDeletionImpactItem[];
  evidenceFiles: number;
  manifestSha256: string | null;
  retentionUntil: string | null;
  retentionBasis: string | null;
  failureDetail: string | null;
  replayed: boolean;
}

export interface CustomerDeletionEvidence {
  id: string;
  kind: string;
  label: string;
  recordType: string;
  originalId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CustomerDeletionDetail extends CustomerDeletionSummary {
  evidence: CustomerDeletionEvidence[];
}

export interface CustomerDeletionRecord {
  id: string;
  recordType: string;
  typeLabel: string;
  originalId: string;
  label: string;
  originalVersion: number | null;
  /** The record was already deleted before the customer was; its original deleted_at is in the snapshot. */
  previouslyDeleted: boolean;
  payload: Record<string, unknown>;
  payloadSha256: string;
}

export interface LocationFormValues {
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  siteContactName: string;
  siteContactMobile: string;
  siteContactEmail: string;
  notes?: string;
  contacts?: LocationContact[];
  ppeRequirements: string[];
  additionalRequirements: string[];
  schedulingTimezone: string;
  schedulingOpenTime: string;
  schedulingCloseTime: string;
  schedulingWeekdays: number[];
  schedulingBlackoutDates: string[];
}

/** A customer is created with its first location; more are added from Customer Details. */
export interface CustomerFormValues {
  name: string;
  notes: string;
  firstLocation: LocationFormValues;
  /** Further sites entered on the same form; saved with the customer in one request. */
  additionalLocations?: LocationFormValues[];
}

export interface CustomerUpdateValues {
  name: string;
  notes: string;
}

export interface ContactFormValues {
  name: string;
  email: string;
  phone: string;
  role: string;
  receivesRetestReminders: boolean;
}

export interface CustomerSummary {
  activeCustomers: number;
  archivedCustomers: number;
  locations: number;
  assets: number;
}

export interface ApiListResult<TItem> {
  total: number;
  etag: string | null;
  items: TItem[];
}

export type ReferenceCatalogKey =
  | "standards"
  | "materials"
  | "couplings"
  | "coupling-add-ons"
  | "attach-methods"
  | "nominal-bores";

export interface ReferenceCatalogRecord {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  etag?: string | null;
}

export interface ReferenceCatalogFormValues {
  code: string;
  name: string;
}

export interface ProductRecord {
  id: string;
  code: string;
  name: string;
  category: string;
  subCategory: string | null;
  standardId: string | null;
  standardCode: string | null;
  enabled: boolean;
  etag?: string | null;
}

export interface ProductFormValues {
  code: string;
  name: string;
  category: string;
  subCategory: string | null;
  standardId: string | null;
}

export interface RecordSummary {
  id: string;
  code: string;
  name: string;
}

export interface AssetProductSummary extends RecordSummary {
  category: string;
}

export interface AssetLocationSummary {
  id: string;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  schedulingTimezone?: string;
}

export interface AssetInspectionHistoryRecord {
  id: string;
  inspectionType: string;
  status: string;
  result: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
}

export interface AssetCertificateHistoryRecord {
  id: string;
  number: string;
  certificateVersion: number;
  status: string;
  issuedAt: string;
  validUntil: string | null;
}

export interface AssetRetestSummary {
  dueAt: string;
  status: string;
}

export type AssetWorkflowTargetType = "ASSET" | "SCHEDULING" | "INSPECTION" | "CERTIFICATES";

/** A semantic next step from the API: what to do and where it lives, never a URL or a command. */
export interface AssetWorkflowAction {
  code: string;
  label: string;
  targetType: AssetWorkflowTargetType;
  targetId: string | null;
  /** The inspection a certificate action is about. */
  inspectionId: string | null;
}

export interface AssetWorkflow {
  status: string;
  label: string;
  detail: string;
  attention: boolean;
  related: {
    bookingId: string | null;
    appointmentId: string | null;
    inspectionId: string | null;
    certificateId: string | null;
  };
  context: {
    scheduledAt: string | null;
    dueAt: string | null;
    certificateNumber: string | null;
  };
  nextAction: AssetWorkflowAction | null;
}

export interface AssetRecord {
  id: string;
  assetNumber: string;
  assetName: string | null;
  customerSerialNo: string | null;
  purchaseOrderNumber: string | null;
  tag: string | null;
  lifecycleStatus: string;
  manufactureDate: string | null;
  installationDate: string | null;
  graveDate: string | null;
  nextRetestDueAt: string | null;
  condemnedAt: string | null;
  lengthM: string | null;
  notes: string | null;
  description: string | null;
  customer: RecordSummary;
  product: AssetProductSummary;
  location: AssetLocationSummary | null;
  retestSchedule: AssetRetestSummary | null;
  aEnd: AssetEndValues;
  bEnd: AssetEndValues;
  /** The product's rating for this hose's bore; null when it has none. */
  pressureRating?: { workingPressureKpa: number; testPressureKpa: number } | null;
  inspectionHistory: AssetInspectionHistoryRecord[];
  certificateHistory: AssetCertificateHistoryRecord[];
  etag?: string | null;
}

export interface AssetEndValues {
  fitting: string;
  size: string;
  nominalBore: RecordSummary | null;
  material: RecordSummary | null;
  coupling: RecordSummary | null;
  couplingAddOn: RecordSummary | null;
  attachMethod: RecordSummary | null;
}

export interface AssetConfigurationOptions {
  materials: RecordSummary[];
  couplings: RecordSummary[];
  couplingAddOns: RecordSummary[];
  attachMethods: RecordSummary[];
  nominalBores: RecordSummary[];
}

export interface AssetFormValues {
  customerId: string;
  locationId: string | null;
  productId: string;
  assetName: string;
  assetNumber?: string;
  generateAssetNumber?: boolean;
  serialNumber: string;
  notes: string;
  purchaseOrderNumber: string;
  installationDate: string | null;
  graveDate: string | null;
  nextInspectionDate: string | null;
  lengthM: string | null;
  materialId?: string | null;
  nominalBoreId?: string | null;
  aEnd: AssetEndValues;
  bEnd: AssetEndValues;
}

export type InspectionStatus = "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "APPROVED" | "REJECTED";

export type InspectionBookingStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED";

export type InspectionType = "NEW_ASSET" | "SERVICE";

export interface InspectionAssetSummary {
  id: string;
  assetNumber: string;
  /** The name people know the asset by; absent on older API responses. */
  assetName?: string | null;
  tag: string | null;
  lifecycleStatus: string;
}

export type RetestScheduleStatus = "UPCOMING" | "DUE" | "OVERDUE" | "SUSPENDED";

export interface RetestScheduleRecord {
  id: string;
  assetId: string;
  customerId: string;
  dueAt: string;
  status: RetestScheduleStatus;
  reminderIntervalDays: number;
  escalationIntervalDays: number;
  lastRemindedAt: string | null;
  escalatedAt: string | null;
  asset: InspectionAssetSummary;
  customer: RecordSummary;
  product: AssetProductSummary;
  etag?: string | null;
}

export interface RetestScheduleUpdateValues {
  dueAt: string;
  status: RetestScheduleStatus;
  reminderIntervalDays: number;
  escalationIntervalDays: number;
}

export interface AdminUserRecord {
  id: string;
  oidcSubject: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  role: string;
  customerId: string | null;
  customerIds?: string[];
  accountStatus: "ACTIVE" | "LOCKED" | "DISABLED";
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  etag?: string | null;
}

export interface AdminUserFormValues {
  oidcSubject?: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  customerId: string | null;
  customerIds?: string[];
}

export interface AdminUserCreateResult {
  user: AdminUserRecord;
  temporaryPassword: string;
}

export interface TemporaryPasswordResult {
  userId: string;
  temporaryPassword: string;
}

export interface AdminUserUpdateValues {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  role?: string;
  customerId?: string | null;
  customerIds?: string[];
}

export interface DeviceRecord {
  deviceId: string;
  displayName?: string;
  userId: string;
  platform: string;
  appVersion: string;
  lastSyncAt: string | null;
  offlineWindowDays: number;
  revoked: boolean;
  state: string;
  etag?: string | null;
}

export interface DeviceUpdateValues {
  offlineWindowDays?: number;
  revoked?: boolean;
}

export interface AuditEventRecord {
  sequence: number;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  timestamp: string;
  hash: string;
}

export interface PressureTestRecord {
  id: string;
  appliedPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

export interface PressureTestValues {
  appliedPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

export interface InspectionRecord {
  id: string;
  assetId: string;
  inspectionType: InspectionType;
  status: InspectionStatus;
  result: string | null;
  inspectorUserId: string | null;
  reviewerUserId: string | null;
  /** When work first began; null for inspections that predate the lifecycle. */
  startedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  /** Why the reviewer sent it back, while it is waiting for changes. */
  rejectionReason: string | null;
  asset: InspectionAssetSummary;
  customer: RecordSummary;
  product: AssetProductSummary;
  pressureTest: PressureTestRecord | null;
  etag?: string | null;
}

export interface InspectionBookingRecord {
  id: string;
  customer: RecordSummary;
  location: AssetLocationSummary;
  assets: InspectionAssetSummary[];
  scheduledAt: string;
  scheduledEndAt: string | null;
  additionalInformation: string | null;
  status: InspectionBookingStatus;
  requestedByUserId: string;
  inspectorUserId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  appointment: InspectionAppointmentRecord | null;
  changeRequests: InspectionBookingChangeRequest[];
}

export interface InspectionAppointmentRecord {
  id: string;
  status: "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
  startsAt: string;
  endsAt: string;
  revisionNumber: number;
  timezoneId: string;
  localStartSnapshot: string;
  localEndSnapshot: string;
  utcOffsetStart: string;
  utcOffsetEnd: string;
  tzdataVersion: string;
}

export interface InspectionAvailabilitySlot {
  quoteId: string;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
}

export interface InspectionBookingChangeRequest {
  id: string;
  status: "PENDING_ADMIN_APPROVAL" | "PENDING_CUSTOMER_CONFIRMATION" | "APPLIED" | "REJECTED" | "CANCELLED";
  startsAt: string;
  endsAt: string;
  reason: string | null;
  emergency: boolean;
  createdAt: string;
}

export interface ScheduleInspector {
  id: string;
  displayName: string;
}

export interface InspectionScheduleResult {
  total: number;
  limit: number;
  items: InspectionBookingRecord[];
  inspectors: ScheduleInspector[];
}

export interface InspectionBookingCreateValues {
  customerId: string;
  locationId: string;
  assetIds: string[];
  availabilityQuoteId: string;
  additionalInformation: string | null;
}

export interface InspectionCreateValues {
  assetId: string;
  inspectionType: InspectionType;
  result: string | null;
  pressureTest: PressureTestValues | null;
}

export interface InspectionUpdateValues {
  result: string | null;
  pressureTest: PressureTestValues | null;
}

export type CertificateStatus = "DRAFT" | "ISSUED" | "SUPERSEDED" | "REVOKED";

export interface CertificateInspectionSummary {
  id: string;
  inspectionType: InspectionType;
  status: InspectionStatus;
  result: string | null;
  approvedAt: string | null;
}

export interface CertificateRecord {
  id: string;
  inspectionId: string;
  assetId: string;
  number: string;
  certificateVersion: number;
  issuedAt: string;
  validUntil: string | null;
  pdfObjectKey: string;
  verificationHash: string;
  publicToken: string;
  issuedByUserId: string;
  status: CertificateStatus;
  asset: InspectionAssetSummary;
  customer: RecordSummary;
  product: AssetProductSummary;
  inspection: CertificateInspectionSummary;
  etag?: string | null;
}

export interface CertificateIssueValues {
  inspectionId: string;
  number: string;
  validUntil: string | null;
}
