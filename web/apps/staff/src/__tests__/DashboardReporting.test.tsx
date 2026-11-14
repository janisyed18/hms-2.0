import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationalWorkspace } from "../components/OperationalWorkspace";
import { reportingPeriodFromDates, withReportingTimeZone } from "../utils/reportingPeriod";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const emptyList = { total: 0, limit: 50, offset: 0, items: [] };

interface DashboardOverrides {
  fleet?: Partial<{
    on_track: number;
    due_soon: number;
    overdue: number;
    suspended: number;
    unscheduled: number;
    total: number;
    on_track_percent: number | null;
  }>;
  escalationEligible?: number;
  escalatedToday?: number;
  overdueEscalated?: number;
  overdueTotal?: number;
}

function dashboardBody(limit: number, offset: number, overrides: DashboardOverrides = {}) {
  const overdueTotal = overrides.overdueTotal ?? 3;
  const rows = Array.from({ length: overdueTotal }, (_, index) => ({
    asset_id: `asset-${index}`,
    asset_number: `HOSE-${index}`,
    asset_name: null,
    customer_name: "Vopak",
    product_name: "FUELFLEX",
    due_at: "2023-11-02",
    days_overdue: 700 + index,
    status: index === 0 ? "ESCALATED" : "OVERDUE"
  }));
  return {
    as_of: "2026-11-14T00:30:00Z",
    timezone: "Australia/Sydney",
    total_assets: 120,
    total_customers: 4,
    in_service_assets: 100,
    fleet_status: {
      on_track: 60,
      due_soon: 10,
      overdue: 3,
      suspended: 2,
      unscheduled: 25,
      total: 100,
      on_track_percent: 60,
      ...overrides.fleet
    },
    due_soon_assets: 10,
    overdue_assets: 3,
    overdue_schedules: 3,
    overdue_escalated: overrides.overdueEscalated ?? 1,
    escalation_eligible_total: overrides.escalationEligible ?? 2,
    escalated_today: overrides.escalatedToday ?? 1,
    awaiting_review_inspections: 4,
    overdue_total: overdueTotal,
    overdue_limit: limit,
    overdue_offset: offset,
    overdue_retests: rows.slice(offset, offset + limit),
    due_this_week: [],
    awaiting_review: []
  };
}

function activityBody() {
  const bucket = (start: string, assets: number, escalated: number) => ({
    start,
    end: start,
    assets_added: assets,
    inspections_submitted: 2,
    inspections_approved: 1,
    inspections_rejected: 0,
    certificates_issued: 1,
    retests_escalated: escalated
  });
  return {
    generated_at: "2026-11-14T00:30:00Z",
    start_at: "2026-11-01T13:00:00Z",
    end_at: "2026-11-03T13:00:00Z",
    timezone: "Australia/Sydney",
    granularity: "day",
    buckets: [
      bucket("2026-11-01T13:00:00Z", 5, 1),
      bucket("2026-11-02T13:00:00Z", 7, 2)
    ],
    totals: {
      assets_added: 12,
      inspections_submitted: 4,
      inspections_approved: 2,
      inspections_rejected: 0,
      certificates_issued: 2,
      retests_escalated: 3
    }
  };
}

interface StubOptions {
  overrides?: DashboardOverrides;
  /** Hold every activity response after the first, to model a slow period change. */
  holdActivityAfterFirst?: boolean;
  activityStatus?: number;
  auditStatus?: number;
  dashboardFailsAfter?: number;
  escalation?: { dispatched: number; eligible: number };
  onDashboard?: (limit: number, offset: number) => void;
}

