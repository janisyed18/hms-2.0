import type {
  AssetUpdateInput,
  LifecycleAction,
  ConflictResolution,
  InspectionDraftInput,
  OutboxOperation,
  OutboxState,
  PressureTestOperationInput
} from "../domain/types";

export const OUTBOX_STORAGE_KEY = "bat-hms-inspector-outbox";

/** What the inspector is told when a save did not reach this device's storage. */
export const SAVE_FAILED_MESSAGE =
  "Inspection couldn't be saved on this device. Keep this page open and try again.";
export const LOAD_FAILED_MESSAGE =
  "This device's saved inspection work couldn't be read, so it may not be shown. Keep this page open, don't clear site data, and try again.";
const UNREADABLE_KEPT_MESSAGE =
  "Saved inspection data on this device was unreadable. A copy was kept for recovery.";
const DAMAGED_KEPT_MESSAGE =
  "Some saved inspection records on this device were damaged. A copy was kept for recovery.";
const UNREADABLE_BLOCKED_MESSAGE =
  "Saved inspection data on this device is unreadable and could not be copied for recovery, so nothing new can be saved here. Keep this page open and contact support.";

/** A write to the device's offline storage did not happen. Nothing was saved. */
export class OutboxStorageError extends Error {
  /** "full" when the device is out of space, "unavailable" when storage is blocked or broken. */
  readonly reason: "full" | "unavailable" | "unreadable";

  constructor(reason: "full" | "unavailable" | "unreadable", message = SAVE_FAILED_MESSAGE) {
    super(message);
    this.name = "OutboxStorageError";
    this.reason = reason;
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22 ||
      error.code === 1014)
  );
}

/** A short fingerprint, so each different damaged queue gets its own recovery key. */
function fingerprint(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${raw.length}`;
}

/** Where a damaged queue is copied before anything can overwrite it. */
export function recoveryKeyPrefix(storageKey: string): string {
  return `${storageKey}:unreadable:`;
}

/**
 * Keeps a copy of a damaged queue under a key of its own, and confirms the copy holds exactly
 * these bytes: a different damaged queue is never covered by an earlier copy. Returns false when
 * no verified copy exists, in which case nothing may overwrite the original.
 */
function keepUnreadableCopy(storageKey: string, raw: string): boolean {
  try {
    const base = `${recoveryKeyPrefix(storageKey)}${fingerprint(raw)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const key = attempt === 0 ? base : `${base}-${attempt}`;
      const existing = localStorage.getItem(key);
      if (existing === raw) return true;
      if (existing === null) {
        localStorage.setItem(key, raw);
        return localStorage.getItem(key) === raw;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function isOperationRecord(value: unknown): value is OutboxOperation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.opId === "string" &&
    typeof record.entityId === "string" &&
    typeof record.status === "string"
  );
}

interface StoredQueue {
  /** The operations that are whole. */
  operations: OutboxOperation[];
  /** Every byte of the stored queue is accounted for: it parses and no record was dropped. */
  intact: boolean;
  unparseable: boolean;
}

/** Reads a stored queue without discarding anything: damage is reported, not filtered away. */
function readStored(raw: string): StoredQueue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { operations: [], intact: false, unparseable: true };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as { operations?: unknown }).operations
      : undefined;
  if (!Array.isArray(list)) return { operations: [], intact: false, unparseable: false };
  const operations = list.filter(isOperationRecord);
  return { operations, intact: operations.length === list.length, unparseable: false };
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function outboxStorageKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("An authenticated inspector user ID is required for offline storage.");
  }

  return `${OUTBOX_STORAGE_KEY}:${encodeURIComponent(normalizedUserId)}`;
}

function removeLegacyOutbox() {
  // Never attribute pre-authentication development data to a real inspector. Tidying only: a
  // device that refuses it must not stop a save or a load.
  try {
    localStorage.removeItem(OUTBOX_STORAGE_KEY);
  } catch {
    // Ignored on purpose.
  }
}

/**
 * The queue to change and write back. When it could not be read, writing back what was read
 * (nothing) would erase the real queue, so the change is refused instead.
 */
function loadWritable(userId: string): OutboxState {
  const state = loadOutbox(userId);
  if (state.loadFailed) throw new OutboxStorageError("unavailable", state.warning ?? LOAD_FAILED_MESSAGE);
  return state;
}

