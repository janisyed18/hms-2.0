import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { CustomerRemovalDialog } from "../components/CustomerRemovalDialog";
import type { CustomerDeletionCheck, CustomerDeletionSummary, CustomerRecord } from "../domain/types";
import { useCustomerWorkspace } from "../hooks/useCustomerWorkspace";

const client = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  getCustomerSummary: vi.fn(),
  getCustomerDeletionCheck: vi.fn(),
  deleteCustomer: vi.fn(),
  archiveCustomer: vi.fn()
}));

vi.mock("../api/hmsClient", async (original) => ({
  ...(await original<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

function customer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: "c1", code: "SMG", name: "Summit Marine Group", etag: '"3"', notes: null, retestEnabled: true, defaultRetestMonths: 12,
    locations: [], contacts: [], status: "Active", archivedAt: null,
    metrics: { assetCount: 0, inServiceCount: 0, inspectionDueCount: 0, inspectionDueLabel: "", certificateValidPercent: 0, certificateStatusLabel: "", recentInspections: [], activity: [] },
    ...overrides
  };
}

const clear: CustomerDeletionCheck = {
  canDelete: true, archived: false, blockers: [], customerName: "Summit Marine Group", customerCode: "SMG",
  totalRecords: 12, evidenceFiles: 2, fingerprint: "fp-1", retentionYears: 7,
  items: [{ kind: "assets", label: "Assets", count: 7 }, { kind: "certificates", label: "Certificates", count: 5 }]
};
const blocked: CustomerDeletionCheck = {
  ...clear,
  canDelete: false,
  blockers: [{ kind: "inspection_bookings", label: "inspection bookings", count: 2, records: [] }]
};
const summary: CustomerDeletionSummary = {
  id: "batch-1", deletionNumber: "DEL-2026-000001", status: "completed", customerId: "c1", customerCode: "SMG",
  customerName: "Summit Marine Group", actorName: "Sam Admin", reason: null, deletedAt: "2026-11-10T01:02:00Z",
  totalRecords: 12, recordCounts: [], evidenceFiles: 2, manifestSha256: "abc", retentionUntil: "2033-11-10", retentionBasis: null, failureDetail: null, replayed: false
};

/** The customer workspace and its removal dialog wired the way App wires them. */
function Harness({ target, onViewHistory = vi.fn() }: { target: CustomerRecord; onViewHistory?: (id: string) => void }) {
  const workspace = useCustomerWorkspace();
  return (
    <>
      <button onClick={() => workspace.requestLifecycle("delete", target)} type="button">Remove customer</button>
      <p data-testid="notice">{workspace.notice ? `${workspace.notice.title}: ${workspace.notice.message}` : ""}</p>
      <CustomerRemovalDialog
        onArchive={() => void workspace.archiveInsteadOfDeleting()}
        onCancel={workspace.cancelDeletion}
        onConfirm={(input) => void workspace.confirmDeletion(input)}
        onRetry={workspace.retryDeletionCheck}
        onViewHistory={onViewHistory}
        state={workspace.deletion}
      />
    </>
  );
}

async function openDialog(target = customer(), onViewHistory?: (id: string) => void) {
  const user = userEvent.setup();
  render(<Harness onViewHistory={onViewHistory} target={target} />);
  await user.click(screen.getByRole("button", { name: "Remove customer" }));
  return user;
}
const dialog = () => screen.getByRole("alertdialog");

async function goToConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(dialog()).findByRole("radio", { name: /Delete Customer and Related Data/ }));
  await user.click(within(dialog()).getByRole("button", { name: /Continue/ }));
  await user.click(await within(dialog()).findByRole("button", { name: /Continue/ }));
}
async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog()).getByLabelText(/Type the customer name/), "Summit Marine Group");
  await user.click(within(dialog()).getByRole("checkbox"));
  await user.click(within(dialog()).getByRole("button", { name: /Delete Customer$/ }));
}

