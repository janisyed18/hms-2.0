import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsWorkspace } from "../components/AnalyticsWorkspace";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fleetStatus = {
  on_track: 60,
  due_soon: 10,
  overdue: 3,
  suspended: 2,
  unscheduled: 25,
  total: 100,
  on_track_percent: 60
};

function overviewBody(overrides: Record<string, unknown> = {}) {
  return {
    generated_at: "2026-11-14T00:30:00Z",
    as_of: "2026-11-14T00:30:00Z",
    timezone: "Australia/Sydney",
    total_assets: 120,
    in_service_assets: 100,
    due_soon_assets: 10,
    overdue_assets: 3,
    awaiting_review_inspections: 4,
    fleet_status: fleetStatus,
    fleet_posture: { clear: 60, due_soon: 10, overdue: 3 },
    certificate_coverage: {
      eligible_assets: 100,
      covered_assets: 70,
      unverified_assets: 5,
      expired_assets: 10,
      missing_assets: 15,
      expiring_assets: 8,
      coverage_percent: 70,
      issued: 92,
      expiring_soon: 9,
      expired: 12,
      issued_in_period: 6
    },
    customer_risk: [],
    inspection_outcomes: [
      { inspection_type: "SERVICE", submitted: 4, approved: 20, rejected: 1 }
    ],
    ...overrides
  };
}

function stub(options: { failAfter?: number; holdAfterFirst?: boolean } = {}) {
  let calls = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url), "http://test").pathname;
    if (path === "/api/v1/analytics/overview") {
      calls += 1;
      if (options.failAfter !== undefined && calls > options.failAfter) {
        return new Response(JSON.stringify({ detail: "Analytics is unavailable" }), { status: 503 });
      }
      if (options.holdAfterFirst && calls > 1) {
        return new Promise<Response>(() => undefined);
      }
      return ok(overviewBody());
    }
    return ok({ total: 0, limit: 50, offset: 0, items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Analytics shares the Dashboard's fleet definitions", () => {
  it("shows the retest on-track rate and the five-category partition", async () => {
    stub();
    render(<AnalyticsWorkspace onModuleChange={vi.fn()} />);

    const card = (await screen.findByText("Retest on-track rate")).closest(".kpi-card");
    expect(card).toHaveTextContent("60%");
    expect(card).toHaveTextContent("60 of 100 eligible assets on track");
    const panel = screen.getByText("Fleet retest status").closest(".health-panel");
    expect(panel).not.toBeNull();
    for (const label of ["On track", "Due soon", "Overdue", "Suspended", "Unscheduled"]) {
      expect(
        within(panel as HTMLElement).getByRole("button", { name: new RegExp(`^${label}: `) })
      ).toBeVisible();
    }
    expect(screen.getByText("3% of eligible assets are overdue")).toBeVisible();
  });

  it("separates asset coverage from certificate counts and period activity", async () => {
    stub();
    render(<AnalyticsWorkspace onModuleChange={vi.fn()} />);

    expect(await screen.findByText("70 of 100 eligible assets covered")).toBeVisible();
    expect(screen.getByText("Covered by a valid certificate")).toBeVisible();
    expect(screen.getByText("Validity unverified (no expiry recorded)")).toBeVisible();
    expect(screen.getByText("Certificate expired")).toBeVisible();
    expect(screen.getByText("No certificate")).toBeVisible();
    // Certificate-level numbers are labelled as records, never as assets.
    expect(screen.getByText("Issued certificate records").nextElementSibling).toHaveTextContent("92");
    expect(screen.getByText("Issued in this period").nextElementSibling).toHaveTextContent("6");
  });

  it("says the period applies to activity, not to current status", async () => {
    stub();
    render(<AnalyticsWorkspace onModuleChange={vi.fn()} />);

    expect(
      await screen.findByText(/The period changes activity figures only, not current fleet status\./)
    ).toBeVisible();
  });

  it("names the period its throughput belongs to while a newer period is loading", async () => {
    stub({ holdAfterFirst: true });
    const user = userEvent.setup();
    render(<AnalyticsWorkspace onModuleChange={vi.fn()} />);

    expect(await screen.findByText(/Inspection throughput is for last 1 month\./)).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox", { name: "Reporting period" }), "last_week");

    expect(await screen.findByText("Updating to last 1 week…")).toBeVisible();
    // Still described as last month's, because that is what is on screen.
    expect(screen.getByText(/Inspection throughput is for last 1 month\./)).toBeVisible();
  });

  it("keeps the last good figures and offers a retry when a refresh fails", async () => {
    stub({ failAfter: 1 });
    const user = userEvent.setup();
    render(<AnalyticsWorkspace onModuleChange={vi.fn()} />);

    await screen.findByText("Retest on-track rate");
    await user.click(screen.getByRole("button", { name: "Refresh analytics" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("These figures are from the last successful load.");
    expect(screen.getByText("Retest on-track rate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
