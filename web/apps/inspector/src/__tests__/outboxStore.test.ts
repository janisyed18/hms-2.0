import { beforeEach, describe, expect, it } from "vitest";
import {
  createAssetUpdateOperation,
  createInspectionOperation,
  createPressureTestOperation,
  loadOutbox,
  markOperationApplied,
  markOperationConflict,
  markOperationRejected,
  outboxStorageKey,
  resolveOperationConflict,
  saveOutbox
  , upsertOutboxOperation
} from "../offline/outboxStore";

const INSPECTOR_A = "inspector-a";
const INSPECTOR_B = "inspector-b";

beforeEach(() => {
  localStorage.clear();
});

function makeDraftOperation() {
  return createInspectionOperation({
    assetId: "asset-1",
    assetNumber: "HOS-2024-0891",
    customerName: "North Sea Shipping Ltd",
    inspectionId: "local-inspection-1",
    baseVersion: 2,
    lifecycleActions: [],
    result: "REPAIR",
    pressureTest: {
      appliedPressureKpa: 2250,
      holdTimeSeconds: 300,
      passed: true,
      measurements: { schema_version: 1, working_pressure_kpa: 1500, test_duration_minutes: 5 }
    }
  });
}

describe("outboxStore", () => {
  it("preserves an old asset update when a later assignment uses the same asset", () => {
    const oldOperation = createAssetUpdateOperation({
      assetId: "asset-1", assetNumber: "A", customerName: "Customer", baseVersion: 1,
      customerSerialNo: "old", tag: "old",
      workContext: { appointment_id: "a", booking_id: "a", revision_id: "a", assignment_id: "a", asset_id: "asset-1" }
    });
    const newOperation = createAssetUpdateOperation({
      assetId: "asset-1", assetNumber: "A", customerName: "Customer", baseVersion: 1,
      customerSerialNo: "new", tag: "new",
      workContext: { appointment_id: "b", booking_id: "b", revision_id: "b", assignment_id: "b", asset_id: "asset-1" }
    });
    upsertOutboxOperation(INSPECTOR_A, oldOperation);
    upsertOutboxOperation(INSPECTOR_A, newOperation);
    expect(loadOutbox(INSPECTOR_A).operations).toHaveLength(2);
  });
  it("adds an inspection operation and persists it", () => {
    const operation = makeDraftOperation();

    saveOutbox(INSPECTOR_A, [operation]);

    expect(loadOutbox(INSPECTOR_A).operations).toHaveLength(1);
    expect(loadOutbox(INSPECTOR_A).operations[0]).toMatchObject({
      entity: "Inspection",
      entityId: "local-inspection-1",
      status: "pending"
    });
  });

  it("creates an asset metadata operation for safe field edits", () => {
    const operation = createAssetUpdateOperation({
      assetId: "asset-1",
      assetNumber: "HOS-2024-0891",
      customerName: "North Sea Shipping Ltd",
      baseVersion: 2,
      customerSerialNo: "FIELD-SN-1",
      tag: "FIELD-TAG-1"
    });

    expect(operation).toMatchObject({
      entity: "Asset",
      entityId: "asset-1",
      assetNumber: "HOS-2024-0891",
      op: "update",
      baseVersion: 2,
      payload: {
        customer_serial_no: "FIELD-SN-1",
        tag: "FIELD-TAG-1"
      },
      status: "pending"
    });
  });

  it("queues the whole form: the instruction, the pressure test and its measurements", () => {
    const operation = makeDraftOperation();

    expect(operation.payload).toEqual({
      asset_id: "asset-1",
      inspection_type: "SERVICE",
      result: "REPAIR",
      pressure_test: {
        applied_pressure_kpa: 2250,
        hold_time_seconds: 300,
        passed: true,
        measurements: { schema_version: 1, working_pressure_kpa: 1500, test_duration_minutes: 5 }
      }
    });
    // The instruction is separate from the pressure test's own result: a failed test can
    // still be instructed PASS and a passed one REPAIR.
    expect(operation.payload.result).not.toBe("PASS");
  });

  it("creates a pressure-test child operation", () => {
    const operation = createPressureTestOperation({
      assetId: "asset-1",
      assetNumber: "HOS-2024-0891",
      customerName: "North Sea Shipping Ltd",
      inspectionId: "inspection-1",
      pressureTestId: "pressure-test-1",
      baseVersion: null,
      appliedPressureKpa: 2250,
      holdTimeSeconds: 300,
      passed: true,
      measurements: { schema_version: 1, working_pressure_kpa: 1500 }
    });

    expect(operation).toMatchObject({
      entity: "PressureTestResult",
      entityId: "pressure-test-1",
      op: "create",
      baseVersion: null,
      payload: {
        inspection_id: "inspection-1",
        applied_pressure_kpa: 2250,
        hold_time_seconds: 300,
        passed: true,
        measurements: { schema_version: 1, working_pressure_kpa: 1500 }
      },
      status: "pending"
    });
  });

  it("marks operations applied with the server version", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);

    markOperationApplied(INSPECTOR_A, operation.opId, 3);

    expect(loadOutbox(INSPECTOR_A).operations[0]).toMatchObject({
      status: "applied",
      serverVersion: 3
    });
  });

  it("marks conflicts with current server payload", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);

    markOperationConflict(INSPECTOR_A, operation.opId, {
      currentVersion: 4,
      payload: { result: "server copy" }
    });

    expect(loadOutbox(INSPECTOR_A).operations[0]).toMatchObject({
      status: "conflict",
      currentVersion: 4,
      serverPayload: { result: "server copy" }
    });
  });

  it("marks rejected operations with the server error", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);

    markOperationRejected(INSPECTOR_A, operation.opId, "Unsupported asset");

    expect(loadOutbox(INSPECTOR_A).operations[0]).toMatchObject({
      status: "rejected",
      lastError: "Unsupported asset"
    });
  });

  it("retries a conflict with a new key and the server version", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);
    markOperationConflict(INSPECTOR_A, operation.opId, { currentVersion: 4, payload: {} });
    resolveOperationConflict(INSPECTOR_A, operation.opId, "keep-local");
    const resolved = loadOutbox(INSPECTOR_A).operations[0];
    expect(resolved.baseVersion).toBe(4);
    expect(resolved.idempotencyKey).not.toBe(operation.idempotencyKey);
  });

  it("resolves a conflict by accepting the server state locally", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);
    markOperationConflict(INSPECTOR_A, operation.opId, {
      currentVersion: 4,
      payload: { result: "server copy" }
    });

    resolveOperationConflict(INSPECTOR_A, operation.opId, "accept-server");

    expect(loadOutbox(INSPECTOR_A).operations[0]).toMatchObject({
      status: "applied",
      serverVersion: 4
    });
  });

  it("resets corrupt stored JSON and reports a warning", () => {
    localStorage.setItem(outboxStorageKey(INSPECTOR_A), "{bad");

    expect(loadOutbox(INSPECTOR_A)).toMatchObject({
      operations: [],
      warning: "Local queue was reset because stored data was unreadable."
    });
  });

  it("keeps offline work private to the authenticated inspector", () => {
    const operation = makeDraftOperation();
    saveOutbox(INSPECTOR_A, [operation]);

    expect(loadOutbox(INSPECTOR_B).operations).toEqual([]);
    expect(loadOutbox(INSPECTOR_B).operations.filter(({ status }) => status === "pending"))
      .toEqual([]);
    expect(loadOutbox(INSPECTOR_A).operations).toMatchObject([
      { opId: operation.opId, entityId: operation.entityId, status: "pending" }
    ]);
  });

  it("removes the legacy anonymous queue instead of assigning it to a signed-in user", () => {
    const operation = makeDraftOperation();
    localStorage.setItem(
      "bat-hms-inspector-outbox",
      JSON.stringify({ operations: [operation] })
    );

    expect(loadOutbox(INSPECTOR_A).operations).toEqual([]);
    expect(localStorage.getItem("bat-hms-inspector-outbox")).toBeNull();
    expect(localStorage.getItem(outboxStorageKey(INSPECTOR_A))).toBeNull();
  });
});