describe("Remove customer", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listCustomers.mockResolvedValue({ total: 1, etag: null, items: [customer()] });
    client.getCustomerSummary.mockResolvedValue(null);
  });

  it("offers Archive as the recommended default and Delete as a separate choice", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    await openDialog();
    expect(await within(dialog()).findByRole("heading", { name: "Remove Customer" })).toBeVisible();
    expect(within(dialog()).getByText("Recommended")).toBeVisible();
    expect(within(dialog()).getByRole("radio", { name: /Archive Customer/ })).toBeChecked();
    expect(client.deleteCustomer).not.toHaveBeenCalled();
  });

  it("archives from the first step without deleting anything", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.archiveCustomer.mockResolvedValue(customer({ status: "Archived", archivedAt: "2026-11-09T00:00:00Z" }));
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("button", { name: "Archive customer" }));
    expect(client.archiveCustomer).toHaveBeenCalledWith("c1");
    expect(client.deleteCustomer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    const notice = screen.getByTestId("notice");
    expect(notice).toHaveTextContent("Customer archived");
    expect(notice).not.toHaveTextContent(/deleted/i);
  });

  it("shows the deletion impact, then requires the typed name and acknowledgement", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    const user = await openDialog();
    await goToConfirm(user).catch(() => undefined);
    // Review step content was passed through; we are on Confirm.
    expect(await within(dialog()).findByRole("heading", { name: "Confirm Deletion" })).toBeVisible();
    const del = within(dialog()).getByRole("button", { name: /Delete Customer$/ });
    expect(del).toBeDisabled();
    await user.type(within(dialog()).getByLabelText(/Type the customer name/), "Summit");
    expect(del).toBeDisabled();
    await user.clear(within(dialog()).getByLabelText(/Type the customer name/));
    await user.type(within(dialog()).getByLabelText(/Type the customer name/), "Summit Marine Group");
    expect(del).toBeDisabled();
    await user.click(within(dialog()).getByRole("checkbox"));
    expect(del).toBeEnabled();
  });

  it("lists the impact on the review step", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("radio", { name: /Delete Customer and Related Data/ }));
    await user.click(within(dialog()).getByRole("button", { name: /Continue/ }));
    const list = await within(dialog()).findByRole("list", { name: "Records to be removed from active HMS" });
    expect(within(list).getByText("Assets")).toBeVisible();
    expect(within(list).getByText("7")).toBeVisible();
    expect(within(dialog()).getByText("Total Records: 12")).toBeVisible();
  });

  it("deletes with the name, fingerprint, version and an idempotency key, then shows the success dialog", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockResolvedValue(summary);
    const onViewHistory = vi.fn();
    const user = await openDialog(customer(), onViewHistory);
    await goToConfirm(user);
    await confirmDelete(user);

    expect(client.deleteCustomer).toHaveBeenCalledWith("c1", expect.objectContaining({
      confirmName: "Summit Marine Group", fingerprint: "fp-1", etag: '"3"', idempotencyKey: expect.any(String)
    }));
    expect(await within(dialog()).findByRole("heading", { name: "Customer Deleted Successfully" })).toBeVisible();
    expect(within(dialog()).getByText("DEL-2026-000001")).toBeVisible();
    expect(within(dialog()).getByText(/Sam Admin/)).toBeVisible();
    expect(within(dialog()).getByText(/13 records/)).toBeVisible();
    await user.click(within(dialog()).getByRole("button", { name: /View in History/ }));
    expect(onViewHistory).toHaveBeenCalledWith("batch-1");
    expect(client.archiveCustomer).not.toHaveBeenCalled();
  });

  it("when linked records outside the customer exist it explains and cannot continue", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(blocked);
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("radio", { name: /Delete Customer and Related Data/ }));
    await user.click(within(dialog()).getByRole("button", { name: /Continue/ }));
    expect(await within(dialog()).findByText(/2 inspection bookings/)).toBeVisible();
    expect(within(dialog()).getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  it("for an already archived customer offers no second Archive", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue({ ...clear, archived: true });
    await openDialog(customer({ status: "Archived", archivedAt: "2026-11-01T00:00:00Z" }));
    expect(await within(dialog()).findByText("Already archived")).toBeVisible();
    expect(within(dialog()).getByRole("radio", { name: /Archive Customer/ })).toBeDisabled();
    expect(within(dialog()).getByRole("radio", { name: /Delete Customer and Related Data/ })).toBeChecked();
  });

  it("a stale version (412) returns to the review with the current impact, and nothing is deleted", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockRejectedValue(new HmsApiError(412, "precondition", "stale", null));
    const user = await openDialog();
    await goToConfirm(user);
    await confirmDelete(user);
    expect(await within(dialog()).findByText(/records changed after you reviewed them/)).toBeVisible();
    expect(client.getCustomerDeletionCheck).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("notice")).toBeEmptyDOMElement();
  });

  it("keeps the dialog open and says nothing was removed when the delete fails", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockRejectedValue(new HmsApiError(403, "forbidden", "Only a Super Admin can delete records.", null));
    const user = await openDialog();
    await goToConfirm(user);
    await confirmDelete(user);
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/Nothing was removed.*You do not have permission to do this\./);
    expect(screen.getByTestId("notice")).toBeEmptyDOMElement();
  });

  it("when the check itself fails it says so and can be retried", async () => {
    client.getCustomerDeletionCheck.mockRejectedValueOnce(new HmsApiError(403, "forbidden", "no", null)).mockResolvedValueOnce(clear);
    const user = await openDialog();
    expect(await within(dialog()).findByText("You do not have permission to do this.")).toBeVisible();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(await within(dialog()).findByRole("button", { name: "Archive customer" })).toBeEnabled();
  });

  it("Cancel and Escape close it without deleting or archiving anything", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    const user = await openDialog();
    await within(dialog()).findByRole("radio", { name: /Archive Customer/ });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove customer" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.deleteCustomer).not.toHaveBeenCalled();
    expect(client.archiveCustomer).not.toHaveBeenCalled();
  });
});
