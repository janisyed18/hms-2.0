import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchedulingWorkspace } from "../components/SchedulingWorkspace";
import type { InspectionBookingRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listInspectionSchedule: vi.fn(),
  listInspectionBookings: vi.fn(),
  listAdminUsers: vi.fn(),
  listAllAssets: vi.fn(),
  listInspectionAvailability: vi.fn(),
  approveInspectionBooking: vi.fn(),
  rejectInspectionBooking: vi.fn(),
  cancelInspectionBooking: vi.fn(),
  approveInspectionBookingReschedule: vi.fn(),
  requestInspectionBookingReschedule: vi.fn(),
  createInspectionBooking: vi.fn(),
  getInspectionBooking: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const SYDNEY = "Australia/Sydney";
const PERTH = "Australia/Perth";
const MONDAY = "2027-03-01";

interface Seed {
  id: string;
  customer?: string;
  customerId?: string;
  location?: string;
  locationId?: string;
  zone?: string;
  start: string;
  end: string;
  inspector?: string | null;
  status?: InspectionBookingRecord["status"];
  appointmentStatus?: "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW" | null;
  snapshot?: [string, string];
  change?: "PENDING_ADMIN_APPROVAL" | "PENDING_CUSTOMER_CONFIRMATION";
  assets?: string[];
}

function booking(seed: Seed): InspectionBookingRecord {
  const zone = seed.zone ?? SYDNEY;
  const status = seed.status ?? "APPROVED";
  const appointmentStatus =
    seed.appointmentStatus === undefined
      ? status === "APPROVED"
        ? "CONFIRMED"
        : null
      : seed.appointmentStatus;
  return {
    id: seed.id,
    customer: { id: seed.customerId ?? "cust-vopak", code: "V", name: seed.customer ?? "Vopak" },
    location: {
      id: seed.locationId ?? "loc-botany",
      name: seed.location ?? "Botany",
      address1: null,
      address2: null,
      city: null,
      state: null,
      country: null,
      schedulingTimezone: zone
    },
    assets: (seed.assets ?? ["HOS-1"]).map((number, index) => ({
      id: `${seed.id}-a${index}`,
      assetNumber: number,
      tag: null,
      lifecycleStatus: "IN_SERVICE"
    })),
    scheduledAt: seed.start,
    scheduledEndAt: seed.end,
    additionalInformation: null,
    status,
    requestedByUserId: "cust",
    inspectorUserId: seed.inspector === undefined ? "insp-a" : seed.inspector,
    reviewedByUserId: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: "2027-02-20T00:00:00Z",
    appointment: appointmentStatus
      ? {
          id: `${seed.id}-appt`,
          status: appointmentStatus,
          startsAt: seed.start,
          endsAt: seed.end,
          revisionNumber: 1,
          timezoneId: zone,
          localStartSnapshot: seed.snapshot?.[0] ?? "2027-03-01T11:00:00",
          localEndSnapshot: seed.snapshot?.[1] ?? "2027-03-01T12:00:00",
          utcOffsetStart: zone === PERTH ? "+08:00" : "+11:00",
          utcOffsetEnd: zone === PERTH ? "+08:00" : "+11:00",
          tzdataVersion: "test"
        }
      : null,
    changeRequests: seed.change
      ? [
          {
            id: `${seed.id}-chg`,
            status: seed.change,
            startsAt: "2027-03-05T00:00:00Z",
            endsAt: "2027-03-05T01:00:00Z",
            reason: "Site closed",
            emergency: false,
            createdAt: "2027-02-25T00:00:00Z"
          }
        ]
      : []
  };
}

const confirmedA = booking({ id: "b1", start: "2027-03-01T00:00:00Z", end: "2027-03-01T01:00:00Z" });
const clashA = booking({
  id: "b2",
  customer: "Shell",
  customerId: "cust-shell",
  location: "Clyde",
  locationId: "loc-clyde",
  start: "2027-03-01T00:30:00Z",
  end: "2027-03-01T01:30:00Z",
  snapshot: ["2027-03-01T11:30:00", "2027-03-01T12:30:00"]
});
const perthB = booking({
  id: "b3",
  customer: "Orica",
  customerId: "cust-orica",
  location: "Kwinana",
  locationId: "loc-kwinana",
  zone: PERTH,
  inspector: "insp-b",
  start: "2027-03-01T01:00:00Z",
  end: "2027-03-01T03:00:00Z",
  snapshot: ["2027-03-01T09:00:00", "2027-03-01T11:00:00"]
});
const pending = booking({
  id: "b4",
  start: "2027-03-01T03:00:00Z",
  end: "2027-03-01T04:00:00Z",
  inspector: null,
  status: "PENDING_APPROVAL",
  appointmentStatus: null
});
const tuesdayCancelled = booking({
  id: "b5",
  customer: "Orica",
  customerId: "cust-orica",
  location: "Kwinana",
  locationId: "loc-kwinana",
  zone: PERTH,
  inspector: "insp-b",
  start: "2027-03-02T01:00:00Z",
  end: "2027-03-02T02:00:00Z",
  status: "CANCELLED",
  appointmentStatus: "CANCELLED"
});

const inspectors = [
  { id: "insp-a", displayName: "Ada Archer" },
  { id: "insp-b", displayName: "Ben Brook" }
];
const everything = [confirmedA, clashA, perthB, pending, tuesdayCancelled];

function scheduleResult(items: InspectionBookingRecord[], total = items.length) {
  return { total, limit: 500, items, inspectors };
}

function renderWorkspace(
  props: Partial<React.ComponentProps<typeof SchedulingWorkspace>> = {}
) {
  return render(
    <SchedulingWorkspace canApproveBookings canBook initialDate={MONDAY} {...props} />
  );
}

async function ready() {
  await screen.findByRole("group", { name: /Dispatch schedule for/ });
}

const lastScheduleCall = () => {
  const calls = client.listInspectionSchedule.mock.calls;
  return calls[calls.length - 1][0] as {
    start: Date;
    end: Date;
    inspectorUserId?: string;
    customerId?: string;
    locationId?: string;
    unassigned?: boolean;
  };
};

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listInspectionSchedule.mockResolvedValue(scheduleResult(everything));
  client.listInspectionBookings.mockResolvedValue({ total: 0, items: [], etag: null });
  client.listAdminUsers.mockResolvedValue({
    total: 2,
    items: inspectors.map((inspector) => ({
      ...inspector,
      role: "INSPECTOR",
      accountStatus: "ACTIVE"
    }))
  });
  client.listAllAssets.mockResolvedValue({ total: 0, items: [] });
  client.getInspectionBooking.mockImplementation(async (id: string) =>
    everything.find((item) => item.id === id)
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Day view", () => {
  it("asks for exactly the visible day, in the calendar's zone", async () => {
    renderWorkspace();
    await ready();
    const { start, end } = lastScheduleCall();
    // Monday 1 March in Sydney (AEDT, +11) is 13:00Z on the Sunday to 13:00Z on the Monday.
    expect(start.toISOString()).toBe("2027-02-28T13:00:00.000Z");
    expect(end.toISOString()).toBe("2027-03-01T13:00:00.000Z");
  });

  it("shows an Unassigned lane and one lane per working inspector with their workload", async () => {
    renderWorkspace();
    await ready();
    const grid = screen.getByRole("group", { name: /Dispatch schedule for Monday 1 March/ });
    expect(within(grid).getByText("Unassigned")).toBeInTheDocument();
    expect(within(grid).getByText("1 visit to assign")).toBeInTheDocument();
    expect(within(grid).getByText("Ada Archer")).toBeInTheDocument();
    expect(within(grid).getByText(/2 visits · 2h scheduled/)).toBeInTheDocument();
    expect(within(grid).getByText("Ben Brook")).toBeInTheDocument();
    expect(within(grid).getByText(/1 visit · 2h scheduled/)).toBeInTheDocument();
  });

  it("keeps unassigned requests on the calendar, in their own lane", async () => {
    renderWorkspace();
    await ready();
    const block = screen.getByRole("button", { name: /Vopak, Botany, Unassigned, Awaiting approval/ });
    expect(block).toBeInTheDocument();
  });

  it("describes each visit in words: time, customer, location, inspector and status", async () => {
    renderWorkspace();
    await ready();
    expect(
      screen.getByRole("button", {
        name: "Monday 1 March, 11:00 am to 12:00 pm, Vopak, Botany, Ada Archer, Confirmed, conflicts with another visit for this inspector"
      })
    ).toBeInTheDocument();
  });

  it("flags an inspector who is double-booked, in words and not just by overlap", async () => {
    renderWorkspace();
    await ready();
    expect(screen.getByText("2 overlapping visits")).toBeInTheDocument();
    expect(screen.getAllByText(/Confirmed · Conflict/)).toHaveLength(2);
  });

  it("shows a visit at its own location's time, naming the zone when it differs", async () => {
    renderWorkspace();
    await ready();
    const perth = screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook, Confirmed/ });
    // 09:00-11:00 where it happens (Perth), not 12:00-14:00 Sydney time.
    expect(perth).toHaveAccessibleName(/9:00 am to 11:00 am AWST, Orica/);
  });

  it("is unaffected by the zone the browser is set to", async () => {
    const before = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      renderWorkspace();
      await ready();
      expect(screen.getByRole("button", { name: /9:00 am to 11:00 am AWST, Orica, Kwinana/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /11:00 am to 12:00 pm, Vopak, Botany, Ada Archer/ })).toBeInTheDocument();
      expect(lastScheduleCall().start.toISOString()).toBe("2027-02-28T13:00:00.000Z");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("explains an empty day and offers to book", async () => {
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([]));
    renderWorkspace();
    const message = await screen.findByText("No inspections scheduled for Monday 1 March");
    expect(within(message.closest("div") as HTMLElement).getByRole("button", { name: "Book inspection" })).toBeInTheDocument();
  });

  it("hides idle inspectors when there are many, and can show them", async () => {
    const crowd = Array.from({ length: 30 }, (_, index) => ({
      id: `crowd-${index}`,
      displayName: `Inspector ${String(index).padStart(2, "0")}`
    }));
    client.listAdminUsers.mockResolvedValue({
      total: 30,
      items: [...inspectors, ...crowd].map((inspector) => ({
        ...inspector,
        role: "INSPECTOR",
        accountStatus: "ACTIVE"
      }))
    });
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    const toggle = await screen.findByLabelText(/Show inspectors with no visits/);
    const grid = screen.getByRole("group", { name: /Dispatch schedule/ });
    expect(within(grid).queryByText("Inspector 07")).not.toBeInTheDocument();
    expect(within(grid).getByText("Ada Archer")).toBeInTheDocument();
    await user.click(toggle);
    expect(within(screen.getByRole("group", { name: /Dispatch schedule/ })).getByText("Inspector 07")).toBeInTheDocument();
  });
});

