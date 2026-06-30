import {
  BadgeCheck,
  Clock3,
  KeyRound,
  Laptop,
  LockKeyhole,
  ServerCog,
  ShieldCheck,
  Smartphone,
  UsersRound,
  Wifi
} from "lucide-react";
import type { ReactNode } from "react";

export type SystemModule = "users" | "devices";

interface SystemWorkspaceProps {
  module: SystemModule;
  source: "api" | "mock";
}

const userRows = [
  ["James Mitchell", "HMS Admin", "Full access", "Active", "Today"],
  ["Rebecca Thompson", "Reviewer", "Approve inspections", "Active", "2h ago"],
  ["Martin Kelly", "Inspector", "Create inspections", "Active", "4h ago"],
  ["Client Portal", "Customer Viewer", "Read certificates", "Restricted", "Yesterday"]
];

const roleRows = [
  ["HMS Admin", "All modules", "Approve, issue, archive", "4 users"],
  ["Reviewer", "Inspections, Certificates", "Approve and issue", "7 users"],
  ["Inspector", "Assets, Inspections", "Draft and submit", "18 users"],
  ["Customer Viewer", "Certificates", "Read-only", "34 users"]
];

const deviceRows = [
  ["Field Tablet 01", "iPad Pro", "Offline Ready", "Synced 8 min ago", "26.4.1"],
  ["Field Tablet 02", "iPad Air", "Sync Pending", "Queued 14 items", "26.4.1"],
  ["Workshop Kiosk", "Windows Tablet", "Online", "Synced 2 min ago", "26.4.0"],
  ["Pressure Bench", "Android Rugged", "Attention", "Last seen yesterday", "26.3.8"]
];

const deviceQueueRows = [
  ["Inspection drafts", "14", "Ready"],
  ["Pressure readings", "8", "Queued"],
  ["Certificate receipts", "3", "Synced"]
];

export function SystemWorkspace({ module, source }: SystemWorkspaceProps) {
  if (module === "devices") {
    return (
      <section className="system-workspace" aria-label="Device workspace">
        <WorkspaceSource source={source} />
        <MetricGrid
          items={[
            {
              icon: <Smartphone aria-hidden="true" size={18} />,
              label: "Registered Devices",
              value: "24",
              helper: "18 active in the last 24 hours",
              tone: "blue"
            },
            {
              icon: <Wifi aria-hidden="true" size={18} />,
              label: "Sync Health",
              value: "96%",
              helper: "Most devices synced recently",
              tone: "green"
            },
            {
              icon: <ServerCog aria-hidden="true" size={18} />,
              label: "Queued Events",
              value: "25",
              helper: "Waiting for backend confirmation",
              tone: "amber"
            },
            {
              icon: <Clock3 aria-hidden="true" size={18} />,
              label: "Needs Attention",
              value: "1",
              helper: "Device last seen yesterday",
              tone: "red"
            }
          ]}
        />

        <div className="system-layout">
          <section className="data-panel">
            <div className="panel-heading">
              <div>
                <h2>Registered Devices</h2>
                <p>Field devices currently known to the HMS workspace.</p>
              </div>
            </div>
            <SystemTable
              ariaLabel="Device records"
              columns={["Device", "Platform", "State", "Last Sync", "App"]}
              rows={deviceRows}
            />
          </section>

          <section className="data-panel">
            <div className="panel-heading compact">
              <h2>Sync Health</h2>
            </div>
            <div className="device-health-list">
              {deviceQueueRows.map(([label, count, status]) => (
                <article key={label}>
                  <Laptop aria-hidden="true" size={17} />
                  <div>
                    <strong>{label}</strong>
                    <span>{status}</span>
                  </div>
                  <em>{count}</em>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    );
  }

  return (
    <section className="system-workspace" aria-label="Users and roles workspace">
      <WorkspaceSource source={source} />
      <MetricGrid
        items={[
          {
            icon: <UsersRound aria-hidden="true" size={18} />,
            label: "Active Users",
            value: "63",
            helper: "Staff and customer portal users",
            tone: "blue"
          },
          {
            icon: <ShieldCheck aria-hidden="true" size={18} />,
            label: "Admin Seats",
            value: "4",
            helper: "Full HMS access",
            tone: "green"
          },
          {
            icon: <KeyRound aria-hidden="true" size={18} />,
            label: "Reviewer Seats",
            value: "7",
            helper: "Can approve inspections",
            tone: "amber"
          },
          {
            icon: <LockKeyhole aria-hidden="true" size={18} />,
            label: "Restricted Users",
            value: "34",
            helper: "Certificate and customer views",
            tone: "red"
          }
        ]}
      />

      <div className="system-layout">
        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>User Directory</h2>
              <p>Read-only staff access view for the development console.</p>
            </div>
          </div>
          <SystemTable
            ariaLabel="User access records"
            columns={["User", "Role", "Scope", "Status", "Last Active"]}
            rows={userRows}
          />
        </section>

        <section className="data-panel">
          <div className="panel-heading compact">
            <h2>Role Matrix</h2>
          </div>
          <div className="role-matrix">
            {roleRows.map(([role, modules, permissions, users]) => (
              <article key={role}>
                <BadgeCheck aria-hidden="true" size={17} />
                <div>
                  <strong>{role}</strong>
                  <span>{modules}</span>
                  <p>{permissions}</p>
                </div>
                <em>{users}</em>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function WorkspaceSource({ source }: { source: "api" | "mock" }) {
  return (
    <div className="dashboard-source-row">
      <span className={source === "api" ? "source-api" : "source-mock"}>
        {source === "api" ? "Backend" : "Mock data"}
      </span>
    </div>
  );
}

function MetricGrid({
  items
}: {
  items: Array<{
    helper: string;
    icon: ReactNode;
    label: string;
    tone: "blue" | "green" | "amber" | "red";
    value: string;
  }>;
}) {
  return (
    <div className="kpi-grid" aria-label="System highlights">
      {items.map((item) => (
        <div className={`kpi-card tone-${item.tone}`} key={item.label}>
          <div className="kpi-icon">{item.icon}</div>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.helper}</small>
        </div>
      ))}
    </div>
  );
}

function SystemTable({
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
