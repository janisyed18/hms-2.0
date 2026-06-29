import {
  Activity,
  BadgeCheck,
  BellRing,
  ClipboardCheck,
  CloudCog,
  RefreshCcw,
  ShieldCheck
} from "lucide-react";
import type { ReactNode } from "react";

export type OperationalModule = "dashboard" | "sync" | "audit";

interface OperationalWorkspaceProps {
  module: OperationalModule;
  source: "api" | "mock";
}

const syncRows = [
  ["Certificate issue", "Queued", "CERT-VOPA-NEW-1", "2 min ago"],
  ["Inspection draft", "Ready", "997950", "9 min ago"],
  ["Asset update", "Waiting", "ORIC-100", "18 min ago"]
];

const auditRows = [
  ["Inspection approved", "Alex Williams", "ORIC-100", "2026-06-29 10:41"],
  ["Certificate issued", "Alex Williams", "CERT-VOPA-NEW-1", "2026-06-29 10:48"],
  ["Asset reviewed", "Alex Williams", "997950", "2026-06-29 11:02"]
];

export function OperationalWorkspace({ module, source }: OperationalWorkspaceProps) {
  if (module === "sync") {
    return (
      <section className="operations-page" aria-label="Sync queue workspace">
        <OperationsHeader
          eyebrow="Operations"
          icon={<RefreshCcw aria-hidden="true" size={20} />}
          source={source}
          title="Sync Queue"
          description="Read-only local queue view for records waiting on future sync APIs."
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
    return (
      <section className="operations-page" aria-label="Audit workspace">
        <OperationsHeader
          eyebrow="Governance"
          icon={<ShieldCheck aria-hidden="true" size={20} />}
          source={source}
          title="Audit Trail"
          description="Read-only local event stream for inspection, certificate, and asset activity."
        />
        <OperationsTable
          ariaLabel="Audit trail events"
          columns={["Event", "Actor", "Record", "Time"]}
          rows={auditRows}
        />
      </section>
    );
  }

  return (
    <section className="operations-page" aria-label="Dashboard workspace">
      <OperationsHeader
        eyebrow="Overview"
        icon={<Activity aria-hidden="true" size={20} />}
        source={source}
        title="Operations Dashboard"
        description="Current operational snapshot across customers, assets, inspections, and certificates."
      />
      <div className="operations-grid" aria-label="Operational highlights">
        <MetricCard
          icon={<ClipboardCheck aria-hidden="true" size={18} />}
          label="Open inspections"
          value="4"
          tone="blue"
        />
        <MetricCard
          icon={<BadgeCheck aria-hidden="true" size={18} />}
          label="Issued certificates"
          value="2"
          tone="green"
        />
        <MetricCard
          icon={<CloudCog aria-hidden="true" size={18} />}
          label="Sync items"
          value="7"
          tone="amber"
        />
        <MetricCard
          icon={<BellRing aria-hidden="true" size={18} />}
          label="Attention"
          value="3"
          tone="red"
        />
      </div>
      <div className="operations-split">
        <section className="operations-panel">
          <h3>Today</h3>
          <p>
            Inspection approvals, certificate issue events, and asset review items are grouped here
            for the staff workspace.
          </p>
        </section>
        <section className="operations-panel">
          <h3>Next Review</h3>
          <p>
            The next focused build phase can replace this read-only snapshot with backend
            dashboard aggregates.
          </p>
        </section>
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
  source: "api" | "mock";
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
      <strong>{source === "api" ? "Backend" : "Mock data"}</strong>
    </header>
  );
}

function MetricCard({
  icon,
  label,
  tone,
  value
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "green" | "amber" | "red";
  value: string;
}) {
  return (
    <div className={`operations-metric tone-${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperationsTable({
  ariaLabel,
  columns,
  rows
}: {
  ariaLabel: string;
  columns: string[];
  rows: string[][];
}) {
  return (
    <section className="table-panel operations-table-panel">
      <div className="table-frame">
        <table aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.join("-")}>
                {row.map((cell, index) => (
                  <td key={`${cell}-${index}`}>{index === 0 ? <strong>{cell}</strong> : cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
