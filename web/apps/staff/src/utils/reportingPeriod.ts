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
}

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
  return periodFromBounds(preset, presetConfig[preset].label, start, end);
}

export function reportingPeriodFromDates(startDate: string, endDate: string): ReportingPeriod | null {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const inclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(inclusiveEnd.getTime()) || start > inclusiveEnd) {
    return null;
  }
  const end = new Date(inclusiveEnd);
  end.setUTCDate(end.getUTCDate() + 1);
  return periodFromBounds("custom", formatRangeLabel(start, inclusiveEnd), start, end);
}

function periodFromBounds(
  preset: ReportingPeriodPreset,
  label: string,
  start: Date,
  end: Date
): ReportingPeriod {
  return {
    preset,
    label,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startDate: toInputDate(start),
    endDate: toInputDate(new Date(end.getTime() - 1))
  };
}

function toInputDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatRangeLabel(start: Date, end: Date) {
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${formatDate(start, !sameYear)} - ${formatDate(end, true)}`;
}

function formatDate(value: Date, includeYear: boolean) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
    timeZone: "UTC"
  }).format(value);
}
