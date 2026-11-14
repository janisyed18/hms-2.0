export type ReportingPeriodPreset =
  | "last_hour"
  | "last_day"
  | "last_week"
  | "last_month"
  | "last_three_months"
  | "custom";

export interface ReportingPeriod {
  preset: ReportingPeriodPreset;
  label: string;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
  /** The IANA zone the calendar dates belong to. Presets are rolling, so they have none. */
  timeZone?: string;
}

/**
 * The reporting period selects *activity*. Current status (overdue retests, fleet status,
 * certificate coverage) is a snapshot the server measures at request time and does not
 * filter by this period.
 */
export const REPORTING_PERIOD_SCOPE_NOTE =
  "The period changes activity figures only, not current fleet status.";

const presetConfig: Record<Exclude<ReportingPeriodPreset, "custom">, { label: string; milliseconds: number }> = {
  last_hour: { label: "Last 1 hour", milliseconds: 60 * 60 * 1_000 },
  last_day: { label: "Last 1 day", milliseconds: 24 * 60 * 60 * 1_000 },
  last_week: { label: "Last 1 week", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  last_month: { label: "Last 1 month", milliseconds: 30 * 24 * 60 * 60 * 1_000 },
  last_three_months: { label: "Last 3 months", milliseconds: 90 * 24 * 60 * 60 * 1_000 }
};

export function reportingPeriodForPreset(
  preset: Exclude<ReportingPeriodPreset, "custom">,
  now = new Date()
): ReportingPeriod {
  const end = new Date(now);
  const start = new Date(now.getTime() - presetConfig[preset].milliseconds);
  return {
    preset,
    label: presetConfig[preset].label,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startDate: toInputDate(start),
    endDate: toInputDate(new Date(end.getTime() - 1))
  };
}

/**
 * A custom range covers whole calendar days in the organisation's timezone: the chosen
 * dates run from the start of the first day to the start of the day after the last one,
 * so the API window stays half-open and includes no extra day. Without a timezone the
 * dates are read as UTC, which is only correct until the server has told us its zone.
 */
export function reportingPeriodFromDates(
  startDate: string,
  endDate: string,
  timeZone?: string
): ReportingPeriod | null {
  const start = zonedDayStart(startDate, timeZone);
  const inclusiveEnd = zonedDayStart(endDate, timeZone);
  if (!start || !inclusiveEnd || start.getTime() > inclusiveEnd.getTime()) {
    return null;
  }
  const end = zonedDayStart(addDays(endDate, 1), timeZone);
  if (!end) {
    return null;
  }
  return {
    preset: "custom",
    label: formatRangeLabel(startDate, endDate, timeZone),
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startDate,
    endDate,
    ...(timeZone ? { timeZone } : {})
  };
}

/** Re-anchor an existing custom range once the organisation timezone is known. */
export function withReportingTimeZone(period: ReportingPeriod, timeZone: string): ReportingPeriod {
  if (period.preset !== "custom" || period.timeZone === timeZone) {
    return period;
  }
  return reportingPeriodFromDates(period.startDate, period.endDate, timeZone) ?? period;
}

function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  if (!parsed) return date;
  const moved = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return moved.toISOString().slice(0, 10);
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** The instant a calendar day begins in `timeZone` (UTC when none is given). */
function zonedDayStart(date: string, timeZone?: string): Date | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const asUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!timeZone) return new Date(asUtc);
  // The zone's offset depends on the instant, and the instant on the offset, so apply
  // the offset once and correct with the offset that actually holds there. One pass is
  // enough: the two differ only across a transition, and the corrected guess is past it.
  const guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  const instant = asUtc - zoneOffsetMs(guess, timeZone);
  return new Date(instant);
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(instant));
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const local = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second")
  );
  return local - instant;
}

function toInputDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatRangeLabel(startDate: string, endDate: string, timeZone?: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end) return `${startDate} - ${endDate}`;
  const sameYear = start.year === end.year;
  return `${formatDate(startDate, !sameYear)} - ${formatDate(endDate, true)}`;

  function formatDate(value: string, includeYear: boolean) {
    const parsed = parseDate(value);
    if (!parsed) return value;
    // Formatted from a UTC instant in UTC, so the printed date is the chosen date
    // itself, whatever the viewer's or the organisation's zone.
    void timeZone;
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      ...(includeYear ? { year: "numeric" } : {}),
      timeZone: "UTC"
    }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
  }
}
