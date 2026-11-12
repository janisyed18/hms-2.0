import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsWorkspace } from "../components/AssetsWorkspace";
import { customerTableProps } from "../test/customerTableProps";
import { CustomerDetail } from "../components/CustomerDetail";
import { CustomerTable } from "../components/CustomerTable";
import type { AssetRecord, CustomerRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  getAsset: vi.fn(),
  getAssetWorkflow: vi.fn(),
  getCustomer: vi.fn(),
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

describe("Staff asset register narrowed to a location", () => {
  it("asks the server for that customer's location only, names both filters, and clears the URL when the location chip is removed", async () => {
    const user = userEvent.setup();
    const onLocationRouteChange = vi.fn();
    client.getCustomer.mockResolvedValue({ id: "cust-1", name: "Orica", locations: [{ id: "loc-1", name: "Kooragang" }] });
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} onLocationRouteChange={onLocationRouteChange} routeAssetId={null} routeCustomerId="cust-1" routeLocationId="loc-1" />);
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-1" })));
    // Both filters are named from the customer record, not shown as ids.
    expect(await screen.findByRole("button", { name: "Remove filter Location: Kooragang" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter Customer: Orica" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove filter Location: Kooragang" }));
    expect(onLocationRouteChange).toHaveBeenCalledWith(null);
    await waitFor(() => expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: undefined })));
  });
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
    // The server does the searching; the stand-in answers like it does, on number and name.
    client.listAssets.mockImplementation(async (options: { search?: string } = {}) => {
      const needle = (options.search ?? "").toLowerCase();
      return list([asset("1", "HMS-373CEBA88", "Main Transfer Hose"), asset("2", "HMS-222", LONG), asset("3", "HMS-333", null)]
        .filter((item) => !needle || `${item.assetNumber} ${item.assetName ?? ""}`.toLowerCase().includes(needle)));
    });
    await user.type(search, "hms-373ceba88");
    await waitFor(() => expect(screen.queryByText(LONG)).toBeNull());
    expect(screen.getByText("Main Transfer Hose")).toBeInTheDocument();
    expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ search: "hms-373ceba88" }));
    await user.clear(search);
    await user.type(search, "chemical transfer");
    await waitFor(() => expect(screen.queryByText("Main Transfer Hose")).toBeNull());
    expect(screen.getByText(LONG)).toBeInTheDocument();
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
    contacts: [], status: "Active", archivedAt: null,
    metrics: { assetCount: 2, inServiceCount: 2, inspectionDueCount: null, inspectionDueLabel: "", certificateValidPercent: null, certificateStatusLabel: "", recentInspections: [], activity: [] }
  } as unknown as CustomerRecord;

  it("shows each location's asset count as one link that opens the register for that customer and location", async () => {
    const user = userEvent.setup();
    const onLocationAssetsOpen = vi.fn();
    client.listAssets.mockResolvedValue(list([asset("1", "HMS-373CEBA88", "Main Transfer Hose"), asset("3", "HMS-333", null)]));
    render(<CustomerDetail activeTab="Locations" canWrite={false} customer={customer} onClose={vi.fn()} onEdit={vi.fn()} onLocationAssetsOpen={onLocationAssetsOpen} onTabChange={vi.fn()} />);
    const link = await screen.findByRole("button", { name: `View 2 assets at ${location.name}` });
    expect(link).toHaveTextContent("2assets");
    // Individual assets are no longer listed on the card.
    expect(screen.queryByRole("button", { name: /^Open asset/ })).toBeNull();
    await user.click(link);
    expect(onLocationAssetsOpen).toHaveBeenCalledWith("cust-1", location.id);
  });

  it("says 1 asset, in the singular, for a location with a single asset", async () => {
    client.listAssets.mockResolvedValue(list([asset("real-id-9", "HMS-9", null)]));
    render(<CustomerDetail activeTab="Locations" canWrite={false} customer={customer} onClose={vi.fn()} onEdit={vi.fn()} onLocationAssetsOpen={vi.fn()} onTabChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: `View 1 asset at ${location.name}` })).toHaveTextContent("1asset");
  });

  it("shows an empty state, and no link, for a location with no assets", async () => {
    client.listAssets.mockResolvedValue(list([]));
    render(<CustomerDetail activeTab="Locations" canWrite={false} customer={customer} onClose={vi.fn()} onEdit={vi.fn()} onLocationAssetsOpen={vi.fn()} onTabChange={vi.fn()} />);
    expect(await screen.findByText("No assets at this location.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^View \d+ assets? at/ })).toBeNull();
  });

  it("derives a card's initials from the first two words of the customer's name", () => {
    const named = (name: string, code: string) => ({ ...customer, id: code, code, name });
    const customers = [named("Xero Stock Private Limited", "XS1"), named("XERO PTY Ltd", "XP1"), named("Momentum", "MO1")];
    render(
      <CustomerTable {...customerTableProps({ canWrite: false, customers })} />
    );
    const avatar = (name: RegExp) => screen.getByRole("button", { name }).querySelector(".customer-avatar") as HTMLElement;
    expect(avatar(/Xero Stock Private Limited/)).toHaveTextContent("XS");
    expect(avatar(/XERO PTY Ltd/)).toHaveTextContent("XP");
    expect(avatar(/Momentum/)).toHaveTextContent("M");
    expect(avatar(/Momentum/)).toHaveAttribute("aria-hidden", "true");
  });
});
