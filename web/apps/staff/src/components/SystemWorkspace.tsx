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
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AdminUserRecord,
  DeviceRecord,
  StaffRole
} from "../domain/types";
import { formatDateTime } from "../utils/dateTime";
import { deviceLabel, userLabel } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice, useActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { useActionRunner } from "./interaction/useActionRunner";
import { useConfirmedAction } from "./interaction/useConfirmedAction";
import { OneTimeCredentialDialog, type OneTimeCredential } from "./OneTimeCredentialDialog";
import { PaginationControls, usePagination } from "./Pagination";
import {
  UserAdminDialog,
  type CustomerOption,
  type UserAdminValues
} from "./UserAdminDialog";
import { WorkspaceState } from "./WorkspaceState";
import { ManagementHeader, ManagementMetric, ManagementMetricStrip } from "./ManagementPrimitives";
import { canManageRole } from "./roleAdmin";

export type SystemModule = "users" | "devices";

interface SystemWorkspaceProps {
  module: SystemModule;
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
  actorRoles,
  customerOptions
}: SystemWorkspaceProps) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userDialog, setUserDialog] = useState<{
    mode: "create" | "edit";
    user?: AdminUserRecord;
  } | null>(null);
  const [credential, setCredential] = useState<OneTimeCredential | null>(null);
  const [managedUserId, setManagedUserId] = useState<string | null>(null);
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const { pending: pendingAction, run } = useActionRunner(notify);

  useEffect(() => {
    let active = true;
    setError(null);
    if (module === "users") {
      createHmsClient().listAdminUsers({ sort: "email" })
        .then((result) => {
          if (!active) {
            return;
          }
          setUsers(result.items);
        })
        .catch((loadError: unknown) => {
          if (active) {
            setError(errorMessage(loadError));
          }
        });
    }
    if (module === "devices") {
      createHmsClient().listDevices({ sort: "device_id" })
        .then((result) => {
          if (!active) {
            return;
          }
          setDevices(result.items);
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
  }, [module]);

  const roleRows = useMemo(() => roleSummary(users), [users]);

  async function saveUser(values: UserAdminValues) {
    // Errors are thrown to the dialog, which stays open with what was typed; success is announced here.
    const body = {
      email: values.email,
      firstName: values.firstName || null,
      lastName: values.lastName || null,
      role: values.role,
      customerId: values.customerId,
      customerIds: values.customerIds
    };
    if (userDialog?.mode === "edit" && userDialog.user) {
      const updated = await createHmsClient().updateAdminUser(userDialog.user.id, body);
      replaceUser(updated);
      notify({ kind: "success", title: "User updated", message: `${userLabel(updated)} updated successfully.` });
    } else {
      const result = await createHmsClient().createAdminUser(body);
      setUsers((current) => [result.user, ...current]);
      notify({ kind: "success", title: "User created", message: `${userLabel(result.user)} created successfully.` });
      setCredential({
        title: "Temporary password",
        label: "Password",
        value: result.temporaryPassword,
        note: "Give this password to the user securely. They must change it at first sign-in."
      });
    }
    setUserDialog(null);
  }

  function replaceUser(updated: AdminUserRecord) {
    setUsers((current) =>
      current.map((item) => (item.id === updated.id ? updated : item))
    );
  }

  type UserAction = "disable" | "enable" | "unlock" | "password" | "mfa";
  const actionCopy: Record<UserAction, { title: string; message: string; confirm: string; pending: string; done: string }> = {
    disable: { title: "Disable", message: "They will be signed out and unable to sign in until the account is enabled again.", confirm: "Disable account", pending: "Disabling…", done: "was disabled" },
    enable: { title: "Enable", message: "They will be able to sign in again.", confirm: "Enable account", pending: "Enabling…", done: "was enabled" },
    unlock: { title: "Unlock", message: "Failed sign-in attempts are cleared and they can try again.", confirm: "Unlock account", pending: "Unlocking…", done: "was unlocked" },
    password: { title: "Reset the password for", message: "A new temporary password is issued and shown once. The current password stops working.", confirm: "Reset password", pending: "Resetting…", done: "had their password reset" },
    mfa: { title: "Reset MFA for", message: "They must enrol a new authenticator at their next sign-in. Their recovery codes stop working.", confirm: "Reset MFA", pending: "Resetting…", done: "had MFA reset" }
  };
  const userAction = useConfirmedAction<{ user: AdminUserRecord; action: UserAction }>(
    async ({ user, action }) => {
      const client = createHmsClient();
      if (action === "password") {
        const result = await client.resetAdminUserPassword(user.id);
        replaceUser({ ...user, mustChangePassword: true });
        setCredential({ title: "Password reset", label: "Temporary password", value: result.temporaryPassword });
      } else {
        const updated =
          action === "disable" ? await client.disableAdminUser(user.id)
          : action === "enable" ? await client.enableAdminUser(user.id)
          : action === "unlock" ? await client.unlockAdminUser(user.id)
          : await client.resetAdminUserMfa(user.id);
        replaceUser(updated);
      }
      notify({ kind: "success", title: "Account updated", message: `${userLabel(user)} ${actionCopy[action].done}.` });
    },
    ({ user, action }) => ({ fallback: `${userLabel(user)} could not be updated (${actionCopy[action].confirm.toLowerCase()}). Nothing was changed.` })
  );
  function runUserAction(user: AdminUserRecord, action: UserAction) {
    setManagedUserId(null);
    userAction.request({ user, action });
  }

  const deviceRevoke = useConfirmedAction<DeviceRecord>(
    async (device) => {
      const updated = await createHmsClient().updateDevice(device.deviceId, { revoked: true });
      setDevices((current) => current.map((item) => (item.deviceId === device.deviceId ? updated : item)));
      notify({ kind: "success", title: "Device revoked", message: `${deviceLabel(device)} was revoked and is blocked from syncing.` });
    },
    (device) => ({ fallback: `${deviceLabel(device)} could not be revoked. It is still allowed to sync.` })
  );
  function toggleDevice(device: DeviceRecord) {
    if (!device.revoked) {
      deviceRevoke.request(device);
      return;
    }
    // Restoring is reversible and not destructive: no dialog, but a clear outcome either way.
    void run(`restore:${device.deviceId}`, async () => {
      const updated = await createHmsClient().updateDevice(device.deviceId, { revoked: false });
      setDevices((current) => current.map((item) => (item.deviceId === device.deviceId ? updated : item)));
    }, {
      fallback: `${deviceLabel(device)} could not be restored. It is still revoked.`,
      failureTitle: "Device not restored",
      success: () => ({ title: "Device restored", message: `${deviceLabel(device)} was restored and can sync again.` })
    });
  }

  if (module === "devices") {
    return (
      <section className="system-workspace" aria-label="Device workspace">
        {error ? <WorkspaceState title="Device admin unavailable" tone="error">{error}</WorkspaceState> : null}
        {notice ? <ActionNotice kind={notice.kind} onDismiss={dismissNotice} title={notice.title}>{notice.message}</ActionNotice> : null}
        <ConfirmDialog
          confirmLabel="Revoke device"
          error={deviceRevoke.error}
          message="It is blocked from syncing until it is restored. Data already synced is kept."
          onCancel={deviceRevoke.cancel}
          onConfirm={() => void deviceRevoke.confirm()}
          open={deviceRevoke.target !== null}
          pending={deviceRevoke.pending}
          pendingLabel="Revoking…"
          title={deviceRevoke.target ? `Revoke ${deviceLabel(deviceRevoke.target)}?` : "Revoke device?"}
        />
        <ManagementHeader
          eyebrow="Device management"
          title="Device management"
          description="Manage registered mobile and field devices in this workspace."
          context={<><Smartphone aria-hidden="true" size={20} /><span><strong>{devices.length} registered devices</strong><small>Field access and sync state</small></span></>}
        />
        <ManagementMetricStrip>
          <ManagementMetric icon={Smartphone} label="Registered Devices" value={devices.length} detail={`${devices.filter((device) => !device.revoked).length} active devices`} />
          <ManagementMetric icon={Wifi} label="Sync Health" value={`${syncHealth(devices)}%`} detail="Devices with recent sync state" tone="green" />
          <ManagementMetric icon={ServerCog} label="Offline Window" value={`${maxOfflineWindow(devices)}d`} detail="Largest allowed offline window" tone="amber" />
          <ManagementMetric icon={Clock3} label="Revoked" value={devices.filter((device) => device.revoked).length} detail="Blocked from future sync" tone="red" />
        </ManagementMetricStrip>

        <div className="system-layout">
          <section className="data-panel">
            <div className="panel-heading">
              <div>
                <h2>Registered Devices</h2>
                <p>Field devices currently known to the HMS workspace.</p>
              </div>
            </div>
            <DeviceTable devices={devices} onToggleRevoke={toggleDevice} pendingKey={pendingAction} />
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
      {error ? <WorkspaceState title="User admin unavailable" tone="error">{error}</WorkspaceState> : null}
      {notice ? <ActionNotice kind={notice.kind} onDismiss={dismissNotice} title={notice.title}>{notice.message}</ActionNotice> : null}
      <ConfirmDialog
        confirmLabel={userAction.target ? actionCopy[userAction.target.action].confirm : "Confirm"}
        error={userAction.error}
        message={userAction.target ? actionCopy[userAction.target.action].message : ""}
        onCancel={userAction.cancel}
        onConfirm={() => void userAction.confirm()}
        open={userAction.target !== null}
        pending={userAction.pending}
        pendingLabel={userAction.target ? actionCopy[userAction.target.action].pending : "Working…"}
        title={userAction.target ? `${actionCopy[userAction.target.action].title} ${userLabel(userAction.target.user)}?` : "Change account?"}
      />
      <ManagementHeader
        eyebrow="Access management"
        title="Access control"
        description="Manage workspace access, roles, reviewers, and customer-scoped users."
        context={<><UsersRound aria-hidden="true" size={20} /><span><strong>{users.length} user accounts</strong><small>Role-based workspace access</small></span></>}
      />
      <ManagementMetricStrip>
        <ManagementMetric icon={UsersRound} label="Active Users" value={users.filter((user) => user.accountStatus === "ACTIVE").length} detail="Enabled staff and customer users" />
        <ManagementMetric icon={ShieldCheck} label="Admin Seats" value={users.filter((user) => user.role === "HMS_ADMIN" || user.role === "SUPER_ADMIN").length} detail="Full HMS access" tone="green" />
        <ManagementMetric icon={KeyRound} label="Reviewer Seats" value={users.filter((user) => user.role === "REVIEWER").length} detail="Can approve inspections" tone="amber" />
        <ManagementMetric icon={LockKeyhole} label="Restricted Users" value={users.filter((user) => user.role === "CUSTOMER_USER").length} detail="Scoped customer access" tone="red" />
      </ManagementMetricStrip>

      <div className="system-layout">
        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>User Directory</h2>
              <p>Persisted access records resolved by the HMS auth boundary.</p>
            </div>
            <ActionButton onClick={() => setUserDialog({ mode: "create" })} variant="primary">
              <Plus aria-hidden="true" size={15} />
              Add User
            </ActionButton>
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
          customerId: userDialog.user.customerId,
          customerIds: userDialog.user.customerIds
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

// Five rows of actions plus padding; used only to decide whether the menu fits below its button.
const USER_MENU_HEIGHT = 210;

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
  const pagination = usePagination(users);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({});

  // The menu is fixed to the viewport so the table frame's scroll area cannot clip it, and opens upward
  // when there is no room below. Anything that moves the button under it closes it instead.
  useEffect(() => {
    if (!managedUserId) return;
    const close = () => onManage(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [managedUserId, onManage]);

  function placeMenu(button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    setMenuPosition(
      rect.bottom + 6 + USER_MENU_HEIGHT > window.innerHeight
        ? { position: "fixed", right, bottom: window.innerHeight - rect.top + 6, top: "auto" }
        : { position: "fixed", right, top: rect.bottom + 6 }
    );
  }

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
            {pagination.items.map((user) => (
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
                <td className="user-actions-cell">
                  {canManageRole(actorRoles, user.role as StaffRole) ? (
                    <div className="user-actions">
                      <button
                        aria-label={`Manage ${user.email}`}
                        className="icon-button light"
                        type="button"
                        onClick={(event) => {
                          placeMenu(event.currentTarget);
                          onManage(managedUserId === user.id ? null : user.id);
                        }}
                      >
                        <MoreHorizontal aria-hidden="true" size={17} />
                      </button>
                      {managedUserId === user.id ? (
                        <div className="user-action-menu" role="menu" style={menuPosition}>
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
      <PaginationControls
        label="User access records"
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        page={pagination.page}
        pageCount={pagination.pageCount}
        pageSize={pagination.pageSize}
        start={pagination.start}
        total={pagination.total}
      />
    </section>
  );
}

function DeviceTable({
  devices,
  onToggleRevoke,
  pendingKey
}: {
  devices: DeviceRecord[];
  onToggleRevoke: (device: DeviceRecord) => void;
  pendingKey: string | null;
}) {
  const pagination = usePagination(devices);

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
            {pagination.items.map((device) => (
              <tr key={device.deviceId}>
                <td><strong>{deviceLabel(device)}</strong></td>
                <td>{device.platform}</td>
                <td>{device.state}</td>
                <td>{device.lastSyncAt ? formatDateTime(device.lastSyncAt) : "Not synced"}</td>
                <td>{device.appVersion}</td>
                <td>{device.offlineWindowDays} days</td>
                <td>
                  <ActionButton
                    aria-label={pendingKey === `restore:${device.deviceId}` ? `Restoring ${deviceLabel(device)}` : `${device.revoked ? "Restore" : "Revoke"} ${deviceLabel(device)}`}
                    disabled={pendingKey !== null && pendingKey !== `restore:${device.deviceId}`}
                    onClick={() => onToggleRevoke(device)}
                    pending={pendingKey === `restore:${device.deviceId}`}
                    pendingLabel="Restoring…"
                    variant={device.revoked ? "secondary" : "ghost"}
                  >
                    {device.revoked ? "Restore" : "Revoke"}
                  </ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationControls
        label="Device records"
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        page={pagination.page}
        pageCount={pagination.pageCount}
        pageSize={pagination.pageSize}
        start={pagination.start}
        total={pagination.total}
      />
    </section>
  );
}

function roleSummary(users: AdminUserRecord[]) {
  return roles.map((role) => ({
    role,
    count: users.filter((user) => user.role === role).length,
    scope: role === "CUSTOMER_USER" ? "Customer scoped" : "Staff workspace",
    permissions:
      role === "SUPER_ADMIN"
        ? "Full system administration and security controls"
        : role === "HMS_ADMIN"
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

function formatRole(role: string): string {
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .map((part) => (part === "Hms" ? "HMS" : part))
    .join(" ");
}

function errorMessage(error: unknown): string {
  return friendlyApiError(error, { fallback: "Admin workspace data could not be loaded." }).message;
}
