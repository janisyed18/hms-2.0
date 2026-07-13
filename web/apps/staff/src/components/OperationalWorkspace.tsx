import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Download,
  Hourglass,
  RefreshCcw,
  ShieldCheck
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { HmsApiError, loadAuditEventsWithFallback } from "../api/hmsClient";
import type { AuditEventRecord, DataSource } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { WorkspaceState } from "./WorkspaceState";

export type OperationalModule = "dashboard" | "sync" | "audit";

interface OperationalWorkspaceProps {
  module: OperationalModule;
  source: DataSource;
}

const syncRows = [
  ["Certificate issue", "Queued", "CERT-VOPA-NEW-1", "2 min ago"],
  ["Inspection draft", "Ready", "997950", "9 min ago"],
  ["Asset update", "Waiting", "ORIC-100", "18 min ago"]
];

const overdueRows = [
  ["HOS-2024-0891", "North Sea Shipping", "Composite 2\" WP20", "2026-05-15", "+43", "Overdue"],
  ["HOS-2024-0643", "Pacific Marine Ltd", "Rubber 3\" WP15", "2026-05-22", "+36", "Overdue"],
  ["HOS-2025-0112", "Bateman Offshore", "SS 1.5\" WP50", "2026-06-01", "+26", "Escalated"],
  ["HOS-2023-1044", "Coastal Fuels Pty", "PVC 4\" WP10", "2026-06-10", "+17", "Escalated"],
  ["HOS-2025-0331", "Harbour Logistics", "Composite 1\" WP25", "2026-06-18", "+9", "Overdue"]
];

const dueThisWeekRows = [
  ["HOS-2024-0921", "North Sea Shipping", "Jun 30"],
  ["HOS-2025-0156", "Pacific Marine Ltd", "Jul 01"],
  ["HOS-2024-0788", "Bateman Offshore", "Jul 02"],
  ["HOS-2025-0299", "Coastal Fuels Pty", "Jul 03"]
];

const awaitingReviewRows = [
  ["INS-2026-0441", "HOS-2024-0891", "Submitted", "Pressure test passed"],
  ["INS-2026-0440", "HOS-2024-0643", "Failed", "Pressure below threshold"],
  ["INS-2026-0438", "HOS-2025-0201", "Approved", "Certificate ready"]
];

export function OperationalWorkspace({ module, source }: OperationalWorkspaceProps) {
  const [auditEvents, setAuditEvents] = useState<AuditEventRecord[]>([]);
  const [auditSource, setAuditSource] = useState<DataSource>(source);
  const [auditError, setAuditError] = useState<string | null>(null);

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

  return (
    <section className="console-dashboard" aria-label="Dashboard workspace">
      <div className="dashboard-source-row">
        <span className={source === "api" ? "source-api" : "source-mock"}>
          {source === "api" ? "Backend" : "Mock data"}
        </span>
      </div>
      <div className="kpi-grid" aria-label="Operational highlights" role="group">
        <StaggerGroup className="kpi-grid-motion">
          <StaggerItem>
            <MetricCard
              icon={<Activity aria-hidden="true" size={18} />}
              label="Total Assets"
              value="1,247"
              helper="Across 34 customers"
              tone="blue"
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<CheckCircle2 aria-hidden="true" size={18} />}
              label="In Service"
              value="1,089"
              helper="87.3% fleet health"
              tone="green"
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<AlertTriangle aria-hidden="true" size={18} />}
              label="Overdue"
              value="23"
              helper="Requires immediate action"
              tone="red"
            />
          </StaggerItem>
          <StaggerItem>
            <MetricCard
              icon={<Hourglass aria-hidden="true" size={18} />}
              label="Awaiting Review"
              value="8"
              helper="3 critical, 5 standard"
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
                <p>23 assets past their retest due date</p>
              </div>
              <div className="panel-actions">
                <button className="secondary-button" type="button">
                  <Download aria-hidden="true" size={15} />
                  Export
                </button>
                <button className="danger-button" type="button">Send Escalation</button>
              </div>
            </div>
            <OperationsTable
              ariaLabel="Overdue retests"
              columns={["Asset", "Customer", "Product", "Due Date", "Days Overdue", "Status"]}
              rows={overdueRows}
            />
            <div className="panel-footer">
              <span>Showing 5 of 23 overdue</span>
              <button type="button">View all</button>
            </div>
          </section>

          <section className="data-panel awaiting-panel">
            <div className="panel-heading">
              <div>
                <h2>Awaiting Review</h2>
                <p>8 inspections submitted, pending reviewer approval</p>
              </div>
              <button className="secondary-button" type="button">Review All</button>
            </div>
            <div className="review-strip">
              {awaitingReviewRows.map(([inspection, asset, status, note]) => (
                <article key={inspection}>
                  <span className="asset-code">{inspection}</span>
                  <strong>{asset}</strong>
                  <span className={`mini-status ${status.toLowerCase()}`}>{status}</span>
                  <p>{note}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="dashboard-side">
          <section className="data-panel health-panel">
            <div className="panel-heading compact">
              <h2>Fleet Health</h2>
            </div>
            <div className="fleet-ring" aria-hidden="true" />
            <div className="health-legend">
              <div><span><i className="dot success-dot" />Active fleet</span><strong>1,089</strong></div>
              <div><span><i className="dot warning-dot" />Due Soon</span><strong>135</strong></div>
              <div><span><i className="dot danger-dot" />Overdue</span><strong>23</strong></div>
            </div>
          </section>

          <section className="data-panel due-panel">
            <div className="panel-heading compact">
              <h2>Due This Week</h2>
            </div>
            <div className="due-list">
              {dueThisWeekRows.map(([asset, customer, due]) => (
                <article key={asset}>
                  <CalendarClock aria-hidden="true" size={15} />
                  <div>
                    <strong>{asset}</strong>
                    <span>{customer}</span>
                  </div>
                  <time>{due}</time>
                </article>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
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
  helper,
  icon,
  label,
  tone,
  value
}: {
  helper: string;
  icon: ReactNode;
  label: string;
  tone: "blue" | "green" | "amber" | "red";
  value: string;
}) {
  return (
    <div className={`kpi-card tone-${tone}`}>
      <div className="kpi-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </div>
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

function formatDateTime(value: string): string {
  return value.replace("T", " ").replace(/Z$/, "");
}

function formatAuditAction(action: string): string {
  return action
    .split(".")
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part
    )
    .join(" ");
}

function errorMessage(error: unknown): string {
  if (error instanceof HmsApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Audit events could not be loaded.";
}
