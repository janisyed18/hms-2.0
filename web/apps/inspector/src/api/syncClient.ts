import type {
  InspectionStatus,
  OutboxOperation,
  SyncBootstrapResponse,
  SyncChangesResponse,
  SyncPushResponse,
  SyncRecordRead,
  WorkItem,
  WorkUrgency
} from "../domain/types";

const HMS_DEVICE_HEADERS = {
  "X-HMS-Device-Platform": "web",
  "X-HMS-App-Version": "0.1.0"
};

type FetchLike = typeof fetch;

export interface SyncRuntimeAuth {
  getAccessToken: () => string | null;
  refreshAccessToken?: () => Promise<string>;
  onAuthFailure?: () => void;
}

interface SyncClientOptions extends SyncRuntimeAuth {
  fetchImpl?: FetchLike;
  deviceId?: string;
}

let runtimeAuth: SyncRuntimeAuth | null = null;

export class SyncAuthenticationError extends Error {
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
    this.name = "SyncAuthenticationError";
  }
}

export function configureSyncRuntimeAuth(auth: SyncRuntimeAuth): () => void {
  runtimeAuth = auth;
  return () => {
    if (runtimeAuth === auth) {
      runtimeAuth = null;
    }
  };
}

function browserDeviceId(): string {
  const storageKey = "hms.inspector.device-id";
  if (typeof window === "undefined" || !window.localStorage) {
    return "inspector-browser-unavailable";
  }

  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deviceId = `inspector-browser-${suffix}`;
  window.localStorage.setItem(storageKey, deviceId);
  return deviceId;
}

interface ApiCustomerSummary {
  id: string;
  code?: string;
  name: string;
}

interface ApiProductSummary {
  id: string;
  code?: string;
  name: string;
  category?: string;
}

interface ApiLocationSummary {
  id: string;
  name: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiAssetPayload {
  id: string;
  asset_number: string;
  customer_serial_no: string | null;
  tag: string | null;
  lifecycle_status: string;
  next_retest_due_at: string | null;
  customer_id?: string;
  product_id?: string;
  location_id?: string | null;
  customer?: ApiCustomerSummary;
  product?: ApiProductSummary;
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
  booking_id: string | null;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  inspection_type: string;
}

interface ApiPressureTestPayload {
  id: string;
  inspection_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCustomerPayload(value: unknown): ApiCustomerSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    code: optionalString(value.code),
    name: value.name
  };
}

function asProductPayload(value: unknown): ApiProductSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    code: optionalString(value.code),
    name: value.name,
    category: optionalString(value.category)
  };
}

function asLocationPayload(value: unknown): ApiLocationSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    address_1: nullableString(value.address_1),
    address_2: nullableString(value.address_2),
    city: nullableString(value.city),
    state: nullableString(value.state),
    country: nullableString(value.country)
  };
}

function locationAddress(location: ApiLocationSummary | null): string | null {
  if (!location) {
    return null;
  }
  const parts = [
    location.address_1,
    location.address_2,
    location.city,
    location.state,
    location.country
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function asAssetPayload(value: unknown): ApiAssetPayload | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.asset_number !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    asset_number: value.asset_number,
    customer_serial_no: nullableString(value.customer_serial_no),
    tag: nullableString(value.tag),
    lifecycle_status: optionalString(value.lifecycle_status) ?? "UNKNOWN",
    next_retest_due_at: nullableString(value.next_retest_due_at),
    customer_id: optionalString(value.customer_id),
    product_id: optionalString(value.product_id),
    location_id: nullableString(value.location_id),
    customer: asCustomerPayload(value.customer) ?? undefined,
    product: asProductPayload(value.product) ?? undefined,
    location: asLocationPayload(value.location)
  };
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

function asPressureTestPayload(value: unknown): ApiPressureTestPayload | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.inspection_id !== "string"
  ) {
    return null;
  }

  return value as unknown as ApiPressureTestPayload;
}

