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
  items: CustomerRecord[];
}

export interface CustomerFormValues {
  name: string;
  code: string;
  retestEnabled: boolean;
  defaultRetestMonths: number | null;
}
