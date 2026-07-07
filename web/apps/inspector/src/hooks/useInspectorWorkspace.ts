import { useEffect, useMemo, useState } from "react";
import {
  applySyncChangesToRecords,
  createSyncClient,
  mapBootstrapToWorkItems
} from "../api/syncClient";
import { mockBootstrapResponse } from "../data/mockSync";
import type {
  DataSource,
  InspectionStatus,
  OutboxOperation,
  OutboxState,
  SyncOperationResult,
  WorkItem
} from "../domain/types";
import {
  createAssetUpdateOperation,
  createInspectionOperation,
  createPressureTestOperation,
  loadOutbox,
  markOperationApplied,
  markOperationConflict,
  markOperationPushing,
  markOperationRejected,
  resolveOperationConflict,
  upsertOutboxOperation
} from "../offline/outboxStore";

export type InspectorView = "work" | "capture" | "queue" | "scan";

interface SaveInspectionInput {
  workItem: WorkItem;
  status: InspectionStatus;
  appliedPressureMpa: number;
  requiredPressureMpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  notes: string;
}

interface QueueAssetUpdateInput {
  workItem: WorkItem;
  customerSerialNo: string;
  tag: string;
}

interface QueuePressureTestInput {
  workItem: WorkItem;
  appliedPressureMpa: number;
  requiredPressureMpa: number;
  holdTimeSeconds: number;
  passed: boolean;
}

function pendingOperations(operations: OutboxOperation[]) {
  return operations.filter(
    (operation) =>
      operation.status === "pending" ||
      operation.status === "pushing" ||
      operation.status === "conflict" ||
      operation.status === "rejected"
  );
}

function applyResultToOutbox(result: SyncOperationResult) {
  if (result.status === "applied" && result.version !== null) {
    markOperationApplied(result.op_id, result.version);
    return;
  }

  if (result.status === "conflict" && result.current_version !== null) {
    markOperationConflict(result.op_id, {
      currentVersion: result.current_version,
      payload: result.payload ?? {}
    });
    return;
  }

  markOperationRejected(result.op_id, result.error ?? "Sync operation rejected.");
}

function localInspectionStatus(operation: OutboxOperation): InspectionStatus | null {
  const status = operation.payload.status;
  if (status === "DRAFT" || status === "SUBMITTED") {
    return status;
  }

  return null;
}

function applyLocalOutboxState(
  workItems: WorkItem[],
  operations: OutboxOperation[]
) {
  const localOperationsByAsset = new Map<string, OutboxOperation>();

  for (const operation of operations) {
    if (operation.status !== "applied") {
      localOperationsByAsset.set(operation.assetId, operation);
    }
  }

  return workItems.map((item) => {
    const operation = localOperationsByAsset.get(item.assetId);
    if (!operation) {
      return item;
    }

    return {
      ...item,
      urgency: "draft" as const,
      inspectionStatus: localInspectionStatus(operation) ?? item.inspectionStatus
    };
  });
}

