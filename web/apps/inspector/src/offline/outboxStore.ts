import type {
  AssetUpdateInput,
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

function replaceOperation(
  opId: string,
  update: (operation: OutboxOperation) => OutboxOperation
) {
  const state = loadOutbox();
  saveOutbox(
    state.operations.map((operation) =>
      operation.opId === opId ? update(operation) : operation
    )
  );
}

export function loadOutbox(): OutboxState {
  const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);

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
    localStorage.removeItem(OUTBOX_STORAGE_KEY);
    return { operations: [], warning: RESET_WARNING };
  }
}

export function saveOutbox(operations: OutboxOperation[]) {
  localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify({ operations }));
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
    entityId: input.inspectionId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
    customerName: input.customerName,
    op,
    baseVersion: input.baseVersion,
    payload: {
      asset_id: input.assetId,
      inspection_type: input.inspectionType ?? "SERVICE",
      status: input.status,
      result: input.passed ? "PASS" : "FAIL",
      notes: input.notes,
      pressure_test: {
        applied_pressure_kpa: input.appliedPressureKpa,
        required_pressure_kpa: input.requiredPressureKpa,
        hold_time_seconds: input.holdTimeSeconds,
        passed: input.passed
      }
    },
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
    entityId: input.assetId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
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
    entityId: input.pressureTestId,
    assetId: input.assetId,
    assetNumber: input.assetNumber,
    customerName: input.customerName,
    op,
    baseVersion: input.baseVersion,
    payload: {
      inspection_id: input.inspectionId,
      applied_pressure_kpa: input.appliedPressureKpa,
      hold_time_seconds: input.holdTimeSeconds,
      passed: input.passed,
      measurements: {
        required_pressure_kpa: input.requiredPressureKpa
      }
    },
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function upsertOutboxOperation(operation: OutboxOperation) {
  const state = loadOutbox();
  const existingIndex = state.operations.findIndex(
    (item) => item.entityId === operation.entityId
  );

  if (existingIndex === -1) {
    saveOutbox([operation, ...state.operations]);
    return;
  }

  const next = [...state.operations];
  next[existingIndex] = operation;
  saveOutbox(next);
}

export function markOperationApplied(opId: string, serverVersion: number) {
  replaceOperation(opId, (operation) => ({
    ...operation,
    status: "applied",
    serverVersion,
    currentVersion: undefined,
    lastError: undefined,
    updatedAt: nowIso()
  }));
}

export function markOperationConflict(
  opId: string,
  conflict: { currentVersion: number; payload: Record<string, unknown> }
) {
  replaceOperation(opId, (operation) => ({
    ...operation,
    status: "conflict",
    currentVersion: conflict.currentVersion,
    serverPayload: conflict.payload,
    updatedAt: nowIso()
  }));
}

export function markOperationRejected(opId: string, error: string) {
  replaceOperation(opId, (operation) => ({
    ...operation,
    status: "rejected",
    lastError: error,
    updatedAt: nowIso()
  }));
}

export function markOperationPushing(opId: string) {
  replaceOperation(opId, (operation) => ({
    ...operation,
    status: "pushing",
    lastError: undefined,
    updatedAt: nowIso()
  }));
}

export function resolveOperationConflict(
  opId: string,
  resolution: ConflictResolution
) {
  replaceOperation(opId, (operation) => {
    if (resolution === "keep-local") {
      return {
        ...operation,
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
