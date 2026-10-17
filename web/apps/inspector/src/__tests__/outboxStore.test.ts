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
    status: "DRAFT",
    appliedPressureKpa: 30200,
    requiredPressureKpa: 20000,
    holdTimeSeconds: 300,
    passed: true,
    notes: "No leaks"
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

  it("creates a pressure-test child operation", () => {
    const operation = createPressureTestOperation({
      assetId: "asset-1",
      assetNumber: "HOS-2024-0891",
      customerName: "North Sea Shipping Ltd",
      inspectionId: "inspection-1",
      pressureTestId: "pressure-test-1",
      baseVersion: null,
      appliedPressureKpa: 30200,
      requiredPressureKpa: 20000,
      holdTimeSeconds: 300,
      passed: true
    });

    expect(operation).toMatchObject({
      entity: "PressureTestResult",
      entityId: "pressure-test-1",
      op: "create",
      baseVersion: null,
      payload: {
        inspection_id: "inspection-1",
        applied_pressure_kpa: 30200,
        hold_time_seconds: 300,
        passed: true,
        measurements: {
          required_pressure_kpa: 20000
        }
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