describe("date navigation", () => {
  it("moves by a day, a week or a month depending on the range, and keeps the range", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();

    await user.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() =>
      expect(lastScheduleCall().start.toISOString()).toBe("2027-03-01T13:00:00.000Z")
    );

    await user.click(screen.getByRole("button", { name: "Week" }));
    await waitFor(() => {
      const { start, end } = lastScheduleCall();
      expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
      expect(start.toISOString()).toBe("2027-02-28T13:00:00.000Z"); // Monday 1 March, 00:00 AEDT
    });

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(lastScheduleCall().start.toISOString()).toBe("2027-03-07T13:00:00.000Z"));

    await user.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => {
      const { start, end } = lastScheduleCall();
      // Six whole local weeks: 42 days, plus the hour of a 25-hour daylight-saving day.
      expect(end.getTime() - start.getTime()).toBeGreaterThanOrEqual(42 * 86_400_000);
      expect(end.getTime() - start.getTime()).toBeLessThanOrEqual(42 * 86_400_000 + 3_600_000);
    });
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /April 2027/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /March 2027/ })).toBeInTheDocument());
  });

  it("jumps to a date and returns to today", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2027-03-10T03:00:00Z") });
    renderWorkspace({ initialDate: "2027-05-20" });
    await screen.findByRole("heading", { name: /Thursday 20 May 2027/ });
    fireEvent.change(screen.getByLabelText("Jump to date"), { target: { value: "2027-06-15" } });
    await screen.findByRole("heading", { name: /Tuesday 15 June 2027/ });
    expect(lastScheduleCall().start.toISOString()).toBe("2027-06-14T14:00:00.000Z"); // AEST, +10
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await screen.findByRole("heading", { name: /Wednesday 10 March 2027/ });
  });
});

