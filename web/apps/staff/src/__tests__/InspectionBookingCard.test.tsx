import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InspectionBookingCard, type InspectionBookingCardProps } from "../components/InspectionBookingCard";
import type { InspectionBookingRecord } from "../domain/types";

const inspectors = [{ id: "ins-1", displayName: "Ben Brook" }, { id: "ins-2", displayName: "Ivy Inspector" }];

function booking(overrides: Partial<InspectionBookingRecord> = {}): InspectionBookingRecord {
  return {
    id: "bk-1",
    customer: { id: "c1", name: "Vopak" },
    location: { id: "loc-1", name: "Port Botany", schedulingTimezone: "Australia/Sydney" },
    assets: [{ id: "a1", assetNumber: "980636", assetName: null, tag: null, lifecycleStatus: "IN_SERVICE" }],
    scheduledAt: "2027-03-01T00:00:00Z",
    scheduledEndAt: "2027-03-01T01:00:00Z",
    additionalInformation: null,
    status: "PENDING_APPROVAL",
    requestedByUserId: "c1",
    inspectorUserId: null,
    reviewedByUserId: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: "2027-02-01T00:00:00Z",
    appointment: null,
    changeRequests: [],
    ...overrides
  } as unknown as InspectionBookingRecord;
}

const confirmed = (overrides: Partial<InspectionBookingRecord> = {}) =>
  booking({
    status: "APPROVED",
    inspectorUserId: "ins-1",
    appointment: { id: "ap1", status: "CONFIRMED" } as InspectionBookingRecord["appointment"],
    ...overrides
  });

const change = (status: string, id = "ch-1") => ({ id, status, startsAt: "2027-03-08T00:00:00Z", endsAt: "2027-03-08T01:00:00Z", reason: null, emergency: false, createdAt: "2027-03-01T00:00:00Z" });

function setup(record: InspectionBookingRecord, props: Partial<InspectionBookingCardProps> = {}) {
  const handlers = {
    onApprove: vi.fn(), onDecline: vi.fn(), onRequestReschedule: vi.fn(), onCancel: vi.fn(),
    onChangeInspector: vi.fn(), onApproveReschedule: vi.fn(), onConfirmReschedule: vi.fn()
  };
  render(
    <InspectionBookingCard
      booking={record}
      canApproveBookings
      canBook
      inspectors={inspectors}
      pendingAction={null}
      {...handlers}
      {...props}
    />
  );
  return { ...handlers, user: userEvent.setup() };
}

describe("InspectionBookingCard", () => {
  it("shows site, customer, asset and the time in the site's own timezone", () => {
    setup(booking());
    expect(screen.getByText("Port Botany")).toBeVisible();
    expect(screen.getByText("Vopak")).toBeVisible();
    expect(screen.getByText("980636")).toBeVisible();
    // 00:00 UTC on 1 March 2027 is 11:00 in Sydney (daylight saving).
    expect(screen.getByText(/Mon, 1 Mar 2027, 11:00 am/)).toBeVisible();
  });

  it.each([
    ["PENDING_APPROVAL", "Requested", "booking-status--pending"],
    ["APPROVED", "Approved", "booking-status--approved"],
    ["REJECTED", "Rejected", "booking-status--rejected"],
    ["CANCELLED", "Cancelled", "booking-status--neutral"]
  ] as const)("shows %s as its own status badge", (status, label, className) => {
    setup(booking({ status }), { canApproveBookings: false, canBook: false });
    expect(screen.getByText("Status")).toBeVisible();
    expect(screen.getByText(label)).toHaveClass(className);
  });

  it("lets an approver assign, approve or decline a pending booking, and asks for an inspector first", async () => {
    const { user, onApprove, onDecline } = setup(booking());
    expect(screen.getByRole("button", { name: "Assign inspector" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Change inspector/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign inspector" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment & approve" }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an inspector to assign first.");

    await user.selectOptions(screen.getByLabelText("Assign inspector for Port Botany"), "ins-2");
    await user.click(screen.getByRole("button", { name: "Confirm assignment & approve" }));
    expect(onApprove).toHaveBeenCalledWith("bk-1", "ins-2");

    await user.click(screen.getByRole("button", { name: "Reject request" }));
    expect(onDecline).toHaveBeenCalledWith(expect.objectContaining({ id: "bk-1" }));
  });

  it("offers no approval controls to someone who cannot approve", () => {
    setup(booking(), { canApproveBookings: false });
    expect(screen.queryByRole("button", { name: "Assign inspector" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assign inspector for Port Botany")).not.toBeInTheDocument();
  });

  it("shows the assigned inspector with Change inspector beside the name on a confirmed booking", async () => {
    const { user, onChangeInspector } = setup(confirmed());
    const row = screen.getByText("Assigned inspector:").closest("div") as HTMLElement;
    expect(within(row).getByText("Ben Brook")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change inspector for Port Botany" }));
    expect(onChangeInspector).toHaveBeenCalledWith(expect.objectContaining({ id: "bk-1" }));
    await user.click(screen.getByText("Actions"));
    expect(screen.getByRole("button", { name: "Request reschedule" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel booking" })).toBeEnabled();
  });

  it("hides the inspector row from a customer, who can still reschedule or cancel", async () => {
    const { user, onRequestReschedule, onCancel } = setup(confirmed(), { canApproveBookings: false });
    expect(screen.queryByText("Assigned inspector:")).not.toBeInTheDocument();
    await user.click(screen.getByText("Actions"));
    await user.click(screen.getByRole("button", { name: "Request reschedule" }));
    await user.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(onRequestReschedule).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not offer Change inspector or another reschedule while one is pending", () => {
    setup(confirmed({ changeRequests: [change("PENDING_CUSTOMER_CONFIRMATION")] as never }));
    expect(screen.getByText("Cannot change inspector while a reschedule is pending.")).toBeVisible();
    expect(screen.getByText("Reschedule requested")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Change inspector/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request reschedule" })).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting customer confirmation")).toBeVisible();
  });

  it("an approver approves a customer's reschedule request with a chosen inspector", async () => {
    const { user, onApproveReschedule } = setup(confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL")] as never }));
    expect(screen.getByText("Reschedule request:")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve reschedule" }));
    expect(onApproveReschedule).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Assign inspector for reschedule at Port Botany"), "ins-1");
    await user.click(screen.getByRole("button", { name: "Approve reschedule" }));
    expect(onApproveReschedule).toHaveBeenCalledWith("ch-1", "ins-1");
  });

  it("a customer sees their own request as awaiting admin approval", () => {
    setup(confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL")] as never }), { canApproveBookings: false });
    expect(screen.getByText("Awaiting admin approval")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve reschedule" })).not.toBeInTheDocument();
  });

  it("confirms a proposed reschedule for a customer", async () => {
    const { user, onConfirmReschedule } = setup(confirmed({ changeRequests: [change("PENDING_CUSTOMER_CONFIRMATION")] as never }), { canApproveBookings: false });
    await user.click(screen.getByRole("button", { name: "Confirm reschedule" }));
    expect(onConfirmReschedule).toHaveBeenCalledWith("ch-1");
  });

  it("disables every action while another is running, and labels the one in progress", () => {
    setup(booking(), { pendingAction: "approve:bk-1" });
    expect(screen.getByRole("button", { name: "Assign inspector" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject request" })).toBeDisabled();
  });

  it("keeps long names and references readable", () => {
    const longName = "Extraordinarily Long Customer Name Pty Ltd Trading As The Hose People of Port Botany";
    setup(booking({ customer: { id: "c1", name: longName } as never }));
    expect(screen.getByText(longName)).toBeVisible();
  });
});
