import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionsWorkspace } from "../components/InspectionsWorkspace";
import type { AssetRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  getAsset: vi.fn(),
  listInspectionBookings: vi.fn(),
  listInspections: vi.fn(),
  listAllAssets: vi.fn(),
  listAdminUsers: vi.fn(),
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  listAssets: vi.fn(),
  listInspectionAvailability: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const placed = (id: string, number: string, customer: string, locationId: string, location: string) => ({
  id, assetNumber: number,
  customer: { id: `cust-${customer}`, code: customer, name: customer },
  location: { id: locationId, name: location, schedulingTimezone: "Australia/Perth" }
}) as unknown as AssetRecord;

const assetA = placed("a", "ASSET-A", "Alpha Co", "loc-a", "Alpha Yard");
const assetB = placed("b", "ASSET-B", "Beta Co", "loc-b", "Beta Depot");
const all = [assetA, assetB];

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listInspectionBookings.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.listInspections.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.listAdminUsers.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.listAllAssets.mockResolvedValue({ total: 0, items: [] });
  client.listCustomers.mockResolvedValue({ total: 0, items: [] });
  client.getCustomer.mockImplementation(async (id: string) => ({ id, locations: all.filter((item) => item.customer.id === id).map((item) => item.location) }));
  client.listInspectionAvailability.mockResolvedValue([]);
  client.listAssets.mockImplementation(async (options: { customerId?: string; locationId?: string }) => {
    const items = all.filter((item) => item.customer.id === options.customerId && item.location?.id === options.locationId);
    return { total: items.length, items };
  });
});

const checked = () => screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)
  .map((box) => (box as HTMLInputElement).labels?.[0]?.textContent ?? "");

describe("booking started from an asset in the address", () => {
  it("opens the form with that asset's customer, location and the asset, then reports it handled when closed", async () => {
    client.getAsset.mockResolvedValue(assetA);
    const handled = vi.fn();
    render(<InspectionsWorkspace bookAssetId="a" canApprove canApproveBookings canBook canWrite onBookAssetHandled={handled} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("Alpha Co"));
    await waitFor(() => expect(checked().join(" ")).toContain("ASSET-A"));
    expect(handled).not.toHaveBeenCalled();
  });

  it("moves to Asset B when the address changes, without reloading, and drops everything from Asset A", async () => {
    client.getAsset.mockImplementation(async (id: string) => all.find((item) => item.id === id));
    const view = render(<InspectionsWorkspace bookAssetId="a" canApprove canApproveBookings canBook canWrite />);
    await waitFor(() => expect(checked().join(" ")).toContain("ASSET-A"));
    view.rerender(<InspectionsWorkspace bookAssetId="b" canApprove canApproveBookings canBook canWrite />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("Beta Co"));
    await waitFor(() => expect(checked().join(" ")).toContain("ASSET-B"));
    expect(checked().join(" ")).not.toContain("ASSET-A");
    expect(screen.getByLabelText("Booking location")).toHaveTextContent("Beta Depot");
  });

  it("ignores a slow answer for Asset A that arrives after the address moved to Asset B", async () => {
    const slowA = deferred<AssetRecord>();
    client.getAsset.mockImplementation((id: string) => (id === "a" ? slowA.promise : Promise.resolve(assetB)));
    const view = render(<InspectionsWorkspace bookAssetId="a" canApprove canApproveBookings canBook canWrite />);
    view.rerender(<InspectionsWorkspace bookAssetId="b" canApprove canApproveBookings canBook canWrite />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("Beta Co"));
    slowA.resolve(assetA);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("Beta Co");
    await waitFor(() => expect(checked().join(" ")).toContain("ASSET-B"));
    expect(checked().join(" ")).not.toContain("ASSET-A");
  });

  it("does not open a booking, or even load the asset, for someone who may not book", async () => {
    const handled = vi.fn();
    render(<InspectionsWorkspace bookAssetId="a" canApprove canApproveBookings canBook={false} canWrite onBookAssetHandled={handled} />);
    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(client.getAsset).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Booking customer" })).toBeNull();
  });

  it("opens a blank form with the reason when the asset cannot be loaded", async () => {
    client.getAsset.mockRejectedValue(new Error("boom"));
    render(<InspectionsWorkspace bookAssetId="nope" canApprove canApproveBookings canBook canWrite />);
    expect(await screen.findByText(/Asset not loaded/)).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Booking customer" })).toHaveValue("");
  });
});
