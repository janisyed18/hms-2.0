import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsWorkspace } from "../components/AssetsWorkspace";
import { CustomerPortalWorkspace } from "../components/CustomerPortalWorkspace";
import type { AssetRecord, StaffSession } from "../domain/types";
import { useInspectionsWorkspace } from "../hooks/useInspectionsWorkspace";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  getAsset: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAssetConfigurationOptions: vi.fn(),
  listInspections: vi.fn(),
  listAllAssets: vi.fn(),
  listInspectionBookings: vi.fn(),
  listCertificates: vi.fn(),
  listNotifications: vi.fn(),
  listRetestSchedules: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const asset = (id: string, name: string) => ({
  id, assetNumber: `HMS-${id}`, assetName: name, customerSerialNo: "SN", purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "a1", lengthM: null,
  customer: { id: "cust-1", code: "ORIC", name: "Orica" },
  product: { id: "prod-1", code: "P", name: "Hydraulic Hose", category: "Hose" },
  location: { id: "loc-1", name: "Kooragang", address1: null, address2: null, city: null, state: null, country: null },
  aEnd: blankEnd, bEnd: blankEnd, inspectionHistory: [], certificateHistory: [], pressureRating: null
}) as unknown as AssetRecord;
const list = (items: unknown[]) => ({ total: items.length, limit: 100, offset: 0, etag: null, items });

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listAssets.mockResolvedValue(list([asset("1", "Main Pump Hose"), asset("2", "Spare Hose")]));
  client.listCustomers.mockResolvedValue(list([]));
  client.listProducts.mockResolvedValue(list([]));
  client.getAssetConfigurationOptions.mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] });
});

function AssetsHarness({ initial, onChange }: { initial: string | null; onChange: (id: string | null, options?: { replace?: boolean }) => void }) {
  const [routeId, setRouteId] = useState<string | null>(initial);
  return (
    <>
      <button onClick={() => setRouteId(null)} type="button">Route: Back</button>
      <button onClick={() => setRouteId("2")} type="button">Route: Forward</button>
      <AssetsWorkspace canWrite onAssetRouteChange={(id, options) => { onChange(id, options); setRouteId(id); }} routeAssetId={routeId} />
    </>
  );
}

describe("the asset detail follows the URL", () => {
  it("opens the asset a link names, from the loaded register", async () => {
    const onChange = vi.fn();
    render(<AssetsHarness initial="2" onChange={onChange} />);
    expect(await screen.findByRole("complementary", { name: "Asset detail" })).toHaveTextContent("Spare Hose");
    expect(onChange).not.toHaveBeenCalled(); // opening from the link is not a new navigation
  });

  it("fetches an asset that is not in the loaded page, and shows it", async () => {
    client.getAsset.mockResolvedValue(asset("9", "Far Hose"));
    render(<AssetsHarness initial="9" onChange={vi.fn()} />);
    expect(await screen.findByRole("complementary", { name: "Asset detail" })).toHaveTextContent("Far Hose");
    expect(client.getAsset).toHaveBeenCalledWith("9");
  });

  it("shows nothing for an asset that cannot be opened, and the link stops naming it", async () => {
    client.getAsset.mockRejectedValue(new Error("404"));
    const onChange = vi.fn();
    render(<AssetsHarness initial="gone" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, { replace: true }));
    expect(screen.queryByRole("complementary", { name: "Asset detail" })).toBeNull();
    expect(await screen.findByText("The selected asset could not be opened.")).toBeInTheDocument();
  });

  it("tells the URL when the person opens and closes an asset, and closes when the URL does", async () => {
    const onChange = vi.fn();
    render(<AssetsHarness initial={null} onChange={onChange} />);
    const actor = userEvent.setup();
    await screen.findByText("Main Pump Hose");
    await actor.click(screen.getByText("Main Pump Hose"));
    await screen.findByRole("complementary", { name: "Asset detail" });
    expect(onChange).toHaveBeenCalledWith("1", undefined);

    await actor.click(screen.getByRole("button", { name: "Route: Back" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Asset detail" })).toBeNull());
    await actor.click(screen.getByRole("button", { name: "Route: Forward" }));
    expect(await screen.findByRole("complementary", { name: "Asset detail" })).toHaveTextContent("Spare Hose");

    onChange.mockClear();
    await actor.click(screen.getByRole("button", { name: "Close asset detail" }));
    expect(onChange).toHaveBeenCalledWith(null, undefined);
  });
});

describe("the inspection detail follows the URL", () => {
  const inspection = { id: "insp-1", status: "DRAFT", inspectionType: "ANNUAL", result: null, asset: { assetNumber: "A", tag: null }, customer: { code: "C", name: "C" }, product: { code: "P", name: "P" } };
  beforeEach(() => {
    client.listInspections.mockResolvedValue(list([inspection]));
    client.listAllAssets.mockResolvedValue(list([]));
    client.listInspectionBookings.mockResolvedValue(list([]));
  });

  it("selects the inspection a link names once the list is loaded", async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useInspectionsWorkspace(false, "insp-1", onChange));
    await waitFor(() => expect(result.current.selectedInspection?.id).toBe("insp-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects nothing for an inspection that is not in the list, says so, and the link stops naming it", async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useInspectionsWorkspace(false, "nobody", onChange));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, { replace: true }));
    expect(result.current.selectedInspection).toBeNull();
    expect(result.current.notice).toMatchObject({ kind: "error", title: "Inspection unavailable" });
  });

  it("reports opening and closing to the URL and follows it back", async () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ route }: { route: string | null }) => useInspectionsWorkspace(false, route, onChange), { initialProps: { route: null as string | null } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.openDetail(inspection as never));
    expect(onChange).toHaveBeenCalledWith("insp-1");
    rerender({ route: "insp-1" });
    rerender({ route: null });
    await waitFor(() => expect(result.current.selectedInspection).toBeNull());
  });
});

