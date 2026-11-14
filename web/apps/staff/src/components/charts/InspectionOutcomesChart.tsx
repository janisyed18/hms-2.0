import { scaleLinear } from "d3-scale";
import { useId } from "react";

import type { AnalyticsInspectionOutcome } from "../../domain/types";
import { countTicks, formatCount, niceMax } from "./chartPrimitives";

const OUTCOMES = [
  { key: "submitted", label: "Awaiting review", token: "var(--chart-4)" },
  { key: "approved", label: "Approved", token: "var(--chart-2)" },
  { key: "rejected", label: "Rejected", token: "var(--chart-6)" }
] as const;

const VIEW_WIDTH = 520;
const ROW_HEIGHT = 26;
const BAR_HEIGHT = 7;
const LABEL_WIDTH = 150;

interface InspectionOutcomesChartProps {
  outcomes: AnalyticsInspectionOutcome[];
  /** Named so nobody reads period throughput as a running total, or the reverse. */
  periodLabel: string | null;
}

/**
 * Outcomes by inspection type: grouped bars on one shared scale, so the types can be
 * compared. Each bar is one status at the moment the API measured it, within the selected
 * period where one applies.
 */
export function InspectionOutcomesChart({ outcomes, periodLabel }: InspectionOutcomesChartProps) {
  const titleId = useId();
  if (outcomes.length === 0) {
    return <p className="chart-empty">No submitted, approved or rejected inspections are visible.</p>;
  }

  const peak = Math.max(
    ...outcomes.flatMap((outcome) => OUTCOMES.map((entry) => outcome[entry.key]))
  );
  const scale = scaleLinear().domain([0, niceMax(peak)]).range([0, VIEW_WIDTH - LABEL_WIDTH - 46]);
  const height = outcomes.length * OUTCOMES.length * ROW_HEIGHT + 26;
  const ticks = countTicks(peak, 3);

  return (
    <div className="outcomes-chart">
      <svg
        aria-labelledby={titleId}
        className="outcomes-chart-svg"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      >
        <title id={titleId}>
          {`Inspection outcomes${periodLabel ? ` for ${periodLabel.toLowerCase()}` : ""}: ${outcomes
            .map(
              (outcome) =>
                `${readableType(outcome.inspectionType)} ${OUTCOMES.map(
                  (entry) => `${entry.label} ${outcome[entry.key]}`
                ).join(", ")}`
            )
            .join("; ")}.`}
        </title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="chart-grid"
              x1={LABEL_WIDTH + scale(tick)}
              x2={LABEL_WIDTH + scale(tick)}
              y1="0"
              y2={height - 22}
            />
            <text
              className="chart-axis-label"
              textAnchor="middle"
              x={LABEL_WIDTH + scale(tick)}
              y={height - 6}
            >
              {formatCount(tick)}
            </text>
          </g>
        ))}
        {outcomes.map((outcome, typeIndex) =>
          OUTCOMES.map((entry, entryIndex) => {
            const row = typeIndex * OUTCOMES.length + entryIndex;
            const y = row * ROW_HEIGHT + 6;
            const value = outcome[entry.key];
            return (
              <g key={`${outcome.inspectionType}-${entry.key}`}>
                <text className="outcomes-chart-label" x="0" y={y + BAR_HEIGHT + 2}>
                  {entryIndex === 0 ? `${readableType(outcome.inspectionType)} · ${entry.label}` : entry.label}
                </text>
                <rect
                  className="outcomes-chart-track"
                  height={BAR_HEIGHT}
                  rx="3"
                  width={VIEW_WIDTH - LABEL_WIDTH - 46}
                  x={LABEL_WIDTH}
                  y={y}
                />
                <rect
                  fill={entry.token}
                  height={BAR_HEIGHT}
                  rx="3"
                  width={Math.max(value > 0 ? 2 : 0, scale(value))}
                  x={LABEL_WIDTH}
                  y={y}
                />
                <text
                  className="outcomes-chart-value"
                  x={VIEW_WIDTH - 40}
                  y={y + BAR_HEIGHT + 2}
                >
                  {formatCount(value)}
                </text>
              </g>
            );
          })
        )}
      </svg>
      <div className="chart-legend is-compact" role="group" aria-label="Inspection outcome colours">
        {OUTCOMES.map((entry) => (
          <span className="chart-legend-item is-static" key={entry.key}>
            <i aria-hidden="true" style={{ background: entry.token }} />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function readableType(type: string): string {
  return type
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}
