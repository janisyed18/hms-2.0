import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityTrendChart } from "../components/charts/ActivityTrendChart";
import { CertificateCoverageChart } from "../components/charts/CertificateCoverageChart";
import { FleetStatusChart } from "../components/charts/FleetStatusChart";
import { InspectionOutcomesChart } from "../components/charts/InspectionOutcomesChart";
import { countTicks, labelIndices, niceMax } from "../components/charts/chartPrimitives";
import type { ActivityReport, FleetStatus } from "../domain/types";

function activity(overrides: Partial<ActivityReport> = {}): ActivityReport {
  const bucket = (start: string, end: string, assets: number, escalated: number) => ({
    start,
    end,
    assets_added: assets,
    assetsAdded: assets,
    inspectionsSubmitted: 4,
    inspectionsApproved: 2,
    inspectionsRejected: 0,
    certificatesIssued: 1,
    retestsEscalated: escalated
  });
  return {
    generatedAt: "2026-11-14T00:30:00Z",
    startAt: "2026-11-10T13:00:00Z",
    endAt: "2026-11-13T13:00:00Z",
    timezone: "Australia/Sydney",
    granularity: "day",
    buckets: [
      bucket("2026-11-10T13:00:00Z", "2026-11-11T13:00:00Z", 5, 1),
      bucket("2026-11-11T13:00:00Z", "2026-11-12T13:00:00Z", 9, 0),
      bucket("2026-11-12T13:00:00Z", "2026-11-13T13:00:00Z", 40, 2)
    ].map(({ assets_added: _ignored, ...rest }) => rest),
    totals: {
      assetsAdded: 54,
      inspectionsSubmitted: 12,
      inspectionsApproved: 6,
      inspectionsRejected: 0,
      certificatesIssued: 3,
      retestsEscalated: 3
    },
    ...overrides
  };
}

const fleet: FleetStatus = {
  onTrack: 60,
  dueSoon: 10,
  overdue: 3,
  suspended: 2,
  unscheduled: 25,
  total: 100,
  onTrackPercent: 60
};

describe("chart primitives", () => {
  it("rounds an axis maximum up to a readable number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(37)).toBe(40);
    expect(niceMax(41)).toBe(50);
    expect(niceMax(1234)).toBe(1250);
  });

  it("gives whole-number ticks up to that maximum", () => {
    expect(countTicks(40)).toEqual([0, 10, 20, 30, 40]);
    expect(countTicks(3)).toEqual([0, 1, 2, 3]);
  });

  it("thins labels while keeping the first and last", () => {
    expect(labelIndices(3, 6)).toEqual([0, 1, 2]);
    const thinned = labelIndices(30, 6);
    expect(thinned[0]).toBe(0);
    expect(thinned[thinned.length - 1]).toBe(29);
    expect(thinned.length).toBeLessThanOrEqual(6);
  });
});

