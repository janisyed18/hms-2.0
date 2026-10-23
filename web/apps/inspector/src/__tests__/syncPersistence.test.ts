import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient } from "../api/syncClient";
import { mockBootstrapResponse } from "../data/mockSync";
import { useInspectorWorkspace } from "../hooks/useInspectorWorkspace";
import { createAssetUpdateOperation, loadOutbox, saveOutbox } from "../offline/outboxStore";
import {
  clearUserSyncData,
  createIndexedDbSyncStore,
  resetDefaultSyncStore,
  scopeKey,
  type SyncScope,
  type SyncStore
} from "../offline/syncStore";
import type { SyncBootstrapResponse, SyncRecordRead } from "../domain/types";

// jsdom has no IndexedDB; the store reads these globals like a browser would.
Object.assign(globalThis, { IDBKeyRange, IDBDatabase });

const DEVICE = {
  device_id: "d",
  platform: "web",
  app_version: "0.2.0",
  offline_window_days: 2,
  revoked: false
};
const DAY = 86_400_000;

function rec(id: string, version = 1): SyncRecordRead {
  return {
    seq: null,
    entity: "Asset",
    entity_id: id,
    op: "upsert",
    version,
    changed_at: null,
    payload: { id, asset_number: id }
  };
}

function context(id: string) {
  return {
    appointment_id: `ap-${id}`,
    booking_id: `bk-${id}`,
    revision_id: `rv-${id}`,
    assignment_id: `as-${id}`,
    asset_id: id
  };
}

function page(
  ids: string[],
  next: string | null,
  extra: Partial<SyncBootstrapResponse> = {}
): SyncBootstrapResponse {
  return {
    device: DEVICE,
    cursor: 10,
    has_more: next !== null,
    records: ids.map((id) => rec(id)),
    work_contexts: ids.map(context),
    protocol_version: 2,
    next_page_token: next,
    page_size: 2,
    scope_changed: false,
    ...extra
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const changes = (cursor: number, list: SyncRecordRead[] = [], more = false) => ({
  cursor,
  has_more: more,
  changes: list
});

type Route = (url: string) => Response | Error | Promise<Response | Error>;

let factory: IDBFactory;
let clock: number;

beforeEach(() => {
  factory = new IDBFactory();
  clock = 1_000_000;
  localStorage.clear();
});

function newStore(): SyncStore {
  // A new store object on the same database is what a reloaded page gets.
  return createIndexedDbSyncStore(factory);
}

function clientFor(route: Route, userId = "user-a", deviceId = "dev-1", store = newStore()) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const path = String(url);
    calls.push(path);
    const result = await route(path);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return {
    calls,
    store,
    client: createSyncClient({
      fetchImpl,
      getAccessToken: () => "token",
      userId,
      deviceId,
      store,
      now: () => clock
    })
  };
}

const scope = (userId = "user-a", deviceId = "dev-1"): SyncScope => ({
  userId,
  deviceId,
  protocol: 2
});

/** Pages a, b, c (tokens t1, t2), then an empty change feed. */
const happy: Route = (url) => {
  if (url === "/api/v1/sync/bootstrap") return json(page(["a1"], "t1"));
  if (url.endsWith("page_token=t1")) return json(page(["a2"], "t2"));
  if (url.endsWith("page_token=t2")) return json(page(["a3"], null));
  return json(changes(10));
};

const ids = (records: SyncRecordRead[]) => records.map((r) => r.entity_id).sort();

describe("persisted last-good snapshot", () => {
  it("survives a restart and is usable with no network", async () => {
    await clientFor(happy).client.bootstrap();

    const offline = clientFor(() => new TypeError("offline"));
    const saved = await offline.client.loadSnapshot();

    expect(saved.status).toBe("ready");
    if (saved.status === "ready") {
      expect(ids(saved.snapshot.records)).toEqual(["a1", "a2", "a3"]);
      expect(saved.snapshot.workContexts).toHaveLength(3);
      expect(saved.snapshot.cursor).toBe(10);
      expect(saved.snapshot.device.offline_window_days).toBe(2);
    }
    expect(offline.calls).toEqual([]);
  });

  it("expires at an absolute time set when it was promoted", async () => {
    await clientFor(happy).client.bootstrap();

    clock += DAY; // inside the 2-day window
    expect((await clientFor(() => new TypeError("x")).client.loadSnapshot()).status).toBe("ready");

    // A failed refresh does not extend the window.
    await expect(
      clientFor(() => new TypeError("offline")).client.bootstrap()
    ).rejects.toThrow();
    clock += DAY + 1;
    const store = newStore();
    const expired = await clientFor(() => new TypeError("x"), "user-a", "dev-1", store).client.loadSnapshot();
    expect(expired.status).toBe("expired");
    // ...and the expired data is gone, not merely hidden.
    expect(await store.loadActive(scope())).toBeNull();
  });

  it("extends the window only when a refresh fully succeeds", async () => {
    await clientFor(happy).client.bootstrap();
    clock += DAY + DAY / 2;
    await clientFor(happy).client.bootstrap();
    clock += DAY; // past the first window, inside the renewed one
    expect((await clientFor(() => new TypeError("x")).client.loadSnapshot()).status).toBe("ready");
  });
});

describe("persisted bootstrap staging", () => {
  it("resumes from the stored token after a restart, not from page one", async () => {
    const failing: Route = (url) =>
      url.endsWith("page_token=t2") ? new TypeError("crash") : happy(url);
    await expect(clientFor(failing).client.bootstrap()).rejects.toThrow("crash");

    const restarted = clientFor(happy);
    const result = await restarted.client.bootstrap();

    expect(restarted.calls[0]).toBe("/api/v1/sync/bootstrap?page_token=t2");
    expect(restarted.calls).not.toContain("/api/v1/sync/bootstrap");
    expect(ids(result.records)).toEqual(["a1", "a2", "a3"]);
  });

  it("resumes with genuinely fresh JavaScript state", async () => {
    const failing: Route = (url) =>
      url.endsWith("page_token=t2") ? new TypeError("crash") : happy(url);
    await expect(clientFor(failing).client.bootstrap()).rejects.toThrow("crash");

    vi.resetModules();
    const freshClient = await import("../api/syncClient");
    const freshStore = await import("../offline/syncStore");
    const calls: string[] = [];
    const client = freshClient.createSyncClient({
      fetchImpl: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return happy(String(url));
      }) as typeof fetch,
      getAccessToken: () => "token",
      userId: "user-a",
      deviceId: "dev-1",
      store: freshStore.createIndexedDbSyncStore(factory),
      now: () => clock
    });

    const result = await client.bootstrap();

    expect(calls[0]).toBe("/api/v1/sync/bootstrap?page_token=t2");
    expect(ids(result.records)).toEqual(["a1", "a2", "a3"]);
  });

  it("resumes change reconciliation from the stored cursor without refetching pages", async () => {
    const route: Route = (url) => {
      if (url === "/api/v1/sync/bootstrap") return json(page(["a1"], null));
      if (url.includes("changes?since=10")) {
        return json(changes(12, [{ ...rec("a1", 2), seq: 11 }], true));
      }
      if (url.includes("changes?since=12")) return new TypeError("crash");
      return json(changes(12));
    };
    await expect(clientFor(route).client.bootstrap()).rejects.toThrow("crash");

    const restarted = clientFor((url) => {
      if (url.includes("changes?since=12")) return json(changes(15, [], false));
      throw new Error(`unexpected ${url}`);
    });
    const result = await restarted.client.bootstrap();

    expect(restarted.calls).toHaveLength(1);
    expect(restarted.calls[0]).toContain("changes?since=12");
    expect(result.records.find((r) => r.entity_id === "a1")?.version).toBe(2);
    expect(result.cursor).toBe(15);
  });
});

