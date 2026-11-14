/**
 * Shared chart pieces. D3 is used for scales and shapes only: React owns every element,
 * so there is no `d3-selection`, no `d3-axis`, and nothing mutates the DOM behind React.
 *
 * Time is never re-derived on the client. Bucket boundaries come from the server, and
 * labels are formatted in the organisation's timezone that the API reports.
 */

export const CHART_SERIES_COUNT = 6;

/** Dash patterns, so series stay separable without colour. */
export const seriesDash = ["none", "7 4", "2 3", "10 4 2 4", "1 4", "12 5"] as const;

export interface ChartFrame {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  innerWidth: number;
  innerHeight: number;
}

export function chartFrame(
  width: number,
  height: number,
  margin: { top: number; right: number; bottom: number; left: number }
): ChartFrame {
  return {
    width,
    height,
    margin,
    innerWidth: Math.max(1, width - margin.left - margin.right),
    innerHeight: Math.max(1, height - margin.top - margin.bottom)
  };
}

/** A "nice" upper bound so the y-axis has readable ticks and some headroom. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  if (value <= 5) return value;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** At most `count` evenly spaced whole-number ticks, including 0 and the maximum. */
export function countTicks(max: number, count = 4): number[] {
  const top = niceMax(max);
  const raw = Array.from({ length: count + 1 }, (_, index) => (top / count) * index);
  const whole = raw.map((value) => Math.round(value));
  return Array.from(new Set(whole)).filter((value) => value <= top);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-AU").format(value);
}

export function formatBucketStart(
  start: string,
  granularity: string,
  timeZone: string
): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === "hour"
      ? { hour: "numeric", timeZone }
      : granularity === "week"
        ? { day: "numeric", month: "short", timeZone }
        : { day: "numeric", month: "short", timeZone };
  return new Intl.DateTimeFormat("en-AU", options).format(new Date(start));
}

/** What one bucket covers, said in full: used by the tooltip and the readout. */
export function formatBucketRange(
  start: string,
  end: string,
  granularity: string,
  timeZone: string
): string {
  if (granularity === "hour") {
    const from = new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      timeZone
    }).format(new Date(start));
    const to = new Intl.DateTimeFormat("en-AU", { hour: "numeric", timeZone }).format(
      new Date(end)
    );
    return `${from} to ${to}`;
  }
  const from = new Intl.DateTimeFormat("en-AU", {
    weekday: granularity === "day" ? "short" : undefined,
    day: "numeric",
    month: "short",
    timeZone
  }).format(new Date(start));
  if (granularity === "day") return from;
  // A week bucket ends at the start of the next one, so name its last day.
  const lastDay = new Date(new Date(end).getTime() - 86_400_000);
  const to = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    timeZone
  }).format(lastDay);
  return `${from} to ${to}`;
}

/** Indices of at most `max` labels, always including the first and last. */
export function labelIndices(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, index) => index);
  const step = (length - 1) / (max - 1);
  const picked = Array.from({ length: max }, (_, index) => Math.round(index * step));
  return Array.from(new Set(picked));
}
