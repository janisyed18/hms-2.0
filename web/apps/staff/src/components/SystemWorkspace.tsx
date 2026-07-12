import {
  BadgeCheck,
  Clock3,
  Edit3,
  KeyRound,
  Laptop,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  UserCheck,
  UserX,
  UsersRound,
  Wifi
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  createHmsClient,
  HmsApiError,
  loadAdminUsersWithFallback,
  loadDevicesWithFallback
} from "../api/hmsClient";
import type {
  AdminUserRecord,
  DataSource,
  DeviceRecord,
  StaffRole
} from "../domain/types";
import { OneTimeCredentialDialog, type OneTimeCredential } from "./OneTimeCredentialDialog";
import {
  UserAdminDialog,
  type CustomerOption,
  type UserAdminValues
} from "./UserAdminDialog";
import { WorkspaceState } from "./WorkspaceState";
import { canManageRole } from "./roleAdmin";

export type SystemModule = "users" | "devices";

interface SystemWorkspaceProps {
  module: SystemModule;
  source: DataSource;
  actorRoles: StaffRole[];
  customerOptions: CustomerOption[];
}

const roles: StaffRole[] = [
  "SUPER_ADMIN",
  "HMS_ADMIN",
  "REVIEWER",
  "INSPECTOR",
  "ASSEMBLY",
  "CUSTOMER_USER"
];