describe("promotion", () => {
  async function activeA() {
    await clientFor((url) =>
      url === "/api/v1/sync/bootstrap" ? json(page(["A"], null)) : json(changes(10))
    ).client.bootstrap();
  }

  it("never shows a partial bootstrap in place of the last good snapshot", async () => {
    await activeA();
    const failing: Route = (url) =>
      url.endsWith("page_token=t1") ? new TypeError("crash") : happy(url);
    await expect(clientFor(failing).client.bootstrap()).rejects.toThrow();

    const saved = await clientFor(() => new TypeError("x")).client.loadSnapshot();

    expect(saved.status).toBe("ready");
    if (saved.status === "ready") expect(ids(saved.snapshot.records)).toEqual(["A"]);
  });

  it("replaces the snapshot and removes staging in one step on completion", async () => {
    await activeA();
    const store = newStore();
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction");

    await clientFor(happy, "user-a", "dev-1", store).client.bootstrap();

    const promotion = spy.mock.calls.filter(
      ([names, mode]) =>
        mode === "readwrite" &&
        Array.isArray(names) &&
        names.includes("active") &&
        names.includes("staging") &&
        names.includes("chunks")
    );
    expect(promotion).toHaveLength(1);
    spy.mockRestore();

    const active = await store.loadActive(scope());
    expect(ids(active?.records ?? [])).toEqual(["a1", "a2", "a3"]);
    expect(await store.loadStaging(scope())).toBeNull();
  });

  it("leaves the previous snapshot and the staging untouched if promotion fails", async () => {
    await activeA();
    const store = newStore();
    const unclonable = { ...(await store.loadActive(scope()))!, records: [(() => 1) as never] };
    await expect(store.promote(scope(), unclonable)).rejects.toBeDefined();

    const active = await store.loadActive(scope());
    expect(ids(active?.records ?? [])).toEqual(["A"]);
  });

  it("keeps the active snapshot when the server rejects the stored token", async () => {
    await activeA();
    const crash: Route = (url) =>
      url.endsWith("page_token=t1") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash).client.bootstrap()).rejects.toThrow();

    const store = newStore();
    const rejecting = clientFor((url) => {
      if (url.endsWith("page_token=t1")) {
        return json({ detail: { code: "SYNC_PAGE_TOKEN_INVALID" } }, 400);
      }
      return new TypeError("offline again"); // the fresh page one fails too
    }, "user-a", "dev-1", store);
    await expect(rejecting.client.bootstrap()).rejects.toThrow();

    expect(rejecting.calls).toEqual([
      "/api/v1/sync/bootstrap?page_token=t1",
      "/api/v1/sync/bootstrap"
    ]);
    const active = await store.loadActive(scope());
    expect(ids(active?.records ?? [])).toEqual(["A"]);
    // the stale staged pages are gone; a new, empty staging replaced them
    const staging = await store.loadStaging(scope());
    expect(staging?.chunks ?? []).toEqual([]);
  });

  it("discards a scope-changed copy but keeps the active snapshot until a clean one lands", async () => {
    await activeA();
    const store = newStore();
    let attempt = 0;
    let activeDuringRestart: string[] = [];
    const route: Route = async (url) => {
      if (url === "/api/v1/sync/bootstrap") {
        attempt += 1;
        if (attempt === 2) {
          const mid = await store.loadActive(scope());
          activeDuringRestart = ids(mid?.records ?? []);
          expect(await store.loadStaging(scope())).toMatchObject({ chunks: [] });
        }
        return json(
          page([attempt === 1 ? "stale" : "fresh"], null, { scope_changed: attempt === 1 })
        );
      }
      return json(changes(10));
    };

    const result = await clientFor(route, "user-a", "dev-1", store).client.bootstrap();

    expect(activeDuringRestart).toEqual(["A"]);
    expect(ids(result.records)).toEqual(["fresh"]);
    expect(ids((await store.loadActive(scope()))?.records ?? [])).toEqual(["fresh"]);
  });
});

