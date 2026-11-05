import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetForm } from "../components/AssetForm";
import type { AssetRecord } from "../domain/types";
import { lookups, resetLookups } from "../test/lookupClient";

vi.mock("../api/hmsClient", async (original) => {
  const { lookupClient } = await import("../test/lookupClient");
  return { ...(await original<typeof import("../api/hmsClient")>()), createHmsClient: () => lookupClient };
});

const customer = { id: "c1", code: "AGT1", name: "Vopak" };
const product = { id: "p1", code: "HOSE", name: "Hose", category: "Hose" };
const noEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const options = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };

// Installed 2026-01-15, so the one-year date would be 2027-01-15; a retest was later approved for 2027-04-15.
const asset = {
  id: "1", assetNumber: "A-1", assetName: "Hose One", customerSerialNo: "SN-1", purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "ACTIVE", manufactureDate: null, installationDate: "2026-01-15", graveDate: null, nextRetestDueAt: "2027-04-15",
  condemnedAt: null, lengthM: null, notes: null, description: null, customer, product,
  location: { id: "l1", name: "Dock" } as AssetRecord["location"], retestSchedule: null, aEnd: noEnd, bEnd: noEnd,
  inspectionHistory: [], certificateHistory: [], etag: "e"
} as AssetRecord;

beforeEach(() => {
  resetLookups();
  lookups.customers = [customer];
  lookups.products = [product];
  lookups.locations = { c1: [{ id: "l1", name: "Dock" }] };
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

const renderForm = () => render(<AssetForm asset={asset} configurationOptions={options} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

describe("Next Inspection Date on an existing asset", () => {
  it("keeps a date that was moved after installation until the installation date itself is edited", async () => {
    renderForm();
    const next = await screen.findByLabelText("Next Inspection Date");
    await waitFor(() => expect(screen.getByLabelText("Installation Date")).toHaveValue("2026-01-15"));
    expect(next).toHaveValue("2027-04-15");

    fireEvent.change(screen.getByLabelText("Installation Date"), { target: { value: "2026-03-01" } });
    await waitFor(() => expect(next).toHaveValue("2027-03-01"));
  });
});