function replaceOperation(
  userId: string,
  opId: string,
  update: (operation: OutboxOperation) => OutboxOperation
) {
  const state = loadWritable(userId);
  saveOutbox(
    userId,
    state.operations.map((operation) =>
      operation.opId === opId ? update(operation) : operation
    )
  );
}

/**
 * The queue stored for this inspector. Never throws and never deletes: storage that cannot be read
 * comes back as `loadFailed` (callers keep what they already hold), and a queue that is there but
 * unparseable is copied aside and reported, not discarded.
 */
export function loadOutbox(userId: string): OutboxState {
  removeLegacyOutbox();
  const storageKey = outboxStorageKey(userId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    return { operations: [], loadFailed: true, warning: LOAD_FAILED_MESSAGE };
  }

  if (!raw) {
    return { operations: [] };
  }

  const stored = readStored(raw);
  if (stored.intact) return { operations: stored.operations };
  // Damaged: what is whole is returned, and the whole stored value is copied aside first.
  const kept = keepUnreadableCopy(storageKey, raw);
  return {
    operations: stored.operations,
    loadFailed: !kept,
    warning: !kept
      ? UNREADABLE_BLOCKED_MESSAGE
      : stored.unparseable
        ? UNREADABLE_KEPT_MESSAGE
        : DAMAGED_KEPT_MESSAGE
  };
}

/** Throws {@link OutboxStorageError}, having changed nothing, when the queue cannot be stored. */
export function saveOutbox(userId: string, operations: OutboxOperation[]) {
  removeLegacyOutbox();
  const storageKey = outboxStorageKey(userId);
  try {
    // A damaged queue (unparseable, or with records that are not whole) is copied aside, and the
    // copy verified, before a new one replaces it.
    const existing = localStorage.getItem(storageKey);
    if (existing !== null && !readStored(existing).intact && !keepUnreadableCopy(storageKey, existing)) {
      throw new OutboxStorageError("unreadable", UNREADABLE_BLOCKED_MESSAGE);
    }
    localStorage.setItem(storageKey, JSON.stringify({ operations }));
  } catch (error) {
    if (error instanceof OutboxStorageError) throw error;
    throw new OutboxStorageError(isQuotaError(error) ? "full" : "unavailable");
  }
}

