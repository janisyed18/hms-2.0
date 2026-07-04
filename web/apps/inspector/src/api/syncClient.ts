import type {
  OutboxOperation,
  SyncBootstrapResponse,
  SyncChangesResponse,
  SyncPushResponse,
  WorkItem,
  WorkUrgency
} from "../domain/types";

const HMS_HEADERS = {
  "Content-Type": "application/json",
  "X-HMS-User-Id": "inspector-ui-dev",
  "X-HMS-Roles": "INSPECTOR",
  "X-HMS-Device-Id": "inspector-browser-dev",
  "X-HMS-Device-Platform": "web",
  "X-HMS-App-Version": "0.1.0"
};

type FetchLike = typeof fetch;

interface ApiCustomerSummary {
  id: string;
  code: string;
  name: string;
}

interface ApiProductSummary {
  id: string;
  code: string;
  name: string;
  category: string;
}

interface ApiLocationSummary {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiAssetPayload {
  id: string;
  asset_number: string;
  lifecycle_status: string;
  next_retest_due_at: string | null;
  customer: ApiCustomerSummary;
  product: ApiProductSummary;
  location: ApiLocationSummary | null;
}

interface ApiRetestSchedulePayload {
  id: string;
  asset_id: string;
  due_at: string | null;
  status: "UPCOMING" | "DUE" | "OVERDUE" | "SUSPENDED";
}

interface ApiInspectionPayload {
  id: string;
  asset_id: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  inspection_type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asAssetPayload(value: unknown): ApiAssetPayload | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.asset_number !== "string" ||
    !isRecord(value.customer) ||
    !isRecord(value.product)
  ) {
    return null;
  }

  return value as unknown as ApiAssetPayload;
}

function asSchedulePayload(value: unknown): ApiRetestSchedulePayload | null {
  if (
    !isRecord(value) ||
    typeof value.asset_id !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }

  return value as unknown as ApiRetestSchedulePayload;
}

function asInspectionPayload(value: unknown): ApiInspectionPayload | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.asset_id !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }

  return value as unknown as ApiInspectionPayload;
}

async function requestJson<TResponse>(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit = {}
): Promise<TResponse> {
  const response = await fetchImpl(path, {
    ...init,
    headers: {
      ...HMS_HEADERS,
      ...init.headers
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Sync request failed with ${response.status}: ${detail || response.statusText}`
    );
  }

  return (await response.json()) as TResponse;
}

function toApiOperation(operation: OutboxOperation) {
  return {
    op_id: operation.opId,
    idempotency_key: operation.idempotencyKey,
    entity: operation.entity,
    entity_id: operation.entityId,
    op: operation.op,
    base_version: operation.baseVersion,
    payload: operation.payload
  };
}

function urgencyFromSchedule(
  schedule: ApiRetestSchedulePayload | undefined,
  inspection: ApiInspectionPayload | undefined
): WorkUrgency {
  if (inspection?.status === "DRAFT") {
    return "draft";
  }

  if (schedule?.status === "OVERDUE") {
    return "overdue";
  }

  if (schedule?.status === "DUE") {
    return "due-today";
  }

  return "synced";
}

export function mapBootstrapToWorkItems(
  response: SyncBootstrapResponse
): WorkItem[] {
  const schedulesByAsset = new Map<string, ApiRetestSchedulePayload>();
  const inspectionsByAsset = new Map<string, ApiInspectionPayload>();
  const assets = response.records
    .filter((record) => record.op === "upsert" && record.entity === "Asset")
    .map((record) => ({
      record,
      payload: asAssetPayload(record.payload)
    }))
    .filter(
      (entry): entry is { record: (typeof response.records)[number]; payload: ApiAssetPayload } =>
        entry.payload !== null
    );

  for (const record of response.records) {
    if (record.op !== "upsert") {
      continue;
    }

    if (record.entity === "RetestSchedule") {
      const schedule = asSchedulePayload(record.payload);
      if (schedule) {
        schedulesByAsset.set(schedule.asset_id, schedule);
      }
    }

    if (record.entity === "Inspection") {
      const inspection = asInspectionPayload(record.payload);
      if (inspection) {
        inspectionsByAsset.set(inspection.asset_id, inspection);
      }
    }
  }

  return assets
    .map(({ record, payload }) => {
      const schedule = schedulesByAsset.get(payload.id);
      const inspection = inspectionsByAsset.get(payload.id);

      return {
        id: payload.id,
        assetId: payload.id,
        assetNumber: payload.asset_number,
        customerName: payload.customer.name,
        locationName: payload.location?.name ?? null,
        productName: payload.product.name,
        lifecycleStatus: payload.lifecycle_status,
        retestDueAt: schedule?.due_at ?? payload.next_retest_due_at,
        urgency: urgencyFromSchedule(schedule, inspection),
        serverVersion: record.version,
        inspectionId: inspection?.id ?? null,
        inspectionStatus: inspection?.status === "DRAFT" ? "DRAFT" : null
      } satisfies WorkItem;
    })
    .sort((left, right) => {
      const priority = { overdue: 0, "due-today": 1, draft: 2, synced: 3 };
      return priority[left.urgency] - priority[right.urgency];
    });
}

export function createSyncClient(options: { fetchImpl?: FetchLike } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    bootstrap() {
      return requestJson<SyncBootstrapResponse>(
        fetchImpl,
        "/api/v1/sync/bootstrap"
      );
    },

    changes(since: number) {
      return requestJson<SyncChangesResponse>(
        fetchImpl,
        `/api/v1/sync/changes?since=${since}`
      );
    },

    push(operations: OutboxOperation[]) {
      return requestJson<SyncPushResponse>(fetchImpl, "/api/v1/sync/push", {
        method: "POST",
        body: JSON.stringify({
          operations: operations.map(toApiOperation)
        })
      });
    },

    operations(operations: OutboxOperation[]) {
      return requestJson<SyncPushResponse>(fetchImpl, "/api/v1/sync/operations", {
        method: "POST",
        body: JSON.stringify({
          operations: operations.map(toApiOperation)
        })
      });
    }
  };
}
