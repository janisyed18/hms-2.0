import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAssetsWorkspace } from "../hooks/useAssetsWorkspace";
import type { AssetFormValues, AssetRecord } from "../domain/types";

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const asset = (id: string): AssetRecord => ({
  id, assetNumber: `HMS-${id}`, assetName: `Hose ${id}`, customerSerialNo: "SN", purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "a1", lengthM: null,
  customer: { id: "cust-1", code: "ORIC", name: "Orica" },
  product: { id: "prod-1", code: "P", name: "Hydraulic Hose", category: "Hose" },
  location: null, aEnd: blankEnd, bEnd: blankEnd, inspectionHistory: [], certificateHistory: [], pressureRating: null
} as unknown as AssetRecord);

let finishSave: (record: AssetRecord) => void = () => undefined;
const client = {
  listAssets: vi.fn().mockResolvedValue({ items: [asset("1"), asset("2")] }),
  listCustomers: vi.fn().mockResolvedValue({ items: [] }),
  listProducts: vi.fn().mockResolvedValue({ items: [] }),
  getAssetConfigurationOptions: vi.fn().mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] }),
  updateAsset: vi.fn(() => new Promise<AssetRecord>((resolve) => { finishSave = resolve; }))
};
vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

describe("asset form save sessions", () => {
  it("lets a slow save for asset 1 land in the register without closing the form now showing asset 2", async () => {
    const { result } = renderHook(() => useAssetsWorkspace());
    await waitFor(() => expect(result.current.assets).toHaveLength(2));
    act(() => result.current.openEdit(result.current.assets[0]));
    let saving: Promise<void> = Promise.resolve();
    act(() => { saving = result.current.saveAsset({} as AssetFormValues); });
    act(() => result.current.openEdit(result.current.assets[1]));
    await act(async () => { finishSave({ ...asset("1"), assetName: "Saved one" }); await saving; });
    expect(result.current.assets.find((item) => item.id === "1")?.assetName).toBe("Saved one");
    expect(result.current.isFormOpen).toBe(true);
    expect(result.current.formAsset?.id).toBe("2");
  });

  it("closes the form when the save that finishes is the one it is showing", async () => {
    const { result } = renderHook(() => useAssetsWorkspace());
    await waitFor(() => expect(result.current.assets).toHaveLength(2));
    act(() => result.current.openEdit(result.current.assets[0]));
    let saving: Promise<void> = Promise.resolve();
    act(() => { saving = result.current.saveAsset({} as AssetFormValues); });
    await act(async () => { finishSave(asset("1")); await saving; });
    expect(result.current.isFormOpen).toBe(false);
  });
});