export function createInspectionOperation(
  input: InspectionDraftInput
): OutboxOperation {
  const timestamp = nowIso();
  const opId = makeId("op");
  const op = input.baseVersion === null ? "create" : "update";

  return {
    opId,
    idempotencyKey: makeId("idem"),
    entity: "Inspection",
    workContext: input.workContext,
    entityId: input.inspectionId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
    assetName: input.assetName,
    customerName: input.customerName,
    op,
    baseVersion: input.baseVersion,
    payload: {
      asset_id: input.assetId,
      inspection_type: input.inspectionType ?? "SERVICE",
      // Form data only when there is some: a bare start or rework carries none.
      ...(input.pressureTest
        ? {
            // The instruction (Pass or Repair), not the pressure test's own pass/fail.
            result: input.result,
            pressure_test: {
              applied_pressure_kpa: input.pressureTest.appliedPressureKpa,
              hold_time_seconds: input.pressureTest.holdTimeSeconds,
              passed: input.pressureTest.passed,
              measurements: input.pressureTest.measurements
            }
          }
        : {})
    },
    lifecycleActions: input.lifecycleActions,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createAssetUpdateOperation(
  input: AssetUpdateInput
): OutboxOperation {
  const timestamp = nowIso();

  return {
    opId: makeId("op"),
    idempotencyKey: makeId("idem"),
    entity: "Asset",
    workContext: input.workContext,
    entityId: input.assetId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
    assetName: input.assetName,
    customerName: input.customerName,
    op: "update",
    baseVersion: input.baseVersion,
    payload: {
      customer_serial_no: input.customerSerialNo,
      tag: input.tag
    },
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createPressureTestOperation(
  input: PressureTestOperationInput
): OutboxOperation {
  const timestamp = nowIso();
  const op = input.baseVersion === null ? "create" : "update";

  return {
    opId: makeId("op"),
    idempotencyKey: makeId("idem"),
    entity: "PressureTestResult",
    workContext: input.workContext,
    entityId: input.pressureTestId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
    assetName: input.assetName,
    customerName: input.customerName,
    op,
    baseVersion: input.baseVersion,
    payload: {
      inspection_id: input.inspectionId,
      applied_pressure_kpa: input.appliedPressureKpa,
      hold_time_seconds: input.holdTimeSeconds,
      passed: input.passed,
      measurements: input.measurements
    },
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function upsertOutboxOperation(userId: string, operation: OutboxOperation) {
  const state = loadWritable(userId);
  const existingIndex = state.operations.findIndex(
    (item) => item.entity === operation.entity && item.entityId === operation.entityId &&
      item.workContext?.appointment_id === operation.workContext?.appointment_id &&
      item.workContext?.revision_id === operation.workContext?.revision_id &&
      item.workContext?.assignment_id === operation.workContext?.assignment_id
  );

  if (existingIndex === -1) {
    saveOutbox(userId, [operation, ...state.operations]);
    return;
  }

  const next = [...state.operations];
  next[existingIndex] = mergeLifecycle(state.operations[existingIndex], operation);
  saveOutbox(userId, next);
}

/**
 * Saving again replaces an unsynced inspection operation, but never loses what it was going to
 * do: ``start`` then an edit then ``submit`` must still reach the server as start + submit, in
 * that order, with the latest form data. An operation queued by app 0.2.0 has no lifecycle
 * actions; its form data is kept, and it is replaced by a native one only by a new action.
 */
function mergeLifecycle(
  existing: OutboxOperation,
  incoming: OutboxOperation
): OutboxOperation {
  if (
    incoming.entity !== "Inspection" ||
    incoming.lifecycleActions === undefined ||
    existing.status === "applied"
  ) {
    return incoming;
  }
  const carried = existing.lifecycleActions ?? [];
  const actions: LifecycleAction[] = [...carried];
  for (const action of incoming.lifecycleActions) {
    if (actions[actions.length - 1] !== action) actions.push(action);
  }
  // Form data not restated by the new operation (a bare start, say) is kept.
  const { status: _legacyStatus, ...earlier } = existing.payload;
  void _legacyStatus;
  return {
    ...incoming,
    op: existing.op === "create" && existing.baseVersion === null ? "create" : incoming.op,
    baseVersion: existing.op === "create" && existing.baseVersion === null ? null : incoming.baseVersion,
    payload: { ...earlier, ...incoming.payload },
    lifecycleActions: actions,
    createdAt: existing.createdAt
  };
}

export function markOperationApplied(userId: string, opId: string, serverVersion: number) {
  replaceOperation(userId, opId, (operation) => ({
    ...operation,
    status: "applied",
    serverVersion,
    currentVersion: undefined,
    lastError: undefined,
    updatedAt: nowIso()
  }));
}

export function markOperationConflict(
  userId: string,
  opId: string,
  conflict: { currentVersion: number; payload: Record<string, unknown> }
) {
  replaceOperation(userId, opId, (operation) => ({
    ...operation,
    status: "conflict",
    currentVersion: conflict.currentVersion,
    serverPayload: conflict.payload,
    updatedAt: nowIso()
  }));
}

export function markOperationRejected(userId: string, opId: string, error: string) {
  replaceOperation(userId, opId, (operation) => ({
    ...operation,
    status: "rejected",
    lastError: error,
    updatedAt: nowIso()
  }));
}

export function markOperationPushing(userId: string, opId: string) {
  replaceOperation(userId, opId, (operation) => ({
    ...operation,
    status: "pushing",
    lastError: undefined,
    updatedAt: nowIso()
  }));
}

export function resolveOperationConflict(
  userId: string,
  opId: string,
  resolution: ConflictResolution
) {
  replaceOperation(userId, opId, (operation) => {
    if (resolution === "keep-local") {
      return {
        ...operation,
        baseVersion: operation.currentVersion ?? operation.baseVersion,
        idempotencyKey: makeId("idem"),
        status: "pending",
        lastError: undefined,
        updatedAt: nowIso()
      };
    }

    return {
      ...operation,
      status: "applied",
      serverVersion: operation.currentVersion,
      lastError: undefined,
      updatedAt: nowIso()
    };
  });
}
