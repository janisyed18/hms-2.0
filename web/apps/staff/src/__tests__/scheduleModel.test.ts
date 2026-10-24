import { describe, expect, it } from "vitest";

import { visitTimes } from "../components/scheduling/TimeGrid";
import type { InspectionBookingRecord } from "../domain/types";
import {
  UNASSIGNED,
  buildLanes,
  conflictIds,
  formatDuration,
  monthGrid,
  placeEntries,
  rangeFor,
  snapshotClock,
  statusOf,
  toEntry,
  workloadLabel
} from "../scheduling/scheduleModel";

const SYDNEY = "Australia/Sydney";

function booking(
  id: string,
  start: string,
  end: string,
  overrides: Partial<InspectionBookingRecord> = {}
): InspectionBookingRecord {
  return {
    id,
    customer: { id: "c", code: "C", name: "Customer" },
    location: {
      id: "l",
      name: "Site",
      address1: null,
      address2: null,
      city: null,
      state: null,
      country: null,
      schedulingTimezone: SYDNEY
    },
    assets: [],
    scheduledAt: start,
    scheduledEndAt: end,
    additionalInformation: null,
    status: "APPROVED",
    requestedByUserId: "u",
    inspectorUserId: "insp",
    reviewedByUserId: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: "2027-01-01T00:00:00Z",
    appointment: {
      id: `${id}-a`,
      status: "CONFIRMED",
      startsAt: start,
      endsAt: end,
      revisionNumber: 1,
      timezoneId: SYDNEY,
      localStartSnapshot: "2027-03-01T11:00:00",
      localEndSnapshot: "2027-03-01T12:00:00",
      utcOffsetStart: "+11:00",
      utcOffsetEnd: "+11:00",
      tzdataVersion: "x"
    },
    changeRequests: [],
    ...overrides
  };
}

const names = new Map([["insp", "Ada"], ["other", "Ben"]]);
const entry = (id: string, start: string, end: string, overrides: Partial<InspectionBookingRecord> = {}) =>
  toEntry(booking(id, start, end, overrides), names);

describe("status mapping", () => {
  it("reads existing server state, never inventing one", () => {
    expect(statusOf(booking("a", "2027-03-01T00:00:00Z", "2027-03-01T01:00:00Z"))).toBe("confirmed");
    expect(statusOf(booking("a", "x", "y", { status: "PENDING_APPROVAL", appointment: null }))).toBe("pending");
    expect(statusOf(booking("a", "x", "y", { status: "REJECTED", appointment: null }))).toBe("declined");
    expect(statusOf(booking("a", "x", "y", { status: "CANCELLED" }))).toBe("cancelled");
    const done = booking("a", "x", "y");
    done.appointment!.status = "COMPLETED";
    expect(statusOf(done)).toBe("completed");
    done.appointment!.status = "NO_SHOW";
    expect(statusOf(done)).toBe("no-show");
    const asked = booking("a", "x", "y", {
      changeRequests: [{ id: "c", status: "PENDING_ADMIN_APPROVAL", startsAt: "x", endsAt: "y", reason: null, emergency: false, createdAt: "x" }]
    });
    expect(statusOf(asked)).toBe("change-requested");
    asked.changeRequests[0].status = "APPLIED";
    expect(statusOf(asked)).toBe("confirmed");
  });
});

describe("conflicts and workload", () => {
  it("flags only the same inspector overlapping, ignoring cancelled and unassigned visits", () => {
    const a = entry("a", "2027-03-01T00:00:00Z", "2027-03-01T02:00:00Z");
    const b = entry("b", "2027-03-01T01:00:00Z", "2027-03-01T03:00:00Z");
    const touching = entry("c", "2027-03-01T03:00:00Z", "2027-03-01T04:00:00Z");
    const otherInspector = entry("d", "2027-03-01T01:00:00Z", "2027-03-01T02:00:00Z", { inspectorUserId: "other" });
    const cancelled = entry("e", "2027-03-01T01:00:00Z", "2027-03-01T02:00:00Z", { status: "CANCELLED" });
    const unassigned = entry("f", "2027-03-01T01:00:00Z", "2027-03-01T02:00:00Z", { inspectorUserId: null, status: "PENDING_APPROVAL", appointment: null });
    expect([...conflictIds([a, b, touching, otherInspector, cancelled, unassigned])].sort()).toEqual(["a", "b"]);
  });

  it("describes workload as a count and scheduled time, not as remaining capacity", () => {
    const entries = [
      entry("a", "2027-03-01T00:00:00Z", "2027-03-01T02:00:00Z"),
      entry("b", "2027-03-01T03:00:00Z", "2027-03-01T04:30:00Z"),
      entry("u", "2027-03-01T05:00:00Z", "2027-03-01T06:00:00Z", { inspectorUserId: null, status: "PENDING_APPROVAL", appointment: null })
    ];
    const lanes = buildLanes(entries, [{ id: "insp", name: "Ada" }, { id: "idle", name: "Zed" }], false);
    expect(lanes.map((lane) => lane.name)).toEqual([UNASSIGNED, "Ada"]);
    expect(workloadLabel(lanes[1])).toBe("2 visits · 3h 30m scheduled");
    expect(workloadLabel(lanes[0])).toBe("1 visit to assign");
    expect(buildLanes(entries, [{ id: "idle", name: "Zed" }], true).map((lane) => lane.name)).toContain("Zed");
    expect(formatDuration(45)).toBe("45m");
  });
});