function stub(options: StubOptions = {}) {
  let dashboardCalls = 0;
  let activityCalls = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url), "http://test");
    const path = target.pathname;
    if (path === "/api/v1/dashboard") {
      dashboardCalls += 1;
      const limit = Number(target.searchParams.get("limit") ?? "5");
      const offset = Number(target.searchParams.get("offset") ?? "0");
      options.onDashboard?.(limit, offset);
      if (options.dashboardFailsAfter !== undefined && dashboardCalls > options.dashboardFailsAfter) {
        return new Response(JSON.stringify({ detail: "Service unavailable" }), { status: 503 });
      }
      return ok(dashboardBody(limit, offset, options.overrides));
    }
    if (path === "/api/v1/reporting/activity") {
      if (options.activityStatus) {
        return new Response(JSON.stringify({ detail: "Activity is unavailable" }), {
          status: options.activityStatus
        });
      }
      activityCalls += 1;
      if (options.holdActivityAfterFirst && activityCalls > 1) {
        return new Promise<Response>(() => undefined);
      }
      return ok(activityBody());
    }
    if (path === "/api/v1/admin/audit-events") {
      if (options.auditStatus) {
        return new Response(JSON.stringify({ detail: "Forbidden" }), { status: options.auditStatus });
      }
      return ok(emptyList);
    }
    if (path === "/api/v1/retest-schedules/escalate-overdue" && init?.method === "POST") {
      return ok(options.escalation ?? { dispatched: 2, eligible: 2 });
    }
    return ok(emptyList);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDashboard(canEscalate = true) {
  return render(
    <OperationalWorkspace
      canEscalate={canEscalate}
      module="dashboard"
      onAssetOpen={vi.fn()}
      onModuleChange={vi.fn()}
      userName="Sam"
    />
  );
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Dashboard reports the retest on-track rate", () => {
  it("shows the rate with its supporting count, and names the period as activity only", async () => {
    stub();
    renderDashboard();

    const card = (await screen.findByText("Retest on-track rate")).closest(".kpi-card");
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("60%");
    expect(card).toHaveTextContent("60 of 100 eligible assets on track");
    // Total Assets stays a separate, all-assets snapshot.
    const totals = screen.getByText("Total Assets").closest(".kpi-card");
    expect(totals).toHaveTextContent("120");
    expect(totals).toHaveTextContent("Every asset on record, across 4 customers");
    expect(
      screen.getByText(/The period changes activity figures only, not current fleet status\./)
    ).toBeVisible();
  });

  it("shows N/A rather than a healthy 0% when there is no eligible fleet", async () => {
    stub({
      overrides: {
        fleet: {
          on_track: 0,
          due_soon: 0,
          overdue: 0,
          suspended: 0,
          unscheduled: 0,
          total: 0,
          on_track_percent: null
        }
      }
    });
    renderDashboard();

    const card = (await screen.findByText("Retest on-track rate")).closest(".kpi-card");
    expect(card).toHaveTextContent("N/A");
    expect(card).toHaveTextContent("No eligible assets to measure");
    expect(card).not.toHaveTextContent("0%");
    expect(card).not.toHaveClass("tone-green");
  });

  it("shows the five retest categories as one partition of the eligible fleet", async () => {
    stub();
    renderDashboard();

    const panel = await screen.findByRole("group", { name: "Fleet retest status distribution" });
    const legend = panel.parentElement?.querySelector(".health-legend");
    expect(legend).not.toBeNull();
    for (const [label, count, percent] of [
      ["On track", "60 assets", "60%"],
      ["Due soon", "10 assets", "10%"],
      ["Overdue", "3 assets", "3%"],
      ["Suspended", "2 assets", "2%"],
      ["Unscheduled", "25 assets", "25%"]
    ]) {
      expect(
        within(legend as HTMLElement).getByRole("button", {
          name: `${label}: ${count}, ${percent} of the eligible fleet`
        })
      ).toBeVisible();
    }
    expect(screen.getByText("100 assets eligible for retest")).toBeVisible();
  });
});