describe("lifecycle actions in the outbox", () => {
  const context = { appointment_id: "ap", booking_id: "bk", revision_id: "rv", assignment_id: "as", asset_id: "asset-1" };
  const pressureTest = {
    appliedPressureKpa: 2250, holdTimeSeconds: 300, passed: true,
    measurements: { schema_version: 1, test_duration_minutes: 5 }
  };
  const inspection = (
    lifecycleActions: Array<"start" | "rework" | "submit">,
    options: { baseVersion?: number | null; withForm?: boolean; result?: string } = {}
  ) =>
    createInspectionOperation({
      workContext: context, assetId: "asset-1", assetNumber: "A-1", customerName: "C",
      inspectionId: "local-1", baseVersion: options.baseVersion ?? null, lifecycleActions,
      result: options.withForm === false ? null : (options.result ?? "PASS"),
      pressureTest: options.withForm === false ? null : pressureTest
    });
  const queued = () => loadOutbox(INSPECTOR_A).operations;

  it("a bare start carries no form data and no status", () => {
    const start = inspection(["start"], { withForm: false });
    expect(start.lifecycleActions).toEqual(["start"]);
    expect(start.payload).toEqual({ asset_id: "asset-1", inspection_type: "SERVICE" });
  });

  it("start, then saving progress, then submit still reaches the server as start + submit", () => {
    upsertOutboxOperation(INSPECTOR_A, inspection(["start"], { withForm: false }));
    upsertOutboxOperation(INSPECTOR_A, inspection([], { result: "REPAIR" }));
    expect(queued()).toHaveLength(1);
    expect(queued()[0].lifecycleActions).toEqual(["start"]);
    upsertOutboxOperation(INSPECTOR_A, inspection(["submit"]));
    expect(queued()).toHaveLength(1);
    expect(queued()[0].lifecycleActions).toEqual(["start", "submit"]);
    expect(queued()[0].op).toBe("create");
    expect(queued()[0].baseVersion).toBeNull();
    expect(queued()[0].payload).toMatchObject({ result: "PASS" });
  });

  it("repeated saves of progress never drop the queued start", () => {
    upsertOutboxOperation(INSPECTOR_A, inspection(["start"], { withForm: false }));
    for (const result of ["PASS", "REPAIR", "PASS"]) {
      upsertOutboxOperation(INSPECTOR_A, inspection([], { result }));
    }
    expect(queued()[0].lifecycleActions).toEqual(["start"]);
    expect(queued()[0].payload.result).toBe("PASS");
  });

  it("rework then submit are kept in order on an update", () => {
    upsertOutboxOperation(INSPECTOR_A, inspection(["rework"], { baseVersion: 4, withForm: false }));
    upsertOutboxOperation(INSPECTOR_A, inspection([], { baseVersion: 4 }));
    upsertOutboxOperation(INSPECTOR_A, inspection(["submit"], { baseVersion: 4 }));
    expect(queued()[0].lifecycleActions).toEqual(["rework", "submit"]);
    expect(queued()[0].op).toBe("update");
    expect(queued()[0].baseVersion).toBe(4);
  });

  it("does not carry the actions of an operation the server already applied", () => {
    upsertOutboxOperation(INSPECTOR_A, inspection(["start"], { withForm: false }));
    markOperationApplied(INSPECTOR_A, queued()[0].opId, 1);
    upsertOutboxOperation(INSPECTOR_A, inspection(["submit"], { baseVersion: 1 }));
    expect(queued()[0].lifecycleActions).toEqual(["submit"]);
  });

  it("keeps an operation queued by app 0.2.0 as it was until a native one replaces it", () => {
    const old = createInspectionOperation({
      workContext: context, assetId: "asset-1", assetNumber: "A-1", customerName: "C",
      inspectionId: "local-1", baseVersion: null, lifecycleActions: [], result: "PASS", pressureTest
    });
    const legacy = { ...old, lifecycleActions: undefined, payload: { ...old.payload, status: "SUBMITTED" } };
    saveOutbox(INSPECTOR_A, [legacy]);
    const [loaded] = queued();
    expect(loaded.lifecycleActions).toBeUndefined();
    expect(loaded.payload.status).toBe("SUBMITTED");
    expect(loaded.status).toBe("pending");
  });
});
