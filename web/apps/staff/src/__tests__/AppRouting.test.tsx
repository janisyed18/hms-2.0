import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App, { HmsApp } from "../App";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";
import type { CustomerRecord, StaffSession } from "../domain/types";

const empty = { total: 0, limit: 50, offset: 0, etag: null, nextAfter: null, items: [] };
const client = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () =>
    new Proxy({}, {
      get: (_target, name: string) => (client.overrides[name] ?? (async () => ({ ...empty, unreadTotal: 0 })))
    })
}));

// The workspaces are stood in for by panels that show what the URL told them and let a test act as the
// person would: this file is about the routing between them, which the real components do not change.
vi.mock("../components/AssetsWorkspace", () => ({
  AssetsWorkspace: ({ routeAssetId, onAssetRouteChange }: { routeAssetId?: string | null; onAssetRouteChange?: (id: string | null) => void }) => (
    <section aria-label="Assets stub">
      <p>Asset open: {routeAssetId ?? "none"}</p>
      <button onClick={() => onAssetRouteChange?.("asset-9")} type="button">Open asset 9</button>
      <button onClick={() => onAssetRouteChange?.(null)} type="button">Close asset</button>
    </section>
  )
}));
vi.mock("../components/InspectionsWorkspace", () => ({
  InspectionsWorkspace: ({ routeInspectionId }: { routeInspectionId?: string | null }) => <p>Inspection open: {routeInspectionId ?? "none"}</p>
}));
vi.mock("../components/OperationalWorkspace", () => ({
  OperationalWorkspace: ({ userName }: { userName: string | null }) => <h2>Dashboard stub {userName ?? "nobody"}</h2>
}));
vi.mock("../components/SystemWorkspace", () => ({
  SystemWorkspace: ({ module, usersRoute }: { module: string; usersRoute?: { query: { role: string; page: number } } }) => (
    <p>System {module} role={usersRoute?.query.role || "any"} page={usersRoute?.query.page}</p>
  )
}));
vi.mock("../components/CustomerPortalWorkspace", () => ({
  CustomerPortalWorkspace: ({ activeModule, customerId, assetId, onCustomerChange }: { activeModule: string; customerId: string | null; assetId: string | null; onCustomerChange: (id: string, o?: { replace?: boolean }) => void }) => (
    <section aria-label="Portal stub">
      <p>Portal {activeModule} org={customerId ?? "none"} asset={assetId ?? "none"}</p>
      <button onClick={() => onCustomerChange("org-2")} type="button">Switch to org 2</button>
    </section>
  )
}));

const customer = (id: string, name: string) => ({ id, code: id.toUpperCase(), name, notes: null, retestEnabled: true, defaultRetestMonths: 12, locations: [], contacts: [], status: "Active", riskLevel: "Low", industry: "Marine", metrics: { assetCount: 0, inServiceCount: 0 } }) as unknown as CustomerRecord;

const session = (roles: StaffSession["roles"], extra: Partial<StaffSession> = {}): StaffSession => ({
  userId: "u1", displayName: "Jani Syed", email: "jani@example.com", roles, permissions: [], customerIds: [], authMode: "dev", ...extra
});
const admin = session(["HMS_ADMIN"]);
const open = (url: string) => window.history.replaceState(null, "", url);

beforeEach(() => {
  client.overrides = { listCustomers: async () => ({ ...empty, total: 2, items: [customer("c1", "Vopak"), customer("c2", "Orica")] }) };
});

