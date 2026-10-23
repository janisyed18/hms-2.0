import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BootstrapSupersededError,
  SyncUpgradeRequiredError,
  createSyncClient,
  discardBootstrapProgress
} from "../api/syncClient";
import type { SyncBootstrapResponse, SyncRecordRead } from "../domain/types";

const DEVICE = {
  device_id: "d",
  platform: "web",
  app_version: "0.2.0",
  offline_window_days: 7,
  revoked: false
};

function record(id: string, version = 1): SyncRecordRead {
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

function page(
  records: SyncRecordRead[],
  next: string | null,
  extra: Partial<SyncBootstrapResponse> = {}
): SyncBootstrapResponse {
  return {
    device: DEVICE,
    cursor: 10,
    has_more: next !== null,
    records,
    work_contexts: [],
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

function emptyChanges(cursor = 10) {
  return { cursor, has_more: false, changes: [] };
}

type Handler = (url: string) => Response | Promise<Response> | Error;

function client(handler: Handler, userId = "inspector-a") {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    calls.push(path);
    const result = await handler(path);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return {
    calls,
    fetchImpl,
    sync: createSyncClient({
      fetchImpl,
      getAccessToken: () => "token",
      deviceId: "device-1",
      userId
    })
  };
}

afterEach(() => discardBootstrapProgress());

describe("paged bootstrap", () => {
  it("follows continuation tokens, then applies changes from the first watermark", async () => {
    const { sync, calls } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") return json(page([record("a"), record("b")], "t1"));
      if (url === "/api/v1/sync/bootstrap?page_token=t1") return json(page([record("c")], null));
      if (url.startsWith("/api/v1/sync/changes?since=10")) {
        return json({
          cursor: 12,
          has_more: false,
          changes: [
            { ...record("b", 2), seq: 11 },
            {
              entity: "Asset",
              entity_id: "a",
              op: "delete",
              version: 2,
              seq: 12,
              changed_at: null,
              payload: null
            }
          ]
        });
      }
      return new Response("nope", { status: 404 });
    });

    const result = await sync.bootstrap();

    expect(result.records.map((r) => [r.entity_id, r.version]).sort()).toEqual([
      ["b", 2],
      ["c", 1]
    ]);
    expect(result.cursor).toBe(12);
    expect(calls[0]).toBe("/api/v1/sync/bootstrap");
    expect(calls[1]).toBe("/api/v1/sync/bootstrap?page_token=t1");
    expect(calls[2]).toContain("/api/v1/sync/changes?since=10");
  });

  it("resumes from the last completed page after a network failure, not page one", async () => {
    let failNext = true;
    const { sync, calls } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") return json(page([record("a")], "t1"));
      if (url === "/api/v1/sync/bootstrap?page_token=t1") {
        if (failNext) {
          failNext = false;
          return new TypeError("network down");
        }
        return json(page([record("b")], null));
      }
      return json(emptyChanges());
    });

    await expect(sync.bootstrap()).rejects.toThrow("network down");
    const result = await sync.bootstrap();

    expect(result.records.map((r) => r.entity_id)).toEqual(["a", "b"]);
    // page one was fetched once; the retry continued with the same token.
    expect(calls.filter((url) => url === "/api/v1/sync/bootstrap")).toHaveLength(1);
    expect(
      calls.filter((url) => url === "/api/v1/sync/bootstrap?page_token=t1")
    ).toHaveLength(2);
  });

  it("resumes the change phase without refetching the pages", async () => {
    let changesFail = true;
    const { sync, calls } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") return json(page([record("a")], null));
      if (changesFail) {
        changesFail = false;
        return new Response("down", { status: 503 });
      }
      return json(emptyChanges());
    });

    await expect(sync.bootstrap()).rejects.toThrow("503");
    await sync.bootstrap();

    expect(calls.filter((url) => url === "/api/v1/sync/bootstrap")).toHaveLength(1);
  });

  it("never returns a partial dataset when a page fails", async () => {
    const { sync } = client((url) =>
      url === "/api/v1/sync/bootstrap"
        ? json(page([record("a")], "t1"))
        : new Response("down", { status: 503 })
    );
    await expect(sync.bootstrap()).rejects.toThrow();
  });

  it("starts over when the server rejects the token", async () => {
    let first = true;
    const { sync, calls } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") {
        return json(page([record("a")], first ? "stale" : null));
      }
      if (url === "/api/v1/sync/bootstrap?page_token=stale") {
        first = false;
        return json(
          { detail: { code: "SYNC_PAGE_TOKEN_INVALID", message: "expired" } },
          400
        );
      }
      return json(emptyChanges());
    });

    const result = await sync.bootstrap();

    expect(result.records.map((r) => r.entity_id)).toEqual(["a"]);
    expect(calls.filter((url) => url === "/api/v1/sync/bootstrap")).toHaveLength(2);
  });

  it("discards everything and restarts when the scope changed during the traversal", async () => {
    let attempts = 0;
    const { sync } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") {
        attempts += 1;
        return json(
          page([record(attempts === 1 ? "old" : "new")], null, {
            scope_changed: attempts === 1
          })
        );
      }
      return json(emptyChanges());
    });

    const result = await sync.bootstrap();

    expect(result.records.map((r) => r.entity_id)).toEqual(["new"]);
  });

  it("gives up after repeated restarts instead of looping", async () => {
    const { sync } = client((url) =>
      url === "/api/v1/sync/bootstrap"
        ? json(page([record("a")], null, { scope_changed: true }))
        : json(emptyChanges())
    );
    await expect(sync.bootstrap()).rejects.toThrow(/kept changing/);
  });

  it("restarts if a later page reports a different watermark", async () => {
    let attempts = 0;
    const { sync } = client((url) => {
      if (url === "/api/v1/sync/bootstrap") {
        attempts += 1;
        return json(page([record("a")], attempts === 1 ? "t1" : null));
      }
      if (url === "/api/v1/sync/bootstrap?page_token=t1") {
        return json(page([record("b")], null, { cursor: 99 }));
      }
      return json(emptyChanges());
    });

    const result = await sync.bootstrap();

    expect(result.records.map((r) => r.entity_id)).toEqual(["a"]);
  });

  it("reports an upgrade requirement and keeps nothing", async () => {
    const { sync } = client(() =>
      json({ detail: { code: "SYNC_CLIENT_UPGRADE_REQUIRED" } }, 426)
    );
    await expect(sync.bootstrap()).rejects.toBeInstanceOf(SyncUpgradeRequiredError);
  });

  it("accepts a single unpaged answer from a server that predates paging", async () => {
    const legacy = { ...page([record("a")], null), protocol_version: undefined };
    const { sync, calls } = client(() => json(legacy));
    const result = await sync.bootstrap();
    expect(result.records).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does not let another user see or continue a partial bootstrap", async () => {
    let tokenUsedByB: string | null = null;
    const handlerFor = (name: string): Handler => (url) => {
      if (url === "/api/v1/sync/bootstrap") {
        return json(page([record(`${name}-1`)], name === "a" ? "a-token" : null));
      }
      if (url.includes("page_token")) {
        if (name === "b") tokenUsedByB = url;
        return new Response("down", { status: 503 });
      }
      return json(emptyChanges());
    };
    const userA = client(handlerFor("a"), "user-a");
    await expect(userA.sync.bootstrap()).rejects.toThrow();

    const userB = client(handlerFor("b"), "user-b");
    const result = await userB.sync.bootstrap();

    expect(result.records.map((r) => r.entity_id)).toEqual(["b-1"]);
    expect(tokenUsedByB).toBeNull();
  });

  it("drops a user's partial state when they sign out", async () => {
    let pageOneFetches = 0;
    const handler: Handler = (url) => {
      if (url === "/api/v1/sync/bootstrap") {
        pageOneFetches += 1;
        return json(page([record("a")], "t1"));
      }
      return new Response("down", { status: 503 });
    };
    await expect(client(handler).sync.bootstrap()).rejects.toThrow();
    discardBootstrapProgress("inspector-a");
    await expect(client(handler).sync.bootstrap()).rejects.toThrow();
    expect(pageOneFetches).toBe(2);
  });

  it("lets a newer refresh supersede an older one without mixing their pages", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { sync } = client(async (url) => {
      if (url === "/api/v1/sync/bootstrap") {
        calls += 1;
        if (calls === 1) await gate;
        return json(page([record(`run-${calls}`)], null));
      }
      return json(emptyChanges());
    });

    const older = sync.bootstrap();
    const newer = sync.bootstrap();
    release();

    await expect(older).rejects.toBeInstanceOf(BootstrapSupersededError);
    expect((await newer).records.map((r) => r.entity_id)).toEqual(["run-2"]);
  });
});
