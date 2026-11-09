import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { CustomerDeleteDialog } from "../components/CustomerDeleteDialog";
import type { CustomerDeletionCheck, CustomerRecord } from "../domain/types";
import { customerLabel } from "../utils/identity";
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

const LABEL = customerLabel({ code: "SMG", name: "Summit Marine Group" });
const clear: CustomerDeletionCheck = { canDelete: true, archived: false, blockers: [] };
const blocked: CustomerDeletionCheck = {
  canDelete: false,
  archived: false,
  blockers: [
    { kind: "assets", label: "assets", count: 7, records: [{ id: "a1", name: "A-001" }, { id: "a2", name: "A-002" }] },
    { kind: "inspection_bookings", label: "inspection bookings", count: 2, records: [] }
  ]
};

/** The customer workspace and its delete dialog wired the way App wires them. */
function Harness({ target, onOpenLinked = vi.fn(() => true) }: { target: CustomerRecord; onOpenLinked?: (kind: string, id: string | null) => boolean }) {
  const workspace = useCustomerWorkspace();
  return (
    <>
      <button onClick={() => workspace.requestLifecycle("delete", target)} type="button">Delete customer</button>
      <p data-testid="notice">{workspace.notice ? `${workspace.notice.title}: ${workspace.notice.message}` : ""}</p>
      <CustomerDeleteDialog
        onArchive={() => void workspace.archiveInsteadOfDeleting()}
        onCancel={workspace.cancelDeletion}
        onConfirm={() => void workspace.confirmDeletion()}
        onOpenLinked={onOpenLinked}
        onRetry={workspace.retryDeletionCheck}
        state={workspace.deletion}
      />
    </>
  );
}

async function openDialog(target = customer()) {
  const user = userEvent.setup();
  render(<Harness target={target} />);
  await user.click(screen.getByRole("button", { name: "Delete customer" }));
  return user;
}
const dialog = () => screen.getByRole("alertdialog");

describe("Delete customer", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listCustomers.mockResolvedValue({ total: 1, etag: null, items: [customer()] });
    client.getCustomerSummary.mockResolvedValue(null);
  });

  it("deletes an unused customer in one confirmed step, without archiving it first", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockResolvedValue(undefined);
    const user = await openDialog();

    expect(await within(dialog()).findByRole("heading", { name: "Delete customer?" })).toBeVisible();
    expect(within(dialog()).getByText(/can be deleted permanently\. This cannot be undone/)).toBeVisible();
    expect(client.deleteCustomer).not.toHaveBeenCalled();
    expect(client.archiveCustomer).not.toHaveBeenCalled();

    await user.click(within(dialog()).getByRole("button", { name: "Delete customer" }));
    // The version it was read at travels with the delete, so someone else's edit is not overwritten.
    expect(client.deleteCustomer).toHaveBeenCalledWith("c1", '"3"');
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("notice")).toHaveTextContent(`Customer deleted: ${LABEL} was permanently deleted.`);
    expect(client.archiveCustomer).not.toHaveBeenCalled();
  });

  it("shows what blocks deletion, with counts and names, and offers Archive instead", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(blocked);
    const onOpenLinked = vi.fn(() => true);
    const user = userEvent.setup();
    render(<Harness onOpenLinked={onOpenLinked} target={customer()} />);
    await user.click(screen.getByRole("button", { name: "Delete customer" }));

    expect(await within(dialog()).findByRole("heading", { name: "Delete customer?" })).toBeVisible();
    const list = within(dialog()).getByRole("list", { name: "Linked records" });
    expect(within(list).getByText("assets")).toBeVisible();
    expect(within(list).getByText("7")).toBeVisible();
    expect(within(list).getByText("and 5 more")).toBeVisible();
    expect(within(list).getByText("inspection bookings")).toBeVisible();
    expect(within(dialog()).getByText(/This customer has linked records\. Archive the customer to preserve its history/)).toBeVisible();
    expect(within(dialog()).getByText(/Permanent deletion is available only when no linked records remain/)).toBeVisible();
    expect(within(dialog()).queryByRole("button", { name: "Delete customer" })).not.toBeInTheDocument();

    // A named asset links straight to it.
    await user.click(within(list).getByRole("button", { name: "A-001" }));
    expect(onOpenLinked).toHaveBeenCalledWith("asset", "a1");
    // The whole row opens that kind of record, and a kind with no page is not a button.
    await user.click(within(list).getByRole("button", { name: /assets, 7/ }));
    expect(onOpenLinked).toHaveBeenCalledWith("assets", null);
    await user.click(within(list).getByRole("button", { name: /inspection bookings, 2/ }));
    expect(onOpenLinked).toHaveBeenCalledWith("inspection_bookings", null);
  });

  it("archives instead when asked, and says it was archived rather than deleted", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(blocked);
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

  it("for an already archived customer explains that it stays archived, and offers no second Archive", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue({ ...blocked, archived: true });
    await openDialog(customer({ status: "Archived", archivedAt: "2026-11-01T00:00:00Z" }));
    expect(await within(dialog()).findByText(/already archived/)).toBeVisible();
    expect(within(dialog()).queryByRole("button", { name: "Archive customer" })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("when a record appeared after the check, the refused delete shows the current blockers instead of a bare error", async () => {
    client.getCustomerDeletionCheck.mockResolvedValueOnce(clear).mockResolvedValueOnce(blocked);
    client.deleteCustomer.mockRejectedValue(new HmsApiError(409, "conflict", "This customer is still used by 7 assets.", null));
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("button", { name: "Delete customer" }));

    expect(await within(dialog()).findByRole("heading", { name: "Delete customer?" })).toBeVisible();
    expect(within(dialog()).getByRole("button", { name: "Archive customer" })).toBeVisible();
  });

  it("keeps the dialog open and says why when the delete is refused for another reason", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockRejectedValue(new HmsApiError(403, "forbidden", "Only a Super Admin can delete records.", null));
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("button", { name: "Delete customer" }));

    expect(await within(dialog()).findByText("You do not have permission to do this.")).toBeVisible();
    expect(within(dialog()).getByRole("button", { name: "Delete customer" })).toBeEnabled();
    expect(screen.getByTestId("notice")).toBeEmptyDOMElement();
  });

  it("a stale version (412) is refused as changed by someone else, not deleted", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(clear);
    client.deleteCustomer.mockRejectedValue(new HmsApiError(412, "precondition", "stale", null));
    const user = await openDialog();
    await user.click(await within(dialog()).findByRole("button", { name: "Delete customer" }));
    expect(await within(dialog()).findByText(/changed by someone else/)).toBeVisible();
    expect(screen.getByTestId("notice")).toBeEmptyDOMElement();
  });

  it("when the check itself fails it says so and can be retried", async () => {
    client.getCustomerDeletionCheck.mockRejectedValueOnce(new HmsApiError(403, "forbidden", "no", null)).mockResolvedValueOnce(clear);
    const user = await openDialog();
    expect(await within(dialog()).findByText("You do not have permission to do this.")).toBeVisible();
    expect(within(dialog()).queryByRole("button", { name: "Delete customer" })).not.toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(await within(dialog()).findByRole("button", { name: "Delete customer" })).toBeVisible();
  });

  it("Cancel and Escape close it without deleting or archiving anything", async () => {
    client.getCustomerDeletionCheck.mockResolvedValue(blocked);
    const user = await openDialog();
    await within(dialog()).findByRole("list", { name: "Linked records" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete customer" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.deleteCustomer).not.toHaveBeenCalled();
    expect(client.archiveCustomer).not.toHaveBeenCalled();
  });
});