export function useInspectorWorkspace() {
  const [view, setView] = useState<InspectorView>("work");
  const [syncRecords, setSyncRecords] = useState(
    () => mockBootstrapResponse.records
  );
  const [source, setSource] = useState<DataSource>("mock");
  const [cursor, setCursor] = useState(mockBootstrapResponse.cursor);
  const [outbox, setOutbox] = useState<OutboxState>(() => loadOutbox());
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItem | null>(
    null
  );
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [lastSyncLabel, setLastSyncLabel] = useState("Mock data loaded");

  const workItems = useMemo(
    () =>
      applyLocalOutboxState(
        mapBootstrapToWorkItems({ records: syncRecords }),
        outbox.operations
      ),
    [outbox.operations, syncRecords]
  );

  const queuedCount = useMemo(
    () => pendingOperations(outbox.operations).length,
    [outbox.operations]
  );

  useEffect(() => {
    const syncClient = createSyncClient();
    let cancelled = false;

    syncClient
      .bootstrap()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setSyncRecords(response.records);
        setSource("api");
        setCursor(response.cursor);
        setLastSyncLabel("Last sync just now");
      })
      .catch(() => {
        if (!cancelled) {
          setSource("mock");
          setLastSyncLabel("Mock data loaded");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }

    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  function refreshOutbox() {
    setOutbox(loadOutbox());
  }

  function openWorkItem(item: WorkItem) {
    setSelectedWorkItem(item);
    setView("capture");
  }

  function saveInspection(input: SaveInspectionInput) {
    const operation = createInspectionOperation({
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      inspectionId:
        input.workItem.inspectionId ??
        `local-${input.workItem.assetNumber.toLowerCase()}`,
      baseVersion: input.workItem.inspectionId
        ? input.workItem.serverVersion
        : null,
      status: input.status,
      appliedPressureKpa: Math.round(input.appliedPressureMpa * 1000),
      requiredPressureKpa: Math.round(input.requiredPressureMpa * 1000),
      holdTimeSeconds: input.holdTimeSeconds,
      passed: input.passed,
      notes: input.notes,
      inspectionType: "SERVICE"
    });

    upsertOutboxOperation(operation);
    refreshOutbox();
  }

  function queueAssetUpdate(input: QueueAssetUpdateInput) {
    const operation = createAssetUpdateOperation({
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      baseVersion: input.workItem.assetVersion,
      customerSerialNo: input.customerSerialNo,
      tag: input.tag
    });

    upsertOutboxOperation(operation);
    refreshOutbox();
  }

  function queuePressureTest(input: QueuePressureTestInput) {
    const inspectionId =
      input.workItem.inspectionId ??
      `local-${input.workItem.assetNumber.toLowerCase()}`;
    const pressureTestId =
      input.workItem.pressureTestId ??
      `local-pressure-${input.workItem.assetNumber.toLowerCase()}`;
    const operation = createPressureTestOperation({
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      inspectionId,
      pressureTestId,
      baseVersion: input.workItem.pressureTestVersion,
      appliedPressureKpa: Math.round(input.appliedPressureMpa * 1000),
      requiredPressureKpa: Math.round(input.requiredPressureMpa * 1000),
      holdTimeSeconds: input.holdTimeSeconds,
      passed: input.passed
    });

    upsertOutboxOperation(operation);
    refreshOutbox();
  }

  async function pushQueuedOperations() {
    if (!isOnline) {
      return;
    }

    const queue = pendingOperations(loadOutbox().operations).filter(
      (operation) =>
        operation.status === "pending" || operation.status === "rejected"
    );

    if (queue.length === 0) {
      return;
    }

    for (const operation of queue) {
      markOperationPushing(operation.opId);
    }
    refreshOutbox();

    try {
      const result = await createSyncClient().push(queue);
      for (const item of result.results) {
        applyResultToOutbox(item);
      }
      setCursor(result.cursor);
      setLastSyncLabel("Last sync just now");
    } catch (error) {
      for (const operation of queue) {
        markOperationRejected(
          operation.opId,
          error instanceof Error ? error.message : "Sync push failed."
        );
      }
    } finally {
      refreshOutbox();
    }
  }

  async function pullChanges() {
    try {
      const result = await createSyncClient().changes(cursor);
      setSyncRecords((records) =>
        applySyncChangesToRecords(records, result.changes)
      );
      setCursor(result.cursor);
      setLastSyncLabel("Last sync just now");
    } catch {
      setLastSyncLabel("Pull failed; using local data");
    }
  }

  function resolveConflict(opId: string, resolution: "keep-local" | "accept-server") {
    resolveOperationConflict(opId, resolution);
    refreshOutbox();
  }

  return {
    view,
    setView,
    workItems,
    selectedWorkItem,
    outbox,
    source,
    isOnline,
    lastSyncLabel,
    queuedCount,
    openWorkItem,
    saveInspection,
    queueAssetUpdate,
    queuePressureTest,
    pushQueuedOperations,
    pullChanges,
    resolveConflict
  };
}