describe("Week and Month views", () => {
  it("shows the week as seven navigable days with their visits", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: "Week" }));
    const grid = await screen.findByRole("group", { name: /Schedule for the week of 1 March to 7 March 2027/ });
    expect(within(grid).getAllByRole("button", { name: /^Open .* in day view$/ })).toHaveLength(7);
    expect(within(grid).getByText("4 visits")).toBeInTheDocument(); // Monday
    expect(
      within(grid).getByRole("button", { name: /Monday 1 March, 9:00 am to 11:00 am AWST, Orica, Kwinana, Ben Brook/ })
    ).toBeInTheDocument();
    await user.click(within(grid).getByRole("button", { name: /Open Monday 1 March in day view/ }));
    await screen.findByRole("group", { name: /Dispatch schedule for Monday 1 March/ });
  });

  it("summarises each day of the month and opens a day on request", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: "Month" }));
    const monday = await screen.findByRole("button", {
      name: "Monday 1 March: 4 visits, 1 unassigned, 2 overlapping. Open day view"
    });
    expect(screen.getByRole("button", { name: /Tuesday 2 March: 1 visit\./ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Wednesday 3 March: no visits/ })).toBeInTheDocument();
    await user.click(monday);
    await screen.findByRole("group", { name: /Dispatch schedule for Monday 1 March/ });
  });

  it("says so when a month has nothing in it", async () => {
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([]));
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText(/No inspections scheduled for Monday/);
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByText(/No inspections scheduled in March 2027/)).toBeInTheDocument();
  });

  it("says so when a week has nothing in it", async () => {
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([]));
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText(/No inspections scheduled for Monday/);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByText(/No inspections scheduled for the week of/)).toBeInTheDocument();
  });
});

