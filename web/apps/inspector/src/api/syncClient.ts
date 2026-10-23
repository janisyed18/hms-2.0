import {
  defaultSyncStore,
  scopeKey,
  type ActiveSnapshot,
  type StagingChunk,
  type StagingProgress,
  type SyncScope,
  type SyncStore
} from "../offline/syncStore";
import type { PressureRating, SavedInspectionForm } from "../domain/inspectionForm";
import type {
  InspectionStatus,
  OutboxOperation,
  SyncBootstrapResponse,
  SyncChangesResponse,
  SyncPushResponse,
  SyncRecordRead,
  SyncWorkContext,
  WorkItem,
  WorkUrgency
} from "../domain/types";

// App 0.2.0 is the first release that pages the bootstrap. The protocol header, not
// the app version string, is what the server uses to tell it from an older client.
export const SYNC_PROTOCOL_VERSION = 2;

const HMS_DEVICE_HEADERS = {
  "X-HMS-Device-Platform": "web",
  "X-HMS-App-Version": "0.2.0",
  "X-HMS-Sync-Protocol": String(SYNC_PROTOCOL_VERSION)
};

type FetchLike = typeof fetch;

export interface SyncRuntimeAuth {
  getAccessToken: () => string | null;
  refreshAccessToken?: () => Promise<string>;
  onAuthFailure?: () => void;
}

interface SyncClientOptions extends SyncRuntimeAuth {
  fetchImpl?: FetchLike;
  store?: SyncStore;
  now?: () => number;
  deviceId?: string;
  // The signed-in user, used to scope the device id.
  userId?: string;
}

let runtimeAuth: SyncRuntimeAuth | null = null;

export class SyncAuthenticationError extends Error {
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
    this.name = "SyncAuthenticationError";
  }
}

/** A non-2xx sync response, with the status and (when JSON) the error code. */
export class SyncRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, statusText: string, body: string) {
    super(`Sync request failed with ${status}: ${body || statusText}`);
    this.name = "SyncRequestError";
    this.status = status;
    this.code = errorCode(body);
  }
}

function errorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return null;
    const detail = isRecord(parsed.detail) ? parsed.detail : parsed;
    return typeof detail.code === "string" ? detail.code : null;
  } catch {
    return null;
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

const DEVICE_ID_STORAGE_PREFIX = "hms.inspector.device-id";

// Ids that could not be persisted (storage blocked or unavailable), kept for the life
// of the page so one session is still one device.
const unpersistedDeviceIds = new Map<string, string>();

function newDeviceId(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `inspector-browser-${suffix}`;
}

function deviceStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  } catch {
    // Some browsers throw on merely touching localStorage (blocked site data).
    return null;
  }
}

/**
 * The device id this browser sends for the signed-in user.
 *
 * The server binds a device id to the first user who syncs with it and refuses it for
 * anyone else, so the id must belong to the user, not to the browser profile: two
 * inspectors sharing a profile each get their own. It is random, persisted per user,
 * and never a literal shared across users. A request with no signed-in user gets a
 * page-lifetime id that is not persisted. The old browser-wide id is deliberately
 * ignored: it was registered to whoever synced first and would lock out everyone else.
 */
function browserDeviceId(userId: string | undefined): string {
  const scope = userId ?? "";
  const store = userId === undefined ? null : deviceStorage();
  const key = `${DEVICE_ID_STORAGE_PREFIX}:${scope}`;
  try {
    const existing = store?.getItem(key);
    if (existing) {
      return existing;
    }
  } catch {
    // Fall through to the in-memory id.
  }
  const remembered = unpersistedDeviceIds.get(scope);
  if (remembered) {
    return remembered;
  }
  const created = newDeviceId();
  unpersistedDeviceIds.set(scope, created);
  try {
    store?.setItem(key, created);
  } catch {
    // Keep the in-memory id.
  }
  return created;
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
  pressure_rating?: unknown;
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
  result: string | null;
}

interface ApiPressureTestPayload {
  id: string;
  inspection_id: string;
  applied_pressure_kpa: number;
  hold_time_seconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
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
    location: asLocationPayload(value.location),
    pressure_rating: value.pressure_rating
  };
}

function asPressureRating(value: unknown): PressureRating | null {
  if (
    !isRecord(value) ||
    typeof value.working_pressure_kpa !== "number" ||
    typeof value.test_pressure_kpa !== "number"
  ) {
    return null;
  }
  return {
    workingPressureKpa: value.working_pressure_kpa,
    testPressureKpa: value.test_pressure_kpa
  };
}

function savedInspectionForm(
  inspection: ApiInspectionPayload | undefined,
  pressureTest: ApiPressureTestPayload | undefined
): SavedInspectionForm | null {
  if (!inspection || !pressureTest) return null;
  return {
    result: typeof inspection.result === "string" ? inspection.result : null,
    appliedPressureKpa: pressureTest.applied_pressure_kpa,
    holdTimeSeconds: pressureTest.hold_time_seconds,
    passed: pressureTest.passed === true,
    measurements: isRecord(pressureTest.measurements) ? pressureTest.measurements : null
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
    throw new SyncRequestError(
      response.status,
      response.statusText,
      await response.text()
    );
  }

  return (await response.json()) as TResponse;
}