export function SystemWorkspace({
  module,
  source,
  actorRoles,
  customerOptions
}: SystemWorkspaceProps) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>(source);
  const [error, setError] = useState<string | null>(null);
  const [userDialog, setUserDialog] = useState<{
    mode: "create" | "edit";
    user?: AdminUserRecord;
  } | null>(null);
  const [credential, setCredential] = useState<OneTimeCredential | null>(null);
  const [managedUserId, setManagedUserId] = useState<string | null>(null);

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

  async function saveUser(values: UserAdminValues) {
    setError(null);
    try {
      if (userDialog?.mode === "edit" && userDialog.user) {
        const updated =
          dataSource === "api"
            ? await createHmsClient().updateAdminUser(userDialog.user.id, {
                email: values.email,
                firstName: values.firstName || null,
                lastName: values.lastName || null,
                role: values.role,
                customerId: values.customerId
              })
            : {
                ...userDialog.user,
                email: values.email,
                firstName: values.firstName || null,
                lastName: values.lastName || null,
                displayName: displayNameFor(values),
                role: values.role,
                customerId: values.customerId,
                updatedAt: new Date().toISOString()
              };
        replaceUser(updated);
      } else {
        const result =
          dataSource === "api"
            ? await createHmsClient().createAdminUser({
                email: values.email,
                firstName: values.firstName || null,
                lastName: values.lastName || null,
                role: values.role,
                customerId: values.customerId
              })
            : localUser(values);
        setUsers((current) => [result.user, ...current]);
        setCredential({
          title: "Temporary password",
          label: "Password",
          value: result.temporaryPassword,
          note: "Give this password to the user securely. They must change it at first sign-in."
        });
      }
      setUserDialog(null);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  function replaceUser(updated: AdminUserRecord) {
    setUsers((current) =>
      current.map((item) => (item.id === updated.id ? updated : item))
    );
  }

  async function runUserAction(
    user: AdminUserRecord,
    action: "disable" | "enable" | "unlock" | "password" | "mfa"
  ) {
    setError(null);
    setManagedUserId(null);
    const labels = {
      disable: "disable this account",
      enable: "enable this account",
      unlock: "unlock this account",
      password: "issue a new temporary password",
      mfa: "reset MFA enrollment"
    };
    if (!window.confirm(`Confirm: ${labels[action]}?`)) {
      return;
    }
    try {
      if (action === "password") {
        const result =
          dataSource === "api"
            ? await createHmsClient().resetAdminUserPassword(user.id)
            : { userId: user.id, temporaryPassword: mockTemporaryPassword() };
        setCredential({
          title: "Password reset",
          label: "Temporary password",
          value: result.temporaryPassword
        });
        replaceUser({ ...user, mustChangePassword: true });
        return;
      }
      const client = createHmsClient();
      const updated =
        dataSource === "api"
          ? action === "disable"
            ? await client.disableAdminUser(user.id)
            : action === "enable"
              ? await client.enableAdminUser(user.id)
              : action === "unlock"
                ? await client.unlockAdminUser(user.id)
                : await client.resetAdminUserMfa(user.id)
          : localLifecycleUpdate(user, action);
      replaceUser(updated);
    } catch (actionError) {
      setError(errorMessage(actionError));
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
            <button className="primary-button" type="button" onClick={() => setUserDialog({ mode: "create" })}>
              <Plus aria-hidden="true" size={15} />
              Add User
            </button>
          </div>
          <UserTable
            actorRoles={actorRoles}
            managedUserId={managedUserId}
            onEdit={(user) => {
              setManagedUserId(null);
              setUserDialog({ mode: "edit", user });
            }}
            onManage={setManagedUserId}
            onUserAction={runUserAction}
            users={users}
          />
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
      <UserAdminDialog
        actorRoles={actorRoles}
        customers={customerOptions}
        initial={userDialog?.user ? {
          email: userDialog.user.email,
          firstName: userDialog.user.firstName ?? "",
          lastName: userDialog.user.lastName ?? "",
          role: userDialog.user.role as StaffRole,
          customerId: userDialog.user.customerId
        } : undefined}
        mode={userDialog?.mode ?? "create"}
        open={userDialog !== null}
        onClose={() => setUserDialog(null)}
        onSubmit={saveUser}
      />
      <OneTimeCredentialDialog
        credential={credential}
        onClose={() => setCredential(null)}
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
  actorRoles,
  managedUserId,
  onEdit,
  onManage,
  onUserAction,
  users,
}: {
  actorRoles: StaffRole[];
  managedUserId: string | null;
  onEdit: (user: AdminUserRecord) => void;
  onManage: (id: string | null) => void;
  onUserAction: (
    user: AdminUserRecord,
    action: "disable" | "enable" | "unlock" | "password" | "mfa"
  ) => void;
  users: AdminUserRecord[];
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
              <th>Status</th>
              <th>MFA</th>
              <th>Last login</th>
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
                <td><span className={`user-status status-${user.accountStatus.toLowerCase()}`}>{user.accountStatus}</span></td>
                <td>{user.mfaEnabled ? "Enabled" : "MFA setup required"}</td>
                <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never"}</td>
                <td>
                  {canManageRole(actorRoles, user.role as StaffRole) ? (
                    <div className="user-actions">
                      <button
                        aria-label={`Manage ${user.email}`}
                        className="icon-button light"
                        type="button"
                        onClick={() => onManage(managedUserId === user.id ? null : user.id)}
                      >
                        <MoreHorizontal aria-hidden="true" size={17} />
                      </button>
                      {managedUserId === user.id ? (
                        <div className="user-action-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => onEdit(user)}>
                            <Edit3 aria-hidden="true" size={15} /> Edit user
                          </button>
                          {user.accountStatus === "DISABLED" ? (
                            <button type="button" role="menuitem" onClick={() => onUserAction(user, "enable")}>
                              <UserCheck aria-hidden="true" size={15} /> Enable account
                            </button>
                          ) : (
                            <button type="button" role="menuitem" onClick={() => onUserAction(user, "disable")}>
                              <UserX aria-hidden="true" size={15} /> Disable account
                            </button>
                          )}
                          {user.accountStatus === "LOCKED" || user.lockedUntil ? (
                            <button type="button" role="menuitem" onClick={() => onUserAction(user, "unlock")}>
                              <LockKeyhole aria-hidden="true" size={15} /> Unlock account
                            </button>
                          ) : null}
                          <button type="button" role="menuitem" onClick={() => onUserAction(user, "password")}>
                            <RotateCcw aria-hidden="true" size={15} /> Reset password
                          </button>
                          <button type="button" role="menuitem" onClick={() => onUserAction(user, "mfa")}>
                            <ShieldOff aria-hidden="true" size={15} /> Reset MFA
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : <span className="muted-copy">Protected</span>}
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

function localUser(values: UserAdminValues): {
  user: AdminUserRecord;
  temporaryPassword: string;
} {
  const now = new Date().toISOString();
  return {
    user: {
      id: `local-user-${Date.now()}`,
      oidcSubject: `local:${Date.now()}`,
      email: values.email,
      firstName: values.firstName || null,
      lastName: values.lastName || null,
      displayName: displayNameFor(values),
      role: values.role,
      customerId: values.customerId,
      accountStatus: "ACTIVE",
      mustChangePassword: true,
      mfaEnabled: false,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now
    },
    temporaryPassword: mockTemporaryPassword()
  };
}

function displayNameFor(values: UserAdminValues): string {
  return [values.firstName, values.lastName].filter(Boolean).join(" ") || values.email;
}

function mockTemporaryPassword(): string {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  return `Demo-${Array.from(bytes, (value) => value.toString(36)).join("-")}`;
}

function localLifecycleUpdate(
  user: AdminUserRecord,
  action: "disable" | "enable" | "unlock" | "mfa"
): AdminUserRecord {
  if (action === "disable") {
    return { ...user, accountStatus: "DISABLED" };
  }
  if (action === "enable" || action === "unlock") {
    return { ...user, accountStatus: "ACTIVE", lockedUntil: null };
  }
  return { ...user, mfaEnabled: false };
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
