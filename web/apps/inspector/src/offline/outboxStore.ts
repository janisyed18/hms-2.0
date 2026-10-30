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

const RESET_WARNING =
  "Local queue was reset because stored data was unreadable.";

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeOperations(value: unknown): OutboxOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((operation): operation is OutboxOperation => {
    return (
      typeof operation === "object" &&
      operation !== null &&
      "opId" in operation &&
      "entityId" in operation &&
      "status" in operation
    );
  });
}

export function outboxStorageKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("An authenticated inspector user ID is required for offline storage.");
  }

  return `${OUTBOX_STORAGE_KEY}:${encodeURIComponent(normalizedUserId)}`;
}

function removeLegacyOutbox() {
  // Never attribute pre-authentication development data to a real inspector.
  localStorage.removeItem(OUTBOX_STORAGE_KEY);
}

function replaceOperation(
  userId: string,
  opId: string,
  update: (operation: OutboxOperation) => OutboxOperation
) {
  const state = loadOutbox(userId);
  saveOutbox(
    userId,
    state.operations.map((operation) =>
      operation.opId === opId ? update(operation) : operation
    )
  );
}

export function loadOutbox(userId: string): OutboxState {
  removeLegacyOutbox();
  const storageKey = outboxStorageKey(userId);
  const raw = localStorage.getItem(storageKey);

  if (!raw) {
    return { operations: [] };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const operations = normalizeOperations(
      Array.isArray(parsed) ? parsed : (parsed as { operations?: unknown }).operations
    );
    return { operations };
  } catch {
    localStorage.removeItem(storageKey);
    return { operations: [], warning: RESET_WARNING };
  }
}

export function saveOutbox(userId: string, operations: OutboxOperation[]) {
  removeLegacyOutbox();
  localStorage.setItem(outboxStorageKey(userId), JSON.stringify({ operations }));
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
  const state = loadOutbox(userId);
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
