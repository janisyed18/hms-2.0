import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";
import { outboxStorageKey } from "../offline/outboxStore";
import { resetDefaultSyncStore } from "../offline/syncStore";
import { bootstrapOnly, withChangeFeed } from "../test/syncFetch";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

type User = ReturnType<typeof userEvent.setup>;
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement;
const button = (name: string) => screen.getByRole("button", { name });
const maybe = (name: string) => screen.queryByRole("button", { name });
const open = async (user: User, asset: string) =>
  user.click(await screen.findByRole("button", { name: new RegExp(`open ${asset}`, "i") }));
const queued = () => {
  const raw = localStorage.getItem(outboxStorageKey("test-inspector"));
  return (raw ? JSON.parse(raw).operations : []) as Array<{
    entity: string; op: string; baseVersion: number | null; lifecycleActions?: string[];
    payload: Record<string, unknown>; status: string;
  }>;
};
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
const withServerInspection = (patch: Record<string, unknown>) => ({
  ...mockBootstrapResponse,
  records: mockBootstrapResponse.records.map((record) =>
    record.entity === "Inspection" && record.entity_id === "inspection-0156"
      ? { ...record, payload: { ...record.payload, ...patch } }
      : record
  )
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetDefaultSyncStore();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", bootstrapOnly());
});
afterEach(() => vi.unstubAllGlobals());

describe("native inspection lifecycle in the inspector", () => {
  it("offers only Start on a draft, and its fields cannot be edited before it", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    expect(button("Start inspection")).toBeEnabled();
    expect(maybe("Save progress")).toBeNull();
    expect(maybe("Submit")).toBeNull();
    expect(field("Instruction")).toBeDisabled();
    expect(field("Test time minutes")).toBeDisabled();
    expect(field("Notes")).toBeDisabled();
    // Asset details stay editable on their own.
    expect(field("Asset tag")).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Start the inspection/);
  });

  it("Start unlocks the form at once, even offline, and queues a bare start", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    fireEvent(window, new Event("offline"));
    await user.click(button("Start inspection"));

    expect(field("Instruction")).toBeEnabled();
    expect(field("Test time minutes")).toBeEnabled();
    expect(maybe("Start inspection")).toBeNull();
    expect(button("Save progress")).toBeInTheDocument();
    const [operation] = queued();
    expect(operation.lifecycleActions).toEqual(["start"]);
    expect(operation.op).toBe("create");
    expect(operation.payload).not.toHaveProperty("status");
    expect(operation.payload).not.toHaveProperty("pressure_test");
  });

  it("Submit locks the form, and survives a reload from the local queue", async () => {
    const user = userEvent.setup();
    const first = render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    await fillForm(user);
    await user.click(button("Submit"));

    expect(field("Instruction")).toBeDisabled();
    expect(maybe("Submit")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/submitted for review/);
    expect(queued()[0].lifecycleActions).toEqual(["start", "submit"]);

    first.unmount();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    expect(field("Instruction")).toBeDisabled();
    expect(field("Instruction")).toHaveValue("PASS");
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });

  it("shows a rejected inspection's reason and offers only Begin rework", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      bootstrapOnly(withServerInspection({ status: "REJECTED", rejection_reason: "Hold the test longer" }))
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");

    expect(screen.getByText("Changes required", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Hold the test longer")).toBeInTheDocument();
    expect(button("Begin rework")).toBeEnabled();
    expect(maybe("Save progress")).toBeNull();
    expect(maybe("Submit")).toBeNull();
    expect(maybe("Start inspection")).toBeNull();
    expect(field("Notes")).toBeDisabled();
  });

  it("Begin rework restores editing, keeps the reason as guidance, and resubmit clears it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      bootstrapOnly(withServerInspection({ status: "REJECTED", rejection_reason: "Hold the test longer" }))
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");
    await user.click(button("Begin rework"));

    expect(field("Notes")).toBeEnabled();
    expect(screen.getByText("Rework requested")).toBeInTheDocument();
    expect(screen.getByText("Hold the test longer")).toBeInTheDocument();
    const [operation] = queued();
    expect(operation.lifecycleActions).toEqual(["rework"]);
    expect(operation.op).toBe("update");
    expect(operation.baseVersion).toBe(1);

    // The saved form comes back for rework; completing and submitting resubmits it.
    await user.type(field("Ohms end B"), "0.2");
    await user.type(field("Ohms total"), "0.6");
    await user.selectOptions(field("Certificate result"), "PASS");
    await user.click(screen.getByRole("button", { name: "Pass all" }));
    await user.click(button("Submit"));
    expect(queued()[0].lifecycleActions).toEqual(["rework", "submit"]);
    expect(screen.queryByText("Rework requested")).toBeNull();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });

  it("shows an inspection the server holds in progress as editable, not as a draft", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", bootstrapOnly(withServerInspection({ status: "IN_PROGRESS" })));
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");
    expect(maybe("Start inspection")).toBeNull();
    expect(field("Notes")).toBeEnabled();
    expect(button("Save progress")).toBeInTheDocument();
  });

  it("pushes the whole native sequence, in order, with no inferred status", async () => {
    const user = userEvent.setup();
    const pushed: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/api/v1/sync/push")) {
          const body = JSON.parse(String(init?.body)) as { operations: Array<Record<string, unknown>> };
          pushed.push(...body.operations);
          return new Response(JSON.stringify({
            cursor: 3,
            results: body.operations.map((operation) => ({
              op_id: operation.op_id, idempotency_key: operation.idempotency_key, entity: "Inspection",
              entity_id: operation.entity_id, status: "applied", version: 3, current_version: 3, payload: null, error: null
            }))
          }), { status: 200 });
        }
        return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
      }))
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await user.click(button("Start inspection"));
    await fillForm(user);
    await user.click(button("Submit"));
    await user.click(button("Queue"));
    await user.click(button("Push Changes"));

    await waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].lifecycle_actions).toEqual(["start", "submit"]);
    expect(pushed[0].op).toBe("create");
    expect(pushed[0].payload).not.toHaveProperty("status");
    expect(await screen.findByText("Applied")).toBeInTheDocument();
  });

  it("shows the work list with lifecycle labels, not draft wording", async () => {
    vi.stubGlobal(
      "fetch",
      bootstrapOnly(withServerInspection({ status: "REJECTED", rejection_reason: "x" }))
    );
    render(<App initialAccessToken="test-access-token" />);
    expect(await screen.findByText("Changes required")).toBeInTheDocument();
    expect(screen.queryByText("Draft saved")).toBeNull();
  });
});