describe("isolation", () => {
  it("never lets another user load or resume a user's snapshot or staging", async () => {
    await clientFor(happy, "user-a").client.bootstrap();
    const crash: Route = (url) =>
      url.endsWith("page_token=t1") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash, "user-a").client.bootstrap()).rejects.toThrow();

    const userB = clientFor(happy, "user-b");
    expect((await userB.client.loadSnapshot()).status).toBe("none");
    await userB.client.bootstrap();

    expect(userB.calls[0]).toBe("/api/v1/sync/bootstrap");
    expect((await clientFor(() => new TypeError("x"), "user-a").client.loadSnapshot()).status).toBe("ready");
  });

  it("does not resume another device's staging", async () => {
    const crash: Route = (url) =>
      url.endsWith("page_token=t1") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash, "user-a", "dev-1").client.bootstrap()).rejects.toThrow();

    const other = clientFor(happy, "user-a", "dev-2");
    await other.client.bootstrap();

    expect(other.calls[0]).toBe("/api/v1/sync/bootstrap");
  });

  it("scopes keys by user, device, protocol and storage schema", () => {
    const keys = new Set([
      scopeKey(scope()),
      scopeKey(scope("user-b")),
      scopeKey(scope("user-a", "dev-2")),
      scopeKey({ ...scope(), protocol: 3 })
    ]);
    expect(keys.size).toBe(4);
  });

  it("clears one user's snapshot and staging on every device, and nobody else's", async () => {
    await clientFor(happy, "user-a", "dev-1").client.bootstrap();
    await clientFor(happy, "user-a", "dev-2").client.bootstrap();
    await clientFor(happy, "user-b", "dev-1").client.bootstrap();
    const crash: Route = (url) =>
      url.endsWith("page_token=t1") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash, "user-a", "dev-3").client.bootstrap()).rejects.toThrow();

    const store = newStore();
    await clearUserSyncData("user-a", store);

    for (const device of ["dev-1", "dev-2", "dev-3"]) {
      expect(await store.loadActive(scope("user-a", device))).toBeNull();
      expect(await store.loadStaging(scope("user-a", device))).toBeNull();
    }
    expect(await store.loadActive(scope("user-b", "dev-1"))).not.toBeNull();
  });
});