describe("ActivityTrendChart", () => {
  it("draws one line per series and names them with their totals", () => {
    render(<ActivityTrendChart activity={activity()} />);

    expect(document.querySelectorAll("path.chart-line")).toHaveLength(6);
    const legend = screen.getByRole("group", { name: "Activity series" });
    expect(within(legend).getByRole("button", { name: "Assets added 54" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("rescales the axis when a series is switched off, without changing the data", async () => {
    const user = userEvent.setup();
    render(<ActivityTrendChart activity={activity()} />);

    // 40 is the tallest value, and it comes from Assets added.
    expect(screen.getByText("Vertical axis maximum 40.")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Assets added 54" });
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // The axis now follows the tallest visible series (Inspections submitted, 4).
    expect(screen.getByText("Vertical axis maximum 4.")).toBeInTheDocument();
    expect(document.querySelectorAll("path.chart-line")).toHaveLength(5);
    // The totals and the data table are untouched: only the drawing changed.
    expect(toggle).toHaveTextContent("54");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Assets added" })).toBeInTheDocument();
    expect(table).toHaveTextContent("40");
  });

  it("keeps at least one series visible", async () => {
    const user = userEvent.setup();
    render(<ActivityTrendChart activity={activity()} />);
    const legend = screen.getByRole("group", { name: "Activity series" });
    const toggles = within(legend).getAllByRole("button");

    for (const toggle of toggles) {
      await user.click(toggle);
    }

    const pressed = toggles.filter((toggle) => toggle.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(document.querySelectorAll("path.chart-line")).toHaveLength(1);
  });

  it("reads each period out with the arrow keys", async () => {
    render(<ActivityTrendChart activity={activity()} />);

    const plot = screen.getByRole("application", { name: /Use the arrow keys/ });
    fireEvent.focus(plot);
    const readout = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

    // Focus starts on the first period.
    await waitFor(() => expect(readout()).toContain("Wed, 11 Nov"));
    expect(readout()).toContain("Assets added 5");

    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(readout()).toContain("Thu, 12 Nov");
    expect(readout()).toContain("Assets added 9");

    fireEvent.keyDown(plot, { key: "End" });
    expect(readout()).toContain("Fri, 13 Nov");
    expect(readout()).toContain("Assets added 40");

    // The marker and tooltip follow the keyboard, not just the pointer.
    expect(document.querySelector(".chart-tooltip")).not.toBeNull();
    expect(document.querySelector(".chart-tooltip")).toHaveTextContent("Assets added");

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(document.querySelector(".chart-tooltip")).toBeNull();
  });

  it("formats bucket dates in the organisation timezone, not the viewer's", () => {
    render(<ActivityTrendChart activity={activity()} />);

    // The first bucket starts at 13:00 UTC on 10 November, which is midnight on the
    // 11th in Sydney: the row is named for the Sydney day, not the UTC one.
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Wed, 11 Nov" })).toBeInTheDocument();
    expect(table).toHaveAccessibleName(/Australia\/Sydney/);
  });

  it("hides the data table in a clipping wrapper so it cannot widen the page", () => {
    render(<ActivityTrendChart activity={activity()} />);

    const table = screen.getByRole("table");
    expect(table).not.toHaveClass("sr-only");
    expect(table.parentElement).toHaveClass("sr-only");
  });

  it("says so when the period holds no buckets", () => {
    render(<ActivityTrendChart activity={activity({ buckets: [] })} />);
    expect(screen.getByText("No activity was recorded in this period.")).toBeInTheDocument();
  });
});

describe("FleetStatusChart", () => {
  it("stacks the five categories into one bar over the eligible fleet", () => {
    render(<FleetStatusChart fleet={fleet} />);

    const widths = [...document.querySelectorAll("rect.fleet-bar-segment")].map((rect) =>
      Number(rect.getAttribute("width"))
    );
    expect(widths).toHaveLength(5);
    // The segments fill the bar exactly: the categories partition the fleet.
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(760, 5);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      /On track 60, 60 per cent; Due soon 10, 10 per cent; Overdue 3, 3 per cent; Suspended 2, 2 per cent; Unscheduled 25, 25 per cent/
    );
  });

  it("names each category with its meaning, and drills down on click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<FleetStatusChart fleet={fleet} onSelect={onSelect} />);

    const suspended = screen.getByRole("button", {
      name: "Suspended: 2 assets, 2% of the eligible fleet. Retest schedule suspended, so no retest is expected."
    });
    await user.click(suspended);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "suspended", value: 2 }));
  });

  it("is static text, not buttons, when there is nothing to drill into", () => {
    render(<FleetStatusChart fleet={fleet} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so when no asset is eligible", () => {
    render(
      <FleetStatusChart
        fleet={{ onTrack: 0, dueSoon: 0, overdue: 0, suspended: 0, unscheduled: 0, total: 0, onTrackPercent: null }}
      />
    );
    expect(screen.getByText(/No assets are eligible for retest/)).toBeInTheDocument();
  });
});

describe("InspectionOutcomesChart", () => {
  it("compares outcomes per inspection type on one scale", () => {
    render(
      <InspectionOutcomesChart
        outcomes={[
          { inspectionType: "NEW_ASSET", submitted: 3, approved: 142, rejected: 11 },
          { inspectionType: "SERVICE", submitted: 5, approved: 318, rejected: 27 }
        ]}
        periodLabel="Last 1 month"
      />
    );

    expect(screen.getByRole("img")).toHaveAccessibleName(
      /Inspection outcomes for last 1 month: New asset Awaiting review 3, Approved 142, Rejected 11; Service Awaiting review 5, Approved 318, Rejected 27\./
    );
    expect(screen.getByText("New asset · Awaiting review")).toBeInTheDocument();
    expect(screen.getByText("318")).toBeInTheDocument();
  });

  it("says so when there is nothing to compare", () => {
    render(<InspectionOutcomesChart outcomes={[]} periodLabel={null} />);
    expect(
      screen.getByText("No submitted, approved or rejected inspections are visible.")
    ).toBeInTheDocument();
  });
});

describe("CertificateCoverageChart", () => {
  const coverage = {
    eligibleAssets: 100,
    coveredAssets: 70,
    unverifiedAssets: 5,
    expiredAssets: 10,
    missingAssets: 15,
    expiringAssets: 8,
    coveragePercent: 70,
    issued: 134,
    expiringSoon: 12,
    expired: 19,
    issuedInPeriod: 6
  };

  it("shows asset coverage as one bar and keeps certificate records separate", () => {
    render(<CertificateCoverageChart coverage={coverage} />);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      /Certificate coverage of 100 eligible assets: Covered by a valid certificate 70, 70 per cent/
    );
    expect(screen.getByText("Validity unverified (no expiry recorded)")).toBeInTheDocument();
    // Certificate-level counts are labelled as records, never as assets.
    expect(screen.getByText("Issued certificate records").nextElementSibling).toHaveTextContent("134");
    expect(screen.getByText("Expired certificate records").nextElementSibling).toHaveTextContent("19");
    expect(screen.getByText("Issued in this period").nextElementSibling).toHaveTextContent("6");
  });

  it("shows a dash when no period is selected", () => {
    render(<CertificateCoverageChart coverage={{ ...coverage, issuedInPeriod: null }} />);
    expect(screen.getByText("Issued in this period").nextElementSibling).toHaveTextContent("—");
  });

  it("says so when no asset is eligible", () => {
    render(
      <CertificateCoverageChart
        coverage={{ ...coverage, eligibleAssets: 0, coveredAssets: 0, unverifiedAssets: 0, expiredAssets: 0, missingAssets: 0 }}
      />
    );
    expect(screen.getByText("No assets are eligible for certificate coverage.")).toBeInTheDocument();
  });
});
