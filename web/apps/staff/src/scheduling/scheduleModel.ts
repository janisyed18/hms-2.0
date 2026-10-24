import type { InspectionBookingRecord } from "../domain/types";
import {
  addDays,
  dayLengthMinutes,
  minutesIntoDay,
  startOfWeek,
  weekdayIndex,
  ymdOf,
  zonedMidnight
} from "./zonedTime";

/**
 * How the server's booking and appointment states read on a calendar.
 *
 * These are presentation groups mapped from existing server state; there is no
 * frontend-only status. See `statusOf`.
 */
export type ScheduleStatus =
  | "pending"
  | "change-requested"
  | "confirmed"
  | "completed"
  | "no-show"
  | "cancelled"
  | "declined";

export const STATUS_META: Record<
  ScheduleStatus,
  { label: string; hint: string }
> = {
  pending: { label: "Awaiting approval", hint: "Requested; no inspector yet" },
  "change-requested": {
    label: "Change requested",
    hint: "Confirmed, with a reschedule waiting"
  },
  confirmed: { label: "Confirmed", hint: "Approved with an inspector" },
  completed: { label: "Completed", hint: "Visit finished" },
  "no-show": { label: "No show", hint: "Visit did not take place" },
  cancelled: { label: "Cancelled", hint: "Booking cancelled" },
  declined: { label: "Declined", hint: "Request declined" }
};

export const STATUS_ORDER: ScheduleStatus[] = [
  "pending",
  "change-requested",
  "confirmed",
  "completed",
  "no-show",
  "cancelled",
  "declined"
];

const PENDING_CHANGE = ["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"];

export function hasPendingChange(booking: InspectionBookingRecord): boolean {
  return booking.changeRequests.some((change) => PENDING_CHANGE.includes(change.status));
}

export function statusOf(booking: InspectionBookingRecord): ScheduleStatus {
  if (booking.status === "REJECTED") return "declined";
  if (booking.status === "CANCELLED") return "cancelled";
  if (booking.status === "PENDING_APPROVAL") return "pending";
  const appointment = booking.appointment?.status;
  if (appointment === "CANCELLED") return "cancelled";
  if (appointment === "COMPLETED") return "completed";
  if (appointment === "NO_SHOW") return "no-show";
  return hasPendingChange(booking) ? "change-requested" : "confirmed";
}

/** Statuses whose time is actually held, so they count towards workload and conflicts. */
const HELD: ScheduleStatus[] = ["change-requested", "confirmed", "completed", "no-show"];

export interface ScheduleEntry {
  id: string;
  booking: InspectionBookingRecord;
  start: number;
  end: number;
  status: ScheduleStatus;
  customerName: string;
  locationName: string;
  /** The location's scheduling zone: how this visit is described to people. */
  timeZone: string;
  inspectorId: string | null;
  inspectorName: string;
  assetCount: number;
  pendingChange: boolean;
}

export const UNASSIGNED = "Unassigned";
const DEFAULT_DURATION_MS = 60 * 60_000;

export function toEntry(
  booking: InspectionBookingRecord,
  inspectorNames: ReadonlyMap<string, string>
): ScheduleEntry {
  const start = new Date(booking.scheduledAt).getTime();
  const end = booking.scheduledEndAt
    ? new Date(booking.scheduledEndAt).getTime()
    : start + DEFAULT_DURATION_MS;
  return {
    id: booking.id,
    booking,
    start,
    end: Math.max(end, start + 15 * 60_000),
    status: statusOf(booking),
    customerName: booking.customer.name,
    locationName: booking.location.name,
    timeZone: booking.appointment?.timezoneId ?? booking.location.schedulingTimezone ?? "UTC",
    inspectorId: booking.inspectorUserId,
    inspectorName: booking.inspectorUserId
      ? (inspectorNames.get(booking.inspectorUserId) ?? "Inspector")
      : UNASSIGNED,
    assetCount: booking.assets.length,
    pendingChange: hasPendingChange(booking)
  };
}

export function durationMinutes(entry: ScheduleEntry): number {
  return Math.round((entry.end - entry.start) / 60_000);
}

/** "2h", "1h 30m", "45m". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The time a visit is shown at, in its own location's zone. For a confirmed
 * appointment this is the persisted local-time snapshot, so a later tzdata change can
 * never silently move a visit that was promised at a particular wall-clock time.
 */
