import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionsWorkspace } from "../components/InspectionsWorkspace";
import { bookingStatusView } from "../components/CustomerBookings";
import { inspectionStatusLabel } from "../utils/inspectionStatus";
import { certificateStatusLabel, inspectionResultLabel, lifecycleStatusLabel, plainWords, retestStatusLabel } from "../utils/statusLabels";

const client = vi.hoisted(() => ({
  listInspections: vi.fn(),
  listAllAssets: vi.fn(),
  listInspectionBookings: vi.fn(),
  listAdminUsers: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  const empty = { total: 0, limit: 50, offset: 0, etag: null, items: [] };
  client.listInspections.mockResolvedValue(empty);
  client.listAllAssets.mockResolvedValue(empty);
  client.listInspectionBookings.mockResolvedValue(empty);
  client.listAdminUsers.mockResolvedValue(empty);
});

describe("one name for each state", () => {
  it("inspection states use the product's words", () => {
    expect(inspectionStatusLabel("SUBMITTED")).toBe("Awaiting review");
    expect(inspectionStatusLabel("REJECTED")).toBe("Changes required");
    expect(inspectionStatusLabel("IN_PROGRESS")).toBe("In progress");
    expect(inspectionStatusLabel("APPROVED")).toBe("Approved");
  });

  it("codes are never shown as they come from the API", () => {
    expect(lifecycleStatusLabel("IN_SERVICE")).toBe("In service");
    expect(retestStatusLabel("OVERDUE")).toBe("Overdue");
    expect(certificateStatusLabel("DRAFT")).toBe("Pending issue");
    expect(inspectionResultLabel(null)).toBe("Result pending");
    expect(inspectionResultLabel("PASS")).toBe("Pass");
    expect(plainWords("NEW_ASSET")).toBe("New asset");
    // A code nobody has named yet is still readable, not shouted.
    expect(lifecycleStatusLabel("ON_HOLD")).toBe("On hold");
  });

  it("a booking needing approval is 'Awaiting approval' to the customer, as it is to staff", () => {
    const view = bookingStatusView({ status: "PENDING_APPROVAL", appointment: null } as never);
    expect(view.label).toBe("Awaiting approval");
  });
});

describe("Inspections has two actions, and they are different ones", () => {
  it("offers 'Create inspection' (a record for an asset) and 'Book inspection' (a site visit) side by side, with booking the main one", async () => {
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    const create = await screen.findByRole("button", { name: "Create inspection" });
    const book = screen.getByRole("button", { name: "Book inspection" });
    expect(create).toHaveClass("secondary-button");
    expect(book).toHaveClass("primary-button");
    expect(screen.queryByRole("button", { name: /Add inspection/i })).toBeNull();
  });

  it("shows only the action a person may take", async () => {
    const first = render(<InspectionsWorkspace canApprove={false} canApproveBookings={false} canBook canWrite={false} />);
    await screen.findByRole("button", { name: "Book inspection" });
    expect(screen.queryByRole("button", { name: "Create inspection" })).toBeNull();
    first.unmount();
    render(<InspectionsWorkspace canApprove canApproveBookings={false} canBook={false} canWrite />);
    await screen.findByRole("button", { name: "Create inspection" });
    expect(screen.queryByRole("button", { name: "Book inspection" })).toBeNull();
  });

  it("the status tab for submitted work says 'Awaiting review'", async () => {
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    expect(await screen.findByRole("tab", { name: "Awaiting review" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Submitted" })).toBeNull();
  });
});
