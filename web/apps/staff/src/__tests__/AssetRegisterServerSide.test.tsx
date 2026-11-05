import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsWorkspace } from "../components/AssetsWorkspace";
import type { AssetRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAsset: vi.fn(),
  deleteAsset: vi.fn(),
  updateAsset: vi.fn(),
  getCustomer: vi.fn(),
  getAssetConfigurationOptions: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const asset = (index: number, customer = { id: "cust-1", code: "C1", name: "Orica" }) => ({
  id: `asset-${index}`, assetNumber: `HMS-${String(index).padStart(3, "0")}`, assetName: null, customerSerialNo: null, purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "a", lengthM: null,
  customer, product: { id: "prod-1", code: "P", name: "Hydraulic Hose", category: "Hose" },
  location: null, aEnd: blankEnd, bEnd: blankEnd, inspectionHistory: [], certificateHistory: [], pressureRating: null
}) as unknown as AssetRecord;

// 130 assets: well past the old 50-row first page. Customer "Zeta" and its asset sit beyond both the first
// 50 assets and the first 100 customers.
const ZETA = { id: "cust-zeta", code: "ZET", name: "Zeta Marine" };
const assets = [...Array.from({ length: 129 }, (_, index) => asset(index + 1)), asset(130, ZETA)];
const customers = [...Array.from({ length: 120 }, (_, index) => ({ id: `cust-${index}`, code: `C${index}`, name: `Customer ${String(index).padStart(3, "0")}` })), ZETA];

type Options = { search?: string; customerId?: string; productId?: string; status?: string; dueFrom?: string; dueTo?: string; limit?: number; offset?: number };

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getAssetConfigurationOptions.mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] });
  client.listAssets.mockImplementation(async (options: Options = {}) => {
    const needle = (options.search ?? "").toLowerCase();
    const matching = assets.filter((item) =>
      (!options.customerId || item.customer.id === options.customerId)
      && (!options.status || item.lifecycleStatus === options.status)
      && (!needle || item.assetNumber.toLowerCase().includes(needle)));
    const offset = options.offset ?? 0;
    return { total: matching.length, etag: null, items: matching.slice(offset, offset + (options.limit ?? 50)) };
  });
  client.listCustomers.mockImplementation(async (options: { search?: string } = {}) => {
    const needle = (options.search ?? "").toLowerCase();
    const matching = customers.filter((item) => item.name.toLowerCase().includes(needle));
    return { total: matching.length, etag: null, items: matching.slice(0, 25) };
  });
  client.listProducts.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.getCustomer.mockImplementation(async (id: string) => ({
    ...(customers.find((item) => item.id === id) ?? customers[0]),
    locations: [{ id: "loc-1", name: "Yard", schedulingTimezone: null }]
  }));
});

