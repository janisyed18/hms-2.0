import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  Hourglass,
  RefreshCcw,
  ArrowUpRight,
  ArrowRight,
  ChartNoAxesCombined,
  Send,
  Boxes,
  BellRing
} from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import {
  createHmsClient,
  HmsApiError
} from "../api/hmsClient";
import type {
  ActivityReport,
  AuditEventRecord,
  DashboardRecord,
  DashboardRetestRecord,
  FleetStatus
} from "../domain/types";
import { PresencePanel, StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { motionTokens } from "../motion/motionTokens";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { WorkspaceState } from "./WorkspaceState";
import { assetAccessibleName, assetLabel } from "../utils/identity";
import { AssetIdentity } from "./AssetIdentity";
import { downloadCsv } from "./ModuleTable";
import { PaginationControls, usePagination } from "./Pagination";
import { ReportingPeriodControl } from "./ReportingPeriodControl";
import type { AppModule } from "./AppShell";
import {
  REPORTING_PERIOD_SCOPE_NOTE,
  reportingPeriodForPreset,
  withReportingTimeZone
} from "../utils/reportingPeriod";
import type { ReportingPeriod } from "../utils/reportingPeriod";

export type OperationalModule = "dashboard" | "sync";

interface OperationalWorkspaceProps {
  canEscalate: boolean;
  module: OperationalModule;
  onAssetOpen: (assetId: string) => void;
  onModuleChange: (module: AppModule, inspectionId?: string) => void;
  /** Null when only an email is known: the greeting then omits the name rather than read the address out. */
  userName: string | null;
}

const syncRows = [
  ["Certificate issue", "Queued", "CERT-VOPA-NEW-1", "2 min ago"],
  ["Inspection draft", "Ready", "997950", "9 min ago"],
  ["Asset update", "Waiting", "ORIC-100", "18 min ago"]
];

const overduePageSizes = [5, 10, 25];

export function OperationalWorkspace({
  canEscalate,
  module,
  onAssetOpen,
  onModuleChange,
  userName
}: OperationalWorkspaceProps) {
  const [dashboardEvents, setDashboardEvents] = useState<AuditEventRecord[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<LoadedActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [overduePage, setOverduePage] = useState(1);
  const [overduePageSize, setOverduePageSize] = useState(overduePageSizes[0]);
  const overdueStart = (overduePage - 1) * overduePageSize;
  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardStale, setDashboardStale] = useState<string | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const [dashboardActionError, setDashboardActionError] = useState<string | null>(null);
  const [isEscalating, setEscalating] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [isConfirmingEscalation, setConfirmingEscalation] = useState(false);
  const [escalationError, setEscalationError] = useState<string | null>(null);
  const [reportingPeriod, setReportingPeriod] = useState<ReportingPeriod>(() => reportingPeriodForPreset("last_month"));
  const [dashboardNow] = useState(() => Date.now());
  const reducedMotion = useReducedMotion();
  // Only the newest request may write state, so a slow reply from an earlier filter
  // cannot overwrite a newer one.
  const latestRequest = useRef(0);
  // Whether anything is on screen to keep: a failed refresh then leaves the last good
  // figures visible with a warning, instead of replacing the page with an error.
  const hasDashboard = useRef(false);
  // Set before the first await, so two fast clicks cannot both start a request.
  const escalationInFlight = useRef(false);

  useEffect(() => {
    if (module !== "dashboard") {
      return;
    }

    const token = ++latestRequest.current;
    const current = () => token === latestRequest.current;
    const client = createHmsClient();
    setDashboardLoading(true);

    client
      .getDashboard(overduePageSize, overdueStart, reportingPeriod)
      .then((result) => {
        if (!current()) {
          return;
        }
        setDashboard(result);
        setDashboardError(null);
        setDashboardStale(null);
        hasDashboard.current = true;
        setDashboardLoading(false);
        // The queue may have shrunk under the current page: clamp, which refetches.
        const pageCount = Math.max(1, Math.ceil(result.overdueTotal / overduePageSize));
        if (overduePage > pageCount) {
          setOverduePage(pageCount);
        }
      })
      .catch((error: unknown) => {
        if (!current()) {
          return;
        }
        setDashboardLoading(false);
        if (hasDashboard.current) {
          setDashboardStale(
            `${errorMessage(error, "The dashboard could not be refreshed.")} These figures are from the last successful load.`
          );
        } else {
          setDashboardError(errorMessage(error, "Dashboard data could not be loaded."));
        }
      });

    setActivityLoading(true);
    client
      .getReportingActivity(reportingPeriod)
      .then((result) => {
        if (current()) {
          setActivity({ report: result, periodLabel: reportingPeriod.label });
          setActivityError(null);
          setActivityLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (current()) {
          setActivity(null);
          setActivityError(errorMessage(error, "Activity could not be loaded."));
          setActivityLoading(false);
        }
      });

    client
      .listAuditEvents({ limit: 100, sort: "-sequence" })
      .then((result) => {
        if (current()) {
          setDashboardEvents(result.items);
          setEventsError(null);
        }
      })
      .catch((error: unknown) => {
        if (current()) {
          setDashboardEvents([]);
          setEventsError(
            error instanceof HmsApiError && (error.status === 403 || error.status === 401)
              ? "Recent activity needs audit access."
              : errorMessage(error, "Recent activity could not be loaded.")
          );
        }
      });

    return () => {
      // Nothing to abort: the token check above already ignores a superseded reply.
    };
  }, [module, overduePage, overduePageSize, overdueStart, reportingPeriod]);

  if (module === "sync") {
    return (
      <section className="operations-page" aria-label="Sync queue workspace">
        <OperationsHeader
          eyebrow="Operations"
          icon={<RefreshCcw aria-hidden="true" size={20} />}
          title="Sync Queue"
          description="Queued inspection, certificate, and asset events awaiting staff review."
        />
        <OperationsTable
          ariaLabel="Sync queue items"
          columns={["Item", "State", "Record", "Updated"]}
          rows={syncRows}
        />
      </section>
    );
  }

  if (dashboardLoading && dashboard === null) {
    return (
      <WorkspaceState title="Loading dashboard" tone="loading">
        Loading current operational data from the backend.
      </WorkspaceState>
    );
  }

  if (dashboardError || dashboard === null) {
    return (
      <WorkspaceState title="Dashboard unavailable" tone="error">
        {dashboardError ?? "Dashboard data could not be loaded."}
      </WorkspaceState>
    );
  }

  const overduePageCount = Math.max(
    1,
    Math.ceil(dashboard.overdueTotal / overduePageSize)
  );
  const fleet = dashboard.fleetStatus;
  const onTrackRate = fleet.onTrackPercent;
  const series = activitySeries(activity?.report ?? null);
  // Escalations awaiting nobody: what has actually been escalated, across the whole
  // queue rather than the page on screen.
  const escalationTotal = dashboard.overdueEscalated;

  async function exportOverdueRetests() {
    if (!dashboard || isExporting) {
      return;
    }
    setExporting(true);
    setDashboardActionError(null);
    setDashboardNotice(null);
    try {
      const rows = await fetchAllOverdueRetests(dashboard.overdueTotal, reportingPeriod);
      downloadCsv(overdueExportName(dashboard.asOf, dashboard.timezone), [
        ["Asset", "Customer", "Product", "Due date", "Days overdue", "Status"],
        ...rows.map((retest) => [
          retest.assetNumber,
          retest.customerName,
          retest.productName,
          retest.dueAt,
          String(retest.daysOverdue),
          retest.status
        ])
      ]);
      setDashboardNotice(
        rows.length === dashboard.overdueTotal
          ? `Exported all ${formatNumber(rows.length)} overdue ${rows.length === 1 ? "retest" : "retests"}.`
          : `Exported the first ${formatNumber(rows.length)} of ${formatNumber(dashboard.overdueTotal)} overdue retests.`
      );
    } catch (error: unknown) {
      setDashboardActionError(
        friendlyApiError(error, { fallback: "The overdue retests could not be exported. Try again." }).message
      );
    } finally {
      setExporting(false);
    }
  }

  async function sendOverdueEscalation() {
    const currentDashboard = dashboard;
    // The ref is checked and set in the same tick, so a second click during the same
    // render cannot start a second request.
    if (
      !canEscalate
      || !currentDashboard
      || currentDashboard.escalationEligibleTotal === 0
      || escalationInFlight.current
    ) {
      return;
    }
    escalationInFlight.current = true;
    setEscalating(true);
    setDashboardNotice(null);
    setDashboardActionError(null);
    setEscalationError(null);
    try {
      const client = createHmsClient();
      // The server count is authoritative: what was eligible may have changed since
      // this page was drawn, so report what it actually sent, not what we displayed.
      const { dispatched } = await client.escalateOverdueRetests();
      setConfirmingEscalation(false);
      setDashboardNotice(
        dispatched
          ? `${formatNumber(dispatched)} overdue retest${dispatched === 1 ? "" : "s"} escalated successfully.`
          : "All overdue retests have already been escalated today."
      );
      try {
        setDashboard(await client.getDashboard(overduePageSize, overdueStart, reportingPeriod));
      } catch {
        // The escalation itself worked; only the refreshed numbers are stale.
        setDashboardActionError("The escalation was sent, but the dashboard could not be refreshed. Reload to see the latest numbers.");
      }
    } catch (error: unknown) {
      // Nothing was sent: keep the dialog open and say why.
      setEscalationError(friendlyApiError(error, { fallback: "The overdue retest escalations could not be sent. Try again." }).message);
    } finally {
      escalationInFlight.current = false;
      setEscalating(false);
    }
  }

  return (
    <section className="console-dashboard" aria-label="Dashboard workspace">
      <header className="dashboard-source-row dashboard-hero">
        <div>
          <span className="dashboard-context">Dashboard</span>
          <h2>Good {greetingForCurrentTime(dashboardNow)}{userName ? `, ${userName}` : ""}</h2>
          <p>
            Current status as at {formatAsOf(dashboard.asOf, dashboard.timezone)}. Activity shown for {reportingPeriod.label.toLowerCase()}. {REPORTING_PERIOD_SCOPE_NOTE}
          </p>
        </div>
        <div className="dashboard-hero-actions">
          <span className="dashboard-date"><CalendarClock aria-hidden="true" size={18} />{formatDashboardDate(dashboardNow)}</span>
          <ReportingPeriodControl
            onChange={(period) => {
              setReportingPeriod(withReportingTimeZone(period, dashboard.timezone));
              setOverduePage(1);
            }}
            period={reportingPeriod}
            timeZone={dashboard.timezone}
          />
        </div>
      </header>
      {dashboardStale ? (
        <ActionNotice kind="error" onDismiss={() => setDashboardStale(null)}>{dashboardStale}</ActionNotice>
      ) : null}
      <div className="kpi-grid" aria-label="Operational highlights" role="group">
        <StaggerGroup className="kpi-grid-motion">
          <StaggerItem>
            <MetricCard
              icon={<Activity aria-hidden="true" size={18} />}
              label="Total Assets"
              value={formatNumber(dashboard.totalAssets)}
              helper={`Every asset on record, across ${formatNumber(dashboard.totalCustomers)} customers`}
              action="Open asset register"
              onClick={() => onModuleChange("assets")}
              tone="blue"
              trend={series ? series.assetsAdded.values : undefined}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<CheckCircle2 aria-hidden="true" size={18} />}
              label="Retest on-track rate"
              value={onTrackRate === null ? "N/A" : `${onTrackRate}%`}
              helper={
                onTrackRate === null
                  ? "No eligible assets to measure"
                  : `${formatNumber(fleet.onTrack)} of ${formatNumber(fleet.total)} eligible assets on track`
              }
              action="View the retest schedule"
              onClick={() => onModuleChange("retest")}
              tone={onTrackRate === null ? "blue" : "green"}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<AlertTriangle aria-hidden="true" size={18} />}
              label="Overdue"
              value={formatNumber(dashboard.overdueAssets)}
              helper={
                dashboard.overdueAssets
                  ? `${assetCountLabel(dashboard.overdueAssets)} past a retest due date`
                  : "No overdue retests"
              }
              action="Review overdue retests"
              onClick={() => onModuleChange("retest")}
              tone="red"
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<Hourglass aria-hidden="true" size={18} />}
              label="Awaiting review"
              value={formatNumber(dashboard.awaitingReviewInspections)}
              helper="Inspections waiting for a reviewer"
              action="Review submitted inspections"
              onClick={() => onModuleChange("inspections")}
              tone="amber"
              trend={series ? series.inspectionsSubmitted.values : undefined}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<BellRing aria-hidden="true" size={18} />}
              label="Escalated"
              value={formatNumber(escalationTotal)}
              helper={
                escalationTotal
                  ? `${formatNumber(dashboard.escalatedToday)} sent today`
                  : "No overdue retest has been escalated"
              }
              action="Review overdue retests"
              onClick={() => onModuleChange("retest")}
              tone="violet"
              trend={series ? series.retestsEscalated.values : undefined}
            />
          </StaggerItem>
        </StaggerGroup>
      </div>

      <div className="dashboard-command-grid">
        <section className="data-panel trend-panel">
          <div className="panel-heading compact">
            <div>
              <h2>Operational Trends</h2>
              <p>
                {/* The period the figures on screen belong to, which during a change is
                    still the previous one until its replacement arrives. */}
                {activity
                  ? `Recorded activity for ${activity.periodLabel.toLowerCase()}, by ${activity.report.granularity}.`
                  : "Recorded activity for the selected period."}
                {activityLoading && activity && activity.periodLabel !== reportingPeriod.label
                  ? ` Updating to ${reportingPeriod.label.toLowerCase()}…`
                  : ""}
              </p>
            </div>
            <button className="subtle-link-button" onClick={() => onModuleChange("analytics")} type="button">
              <ChartNoAxesCombined aria-hidden="true" size={17} />
              Analytics
            </button>
          </div>
          <OperationalTrendPanel
            activity={activity?.report ?? null}
            error={activityError}
            isStale={Boolean(activity && activity.periodLabel !== reportingPeriod.label)}
            series={series}
          />
        </section>
        <FleetStatusPanel fleet={fleet} onModuleChange={onModuleChange} />
      </div>

      <div className="dashboard-layout">
        <div className="dashboard-primary">
          <section className="data-panel overdue-panel">
            <div className="panel-heading">
              <div>
                <div className="section-title"><h2>Overdue Retests</h2><span className="section-count is-urgent" aria-hidden="true">{formatNumber(dashboard.overdueTotal)}</span></div>
                <p>{assetCountLabel(dashboard.overdueTotal)} past {dashboard.overdueTotal === 1 ? "its" : "their"} retest due date</p>
              </div>
              <div className="panel-actions">
                <ActionButton
                  disabled={dashboard.overdueTotal === 0}
                  onClick={() => void exportOverdueRetests()}
                  pending={isExporting}
                  pendingLabel="Exporting…"
                  variant="secondary"
                >
                  <Download aria-hidden="true" size={15} />
                  Export all
                </ActionButton>
                <ActionButton
                  disabled={!canEscalate || dashboard.escalationEligibleTotal === 0}
                  onClick={() => { setEscalationError(null); setConfirmingEscalation(true); }}
                  variant="secondary"
                >
                  <Send aria-hidden="true" size={14} />
                  Send Escalation
                </ActionButton>
              </div>
            </div>
            {dashboardNotice ? <ActionNotice kind="success" onDismiss={() => setDashboardNotice(null)}>{dashboardNotice}</ActionNotice> : null}
            {dashboardActionError ? <ActionNotice kind="error" onDismiss={() => setDashboardActionError(null)}>{dashboardActionError}</ActionNotice> : null}
            <ConfirmDialog
              confirmLabel="Send escalations"
              error={escalationError}
              message={`This notifies the owners of ${formatNumber(dashboard.escalationEligibleTotal)} overdue asset${dashboard.escalationEligibleTotal === 1 ? "" : "s"}. Assets already escalated today, suspended schedules, and condemned, retired or draft assets are not included.`}
              onCancel={() => { if (!isEscalating) { setConfirmingEscalation(false); setEscalationError(null); } }}
              onConfirm={() => void sendOverdueEscalation()}
              open={isConfirmingEscalation}
              pending={isEscalating}
              pendingLabel="Sending…"
              title="Send overdue retest escalations?"
            />
            <PresencePanel presenceKey={`overdue-${overduePage}-${overduePageSize}`}>
              <OperationsTable
                ariaLabel="Overdue retests"
                columns={["Asset", "Customer", "Product", "Due Date", "Days Overdue", "Status"]}
                emptyMessage="No overdue retests. Your retest schedule is up to date."
                onFirstCellClick={(index) => onAssetOpen(dashboard.overdueRetests[index].assetId)}
                firstCellActionLabel={(index) => `Open asset ${assetAccessibleName(dashboard.overdueRetests[index])}`}
                paginate={false}
                rows={dashboard.overdueRetests.map((retest) => [
                  assetLabel(retest),
                  retest.customerName,
                  retest.productName,
                  retest.dueAt,
                  `+${retest.daysOverdue}`,
                  retest.status
                ])}
              />
            </PresencePanel>
            <DashboardPagination
              onPageChange={setOverduePage}
              onPageSizeChange={(size) => {
                setOverduePageSize(size);
                setOverduePage(1);
              }}
              page={overduePage}
              pageCount={overduePageCount}
              pageSize={overduePageSize}
              start={overdueStart}
              total={dashboard.overdueTotal}
            />
          </section>

          <section className="data-panel awaiting-panel">
            <div className="panel-heading">
              <div>
                <div className="section-title"><h2>Awaiting review</h2><span className="section-count" aria-hidden="true">{formatNumber(dashboard.awaitingReviewInspections)}</span></div>
                <p>{dashboard.awaitingReviewInspections} {dashboard.awaitingReviewInspections === 1 ? "inspection" : "inspections"} pending reviewer approval</p>
              </div>
              <button className="secondary-button" onClick={() => onModuleChange("inspections")} type="button">Review All <ArrowRight aria-hidden="true" size={14} /></button>
            </div>
            <div className="review-strip">
              {dashboard.awaitingReview.map((inspection) => (
                <m.button
                  aria-label={`Open inspection ${assetAccessibleName(inspection)}`}
                  className="review-card"
                  key={inspection.inspectionId}
                  onClick={() => onModuleChange("inspections", inspection.inspectionId)}
                  transition={motionTokens.spring.gentle}
                  type="button"
                  whileHover={reducedMotion ? undefined : { x: 2 }}
                  whileTap={reducedMotion ? undefined : { scale: 0.985 }}
                >
                  <span className="review-icon"><ClipboardCheck aria-hidden="true" size={20} /></span>
                  <span className="review-identity">
                    <AssetIdentity asset={inspection} />
                    <span>{inspection.inspectionType.replaceAll("_", " ").toLowerCase()}</span>
                  </span>
                  <span className="review-card-result">{inspection.result ?? "Not assessed"}</span>
                  <span className="mini-status submitted">{inspection.status.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="review-card-action">Open review <ArrowUpRight aria-hidden="true" size={14} /></span>
                </m.button>
              ))}
              {dashboard.awaitingReview.length === 0 ? <p className="dashboard-empty">No inspections are awaiting review.</p> : null}
            </div>
          </section>
        </div>

        <aside className="dashboard-side">
          <section className="data-panel due-panel">
            <div className="panel-heading compact">
              <h2>Due This Week</h2>
              <CalendarClock aria-hidden="true" size={18} />
            </div>
            <div className="due-list">
              {dashboard.dueThisWeek.map((item) => (
                <button className="due-item" aria-label={`Open scheduled asset ${assetAccessibleName(item)}`} key={item.assetId} onClick={() => onAssetOpen(item.assetId)} type="button">
                  <CalendarClock aria-hidden="true" size={15} />
                  <span>
                    <AssetIdentity asset={item} />
                    <span>{item.customerName}</span>
                  </span>
                  <time>{item.dueAt}</time>
                </button>
              ))}
              {dashboard.dueThisWeek.length === 0 ? <div className="schedule-empty"><CheckCircle2 aria-hidden="true" size={20} /><p>No retests due this week.</p></div> : null}
            </div>
            <button className="schedule-link" onClick={() => onModuleChange("retest")} type="button">Open retest schedule <ArrowRight aria-hidden="true" size={15} /></button>
          </section>
          <RecentActivityPanel error={eventsError} events={dashboardEvents} now={dashboardNow} period={reportingPeriod} />
        </aside>
      </div>

    </section>
  );
}

