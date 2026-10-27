import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import type { AssetRecord, AssetWorkflow, StaffSession } from "../domain/types";

const empty = { total: 0, limit: 50, offset: 0, etag: null, nextAfter: null, items: [] };
const client = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () =>
    new Proxy({}, { get: (_target, name: string) => client.overrides[name] ?? (async () => ({ ...empty, unreadTotal: 0 })) })
}));
vi.mock("../components/InspectionsWorkspace", () => ({
  InspectionsWorkspace: ({ routeInspectionId }: { routeInspectionId?: string | null }) => <p>Inspection open: {routeInspectionId ?? "none"}</p>
}));
vi.mock("../components/CertificatesWorkspace", () => ({ CertificatesWorkspace: () => <p>Certificates page</p> }));
vi.mock("../components/SchedulingWorkspace", () => ({ SchedulingWorkspace: () => <p>Scheduling page</p> }));

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const asset = {
  id: "a1", assetNumber: "HMS-1", assetName: "Main Pump Hose", customerSerialNo: "SN", purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "e", lengthM: null,
  customer: { id: "c1", code: "C", name: "Orica" }, product: { id: "p1", code: "P", name: "Hose", category: "Hose" },
  location: { id: "l1", name: "Kooragang", address1: null, address2: null, city: null, state: null, country: null },
  aEnd: blankEnd, bEnd: blankEnd, inspectionHistory: [], certificateHistory: [], pressureRating: null
} as unknown as AssetRecord;
const wf = (over: Partial<AssetWorkflow> = {}): AssetWorkflow => ({
  status: "AWAITING_REVIEW", label: "Inspection submitted — awaiting approval", detail: "Waiting for a reviewer.", attention: false,
  related: { bookingId: null, appointmentId: null, inspectionId: "insp-9", certificateId: null },
  context: { scheduledAt: null, dueAt: null, certificateNumber: null },
  nextAction: { code: "REVIEW_INSPECTION", label: "Review inspection", targetType: "INSPECTION", targetId: "insp-9", inspectionId: null },
  ...over
});
const session = (roles: StaffSession["roles"]): StaffSession => ({ userId: "u", displayName: "Rae Reviewer", roles, permissions: [], customerIds: [], authMode: "dev" });
// The first render of a lazily loaded workspace can take longer than a findBy's default second on a loaded machine.
const SLOW = { timeout: 5000 };
const open = (url: string) => window.history.replaceState(null, "", url);

beforeEach(() => {
  client.overrides = {
    listAssets: async () => ({ ...empty, total: 1, items: [asset] }),
    getAsset: async () => asset,
    getAssetWorkflow: async () => wf(),
    getAssetConfigurationOptions: async () => ({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] })
  };
  open("/?view=assets&asset=a1");
});

