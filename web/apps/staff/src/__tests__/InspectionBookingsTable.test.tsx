import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InspectionBookingsTable, bookingReference, type InspectionBookingsTableProps } from "../components/InspectionBookingsTable";
import type { InspectionBookingRecord } from "../domain/types";

const inspectors = [{ id: "ins-1", displayName: "Ben Brook" }, { id: "ins-2", displayName: "Ivy Inspector" }];

function booking(overrides: Partial<InspectionBookingRecord> = {}): InspectionBookingRecord {
  return {
    id: "01951f7a-0000-7000-8000-159dd231e9aa",
    customer: { id: "c1", name: "Vopak" },
    location: { id: "loc-1", name: "Port Botany", city: "Sydney", state: "NSW", schedulingTimezone: "Australia/Sydney" },
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

// ``requestedByRole`` is what the API reports for the stored requester; the table never
// infers the origin from the status, so each fixture states it.
const change = (status: string, requestedByRole: string | null = "CUSTOMER_USER", id = "ch-1") =>
  ({ id, status, startsAt: "2027-03-08T00:00:00Z", endsAt: "2027-03-08T01:00:00Z", reason: null, emergency: false, createdAt: "2027-03-01T00:00:00Z", requestedByRole });

function setup(records: InspectionBookingRecord[], props: Partial<InspectionBookingsTableProps> = {}) {
  const handlers = {
    onAssign: vi.fn(), onChangeInspector: vi.fn(), onDecline: vi.fn(), onRequestReschedule: vi.fn(),
    onCancel: vi.fn(), onApproveReschedule: vi.fn(), onConfirmReschedule: vi.fn()
  };
  render(
    <InspectionBookingsTable
      bookings={records}
      canApproveBookings
      canBook
      filtered={false}
      inspectors={inspectors}
      loading={false}
      pendingAction={null}
      {...handlers}
      {...props}
    />
  );
  return { ...handlers, user: userEvent.setup() };
}

const row = (site: string) =>
  screen.getByText(site, { selector: ".booking-row__identity strong" }).closest("tr") as HTMLElement;

const openMenu = async (user: ReturnType<typeof userEvent.setup>, site = "Port Botany") =>
  user.click(within(row(site)).getByRole("button", { name: `Actions for ${site}` }));

describe("InspectionBookingsTable", () => {
  it("names the site, customer, reference, time and place of each booking", () => {
    setup([booking()]);
    const cells = within(row("Port Botany"));
    expect(cells.getByText("Vopak")).toBeVisible();
    expect(cells.getByText("REF: HMS-9DD231E9AA")).toBeVisible();
    expect(cells.getByText("980636")).toBeVisible();
    // 00:00 UTC on 1 March 2027 is 11:00 in Sydney (daylight saving).
    expect(cells.getByText(/Mon, 1 Mar 2027, 11:00 am/)).toBeVisible();
    expect(cells.getByText("Sydney, NSW")).toBeVisible();
  });

  it("keeps the reference a searchable part of the booking's own id", () => {
    const id = "01951f7a-0000-7000-8000-159dd231e9aa";
    const reference = bookingReference(id).replace("HMS-", "").toLowerCase();
    expect(id.replaceAll("-", "")).toContain(reference);
  });

  it("falls back to the site's name when the place is not recorded", () => {
    setup([booking({ location: { id: "loc-1", name: "Port Botany", city: null, state: null, schedulingTimezone: "Australia/Sydney" } as never })]);
    expect(within(row("Port Botany")).getAllByText("Port Botany").length).toBeGreaterThan(1);
  });

  it.each([
    ["PENDING_APPROVAL", "Requested", "New inspection request"],
    ["APPROVED", "Approved", "Scheduled and confirmed"],
    ["REJECTED", "Rejected", "Not approved"],
    ["CANCELLED", "Cancelled", "No longer scheduled"]
  ] as const)("labels %s as its own status, with the field named", (status, label, caption) => {
    setup([booking({ status })], { canApproveBookings: false, canBook: false });
    const cells = within(row("Port Botany"));
    expect(cells.getByText("Status")).toBeVisible();
    expect(cells.getByText(label)).toBeVisible();
    expect(cells.getByText(caption)).toBeVisible();
  });

  it("offers an approver Assign inspector and Decline on a new request", async () => {
    const { user, onAssign, onDecline } = setup([booking()]);
    await user.click(within(row("Port Botany")).getByRole("button", { name: "Assign inspector for Port Botany" }));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: "01951f7a-0000-7000-8000-159dd231e9aa" }));
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Decline request" }));
    expect(onDecline).toHaveBeenCalled();
  });

  it("names the assigned inspector and offers Change inspector on a confirmed booking", async () => {
    const { user, onChangeInspector, onRequestReschedule, onCancel } = setup([confirmed()]);
    const cells = within(row("Port Botany"));
    expect(cells.getByText("Ben Brook")).toBeVisible();
    await user.click(cells.getByRole("button", { name: "Change inspector for Port Botany" }));
    expect(onChangeInspector).toHaveBeenCalled();
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Request reschedule" }));
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(onRequestReschedule).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("says when no inspector is assigned yet", () => {
    setup([booking()]);
    expect(within(row("Port Botany")).getByText("Not assigned")).toBeVisible();
  });

  it("names the role that asked for a reschedule, from the request itself", () => {
    setup([confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL", "CUSTOMER_USER")] as never })]);
    const cells = within(row("Port Botany"));
    expect(cells.getByText("Reschedule requested")).toBeVisible();
    expect(cells.getByText("Requested by: Customer")).toBeVisible();
  });

  it("names an inspector-initiated request as the inspector, not as whoever approves it", () => {
    setup([confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL", "INSPECTOR")] as never })]);
    expect(within(row("Port Botany")).getByText("Requested by: Inspector")).toBeVisible();
  });

  it("says nothing about the origin when the requester's role is unknown", () => {
    setup([confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL", null)] as never })]);
    const cells = within(row("Port Botany"));
    expect(cells.getByText("Reschedule requested")).toBeVisible();
    expect(cells.queryByText(/Requested by:/)).not.toBeInTheDocument();
  });

  it("offers the reschedule decision and refuses a reassignment at the same time", async () => {
    const { user, onApproveReschedule } = setup([confirmed({ changeRequests: [change("PENDING_ADMIN_APPROVAL")] as never })]);
    const reassign = within(row("Port Botany")).getByRole("button", { name: "Change inspector for Port Botany" });
    expect(reassign).toBeDisabled();
    expect(reassign).toHaveAttribute("title", "Reassignment is paused while a reschedule is pending.");
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Approve reschedule" }));
    expect(onApproveReschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "01951f7a-0000-7000-8000-159dd231e9aa" }), "ch-1");
  });

  it("lets a customer confirm the reschedule an admin proposed, and shows them no inspector", async () => {
    const { user, onConfirmReschedule } = setup(
      [confirmed({ changeRequests: [change("PENDING_CUSTOMER_CONFIRMATION", "HMS_ADMIN")] as never })],
      { canApproveBookings: false }
    );
    const cells = within(row("Port Botany"));
    expect(cells.queryByText("Ben Brook")).not.toBeInTheDocument();
    expect(cells.getByText("Requested by: Admin")).toBeVisible();
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Confirm reschedule" }));
    expect(onConfirmReschedule).toHaveBeenCalledWith("ch-1");
  });

  it.each(["REJECTED", "CANCELLED"] as const)("offers nothing to do on a %s booking", (status) => {
    setup([booking({ status })]);
    const cells = within(row("Port Botany"));
    expect(cells.getByText("No actions")).toBeVisible();
    expect(cells.queryByRole("button")).not.toBeInTheDocument();
  });

  it("disables every action while one is running", () => {
    setup([booking()], { pendingAction: "approve:bk-1" });
    expect(within(row("Port Botany")).getByRole("button", { name: "Assign inspector for Port Botany" })).toBeDisabled();
  });

  it("explains an empty table differently when filters are the reason", () => {
    const { user } = setup([], { filtered: true });
    expect(screen.getByText("No bookings match these filters.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    void user;
  });

  it("says nothing is booked when nothing is filtered out", () => {
    setup([]);
    expect(screen.getByText("No inspection bookings are scheduled.")).toBeVisible();
  });

  it("keeps the table up while a page is loading rather than blanking it", () => {
    setup([booking()], { loading: true });
    expect(screen.getByRole("table", { name: "Inspection bookings" })).toBeVisible();
    expect(row("Port Botany")).toBeVisible();
  });
});