describe("filters", () => {
  it("asks the server for the chosen inspector and shows only their visits", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.selectOptions(screen.getByLabelText("Inspector"), "insp-b");
    await waitFor(() => expect(lastScheduleCall().inspectorUserId).toBe("insp-b"));
    // The mocked server ignores the filter and returns everything; the view still agrees.
    expect(screen.queryByRole("button", { name: /Vopak, Botany/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ })).toBeInTheDocument();
  });

  it("filters by customer and location and resets them", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-shell");
    await waitFor(() => expect(lastScheduleCall().customerId).toBe("cust-shell"));
    expect(screen.getAllByRole("button", { name: /Shell, Clyde/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Orica, Kwinana/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Reset filters \(1\)/ }));
    await waitFor(() => expect(lastScheduleCall().customerId).toBeUndefined());
    expect(screen.getByRole("button", { name: /Orica, Kwinana/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Location"), "loc-kwinana");
    await waitFor(() => expect(lastScheduleCall().locationId).toBe("loc-kwinana"));
    expect(screen.queryByRole("button", { name: /Shell, Clyde/ })).not.toBeInTheDocument();
  });

  it("filters by status group and by unassigned work", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.selectOptions(screen.getByLabelText("Status"), "pending");
    expect(screen.getByRole("button", { name: /Awaiting approval/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ada Archer, Confirmed/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await user.selectOptions(screen.getByLabelText("Assignment"), "unassigned");
    await waitFor(() => expect(lastScheduleCall().unassigned).toBe(true));
    expect(screen.queryByRole("button", { name: /Ada Archer/ })).not.toBeInTheDocument();
  });

  it("applies the same filters to the Month view and the List", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.selectOptions(screen.getByLabelText("Inspector"), "insp-b");
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("button", { name: /Monday 1 March: 1 visit\./ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "List" }));
    const table = await screen.findByRole("table", { name: "Scheduled inspections" });
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + Monday + Tuesday for Ben
    expect(within(table).queryByText("Ada Archer")).not.toBeInTheDocument();
  });

  it("explains a filter that matches nothing", async () => {
    client.listInspectionSchedule.mockImplementation(async () => scheduleResult([]));
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText(/No inspections scheduled for Monday/);
    await user.selectOptions(screen.getByLabelText("Assignment"), "assigned");
    expect(screen.getByText(/Nothing matches the current filters/)).toBeInTheDocument();
  });
});

describe("loading and errors", () => {
  it("shows a skeleton before the first result, never a blank calendar", async () => {
    client.listInspectionSchedule.mockReturnValue(new Promise(() => undefined));
    renderWorkspace();
    expect(screen.getByRole("status", { name: "Loading schedule" })).toBeInTheDocument();
  });

  it("reports a failed load with a retry that works", async () => {
    client.listInspectionSchedule.mockRejectedValueOnce(new Error("Gateway timeout"));
    const user = userEvent.setup();
    renderWorkspace();
    expect(await screen.findByText(/The schedule could not be loaded\. Gateway timeout/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await ready();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("keeps the last schedule on screen when a later fetch fails", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    client.listInspectionSchedule.mockRejectedValueOnce(new Error("Offline"));
    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(await screen.findByText(/last loaded view is shown/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Dispatch schedule/ })).toBeInTheDocument();
  });

  it("says when only part of a busy period is shown", async () => {
    client.listInspectionSchedule.mockResolvedValue(scheduleResult(everything, 1200));
    renderWorkspace();
    await ready();
    expect(screen.getByText(/Showing the first 500 of 1200 visits/)).toBeInTheDocument();
  });
});

describe("status", () => {
  it("names every status in words and explains them in a legend", async () => {
    renderWorkspace();
    await ready();
    const legend = screen.getByRole("list", { name: "Status legend" });
    for (const label of ["Awaiting approval", "Change requested", "Confirmed", "Completed", "No show", "Cancelled", "Declined"]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
  });

  it("maps server state to presentation groups", async () => {
    const done = booking({ id: "d1", start: "2027-03-01T05:00:00Z", end: "2027-03-01T06:00:00Z", appointmentStatus: "COMPLETED" });
    const asked = booking({ id: "d2", start: "2027-03-01T06:00:00Z", end: "2027-03-01T07:00:00Z", change: "PENDING_ADMIN_APPROVAL" });
    const declined = booking({ id: "d3", start: "2027-03-01T07:00:00Z", end: "2027-03-01T08:00:00Z", status: "REJECTED", appointmentStatus: null, inspector: null });
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([done, asked, declined]));
    renderWorkspace();
    await ready();
    expect(screen.getByText("Completed", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("Change requested", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("Declined", { selector: "em" })).toBeInTheDocument();
  });
});

describe("appointment details", () => {
  it("opens from the calendar with everything an operator needs, and closes with Escape", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    const block = screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ });
    await user.click(block);
    const drawer = await screen.findByRole("dialog", { name: /Orica · Kwinana/ });
    expect(within(drawer).getByText("Ben Brook")).toBeInTheDocument();
    expect(within(drawer).getByText(/Australia\/Perth \(AWST, UTC\+08:00\)/)).toBeInTheDocument();
    expect(within(drawer).getByText(/The calendar is showing Australia\/Sydney/)).toBeInTheDocument();
    expect(within(drawer).getByText("HOS-1")).toBeInTheDocument();
    expect(within(drawer).getByText(/revision 1/)).toBeInTheDocument();
    expect(within(drawer).getByText(/9:00 am to 11:00 am/)).toBeInTheDocument();
    expect(drawer).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(block).toHaveFocus();
  });

  it("can be opened from the keyboard", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    const block = screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ });
    block.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows a pending reschedule and its history", async () => {
    const changed = booking({ id: "c1", start: "2027-03-01T05:00:00Z", end: "2027-03-01T06:00:00Z", change: "PENDING_ADMIN_APPROVAL" });
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([changed]));
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Change requested/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Waiting for admin approval")).toBeInTheDocument();
    expect(within(drawer).getByText(/Site closed/)).toBeInTheDocument();
  });
});

