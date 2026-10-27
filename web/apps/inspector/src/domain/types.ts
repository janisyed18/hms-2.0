
import type { PressureRating, SavedInspectionForm } from "./inspectionForm";

export type InspectionStatus =
  | "DRAFT"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

/** The business transitions an inspection operation performs, in order (sync protocol 3). */
export type LifecycleAction = "start" | "rework" | "submit";

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
  /** What this operation does to the lifecycle; none for a plain save of progress. */
  lifecycleActions: LifecycleAction[];
  /** The instruction: PASS or REPAIR. Null along with the pressure test when no form data. */
  result: string | null;
  /** Null for a bare transition (start, begin rework): no form data is sent. */
  pressureTest: PressureTestDraft | null;
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
  /** The inspection's status as this device sees it, including work queued here. */
  inspectionStatus: InspectionStatus | null;
  /** True once the inspection is submitted, approved or rejected: not editable as it is. */
  inspectionLocked: boolean;
  /** Why it was sent back; kept as rework guidance until it is resubmitted. */
  rejectionReason: string | null;
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
  // Present from the paged protocol (2) on.
  protocol_version?: number;
  next_page_token?: string | null;
  page_size?: number | null;
  scope_changed?: boolean;
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
  /** Protocol 3 inspection operations only; absent on one queued by app 0.2.0. */
  lifecycleActions?: LifecycleAction[];
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
