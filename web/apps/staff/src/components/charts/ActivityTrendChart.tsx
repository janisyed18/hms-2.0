import { max as d3Max } from "d3-array";
import { scaleLinear, scaleTime } from "d3-scale";
import { line as d3Line } from "d3-shape";
import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { ActivityBucket, ActivityCounts, ActivityReport } from "../../domain/types";
import {
  axisTicks,
  chartFrame,
  formatBucketRange,
  formatBucketStart,
  formatCount,
  labelIndices,
  nearestBucketIndex,
  seriesDash
} from "./chartPrimitives";

/**
 * The six series the reporting API returns. Each is counted by the server from an exact
 * timestamp; nothing here infers activity from an audit action's wording, and there is
 * no "retests completed" series, because completing a retest only moves its due date and
 * leaves no timestamp to count.
 */
export const ACTIVITY_SERIES = [
  { key: "assetsAdded", label: "Assets added", token: "var(--chart-1)" },
  { key: "inspectionsSubmitted", label: "Inspections submitted", token: "var(--chart-2)" },
  { key: "inspectionsApproved", label: "Inspections approved", token: "var(--chart-3)" },
  { key: "inspectionsRejected", label: "Inspections rejected", token: "var(--chart-4)" },
  { key: "certificatesIssued", label: "Certificates issued", token: "var(--chart-5)" },
  { key: "retestsEscalated", label: "Retests escalated", token: "var(--chart-6)" }
] as const satisfies ReadonlyArray<{
  key: keyof ActivityCounts;
  label: string;
  token: string;
}>;

type SeriesKey = (typeof ACTIVITY_SERIES)[number]["key"];

const VIEW_WIDTH = 760;
const VIEW_HEIGHT = 300;

interface ActivityTrendChartProps {
  activity: ActivityReport;
  /** True while these figures belong to a period other than the one now selected. */
  isStale?: boolean;
}

