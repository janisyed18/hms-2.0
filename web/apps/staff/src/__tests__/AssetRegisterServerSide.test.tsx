import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsWorkspace } from "../components/AssetsWorkspace";
import type { AssetRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAsset: vi.fn(),
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
