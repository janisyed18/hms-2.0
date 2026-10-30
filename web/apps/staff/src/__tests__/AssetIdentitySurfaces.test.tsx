import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsWorkspace } from "../components/AssetsWorkspace";
import { CustomerDetail } from "../components/CustomerDetail";
import { CustomerTable } from "../components/CustomerTable";
import type { AssetRecord, CustomerRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  getAsset: vi.fn(),
  getAssetWorkflow: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAssetConfigurationOptions: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const location = { id: "loc-1", name: "Kooragang", address1: null, address2: null, city: null, state: null, country: null };
const asset = (id: string, number: string, name: string | null) => ({
  id, assetNumber: number, assetName: name, customerSerialNo: null, purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "a1", lengthM: null,
  customer: { id: "cust-1", code: "ORIC", name: "Orica" },
  product: { id: "prod-1", code: "P", name: "Hydraulic Hose", category: "Hose" },
  location, aEnd: blankEnd, bEnd: blankEnd, inspectionHistory: [], certificateHistory: [], pressureRating: null
}) as unknown as AssetRecord;
const list = (items: unknown[]) => ({ total: items.length, limit: 100, offset: 0, etag: null, items });
const LONG = "High Pressure Chemical Transfer Hose Assembly 04";

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getAssetWorkflow.mockResolvedValue({ status: "CURRENT", label: "Current", detail: "", attention: false, related: { bookingId: null, appointmentId: null, inspectionId: null, certificateId: null }, context: { scheduledAt: null, dueAt: null, certificateNumber: null }, nextAction: null });
  client.listAssets.mockResolvedValue(list([
    asset("1", "HMS-373CEBA88", "Main Transfer Hose"),
    asset("2", "HMS-222", LONG),
    asset("3", "HMS-333", null)
  ]));
  client.listCustomers.mockResolvedValue(list([]));
  client.listProducts.mockResolvedValue(list([]));
  client.getAssetConfigurationOptions.mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] });
});

describe("Staff asset register", () => {
  it("names each asset first, keeps its number underneath, and falls back to the number alone", async () => {
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    const named = (await screen.findByText("Main Transfer Hose")).closest("tr") as HTMLElement;
    expect(within(named).getByText("Asset #HMS-373CEBA88")).toBeInTheDocument();
    // A long name stays whole in the DOM (wrapped by CSS, full text on hover), with its number.
    const long = screen.getByText(LONG).closest("tr") as HTMLElement;
    expect(screen.getByText(LONG)).toHaveAttribute("title", LONG);
    expect(within(long).getByText("Asset #HMS-222")).toBeInTheDocument();
    // No name: the number is the label, shown once.
    const unnamed = screen.getByText("HMS-333").closest("tr") as HTMLElement;
    expect(within(unnamed).queryByText(/Asset #/)).toBeNull();
  });

  it("still finds an asset by its number, and by its name", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    await screen.findByText("Main Transfer Hose");
    const search = screen.getByLabelText("Search assets");
    await user.type(search, "hms-373ceba88");
    expect(screen.getByText("Main Transfer Hose")).toBeInTheDocument();
    expect(screen.queryByText(LONG)).toBeNull();
    await user.clear(search);
    await user.type(search, "chemical transfer");
    expect(screen.getByText(LONG)).toBeInTheDocument();
    expect(screen.queryByText("Main Transfer Hose")).toBeNull();
  });

  it("titles the detail with the name and lists the number among the facts", async () => {
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId="1" />);
    const detail = await screen.findByRole("complementary", { name: "Asset detail" });
    expect(within(detail).getByRole("heading", { name: "Main Transfer Hose", level: 2 })).toBeInTheDocument();
    expect(detail).toHaveTextContent("Asset #HMS-373CEBA88 · Orica · Kooragang");
    expect(within(detail).getByText("Asset number").nextElementSibling).toHaveTextContent("HMS-373CEBA88");
  });

  it("titles an unnamed asset's detail with its number and does not repeat it", async () => {
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId="3" />);
    const detail = await screen.findByRole("complementary", { name: "Asset detail" });
    expect(within(detail).getByRole("heading", { name: "HMS-333", level: 2 })).toBeInTheDocument();
    expect(detail).not.toHaveTextContent("Asset #HMS-333");
  });
});

describe("Staff customer detail and cards", () => {
  const customer = {
    id: "cust-1", code: "ORIC", name: "Orica", notes: null, retestEnabled: true, defaultRetestMonths: 12,
    locations: [{ ...location, siteContactName: null, siteContactMobile: null, siteContactEmail: null, ppeRequirements: [], additionalRequirements: [] }],
    contacts: [], status: "Active", riskLevel: "Low", industry: "", paymentTerms: "", contractStart: "", contractEnd: "", lastActivity: "",
    metrics: { assetCount: 2, inServiceCount: 2, inspectionDueCount: null, inspectionDueLabel: "", certificateValidPercent: null, certificateStatusLabel: "", recentInspections: [], activity: [] }
  } as unknown as CustomerRecord;

  it("lists a location's assets by name with the number, and opens them with a label naming both", async () => {
    const user = userEvent.setup();
    const onAssetOpen = vi.fn();
    client.listAssets.mockResolvedValue(list([asset("1", "HMS-373CEBA88", "Main Transfer Hose"), asset("3", "HMS-333", null)]));
    render(<CustomerDetail activeTab="Locations" canWrite={false} customer={customer} onAssetOpen={onAssetOpen} onClose={vi.fn()} onEdit={vi.fn()} onTabChange={vi.fn()} />);
    const link = await screen.findByRole("button", { name: "Open asset Main Transfer Hose, HMS-373CEBA88" });
    expect(link).toHaveTextContent("Main Transfer Hose");
    expect(link).toHaveTextContent("Asset #HMS-373CEBA88");
    expect(screen.getByRole("button", { name: "Open asset HMS-333" })).toBeInTheDocument();
    await user.click(link);
    expect(onAssetOpen).toHaveBeenCalledWith("1");
  });

  it("derives a card's initials from the first two words of the customer's name", () => {
    const named = (name: string, code: string) => ({ ...customer, id: code, code, name });
    const customers = [named("Xero Stock Private Limited", "XS1"), named("XERO PTY Ltd", "XP1"), named("Momentum", "MO1")];
    render(
      <CustomerTable allCustomers={customers} canWrite={false} customers={customers} onAddCustomer={() => undefined}
        onQueryChange={() => undefined} onRiskFilterChange={() => undefined} onSelectCustomer={() => undefined}
        onStatusFilterChange={() => undefined} query="" riskFilter="All" selectedId={null} statusFilter="All" totalCount={3} />
    );
    const avatar = (name: RegExp) => screen.getByRole("button", { name }).querySelector(".customer-avatar") as HTMLElement;
    expect(avatar(/Xero Stock Private Limited/)).toHaveTextContent("XS");
    expect(avatar(/XERO PTY Ltd/)).toHaveTextContent("XP");
    expect(avatar(/Momentum/)).toHaveTextContent("M");
    expect(avatar(/Momentum/)).toHaveAttribute("aria-hidden", "true");
  });
});
