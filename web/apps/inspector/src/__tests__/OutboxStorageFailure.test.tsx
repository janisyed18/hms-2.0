import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";
import { outboxStorageKey } from "../offline/outboxStore";
import { resetDefaultSyncStore } from "../offline/syncStore";
import { bootstrapOnly, withChangeFeed } from "../test/syncFetch";

const SAVE_FAILED = "Inspection couldn't be saved on this device. Keep this page open and try again.";
const KEY = outboxStorageKey("test-inspector");

/** A device whose outbox storage can be made full or unreadable on demand. */
function device() {
  const values = new Map<string, string>();
  const state = { full: false, unreadable: false, writes: [] as string[] };
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => {
      if (state.unreadable && key === KEY) throw new DOMException("denied", "SecurityError");
      return values.get(key) ?? null;
    },
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      if (state.full && key === KEY) throw new DOMException("full", "QuotaExceededError");
      if (key === KEY) state.writes.push(key);
      values.set(key, value);
    }
  };
  return { storage, state, values };
}

type User = ReturnType<typeof userEvent.setup>;
const button = (name: string) => screen.getByRole("button", { name });
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement;
const open = async (user: User, asset: string) =>
  user.click(await screen.findByRole("button", { name: new RegExp(`open ${asset}`, "i") }));
const nav = (name: string) =>
  within(screen.getByRole("navigation", { name: "Inspector navigation" })).getByRole("button", { name });
const prompt = () => screen.queryByRole("alertdialog", { name: "Discard unsaved changes?" });
const notice = () => screen.queryByText(SAVE_FAILED);
const fillForm = async (user: User) => {
  await user.selectOptions(field("Test time minutes"), "5");
  await user.selectOptions(field("Pressure test result"), "PASS");
  await user.selectOptions(field("Instruction"), "PASS");
  await user.type(field("Ohms end A"), "0.1");
  await user.type(field("Ohms end B"), "0.2");
  await user.type(field("Ohms total"), "0.3");
  await user.click(button("Pass all"));
  await user.selectOptions(field("Certificate result"), "PASS");
};
const queued = (d: ReturnType<typeof device>) => {
  const raw = d.values.get(KEY);
  return (raw ? JSON.parse(raw).operations : []) as Array<{ lifecycleActions?: string[]; entity: string }>;
};
const withServerInspection = (patch: Record<string, unknown>) => ({
  ...mockBootstrapResponse,
  records: mockBootstrapResponse.records.map((record) =>
    record.entity === "Inspection" && record.entity_id === "inspection-0156"
      ? { ...record, payload: { ...record.payload, ...patch } }
      : record
  )
});

let dev: ReturnType<typeof device>;
beforeEach(() => {
  vi.unstubAllGlobals();
  resetDefaultSyncStore();
  dev = device();
  vi.stubGlobal("localStorage", dev.storage);
  vi.stubGlobal("fetch", bootstrapOnly());
});
afterEach(() => vi.unstubAllGlobals());

