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

/**
 * An axis that ends on a round number, with evenly spaced whole-number ticks. The step
 * is chosen from a round series first, then the top is rounded up to a multiple of it,
 * so the gaps are even (0, 5, 10, 15) rather than the uneven run that dividing a maximum
 * by a fixed count and rounding produces (0, 4, 8, 11, 15).
 */
export function axisTicks(peak: number, count = 4): { top: number; ticks: number[] } {
  if (peak <= 0) return { top: 1, ticks: [0, 1] };
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, peak / count)));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((unit) => Math.max(1, Math.round(unit * magnitude)))
      .find((candidate) => peak / candidate <= count) ?? Math.max(1, Math.round(10 * magnitude));
  const top = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) {
    ticks.push(value);
  }
  return { top, ticks };
}

/** A reporting instant in the organisation's zone, named so the reader knows which. */
export function formatReportingTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short"
  }).format(new Date(value));
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
  // A week bucket ends at the start of the next one, so name the day holding its last
  // instant. Subtracting 24 hours would land on the wrong date across a daylight-saving
  // change, where a local day is 23 or 25 hours long.
  const lastDay = new Date(new Date(end).getTime() - 1);
  const to = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    timeZone
  }).format(lastDay);
  return `${from} to ${to}`;
}

/**
 * The bucket an instant belongs to, or the nearest one when it falls outside them all.
 * Buckets are not evenly spaced: a daylight-saving day is 23 or 25 hours, and the first
 * and last bucket of a period are clipped to it, so a position cannot be turned into an
 * index by dividing the width evenly.
 */
export function nearestBucketIndex(
  buckets: ReadonlyArray<{ start: string; end: string }>,
  time: number
): number | null {
  if (buckets.length === 0 || Number.isNaN(time)) return null;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  buckets.forEach((bucket, index) => {
    const start = new Date(bucket.start).getTime();
    const end = new Date(bucket.end).getTime();
    const gap = time >= start && time < end ? 0 : Math.abs(start - time);
    if (gap < distance) {
      distance = gap;
      nearest = index;
    }
  });
  return nearest;
}

/** Indices of at most `max` labels, always including the first and last. */
export function labelIndices(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, index) => index);
  const step = (length - 1) / (max - 1);
  const picked = Array.from({ length: max }, (_, index) => Math.round(index * step));
  return Array.from(new Set(picked));
}
