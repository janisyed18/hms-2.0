export type DataSource = "api" | "mock";

export type InspectionStatus = "DRAFT" | "SUBMITTED";

export type InspectionType = "SERVICE" | "NEW_ASSET";

export type WorkUrgency = "overdue" | "due-today" | "draft" | "synced";

export type OutboxStatus =
  | "pending"
  | "pushing"
  | "applied"
  | "conflict"
  | "rejected";

export type ConflictResolution = "keep-local" | "accept-server";

export interface PressureTestDraft {
  appliedPressureKpa: number;
  requiredPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
}

export interface InspectionDraftInput extends PressureTestDraft {
  assetId: string;
  assetNumber: string;
  customerName: string;
  inspectionId: string;
  baseVersion: number | null;
  status: InspectionStatus;
  notes: string;
  inspectionType?: InspectionType;
}

export interface WorkItem {
  id: string;
  assetId: string;
  assetNumber: string;
  customerName: string;
  locationName: string | null;
  productName: string;
  lifecycleStatus: string;
  retestDueAt: string | null;
  urgency: WorkUrgency;
  serverVersion: number;
  inspectionId: string | null;
  inspectionStatus: InspectionStatus | null;
}

export interface OutboxOperation {
  opId: string;
  idempotencyKey: string;
  entity: "Inspection";
  entityId: string;
  assetId: string;
  assetNumber: string;
  customerName: string;
  op: "create" | "update";
  baseVersion: number | null;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  createdAt: string;
  updatedAt: string;
  serverVersion?: number;
  currentVersion?: number;
  serverPayload?: Record<string, unknown>;
  lastError?: string;
}

export interface OutboxState {
  operations: OutboxOperation[];
  warning?: string;
}