export function ActivityTrendChart({ activity, isStale = false }: ActivityTrendChartProps) {
  const [hidden, setHidden] = useState<ReadonlySet<SeriesKey>>(() => new Set());
  const [focusedBucket, setFocusedBucket] = useState<number | null>(null);
  const [pointerBucket, setPointerBucket] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const buckets = activity.buckets;
  const visible = ACTIVITY_SERIES.filter((series) => !hidden.has(series.key));
  const frame = chartFrame(VIEW_WIDTH, VIEW_HEIGHT, { top: 12, right: 12, bottom: 34, left: 44 });

  const { x, y, yMax, ticks, paths } = useMemo(() => {
    // An empty report renders the empty state below, so the domain only has to be
     // valid, not meaningful. Nothing here may read the clock: that would make the
     // render impure.
    const first = buckets.length ? new Date(buckets[0].start).getTime() : 0;
    const last = buckets.length ? new Date(buckets[buckets.length - 1].end).getTime() : 1;
    const scaleX = scaleTime()
      .domain([first, last])
      .range([frame.margin.left, frame.margin.left + frame.innerWidth]);
    // The domain follows the series that are shown: hiding the tallest one rescales the
    // axis, while the counts themselves are untouched.
    const peak = d3Max(
      visible.flatMap((series) => buckets.map((bucket) => bucket[series.key]))
    ) ?? 0;
    const { top, ticks: yTicks } = axisTicks(peak);
    const scaleY = scaleLinear()
      .domain([0, top])
      .range([frame.margin.top + frame.innerHeight, frame.margin.top]);
    const built = visible.map((series) => ({
      key: series.key,
      label: series.label,
      token: series.token,
      dash: seriesDash[ACTIVITY_SERIES.findIndex((entry) => entry.key === series.key)],
      d:
        d3Line<ActivityBucket>()
          .x((bucket) => scaleX(new Date(bucket.start)))
          .y((bucket) => scaleY(bucket[series.key]))(buckets) ?? ""
    }));
    return { x: scaleX, y: scaleY, yMax: top, ticks: yTicks, paths: built };
  }, [buckets, frame.innerHeight, frame.innerWidth, frame.margin.left, frame.margin.top, visible]);

  const activeBucket = pointerBucket ?? focusedBucket;
  const labelled = labelIndices(buckets.length, 6);
  // Near an edge the tooltip anchors to that side instead of centring, so it stays
  // inside the panel at narrow widths rather than hanging off it.
  const activeRatio = activeBucket === null
    ? 0.5
    : x(new Date(buckets[activeBucket].start)) / VIEW_WIDTH;
  const tooltipSide = activeRatio < 0.3 ? "start" : activeRatio > 0.7 ? "end" : "center";

  function toggle(key: SeriesKey) {
    setHidden((current) => {
      const next = new Set(current);
      // Never hide the last visible series: an empty chart says nothing.
      if (next.has(key)) next.delete(key);
      else if (current.size < ACTIVITY_SERIES.length - 1) next.add(key);
      return next;
    });
  }

  function bucketFromPointer(clientX: number) {
    const plot = plotRef.current?.getBoundingClientRect();
    if (!plot || plot.width === 0 || buckets.length === 0) return null;
    // Through the x scale, not by dividing the width evenly: the buckets are not all
    // the same length.
    const ratio = (clientX - plot.left) / plot.width;
    const viewX = frame.margin.left + ratio * frame.innerWidth;
    return nearestBucketIndex(buckets, x.invert(viewX).getTime());
  }

  function onPlotKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (buckets.length === 0) return;
    const current = focusedBucket ?? 0;
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: buckets.length - 1
    };
    if (event.key in moves) {
      event.preventDefault();
      setFocusedBucket(Math.min(buckets.length - 1, Math.max(0, moves[event.key])));
      return;
    }
    if (event.key === "Escape" && focusedBucket !== null) {
      event.preventDefault();
      setFocusedBucket(null);
    }
  }

  if (buckets.length === 0) {
    return <p className="trend-empty">No activity was recorded in this period.</p>;
  }

  const readout = activeBucket === null
    ? ""
    : `${formatBucketRange(buckets[activeBucket].start, buckets[activeBucket].end, activity.granularity, activity.timezone)}: ${visible
        .map((series) => `${series.label} ${buckets[activeBucket][series.key]}`)
        .join(", ")}`;

  return (
    <div className={`activity-chart${isStale ? " is-stale" : ""}`}>
      <div className="activity-chart-plot">
        {/* Decorative: the figures are in the summary and table below, and the keyboard
            target is a sibling rather than a child, because a focusable element inside
            an image role is not reliably reachable. */}
        <svg
          aria-hidden="true"
          className="activity-chart-svg"
          preserveAspectRatio="none"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        >
          {ticks.map((tick) => {
            const yPosition = y(tick);
            return (
              <g key={tick}>
                <line
                  className="chart-grid"
                  x1={frame.margin.left}
                  x2={frame.margin.left + frame.innerWidth}
                  y1={yPosition}
                  y2={yPosition}
                />
                <text className="chart-axis-label" textAnchor="end" x={frame.margin.left - 8} y={yPosition + 4}>
                  {formatCount(tick)}
                </text>
              </g>
            );
          })}
          <line
            className="chart-axis"
            x1={frame.margin.left}
            x2={frame.margin.left + frame.innerWidth}
            y1={y(0)}
            y2={y(0)}
          />
          {labelled.map((index) => (
            <text
              className="chart-axis-label"
              key={`x-${index}`}
              textAnchor={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}
              x={x(new Date(buckets[index].start))}
              y={VIEW_HEIGHT - 10}
            >
              {formatBucketStart(buckets[index].start, activity.granularity, activity.timezone)}
            </text>
          ))}
          {paths.map((series) => (
            <path
              className="chart-line"
              d={series.d}
              key={series.key}
              stroke={series.token}
              strokeDasharray={series.dash === "none" ? undefined : series.dash}
            />
          ))}
          {activeBucket !== null ? (
            <g className="chart-marker">
              <line
                x1={x(new Date(buckets[activeBucket].start))}
                x2={x(new Date(buckets[activeBucket].start))}
                y1={frame.margin.top}
                y2={y(0)}
              />
              {visible.map((series) => (
                <circle
                  cx={x(new Date(buckets[activeBucket].start))}
                  cy={y(buckets[activeBucket][series.key])}
                  fill={series.token}
                  key={series.key}
                  r="4"
                />
              ))}
            </g>
          ) : null}
        </svg>
        {/* The keyboard and pointer target, over the plot area: focusable, so the chart
            can be inspected without a mouse, with arrow keys stepping bucket by bucket. */}
        <div
          aria-describedby={`${titleId}-readout`}
          aria-label={`Activity by ${activity.granularity}. Use the arrow keys to read each period.`}
          className="chart-plot-target"
          onBlur={() => setFocusedBucket(null)}
          onFocus={() => setFocusedBucket((current) => current ?? 0)}
          onKeyDown={onPlotKeyDown}
          onPointerLeave={() => setPointerBucket(null)}
          onPointerMove={(event) => setPointerBucket(bucketFromPointer(event.clientX))}
          ref={plotRef}
          role="application"
          style={{
            left: `${(frame.margin.left / VIEW_WIDTH) * 100}%`,
            top: `${(frame.margin.top / VIEW_HEIGHT) * 100}%`,
            width: `${(frame.innerWidth / VIEW_WIDTH) * 100}%`,
            height: `${(frame.innerHeight / VIEW_HEIGHT) * 100}%`
          }}
          tabIndex={0}
        />
        {activeBucket !== null ? (
          <div
            className={`chart-tooltip${tooltipSide === "center" ? "" : ` is-${tooltipSide}`}`}
            style={{
              left: `${(x(new Date(buckets[activeBucket].start)) / VIEW_WIDTH) * 100}%`
            }}
          >
            <strong>
              {formatBucketRange(
                buckets[activeBucket].start,
                buckets[activeBucket].end,
                activity.granularity,
                activity.timezone
              )}
            </strong>
            <dl>
              {visible.map((series) => (
                <div key={series.key}>
                  <dt>
                    <i aria-hidden="true" style={{ background: series.token }} />
                    {series.label}
                  </dt>
                  <dd>{formatCount(buckets[activeBucket][series.key])}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
      <p className="sr-only" id={titleId}>
        {`Recorded activity by ${activity.granularity}, ${activity.timezone}. Series shown: ${visible
          .map((series) => series.label)
          .join(", ")}. Vertical axis maximum ${formatCount(yMax)}. The figures are in the table below.`}
      </p>
      {/* What the pointer or the arrow keys are on, announced without moving focus. */}
      <p aria-live="polite" className="sr-only" id={`${titleId}-readout`}>
        {readout}
      </p>
      <div className="chart-legend" role="group" aria-label="Activity series">
        {ACTIVITY_SERIES.map((series, index) => {
          const isHidden = hidden.has(series.key);
          return (
            <button
              aria-pressed={!isHidden}
              className={`chart-legend-item${isHidden ? " is-hidden" : ""}`}
              key={series.key}
              onClick={() => toggle(series.key)}
              type="button"
            >
              <svg aria-hidden="true" className="chart-legend-swatch" viewBox="0 0 24 8">
                <line
                  stroke={series.token}
                  strokeDasharray={seriesDash[index] === "none" ? undefined : seriesDash[index]}
                  strokeWidth="2.5"
                  x1="1"
                  x2="23"
                  y1="4"
                  y2="4"
                />
              </svg>
              <span>{series.label}</span>
              <strong>{formatCount(activity.totals[series.key])}</strong>
            </button>
          );
        })}
      </div>
      {/* The same numbers as the chart, for anyone reading with assistive technology or
          unable to tell the lines apart. The wrapper carries `sr-only`, not the table: a
          CSS table treats a specified width as a minimum, so a hidden table that is not
          inside a clipping wrapper lays out at its content width and widens the page. */}
      <div className="sr-only">
        <table>
          <caption>
            {`Recorded activity by ${activity.granularity}, ${activity.timezone}. Total across the period: ${ACTIVITY_SERIES.map((series) => `${series.label} ${activity.totals[series.key]}`).join(", ")}.`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Period starting</th>
              {ACTIVITY_SERIES.map((series) => (
                <th key={series.key} scope="col">
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.start}>
                <th scope="row">
                  {formatBucketRange(bucket.start, bucket.end, activity.granularity, activity.timezone)}
                </th>
                {ACTIVITY_SERIES.map((series) => (
                  <td key={series.key}>{bucket[series.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
