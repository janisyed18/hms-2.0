import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";
import { assetDisplayName, assetSecondaryNumber } from "../domain/assetIdentity";
import { createSyncClient, mapBootstrapToWorkItems } from "../api/syncClient";
import type { OutboxOperation } from "../domain/types";
import { outboxStorageKey } from "../offline/outboxStore";
import { bootstrapOnly } from "../test/syncFetch";

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

/** The mock bootstrap with the first asset named; the others keep no name. */
function bootstrapWithName(name: string | null) {
  const body = structuredClone(mockBootstrapResponse) as typeof mockBootstrapResponse;
  const change = (body as unknown as { records: Array<{ entity: string; entity_id: string; payload: Record<string, unknown> }> })
    .records?.find((record) => record.entity === "Asset" && record.payload.asset_number === "HOS-2024-0891");
  if (change) change.payload.asset_name = name;
  return { body, named: Boolean(change) };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("asset identity helpers", () => {
  it("names first and falls back to the number", () => {
    expect(assetDisplayName({ assetNumber: "HMS-1", assetName: " Pump " })).toBe("Pump");
    expect(assetDisplayName({ assetNumber: "HMS-1", assetName: "  " })).toBe("HMS-1");
    expect(assetDisplayName({ assetNumber: "HMS-1" })).toBe("HMS-1");
  });

  it("offers the number as secondary only when the name is a real, different name", () => {
    expect(assetSecondaryNumber({ assetNumber: "HMS-1", assetName: "Pump" })).toBe("HMS-1");
    expect(assetSecondaryNumber({ assetNumber: "HMS-1", assetName: "HMS-1" })).toBeNull();
    expect(assetSecondaryNumber({ assetNumber: "HMS-1", assetName: null })).toBeNull();
  });
});

describe("the sync client and asset names", () => {
  it("reads the asset name from the bootstrap and tolerates its absence", () => {
    const { body } = bootstrapWithName("Main Transfer Hose");
    const items = mapBootstrapToWorkItems(body);
    expect(items.find((item) => item.assetNumber === "HOS-2024-0891")?.assetName).toBe("Main Transfer Hose");
    expect(items.find((item) => item.assetNumber !== "HOS-2024-0891")?.assetName ?? null).toBeNull();
  });

  it("never sends the display name to the server: the push body is exactly the documented operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cursor: 9, results: [] }) });
    const client = createSyncClient({ fetchImpl: fetchMock, getAccessToken: () => "token" });
    const operation: OutboxOperation = {
      opId: "op-1", idempotencyKey: "idem-1", entity: "Inspection", entityId: "inspection-1", assetId: "asset-1",
      assetNumber: "HOS-2024-0891", assetName: "Main Transfer Hose", customerName: "North Sea Shipping Ltd",
      op: "create", baseVersion: null, payload: { status: "DRAFT" }, status: "pending",
      createdAt: "2026-07-04T00:00:00.000Z", updatedAt: "2026-07-04T00:00:00.000Z"
    };
    await client.push([operation]);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { operations: Array<Record<string, unknown>> };
    expect(Object.keys(sent.operations[0]).sort()).toEqual(["base_version", "entity", "entity_id", "idempotency_key", "op", "op_id", "payload", "work_context"].filter((key) => key in sent.operations[0]).sort());
    expect(JSON.stringify(sent)).not.toContain("Main Transfer Hose");
  });
});

describe("the inspector shows the asset name first", () => {
  it("names the work card, keeps the number under it, and leaves an unnamed asset's number alone", async () => {
    const { body, named } = bootstrapWithName("Main Transfer Hose");
    expect(named).toBe(true);
    vi.stubGlobal("fetch", bootstrapOnly(body));
    render(<App initialAccessToken="test-access-token" />);

    const open = await screen.findByRole("button", { name: "Open Main Transfer Hose, HOS-2024-0891" });
    const card = open.closest("article") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "Main Transfer Hose" })).toBeInTheDocument();
    expect(within(card).getByText("Asset #HOS-2024-0891")).toBeInTheDocument();

    const plain = (await screen.findByRole("button", { name: /^Open HOS-2025-0201$/ })).closest("article") as HTMLElement;
    expect(within(plain).getByRole("heading", { name: "HOS-2025-0201" })).toBeInTheDocument();
    expect(within(plain).queryByText(/Asset #/)).toBeNull();
  });

  it("finds work by name or by number", async () => {
    const user = userEvent.setup();
    const { body } = bootstrapWithName("Main Transfer Hose");
    vi.stubGlobal("fetch", bootstrapOnly(body));
    render(<App initialAccessToken="test-access-token" />);
    await screen.findByRole("button", { name: "Open Main Transfer Hose, HOS-2024-0891" });
    const search = screen.getByLabelText("Search work");
    await user.type(search, "transfer");
    expect(screen.getByRole("button", { name: "Open Main Transfer Hose, HOS-2024-0891" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "HOS-2024-0891");
    expect(screen.getByRole("button", { name: "Open Main Transfer Hose, HOS-2024-0891" })).toBeInTheDocument();
  });

  it("carries the name into the capture header and onto the queued work", async () => {
    const user = userEvent.setup();
    const { body } = bootstrapWithName("Main Transfer Hose");
    vi.stubGlobal("fetch", bootstrapOnly(body));
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: "Open Main Transfer Hose, HOS-2024-0891" }));

    const context = screen.getByRole("complementary", { name: "Asset context" });
    expect(within(context).getByRole("heading", { name: "Main Transfer Hose" })).toBeInTheDocument();
    expect(within(context).getByText("Asset #HOS-2024-0891")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start inspection" }));
    await waitFor(() => {
      const raw = localStorage.getItem(outboxStorageKey("test-inspector"));
      const operations = raw ? (JSON.parse(raw).operations as Array<{ assetName?: string; assetNumber: string }>) : [];
      expect(operations[0]).toMatchObject({ assetNumber: "HOS-2024-0891", assetName: "Main Transfer Hose" });
    });
  });
});