describe("the Dashboard escalation reflects what the server will do", () => {
  it("confirms the eligible count, not the overdue total", async () => {
    stub({ overrides: { overdueTotal: 3, escalationEligible: 2 } });
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Send Escalation" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Send overdue retest escalations?" });
    expect(dialog).toHaveTextContent("notifies the owners of 2 overdue assets");
    expect(dialog).toHaveTextContent("Assets already escalated today, suspended schedules, and condemned, retired or draft assets are not included.");
  });

  it("reports the count the server actually dispatched, not the count displayed", async () => {
    // Two were eligible when the page was drawn; by the time it ran, one was.
    stub({ overrides: { escalationEligible: 2 }, escalation: { dispatched: 1, eligible: 1 } });
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Send Escalation" }));
    await user.click(screen.getByRole("button", { name: "Send escalations" }));

    expect(await screen.findByText("1 overdue retest escalated successfully.")).toBeVisible();
  });

  it("sends one request when the confirm button is clicked twice in quick succession", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Send Escalation" }));
    const confirm = screen.getByRole("button", { name: "Send escalations" });
    await Promise.all([user.click(confirm), user.click(confirm)]);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("escalate-overdue")).length
      ).toBe(1)
    );
  });

  it("disables the control when nothing is eligible", async () => {
    stub({ overrides: { escalationEligible: 0 } });
    renderDashboard();

    expect(await screen.findByRole("button", { name: "Send Escalation" })).toBeDisabled();
  });

  it("disables the control for a role that cannot escalate", async () => {
    stub();
    renderDashboard(false);

    expect(await screen.findByRole("button", { name: "Send Escalation" })).toBeDisabled();
  });
});

describe("the Dashboard export covers every overdue record", () => {
  it("pages the queue and says it exported all of them", async () => {
    const requested: Array<[number, number]> = [];
    stub({ overrides: { overdueTotal: 3 }, onDashboard: (limit, offset) => requested.push([limit, offset]) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderDashboard();

    // The visible page holds one row; the export must not stop there.
    await screen.findByRole("table", { name: "Overdue retests" });
    await user.click(screen.getByRole("button", { name: "Export all" }));

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("Exported all 3 overdue retests.");
    expect(requested.some(([limit]) => limit === 100)).toBe(true);
  });

  it("names the file for the as-of date in the organisation timezone", async () => {
    // 00:30 UTC on 14 November is 11:30 on the 14th in Sydney, but the 13th in UTC.
    stub({ overrides: { overdueTotal: 1 } });
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      filenames.push(this.download);
    });
    const user = userEvent.setup();
    renderDashboard();

    await screen.findByRole("table", { name: "Overdue retests" });
    await user.click(screen.getByRole("button", { name: "Export all" }));

    await waitFor(() => expect(filenames).toHaveLength(1));
    expect(filenames[0]).toBe("overdue-retests-2026-11-14.csv");
  });
});

describe("the Dashboard trend comes from the reporting activity API", () => {
  it("names the six series with their period totals and no audit-log reading", async () => {
    const fetchMock = stub();
    renderDashboard();

    const legend = await screen.findByLabelText("Operational trend legend");
    expect(legend).toHaveTextContent("Assets added 12");
    expect(legend).toHaveTextContent("Inspections submitted 4");
    expect(legend).toHaveTextContent("Inspections approved 2");
    expect(legend).toHaveTextContent("Inspections rejected 0");
    expect(legend).toHaveTextContent("Certificates issued 2");
    expect(legend).toHaveTextContent("Retests escalated 3");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/reporting/activity"))
    ).toBe(true);
  });

  it("offers the same numbers as a table for assistive technology", async () => {
    stub();
    renderDashboard();

    const table = await screen.findByRole("table", {
      name: /Recorded activity by day, Australia\/Sydney/
    });
    expect(within(table).getByRole("columnheader", { name: "Assets added" })).toBeVisible();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("5");
    expect(rows[1]).toHaveTextContent("7");
  });

  it("names the period its figures belong to while a newer period is loading", async () => {
    stub({ holdActivityAfterFirst: true });
    const user = userEvent.setup();
    renderDashboard();

    await screen.findByLabelText("Operational trend legend");
    expect(screen.getByText(/Recorded activity for last 1 month, by day\./)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Reporting period" }), "last_week");

    // The chart still shows last month's figures, so it says so and marks itself busy.
    const subtitle = await screen.findByText(
      /Recorded activity for last 1 month, by day\. Updating to last 1 week…/
    );
    expect(subtitle).toBeInTheDocument();
    expect(document.querySelector(".operational-trend.is-stale")).not.toBeNull();
    expect(document.querySelector('.operational-trend[aria-busy="true"]')).not.toBeNull();
  });

  it("says activity could not be loaded instead of showing an empty chart", async () => {
    stub({ activityStatus: 503 });
    renderDashboard();

    expect(await screen.findByText(/Activity is unavailable|Activity could not be loaded/)).toBeVisible();
    expect(screen.queryByLabelText("Operational trend legend")).not.toBeInTheDocument();
  });

  it("says recent activity needs audit access rather than claiming there was none", async () => {
    stub({ auditStatus: 403 });
    renderDashboard();

    expect(await screen.findByText("Recent activity needs audit access.")).toBeVisible();
  });
});

