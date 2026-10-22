
import type { PressureRating, SavedInspectionForm } from "./inspectionForm";

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

/**
 * The pressure test as queued: pressures and duration, the pass/fail, and the
 * structured measurements (schema version 1) the customer's form records.
 */
export interface PressureTestDraft {
  appliedPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

export interface InspectionDraftInput {
  workContext?: SyncWorkContext;
  assetId: string;
  assetNumber: string;
  customerName: string;
  inspectionId: string;
  baseVersion: number | null;
  status: InspectionStatus;
  /** The instruction: PASS or REPAIR. */
  result: string | null;
  pressureTest: PressureTestDraft;
  inspectionType?: InspectionType;
}

export interface AssetUpdateInput {
  workContext?: SyncWorkContext;
  assetId: string;
  assetNumber: string;
  customerName: string;
  baseVersion: number;
  customerSerialNo: string;
  tag: string;
}

export interface PressureTestOperationInput extends PressureTestDraft {
  workContext?: SyncWorkContext;
  assetId: string;
  assetNumber: string;
  customerName: string;
  inspectionId: string;
  pressureTestId: string;
  baseVersion: number | null;
}

export interface WorkItem {
  workContext?: SyncWorkContext;
  id: string;
  assetId: string;
  assetNumber: string;
  customerSerialNo: string | null;
  tag: string | null;
  customerName: string;
  locationName: string | null;
  locationAddress: string | null;
  productName: string;
  lifecycleStatus: string;
  retestDueAt: string | null;
  urgency: WorkUrgency;
  assetVersion: number;
  serverVersion: number;
  inspectionId: string | null;
  inspectionStatus: InspectionStatus | null;
  /** True once the server holds the inspection as submitted, approved or rejected. */
  inspectionLocked: boolean;
  pressureTestId: string | null;
  pressureTestVersion: number | null;
  /** The product's rating for this hose's bore; null when it has none. */
  pressureRating: PressureRating | null;
  /** What the server holds for this assignment's inspection, for a draft reload. */
  saved: SavedInspectionForm | null;
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
  work_contexts?: SyncWorkContext[];
}

export interface SyncWorkContext {
  appointment_id: string;
  booking_id: string;
  revision_id: string;
  assignment_id: string;
  asset_id: string;
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
  workContext?: SyncWorkContext;
  opId: string;
  idempotencyKey: string;
  entity: "Asset" | "Inspection" | "PressureTestResult";
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