describe("staff deep links", () => {
  it("opens the dashboard at the root and changes the URL without reloading when navigating", async () => {
    open("/");
    render(<App initialSession={admin} />);
    expect(await screen.findByText("Dashboard stub Jani Syed")).toBeInTheDocument();
    const before = window.history.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Assets" }));
    expect(window.location.pathname + window.location.search).toBe("/?view=assets");
    expect(window.history.length).toBe(before + 1);
    expect(await screen.findByText("Asset open: none")).toBeInTheDocument();
  });

  it("restores a module, an asset and an inspection from the link", async () => {
    open("/?view=assets&asset=asset-7");
    const first = render(<App initialSession={admin} />);
    expect(await screen.findByText("Asset open: asset-7")).toBeInTheDocument();
    first.unmount();
    open("/?view=inspections&inspection=insp-3");
    render(<App initialSession={admin} />);
    expect(await screen.findByText("Inspection open: insp-3")).toBeInTheDocument();
  });

  it("hands the asset the person opens to the URL, and Back closes it", async () => {
    open("/?view=assets");
    render(<App initialSession={admin} />);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole("button", { name: "Open asset 9" }));
    expect(window.location.search).toBe("?view=assets&asset=asset-9");
    act(() => window.history.back());
    await screen.findByText("Asset open: none");
    expect(window.location.search).toBe("?view=assets");
  });

  it("restores the customer detail from the link, and a customer that is not theirs is never shown", async () => {
    open("/?view=customers&customer=c2");
    const first = render(<App initialSession={admin} />);
    expect(await screen.findByRole("dialog", { name: /Orica/ })).toBeInTheDocument();
    first.unmount();

    open("/?view=customers&customer=not-mine");
    render(<App initialSession={admin} />);
    await waitFor(() => expect(window.location.search).toBe("?view=customers"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Customer unavailable");
    expect(screen.queryByRole("dialog", { name: /Vopak|Orica/ })).toBeNull();
    expect(window.location.search).toBe("?view=customers");
  });

  it("opens customers, assets and inspections found by global search at their canonical links", async () => {
    client.overrides.listCustomers = async () => ({ ...empty, total: 1, items: [customer("c1", "Harbour Marine")] });
    client.overrides.listAssets = async () => ({ ...empty, total: 1, items: [{ id: "asset-5", assetNumber: "HA-5", assetName: null, customer: { name: "Harbour Marine" }, product: { name: "Hose" } }] });
    client.overrides.listInspections = async () => ({ ...empty, total: 1, items: [{ id: "insp-5", asset: { assetNumber: "HA-5" }, inspectionType: "ANNUAL", status: "DRAFT", customer: { name: "Harbour Marine" } }] });
    open("/");
    render(<App initialSession={admin} />);
    const actor = userEvent.setup();
    const search = await screen.findByPlaceholderText("Search customers, assets, inspections...");

    for (const [kind, url] of [
      ["Customer", "?view=customers&customer=c1"],
      ["Asset", "?view=assets&asset=asset-5"],
      ["Inspection", "?view=inspections&inspection=insp-5"]
    ] as const) {
      await actor.clear(search);
      await actor.type(search, "ha");
      const list = await screen.findByRole("listbox", { name: "Search results" });
      const option = (await within(list).findAllByRole("option")).find((item) => within(item).queryByText(kind, { selector: ".global-search-result-kind" }));
      expect(option, kind).toBeDefined();
      await actor.click(option as HTMLElement);
      await waitFor(() => expect(window.location.search).toBe(url));
    }
  });

  it("carries the Users query into the workspace and never invents one", async () => {
    open("/?view=users&role=INSPECTOR&page=2&bogus=1");
    render(<App initialSession={admin} />);
    expect(await screen.findByText("System users role=INSPECTOR page=2")).toBeInTheDocument();
    expect(window.location.search).toBe("?view=users&role=INSPECTOR&page=2");
  });
});

describe("permissions", () => {
  it("never renders a view the account may not open, and rewrites the URL to one it may", async () => {
    open("/?view=users&role=INSPECTOR");
    render(<App initialSession={session(["INSPECTOR"])} />);
    expect(await screen.findByText("Dashboard stub Jani Syed")).toBeInTheDocument();
    expect(screen.queryByText(/System users/)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("keeps staff-only views out of the customer portal", async () => {
    open("/portal/?view=users");
    render(<HmsApp portalMode session={session(["CUSTOMER_USER"])} />);
    expect(await screen.findByLabelText("Portal stub")).toHaveTextContent("Portal dashboard");
    expect(window.location.pathname + window.location.search).toBe("/portal/");
  });
});

describe("customer portal deep links", () => {
  const portal = () => render(<HmsApp portalMode session={session(["CUSTOMER_USER"])} />);

  it("restores the module, organisation and asset from the link", async () => {
    open("/portal/?view=assets&customer=org-1&asset=asset-2");
    portal();
    expect(await screen.findByText("Portal assets org=org-1 asset=asset-2")).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe("/portal/?view=assets&customer=org-1&asset=asset-2");
  });

  it("switching organisation is a history entry and drops the asset", async () => {
    open("/portal/?view=assets&customer=org-1&asset=asset-2");
    portal();
    await screen.findByText(/org=org-1/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Switch to org 2" }));
    expect(window.location.search).toBe("?view=assets&customer=org-2");
    act(() => window.history.back());
    await screen.findByText("Portal assets org=org-1 asset=asset-2");
  });

  it("opens another workspace in the portal with the organisation kept", async () => {
    open("/portal/?view=assets&customer=org-1");
    portal();
    await screen.findByText(/org=org-1/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Bookings" }));
    expect(window.location.search).toBe("?view=bookings&customer=org-1");
  });
});

describe("signing in through a link", () => {
  it("returns to the requested place after sign-in instead of always landing on the dashboard", async () => {
    open("/?view=assets&asset=asset-7");
    const authClient = {
      refresh: vi.fn().mockRejectedValue(new BrowserAuthError("No session", 401)),
      login: vi.fn().mockResolvedValue({ access_token: "token-1" }),
      me: vi.fn().mockResolvedValue({
        user_id: "u-1", email: "jani@example.com", display_name: "Jani Syed", account_status: "ACTIVE",
        roles: ["HMS_ADMIN"], permissions: ["asset:read"], customer_ids: []
      }),
      logout: vi.fn().mockResolvedValue(undefined)
    } as unknown as BrowserAuthClient;
    render(<App authClient={authClient} />);
    const actor = userEvent.setup();

    await actor.type(await screen.findByLabelText("Email"), "jani@example.com");
    await actor.type(screen.getByLabelText("Password", { exact: true }), "A-long-password-1");
    await actor.click(screen.getByRole("button", { name: /Sign in/ }));

    expect(await screen.findByText("Asset open: asset-7")).toBeInTheDocument();
    expect(window.location.search).toBe("?view=assets&asset=asset-7");
  });
});