describe("the Dashboard keeps the last good figures when a refresh fails", () => {
  it("warns about the stale numbers instead of replacing the page with an error", async () => {
    stub({ dashboardFailsAfter: 1 });
    const user = userEvent.setup();
    renderDashboard();

    await screen.findByText("Retest on-track rate");
    // Changing the page size refetches; that request fails.
    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "10");

    expect(
      await screen.findByText(/These figures are from the last successful load\./)
    ).toBeInTheDocument();
    // The KPIs are still on the page: a failed refresh does not blank the dashboard.
    expect(screen.getByText("Retest on-track rate")).toBeInTheDocument();
    expect(screen.getByText("60 of 100 eligible assets on track")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard unavailable")).not.toBeInTheDocument();
  });

  it("shows the error page when the very first load fails", async () => {
    stub({ dashboardFailsAfter: 0 });
    renderDashboard();

    expect(await screen.findByText("Dashboard unavailable")).toBeInTheDocument();
  });
});

describe("custom reporting ranges are whole days in the organisation timezone", () => {
  it("covers midnight to midnight in Sydney, not UTC", () => {
    const period = reportingPeriodFromDates("2026-11-05", "2026-11-05", "Australia/Sydney");
    expect(period).not.toBeNull();
    // 5 November 2026 in Sydney is UTC+11, so the day starts at 13:00 UTC the day before.
    expect(period?.startAt).toBe("2026-11-04T13:00:00.000Z");
    expect(period?.endAt).toBe("2026-11-05T13:00:00.000Z");
    expect(period?.startDate).toBe("2026-11-05");
    expect(period?.endDate).toBe("2026-11-05");
  });

  it("adds no extra day across a multi-day range", () => {
    const period = reportingPeriodFromDates("2026-11-01", "2026-11-03", "Australia/Sydney");
    const hours =
      (new Date(period!.endAt).getTime() - new Date(period!.startAt).getTime()) / 3_600_000;
    expect(hours).toBe(72);
  });

  it("keeps a daylight-saving day the right length", () => {
    // Daylight saving starts in Sydney on 4 October 2026: that day is 23 hours long.
    const period = reportingPeriodFromDates("2026-10-04", "2026-10-04", "Australia/Sydney");
    const hours =
      (new Date(period!.endAt).getTime() - new Date(period!.startAt).getTime()) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("refuses a reversed range", () => {
    expect(reportingPeriodFromDates("2026-11-05", "2026-11-01", "Australia/Sydney")).toBeNull();
    expect(reportingPeriodFromDates("not-a-date", "2026-11-01", "Australia/Sydney")).toBeNull();
  });

  it("re-anchors a range built before the timezone was known", () => {
    const utcRange = reportingPeriodFromDates("2026-11-05", "2026-11-05");
    expect(utcRange?.startAt).toBe("2026-11-05T00:00:00.000Z");
    const anchored = withReportingTimeZone(utcRange!, "Australia/Sydney");
    expect(anchored.startAt).toBe("2026-11-04T13:00:00.000Z");
    expect(anchored.timeZone).toBe("Australia/Sydney");
  });

  it("leaves a rolling preset alone", () => {
    const preset = { preset: "last_week" as const, label: "Last 1 week", startAt: "a", endAt: "b", startDate: "c", endDate: "d" };
    expect(withReportingTimeZone(preset, "Australia/Sydney")).toBe(preset);
  });
});
