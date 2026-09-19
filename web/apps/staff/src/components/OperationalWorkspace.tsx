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
import { useEffect, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import {
  createHmsClient,
  HmsApiError
} from "../api/hmsClient";
import type { AuditEventRecord, DashboardRecord } from "../domain/types";
import { PresencePanel, StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { motionTokens } from "../motion/motionTokens";
import { WorkspaceState } from "./WorkspaceState";
import { downloadCsv } from "./ModuleTable";
import { PaginationControls, usePagination } from "./Pagination";
import { ReportingPeriodControl } from "./ReportingPeriodControl";
import type { AppModule } from "./AppShell";
import { reportingPeriodForPreset } from "../utils/reportingPeriod";
import type { ReportingPeriod } from "../utils/reportingPeriod";

export type OperationalModule = "dashboard" | "sync";

interface OperationalWorkspaceProps {
  canEscalate: boolean;
  module: OperationalModule;
  onAssetOpen: (assetId: string) => void;
  onModuleChange: (module: AppModule, inspectionId?: string) => void;
  userName: string;
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
  const [overduePage, setOverduePage] = useState(1);
  const [overduePageSize, setOverduePageSize] = useState(overduePageSizes[0]);
  const overdueStart = (overduePage - 1) * overduePageSize;
  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const [dashboardActionError, setDashboardActionError] = useState<string | null>(null);
  const [isEscalating, setEscalating] = useState(false);
  const [reportingPeriod, setReportingPeriod] = useState<ReportingPeriod>(() => reportingPeriodForPreset("last_month"));
  const [dashboardNow] = useState(() => Date.now());
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (module !== "dashboard") {
      return;
    }

    let active = true;
      setDashboardLoading(true);
      setDashboardError(null);
    createHmsClient()
      .getDashboard(overduePageSize, overdueStart, reportingPeriod)
      .then((result) => {
        if (!active) {
          return;
        }
        const pageCount = Math.max(1, Math.ceil(result.overdueTotal / overduePageSize));
        if (overduePage > pageCount) {
          setOverduePage(pageCount);
          return;
        }
        setDashboard(result);
        setDashboardLoading(false);
      })
      .catch((error: unknown) => {
        if (active) {
          setDashboardError(errorMessage(error));
          setDashboardLoading(false);
        }
      });

    createHmsClient()
      .listAuditEvents({ limit: 100, sort: "-sequence" })
      .then((result) => {
        if (active) {
          setDashboardEvents(result.items);
        }
      })
      .catch(() => {
        if (active) {
          setDashboardEvents([]);
        }
      });

    return () => {
      active = false;
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
  const healthTotal =
    dashboard.inServiceAssets + dashboard.dueSoonAssets + dashboard.overdueAssets;
  const fleetHealth = healthTotal
    ? Math.round((dashboard.inServiceAssets / healthTotal) * 100)
    : 0;
  const activityEvents = dashboardEvents.filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    return timestamp >= new Date(reportingPeriod.startAt).getTime()
      && timestamp < new Date(reportingPeriod.endAt).getTime();
  });
  const activityWindowDays = Math.max(
    1,
    Math.ceil((new Date(reportingPeriod.endAt).getTime() - new Date(reportingPeriod.startAt).getTime()) / 86_400_000)
  );
  const activityTrend = buildActivityTrend(activityEvents, activityWindowDays, new Date(reportingPeriod.endAt).getTime());
  const escalationTotal = dashboard.overdueRetests.filter((retest) => retest.status === "ESCALATED").length;
  function exportOverdueRetests() {
    if (!dashboard) {
      return;
    }
    downloadCsv("overdue-retests.csv", [
      ["Asset", "Customer", "Product", "Due date", "Days overdue", "Status"],
      ...dashboard.overdueRetests.map((retest) => [
        retest.assetNumber,
        retest.customerName,
        retest.productName,
        retest.dueAt,
        String(retest.daysOverdue),
        retest.status
      ])
    ]);
    setDashboardActionError(null);
    setDashboardNotice("Downloaded the current overdue retest page.");
  }

  async function sendOverdueEscalation() {
    const currentDashboard = dashboard;
    if (!canEscalate || !currentDashboard || currentDashboard.overdueTotal === 0 || isEscalating) {
      return;
    }
    if (!window.confirm(`Send overdue retest escalations for ${currentDashboard.overdueTotal} asset${currentDashboard.overdueTotal === 1 ? "" : "s"}?`)) {
      return;
    }
    setEscalating(true);
    setDashboardNotice(null);
    setDashboardActionError(null);
    try {
      const client = createHmsClient();
      const dispatched = await client.escalateOverdueRetests();
      setDashboard(await client.getDashboard(overduePageSize, overdueStart, reportingPeriod));
      setDashboardNotice(
        dispatched
          ? `Queued escalations for ${dispatched} overdue asset${dispatched === 1 ? "" : "s"}.`
          : "All overdue retests have already been escalated today."
      );
    } catch (error: unknown) {
      setDashboardActionError(errorMessage(error, "Unable to send overdue retest escalations."));
    } finally {
      setEscalating(false);
    }
  }

  return (
    <section className="console-dashboard" aria-label="Dashboard workspace">
      <header className="dashboard-source-row dashboard-hero">
        <div>
          <span className="dashboard-context">Dashboard</span>
          <h2>Good {greetingForCurrentTime(dashboardNow)}, {userName}</h2>
          <p>Operational records for {reportingPeriod.label.toLowerCase()}.</p>
        </div>
        <div className="dashboard-hero-actions">
          <span className="dashboard-date"><CalendarClock aria-hidden="true" size={18} />{formatDashboardDate(dashboardNow)}</span>
          <ReportingPeriodControl
            onChange={(period) => {
              setReportingPeriod(period);
              setOverduePage(1);
            }}
            period={reportingPeriod}
          />
        </div>
      </header>
      <div className="kpi-grid" aria-label="Operational highlights" role="group">
        <StaggerGroup className="kpi-grid-motion">
          <StaggerItem>
            <MetricCard
              icon={<Activity aria-hidden="true" size={18} />}
              label="Total Assets"
              value={formatNumber(dashboard.totalAssets)}
              helper={`Across ${formatNumber(dashboard.totalCustomers)} customers`}
              action="Open asset register"
              onClick={() => onModuleChange("assets")}
              tone="blue"
              trend={activityTrend.assets}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<CheckCircle2 aria-hidden="true" size={18} />}
              label="Healthy Fleet"
              value={formatNumber(dashboard.inServiceAssets)}
              helper={`${fleetHealth}% fleet health`}
              action="View in-service assets"
              onClick={() => onModuleChange("assets")}
              tone="green"
              trend={activityTrend.assets}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<AlertTriangle aria-hidden="true" size={18} />}
              label="Overdue"
              value={formatNumber(dashboard.overdueAssets)}
              helper={dashboard.overdueAssets ? "Requires immediate action" : "No overdue retests"}
              action="Review overdue retests"
              onClick={() => onModuleChange("retest")}
              tone="red"
              trend={activityTrend.retests}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<Hourglass aria-hidden="true" size={18} />}
              label="Pending Review"
              value={formatNumber(dashboard.awaitingReviewInspections)}
              helper="Submitted inspections pending review"
              action="Review submitted inspections"
              onClick={() => onModuleChange("inspections")}
              tone="amber"
              trend={activityTrend.inspections}
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<BellRing aria-hidden="true" size={18} />}
              label="Escalations"
              value={formatNumber(escalationTotal)}
              helper={escalationTotal ? "Needs attention" : "No active escalations"}
              action="Review overdue retests"
              onClick={() => onModuleChange("retest")}
              tone="violet"
              trend={activityTrend.escalations}
            />
          </StaggerItem>
        </StaggerGroup>
      </div>

      <div className="dashboard-command-grid">
        <section className="data-panel trend-panel">
          <div className="panel-heading compact">
            <div>
              <h2>Operational Trends</h2>
              <p>Recorded asset, inspection, and retest activity over time.</p>
            </div>
            <button className="subtle-link-button" onClick={() => onModuleChange("analytics")} type="button">
              <ChartNoAxesCombined aria-hidden="true" size={17} />
              Analytics
            </button>
          </div>
          <OperationalTrendPanel trend={activityTrend} />
        </section>
        <FleetHealthPanel
          dueSoonAssets={dashboard.dueSoonAssets}
          inServiceAssets={dashboard.inServiceAssets}
          overdueAssets={dashboard.overdueAssets}
        />
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
                <button className="secondary-button" onClick={exportOverdueRetests} type="button">
                  <Download aria-hidden="true" size={15} />
                  Export
                </button>
                <button
                  className="danger-button"
                  disabled={!canEscalate || dashboard.overdueTotal === 0 || isEscalating}
                  onClick={() => void sendOverdueEscalation()}
                  type="button"
                >
                  <Send aria-hidden="true" size={14} />
                  {isEscalating ? "Sending..." : "Send Escalation"}
                </button>
              </div>
            </div>
            {dashboardNotice ? <p className="dashboard-action-notice" role="status">{dashboardNotice}</p> : null}
            {dashboardActionError ? <p className="dashboard-action-error" role="alert">{dashboardActionError}</p> : null}
            <PresencePanel presenceKey={`overdue-${overduePage}-${overduePageSize}`}>
              <OperationsTable
                ariaLabel="Overdue retests"
                columns={["Asset", "Customer", "Product", "Due Date", "Days Overdue", "Status"]}
                emptyMessage="No overdue retests. Your retest schedule is up to date."
                onFirstCellClick={(index) => onAssetOpen(dashboard.overdueRetests[index].assetId)}
                firstCellActionLabel={(index) => `Open asset ${dashboard.overdueRetests[index].assetNumber}`}
                paginate={false}
                rows={dashboard.overdueRetests.map((retest) => [
                  retest.assetNumber,
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
                <div className="section-title"><h2>Awaiting Review</h2><span className="section-count" aria-hidden="true">{formatNumber(dashboard.awaitingReviewInspections)}</span></div>
                <p>{dashboard.awaitingReviewInspections} {dashboard.awaitingReviewInspections === 1 ? "inspection" : "inspections"} pending reviewer approval</p>
              </div>
              <button className="secondary-button" onClick={() => onModuleChange("inspections")} type="button">Review All <ArrowRight aria-hidden="true" size={14} /></button>
            </div>
            <div className="review-strip">
              {dashboard.awaitingReview.map((inspection) => (
                <m.button
                  aria-label={`Open inspection ${inspection.assetNumber}`}
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
                    <strong>{inspection.assetNumber}</strong>
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
                <button className="due-item" aria-label={`Open scheduled asset ${item.assetNumber}`} key={item.assetId} onClick={() => onAssetOpen(item.assetId)} type="button">
                  <CalendarClock aria-hidden="true" size={15} />
                  <span>
                    <strong>{item.assetNumber}</strong>
                    <span>{item.customerName}</span>
                  </span>
                  <time>{item.dueAt}</time>
                </button>
              ))}
              {dashboard.dueThisWeek.length === 0 ? <div className="schedule-empty"><CheckCircle2 aria-hidden="true" size={20} /><p>No retests due this week.</p></div> : null}
            </div>
            <button className="schedule-link" onClick={() => onModuleChange("retest")} type="button">Open retest schedule <ArrowRight aria-hidden="true" size={15} /></button>
          </section>
          <RecentActivityPanel events={activityEvents} now={dashboardNow} />
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

type ActivitySeriesName = "assets" | "inspections" | "retests" | "escalations";

interface ActivityTrend {
  assets: number[];
  escalations: number[];
  inspections: number[];
  labels: string[];
  retests: number[];
}

function activitySeriesFor(event: AuditEventRecord): ActivitySeriesName | null {
  const source = `${event.action} ${event.entity}`.toLowerCase();
  if (source.includes("escalat")) return "escalations";
  if (source.includes("retest") || source.includes("schedule")) return "retests";
  if (source.includes("inspection")) return "inspections";
  if (source.includes("asset")) return "assets";
  return null;
}

function buildActivityTrend(events: AuditEventRecord[], days: number, now: number): ActivityTrend {
  const bucketCount = 8;
  const bucketDuration = (days * 86_400_000) / bucketCount;
  const start = now - days * 86_400_000;
  const trend: ActivityTrend = {
    assets: Array.from({ length: bucketCount }, () => 0),
    escalations: Array.from({ length: bucketCount }, () => 0),
    inspections: Array.from({ length: bucketCount }, () => 0),
    labels: Array.from({ length: bucketCount }, (_, index) =>
      new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(
        new Date(start + bucketDuration * (index + 1))
      )
    ),
    retests: Array.from({ length: bucketCount }, () => 0)
  };

  events.forEach((event) => {
    const series = activitySeriesFor(event);
    const timestamp = new Date(event.timestamp).getTime();
    if (!series || Number.isNaN(timestamp)) return;
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor((timestamp - start) / bucketDuration)));
    trend[series][bucket] += 1;
  });

  return trend;
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
  trend: number[];
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
      <MetricSparkline values={trend} />
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

function OperationalTrendPanel({ trend }: { trend: ActivityTrend }) {
  const series = [
    { className: "trend-assets", label: "Assets", values: trend.assets },
    { className: "trend-inspections", label: "Inspections", values: trend.inspections },
    { className: "trend-retests", label: "Retests", values: trend.retests },
    { className: "trend-escalations", label: "Escalations", values: trend.escalations }
  ];
  const maxValue = Math.max(...series.flatMap((entry) => entry.values), 1);
  const hasActivity = series.some((entry) => entry.values.some((value) => value > 0));

  return (
    <div className="operational-trend">
      {hasActivity ? (
        <svg aria-label="Operational activity trend" className="operational-trend-chart" role="img" viewBox="0 0 640 240">
          <desc>Recorded operational events grouped across the selected time range.</desc>
          {[0.25, 0.5, 0.75, 1].map((ratio) => <line className="trend-grid-line" key={ratio} x1="12" x2="628" y1={212 - 196 * ratio} y2={212 - 196 * ratio} />)}
          {series.map((entry) => <path className={`trend-line ${entry.className}`} d={chartPath(entry.values, maxValue, 640, 240)} key={entry.label} pathLength="1" />)}
          {trend.labels.map((label, index) => (
            <text key={label} x={12 + (616 * index) / Math.max(1, trend.labels.length - 1)} y="235">{label}</text>
          ))}
        </svg>
      ) : <p className="trend-empty">No recorded operational activity in this range.</p>}
      <div className="trend-legend" aria-label="Operational trend legend">
        {series.map((entry) => <span className={entry.className} key={entry.label}><i aria-hidden="true" />{entry.label}</span>)}
      </div>
    </div>
  );
}

function RecentActivityPanel({ events, now }: { events: AuditEventRecord[]; now: number }) {
  const recentEvents = events.slice(0, 3);
  return (
    <section className="data-panel recent-activity-panel">
      <div className="panel-heading compact">
        <h2>Recent Activity</h2>
        <Activity aria-hidden="true" size={18} />
      </div>
      <div className="recent-activity-list">
        {recentEvents.map((event) => {
          const series = activitySeriesFor(event);
          const Icon = series === "inspections" ? ClipboardCheck : series === "retests" ? CalendarClock : series === "escalations" ? AlertTriangle : Boxes;
          return (
            <article className={`recent-activity-item ${series ?? "other"}`} key={`${event.sequence}-${event.hash}`}>
              <span className="recent-activity-icon"><Icon aria-hidden="true" size={16} /></span>
              <div><strong>{formatAuditAction(event.action)}</strong><span>{event.entity} record</span></div>
              <time dateTime={event.timestamp}>{formatRelativeTime(event.timestamp, now)}</time>
            </article>
          );
        })}
        {recentEvents.length === 0 ? <p className="dashboard-empty">No recent activity has been recorded.</p> : null}
      </div>
    </section>
  );
}

function formatRelativeTime(value: string, now: number): string {
  const elapsedSeconds = Math.round((new Date(value).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const [unit, seconds] = units.find(([, size]) => Math.abs(elapsedSeconds) >= size) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(elapsedSeconds / seconds), unit);
}

function FleetHealthPanel({
  dueSoonAssets,
  inServiceAssets,
  overdueAssets
}: {
  dueSoonAssets: number;
  inServiceAssets: number;
  overdueAssets: number;
}) {
  const [selection, setSelectedStatus] = useState<FleetStatus | null>(null);
  const selectedStatus = selection ?? (overdueAssets > 0 ? "overdue" : dueSoonAssets > 0 ? "due-soon" : "active");
  const total = inServiceAssets + dueSoonAssets + overdueAssets;
  const segments: FleetSegment[] = [
    { id: "active", label: "Active fleet", value: inServiceAssets },
    { id: "due-soon", label: "Due soon", value: dueSoonAssets },
    { id: "overdue", label: "Overdue", value: overdueAssets }
  ];
  const selectedSegment = segments.find((segment) => segment.id === selectedStatus) ?? segments[0];
  const circumference = 2 * Math.PI * 48;
  let offset = 0;

  function selectSegment(status: FleetStatus) {
    setSelectedStatus(status);
  }

  function selectWithKeyboard(event: KeyboardEvent<SVGCircleElement>, status: FleetStatus) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSegment(status);
    }
  }

  return (
    <section className="data-panel health-panel">
      <div className="panel-heading compact">
        <div>
          <h2>Fleet Health</h2>
          <p>{assetCountLabel(total)} monitored for retest</p>
        </div>
      </div>
      <div className="fleet-ring" aria-label="Fleet health distribution" role="group">
        <svg className="fleet-ring-chart" viewBox="0 0 120 120">
          <circle className="fleet-ring-track" cx="60" cy="60" r="48" />
          <g transform="rotate(-90 60 60)">
            {segments.map((segment) => {
              const segmentLength = total ? (segment.value / total) * circumference : 0;
              const dashOffset = -offset;
              offset += segmentLength;
              const percentage = total ? Math.round((segment.value / total) * 100) : 0;
              const assetLabel = assetCountLabel(segment.value);
              return segmentLength > 0 ? (
                <circle
                  aria-label={`${segment.label}: ${assetLabel}, ${percentage}% of fleet`}
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
          <small>{total ? `${Math.round((selectedSegment.value / total) * 100)}% of fleet` : "No monitored assets"}</small>
        </div>
      </div>
      <div className="health-legend">
        {segments.map((segment) => {
          const percentage = total ? Math.round((segment.value / total) * 100) : 0;
          return (
            <button
              aria-pressed={selectedStatus === segment.id}
              className={`fleet-legend-button fleet-legend-${segment.id}${selectedStatus === segment.id ? " is-selected" : ""}`}
              key={segment.id}
              onClick={() => selectSegment(segment.id)}
              onFocus={() => selectSegment(segment.id)}
              onPointerEnter={() => selectSegment(segment.id)}
              type="button"
            >
              <span>
                <i
                  aria-hidden="true"
                  className={`dot ${segment.id === "active" ? "success" : segment.id === "due-soon" ? "warning" : "danger"}-dot`}
                />
                {segment.label}
                <small>{percentage}%</small>
              </span>
              <strong>{formatNumber(segment.value)}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

type FleetStatus = "active" | "due-soon" | "overdue";

interface FleetSegment {
  id: FleetStatus;
  label: string;
  value: number;
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
