/**
 * Calendar arithmetic in an explicit IANA time zone.
 *
 * The Staff calendar must describe an appointment the way its location does, never the
 * way the viewer's browser happens to be set. Everything here takes the zone as an
 * argument; nothing reads the browser's zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric"
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(instant: Date | string | number, timeZone: string): ZonedParts {
  const found: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return {
    year: found.year,
    month: found.month,
    day: found.day,
    hour: found.hour === 24 ? 0 : found.hour,
    minute: found.minute
  };
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // The formatter drops seconds, so compare against the instant truncated to the minute.
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function toYmd(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function parseYmd(ymd: string): { year: number; month: number; day: number } {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
}

/** The local calendar date of `instant` in `timeZone`. */
export function ymdOf(instant: Date | string | number, timeZone: string): string {
  return toYmd(zonedParts(instant, timeZone));
}

export function addDays(ymd: string, days: number): string {
  const { year, month, day } = parseYmd(ymd);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return toYmd({
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate()
  });
}

export function addMonths(ymd: string, months: number): string {
  const { year, month, day } = parseYmd(ymd);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return toYmd({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: Math.min(day, last)
  });
}

/** 0 = Monday ... 6 = Sunday for a calendar date. */
export function weekdayIndex(ymd: string): number {
  const { year, month, day } = parseYmd(ymd);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

export function startOfWeek(ymd: string): string {
  return addDays(ymd, -weekdayIndex(ymd));
}

export function startOfMonth(ymd: string): string {
  const { year, month } = parseYmd(ymd);
  return toYmd({ year, month, day: 1 });
}

export function daysBetween(fromYmd: string, toYmdValue: string): number {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmdValue);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) /
      86_400_000
  );
}

/** The UTC instant at which `timeZone`'s wall clock first reads 00:00 on `ymd`. */
export function zonedMidnight(ymd: string, timeZone: string): number {
  const { year, month, day } = parseYmd(ymd);
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  // The offset at the first guess can differ from the offset at midnight itself when
  // a transition falls in between; one correction settles it.
  guess = wall - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** Real length of a local day: 23, 24 or 25 hours around a daylight-saving change. */
export function dayLengthMinutes(ymd: string, timeZone: string): number {
  return (zonedMidnight(addDays(ymd, 1), timeZone) - zonedMidnight(ymd, timeZone)) / 60_000;
}

/** Elapsed minutes from local midnight of `ymd` to `instant` (not clock-face minutes). */
export function minutesIntoDay(
  instant: Date | string | number,
  ymd: string,
  timeZone: string
): number {
  return (new Date(instant).getTime() - zonedMidnight(ymd, timeZone)) / 60_000;
}

export function formatTime(instant: Date | string | number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  })
    .format(new Date(instant))
    .replace(/\s?([ap])m$/i, (_, meridiem: string) => ` ${meridiem.toLowerCase()}m`);
}

export function formatDateTime(instant: Date | string | number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(instant));
}

/** A short zone label such as "AEDT" or "GMT+8" for `instant` in `timeZone`. */
export function zoneLabel(instant: Date | string | number, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-AU", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(instant))
    .find((item) => item.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** A calendar date (not an instant) as text; the zone is fixed to UTC on purpose. */
export function formatYmd(
  ymd: string,
  options: Intl.DateTimeFormatOptions
): string {
  const { year, month, day } = parseYmd(ymd);
  return new Intl.DateTimeFormat("en-AU", { ...options, timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );
}
