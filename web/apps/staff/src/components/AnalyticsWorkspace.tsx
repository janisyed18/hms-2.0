import {
  AlertTriangle,
  BarChart3,
  FileCheck2,
  Gauge,
  TimerReset
} from "lucide-react";
import type { ReactNode } from "react";

interface AnalyticsWorkspaceProps {
  source: "api" | "mock";
}

const riskRows = [
  ["North Sea Drilling", "12", "18", "92%", "High"],
  ["Oceanic Platforms", "3", "11", "89%", "High"],
  ["PetroMarine Services", "0", "9", "95%", "Medium"],
  ["Bluewater Energy", "0", "4", "100%", "Low"]
];

const throughputRows = [
  ["New Asset", "42", "38", "90%"],
  ["Service", "86", "73", "85%"],
  ["Pressure Retest", "28", "24", "86%"]
];

const trendPoints = [
  ["Jan", "81"],
  ["Feb", "83"],
  ["Mar", "84"],
  ["Apr", "86"],
  ["May", "87"],
  ["Jun", "87.3"]
];

export function AnalyticsWorkspace({ source }: AnalyticsWorkspaceProps) {
  return (
    <section className="analytics-workspace" aria-label="Analytics workspace">
      <div className="dashboard-source-row">
        <span className={source === "api" ? "source-api" : "source-mock"}>
          {source === "api" ? "Backend" : "Mock data"}
        </span>
      </div>

      <div className="kpi-grid" aria-label="Analytics highlights">
        <AnalyticsMetric
          icon={<Gauge aria-hidden="true" size={18} />}
          label="Fleet Health"
          value="87.3%"
          helper="+2.1% over last quarter"
          tone="green"
        />
        <AnalyticsMetric
          icon={<AlertTriangle aria-hidden="true" size={18} />}
          label="Retest Exposure"
          value="23"
          helper="Overdue assets currently visible"
          tone="red"
        />
        <AnalyticsMetric
          icon={<TimerReset aria-hidden="true" size={18} />}
          label="Approval Time"
          value="1.8d"
          helper="Submitted to approved median"
          tone="blue"
        />
        <AnalyticsMetric
          icon={<FileCheck2 aria-hidden="true" size={18} />}
          label="Certificate Coverage"
          value="92%"
          helper="Valid certificates on in-service fleet"
          tone="amber"
        />
      </div>

      <div className="analytics-layout">
        <section className="data-panel analytics-main-panel">
          <div className="panel-heading">
            <div>
              <h2>Fleet Health Trend</h2>
              <p>Six-month health movement across the visible HMS fleet.</p>
            </div>
            <BarChart3 aria-hidden="true" size={20} />
          </div>
          <div className="trend-chart" aria-label="Fleet health trend chart">
            {trendPoints.map(([month, value]) => (
              <div className="trend-column" key={month}>
                <span style={{ height: `${Number(value) * 0.82}%` }} />
                <strong>{value}%</strong>
                <small>{month}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="data-panel">
          <div className="panel-heading compact">
            <h2>Certificate Coverage</h2>
          </div>
          <div className="coverage-stack" aria-label="Certificate coverage">
            <div>
              <span>Valid</span>
              <strong>92%</strong>
              <i style={{ width: "92%" }} />
            </div>
            <div>
              <span>Expiring in 60 days</span>
              <strong>6%</strong>
              <i style={{ width: "6%" }} />
            </div>
            <div>
              <span>Requires review</span>
              <strong>2%</strong>
              <i style={{ width: "2%" }} />
            </div>
          </div>
        </section>
      </div>

      <div className="analytics-table-grid">
        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>Retest Risk by Customer</h2>
              <p>Customers ranked by overdue and near-term retest pressure.</p>
            </div>
          </div>
          <SimpleTable
            ariaLabel="Risk ranking"
            columns={["Customer", "Overdue", "Due Soon", "Coverage", "Risk"]}
            rows={riskRows}
          />
        </section>

        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>Inspection Throughput</h2>
              <p>Submitted and approved work by inspection category.</p>
            </div>
          </div>
          <SimpleTable
            ariaLabel="Inspection throughput"
            columns={["Type", "Submitted", "Approved", "Pass Rate"]}
            rows={throughputRows}
          />
        </section>
      </div>
    </section>
  );
}

function AnalyticsMetric({
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

function SimpleTable({
  ariaLabel,
  columns,
  rows
}: {
  ariaLabel: string;
  columns: string[];
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
            {rows.map((row) => (
              <tr key={row.join("-")}>
                {row.map((cell, index) => (
                  <td key={`${cell}-${index}`}>
                    {index === 0 ? <strong>{cell}</strong> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