describe("actions go through the existing validated endpoints", () => {
  it("assigns and approves a pending request, then refreshes", async () => {
    client.approveInspectionBooking.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Unassigned, Awaiting approval/ }));
    const drawer = await screen.findByRole("dialog");
    const assign = within(drawer).getByRole("button", { name: "Assign & approve" });
    expect(assign).toBeDisabled();
    await user.selectOptions(within(drawer).getByLabelText("Inspector to assign"), "insp-b");
    await user.click(assign);
    await waitFor(() => expect(client.approveInspectionBooking).toHaveBeenCalledWith("b4", "insp-b"));
    expect(await within(drawer).findByText("Booking approved and inspector assigned.")).toBeInTheDocument();
    expect(client.getInspectionBooking).toHaveBeenCalledWith("b4");
    expect(client.listInspectionSchedule.mock.calls.length).toBeGreaterThan(1);
  });

  it("declines and cancels only after a second, explicit click", async () => {
    client.rejectInspectionBooking.mockResolvedValue(undefined);
    client.cancelInspectionBooking.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Unassigned, Awaiting approval/ }));
    let drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Decline" }));
    expect(client.rejectInspectionBooking).not.toHaveBeenCalled();
    await user.click(within(drawer).getByRole("button", { name: "Confirm decline" }));
    await waitFor(() => expect(client.rejectInspectionBooking).toHaveBeenCalledWith("b4"));

    await user.click(within(drawer).getByRole("button", { name: "Close appointment details" }));
    await user.click(screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ }));
    drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Cancel booking" }));
    expect(client.cancelInspectionBooking).not.toHaveBeenCalled();
    await user.click(within(drawer).getByRole("button", { name: "Confirm cancel booking" }));
    await waitFor(() => expect(client.cancelInspectionBooking).toHaveBeenCalledWith("b3"));
  });

  it("approves a customer's reschedule request with a chosen inspector", async () => {
    const asked = booking({ id: "c1", start: "2027-03-01T05:00:00Z", end: "2027-03-01T06:00:00Z", change: "PENDING_ADMIN_APPROVAL" });
    client.listInspectionSchedule.mockResolvedValue(scheduleResult([asked]));
    client.approveInspectionBookingReschedule.mockResolvedValue(undefined);
    client.getInspectionBooking.mockResolvedValue(asked);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Change requested/ }));
    const drawer = await screen.findByRole("dialog");
    await user.selectOptions(within(drawer).getByLabelText("Inspector to assign"), "insp-a");
    await user.click(within(drawer).getByRole("button", { name: "Approve reschedule" }));
    await waitFor(() => expect(client.approveInspectionBookingReschedule).toHaveBeenCalledWith("c1-chg", "insp-a"));
  });

  it("never reschedules directly: it opens the availability flow, and only a chosen quote is sent", async () => {
    client.listAllAssets.mockResolvedValue({
      total: 1,
      items: [
        {
          id: "b3-a0",
          assetNumber: "HOS-1",
          customer: { id: "cust-orica", code: "O", name: "Orica" },
          location: { id: "loc-kwinana", name: "Kwinana", schedulingTimezone: PERTH }
        }
      ]
    });
    client.listInspectionAvailability.mockResolvedValue([
      { quoteId: "quote-1", startsAt: "2027-03-08T01:00:00Z", endsAt: "2027-03-08T02:00:00Z", expiresAt: "2027-03-01T05:00:00Z" }
    ]);
    client.requestInspectionBookingReschedule.mockResolvedValue({ id: "chg" });
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ }));
    const drawer = await screen.findByRole("dialog", { name: /Orica/ });
    await user.click(within(drawer).getByRole("button", { name: "Request reschedule" }));

    // Nothing was sent: the existing form had to be completed first.
    expect(client.requestInspectionBookingReschedule).not.toHaveBeenCalled();
    const form = (await screen.findByRole("heading", { name: "Request reschedule" })).closest("form") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Preferred inspection date"), { target: { value: "2027-03-08" } });
    await waitFor(() => expect(client.listInspectionAvailability).toHaveBeenCalled());
    expect(client.listInspectionAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust-orica", locationId: "loc-kwinana", localDate: "2027-03-08" })
    );
    const submit = within(form).getByRole("button", { name: "Request reschedule" });
    expect(submit).toBeDisabled();
    await user.selectOptions(await within(form).findByLabelText("Available inspection time"), "quote-1");
    await user.selectOptions(within(form).getByLabelText("Inspector for rescheduled inspection"), "insp-a");
    await user.click(submit);
    await waitFor(() =>
      expect(client.requestInspectionBookingReschedule).toHaveBeenCalledWith(
        "b3",
        expect.objectContaining({ availabilityQuoteId: "quote-1", inspectorUserId: "insp-a" })
      )
    );
  });

  it("opens the booking form on the day being viewed", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: "Book inspection" }));
    const form = (await screen.findByRole("heading", { name: "Book inspection", level: 2 })).closest("form") as HTMLElement;
    expect(within(form).getByLabelText("Preferred inspection date")).toHaveValue(MONDAY);
  });

  it("explains a conflict, refreshes the booking and keeps the user where they were", async () => {
    const { HmsApiError } = await import("../api/hmsClient");
    client.approveInspectionBooking.mockRejectedValue(
      new HmsApiError(409, "conflict", "The inspector is no longer available for the selected time", null)
    );
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("button", { name: /Unassigned, Awaiting approval/ }));
    const drawer = await screen.findByRole("dialog");
    await user.selectOptions(within(drawer).getByLabelText("Inspector to assign"), "insp-a");
    const callsBefore = client.listInspectionSchedule.mock.calls.length;
    await user.click(within(drawer).getByRole("button", { name: "Assign & approve" }));

    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent(/changed while you were working/);
    expect(alert).toHaveTextContent(/no longer available/);
    expect(within(drawer).queryByText("Booking approved and inspector assigned.")).not.toBeInTheDocument();
    expect(client.getInspectionBooking).toHaveBeenCalledWith("b4"); // refreshed from the server
    await waitFor(() => expect(client.listInspectionSchedule.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // still open: nothing was lost
  });

  it("offers only what the role and state allow", async () => {
    const user = userEvent.setup();
    renderWorkspace({ canApproveBookings: false, canBook: false });
    await ready();
    expect(screen.queryByRole("button", { name: "Book inspection" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Unassigned, Awaiting approval/ }));
    let drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByRole("button", { name: "Assign & approve" })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/No further actions/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "Close appointment details" }));

    await user.click(screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ }));
    drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByRole("button", { name: "Cancel booking" })).not.toBeInTheDocument();
  });

  it("offers no actions on a cancelled booking", async () => {
    const user = userEvent.setup();
    renderWorkspace({ initialDate: "2027-03-02" });
    await screen.findByRole("group", { name: /Dispatch schedule for Tuesday/ });
    await user.click(screen.getByRole("button", { name: /Orica, Kwinana.*Cancelled/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByRole("button", { name: /Assign|Decline|Cancel booking|reschedule/i })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/No further actions/)).toBeInTheDocument();
  });
});

