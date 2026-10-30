import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHmsClient } from "../api/hmsClient";
import { OperationalWorkspace } from "../components/OperationalWorkspace";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const empty = { total: 0, limit: 50, offset: 0, items: [] };

function stubDashboard() {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url), "http://test").pathname;
    if (path !== "/api/v1/dashboard") return ok(empty);
    return ok({
      total_assets: 2, total_customers: 1, in_service_assets: 2, due_soon_assets: 2, overdue_assets: 2,
      awaiting_review_inspections: 2, overdue_total: 2, overdue_limit: 5, overdue_offset: 0,
      overdue_retests: [
        { asset_id: "a1", asset_number: "HMS-1", asset_name: "Main Transfer Hose", customer_name: "Mine Ltd", product_name: "Hose", due_at: "2026-10-01", days_overdue: 9, status: "OVERDUE" },
        { asset_id: "a2", asset_number: "HMS-2", asset_name: null, customer_name: "Mine Ltd", product_name: "Hose", due_at: "2026-10-02", days_overdue: 8, status: "OVERDUE" }
      ],
      due_this_week: [
        { asset_id: "a1", asset_number: "HMS-1", asset_name: "Main Transfer Hose", customer_name: "Mine Ltd", due_at: "2026-11-02" },
        { asset_id: "a2", asset_number: "HMS-2", customer_name: "Mine Ltd", due_at: "2026-11-03" }
      ],
      awaiting_review: [
        { inspection_id: "i1", asset_id: "a1", asset_number: "HMS-1", asset_name: "Main Transfer Hose", inspection_type: "SERVICE", status: "SUBMITTED", result: "PASS" },
        { inspection_id: "i2", asset_id: "a2", asset_number: "HMS-2", asset_name: null, inspection_type: "SERVICE", status: "SUBMITTED", result: null }
      ]
    });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("the dashboard names assets first", () => {
  it("names the overdue table, due list and review cards by asset name, with the number kept", async () => {
    stubDashboard();
    render(<OperationalWorkspace canEscalate={false} module="dashboard" onAssetOpen={vi.fn()} onModuleChange={vi.fn()} userName="Admin" />);

    const table = await screen.findByRole("table", { name: "Overdue retests" });
    expect(within(table).getByRole("button", { name: "Open asset Main Transfer Hose, HMS-1" })).toHaveTextContent("Main Transfer Hose — HMS-1");
    expect(within(table).getByRole("button", { name: "Open asset HMS-2" })).toHaveTextContent("HMS-2");

    const due = screen.getByRole("button", { name: "Open scheduled asset Main Transfer Hose, HMS-1" });
    expect(due).toHaveTextContent("Main Transfer Hose");
    expect(due).toHaveTextContent("Asset #HMS-1");
    const plainDue = screen.getByRole("button", { name: "Open scheduled asset HMS-2" });
    expect(plainDue).not.toHaveTextContent("Asset #");

    const review = screen.getByRole("button", { name: "Open inspection Main Transfer Hose, HMS-1" });
    expect(review).toHaveTextContent("Main Transfer Hose");
    expect(review).toHaveTextContent("Asset #HMS-1");
    expect(screen.getByRole("button", { name: "Open inspection HMS-2" })).not.toHaveTextContent("Asset #");
  });
});

describe("My Work from the API", () => {
  it("reads the asset name beside the number, and tolerates a response without it", async () => {
    const api = (number: string, name?: string | null) => ({
      id: `w-${number}`, kind: "INSPECTION", state: "AWAITING_REVIEW", priority: "NORMAL", title: "t", summary: "s",
      customer_id: "c1", customer_name: "Mine", asset_id: `a-${number}`, asset_number: number,
      ...(name === undefined ? {} : { asset_name: name }),
      inspection_id: null, booking_id: null, certificate_id: null, due_at: null, updated_at: "2026-10-01T00:00:00Z",
      next_action: { code: "REVIEW_INSPECTION", label: "Review", target_type: "INSPECTION", target_id: null, inspection_id: null }
    });
    vi.stubGlobal("fetch", vi.fn(async () => ok({
      summary: { total: 3, urgent: 0, due_soon: 0, normal: 3 }, limit: 50, source_limit: 500, source_limited: false,
      items: [api("A-1", "Main Transfer Hose"), api("A-2", null), api("A-3")]
    })));
    const work = await createHmsClient().getMyWork(50);
    expect(work.items.map((item) => [item.assetNumber, item.assetName ?? null])).toEqual([
      ["A-1", "Main Transfer Hose"], ["A-2", null], ["A-3", null]
    ]);
  });
});
