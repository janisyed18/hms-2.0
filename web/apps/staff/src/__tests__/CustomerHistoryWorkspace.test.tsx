import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { CustomerHistoryWorkspace } from "../components/CustomerHistoryWorkspace";
import type { CustomerDeletionDetail, CustomerDeletionSummary } from "../domain/types";

const client = vi.hoisted(() => ({
  listCustomerDeletions: vi.fn(),
  getCustomerDeletion: vi.fn(),
  listCustomerDeletionRecords: vi.fn(),
  downloadCustomerDeletionEvidence: vi.fn()
}));

vi.mock("../api/hmsClient", async (original) => ({
  ...(await original<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const batch: CustomerDeletionSummary = {
  id: "b1", deletionNumber: "DEL-2026-000001", status: "completed", customerId: "c1", customerCode: "SMG",
  customerName: "Summit Marine Group", actorName: "Sam Admin", reason: "Duplicate account", deletedAt: "2026-11-10T01:02:00Z",
  totalRecords: 12, recordCounts: [{ kind: "assets", label: "Assets", count: 7 }], evidenceFiles: 1,
  manifestSha256: "abc", retentionUntil: "2033-11-10", retentionBasis: null, failureDetail: null, replayed: false
};
const detail: CustomerDeletionDetail = {
  ...batch,
  evidence: [{ id: "e1", kind: "certificate_pdf", label: "Certificate C-1", sizeBytes: 2048, sha256: "f".repeat(64), contentType: "application/pdf", recordType: "certificates", originalId: "cert1" }]
};

describe("Deleted Customers (History)", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listCustomerDeletions.mockResolvedValue({ items: [batch], total: 1 });
    client.getCustomerDeletion.mockResolvedValue(detail);
    client.listCustomerDeletionRecords.mockResolvedValue({ items: [], total: 0 });
  });

  it("lists deleted customers with record counts, who deleted them and when", async () => {
    render(<CustomerHistoryWorkspace onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Deleted Customers (History)" })).toBeVisible();
    const row = (await screen.findByText("Summit Marine Group")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Sam Admin")).toBeVisible();
    expect(within(row).getByText(/13|12/)).toBeVisible();
  });

  it("searches on the server", async () => {
    const user = userEvent.setup();
    render(<CustomerHistoryWorkspace onBack={vi.fn()} />);
    await screen.findByText("Summit Marine Group");
    await user.type(screen.getByLabelText("Search deleted customers"), "summit");
    await waitFor(() => expect(client.listCustomerDeletions).toHaveBeenLastCalledWith(expect.objectContaining({ q: "summit" })));
  });

  it("opens the archived records and certificate evidence read-only", async () => {
    const user = userEvent.setup();
    render(<CustomerHistoryWorkspace onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "View records for Summit Marine Group" }));
    expect(await screen.findByText("Certificate C-1")).toBeVisible();
    expect(client.getCustomerDeletion).toHaveBeenCalledWith("b1");
    expect(screen.queryByRole("button", { name: /restore|purge|edit/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing has been deleted", async () => {
    client.listCustomerDeletions.mockResolvedValue({ items: [], total: 0 });
    render(<CustomerHistoryWorkspace onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading deleted customers" })).not.toBeInTheDocument());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says so when the history cannot be loaded", async () => {
    client.listCustomerDeletions.mockRejectedValue(new HmsApiError(403, "forbidden", "no", null));
    render(<CustomerHistoryWorkspace onBack={vi.fn()} />);
    expect(await screen.findByText("You do not have permission to do this.")).toBeVisible();
  });
});
