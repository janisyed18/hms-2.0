import { scaleLinear } from "d3-scale";
import { useId } from "react";

import type { FleetStatus } from "../../domain/types";
import { formatCount } from "./chartPrimitives";

export type FleetCategoryId = "on-track" | "due-soon" | "overdue" | "suspended" | "unscheduled";

export interface FleetCategory {
  id: FleetCategoryId;
  label: string;
  /** What the category means, so a reader never has to guess the rule. */
  description: string;
  value: number;
}

/**
 * The five retest categories, in the order they are stacked. They are mutually exclusive
 * and exhaustive over the eligible fleet, so the bar is a true partition and the
 * percentages add to 100.
 */
export function fleetCategories(fleet: FleetStatus): FleetCategory[] {
  return [
    {
      id: "on-track",
      label: "On track",
      description: "Scheduled, with more than a week until the retest is due",
      value: fleet.onTrack
    },
    {
      id: "due-soon",
      label: "Due soon",
      description: "Retest due within the next 7 days",
      value: fleet.dueSoon
    },
    {
      id: "overdue",
      label: "Overdue",
      description: "Past the retest due date",
      value: fleet.overdue
    },
    {
      id: "suspended",
      label: "Suspended",
      description: "Retest schedule suspended, so no retest is expected",
      value: fleet.suspended
    },
    {
      id: "unscheduled",
      label: "Unscheduled",
      description: "No retest schedule, so no retest date is being tracked",
      value: fleet.unscheduled
    }
  ];
}

const VIEW_WIDTH = 760;
const BAR_HEIGHT = 34;

interface FleetStatusChartProps {
  fleet: FleetStatus;
  /** Called when a category is chosen, for the drill-down to the matching records. */
  onSelect?: (category: FleetCategory) => void;
  selectLabel?: (category: FleetCategory) => string;
}

export function FleetStatusChart({ fleet, onSelect, selectLabel }: FleetStatusChartProps) {
  const titleId = useId();
  const categories = fleetCategories(fleet);
  const total = fleet.total;
  const scale = scaleLinear().domain([0, Math.max(1, total)]).range([0, VIEW_WIDTH]);
  const share = (value: number) => (total ? Math.round((value / total) * 100) : 0);

  // Each segment starts where the ones before it end, computed without mutation.
  const segments = categories.map((category, index) => ({
    ...category,
    x: categories.slice(0, index).reduce((sum, earlier) => sum + scale(earlier.value), 0),
    width: scale(category.value)
  }));

  if (total === 0) {
    return (
      <p className="chart-empty">
        No assets are eligible for retest. Condemned, retired and draft assets are not counted.
      </p>
    );
  }

  return (
    <div className="fleet-bar-chart">
      <svg
        aria-labelledby={titleId}
        className="fleet-bar-svg"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${BAR_HEIGHT}`}
      >
        <title id={titleId}>
          {`Retest status of ${formatCount(total)} eligible assets: ${categories
            .map((category) => `${category.label} ${category.value}, ${share(category.value)} per cent`)
            .join("; ")}.`}
        </title>
        {segments.map((segment) =>
          segment.width > 0 ? (
            <rect
              className={`fleet-bar-segment fleet-segment-${segment.id}`}
              height={BAR_HEIGHT}
              key={segment.id}
              width={segment.width}
              x={segment.x}
              y="0"
            />
          ) : null
        )}
      </svg>
      <ul className="fleet-bar-legend">
        {categories.map((category) => {
          const percent = share(category.value);
          const label = `${category.label}: ${formatCount(category.value)} ${
            category.value === 1 ? "asset" : "assets"
          }, ${percent}% of the eligible fleet. ${category.description}.`;
          return (
            <li key={category.id}>
              {onSelect ? (
                <button
                  aria-label={selectLabel ? `${label} ${selectLabel(category)}` : label}
                  className={`fleet-bar-legend-item fleet-legend-${category.id}`}
                  onClick={() => onSelect(category)}
                  type="button"
                >
                  <i aria-hidden="true" className={`fleet-segment-${category.id}`} />
                  <span className="fleet-bar-legend-label">{category.label}</span>
                  <strong>{formatCount(category.value)}</strong>
                  <small>{percent}%</small>
                </button>
              ) : (
                <span aria-label={label} className={`fleet-bar-legend-item is-static fleet-legend-${category.id}`}>
                  <i aria-hidden="true" className={`fleet-segment-${category.id}`} />
                  <span className="fleet-bar-legend-label">{category.label}</span>
                  <strong>{formatCount(category.value)}</strong>
                  <small>{percent}%</small>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
