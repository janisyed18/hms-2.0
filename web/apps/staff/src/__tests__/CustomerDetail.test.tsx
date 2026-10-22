import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerDetail } from "../components/CustomerDetail";
import type { AssetRecord, CustomerRecord } from "../domain/types";

const listAssets = vi.hoisted(() => vi.fn());

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => ({ listAssets })
}));

const location = {
  id: "location-west",
  name: "Norwest",
  address1: "1 Innovation Drive",
  address2: null,
  city: "Bella Vista",
  state: "NSW",
  country: "Australia",
  siteContactName: "Faria Javed",
  siteContactMobile: "+61 412 275 772",
  siteContactEmail: "faria@example.test",
  ppeRequirements: ["High Vis", "Safety Boots"],
  additionalRequirements: ["2-way radio"]
};

const asset: AssetRecord = {
  id: "asset-west-1",
  assetNumber: "HMS-798BBD74CE",
  assetName: null,
  customerSerialNo: null,
  purchaseOrderNumber: null,
  tag: null,
  lifecycleStatus: "IN_SERVICE",
  manufactureDate: null,
  installationDate: null,
  graveDate: null,
  nextRetestDueAt: null,
  condemnedAt: null,
  lengthM: null,
  notes: null,
  description: null,
  customer: { id: "customer-1", code: "KET", name: "KetcommIT" },
  product: { id: "product-1", code: "HOSE", name: "Hose", category: "Composite" },
  location,
  retestSchedule: null,
  aEnd: { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null },
  bEnd: { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null },
  inspectionHistory: [],
  certificateHistory: []
};

const customer: CustomerRecord = {
  id: "customer-1",
  code: "KET",
  name: "KetcommIT",
  notes: null,
  retestEnabled: true,
  defaultRetestMonths: 12,
  locations: [location],
  contacts: [],
  status: "Active",
  riskLevel: "Low",
  industry: "",
  paymentTerms: "",
  contractStart: "",
  contractEnd: "",
  lastActivity: "",
  metrics: {
    assetCount: 1,
    inServiceCount: 1,
    inspectionDueCount: 0,
    inspectionDueLabel: "Current",
    certificateValidPercent: 100,
    certificateStatusLabel: "Valid",
    recentInspections: [],
    activity: []
  }
};

describe("CustomerDetail locations", () => {
  beforeEach(() => {
    listAssets.mockResolvedValue({ total: 1, items: [asset] });
  });

  it("opens a recorded address in Google Maps and routes an assigned asset to its detail", async () => {
    const user = userEvent.setup();
    const onAssetOpen = vi.fn();
    const onClose = vi.fn();

    render(
      <CustomerDetail
        activeTab="Locations"
        canWrite={false}
        customer={customer}
        onAssetOpen={onAssetOpen}
        onClose={onClose}
        onEdit={vi.fn()}
        onTabChange={vi.fn()}
      />
    );

    const mapsLink = await screen.findByRole("link", { name: "Open Norwest in Google Maps" });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=Norwest%2C%201%20Innovation%20Drive%2C%20Bella%20Vista%2C%20NSW%2C%20Australia"
    );
    expect(mapsLink).toHaveAttribute("target", "_blank");
    expect(mapsLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("PPE requirements")).toBeVisible();
    expect(screen.getByText("High Vis")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Overview" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open asset HMS-798BBD74CE" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAssetOpen).toHaveBeenCalledWith("asset-west-1");
  });

  it("agrees with the customer card and shows unavailable metrics as a dash, not zero", async () => {
    listAssets.mockResolvedValue({ total: 2, items: [asset, { ...asset, id: "asset-west-2", assetNumber: "HMS-2" }] });
    render(
      <CustomerDetail
        activeTab="Locations"
        canWrite={false}
        customer={{
          ...customer,
          metrics: {
            ...customer.metrics,
            assetCount: 2,
            inspectionDueCount: null,
            certificateValidPercent: null,
            inspectionDueLabel: "Not available",
            certificateStatusLabel: "Not available"
          }
        }}
        onAssetOpen={vi.fn()}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onTabChange={vi.fn()}
      />
    );

    const summary = screen.getByLabelText("Customer asset summary");
    await vi.waitFor(() => expect(summary).toHaveTextContent(/Assets2Assigned/));
    const coverage = screen.getByText("Certificate coverage").closest("article") as HTMLElement;
    expect(coverage).toHaveTextContent("—");
    expect(coverage).toHaveTextContent("Not available");
    expect(coverage).not.toHaveTextContent("0%");
    const attention = screen.getByText("Needs attention").closest("article") as HTMLElement;
    expect(attention).toHaveTextContent("—");
    expect(attention).toHaveTextContent("Not available");
    expect(attention).not.toHaveTextContent("Needs attention0");
  });
});