async function requestJson<TResponse>(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit,
  auth: SyncRuntimeAuth,
  deviceId: string
): Promise<TResponse> {
  async function send(accessToken: string) {
    return fetchImpl(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...HMS_DEVICE_HEADERS,
        "X-HMS-Device-Id": deviceId,
        Authorization: `Bearer ${accessToken}`,
        ...init.headers
      }
    });
  }

  const accessToken = auth.getAccessToken();
  if (!accessToken) {
    auth.onAuthFailure?.();
    throw new SyncAuthenticationError();
  }

  let response = await send(accessToken);
  if (response.status === 401 && auth.refreshAccessToken) {
    try {
      response = await send(await auth.refreshAccessToken());
    } catch {
      auth.onAuthFailure?.();
      throw new SyncAuthenticationError();
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      auth.onAuthFailure?.();
      throw new SyncAuthenticationError();
    }
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
    , work_context: operation.workContext
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

function inspectionStatus(status: string | undefined): InspectionStatus | null {
  if (status === "DRAFT" || status === "SUBMITTED") {
    return status;
  }

  return null;
}

export function mapBootstrapToWorkItems(
  response: Pick<SyncBootstrapResponse, "records" | "work_contexts">
): WorkItem[] {
  const customersById = new Map<string, ApiCustomerSummary>();
  const productsById = new Map<string, ApiProductSummary>();
  const locationsById = new Map<string, ApiLocationSummary>();
  const schedulesByAsset = new Map<string, ApiRetestSchedulePayload>();
  const inspectionsByAsset = new Map<
    string,
    { payload: ApiInspectionPayload; version: number }
  >();
  const pressureTestsByInspection = new Map<
    string,
    { payload: ApiPressureTestPayload; version: number }
  >();
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

    if (record.entity === "Customer") {
      const customer = asCustomerPayload(record.payload);
      if (customer) {
        customersById.set(customer.id, customer);
      }
    }

    if (record.entity === "Product") {
      const product = asProductPayload(record.payload);
      if (product) {
        productsById.set(product.id, product);
      }
    }

    if (record.entity === "CustomerLocation") {
      const location = asLocationPayload(record.payload);
      if (location) {
        locationsById.set(location.id, location);
      }
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
        inspectionsByAsset.set(`${inspection.asset_id}:${inspection.booking_id}`, {
          payload: inspection,
          version: record.version
        });
      }
    }

    if (record.entity === "PressureTestResult") {
      const pressureTest = asPressureTestPayload(record.payload);
      if (pressureTest) {
        pressureTestsByInspection.set(pressureTest.inspection_id, {
          payload: pressureTest,
          version: record.version
        });
      }
    }
  }

  return assets
    .flatMap(({ record, payload }) => (response.work_contexts ?? [])
      .filter((context) => context.asset_id === payload.id)
      .map((context) => {
      const schedule = schedulesByAsset.get(payload.id);
      const inspection = inspectionsByAsset.get(`${payload.id}:${context.booking_id}`);
      const pressureTest = inspection
        ? pressureTestsByInspection.get(inspection.payload.id)
        : undefined;
      const customer =
        payload.customer ??
        (payload.customer_id ? customersById.get(payload.customer_id) : undefined);
      const product =
        payload.product ??
        (payload.product_id ? productsById.get(payload.product_id) : undefined);
      const location =
        payload.location ??
        (payload.location_id ? locationsById.get(payload.location_id) ?? null : null);

      return {
        id: context.assignment_id,
        workContext: context,
        assetId: payload.id,
        assetNumber: payload.asset_number,
        customerSerialNo: payload.customer_serial_no,
        tag: payload.tag,
        customerName: customer?.name ?? "Unknown customer",
        locationName: location?.name ?? null,
        locationAddress: locationAddress(location),
        productName: product?.name ?? "Unknown product",
        lifecycleStatus: payload.lifecycle_status,
        retestDueAt: schedule?.due_at ?? payload.next_retest_due_at,
        urgency: urgencyFromSchedule(schedule, inspection?.payload),
        assetVersion: record.version,
        serverVersion: inspection?.version ?? record.version,
        inspectionId: inspection?.payload.id ?? null,
        inspectionStatus: inspectionStatus(inspection?.payload.status),
        pressureTestId: pressureTest?.payload.id ?? null,
        pressureTestVersion: pressureTest?.version ?? null
      } satisfies WorkItem;
    }))
    .sort((left, right) => {
      const priority = { overdue: 0, "due-today": 1, draft: 2, synced: 3 };
      return priority[left.urgency] - priority[right.urgency];
    });
}

export function applySyncChangesToRecords(
  records: SyncRecordRead[],
  changes: SyncRecordRead[]
): SyncRecordRead[] {
  const nextRecords = new Map(
    records.map((record) => [`${record.entity}:${record.entity_id}`, record])
  );

  for (const change of changes) {
    const key = `${change.entity}:${change.entity_id}`;
    if (change.op === "delete") {
      nextRecords.delete(key);
    } else {
      nextRecords.set(key, change);
    }
  }

  return [...nextRecords.values()].sort((left, right) => {
    const leftSeq = left.seq ?? 0;
    const rightSeq = right.seq ?? 0;

    if (leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }

    return `${left.entity}:${left.entity_id}`.localeCompare(
      `${right.entity}:${right.entity_id}`
    );
  });
}

export function createSyncClient(options: Partial<SyncClientOptions> = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth: SyncRuntimeAuth = {
    getAccessToken: options.getAccessToken ?? runtimeAuth?.getAccessToken ?? (() => null),
    refreshAccessToken: options.refreshAccessToken ?? runtimeAuth?.refreshAccessToken,
    onAuthFailure: options.onAuthFailure ?? runtimeAuth?.onAuthFailure
  };
  const deviceId = options.deviceId ?? browserDeviceId();

  function request<TResponse>(path: string, init: RequestInit = {}) {
    return requestJson<TResponse>(fetchImpl, path, init, auth, deviceId);
  }

  return {
    bootstrap() {
      return request<SyncBootstrapResponse>("/api/v1/sync/bootstrap");
    },

    changes(since: number) {
      return request<SyncChangesResponse>(`/api/v1/sync/changes?since=${since}`);
    },

    push(operations: OutboxOperation[]) {
      return request<SyncPushResponse>("/api/v1/sync/push", {
        method: "POST",
        body: JSON.stringify({
          operations: operations.map(toApiOperation)
        })
      });
    },

    operations(operations: OutboxOperation[]) {
      return request<SyncPushResponse>("/api/v1/sync/operations", {
        method: "POST",
        body: JSON.stringify({
          operations: operations.map(toApiOperation)
        })
      });
    }
  };
}
