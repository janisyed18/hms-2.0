import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient } from "../api/syncClient";
import { mockBootstrapResponse } from "../data/mockSync";

// The server binds a device id to the first user who syncs with it and refuses it for
// anyone else (HTTP 403). So the id a browser sends must belong to the signed-in user,
// never to the browser profile as a whole.

const LEGACY_KEY = "hms.inspector.device-id";
const SHARED_FALLBACK = "inspector-browser-unavailable";
const SERVER_LIMIT = 80; // devices.device_id is String(80)

async function deviceIdSentFor(userId: string | undefined): Promise<string> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => mockBootstrapResponse
  });
  const client = createSyncClient({
    fetchImpl: fetchMock,
    getAccessToken: () => "token",
    userId
  });
  await client.bootstrap();
  const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
  return (request.headers as Record<string, string>)["X-HMS-Device-Id"];
}

describe("sync device identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives each user on a shared browser profile a different device id", async () => {
    const alice = await deviceIdSentFor("local:alice-1");
    const bob = await deviceIdSentFor("local:bob-1");

    expect(alice).not.toEqual(bob);
    expect(alice).toMatch(/^inspector-browser-/);
    expect(bob).toMatch(/^inspector-browser-/);
  });

  it("keeps one user's device id stable across requests and reloads", async () => {
    const first = await deviceIdSentFor("local:alice-2");
    const second = await deviceIdSentFor("local:alice-2");

    expect(second).toEqual(first);
    expect(window.localStorage.getItem(`${LEGACY_KEY}:local:alice-2`)).toEqual(first);
  });

  it("does not adopt the old browser-wide id, which may belong to another user", async () => {
    window.localStorage.setItem(LEGACY_KEY, "inspector-browser-legacy-owner");

    const id = await deviceIdSentFor("local:carol-1");

    expect(id).not.toEqual("inspector-browser-legacy-owner");
    expect(window.localStorage.getItem(LEGACY_KEY)).toEqual(
      "inspector-browser-legacy-owner"
    );
  });

  it("stays within the server's device id width", async () => {
    expect((await deviceIdSentFor("local:dave-1")).length).toBeLessThanOrEqual(
      SERVER_LIMIT
    );
  });

  it("never falls back to a literal shared by every user when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    const erin = await deviceIdSentFor("local:erin-1");
    const frank = await deviceIdSentFor("local:frank-1");

    expect(erin).not.toEqual(SHARED_FALLBACK);
    expect(frank).not.toEqual(SHARED_FALLBACK);
    expect(erin).not.toEqual(frank);
    // Still stable for the page's lifetime, so one session is one device.
    expect(await deviceIdSentFor("local:erin-1")).toEqual(erin);
  });

  it("does not persist or share an id for a request with no signed-in user", async () => {
    const a = await deviceIdSentFor(undefined);

    expect(a).not.toEqual(SHARED_FALLBACK);
    expect(a).toMatch(/^inspector-browser-/);
    expect(window.localStorage.length).toBe(0);
  });

  it("lets an explicit device id win, for callers that manage their own", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockBootstrapResponse
    });
    await createSyncClient({
      fetchImpl: fetchMock,
      getAccessToken: () => "token",
      userId: "local:gina-1",
      deviceId: "explicit-device"
    }).bootstrap();

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((request.headers as Record<string, string>)["X-HMS-Device-Id"]).toEqual(
      "explicit-device"
    );
  });
});