describe("List view", () => {
  it("lists visits with their local time, searches and paginates", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: "List" }));
    const table = await screen.findByRole("table", { name: "Scheduled inspections" });
    expect(within(table).getAllByRole("row")).toHaveLength(6); // header + the 5 visits returned
    expect(within(table).getAllByText("Orica").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Scheduled inspections rows per page")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search visits"), "kwinana");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + Monday + Tuesday
    await user.clear(screen.getByLabelText("Search visits"));
    await user.type(screen.getByLabelText("Search visits"), "zzz");
    expect(await screen.findByText("No visits match your search")).toBeInTheDocument();
  });

  it("opens a visit from the list", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: "List" }));
    await user.click((await screen.findAllByRole("button", { name: /^Open Orica at Kwinana,/ }))[0]);
    expect(await screen.findByRole("dialog", { name: /Orica · Kwinana/ })).toBeInTheDocument();
  });
});

describe("Pending requests", () => {
  const change = booking({ id: "p2", customer: "Shell", customerId: "cust-shell", start: "2027-03-03T00:00:00Z", end: "2027-03-03T01:00:00Z", change: "PENDING_ADMIN_APPROVAL" });

  it("lists new requests and reschedule requests with their age and requested time", async () => {
    client.listInspectionBookings.mockImplementation(async (options: { status?: string; hasPendingChange?: boolean }) =>
      options.hasPendingChange
        ? { total: 1, items: [change], etag: null }
        : { total: 1, items: [pending], etag: null }
    );
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: /^Pending requests/ }));
    expect(await screen.findByRole("heading", { name: "New booking requests (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reschedule requests (1)" })).toBeInTheDocument();
    expect(screen.getByText(/Requested change to/)).toBeInTheDocument();
    expect(screen.getAllByText(/Raised .* days? ago|Raised today/).length).toBeGreaterThan(0);
    expect(client.listInspectionBookings).toHaveBeenCalledWith(expect.objectContaining({ status: "PENDING_APPROVAL" }));
    expect(client.listInspectionBookings).toHaveBeenCalledWith(expect.objectContaining({ hasPendingChange: true }));

    await user.click(screen.getByRole("button", { name: /Review reschedule for Shell/ }));
    expect(await screen.findByRole("button", { name: "Approve reschedule" })).toBeInTheDocument();
  });

  it("is honest when nothing is waiting, and when the load fails", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: /^Pending requests/ }));
    expect(await screen.findByText("Nothing is waiting for a decision")).toBeInTheDocument();

    client.listInspectionBookings.mockRejectedValue(new Error("Boom"));
    await user.click(screen.getByRole("tab", { name: "Calendar" }));
    await user.click(screen.getByRole("tab", { name: /^Pending requests/ }));
    expect(await screen.findAllByText(/could not be loaded\. Boom/)).toHaveLength(2);
    client.listInspectionBookings.mockResolvedValue({ total: 0, items: [], etag: null });
    await act(async () => screen.getAllByRole("button", { name: "Try again" })[0].click());
    await act(async () => screen.getAllByRole("button", { name: "Try again" })[0]?.click());
    expect(await screen.findByText("Nothing is waiting for a decision")).toBeInTheDocument();
  });
});

// --- work queues and roster beyond one page ---------------------------------------

function queueBooking(index: number, kind: "request" | "change"): InspectionBookingRecord {
  const stamp = String(index).padStart(4, "0");
  return booking({
    id: `${kind}-${stamp}`,
    customer: `${kind === "request" ? "Requester" : "Changer"} ${stamp}`,
    start: "2027-03-03T00:00:00Z",
    end: "2027-03-03T01:00:00Z",
    inspector: kind === "request" ? null : "insp-a",
    status: kind === "request" ? "PENDING_APPROVAL" : "APPROVED",
    appointmentStatus: kind === "request" ? null : "CONFIRMED",
    change: kind === "change" ? "PENDING_ADMIN_APPROVAL" : undefined
  });
}

function serveQueues(requestTotal: number, changeTotal: number) {
  const requests = Array.from({ length: requestTotal }, (_, index) => queueBooking(index, "request"));
  const changes = Array.from({ length: changeTotal }, (_, index) => queueBooking(index, "change"));
  const calls: Array<{ kind: "requests" | "changes"; offset: number; limit: number }> = [];
  client.listInspectionBookings.mockImplementation(
    async (options: { status?: string; hasPendingChange?: boolean; limit?: number; offset?: number }) => {
      const kind = options.hasPendingChange ? "changes" : "requests";
      const rows = kind === "changes" ? changes : requests;
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      calls.push({ kind, offset, limit });
      return { total: rows.length, items: rows.slice(offset, offset + limit), etag: null };
    }
  );
  return { calls, requests, changes };
}