function DashboardPagination({
  onPageChange,
  onPageSizeChange,
  page,
  pageCount,
  pageSize,
  start,
  total
}: {
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  page: number;
  pageCount: number;
  pageSize: number;
  start: number;
  total: number;
}) {
  const end = Math.min(start + pageSize, total);
  const hasItems = total > 0;

  return (
    <div className="dashboard-pagination">
      <label className="dashboard-page-size">
        <span>Rows per page</span>
        <select aria-label="Rows per page" onChange={(event) => onPageSizeChange(Number(event.target.value))} value={pageSize}>
          {overduePageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <span className="dashboard-page-status">Page {page} of {pageCount}</span>
      <nav aria-label="Overdue retest pages" className="dashboard-page-controls">
        <button aria-label="Previous page" disabled={page === 1 || !hasItems} onClick={() => onPageChange(page - 1)} type="button">
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
          <button
            aria-current={number === page ? "page" : undefined}
            aria-label={`Page ${number}`}
            className={number === page ? "is-active" : undefined}
            key={number}
            onClick={() => onPageChange(number)}
            type="button"
          >
            {number}
          </button>
        ))}
        <button aria-label="Next page" disabled={page === pageCount || !hasItems} onClick={() => onPageChange(page + 1)} type="button">
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </nav>
      <span className="dashboard-page-summary">{hasItems ? `${start + 1}-${end} of ${total} overdue` : "No overdue retests"}</span>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-AU").format(value);
}

