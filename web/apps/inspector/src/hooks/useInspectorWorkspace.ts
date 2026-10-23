import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSyncClient,
  discardBootstrapProgress,
  mapBootstrapToWorkItems
} from "../api/syncClient";
import type { SavedInspectionForm } from "../domain/inspectionForm";
import type {
  InspectionStatus,
  PressureTestDraft,
  OutboxOperation,
  OutboxState,
  SyncOperationResult,
  SyncRecordRead,
  SyncWorkContext,
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
  /** The instruction: PASS or REPAIR. */
  result: string | null;
  pressureTest: PressureTestDraft;
}

interface QueueAssetUpdateInput {
  workItem: WorkItem;
  customerSerialNo: string;
  tag: string;
}

interface QueuePressureTestInput {
  workItem: WorkItem;
  pressureTest: PressureTestDraft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The form values a queued operation carries, so a draft reopens as it was left. */
function savedFromOperation(operation: OutboxOperation): SavedInspectionForm | null {
  const pressure = operation.entity === "Inspection"
    ? operation.payload.pressure_test
    : operation.payload;
  if (
    !isRecord(pressure) ||
    typeof pressure.applied_pressure_kpa !== "number" ||
    typeof pressure.hold_time_seconds !== "number"
  ) {
    return null;
  }
  return {
    result: operation.entity === "Inspection" && typeof operation.payload.result === "string"
      ? operation.payload.result
      : null,
    appliedPressureKpa: pressure.applied_pressure_kpa,
    holdTimeSeconds: pressure.hold_time_seconds,
    passed: pressure.passed === true,
    measurements: isRecord(pressure.measurements) ? pressure.measurements : null
  };
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

function sameWorkContext(left: SyncWorkContext | undefined, right: SyncWorkContext | undefined) {
  return Boolean(left && right && left.appointment_id === right.appointment_id &&
    left.booking_id === right.booking_id && left.revision_id === right.revision_id &&
    left.assignment_id === right.assignment_id && left.asset_id === right.asset_id);
}

function operationIsAssigned(operation: OutboxOperation, records: SyncRecordRead[], contexts: SyncWorkContext[], localOperations: OutboxOperation[] = []) {
  const context = operation.workContext;
  if (!context || operation.assetId !== context.asset_id ||
      !contexts.some((item) => sameWorkContext(item, context))) return false;
  const hasRecord = (entity: string, id: string) => records.some(
    (record) => record.entity === entity && record.entity_id === id && record.op !== "delete"
  );
  if (!hasRecord("Asset", operation.assetId)) return false;
  if (operation.entity === "Inspection" && operation.op !== "create") {
    return hasRecord("Inspection", operation.entityId);
  }
  if (operation.entity === "PressureTestResult") {
    if (operation.op !== "create") return hasRecord("PressureTestResult", operation.entityId);
    return typeof operation.payload.inspection_id === "string" &&
      (hasRecord("Inspection", operation.payload.inspection_id) ||
       localOperations.some((candidate) => candidate.entity === "Inspection" &&
         candidate.entityId === operation.payload.inspection_id &&
         candidate.op === "create" && sameWorkContext(candidate.workContext, context)));
  }
  return true;
}

function applyResultToOutbox(userId: string, result: SyncOperationResult) {
  if (result.status === "applied" && result.version !== null) {
    markOperationApplied(userId, result.op_id, result.version);
    return;
  }

  if (result.status === "conflict" && result.current_version !== null) {
    markOperationConflict(userId, result.op_id, {
      currentVersion: result.current_version,
      payload: result.payload ?? {}
    });
    return;
  }

  markOperationRejected(userId, result.op_id, result.error ?? "Sync operation rejected.");
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
      localOperationsByAsset.set(operation.workContext?.assignment_id ?? "", operation);
    }
  }