describe("Pending requests beyond one page", () => {
  const reviewButtons = () => screen.getAllByRole("button", { name: /^Review / });

  it("reports the server's total, not how many happen to be loaded", async () => {
    const served = serveQueues(137, 120);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: /Pending requests/ }));

    expect(await screen.findByRole("heading", { name: "New booking requests (137)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reschedule requests (120)" })).toBeInTheDocument();
    expect(screen.getByText("Showing 50 of 137")).toBeInTheDocument();
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load more booking requests \(87 not yet shown\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load more reschedule requests \(70 not yet shown\)/ })).toBeInTheDocument();
    // The first page is a page: nothing pretends the queue ends at what was fetched.
    expect(served.calls.every((call) => call.limit <= 50)).toBe(true);
  });

  it("reaches every record exactly once by loading more, independently per queue", async () => {
    const served = serveQueues(137, 120);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: /Pending requests/ }));
    await screen.findByRole("heading", { name: "New booking requests (137)" });
    const loadMoreRequests = () => screen.queryByRole("button", { name: /Load more booking requests/ });

    await user.click(loadMoreRequests() as HTMLElement);
    await screen.findByText("Showing 100 of 137");
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument(); // the other queue did not move
    await user.click(loadMoreRequests() as HTMLElement);
    await screen.findByText("Showing 137 of 137");
    expect(loadMoreRequests()).not.toBeInTheDocument();

    const names = reviewButtons().map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length); // no duplicates
    const requestNames = names.filter((name) => name?.includes("request from"));
    expect(requestNames).toHaveLength(137);
    for (let index = 0; index < 137; index += 1) {
      expect(requestNames).toContain(
        `Review request from Requester ${String(index).padStart(4, "0")} at Botany`
      ); // none skipped
    }

    await user.click(screen.getByRole("button", { name: /Load more reschedule requests/ }));
    await screen.findByText("Showing 100 of 120");
    const pages = (kind: string) =>
      served.calls.filter((call) => call.kind === kind && call.limit === 50).map((call) => call.offset);
    expect(pages("requests")).toEqual([0, 50, 100]);
    expect(pages("changes")).toEqual([0, 50]);
  });

  it("keeps what is loaded when a later page fails, and carries on from there on retry", async () => {
    const served = serveQueues(137, 3);
    const original = client.listInspectionBookings.getMockImplementation()!;
    let failNext = false;
    client.listInspectionBookings.mockImplementation(async (options: { offset?: number; hasPendingChange?: boolean }) => {
      if (failNext && (options.offset ?? 0) === 50 && !options.hasPendingChange) {
        failNext = false;
        throw new Error("Gateway timeout");
      }
      return original(options);
    });
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await user.click(screen.getByRole("tab", { name: /Pending requests/ }));
    await screen.findByText("Showing 50 of 137");

    failNext = true;
    await user.click(screen.getByRole("button", { name: /Load more booking requests/ }));
    const alert = await screen.findByText(/the 50 already loaded are still shown/);
    expect(alert).toHaveTextContent("Gateway timeout");
    expect(reviewButtons().filter((button) => button.getAttribute("aria-label")?.includes("request from"))).toHaveLength(50);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Showing 100 of 137");
    const names = reviewButtons().map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(
      served.calls.filter((call) => call.kind === "requests" && call.limit === 50).map((call) => call.offset)
    ).toEqual([0, 50]); // the failed attempt at 50 never reached the server; the retry resumed there
  });

  it("shows the badge from the server totals before the tab is ever opened", async () => {
    const served = serveQueues(137, 120);
    renderWorkspace();
    await ready();
    expect(await screen.findByLabelText("257 waiting")).toBeInTheDocument();
    // Counting needed no more than a one-row read of each queue.
    expect(served.calls.every((call) => call.limit === 1)).toBe(true);
  });
});