describe("the customer portal asset follows the URL", () => {
  const session = { userId: "c", displayName: "Customer", roles: ["CUSTOMER_USER"], permissions: [], customerIds: ["org-1"], authMode: "dev" } as StaffSession;
  const org = { id: "org-1", code: "ORG", name: "Orica", notes: null, locations: [], contacts: [], metrics: { assetCount: 2, inServiceCount: 2 } };
  const portalAsset = (id: string) => ({ ...asset(id, "x"), assetNumber: `HMS-${id}` });

  beforeEach(() => {
    client.listCustomers.mockResolvedValue(list([org]));
    client.listAssets.mockResolvedValue(list([portalAsset("1"), portalAsset("2")]));
    client.listInspectionBookings.mockResolvedValue(list([]));
    client.listCertificates.mockResolvedValue(list([]));
    client.listInspections.mockResolvedValue(list([]));
    client.listNotifications.mockResolvedValue({ total: 0, unreadTotal: 0, items: [] });
    client.listRetestSchedules.mockResolvedValue(list([]));
  });

  const portal = (props: { customerId: string | null; assetId: string | null; onAssetChange?: () => void; onCustomerChange?: () => void }) =>
    render(<CustomerPortalWorkspace activeModule="assets" customerId={props.customerId} assetId={props.assetId} onAssetChange={props.onAssetChange ?? vi.fn()} onCustomerChange={props.onCustomerChange ?? vi.fn()} onModuleChange={vi.fn()} session={session} />);

  it("restores the asset detail named by the link", async () => {
    portal({ customerId: "org-1", assetId: "2" });
    expect(await screen.findByRole("heading", { name: "HMS-2" })).toBeInTheDocument();
  });

  it("never shows an asset that is not among this organisation's, and the link stops naming it", async () => {
    const onAssetChange = vi.fn();
    portal({ customerId: "org-1", assetId: "someone-elses", onAssetChange });
    await waitFor(() => expect(onAssetChange).toHaveBeenCalledWith(null, { replace: true }));
    expect(screen.queryByRole("heading", { name: /HMS-someone-elses/ })).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("That asset could not be found for this organisation.");
  });

  it("does not swap an organisation the account cannot see for another one", async () => {
    const onCustomerChange = vi.fn();
    portal({ customerId: "org-of-someone-else", assetId: null, onCustomerChange });
    expect(await screen.findByText("Organisation unavailable")).toBeInTheDocument();
    expect(onCustomerChange).not.toHaveBeenCalled();
    expect(client.listAssets).not.toHaveBeenCalled(); // nothing of anyone else's was asked for
  });

  it("selects the first organisation without adding a history entry when none is chosen", async () => {
    const onCustomerChange = vi.fn();
    portal({ customerId: null, assetId: null, onCustomerChange });
    await waitFor(() => expect(onCustomerChange).toHaveBeenCalledWith("org-1", { replace: true }));
  });
});