function greetingForCurrentTime(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function formatDashboardDate(now: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(now));
}

/**
 * The six series the reporting API returns, each counted by the server from an exact
 * timestamp. Nothing here is inferred from an audit action's wording, and there is no
 * "retests completed" series: completing a retest only moves its due date, leaving no
 * timestamp to count.
 */
const activitySeriesOrder = [
  { key: "assetsAdded", label: "Assets added", className: "trend-assets" },
  { key: "inspectionsSubmitted", label: "Inspections submitted", className: "trend-inspections" },
  { key: "inspectionsApproved", label: "Inspections approved", className: "trend-approved" },
  { key: "inspectionsRejected", label: "Inspections rejected", className: "trend-rejected" },
  { key: "certificatesIssued", label: "Certificates issued", className: "trend-certificates" },
  { key: "retestsEscalated", label: "Retests escalated", className: "trend-escalations" }
] as const;

type ActivitySeriesKey = (typeof activitySeriesOrder)[number]["key"];

/** An activity report together with the reporting period it was loaded for. */
interface LoadedActivity {
  report: ActivityReport;
  periodLabel: string;
}

interface ActivitySeries {
  label: string;
  className: string;
  values: number[];
  total: number;
}

type ActivitySeriesSet = Record<ActivitySeriesKey, ActivitySeries> & { labels: string[] };