describe("the inspector roster beyond one page", () => {
  function serveUsers(activeInspectors: number) {
    const users = [
      ...Array.from({ length: activeInspectors }, (_, index) => ({
        id: `ins-${String(index).padStart(3, "0")}`,
        displayName: `Inspector ${String(index).padStart(3, "0")}`,
        role: "INSPECTOR",
        accountStatus: "ACTIVE"
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `off-${index}`,
        displayName: `Retired ${index}`,
        role: "INSPECTOR",
        accountStatus: "DISABLED"
      })),
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `adm-${index}`,
        displayName: `Office ${index}`,
        role: "HMS_ADMIN",
        accountStatus: "ACTIVE"
      }))
    ];
    const calls: Array<{ limit: number; offset: number }> = [];
    client.listAdminUsers.mockImplementation(async (options: { limit: number; offset: number }) => {
      calls.push({ limit: options.limit, offset: options.offset });
      // A user near a page boundary can appear on two pages if the list shifts between requests.
      const overlap = options.offset > 0 ? 1 : 0;
      return {
        total: users.length,
        items: users.slice(Math.max(options.offset - overlap, 0), options.offset + options.limit)
      };
    });
    return { calls, users };
  }

  const filterOptions = async () =>
    within(screen.getByRole("group", { name: "Schedule filters" }).querySelector("select") as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("pages through every active inspector with bounded requests, once", async () => {
    const served = serveUsers(130);
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await waitFor(() => expect(served.calls.length).toBe(Math.ceil(167 / 100)));
    expect(served.calls.every((call) => call.limit <= 100)).toBe(true);
    expect(served.calls.map((call) => call.offset)).toEqual([0, 100]);

    const options = await waitFor(async () => {
      const found = await filterOptions();
      expect(found).toContain("Inspector 129");
      return found;
    });
    expect(options.filter((name) => name === "Inspector 129")).toHaveLength(1); // not duplicated
    expect(options.filter((name) => name?.startsWith("Inspector "))).toHaveLength(130);
    expect(options.some((name) => name?.startsWith("Retired"))).toBe(false);
    expect(options.some((name) => name?.startsWith("Office"))).toBe(false);

    // Moving through dates does not read the whole roster again.
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(served.calls).toHaveLength(2);
  });

  it("offers an inspector from a later page for assignment and for reschedule", async () => {
    serveUsers(130);
    client.approveInspectionBooking.mockResolvedValue(undefined);
    client.listAllAssets.mockResolvedValue({
      total: 1,
      items: [
        {
          id: "b3-a0",
          assetNumber: "HOS-1",
          customer: { id: "cust-orica", code: "O", name: "Orica" },
          location: { id: "loc-kwinana", name: "Kwinana", schedulingTimezone: PERTH }
        }
      ]
    });
    client.listInspectionAvailability.mockResolvedValue([
      { quoteId: "quote-1", startsAt: "2027-03-08T01:00:00Z", endsAt: "2027-03-08T02:00:00Z", expiresAt: "2027-03-01T05:00:00Z" }
    ]);
    client.requestInspectionBookingReschedule.mockResolvedValue({ id: "chg" });
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    await waitFor(async () => expect(await filterOptions()).toContain("Inspector 129"));

    // Assignment
    await user.click(screen.getByRole("button", { name: /Unassigned, Awaiting approval/ }));
    let drawer = await screen.findByRole("dialog");
    await user.selectOptions(within(drawer).getByLabelText("Inspector to assign"), "ins-129");
    await user.click(within(drawer).getByRole("button", { name: "Assign & approve" }));
    await waitFor(() => expect(client.approveInspectionBooking).toHaveBeenCalledWith("b4", "ins-129"));
    await user.click(within(drawer).getByRole("button", { name: "Close appointment details" }));

    // Reschedule / reassignment
    await user.click(screen.getByRole("button", { name: /Orica, Kwinana, Ben Brook/ }));
    drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Request reschedule" }));
    const form = (await screen.findByRole("heading", { name: "Request reschedule" })).closest("form") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Preferred inspection date"), { target: { value: "2027-03-08" } });
    await user.selectOptions(await within(form).findByLabelText("Available inspection time"), "quote-1");
    const picker = within(form).getByLabelText("Inspector for rescheduled inspection");
    expect(within(picker).getAllByRole("option", { name: "Inspector 129" })).toHaveLength(1);
    await user.selectOptions(picker, "ins-129");
    await user.click(within(form).getByRole("button", { name: "Request reschedule" }));
    await waitFor(() =>
      expect(client.requestInspectionBookingReschedule).toHaveBeenCalledWith(
        "b3",
        expect.objectContaining({ inspectorUserId: "ins-129" })
      )
    );
  });

  it("keeps what loaded, and the inspectors seen in the schedule, when a roster page fails", async () => {
    serveUsers(130);
    const original = client.listAdminUsers.getMockImplementation()!;
    let failed = false;
    client.listAdminUsers.mockImplementation(async (options: { limit: number; offset: number }) => {
      if (options.offset > 0 && !failed) {
        failed = true;
        throw new Error("Users unavailable");
      }
      return original(options);
    });
    const user = userEvent.setup();
    renderWorkspace();
    await ready();
    expect(await screen.findByText(/Not every inspector could be loaded/)).toHaveTextContent("Users unavailable");
    const partial = await filterOptions();
    expect(partial).toContain("Inspector 099"); // first page
    expect(partial).not.toContain("Inspector 129"); // second page missing
    expect(partial).toContain("Ada Archer"); // still represented from the schedule

    await user.click(within(screen.getByText(/Not every inspector could be loaded/).closest("div") as HTMLElement).getByRole("button", { name: /Try again/ }));
    await waitFor(async () => expect(await filterOptions()).toContain("Inspector 129"));
  });
});

describe("Pending badge", () => {
  const badge = () => screen.queryByLabelText(/\d+ waiting/);

  it("stays hidden while either count read has failed, rather than understating the queue", async () => {
    client.listInspectionBookings.mockImplementation(async (options: { hasPendingChange?: boolean }) => {
      if (options.hasPendingChange) throw new Error("Count unavailable");
      return { total: 4, items: [], etag: null };
    });
    renderWorkspace();
    await ready();
    await waitFor(() => expect(client.listInspectionBookings).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badge()).toBeNull();
  });

  it("shows the sum once both totals are known", async () => {
    serveQueues(4, 3);
    renderWorkspace();
    await ready();
    expect(await screen.findByLabelText("7 waiting")).toBeInTheDocument();
  });
});