  return workItems.map((item) => {
    const operation = localOperationsByAsset.get(item.workContext?.assignment_id ?? "");
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

export function useInspectorWorkspace(userId: string) {
  const [view, setView] = useState<InspectorView>("work");
  const [syncRecords, setSyncRecords] = useState<SyncRecordRead[]>([]);
  const [workContexts, setWorkContexts] = useState<SyncWorkContext[]>([]);
  const [outbox, setOutbox] = useState<OutboxState>(() => loadOutbox(userId));
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItem | null>(
    null
  );
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [lastSyncLabel, setLastSyncLabel] = useState("Loading assigned work");
  const [offlineExpiresAt, setOfflineExpiresAt] = useState<number | null>(null);
  const refreshGeneration = useRef(0);

  const visibleOutbox = useMemo(
    () => ({ ...outbox, operations: outbox.operations.filter((operation) => operationIsAssigned(operation, syncRecords, workContexts, outbox.operations)) }),
    [syncRecords, outbox, workContexts]
  );

  const workItems = useMemo(
    () =>
      applyLocalOutboxState(
        mapBootstrapToWorkItems({ records: syncRecords, work_contexts: workContexts }),
        visibleOutbox.operations
      ),
    [visibleOutbox.operations, syncRecords, workContexts]
  );

  const queuedCount = useMemo(
    () => pendingOperations(visibleOutbox.operations).length,
    [visibleOutbox.operations]
  );

  const refreshAssignments = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const response = await createSyncClient({ userId }).bootstrap();
    if (generation !== refreshGeneration.current) {
      throw new Error("Assignment refresh was superseded");
    }
    const contexts = response.work_contexts ?? [];
    setSyncRecords(response.records);
    setWorkContexts(contexts);
    setOfflineExpiresAt(Date.now() + Math.max(0, Math.min(response.device.offline_window_days, 7)) * 86400000);
    setSelectedWorkItem((item) => item && contexts.some(
      (context) => sameWorkContext(context, item.workContext)
    ) ? item : null);
    setLastSyncLabel("Last sync just now");
    return response;
  }, [userId]);

  useEffect(() => {
    void refreshAssignments().catch(() => setLastSyncLabel("Unable to load assigned work"));
    return () => { refreshGeneration.current += 1; };
  }, [refreshAssignments]);

  // A half-finished bootstrap is private to this user: drop it on sign-out or when
  // another user takes over.
  useEffect(() => () => discardBootstrapProgress(userId), [userId]);

  useEffect(() => {
    if (offlineExpiresAt === null) return;
    const expire = () => {
      setSyncRecords([]);
      setWorkContexts([]);
      setSelectedWorkItem(null);
      setLastSyncLabel("Offline access expired; reconnect to refresh assignments");
    };
    const timeout = window.setTimeout(expire, Math.max(0, offlineExpiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [offlineExpiresAt]);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      setSyncRecords([]);
      setWorkContexts([]);
      setSelectedWorkItem(null);
      setLastSyncLabel("Refreshing assignments");
      void refreshAssignments().catch(() => setLastSyncLabel("Unable to load assigned work"));
    }

    function handleOffline() {
      setIsOnline(false);
      refreshGeneration.current += 1;
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshAssignments]);

  function refreshOutbox() {
    setOutbox(loadOutbox(userId));
  }

  function localInspectionId(item: WorkItem): string {
    if (item.inspectionId) return item.inspectionId;
    const matching = loadOutbox(userId).operations.filter((operation) =>
      sameWorkContext(operation.workContext, item.workContext)
    );
    const inspection = matching.find((operation) => operation.entity === "Inspection");
    if (inspection) return inspection.entityId;
    const pressure = matching.find((operation) => operation.entity === "PressureTestResult");
    if (pressure && typeof pressure.payload.inspection_id === "string") {
      return pressure.payload.inspection_id;
    }
    return crypto.randomUUID();
  }

  /** What to show when this assignment is opened: the unsent local edit if any, else the server's. */
  function draftFor(item: WorkItem): SavedInspectionForm | null {
    const local = loadOutbox(userId).operations
      .filter((operation) =>
        operation.status !== "applied" &&
        (operation.entity === "Inspection" || operation.entity === "PressureTestResult") &&
        sameWorkContext(operation.workContext, item.workContext))
      .map(savedFromOperation)
      .find((saved) => saved !== null);
    return local ?? item.saved;
  }

  function openWorkItem(item: WorkItem) {
    setSelectedWorkItem(item);
    setView("capture");
  }

  function saveInspection(input: SaveInspectionInput) {
    const operation = createInspectionOperation({
      workContext: input.workItem.workContext,
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      inspectionId: localInspectionId(input.workItem),
      baseVersion: input.workItem.inspectionId
        ? input.workItem.serverVersion
        : null,
      status: input.status,
      result: input.result,
      pressureTest: input.pressureTest,
      inspectionType: "SERVICE"
    });

    upsertOutboxOperation(userId, operation);
    refreshOutbox();
  }

  function queueAssetUpdate(input: QueueAssetUpdateInput) {
    const operation = createAssetUpdateOperation({
      workContext: input.workItem.workContext,
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      baseVersion: input.workItem.assetVersion,
      customerSerialNo: input.customerSerialNo,
      tag: input.tag
    });

    upsertOutboxOperation(userId, operation);
    refreshOutbox();
  }

  function queuePressureTest(input: QueuePressureTestInput) {
    const inspectionId = localInspectionId(input.workItem);
    const pressureTestId =
      input.workItem.pressureTestId ??
      loadOutbox(userId).operations.find((operation) =>
        operation.entity === "PressureTestResult" &&
        sameWorkContext(operation.workContext, input.workItem.workContext)
      )?.entityId ?? crypto.randomUUID();
    const operation = createPressureTestOperation({
      workContext: input.workItem.workContext,
      assetId: input.workItem.assetId,
      assetNumber: input.workItem.assetNumber,
      customerName: input.workItem.customerName,
      inspectionId,
      pressureTestId,
      baseVersion: input.workItem.pressureTestVersion,
      ...input.pressureTest
    });

    upsertOutboxOperation(userId, operation);
    refreshOutbox();
  }

  async function pushQueuedOperations() {
    if (!isOnline) {
      return;
    }

    let permitted: { records: SyncRecordRead[]; work_contexts?: SyncWorkContext[] };
    try {
      permitted = await refreshAssignments();
    } catch {
      setSyncRecords([]);
      setWorkContexts([]);
      setSelectedWorkItem(null);
      setLastSyncLabel("Unable to verify assignments");
      return;
    }
    const localOperations = loadOutbox(userId).operations;
    const queue = pendingOperations(localOperations).filter(
      (operation) =>
        operationIsAssigned(operation, permitted.records, permitted.work_contexts ?? []) &&
        (operation.status === "pending" || operation.status === "rejected")
    );

    if (queue.length === 0) {
      return;
    }

    for (const operation of queue) {
      markOperationPushing(userId, operation.opId);
    }
    refreshOutbox();

    try {
      const result = await createSyncClient({ userId }).push(queue);
      for (const item of result.results) {
        applyResultToOutbox(userId, item);
      }
      setLastSyncLabel("Last sync just now");
    } catch (error) {
      for (const operation of queue) {
        markOperationRejected(
          userId,
          operation.opId,
          error instanceof Error ? error.message : "Sync push failed."
        );
      }
    } finally {
      refreshOutbox();
    }
    try {
      await refreshAssignments();
    } catch {
      setSyncRecords([]);
      setWorkContexts([]);
      setSelectedWorkItem(null);
      setLastSyncLabel("Unable to load assigned work");
    }
  }

  async function pullChanges() {
    try {
      setSyncRecords([]);
      setWorkContexts([]);
      setSelectedWorkItem(null);
      await refreshAssignments();
    } catch {
      setLastSyncLabel("Unable to load assigned work");
    }
  }

  function resolveConflict(opId: string, resolution: "keep-local" | "accept-server") {
    resolveOperationConflict(userId, opId, resolution);
    refreshOutbox();
  }

  return {
    view,
    setView,
    workItems,
    selectedWorkItem,
    outbox: visibleOutbox,
    hasPreservedDrafts: pendingOperations(outbox.operations).some(
      (operation) => !operationIsAssigned(operation, syncRecords, workContexts, outbox.operations)
    ),
    isOnline,
    lastSyncLabel,
    queuedCount,
    openWorkItem,
    draftFor,
    saveInspection,
    queueAssetUpdate,
    queuePressureTest,
    pushQueuedOperations,
    pullChanges,
    resolveConflict
  };
}
