import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerTable } from "../components/CustomerTable";
import type { CustomerRecord } from "../domain/types";
import { useCustomerWorkspace } from "../hooks/useCustomerWorkspace";

function apiCustomer(code: string, name: string, assetCount: number, inService: number) {
  return {
    id: `id-${code}`,
    code,
    name,
    notes: null,
    retest_enabled: true,
    default_retest_months: 12,
    locations: [
      { id: `loc-${code}-1`, name: "Harris Park", address_1: null, address_2: null, city: null, state: null, country: null },
      { id: `loc-${code}-2`, name: "Preston", address_1: null, address_2: null, city: null, state: null, country: null }
    ],
    contacts: [],
    metrics: { asset_count: assetCount, in_service_count: inService }
  };
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("customer asset counts on the Customers screen", () => {
  it("uses the API count and never tallies a page of the global asset list", async () => {
    // 150 other assets exist, so TH's two would fall outside the first 100 of the system.
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      requested.push(path);
      if (path.startsWith("/api/v1/customers")) {
        return okJson({
          total: 4,
          limit: 50,
          offset: 0,
          items: [
            apiCustomer("BULK", "Bulk Co", 150, 150),
            apiCustomer("TH", "TH Industries", 2, 1),
            apiCustomer("ONE", "Single Asset Ltd", 1, 1),
            apiCustomer("NONE", "No Assets Ltd", 0, 0)
          ]
        });
      }
      throw new Error(`unexpected request ${path}`);
    }));

    const { result } = renderHook(() => useCustomerWorkspace());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const counts = Object.fromEntries(result.current.customers.map((c) => [c.code, c.metrics.assetCount]));
    expect(counts).toEqual({ BULK: 150, TH: 2, ONE: 1, NONE: 0 });
    expect(requested.some((path) => path.startsWith("/api/v1/assets"))).toBe(false);
  });

  it("searches on the server and keeps a customer's count when the search hides other customers", async () => {
    const all = [apiCustomer("TH", "TH Industries", 2, 1), apiCustomer("ONE", "Single Asset Ltd", 1, 1)];
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      requested.push(path);
      if (path.startsWith("/api/v1/customers/summary")) {
        return okJson({ active_customers: 2, archived_customers: 0, locations: 4, assets: 3 });
      }
      const search = new URL(path, "http://localhost").searchParams.get("search")?.toLowerCase() ?? "";
      const items = all.filter((item) => item.name.toLowerCase().includes(search));
      return okJson({ total: items.length, limit: 10, offset: 0, items });
    }));
    const { result } = renderHook(() => useCustomerWorkspace());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const { act } = await import("@testing-library/react");
    act(() => result.current.setQuery("th industries"));
    await waitFor(() => expect(result.current.visibleCustomers.map((c) => c.code)).toEqual(["TH"]));
    expect(result.current.visibleCustomers[0].metrics.assetCount).toBe(2);
    expect(requested.some((path) => path.includes("search=th+industries") || path.includes("search=th%20industries"))).toBe(true);
    // The headline totals are system-wide: searching does not shrink them.
    expect(result.current.summary).toMatchObject({ activeCustomers: 2, assets: 3 });
    act(() => result.current.setQuery(""));
    await waitFor(() => expect(result.current.visibleCustomers).toHaveLength(2));
  });
});

function record(code: string, assetCount: number, inService: number): CustomerRecord {
  return {
    id: `id-${code}`,
    code,
    name: { TH: "TH Industries", ONE: "Single Asset Ltd", NONE: "No Assets Ltd" }[code] ?? code,
    notes: null,
    retestEnabled: true,
    defaultRetestMonths: 12,
    locations: [
      { id: "l1", name: "Harris Park", address1: null, address2: null, city: null, state: null, country: null, contacts: [] },
      { id: "l2", name: "Preston", address1: null, address2: null, city: null, state: null, country: null, contacts: [] }
    ] as unknown as CustomerRecord["locations"],
    contacts: [],
    status: "Active",
    archivedAt: null,
    metrics: {
      assetCount,
      inServiceCount: inService,
      inspectionDueCount: null,
      inspectionDueLabel: "Not available",
      certificateValidPercent: null,
      certificateStatusLabel: "Not available",
      recentInspections: [],
      activity: []
    }
  };
}

describe("customer card and detail", () => {
  it("shows the true asset count, in-service count and sites on the card, and totals them", () => {
    const customers = [record("TH", 2, 1), record("NONE", 0, 0), record("ONE", 1, 1)];
    render(
      <CustomerTable
        canWrite={false}
        customers={customers}
        isLoading={false}
        lifecycle="active"
        onAddCustomer={() => undefined}
        onLifecycleChange={() => undefined}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onQueryChange={() => undefined}
        onSelectCustomer={() => undefined}
        page={1}
        pageSize={10}
        query=""
        selectedId={null}
        summary={{ activeCustomers: 3, archivedCustomers: 0, locations: 6, assets: 3 }}
        totalCount={3}
      />
    );

    const card = screen.getByRole("button", { name: /TH Industries/ });
    expect(card).toHaveTextContent(/2\s*Assets/);
    expect(card).toHaveTextContent(/1\s*In service/);
    expect(card).toHaveTextContent(/2\s*Sites/);
    expect(screen.getByRole("button", { name: /No Assets Ltd/ })).toHaveTextContent(/0\s*Assets/);
    expect(screen.getByRole("button", { name: /Single Asset Ltd/ })).toHaveTextContent(/1\s*Assets/);
    expect(screen.getByText("3 total assets")).toBeVisible();
    // The old card showed a fabricated "0 Current".
    expect(card).not.toHaveTextContent(/Current/);
  });
});