describe("placement", () => {
  it("puts overlapping visits side by side and others at full width", () => {
    const a = entry("a", "2027-03-01T00:00:00Z", "2027-03-01T02:00:00Z");
    const b = entry("b", "2027-03-01T01:00:00Z", "2027-03-01T03:00:00Z");
    const c = entry("c", "2027-03-01T04:00:00Z", "2027-03-01T05:00:00Z");
    const placed = placeEntries([a, b, c], "2027-03-01", SYDNEY);
    const byId = Object.fromEntries(placed.map((item) => [item.entry.id, item]));
    expect([byId.a.columns, byId.b.columns, byId.c.columns]).toEqual([2, 2, 1]);
    expect(byId.a.column).not.toBe(byId.b.column);
    // 00:00Z is 11:00 in Sydney: 660 elapsed minutes into the day.
    expect(byId.a.startMin).toBe(11 * 60);
    expect(byId.a.endMin - byId.a.startMin).toBe(120);
  });

  it("counts elapsed time on a 25-hour daylight-saving day", () => {
    // 4 April 2027 in Sydney: clocks go back at 3am. 09:00 AEST is ten elapsed hours in.
    const visit = entry("a", "2027-04-03T23:00:00Z", "2027-04-04T00:00:00Z");
    expect(placeEntries([visit], "2027-04-04", SYDNEY)[0].startMin).toBe(10 * 60);
  });

  it("builds a six-week Monday-first month with counts per local day", () => {
    const weeks = monthGrid(
      [entry("a", "2027-03-01T00:00:00Z", "2027-03-01T01:00:00Z"), entry("b", "2027-03-31T13:30:00Z", "2027-03-31T14:30:00Z")],
      "2027-03-15",
      SYDNEY
    );
    expect(weeks).toHaveLength(6);
    expect(weeks[0][0].ymd).toBe("2027-03-01");
    expect(weeks[0][0].total).toBe(1);
    // 13:30Z on 31 March is 00:30 on 1 April in Sydney.
    const april1 = weeks.flat().find((day) => day.ymd === "2027-04-01");
    expect(april1?.total).toBe(1);
    expect(april1?.inMonth).toBe(false);
  });
});

describe("ranges", () => {
  it("bounds every view by whole local days", () => {
    const day = rangeFor("day", "2027-03-01", SYDNEY);
    expect([day.start.toISOString(), day.end.toISOString()]).toEqual(["2027-02-28T13:00:00.000Z", "2027-03-01T13:00:00.000Z"]);
    const week = rangeFor("week", "2027-03-04", SYDNEY);
    expect(week.firstDay).toBe("2027-03-01");
    expect(week.days).toBe(7);
    const month = rangeFor("month", "2027-03-17", SYDNEY);
    expect(month.firstDay).toBe("2027-03-01");
    expect(month.days).toBe(42);
  });
});

describe("persisted time of a visit", () => {
  it("shows the stored local-time snapshot, even if today's tz rules would compute another time", () => {
    const visit = entry("a", "2027-03-01T00:00:00Z", "2027-03-01T01:00:00Z");
    visit.booking.appointment!.localStartSnapshot = "2027-03-01T10:30:00";
    visit.booking.appointment!.localEndSnapshot = "2027-03-01T11:30:00";
    expect(visitTimes(visit, SYDNEY)).toBe("10:30 am to 11:30 am");
    expect(snapshotClock("2027-03-01T00:05:00")).toBe("12:05 am");
    expect(snapshotClock("2027-03-01T13:00:00")).toBe("1:00 pm");
  });

  it("computes the time from the instant, in the location's zone, when there is no appointment yet", () => {
    const requested = entry("r", "2027-03-01T01:00:00Z", "2027-03-01T02:00:00Z", {
      status: "PENDING_APPROVAL",
      appointment: null,
      inspectorUserId: null,
      location: { ...booking("x", "a", "b").location, schedulingTimezone: "Australia/Perth" }
    });
    expect(visitTimes(requested, "Australia/Perth")).toBe("9:00 am to 10:00 am");
    expect(visitTimes(requested, SYDNEY)).toMatch(/^9:00 am to 10:00 am AWST$/);
  });
});