describe("the asset workflow card inside the asset detail", () => {
  it("fetches the workflow when an asset is opened from a link, and renders the card", async () => {
    const getAssetWorkflow = vi.fn(async () => wf());
    client.overrides.getAssetWorkflow = getAssetWorkflow;
    render(<App initialSession={session(["REVIEWER"])} />);
    const detail = await screen.findByRole("complementary", { name: "Asset detail" }, SLOW);
    expect(await within(detail).findByText("Inspection submitted — awaiting approval")).toBeInTheDocument();
    expect(getAssetWorkflow).toHaveBeenCalledWith("a1");
    // The card sits between the title and the profile.
    const html = detail.innerHTML;
    expect(html.indexOf("Main Pump Hose")).toBeLessThan(html.indexOf("Workflow"));
    expect(html.indexOf("Workflow")).toBeLessThan(html.indexOf("Asset profile"));
  });

  it("an inspection action lands on the exact canonical inspection link", async () => {
    render(<App initialSession={session(["REVIEWER"])} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Review inspection" }, SLOW));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/?view=inspections&inspection=insp-9"));
    expect(await screen.findByText("Inspection open: insp-9", undefined, SLOW)).toBeInTheDocument();
  });

  it("a rework action lands on the exact canonical inspection link", async () => {
    client.overrides.getAssetWorkflow = async () =>
      wf({
        status: "CHANGES_REQUIRED",
        label: "Inspection changes required",
        attention: true,
        nextAction: { code: "REWORK_INSPECTION", label: "Rework inspection", targetType: "INSPECTION", targetId: "insp-9", inspectionId: null }
      });
    render(<App initialSession={session(["REVIEWER"])} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Rework inspection" }, SLOW));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/?view=inspections&inspection=insp-9"));
    expect(await screen.findByText("Inspection open: insp-9", undefined, SLOW)).toBeInTheDocument();
  });

  it("changes required with no action offered (server withheld it) shows the status and no button", async () => {
    client.overrides.getAssetWorkflow = async () =>
      wf({ status: "CHANGES_REQUIRED", label: "Inspection changes required", attention: true, nextAction: null });
    render(<App initialSession={session(["REVIEWER"])} />);
    await screen.findByText("Inspection changes required", undefined, SLOW);
    expect(screen.queryByRole("button", { name: "Rework inspection" })).toBeNull();
  });

  it("a certificate action goes to Certificates", async () => {
    client.overrides.getAssetWorkflow = async () =>
      wf({
        status: "READY_FOR_CERTIFICATE",
        label: "Ready for certificate",
        nextAction: { code: "ISSUE_CERTIFICATE", label: "Issue certificate", targetType: "CERTIFICATES", targetId: null, inspectionId: "insp-9" }
      });
    render(<App initialSession={session(["REVIEWER"])} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Issue certificate" }, SLOW));
    await waitFor(() => expect(window.location.search).toBe("?view=certificates"));
    expect(await screen.findByText("Certificates page", undefined, SLOW)).toBeInTheDocument();
  });

  it("an action to a workspace this account does not have is not offered", async () => {
    client.overrides.getAssetWorkflow = async () =>
      wf({
        status: "OVERDUE",
        label: "Inspection overdue",
        attention: true,
        nextAction: { code: "BOOK_INSPECTION", label: "Book inspection", targetType: "SCHEDULING", targetId: null, inspectionId: null }
      });
    render(<App initialSession={session(["ASSEMBLY"])} />); // assembly has no Scheduling workspace
    await screen.findByText("Inspection overdue", undefined, SLOW);
    expect(screen.queryByRole("button", { name: "Book inspection" })).toBeNull();
  });

  it("editing the asset is done in place and needs the write permission", async () => {
    client.overrides.getAssetWorkflow = async () =>
      wf({
        status: "ASSET_DRAFT",
        label: "Asset setup incomplete",
        attention: true,
        nextAction: { code: "EDIT_ASSET", label: "Complete asset setup", targetType: "ASSET", targetId: "a1", inspectionId: null }
      });
    const first = render(<App initialSession={session(["ASSEMBLY"])} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Complete asset setup" }, SLOW));
    expect(await screen.findByRole("heading", { name: "Edit Asset" }, SLOW)).toBeInTheDocument();
    first.unmount();

    open("/?view=assets&asset=a1");
    render(<App initialSession={session(["REVIEWER"])} />); // reviewers cannot write assets
    await screen.findByText("Asset setup incomplete", undefined, SLOW);
    expect(screen.queryByRole("button", { name: "Complete asset setup" })).toBeNull();
  });

  it("keeps the asset usable when the workflow cannot be loaded, and Retry recovers", async () => {
    let calls = 0;
    client.overrides.getAssetWorkflow = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return wf();
    };
    render(<App initialSession={session(["REVIEWER"])} />);
    const detail = await screen.findByRole("complementary", { name: "Asset detail" }, SLOW);
    const alert = await within(detail).findByRole("alert");
    expect(alert).toHaveTextContent("Workflow status unavailable");
    expect(within(detail).getByText("Asset profile")).toBeInTheDocument(); // the rest still works
    expect(within(detail).getByRole("button", { name: "Back to list" })).toBeEnabled();
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(detail).findByText("Inspection submitted — awaiting approval")).toBeInTheDocument();
  });
});
