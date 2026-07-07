import { beforeEach, describe, expect, it } from "vitest";
import {
  createAssetUpdateOperation,
  createInspectionOperation,
  createPressureTestOperation,
  loadOutbox,
  markOperationApplied,
  markOperationConflict,
  markOperationRejected,
  resolveOperationConflict,
  saveOutbox
} from "../offline/outboxStore";

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
  it("adds an inspection operation and persists it", () => {
    const operation = makeDraftOperation();

    saveOutbox([operation]);

    expect(loadOutbox().operations).toHaveLength(1);
    expect(loadOutbox().operations[0]).toMatchObject({
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
    saveOutbox([operation]);

    markOperationApplied(operation.opId, 3);

    expect(loadOutbox().operations[0]).toMatchObject({
      status: "applied",
      serverVersion: 3
    });
  });

  it("marks conflicts with current server payload", () => {
    const operation = makeDraftOperation();
    saveOutbox([operation]);

    markOperationConflict(operation.opId, {
      currentVersion: 4,
      payload: { result: "server copy" }
    });

    expect(loadOutbox().operations[0]).toMatchObject({
      status: "conflict",
      currentVersion: 4,
      serverPayload: { result: "server copy" }
    });
  });

  it("marks rejected operations with the server error", () => {
    const operation = makeDraftOperation();
    saveOutbox([operation]);

    markOperationRejected(operation.opId, "Unsupported asset");

    expect(loadOutbox().operations[0]).toMatchObject({
      status: "rejected",
      lastError: "Unsupported asset"
    });
  });

  it("resolves a conflict by accepting the server state locally", () => {
    const operation = makeDraftOperation();
    saveOutbox([operation]);
    markOperationConflict(operation.opId, {
      currentVersion: 4,
      payload: { result: "server copy" }
    });

    resolveOperationConflict(operation.opId, "accept-server");

    expect(loadOutbox().operations[0]).toMatchObject({
      status: "applied",
      serverVersion: 4
    });
  });

  it("resets corrupt stored JSON and reports a warning", () => {
    localStorage.setItem("bat-hms-inspector-outbox", "{bad");

    expect(loadOutbox()).toMatchObject({
      operations: [],
      warning: "Local queue was reset because stored data was unreadable."
    });
  });
});
