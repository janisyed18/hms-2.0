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

export interface SyncDeviceRead {
  device_id: string;
  platform: string;
  app_version: string;
  offline_window_days: number;
  revoked: boolean;
}

export interface SyncRecordRead {
  seq: number | null;
  entity: string;
  entity_id: string;
  op: "upsert" | "delete";
  version: number;
  changed_at: string | null;
  payload: Record<string, unknown> | null;
}

export interface SyncBootstrapResponse {
  device: SyncDeviceRead;
  cursor: number;
  has_more: boolean;
  records: SyncRecordRead[];
}

export interface SyncChangesResponse {
  cursor: number;
  has_more: boolean;
  changes: SyncRecordRead[];
}

export interface SyncOperationResult {
  op_id: string;
  idempotency_key: string;
  entity: string;
  entity_id: string;
  status: "applied" | "conflict" | "rejected";
  version: number | null;
  current_version: number | null;
  payload: Record<string, unknown> | null;
  error: string | null;
}

export interface SyncPushResponse {
  cursor: number;
  results: SyncOperationResult[];
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