function activitySeries(activity: ActivityReport | null): ActivitySeriesSet | null {
  if (!activity || activity.buckets.length === 0) {
    return null;
  }
  const labels = activity.buckets.map((bucket) =>
    formatBucketLabel(bucket.start, activity.granularity, activity.timezone)
  );
  const entries = activitySeriesOrder.map((series) => {
    const values = activity.buckets.map((bucket) => bucket[series.key]);
    return [
      series.key,
      {
        label: series.label,
        className: series.className,
        values,
        total: activity.totals[series.key]
      }
    ] as const;
  });
  return { ...Object.fromEntries(entries), labels } as ActivitySeriesSet;
}

function formatBucketLabel(start: string, granularity: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === "hour"
      ? { hour: "numeric", timeZone }
      : { day: "numeric", month: "short", timeZone };
  return new Intl.DateTimeFormat("en-AU", options).format(new Date(start));
}

function formatAsOf(asOf: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short"
  }).format(new Date(asOf));
}

/** Named for the as-of date as the Dashboard shows it, which is the organisation's date. */
function overdueExportName(asOf: string, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).format(new Date(asOf));
  return `overdue-retests-${date}.csv`;
}

/** Every overdue row, not just the page on screen, read through the same queue. */
async function fetchAllOverdueRetests(
  total: number,
  period: ReportingPeriod
): Promise<DashboardRetestRecord[]> {
  const pageSize = 100;
  const maxRows = 5_000;
  const client = createHmsClient();
  const rows: DashboardRetestRecord[] = [];
  while (rows.length < Math.min(total, maxRows)) {
    const page = await client.getDashboard(pageSize, rows.length, period);
    if (page.overdueRetests.length === 0) {
      break;
    }
    rows.push(...page.overdueRetests);
  }
  return rows;
}