describe("an inspector's work when the device will not store it", () => {
  it("Start inspection that cannot be stored says so, changes nothing, and works on retry", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");

    dev.state.full = true;
    await user.click(button("Start inspection"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(button("Start inspection")).toBeEnabled(); // still a draft, form still read-only
    expect(field("Instruction")).toBeDisabled();
    expect(queued(dev)).toEqual([]);

    dev.state.full = false;
    await user.click(button("Start inspection"));
    await waitFor(() => expect(field("Instruction")).toBeEnabled());
    expect(notice()).toBeNull();
    expect(queued(dev)[0].lifecycleActions).toEqual(["start"]);
  });

  it("Save progress that cannot be stored keeps the form, stays unsaved, and blocks leaving silently", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    await user.selectOptions(field("Test time minutes"), "5");
    await user.selectOptions(field("Pressure test result"), "PASS");

    dev.state.full = true;
    await user.click(button("Save progress"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(field("Test time minutes")).toHaveValue("5");
    expect(field("Pressure test result")).toHaveValue("PASS");

    // Navigation asks first rather than discarding the failed draft; Keep editing keeps it all.
    await user.click(nav("Queue"));
    expect(prompt()).not.toBeNull();
    await user.click(button("Keep editing"));
    expect(field("Test time minutes")).toHaveValue("5");

    // Once the device recovers, the same screen saves what is still on it.
    dev.state.full = false;
    await user.click(button("Save progress"));
    await waitFor(() => expect(notice()).toBeNull());
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    const draft = queued(dev).find((operation) => operation.entity === "Inspection");
    expect(draft).toBeDefined();
    await user.click(nav("Queue"));
    expect(prompt()).toBeNull();
  });

  it("Submit that cannot be stored is not treated as submitted", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    await fillForm(user);

    dev.state.full = true;
    await user.click(button("Submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.queryByText("Awaiting review")).toBeNull();
    expect(button("Submit")).toBeEnabled();
    expect(queued(dev).every((operation) => !operation.lifecycleActions?.includes("submit"))).toBe(true);

    dev.state.full = false;
    await user.click(button("Submit"));
    await waitFor(() => expect(screen.getByText("Awaiting review")).toBeInTheDocument());
    expect(queued(dev)[0].lifecycleActions).toEqual(["start", "submit"]);
  });

  it("Begin rework that cannot be stored leaves the inspection rejected", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      bootstrapOnly(withServerInspection({ status: "REJECTED", rejection_reason: "Hold the test longer" }))
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");

    dev.state.full = true;
    await user.click(button("Begin rework"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(button("Begin rework")).toBeEnabled();
    expect(field("Notes")).toBeDisabled();

    dev.state.full = false;
    await user.click(button("Begin rework"));
    await waitFor(() => expect(field("Notes")).toBeEnabled());
  });

  it("Queue Asset Details that cannot be stored stays unsaved", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.type(field("Asset tag"), "T1");

    dev.state.full = true;
    await user.click(button("Queue Asset Details"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(field("Asset tag")).toHaveValue("T1");

    // Switching to another assignment asks first instead of dropping the failed edit.
    await user.click(button("Work queue"));
    expect(prompt()).not.toBeNull();
    await user.click(button("Keep editing"));
    expect(field("Asset tag")).toHaveValue("T1");

    dev.state.full = false;
    await user.click(button("Queue Asset Details"));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(queued(dev).some((operation) => operation.entity === "Asset")).toBe(true);
  });

  it("opens with a warning, not a crash, when saved work cannot be read, and never overwrites it", async () => {
    const user = userEvent.setup();
    const kept = JSON.stringify({ operations: [] });
    dev.values.set(KEY, kept);
    dev.state.unreadable = true;
    render(<App initialAccessToken="test-access-token" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be read/);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    // The write is refused rather than replacing a queue that could not be read.
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be read/);
    expect(dev.state.writes).toEqual([]);
    expect(dev.values.get(KEY)).toBe(kept);
  });

  it("shows a recovery warning for unreadable stored data without deleting it", async () => {
    dev.values.set(KEY, "{bad");
    render(<App initialAccessToken="test-access-token" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/copy was kept for recovery/);
    expect(dev.values.get(KEY)).toBe("{bad");
    expect([...dev.values.entries()].filter(([k]) => k.startsWith(`${KEY}:unreadable:`)).map(([, v]) => v)).toEqual(["{bad"]);
  });

  it("does not push when the device cannot record that a push is under way", async () => {
    const user = userEvent.setup();
    const pushed: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withChangeFeed((url, init) => {
          const path = String(url);
          if (path.includes("/sync/bootstrap")) {
            return new Response(JSON.stringify(mockBootstrapResponse), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          }
          if (path.endsWith("/api/v1/sync/push")) pushed.push(init?.body);
          return new Response("Not found", { status: 404 });
        })
      )
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    expect(queued(dev)).toHaveLength(1);

    await user.click(nav("Queue"));
    dev.state.full = true;
    await user.click(await screen.findByRole("button", { name: "Push Changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(pushed).toEqual([]);
    expect(queued(dev)).toHaveLength(1);
  });

  describe("an interrupted push", () => {
    /** A server that applies each idempotency key once and answers a replay with the same result. */
    function server(onPush?: () => void) {
      const requests: Array<{ op_id: string; idempotency_key: string }> = [];
      const applied = new Set<string>();
      const fetchMock = vi.fn(
        withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
          const path = String(url);
          if (path.endsWith("/api/v1/sync/push")) {
            onPush?.();
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ op_id: string; idempotency_key: string; entity_id: string }>;
            };
            for (const operation of body.operations) {
              requests.push({ op_id: operation.op_id, idempotency_key: operation.idempotency_key });
              applied.add(operation.idempotency_key);
            }
            return new Response(JSON.stringify({
              cursor: 3,
              results: body.operations.map((operation) => ({
                op_id: operation.op_id, idempotency_key: operation.idempotency_key, entity: "Inspection",
                entity_id: operation.entity_id, status: "applied", version: 3, current_version: 3,
                payload: null, error: null
              }))
            }), { status: 200 });
          }
          return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
        })
      );
      return { fetchMock, requests, applied };
    }

    async function startAndPushWithDeviceFailingAfterTheServerApplied(user: User) {
      let firstPush = true;
      const api = server(() => {
        if (!firstPush) return;
        firstPush = false;
        dev.state.full = true; // the server has the work; the device cannot record that
      });
      vi.stubGlobal("fetch", api.fetchMock);
      render(<App initialAccessToken="test-access-token" />);
      await open(user, "HOS-2024-0891");
      await user.click(button("Start inspection"));
      await user.click(nav("Queue"));
      await user.click(await screen.findByRole("button", { name: "Push Changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
      return api;
    }

    it("is sent again once the device recovers, with the same idempotency key, and applied once", async () => {
      const user = userEvent.setup();
      const api = await startAndPushWithDeviceFailingAfterTheServerApplied(user);
      // The outbox still says it is being sent, but nothing is running: it can be pushed.
      await waitFor(() => expect(button("Push Changes")).toBeEnabled());
      expect(queued(dev)).toHaveLength(1);
      const [{ idempotencyKey, opId }] = JSON.parse(dev.values.get(KEY) as string).operations;

      dev.state.full = false;
      await user.click(button("Push Changes"));
      expect(await screen.findByText("Applied")).toBeInTheDocument();

      expect(api.requests).toHaveLength(2);
      expect(api.requests.map((r) => r.idempotency_key)).toEqual([idempotencyKey, idempotencyKey]);
      expect(api.requests.map((r) => r.op_id)).toEqual([opId, opId]);
      expect(api.applied.size).toBe(1); // a replay is the same operation, not a second effect
      expect(notice()).toBeNull();
    });

    it("is sent again after the page is reloaded", async () => {
      const user = userEvent.setup();
      const api = await startAndPushWithDeviceFailingAfterTheServerApplied(user);
      const [{ idempotencyKey }] = JSON.parse(dev.values.get(KEY) as string).operations;
      expect(JSON.parse(dev.values.get(KEY) as string).operations[0].status).toBe("pushing");

      // Reload: a fresh page over the same device storage, which now works.
      document.body.innerHTML = "";
      dev.state.full = false;
      resetDefaultSyncStore();
      const reloaded = userEvent.setup();
      render(<App initialAccessToken="test-access-token" />);
      await reloaded.click(await screen.findByRole("button", { name: /queue/i }));
      await waitFor(() => expect(button("Push Changes")).toBeEnabled());
      await reloaded.click(button("Push Changes"));
      expect(await screen.findByText("Applied")).toBeInTheDocument();
      expect(api.requests.at(-1)?.idempotency_key).toBe(idempotencyKey);
      expect(api.applied.size).toBe(1);
    });

    it("cannot be pushed twice at once while a push is running", async () => {
      const user = userEvent.setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pushes: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith("/api/v1/sync/push")) {
              pushes.push(init?.body);
              await gate;
              return new Response(JSON.stringify({ cursor: 3, results: [] }), { status: 200 });
            }
            return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
          })
        )
      );
      render(<App initialAccessToken="test-access-token" />);
      await open(user, "HOS-2024-0891");
      await user.click(button("Start inspection"));
      await user.click(nav("Queue"));
      await user.click(await screen.findByRole("button", { name: "Push Changes" }));
      await waitFor(() => expect(button("Push Changes")).toBeDisabled());
      expect(pushes).toHaveLength(1);
      release();
    });

    it("refuses a second push requested while assignments are still being verified", async () => {
      const user = userEvent.setup();
      let verifying = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pushes: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith("/api/v1/sync/push")) {
              pushes.push(init?.body);
              return new Response(JSON.stringify({ cursor: 3, results: [] }), { status: 200 });
            }
            if (verifying) await gate; // assignment verification is slow
            return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
          })
        )
      );
      render(<App initialAccessToken="test-access-token" />);
      await open(user, "HOS-2024-0891");
      await user.click(button("Start inspection"));
      await user.click(nav("Queue"));
      const push = await screen.findByRole("button", { name: "Push Changes" });

      verifying = true;
      fireEvent.click(push);
      fireEvent.click(push); // a second request while the first is still verifying assignments
      await new Promise((resolve) => setTimeout(resolve, 50)); // the first is now waiting
      // The push is already under way, so the control is locked while assignments are verified.
      expect(button("Push Changes")).toBeDisabled();
      release();

      await waitFor(() => expect(pushes.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pushes).toHaveLength(1);
    });
  });
});
