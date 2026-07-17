import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Hourglass,
  RefreshCcw,
  ShieldCheck,
  ArrowUpRight
} from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  createHmsClient,
  HmsApiError,
  loadAuditEventsWithFallback
} from "../api/hmsClient";
import type { AuditEventRecord, DashboardRecord, DataSource } from "../domain/types";
import { PresencePanel, StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { motionTokens } from "../motion/motionTokens";
import { formatDateTime } from "../utils/dateTime";
import { WorkspaceState } from "./WorkspaceState";
import { downloadCsv } from "./ModuleTable";
import type { AppModule } from "./AppShell";

export type OperationalModule = "dashboard" | "sync" | "audit";

interface OperationalWorkspaceProps {
  canEscalate: boolean;
  module: OperationalModule;
  onModuleChange: (module: AppModule, inspectionId?: string) => void;
  source: DataSource;
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
  onModuleChange,
  source
}: OperationalWorkspaceProps) {
  const [auditEvents, setAuditEvents] = useState<AuditEventRecord[]>([]);
  const [auditSource, setAuditSource] = useState<DataSource>(source);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [overduePage, setOverduePage] = useState(1);
  const [overduePageSize, setOverduePageSize] = useState(overduePageSizes[0]);
  const overdueStart = (overduePage - 1) * overduePageSize;
  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const [dashboardActionError, setDashboardActionError] = useState<string | null>(null);
  const [isEscalating, setEscalating] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (module !== "audit") {
      return;
    }

    let active = true;
    setAuditError(null);
    loadAuditEventsWithFallback({ sort: "-sequence" })
      .then((result) => {
        if (!active) {
          return;
        }
        setAuditEvents(result.items);
        setAuditSource(result.source);
      })
      .catch((error: unknown) => {
        if (active) {
          setAuditError(errorMessage(error));
        }
      });

    return () => {
      active = false;
    };
  }, [module]);

  useEffect(() => {
    if (module !== "dashboard") {
      return;
    }

    let active = true;
    setDashboardLoading(true);
    setDashboardError(null);
    createHmsClient()
      .getDashboard(overduePageSize, overdueStart)
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

    return () => {
      active = false;
    };
  }, [module, overduePage, overduePageSize, overdueStart]);

  if (module === "sync") {
    return (
      <section className="operations-page" aria-label="Sync queue workspace">
        <OperationsHeader
          eyebrow="Operations"
          icon={<RefreshCcw aria-hidden="true" size={20} />}
          source={source}
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

  if (module === "audit") {
    const auditRows = auditEvents.map((event) => [
      auditSource === "mock" ? formatAuditAction(event.action) : event.action,
      event.actorId,
      `${event.entity}:${event.entityId}`,
      formatDateTime(event.timestamp)
    ]);

    return (
      <section className="operations-page" aria-label="Audit workspace">
        <OperationsHeader
          eyebrow="Governance"
          icon={<ShieldCheck aria-hidden="true" size={20} />}
          source={auditSource}
          title="Audit Trail"
          description="Recent inspection, certificate, and asset lifecycle events across the staff workspace."
        />
        {auditError ? (
          <WorkspaceState title="Audit log unavailable" tone="error">
            {auditError}
          </WorkspaceState>
        ) : null}
        <OperationsTable
          ariaLabel="Audit trail events"
          columns={["Event", "Actor", "Record", "Time"]}
          rows={auditRows}
          emptyMessage="No audit events have been recorded yet."
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
  const fleetRingStyle = {
    background: `conic-gradient(var(--success) 0 ${fleetHealth}%, var(--warning) ${fleetHealth}% ${fleetHealth + (healthTotal ? Math.round((dashboard.dueSoonAssets / healthTotal) * 100) : 0)}%, var(--danger) 0 100%)`
  };

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
      setDashboard(await client.getDashboard(overduePageSize, overdueStart));
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
      <div className="dashboard-source-row">
        <span className="dashboard-context">Operational overview</span>
      </div>
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
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<CheckCircle2 aria-hidden="true" size={18} />}
              label="In Service"
              value={formatNumber(dashboard.inServiceAssets)}
              helper={`${fleetHealth}% fleet health`}
              action="View in-service assets"
              onClick={() => onModuleChange("assets")}
              tone="green"
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
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<Hourglass aria-hidden="true" size={18} />}
              label="Awaiting Review"
              value={formatNumber(dashboard.awaitingReviewInspections)}
              helper="Submitted inspections pending review"
              action="Review submitted inspections"
              onClick={() => onModuleChange("inspections")}
              tone="amber"
            />
          </StaggerItem>
        </StaggerGroup>
      </div>

      <div className="dashboard-layout">
        <div className="dashboard-primary">
          <section className="data-panel overdue-panel">
            <div className="panel-heading">
              <div>
                <h2>Overdue Retests</h2>
                <p>{dashboard.overdueTotal} assets past their retest due date</p>
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
                emptyMessage="No overdue retests in the backend data."
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
                <h2>Awaiting Review</h2>
                <p>{dashboard.awaitingReviewInspections} inspections submitted, pending reviewer approval</p>
              </div>
              <button className="secondary-button" onClick={() => onModuleChange("inspections")} type="button">Review All</button>
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
                  whileHover={reducedMotion ? undefined : { y: -3 }}
                  whileTap={reducedMotion ? undefined : { scale: 0.985 }}
                >
                  <span className="asset-code">{inspection.inspectionId}</span>
                  <strong>{inspection.assetNumber}</strong>
                  <span className={`mini-status ${inspection.status.toLowerCase()}`}>{inspection.status}</span>
                  <span className="review-card-result">{inspection.result ?? inspection.inspectionType}</span>
                  <span className="review-card-action">Open review <ArrowUpRight aria-hidden="true" size={14} /></span>
                </m.button>
              ))}
              {dashboard.awaitingReview.length === 0 ? <p className="dashboard-empty">No inspections are awaiting review.</p> : null}
            </div>
          </section>
        </div>

        <aside className="dashboard-side">
          <m.section
            className="data-panel health-panel"
            transition={motionTokens.spring.gentle}
            whileHover={reducedMotion ? undefined : { y: -2 }}
          >
            <div className="panel-heading compact">
              <h2>Fleet Health</h2>
            </div>
            <div className="fleet-ring" aria-hidden="true" style={fleetRingStyle}>
              <span className="fleet-ring-core" />
            </div>
            <div className="health-legend">
              <div><span><i className="dot success-dot" />Active fleet</span><strong>{formatNumber(dashboard.inServiceAssets)}</strong></div>
              <div><span><i className="dot warning-dot" />Due Soon</span><strong>{formatNumber(dashboard.dueSoonAssets)}</strong></div>
              <div><span><i className="dot danger-dot" />Overdue</span><strong>{formatNumber(dashboard.overdueAssets)}</strong></div>
            </div>
          </m.section>

          <section className="data-panel due-panel">
            <div className="panel-heading compact">
              <h2>Due This Week</h2>
            </div>
            <div className="due-list">
              {dashboard.dueThisWeek.map((item) => (
                <article key={item.assetId}>
                  <CalendarClock aria-hidden="true" size={15} />
                  <div>
                    <strong>{item.assetNumber}</strong>
                    <span>{item.customerName}</span>
                  </div>
                  <time>{item.dueAt}</time>
                </article>
              ))}
              {dashboard.dueThisWeek.length === 0 ? <p className="dashboard-empty">No retests due this week.</p> : null}
            </div>
          </section>
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

function OperationsHeader({
  description,
  eyebrow,
  icon,
  source,
  title
}: {
  description: string;
  eyebrow: string;
  icon: ReactNode;
  source: DataSource;
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
      <strong className={source === "api" ? "source-api" : "source-mock"}>
        {source === "api" ? "Backend" : "Mock data"}
      </strong>
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
  value
}: {
  action: string;
  helper: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone: "blue" | "green" | "amber" | "red";
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
      whileHover={reducedMotion ? undefined : { y: -4 }}
      whileTap={reducedMotion ? undefined : { scale: 0.985 }}
    >
      <div className="kpi-icon">{icon}</div>
      <span className="kpi-label">{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
      <span className="kpi-action">
        {action}
        <ArrowUpRight aria-hidden="true" size={15} />
      </span>
    </m.button>
  );
}

function OperationsTable({
  ariaLabel,
  columns,
  emptyMessage = "No records found.",
  rows
}: {
  ariaLabel: string;
  columns: string[];
  emptyMessage?: string;
  rows: string[][];
}) {
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
              rows.map((row) => (
                <tr key={row.join("-")}>
                  {row.map((cell, index) => (
                    <td key={`${cell}-${index}`}>{index === 0 ? <strong>{cell}</strong> : cell}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
