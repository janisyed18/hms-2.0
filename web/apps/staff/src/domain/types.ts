export type DataSource = "api" | "mock";

export type RiskLevel = "High" | "Medium" | "Low";

export type CustomerStatus = "Active" | "Review" | "Paused";

export type InspectionState = "Overdue" | "Due Soon" | "Current";

export interface CustomerLocation {
  id: string;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
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
  assetCount: number;
  inServiceCount: number;
  outOfServiceCount: number;
  inspectionDueCount: number;
  inspectionDueLabel: string;
  certificateValidPercent: number;
  certificateStatusLabel: string;
  recentInspections: RecentInspection[];
  activity: ActivityItem[];
}

export interface CustomerRecord {
  id: string;
  code: string;
  name: string;
  etag?: string | null;
  retestEnabled: boolean;
  defaultRetestMonths: number | null;
  locations: CustomerLocation[];
  contacts: CustomerContact[];
  status: CustomerStatus;
  riskLevel: RiskLevel;
  industry: string;
  paymentTerms: string;
  contractStart: string;
  contractEnd: string;
  lastActivity: string;
  metrics: CustomerMetrics;
}

export interface CustomerListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: CustomerRecord[];
}

export interface CustomerFormValues {
  name: string;
  code: string;
  retestEnabled: boolean;
  defaultRetestMonths: number | null;
}

export interface ApiListResult<TItem> {
  total: number;
  etag: string | null;
  items: TItem[];
}

export interface ReferenceStandardRecord {
  id: string;
  code: string;
  name: string;
  etag?: string | null;
}

export interface ReferenceStandardListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: ReferenceStandardRecord[];
}

export interface ReferenceStandardFormValues {
  code: string;
  name: string;
}

export interface ProductRecord {
  id: string;
  code: string;
  name: string;
  category: string;
  subCategory: string | null;
  standardCode: string | null;
  etag?: string | null;
}

export interface ProductListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: ProductRecord[];
}

export interface PressureRatingRecord {
  id: string;
  label: string;
  pressureKpa: number;
}

export interface ProductFormValues {
  code: string;
  name: string;
  category: string;
  subCategory: string | null;
  standardId: string | null;
  pressureRatings: PressureRatingRecord[];
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
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface AssetRetestSummary {
  dueAt: string;
  status: string;
}

export interface AssetRecord {
  id: string;
  assetNumber: string;
  customerSerialNo: string | null;
  tag: string | null;
  lifecycleStatus: string;
  manufactureDate: string | null;
  nextRetestDueAt: string | null;
  condemnedAt: string | null;
  lengthM: string | null;
  customer: RecordSummary;
  product: AssetProductSummary;
  location: AssetLocationSummary | null;
  retestSchedule: AssetRetestSummary | null;
  aEnd: AssetEndValues;
  bEnd: AssetEndValues;
  etag?: string | null;
}

export interface AssetListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: AssetRecord[];
}

export interface AssetEndValues {
  fitting: string;
  size: string;
}

export interface AssetFormValues {
  assetNumber: string;
  customerId: string;
  customerSerialNo: string | null;
  productId: string;
  lifecycleStatus: string;
  nextRetestDueAt: string | null;
  aEnd: AssetEndValues;
  bEnd: AssetEndValues;
}

export type InspectionStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";

export type InspectionType = "NEW_ASSET" | "SERVICE";

export interface InspectionAssetSummary {
  id: string;
  assetNumber: string;
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

export interface RetestScheduleListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: RetestScheduleRecord[];
}

export interface RetestScheduleUpdateValues {
  dueAt: string;
  status: RetestScheduleStatus;
  reminderIntervalDays: number;
  escalationIntervalDays: number;
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
  inspectorUserId: string;
  reviewerUserId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  asset: InspectionAssetSummary;
  customer: RecordSummary;
  product: AssetProductSummary;
  pressureTest: PressureTestRecord | null;
  etag?: string | null;
}

export interface InspectionListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: InspectionRecord[];
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

export interface CertificateListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: CertificateRecord[];
}

export interface CertificateIssueValues {
  inspectionId: string;
  number: string;
  validUntil: string | null;
}
