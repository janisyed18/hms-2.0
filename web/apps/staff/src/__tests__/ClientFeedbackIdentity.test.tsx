import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetIdentity } from "../components/AssetIdentity";
import type { CustomerRecord } from "../domain/types";
import { useCustomerWorkspace } from "../hooks/useCustomerWorkspace";
import { assetDisplayName, assetHasDistinctName, initialsOf } from "../utils/identity";

const listCustomers = vi.hoisted(() => vi.fn());

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => ({ listCustomers })
}));

const customer = (id: string, name: string, assetCount: number) => ({
  id, code: id.toUpperCase(), name, notes: null, locations: [], contacts: [], status: "Active", riskLevel: "Low",
  metrics: { assetCount, inServiceCount: assetCount }
}) as unknown as CustomerRecord;

describe("initials", () => {
  it.each([
    ["Xero Stock Private Limited", "XS"],
    ["XERO PTY Ltd", "XP"],
    ["DEV CERTIFICATE 123 TEST", "DC"],
    ["customer 1", "C1"],
    ["Jani Syed", "JS"],
    ["Momentum", "M"],
    ["  Xero   Stock ", "XS"],
    ["\tXero\n Stock", "XS"],
    ["", ""],
    ["   ", ""],
    [null, ""],
    [undefined, ""]
  ])("%j gives %j", (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it("does not split an astral character in half", () => {
    expect(initialsOf("𝒜lpha Beta")).toBe("𝒜B");
  });
});

describe("asset identity", () => {
  it("puts the name first and keeps the number as the secondary identifier", () => {
    render(<AssetIdentity asset={{ assetName: "Main Transfer Hose", assetNumber: "HMS-373CEBA88" }} />);
    expect(screen.getByText("Main Transfer Hose")).toBeInTheDocument();
    expect(screen.getByText("Asset #HMS-373CEBA88")).toBeInTheDocument();
    // Read in order a screen reader gets: name, then "Asset #number".
    expect(document.body.textContent).toBe("Main Transfer HoseAsset #HMS-373CEBA88");
  });

  it.each([null, undefined, "", "   "])("falls back to the number as the one primary label when the name is %j", (name) => {
    render(<AssetIdentity asset={{ assetName: name, assetNumber: "HMS-1" }} />);
    expect(screen.getByText("HMS-1")).toBeInTheDocument();
    expect(screen.queryByText(/Asset #/)).toBeNull();
  });

  it("shows the number once when the name is just the number", () => {
    render(<AssetIdentity asset={{ assetName: "HMS-9", assetNumber: "HMS-9" }} />);
    expect(screen.getAllByText("HMS-9")).toHaveLength(1);
  });

  it("keeps the number on assets that share a name, so they can be told apart", () => {
    render(<>
      <AssetIdentity asset={{ assetName: "Transfer Hose", assetNumber: "HMS-1" }} />
      <AssetIdentity asset={{ assetName: "Transfer Hose", assetNumber: "HMS-2" }} />
    </>);
    expect(screen.getAllByText("Transfer Hose")).toHaveLength(2);
    expect(screen.getByText("Asset #HMS-1")).toBeInTheDocument();
    expect(screen.getByText("Asset #HMS-2")).toBeInTheDocument();
  });

  it("exposes a long name in full for hover and assistive technology", () => {
    const long = "High Pressure Chemical Transfer Hose Assembly 04";
    render(<AssetIdentity asset={{ assetName: long, assetNumber: "HMS-4" }} />);
    expect(screen.getByText(long)).toHaveAttribute("title", long);
  });

  it("helpers agree", () => {
    expect(assetDisplayName({ assetName: " Pump ", assetNumber: "HMS-1" })).toBe("Pump");
    expect(assetDisplayName({ assetName: " ", assetNumber: " HMS-1 " })).toBe("HMS-1");
    expect(assetHasDistinctName({ assetName: "Pump", assetNumber: "HMS-1" })).toBe(true);
    expect(assetHasDistinctName({ assetName: "HMS-1", assetNumber: "HMS-1" })).toBe(false);
    expect(assetHasDistinctName({ assetName: null, assetNumber: "HMS-1" })).toBe(false);
  });
});

describe("customer asset counts follow the server, not the first read", () => {
  beforeEach(() => listCustomers.mockReset());

  it("shows the new count when Customers is entered after an asset was created elsewhere", async () => {
    listCustomers.mockResolvedValueOnce({ total: 1, items: [customer("c1", "Xero Pty Ltd", 0)] });
    const { result, rerender } = renderHook(({ active }) => useCustomerWorkspace({ active }), { initialProps: { active: false } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.customers[0].metrics.assetCount).toBe(0);

    // An asset is created in the Assets workspace; nothing here is told. Then Customers is opened.
    listCustomers.mockResolvedValueOnce({ total: 1, items: [customer("c1", "Xero Pty Ltd", 1)] });
    rerender({ active: true });
    await waitFor(() => expect(result.current.customers[0].metrics.assetCount).toBe(1));
    expect(result.current.customers[0].metrics.inServiceCount).toBe(1);
  });

  it("re-reads on every entry, and not on the first mount where the load already did", async () => {
    listCustomers.mockResolvedValue({ total: 1, items: [customer("c1", "Xero", 2)] });
    const { result, rerender } = renderHook(({ active }) => useCustomerWorkspace({ active }), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listCustomers).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    rerender({ active: true });
    await waitFor(() => expect(listCustomers).toHaveBeenCalledTimes(2));
    rerender({ active: true });
    expect(listCustomers).toHaveBeenCalledTimes(2);
  });

  it("counts each customer for itself, leaves other customers alone, and keeps one read by id", async () => {
    listCustomers.mockResolvedValueOnce({ total: 2, items: [customer("c1", "Xero", 0), customer("c2", "Orica", 3)] });
    const { result } = renderHook(() => useCustomerWorkspace({ active: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.addCustomer(customer("c9", "Beyond the page", 4)));

    listCustomers.mockResolvedValueOnce({ total: 2, items: [customer("c1", "Xero", 1), customer("c2", "Orica", 3)] });
    act(() => result.current.refreshMetrics());
    await waitFor(() => expect(result.current.customers.find((item) => item.id === "c1")?.metrics.assetCount).toBe(1));
    expect(result.current.customers.find((item) => item.id === "c2")?.metrics.assetCount).toBe(3);
    expect(result.current.customers.find((item) => item.id === "c9")?.metrics.assetCount).toBe(4);
  });

  it("keeps what was shown when the re-read fails", async () => {
    listCustomers.mockResolvedValueOnce({ total: 1, items: [customer("c1", "Xero", 2)] });
    const { result } = renderHook(() => useCustomerWorkspace({ active: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    listCustomers.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.refreshMetrics());
    await waitFor(() => expect(listCustomers).toHaveBeenCalledTimes(2));
    expect(result.current.customers[0].metrics.assetCount).toBe(2);
    expect(result.current.error).toBeNull();
  });
});