describe("Asset register is filtered and paged by the server", () => {
  it("shows the real total, loads the next page on request and never claims to have searched everything", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);

    expect(await screen.findByText("HMS-001")).toBeInTheDocument();
    expect(screen.getByText("50 of 130 assets loaded")).toBeVisible();
    expect(screen.queryByText("HMS-051")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load more (50 of 130)" }));
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ offset: 50, limit: 50 })));
    await waitFor(() => expect(screen.getByText("100 of 130 assets loaded")).toBeVisible());
  });

  it("keeps a deleted asset out of the register when an older list answer arrives after it", async () => {
    // A list answer is prepared before the delete and arrives after it, so it still
    // carries the deleted row. Writing it would put the row back on screen.
    const user = userEvent.setup();
    let releaseStale: (() => void) | undefined;
    const stale = new Promise<void>((resolve) => { releaseStale = resolve; });
    let calls = 0;
    const page = (items: AssetRecord[]) => ({ total: items.length, etag: null, items });
    client.listAssets.mockImplementation(async (options: Options = {}) => {
      if (options.limit === 1) return page([]); // the totals above the table
      calls += 1;
      if (calls === 1) return page(assets.slice(0, 2));
      await stale; // the searched-for answer, held until the delete has landed
      return page(assets.slice(0, 2));
    });
    client.deleteAsset.mockResolvedValue(undefined);

    render(<AssetsWorkspace canDelete canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    expect(await screen.findByText("HMS-001")).toBeInTheDocument();

    // Searching asks the server again; that answer is now in flight.
    await user.type(screen.getByLabelText("Search assets"), "HMS-00");
    await waitFor(() => expect(calls).toBeGreaterThan(1));

    await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete asset" }));
    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledWith("asset-1", "a"));
    await waitFor(() => expect(screen.queryByText("HMS-001")).toBeNull());

    releaseStale?.();
    // The held answer lands now; the deleted row must not come back with it.
    await waitFor(() => expect(screen.getByText("HMS-002")).toBeVisible());
    expect(screen.queryByText("HMS-001")).toBeNull();
  });

  it("keeps a saved edit when an older list answer arrives after it", async () => {
    // The same hazard on the save path: the answer in flight still holds the old name.
    const user = userEvent.setup();
    let releaseStale: (() => void) | undefined;
    const stale = new Promise<void>((resolve) => { releaseStale = resolve; });
    let calls = 0;
    const located = { ...asset(1), location: { id: "loc-1", name: "Yard", schedulingTimezone: null } } as unknown as AssetRecord;
    const page = (items: AssetRecord[]) => ({ total: items.length, etag: null, items });
    client.listAssets.mockImplementation(async (options: Options = {}) => {
      if (options.limit === 1) return page([]);
      calls += 1;
      if (calls === 1) return page([located]);
      await stale;
      return page([located]); // the name as it was before the edit
    });
    client.updateAsset.mockResolvedValue({ ...located, assetName: "Renamed hose", etag: "b" });

    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    expect(await screen.findByText("HMS-001")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search assets"), "HMS");
    await waitFor(() => expect(calls).toBeGreaterThan(1));

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const name = await screen.findByLabelText("Asset Name");
    await user.clear(name);
    await user.type(name, "Renamed hose");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    await waitFor(() => expect(client.updateAsset).toHaveBeenCalled());
    expect(await screen.findByText("Renamed hose")).toBeInTheDocument();

    releaseStale?.();
    // The held answer lands now; it must not undo the saved name.
    await waitFor(() => expect(screen.getByText("Renamed hose")).toBeInTheDocument());
    expect(screen.queryByText("HMS-001")).toBeNull();
  });

  it("finds an asset past the first page by searching the server", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    await screen.findByText("HMS-001");

    await user.type(screen.getByLabelText("Search assets"), "HMS-130");

    expect(await screen.findByText("HMS-130")).toBeInTheDocument();
    expect(screen.getByText("1 matching assets")).toBeVisible();
    expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ search: "HMS-130" }));
  });

  it("filters by a customer beyond the first page of customers, found by searching", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    await screen.findByText("HMS-001");

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const customerFilter = screen.getByRole("combobox", { name: "Asset customer filter" });
    // Zeta is not among the first customers the lookup offers; typing finds it on the server.
    await user.click(customerFilter);
    expect(screen.queryByRole("option", { name: /Zeta Marine/ })).toBeNull();
    await user.type(customerFilter, "Zeta");
    await user.click(await screen.findByRole("option", { name: /Zeta Marine/ }));

    expect(await screen.findByText("HMS-130")).toBeInTheDocument();
    expect(screen.queryByText("HMS-001")).toBeNull();
    expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ customerId: "cust-zeta" }));
    expect(screen.getAllByText("Zeta Marine").length).toBeGreaterThan(0);
  });

  it("sends the lifecycle and due-date filters to the server", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    await screen.findByText("HMS-001");

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.type(screen.getByLabelText("Asset due from"), "2027-01-01");
    await user.type(screen.getByLabelText("Asset due to"), "2027-12-31");
    await user.selectOptions(screen.getByLabelText("Asset lifecycle filter"), "OVERDUE");

    await waitFor(() => expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ status: "OVERDUE", dueFrom: "2027-01-01", dueTo: "2027-12-31" })));
  });

  it("counts the whole register above the table, not the rows on screen", async () => {
    render(<AssetsWorkspace canWrite onAssetRouteChange={vi.fn()} routeAssetId={null} />);
    await screen.findByText("HMS-001");

    await waitFor(() => expect(screen.getByRole("region", { name: "Asset register summary" })).toHaveTextContent("Total assets130"));
    expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ status: "OVERDUE", limit: 1 }));
  });
});