describe("corruption", () => {
  async function putRaw(storeName: string, value: unknown) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("hms-inspector-sync", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  it("discards a malformed active snapshot and does not invent work", async () => {
    await clientFor(happy).client.bootstrap();
    await putRaw("active", { key: scopeKey(scope()), records: "garbage" });

    const saved = await clientFor(() => new TypeError("x")).client.loadSnapshot();

    expect(saved.status).toBe("none");
    expect(await newStore().loadActive(scope())).toBeNull();
  });

  it("discards a malformed staging, keeps the active snapshot and restarts", async () => {
    await clientFor((url) =>
      url === "/api/v1/sync/bootstrap" ? json(page(["A"], null)) : json(changes(10))
    ).client.bootstrap();
    await putRaw("staging", { key: scopeKey(scope()), snapshot: "x" });

    const restarted = clientFor(happy);
    const result = await restarted.client.bootstrap();

    expect(restarted.calls[0]).toBe("/api/v1/sync/bootstrap");
    expect(ids(result.records)).toEqual(["a1", "a2", "a3"]);
  });

  it("treats staging whose chunks do not match its progress as corrupt", async () => {
    const crash: Route = (url) =>
      url.endsWith("page_token=t2") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash).client.bootstrap()).rejects.toThrow();
    const store = newStore();
    const staging = await store.loadStaging(scope());
    await putRaw("staging", {
      key: scopeKey(scope()),
      ...staging!.progress,
      chunkCount: staging!.progress.chunkCount + 1
    });

    const restarted = clientFor(happy);
    await restarted.client.bootstrap();

    expect(restarted.calls[0]).toBe("/api/v1/sync/bootstrap");
  });

  it("still syncs when storage is unusable", async () => {
    const broken: SyncStore = new Proxy({} as SyncStore, {
      get: () => () => Promise.reject(new Error("storage blocked"))
    });
    const result = await clientFor(happy, "user-a", "dev-1", broken).client.bootstrap();
    expect(ids(result.records)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("outbox", () => {
  it("is never touched by staging, restarts, rejections, scope changes or promotion", async () => {
    const operation = createAssetUpdateOperation({
      assetId: "a1",
      assetNumber: "A",
      customerName: "C",
      baseVersion: 1,
      customerSerialNo: "s",
      tag: "t",
      workContext: context("a1")
    });
    saveOutbox("user-a", [operation]);
    const before = JSON.stringify(loadOutbox("user-a"));

    const crash: Route = (url) =>
      url.endsWith("page_token=t2") ? new TypeError("crash") : happy(url);
    await expect(clientFor(crash).client.bootstrap()).rejects.toThrow();
    expect(JSON.stringify(loadOutbox("user-a"))).toBe(before);

    await expect(
      clientFor((url) =>
        url.endsWith("page_token=t2")
          ? json({ detail: { code: "SYNC_PAGE_TOKEN_INVALID" } }, 400)
          : new TypeError("offline")
      ).client.bootstrap()
    ).rejects.toThrow();
    expect(JSON.stringify(loadOutbox("user-a"))).toBe(before);

    let attempt = 0;
    await clientFor((url) => {
      if (url === "/api/v1/sync/bootstrap") {
        attempt += 1;
        return json(page(["x"], null, { scope_changed: attempt === 1 }));
      }
      return json(changes(10));
    }).client.bootstrap();
    expect(JSON.stringify(loadOutbox("user-a"))).toBe(before);

    await clearUserSyncData("user-a", newStore());
    expect(JSON.stringify(loadOutbox("user-a"))).toBe(before);
  });
});

describe("workspace after a restart", () => {
  it("shows the saved assignments immediately while offline", async () => {
    // Seed the same database the workspace will use.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = factory;
    resetDefaultSyncStore();
    const seed = createSyncClient({
      fetchImpl: (async (url: RequestInfo | URL) => {
        const path = String(url);
        return path.includes("/sync/changes")
          ? json(changes(8))
          : json({ ...mockBootstrapResponse, protocol_version: 2, next_page_token: null });
      }) as typeof fetch,
      getAccessToken: () => "token",
      userId: "user-a",
      deviceId: "device-user-a"
    });
    const seeded = await seed.bootstrap();
    expect(seeded.records.length).toBeGreaterThan(0);

    // "Restart": nothing but the database survives, and the network is down.
    resetDefaultSyncStore();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    localStorage.setItem("hms.inspector.device-id:user-a", "device-user-a");

    const { result } = renderHook(() => useInspectorWorkspace("user-a"));

    await waitFor(() => expect(result.current.workItems.length).toBeGreaterThan(0));
    expect(result.current.lastSyncLabel).toBe("Showing saved assignments");

    // Another user on the same browser sees none of it.
    const other = renderHook(() => useInspectorWorkspace("user-b"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(other.result.current.workItems).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