export function snapshotClock(snapshot: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(snapshot);
  if (!match) return snapshot;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "pm" : "am";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${match[2]} ${suffix}`;
}

/** Entries that overlap `[from, to)`, i.e. appear on that stretch of the calendar. */
export function entriesWithin(entries: ScheduleEntry[], from: number, to: number) {
  return entries.filter((entry) => entry.start < to && entry.end > from);
}

export function entriesOnDay(entries: ScheduleEntry[], ymd: string, timeZone: string) {
  return entriesWithin(
    entries,
    zonedMidnight(ymd, timeZone),
    zonedMidnight(addDays(ymd, 1), timeZone)
  );
}

function overlaps(a: ScheduleEntry, b: ScheduleEntry) {
  return a.start < b.end && b.start < a.end;
}

/** Visits that double-book the same inspector. Unassigned visits never conflict. */
export function conflictIds(entries: ScheduleEntry[]): Set<string> {
  const held = entries.filter(
    (entry) => entry.inspectorId !== null && HELD.includes(entry.status)
  );
  const flagged = new Set<string>();
  const byInspector = new Map<string, ScheduleEntry[]>();
  for (const entry of held) {
    const list = byInspector.get(entry.inspectorId as string) ?? [];
    list.push(entry);
    byInspector.set(entry.inspectorId as string, list);
  }
  for (const list of byInspector.values()) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let index = 0; index < sorted.length; index += 1) {
      for (let next = index + 1; next < sorted.length; next += 1) {
        if (sorted[next].start >= sorted[index].end) break;
        if (overlaps(sorted[index], sorted[next])) {
          flagged.add(sorted[index].id);
          flagged.add(sorted[next].id);
        }
      }
    }
  }
  return flagged;
}

export interface Lane {
  /** The inspector id, or null for the Unassigned lane. */
  id: string | null;
  name: string;
  entries: ScheduleEntry[];
  visits: number;
  minutes: number;
  conflicts: number;
}

export interface InspectorOption {
  id: string;
  name: string;
}

/**
 * Lanes for one day: an Unassigned lane first (when it has anything), then inspectors
 * by name. Inspectors with no visit are included only when `includeEmpty` says so, so
 * a firm with many inspectors can look at the ones who are working.
 */
export function buildLanes(
  dayEntries: ScheduleEntry[],
  inspectors: InspectorOption[],
  includeEmpty: boolean
): Lane[] {
  const conflicts = conflictIds(dayEntries);
  const grouped = new Map<string | null, ScheduleEntry[]>();
  for (const entry of dayEntries) {
    const list = grouped.get(entry.inspectorId) ?? [];
    list.push(entry);
    grouped.set(entry.inspectorId, list);
  }
  const names = new Map(inspectors.map((inspector) => [inspector.id, inspector.name]));
  for (const entry of dayEntries) {
    if (entry.inspectorId && !names.has(entry.inspectorId)) {
      names.set(entry.inspectorId, entry.inspectorName);
    }
  }
  const ids = new Set<string>(
    [...grouped.keys()].filter((id): id is string => id !== null)
  );
  if (includeEmpty) for (const inspector of inspectors) ids.add(inspector.id);

  const lane = (id: string | null, name: string): Lane => {
    const laneEntries = [...(grouped.get(id) ?? [])].sort((a, b) => a.start - b.start);
    const held = laneEntries.filter((entry) => HELD.includes(entry.status));
    return {
      id,
      name,
      entries: laneEntries,
      visits: id === null ? laneEntries.length : held.length,
      minutes: held.reduce((sum, entry) => sum + durationMinutes(entry), 0),
      conflicts: laneEntries.filter((entry) => conflicts.has(entry.id)).length
    };
  };

  const result: Lane[] = [];
  if (grouped.has(null)) result.push(lane(null, UNASSIGNED));
  [...ids]
    .sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? ""))
    .forEach((id) => result.push(lane(id, names.get(id) ?? "Inspector")));
  return result;
}

/** "4 visits · 6h scheduled": a plain count, not a claim about remaining capacity. */
export function workloadLabel(lane: Lane): string {
  const visits = `${lane.visits} ${lane.visits === 1 ? "visit" : "visits"}`;
  return lane.id === null ? `${visits} to assign` : `${visits} · ${formatDuration(lane.minutes)} scheduled`;
}

export interface PlacedEntry {
  entry: ScheduleEntry;
  /** Elapsed minutes from local midnight, clipped to the day. */
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
}

/** Position a lane's entries on a day grid and side-by-side any that overlap. */
export function placeEntries(
  laneEntries: ScheduleEntry[],
  ymd: string,
  timeZone: string
): PlacedEntry[] {
  const length = dayLengthMinutes(ymd, timeZone);
  const sorted = [...laneEntries].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: ScheduleEntry[][] = [];
  let groupEnd = -Infinity;
  for (const entry of sorted) {
    if (entry.start >= groupEnd) groups.push([]);
    groups[groups.length - 1].push(entry);
    groupEnd = Math.max(groupEnd, entry.end);
  }
  const placed: PlacedEntry[] = [];
  for (const group of groups) {
    const columnEnds: number[] = [];
    const assigned: Array<{ entry: ScheduleEntry; column: number }> = [];
    for (const entry of group) {
      let column = columnEnds.findIndex((end) => end <= entry.start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(entry.end);
      } else {
        columnEnds[column] = entry.end;
      }
      assigned.push({ entry, column });
    }
    for (const { entry, column } of assigned) {
      const from = Math.max(0, minutesIntoDay(entry.start, ymd, timeZone));
      const to = Math.min(length, minutesIntoDay(entry.end, ymd, timeZone));
      placed.push({
        entry,
        startMin: from,
        endMin: Math.max(to, from + 15),
        column,
        columns: columnEnds.length
      });
    }
  }
  return placed;
}

export interface MonthDay {
  ymd: string;
  inMonth: boolean;
  total: number;
  unassigned: number;
  byStatus: Partial<Record<ScheduleStatus, number>>;
  conflicts: number;
}

/** Six-week grid (Monday first) with a count per day; `anchorMonth` is YYYY-MM-DD. */
export function monthGrid(
  entries: ScheduleEntry[],
  anchorMonth: string,
  timeZone: string
): MonthDay[][] {
  const first = `${anchorMonth.slice(0, 7)}-01`;
  const gridStart = startOfWeek(first);
  const conflicts = conflictIds(entries);
  const weeks: MonthDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const row: MonthDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const ymd = addDays(gridStart, week * 7 + day);
      const onDay = entriesOnDay(entries, ymd, timeZone);
      const byStatus: MonthDay["byStatus"] = {};
      for (const entry of onDay) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
      row.push({
        ymd,
        inMonth: ymd.slice(0, 7) === first.slice(0, 7),
        total: onDay.length,
        unassigned: onDay.filter((entry) => entry.inspectorId === null).length,
        byStatus,
        conflicts: onDay.filter((entry) => conflicts.has(entry.id)).length
      });
    }
    weeks.push(row);
  }
  return weeks;
}

export type CalendarMode = "day" | "week" | "month";

/** The inclusive-start, exclusive-end UTC range a view must load. */
export function rangeFor(mode: CalendarMode, anchor: string, timeZone: string) {
  let firstDay: string;
  let days: number;
  if (mode === "day") {
    firstDay = anchor;
    days = 1;
  } else if (mode === "week") {
    firstDay = startOfWeek(anchor);
    days = 7;
  } else {
    firstDay = startOfWeek(`${anchor.slice(0, 7)}-01`);
    days = 42;
  }
  return {
    firstDay,
    days,
    start: new Date(zonedMidnight(firstDay, timeZone)),
    end: new Date(zonedMidnight(addDays(firstDay, days), timeZone))
  };
}

export function isWeekend(ymd: string): boolean {
  return weekdayIndex(ymd) >= 5;
}

export function entryDay(entry: ScheduleEntry, timeZone: string): string {
  return ymdOf(entry.start, timeZone);
}

export interface ScheduleFilters {
  inspectorId: string;
  customerId: string;
  locationId: string;
  status: ScheduleStatus | "";
  /** "" = all, "assigned", "unassigned" */
  assignment: "" | "assigned" | "unassigned";
}

export const EMPTY_FILTERS: ScheduleFilters = {
  inspectorId: "",
  customerId: "",
  locationId: "",
  status: "",
  assignment: ""
};

export function activeFilterCount(filters: ScheduleFilters): number {
  return Object.values(filters).filter(Boolean).length;
}

/** The same rules the API applies, applied again so the views can never disagree. */
export function applyFilters(entries: ScheduleEntry[], filters: ScheduleFilters) {
  return entries.filter(
    (entry) =>
      (!filters.inspectorId || entry.inspectorId === filters.inspectorId) &&
      (!filters.customerId || entry.booking.customer.id === filters.customerId) &&
      (!filters.locationId || entry.booking.location.id === filters.locationId) &&
      (!filters.status || entry.status === filters.status) &&
      (filters.assignment !== "unassigned" || entry.inspectorId === null) &&
      (filters.assignment !== "assigned" || entry.inspectorId !== null)
  );
}