class RestartBootstrap extends Error {}

/** The records and contexts a saved staging state adds up to. */
function rebuild(chunks: StagingChunk[]): {
  records: SyncRecordRead[];
  workContexts: SyncWorkContext[];
} {
  let records: SyncRecordRead[] = [];
  const workContexts: SyncWorkContext[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === "page") {
      records = records.concat(chunk.records);
      workContexts.push(...chunk.workContexts);
    } else {
      records = applySyncChangesToRecords(records, chunk.records);
    }
  }
  return { records, workContexts };
}

function isInvalidPageToken(error: unknown): boolean {
  return error instanceof SyncRequestError && error.code === "SYNC_PAGE_TOKEN_INVALID";
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
        inspectionLocked: inspection !== undefined && inspection.payload.status !== "DRAFT",
        pressureTestId: pressureTest?.payload.id ?? null,
        pressureTestVersion: pressureTest?.version ?? null,
        pressureRating: asPressureRating(payload.pressure_rating),
        saved: savedInspectionForm(inspection?.payload, pressureTest?.payload)
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

const MAX_BOOTSTRAP_RESTARTS = 3;
const CHANGES_PAGE_SIZE = 500;
// The most the Inspector will trust a snapshot offline, whatever the server grants.
const MAX_OFFLINE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Latest bootstrap run per scope: a newer call supersedes an older one in flight. */
const latestRun = new Map<string, number>();
let bootstrapRuns = 0;

export type BootstrapResult = SyncBootstrapResponse & {
  /** Absolute time (ms) the promoted snapshot stops being usable offline. */
  expiresAt: number;
};

export type SavedSnapshot =
  | { status: "none" }
  | { status: "expired" }
  | { status: "ready"; snapshot: ActiveSnapshot };

export class BootstrapSupersededError extends Error {
  constructor() {
    super("Assignment refresh was superseded");
    this.name = "BootstrapSupersededError";
  }
}

export class SyncUpgradeRequiredError extends Error {
  constructor() {
    super("This version of the app is too old to load your assigned work. Update the app.");
    this.name = "SyncUpgradeRequiredError";
  }
}

export function createSyncClient(options: Partial<SyncClientOptions> = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth: SyncRuntimeAuth = {
    getAccessToken: options.getAccessToken ?? runtimeAuth?.getAccessToken ?? (() => null),
    refreshAccessToken: options.refreshAccessToken ?? runtimeAuth?.refreshAccessToken,
    onAuthFailure: options.onAuthFailure ?? runtimeAuth?.onAuthFailure
  };
  const deviceId = options.deviceId ?? browserDeviceId(options.userId);

  function request<TResponse>(path: string, init: RequestInit = {}) {
    return requestJson<TResponse>(fetchImpl, path, init, auth, deviceId);
  }

  const store = options.store ?? defaultSyncStore();
  const now = options.now ?? Date.now;
  // Without a signed-in user there is nothing to scope persisted data to.
  const scope: SyncScope = {
    userId: options.userId ?? "",
    deviceId,
    protocol: SYNC_PROTOCOL_VERSION
  };

  // A failing store (quota, blocked storage) must not stop syncing: the run carries on
  // from memory and simply is not restartable.
  async function persist<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch {
      return null;
    }
  }

  function emptyProgress(): StagingProgress {
    return {
      snapshot: 0,
      nextToken: null,
      pagesComplete: false,
      changesCursor: 0,
      device: null,
      chunkCount: 0,
      updatedAt: now()
    };
  }

  async function promote(
    source: { device: SyncBootstrapResponse["device"] | null },
    cursor: number,
    records: SyncRecordRead[],
    workContexts: SyncWorkContext[]
  ): Promise<BootstrapResult> {
    const device = source.device as SyncBootstrapResponse["device"];
    const days = Math.max(0, Math.min(device.offline_window_days, MAX_OFFLINE_DAYS));
    const promotedAt = now();
    const snapshot: ActiveSnapshot = {
      device,
      cursor,
      records,
      workContexts,
      expiresAt: promotedAt + days * DAY_MS,
      promotedAt
    };
    await persist(() => store.promote(scope, snapshot));
    return {
      device,
      cursor,
      has_more: false,
      records,
      work_contexts: workContexts,
      expiresAt: snapshot.expiresAt
    };
  }

  function bootstrapPage(pageToken?: string) {
    const query = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : "";
    return request<SyncBootstrapResponse>(`/api/v1/sync/bootstrap${query}`);
  }

  function changesPage(since: number, limit?: number) {
    const size = limit === undefined ? "" : `&limit=${limit}`;
    return request<SyncChangesResponse>(`/api/v1/sync/changes?since=${since}${size}`);
  }

  return {
    bootstrapPage,

    /**
     * The last fully reconciled snapshot saved for this user and device, if it is
     * still inside its offline window. An expired one is deleted, not returned.
     */
    async loadSnapshot(): Promise<SavedSnapshot> {
      const saved = await persist(() => store.loadActive(scope));
      if (!saved) return { status: "none" };
      if (saved.expiresAt <= now()) {
        await persist(() => store.discardActive(scope));
        return { status: "expired" };
      }
      return { status: "ready", snapshot: saved };
    },

    /**
     * The whole assigned dataset: every bootstrap page, then the changes committed
     * since the first page's watermark. Each completed page and change batch is saved
     * to the sync store, so a dropped connection, a reload or a crash continues from
     * the last saved step rather than page one. The result is promoted to the active
     * snapshot in one transaction only when everything has reconciled; until then the
     * previous snapshot stays untouched.
     */
    async bootstrap(): Promise<BootstrapResult> {
      const runKey = scopeKey(scope);
      const run = ++bootstrapRuns;
      latestRun.set(runKey, run);
      const guard = () => {
        if (latestRun.get(runKey) !== run) throw new BootstrapSupersededError();
      };

      for (let restart = 0; restart <= MAX_BOOTSTRAP_RESTARTS; restart += 1) {
        let staged = await persist(() => store.loadStaging(scope));
        guard();
        if (!staged) {
          const fresh = emptyProgress();
          await persist(() => store.beginStaging(scope, fresh));
          staged = { progress: fresh, chunks: [] };
        }
        let progress = staged.progress;
        let { records, workContexts } = rebuild(staged.chunks);

        try {
          while (!progress.pagesComplete) {
            const token = progress.nextToken ?? undefined;
            const page = await bootstrapPage(token);
            guard();
            if (page.protocol_version !== SYNC_PROTOCOL_VERSION) {
              // A server that predates paging answered with everything at once.
              return await promote(page, page.cursor, page.records, page.work_contexts ?? []);
            }
            if (token !== undefined && page.cursor !== progress.snapshot) {
              throw new RestartBootstrap();
            }
            const last = !(page.has_more && page.next_page_token);
            if (last && page.scope_changed) throw new RestartBootstrap();
            const chunk: StagingChunk = {
              kind: "page",
              records: page.records,
              workContexts: page.work_contexts ?? []
            };
            progress = {
              ...progress,
              snapshot: page.cursor,
              device: page.device,
              nextToken: last ? null : (page.next_page_token ?? null),
              pagesComplete: last,
              changesCursor: last ? page.cursor : progress.changesCursor,
              chunkCount: progress.chunkCount + 1,
              updatedAt: now()
            };
            records = records.concat(chunk.records);
            workContexts = workContexts.concat(chunk.workContexts);
            await persist(() => store.appendStaging(scope, progress, chunk));
          }

          // Changes after the watermark are reconciled before anything is promoted. A
          // change already present in the pages is applied again harmlessly.
          for (;;) {
            const batch = await changesPage(progress.changesCursor, CHANGES_PAGE_SIZE);
            guard();
            const chunk: StagingChunk = {
              kind: "changes",
              records: batch.changes,
              workContexts: []
            };
            progress = {
              ...progress,
              changesCursor: batch.cursor,
              chunkCount: progress.chunkCount + 1,
              updatedAt: now()
            };
            records = applySyncChangesToRecords(records, batch.changes);
            await persist(() => store.appendStaging(scope, progress, chunk));
            if (!batch.has_more) break;
          }
          if (!progress.device) throw new RestartBootstrap();
          return await promote(
            { ...progress, device: progress.device },
            progress.changesCursor,
            records,
            workContexts
          );
        } catch (error) {
          if (error instanceof RestartBootstrap || isInvalidPageToken(error)) {
            // Only the staged copy is discarded; the last good snapshot stays active.
            await persist(() => store.discardStaging(scope));
            continue;
          }
          if (error instanceof SyncAuthenticationError) {
            // The session ended: this run is over, but its saved progress is kept for
            // the same user to continue after signing back in.
            throw error;
          }
          if (error instanceof SyncRequestError && error.status === 403) {
            // Device revoked or permission withdrawn: nothing here may be shown.
            await persist(() => store.discardStaging(scope));
            await persist(() => store.discardActive(scope));
            throw error;
          }
          if (error instanceof SyncRequestError && error.status === 426) {
            await persist(() => store.discardStaging(scope));
            throw new SyncUpgradeRequiredError();
          }
          // Anything else (a dropped connection, a 5xx) keeps the saved progress so the
          // next attempt resumes where this one stopped.
          throw error;
        }
      }
      await persist(() => store.discardStaging(scope));
      throw new Error("Assigned work kept changing while loading; try again.");
    },

    changes: changesPage,

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