function chartPath(values: number[], maxValue: number, width: number, height: number): string {
  const padding = { top: 16, right: 12, bottom: 28, left: 12 };
  return values
    .map((value, index) => {
      const x = padding.left + ((width - padding.left - padding.right) * index) / Math.max(1, values.length - 1);
      const y = height - padding.bottom - ((height - padding.top - padding.bottom) * value) / Math.max(1, maxValue);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function OperationsHeader({
  description,
  eyebrow,
  icon,
  title
}: {
  description: string;
  eyebrow: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <header className="operations-header">
      <div className="operations-heading-icon">{icon}</div>
      <div>
        <span>{eyebrow}</span>
        <strong className="operations-title">{title}</strong>
        <p>{description}</p>
      </div>
    </header>
  );
}

function MetricCard({
  action,
  helper,
  icon,
  label,
  onClick,
  tone,
  trend,
  value
}: {
  action: string;
  helper: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone: "blue" | "green" | "amber" | "red" | "violet";
  /** Activity for the period. Omitted where no series describes this metric. */
  trend?: number[];
  value: string;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <m.button
      aria-label={action}
      className={`kpi-card tone-${tone}`}
      onClick={onClick}
      transition={motionTokens.spring.gentle}
      type="button"
      whileHover={reducedMotion ? undefined : { y: -1 }}
      whileTap={reducedMotion ? undefined : { scale: 0.985 }}
    >
      <div className="kpi-icon">{icon}</div>
      <span className="kpi-label">{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
      {trend && trend.some((value) => value > 0) ? <MetricSparkline values={trend} /> : null}
      <span className="kpi-action">
        {action}
        <ArrowUpRight aria-hidden="true" size={15} />
      </span>
    </m.button>
  );
}

function MetricSparkline({ values }: { values: number[] }) {
  const maxValue = Math.max(...values, 1);
  return (
    <svg aria-hidden="true" className="kpi-sparkline" viewBox="0 0 100 34">
      <path d={chartPath(values, maxValue, 100, 34)} pathLength="1" />
    </svg>
  );
}

function OperationalTrendPanel({
  activity,
  error,
  isStale,
  series
}: {
  activity: ActivityReport | null;
  error: string | null;
  /** True while these figures belong to a period other than the one now selected. */
  isStale: boolean;
  series: ActivitySeriesSet | null;
}) {
  if (error) {
    return (
      <div className="operational-trend">
        <p className="trend-empty">{error}</p>
      </div>
    );
  }
  if (!series || !activity) {
    return (
      <div className="operational-trend">
        <p className="trend-empty">Loading recorded activity…</p>
      </div>
    );
  }

  const lines = activitySeriesOrder.map((entry) => series[entry.key]);
  const maxValue = Math.max(...lines.flatMap((line) => line.values), 1);
  const hasActivity = lines.some((line) => line.total > 0);
  const labelStep = Math.max(1, Math.ceil(series.labels.length / 6));

  return (
    <div className={`operational-trend${isStale ? " is-stale" : ""}`} aria-busy={isStale || undefined}>
      {hasActivity ? (
        <>
          <svg aria-hidden="true" className="operational-trend-chart" viewBox="0 0 640 240">
            {[0.25, 0.5, 0.75, 1].map((ratio) => <line className="trend-grid-line" key={ratio} x1="12" x2="628" y1={212 - 196 * ratio} y2={212 - 196 * ratio} />)}
            {lines.map((line) => <path className={`trend-line ${line.className}`} d={chartPath(line.values, maxValue, 640, 240)} key={line.label} pathLength="1" />)}
            {series.labels.map((label, index) => (
              index % labelStep === 0 ? (
                <text key={`${label}-${index}`} x={12 + (616 * index) / Math.max(1, series.labels.length - 1)} y="235">{label}</text>
              ) : null
            ))}
          </svg>
          {/* The chart is decorative beside this table, which carries the same numbers
              for anyone reading with assistive technology or unable to tell the lines
              apart by colour. The wrapper, not the table, carries ``sr-only``: a CSS
              table treats a specified width as a minimum, so a 1px table still lays out
              at its content width and widens the page. */}
          <div className="sr-only">
          <table>
            <caption>
              Recorded activity by {activity.granularity}, {activity.timezone}
            </caption>
            <thead>
              <tr>
                <th scope="col">Period starting</th>
                {lines.map((line) => <th key={line.label} scope="col">{line.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {series.labels.map((label, index) => (
                <tr key={`${label}-${index}`}>
                  <th scope="row">{label}</th>
                  {lines.map((line) => <td key={line.label}>{line.values[index]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      ) : <p className="trend-empty">No activity was recorded in this period.</p>}
      <div className="trend-legend" aria-label="Operational trend legend">
        {lines.map((line) => (
          <span className={line.className} key={line.label}>
            <i aria-hidden="true" />
            {line.label} {formatNumber(line.total)}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecentActivityPanel({
  error,
  events,
  now,
  period
}: {
  error: string | null;
  events: AuditEventRecord[];
  now: number;
  period: ReportingPeriod;
}) {
  const start = new Date(period.startAt).getTime();
  const end = new Date(period.endAt).getTime();
  const recentEvents = events
    .filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp >= start && timestamp < end;
    })
    .slice(0, 3);
  return (
    <section className="data-panel recent-activity-panel">
      <div className="panel-heading compact">
        <h2>Recent Activity</h2>
        <Activity aria-hidden="true" size={18} />
      </div>
      <div className="recent-activity-list">
        {recentEvents.map((event) => {
          const kind = auditEventKind(event);
          const Icon = kind === "inspections" ? ClipboardCheck : kind === "retests" ? CalendarClock : kind === "escalations" ? AlertTriangle : Boxes;
          return (
            <article className={`recent-activity-item ${kind ?? "other"}`} key={`${event.sequence}-${event.hash}`}>
              <span className="recent-activity-icon"><Icon aria-hidden="true" size={16} /></span>
              <div><strong>{formatAuditAction(event.action)}</strong><span>{event.entity} record</span></div>
              <time dateTime={event.timestamp}>{formatRelativeTime(event.timestamp, now)}</time>
            </article>
          );
        })}
        {error ? <p className="dashboard-empty">{error}</p> : null}
        {!error && recentEvents.length === 0 ? <p className="dashboard-empty">No activity was recorded in this period.</p> : null}
      </div>
    </section>
  );
}

/**
 * Which icon a single audit entry gets in the Recent Activity list. Presentation only:
 * the activity figures come from the reporting API, never from matching words here.
 */
function auditEventKind(event: AuditEventRecord): string | null {
  const [entity] = event.action.split(".");
  if (event.action.endsWith(".escalated")) return "escalations";
  if (entity === "retest_schedule") return "retests";
  if (entity.startsWith("inspection")) return "inspections";
  if (entity === "asset") return "assets";
  return null;
}

function formatRelativeTime(value: string, now: number): string {
  const elapsedSeconds = Math.round((new Date(value).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const [unit, seconds] = units.find(([, size]) => Math.abs(elapsedSeconds) >= size) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(elapsedSeconds / seconds), unit);
}

/**
 * The fleet's retest status as one partition: every eligible asset is in exactly one
 * category, so the segments and the percentages can be read against the whole fleet.
 */
function FleetStatusPanel({
  fleet,
  onModuleChange
}: {
  fleet: FleetStatus;
  onModuleChange: (module: AppModule) => void;
}) {
  const segments: FleetSegment[] = [
    {
      id: "on-track",
      label: "On track",
      description: "Scheduled, with more than a week until the retest is due",
      value: fleet.onTrack,
      module: "retest"
    },
    {
      id: "due-soon",
      label: "Due soon",
      description: "Retest due within the next 7 days",
      value: fleet.dueSoon,
      module: "retest"
    },
    {
      id: "overdue",
      label: "Overdue",
      description: "Past the retest due date",
      value: fleet.overdue,
      module: "retest"
    },
    {
      id: "suspended",
      label: "Suspended",
      description: "Retest schedule suspended, so no retest is expected",
      value: fleet.suspended,
      module: "retest"
    },
    {
      id: "unscheduled",
      label: "Unscheduled",
      description: "No retest schedule, so no retest date is being tracked",
      value: fleet.unscheduled,
      module: "assets"
    }
  ];
  const total = fleet.total;
  const [selection, setSelectedStatus] = useState<FleetSegmentId | null>(null);
  const selectedStatus = selection
    ?? (fleet.overdue > 0 ? "overdue" : fleet.dueSoon > 0 ? "due-soon" : "on-track");
  const selectedSegment = segments.find((segment) => segment.id === selectedStatus) ?? segments[0];
  const circumference = 2 * Math.PI * 48;
  let offset = 0;

  function selectSegment(status: FleetSegmentId) {
    setSelectedStatus(status);
  }

  function selectWithKeyboard(event: KeyboardEvent<SVGCircleElement>, status: FleetSegmentId) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSegment(status);
    }
  }

  return (
    <section className="data-panel health-panel">
      <div className="panel-heading compact">
        <div>
          <h2>Fleet Retest Status</h2>
          <p>{assetCountLabel(total)} eligible for retest{total ? "" : ". Condemned, retired and draft assets are not counted"}</p>
        </div>
      </div>
      <div className="fleet-ring" aria-label="Fleet retest status distribution" role="group">
        <svg className="fleet-ring-chart" viewBox="0 0 120 120">
          <circle className="fleet-ring-track" cx="60" cy="60" r="48" />
          <g transform="rotate(-90 60 60)">
            {segments.map((segment) => {
              const segmentLength = total ? (segment.value / total) * circumference : 0;
              const dashOffset = -offset;
              offset += segmentLength;
              const percentage = total ? Math.round((segment.value / total) * 100) : 0;
              const countLabel = assetCountLabel(segment.value);
              return segmentLength > 0 ? (
                <circle
                  aria-label={`${segment.label}: ${countLabel}, ${percentage}% of the eligible fleet`}
                  aria-pressed={selectedStatus === segment.id}
                  className={`fleet-segment fleet-segment-${segment.id}${selectedStatus === segment.id ? " is-selected" : ""}`}
                  cx="60"
                  cy="60"
                  key={segment.id}
                  onClick={() => selectSegment(segment.id)}
                  onFocus={() => selectSegment(segment.id)}
                  onKeyDown={(event) => selectWithKeyboard(event, segment.id)}
                  onPointerEnter={() => selectSegment(segment.id)}
                  r="48"
                  role="button"
                  strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
                  strokeDashoffset={dashOffset}
                  tabIndex={0}
                />
              ) : null;
            })}
          </g>
        </svg>
        <div className="fleet-ring-core" aria-live="polite">
          <span>{selectedSegment.label}</span>
          <strong>{formatNumber(selectedSegment.value)}</strong>
          <small>{total ? `${Math.round((selectedSegment.value / total) * 100)}% of the fleet` : "No eligible assets"}</small>
        </div>
      </div>
      <p className="fleet-status-meaning">{selectedSegment.description}.</p>
      <div className="health-legend">
        {segments.map((segment) => {
          const percentage = total ? Math.round((segment.value / total) * 100) : 0;
          return (
            <button
        aria-label={`${segment.label}: ${assetCountLabel(segment.value)}, ${percentage}% of the eligible fleet`}
              className={`fleet-legend-button fleet-legend-${segment.id}${selectedStatus === segment.id ? " is-selected" : ""}`}
              key={segment.id}
              onClick={() => selectSegment(segment.id)}
              onFocus={() => selectSegment(segment.id)}
              onPointerEnter={() => selectSegment(segment.id)}
              type="button"
            >
              <span>
                <i aria-hidden="true" className={`dot fleet-segment-${segment.id}`} />
                {segment.label}
                <small>{percentage}%</small>
              </span>
              <strong>{formatNumber(segment.value)}</strong>
            </button>
          );
        })}
      </div>
      <button className="schedule-link" onClick={() => onModuleChange(selectedSegment.module)} type="button">
        {selectedSegment.id === "unscheduled" ? "Open asset register" : "Open retest schedule"} <ArrowRight aria-hidden="true" size={15} />
      </button>
    </section>
  );
}

type FleetSegmentId = "on-track" | "due-soon" | "overdue" | "suspended" | "unscheduled";

interface FleetSegment {
  id: FleetSegmentId;
  label: string;
  /** What this category means, so a reader never has to guess the rule. */
  description: string;
  value: number;
  module: AppModule;
}

function assetCountLabel(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "asset" : "assets"}`;
}

function OperationsTable({
  ariaLabel,
  columns,
  emptyMessage = "No records found.",
  firstCellActionLabel,
  onFirstCellClick,
  paginate = true,
  rows
}: {
  ariaLabel: string;
  columns: string[];
  emptyMessage?: string;
  firstCellActionLabel?: (index: number) => string;
  onFirstCellClick?: (index: number) => void;
  paginate?: boolean;
  rows: string[][];
}) {
  const pagination = usePagination(rows);
  const visibleRows = paginate ? pagination.items : rows;
  const rowStart = paginate ? pagination.start : 0;

  return (
    <section className="operations-table-panel">
      <div className="table-frame">
        <table className="console-table" aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{emptyMessage}</td>
              </tr>
            ) : (
              visibleRows.map((row, rowIndex) => (
                <tr key={row.join("-")}>
                  {row.map((cell, index) => (
                    <td key={`${cell}-${index}`}>
                      {index === 0 && onFirstCellClick && firstCellActionLabel ? (
                        <button
                          aria-label={firstCellActionLabel(rowStart + rowIndex)}
                          className="dashboard-asset-link"
                          onClick={() => onFirstCellClick(rowStart + rowIndex)}
                          type="button"
                        >
                          {cell}
                        </button>
                      ) : index === 0 ? <strong>{cell}</strong> : cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paginate ? (
        <PaginationControls
          label={ariaLabel}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
          page={pagination.page}
          pageCount={pagination.pageCount}
          pageSize={pagination.pageSize}
          start={pagination.start}
          total={pagination.total}
        />
      ) : null}
    </section>
  );
}

function formatAuditAction(action: string): string {
  return action
    .split(".")
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part
    )
    .join(" ");
}

function errorMessage(error: unknown, fallback = "Audit events could not be loaded."): string {
  if (error instanceof HmsApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}
