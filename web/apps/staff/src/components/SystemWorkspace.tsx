import {
  BadgeCheck,
  Clock3,
  KeyRound,
  Laptop,
  LockKeyhole,
  Plus,
  ServerCog,
  ShieldCheck,
  Smartphone,
  UsersRound,
  Wifi,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import {
  createHmsClient,
  HmsApiError,
  loadAdminUsersWithFallback,
  loadDevicesWithFallback
} from "../api/hmsClient";
import type {
  AdminUserFormValues,
  AdminUserRecord,
  DataSource,
  DeviceRecord
} from "../domain/types";
import { WorkspaceState } from "./WorkspaceState";

export type SystemModule = "users" | "devices";

interface SystemWorkspaceProps {
  module: SystemModule;
  source: DataSource;
}

const roles = ["HMS_ADMIN", "REVIEWER", "INSPECTOR", "ASSEMBLY", "CUSTOMER_USER"];

export function SystemWorkspace({ module, source }: SystemWorkspaceProps) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>(source);
  const [error, setError] = useState<string | null>(null);
  const [isUserFormOpen, setUserFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    if (module === "users") {
      loadAdminUsersWithFallback({ sort: "email" })
        .then((result) => {
          if (!active) {
            return;
          }
          setUsers(result.items);
          setDataSource(result.source);
        })
        .catch((loadError: unknown) => {
          if (active) {
            setError(errorMessage(loadError));
          }
        });
    }
    if (module === "devices") {
      loadDevicesWithFallback({ sort: "device_id" })
        .then((result) => {
          if (!active) {
            return;
          }
          setDevices(result.items);
          setDataSource(result.source);
        })
        .catch((loadError: unknown) => {
          if (active) {
            setError(errorMessage(loadError));
          }
        });
    }
    return () => {
      active = false;
    };
  }, [module, source]);

  const roleRows = useMemo(() => roleSummary(users), [users]);

  async function saveUser(values: AdminUserFormValues) {
    setError(null);
    try {
      const created =
        dataSource === "api"
          ? await createHmsClient().createAdminUser(values)
          : localUser(values);
      setUsers((current) => [created, ...current]);
      setUserFormOpen(false);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  async function archiveUser(user: AdminUserRecord) {
    setError(null);
    try {
      if (dataSource === "api") {
        await createHmsClient().archiveAdminUser(user.id);
      }
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch (archiveError) {
      setError(errorMessage(archiveError));
    }
  }

  async function revokeDevice(device: DeviceRecord) {
    setError(null);
    try {
      const updated =
        dataSource === "api"
          ? await createHmsClient().updateDevice(device.deviceId, {
              revoked: !device.revoked
            })
          : { ...device, revoked: !device.revoked, state: device.revoked ? "Active" : "Revoked" };
      setDevices((current) =>
        current.map((item) => (item.deviceId === device.deviceId ? updated : item))
      );
    } catch (deviceError) {
      setError(errorMessage(deviceError));
    }
  }

  if (module === "devices") {
    return (
      <section className="system-workspace" aria-label="Device workspace">
        <WorkspaceSource source={dataSource} />
        {error ? <WorkspaceState title="Device admin unavailable" tone="error">{error}</WorkspaceState> : null}
        <MetricGrid
          items={[
            {
              icon: <Smartphone aria-hidden="true" size={18} />,
              label: "Registered Devices",
              value: String(devices.length),
              helper: `${devices.filter((device) => !device.revoked).length} active devices`,
              tone: "blue"
            },
            {
              icon: <Wifi aria-hidden="true" size={18} />,
              label: "Sync Health",
              value: `${syncHealth(devices)}%`,
              helper: "Devices with recent sync state",
              tone: "green"
            },
            {
              icon: <ServerCog aria-hidden="true" size={18} />,
              label: "Offline Window",
              value: `${maxOfflineWindow(devices)}d`,
              helper: "Largest allowed offline window",
              tone: "amber"
            },
            {
              icon: <Clock3 aria-hidden="true" size={18} />,
              label: "Revoked",
              value: String(devices.filter((device) => device.revoked).length),
              helper: "Blocked from future sync",
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
            <DeviceTable devices={devices} onToggleRevoke={revokeDevice} />
          </section>

          <section className="data-panel">
            <div className="panel-heading compact">
              <h2>Sync Health</h2>
            </div>
            <div className="device-health-list">
              {devices.map((device) => (
                <article key={device.deviceId}>
                  <Laptop aria-hidden="true" size={17} />
                  <div>
                    <strong>{device.displayName ?? device.deviceId}</strong>
                    <span>{device.lastSyncAt ?? "Not synced yet"}</span>
                  </div>
                  <em>{device.state}</em>
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
      <WorkspaceSource source={dataSource} />
      {error ? <WorkspaceState title="User admin unavailable" tone="error">{error}</WorkspaceState> : null}
      <MetricGrid
        items={[
          {
            icon: <UsersRound aria-hidden="true" size={18} />,
            label: "Active Users",
            value: String(users.length),
            helper: "Persisted staff and customer users",
            tone: "blue"
          },
          {
            icon: <ShieldCheck aria-hidden="true" size={18} />,
            label: "Admin Seats",
            value: String(users.filter((user) => user.role === "HMS_ADMIN").length),
            helper: "Full HMS access",
            tone: "green"
          },
          {
            icon: <KeyRound aria-hidden="true" size={18} />,
            label: "Reviewer Seats",
            value: String(users.filter((user) => user.role === "REVIEWER").length),
            helper: "Can approve inspections",
            tone: "amber"
          },
          {
            icon: <LockKeyhole aria-hidden="true" size={18} />,
            label: "Restricted Users",
            value: String(users.filter((user) => user.role === "CUSTOMER_USER").length),
            helper: "Scoped customer access",
            tone: "red"
          }
        ]}
      />

      <div className="system-layout">
        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>User Directory</h2>
              <p>Persisted access records resolved by the HMS auth boundary.</p>
            </div>
            <button className="primary-button" type="button" onClick={() => setUserFormOpen(true)}>
              <Plus aria-hidden="true" size={15} />
              Add User
            </button>
          </div>
          <UserTable users={users} onArchive={archiveUser} />
        </section>

        <section className="data-panel">
          <div className="panel-heading compact">
            <h2>Role Matrix</h2>
          </div>
          <div className="role-matrix">
            {roleRows.map((row) => (
              <article key={row.role}>
                <BadgeCheck aria-hidden="true" size={17} />
                <div>
                  <strong>{row.role}</strong>
                  <span>{row.scope}</span>
                  <p>{row.permissions}</p>
                </div>
                <em>{row.count} users</em>
              </article>
            ))}
          </div>
        </section>
      </div>
      <UserForm
        open={isUserFormOpen}
        onClose={() => setUserFormOpen(false)}
        onSubmit={saveUser}
      />
    </section>
  );
}

function WorkspaceSource({ source }: { source: DataSource }) {
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

function UserTable({
  users,
  onArchive
}: {
  users: AdminUserRecord[];
  onArchive: (user: AdminUserRecord) => void;
}) {
  return (
    <section className="operations-table-panel">
      <div className="table-frame">
        <table className="console-table" aria-label="User access records">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Scope</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.displayName}</strong></td>
                <td>{user.email}</td>
                <td>
                  <span>{user.role}</span>
                  <small>{formatRole(user.role)}</small>
                </td>
                <td>{user.customerId ?? "All customers"}</td>
                <td>{formatDateTime(user.updatedAt)}</td>
                <td>
                  <button type="button" onClick={() => onArchive(user)}>
                    Archive user {user.email}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeviceTable({
  devices,
  onToggleRevoke
}: {
  devices: DeviceRecord[];
  onToggleRevoke: (device: DeviceRecord) => void;
}) {
  return (
    <section className="operations-table-panel">
      <div className="table-frame">
        <table className="console-table" aria-label="Device records">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>State</th>
              <th>Last Sync</th>
              <th>App</th>
              <th>Offline</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.deviceId}>
                <td><strong>{device.displayName ?? device.deviceId}</strong></td>
                <td>{device.platform}</td>
                <td>{device.state}</td>
                <td>{device.lastSyncAt ? formatDateTime(device.lastSyncAt) : "Not synced"}</td>
                <td>{device.appVersion}</td>
                <td>{device.offlineWindowDays} days</td>
                <td>
                  <button type="button" onClick={() => onToggleRevoke(device)}>
                    {device.revoked ? "Restore" : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserForm({
  open,
  onClose,
  onSubmit
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: AdminUserFormValues) => Promise<void>;
}) {
  const [oidcSubject, setOidcSubject] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState("INSPECTOR");
  const [isSubmitting, setSubmitting] = useState(false);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({
      oidcSubject,
      email,
      firstName: firstName.trim() || null,
      lastName: lastName.trim() || null,
      role,
      customerId: null
    });
    setOidcSubject("");
    setEmail("");
    setFirstName("");
    setLastName("");
    setRole("INSPECTOR");
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Add User</h2>
            <p>Create a persisted admin user for local role-bound testing.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>OIDC subject</span>
          <input
            aria-label="OIDC subject"
            required
            value={oidcSubject}
            onChange={(event) => setOidcSubject(event.target.value)}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            aria-label="Email"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span>First name</span>
          <input
            aria-label="First name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </label>
        <label>
          <span>Last name</span>
          <input
            aria-label="Last name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </label>
        <label>
          <span>Role</span>
          <select
            aria-label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {roles.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save user"}
          </button>
        </div>
      </form>
    </div>
  );
}

function roleSummary(users: AdminUserRecord[]) {
  return roles.map((role) => ({
    role,
    count: users.filter((user) => user.role === role).length,
    scope: role === "CUSTOMER_USER" ? "Customer scoped" : "Staff workspace",
    permissions:
      role === "HMS_ADMIN"
        ? "Administer records, users, devices, and audit"
        : role === "REVIEWER"
          ? "Review inspections and issue certificates"
          : role === "INSPECTOR"
            ? "Create and submit inspection records"
            : role === "ASSEMBLY"
              ? "Maintain asset and assembly records"
              : "Read assigned customer records"
  }));
}

function localUser(values: AdminUserFormValues): AdminUserRecord {
  const now = new Date().toISOString();
  return {
    id: `local-user-${Date.now()}`,
    oidcSubject: values.oidcSubject,
    email: values.email,
    firstName: values.firstName,
    lastName: values.lastName,
    displayName: [values.firstName, values.lastName].filter(Boolean).join(" ") || values.email,
    role: values.role,
    customerId: values.customerId,
    createdAt: now,
    updatedAt: now
  };
}

function syncHealth(devices: DeviceRecord[]): number {
  if (devices.length === 0) {
    return 0;
  }
  const healthy = devices.filter((device) => !device.revoked && device.lastSyncAt).length;
  return Math.round((healthy / devices.length) * 100);
}

function maxOfflineWindow(devices: DeviceRecord[]): number {
  return devices.reduce(
    (largest, device) => Math.max(largest, device.offlineWindowDays),
    0
  );
}

function formatDateTime(value: string): string {
  return value.replace("T", " ").replace(/Z$/, "");
}

function formatRole(role: string): string {
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .map((part) => (part === "Hms" ? "HMS" : part))
    .join(" ");
}

function errorMessage(error: unknown): string {
  if (error instanceof HmsApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Admin workspace data could not be loaded.";
}
