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
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { createHmsClient, type AdminUserSummary } from "../api/hmsClient";
import type {
  AdminUserRecord,
  DeviceRecord,
  StaffRole
} from "../domain/types";
import { formatDateTime } from "../utils/dateTime";
import { formatDateTime as formatInstant } from "../scheduling/zonedTime";
import { deviceLabel, personName, userLabel } from "../utils/identity";
import { hasActiveFilters, useUserDirectory, type UsersRouteControl } from "../hooks/useUserDirectory";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice, useActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { useActionRunner } from "./interaction/useActionRunner";
import { useConfirmedAction } from "./interaction/useConfirmedAction";
import { OneTimeCredentialDialog, type OneTimeCredential } from "./OneTimeCredentialDialog";
import { PaginationControls, usePagination } from "./Pagination";
import { UserDirectoryFilters } from "./UserDirectoryFilters";
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
  /** The Users & Roles query as the URL holds it, and how to change it. Without it the view keeps its own. */
  usersRoute?: UsersRouteControl;
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
  customerOptions,
  usersRoute
}: SystemWorkspaceProps) {
  const directory = useUserDirectory(module === "users", usersRoute);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userDialog, setUserDialog] = useState<{
    mode: "create" | "edit";
    user?: AdminUserRecord;
  } | null>(null);
  // Which opening of the dialog is current: a save that finishes after the dialog moved on must not close it.
  const dialogSession = useRef(0);
  const openUserDialog = (next: { mode: "create" | "edit"; user?: AdminUserRecord }) => { dialogSession.current += 1; setUserDialog(next); };
  const closeUserDialog = () => { dialogSession.current += 1; setUserDialog(null); };
  const [credential, setCredential] = useState<OneTimeCredential | null>(null);
  const [managedUserId, setManagedUserId] = useState<string | null>(null);
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const { pending: pendingAction, run } = useActionRunner(notify);

  useEffect(() => {
    let active = true;
    setError(null);
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

  const roleRows = useMemo(() => roleSummary(directory.summary), [directory.summary]);

  async function saveUser(values: UserAdminValues) {
    const session = dialogSession.current;
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
      // The new user may not match the current filters or page: ask the server for the page again.
      directory.reload();
      notify({ kind: "success", title: "User created", message: `${userLabel(result.user)} created successfully.` });
      setCredential({
        title: "Temporary password",
        label: "Password",
        value: result.temporaryPassword,
        note: "Give this password to the user securely. They must change it at first sign-in."
      });
    }
    if (session === dialogSession.current) closeUserDialog();
  }

  function replaceUser(updated: AdminUserRecord) {
    directory.replaceUser(updated);
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
        context={<><UsersRound aria-hidden="true" size={20} /><span><strong>{directory.summary ? directory.summary.total : "-"} user accounts</strong><small>Role-based workspace access</small></span></>}
      />
      <ManagementMetricStrip>
        <ManagementMetric icon={UsersRound} label="Active Users" value={directory.summary ? directory.summary.active : "-"} detail="Enabled staff and customer users" />
        <ManagementMetric icon={ShieldCheck} label="Admin Seats" value={directory.summary ? (directory.summary.byRole.HMS_ADMIN ?? 0) + (directory.summary.byRole.SUPER_ADMIN ?? 0) : "-"} detail="Full HMS access" tone="green" />
        <ManagementMetric icon={KeyRound} label="Reviewer Seats" value={directory.summary ? directory.summary.byRole.REVIEWER ?? 0 : "-"} detail="Can approve inspections" tone="amber" />
        <ManagementMetric icon={LockKeyhole} label="Restricted Users" value={directory.summary ? directory.summary.byRole.CUSTOMER_USER ?? 0 : "-"} detail="Scoped customer access" tone="red" />
      </ManagementMetricStrip>

      <div className="system-layout">
        <section className="data-panel">
          <div className="panel-heading">
            <div>
              <h2>User Directory</h2>
              <p>Persisted access records resolved by the HMS auth boundary.</p>
            </div>
            <ActionButton onClick={() => openUserDialog({ mode: "create" })} variant="primary">
              <Plus aria-hidden="true" size={15} />
              Add User
            </ActionButton>
          </div>
          <UserDirectoryFilters
            customers={customerOptions}
            filters={directory.filters}
            onChange={directory.changeFilters}
            onClear={directory.clearFilters}
          />
          <UserTable
            actorRoles={actorRoles}
            customerOptions={customerOptions}
            directory={directory}
            managedUserId={managedUserId}
            onEdit={(user) => {
              setManagedUserId(null);
              openUserDialog({ mode: "edit", user });
            }}
            onManage={setManagedUserId}
            onUserAction={runUserAction}
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
                <em>{row.count === null ? "-" : `${row.count} users`}</em>
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
        recordKey={userDialog?.user?.id}
        onClose={closeUserDialog}
        onSubmit={saveUser}
      />
      <OneTimeCredentialDialog
        credential={credential}
        onClose={() => setCredential(null)}
      />
    </section>
  );
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Five rows of actions plus padding; used only to decide whether the menu fits below its button.
const USER_MENU_HEIGHT = 210;

function UserTable({
  actorRoles,
  customerOptions,
  directory,
  managedUserId,
  onEdit,
  onManage,
  onUserAction,
}: {
  actorRoles: StaffRole[];
  customerOptions: CustomerOption[];
  directory: ReturnType<typeof useUserDirectory>;
  managedUserId: string | null;
  onEdit: (user: AdminUserRecord) => void;
  onManage: (id: string | null) => void;
  onUserAction: (
    user: AdminUserRecord,
    action: "disable" | "enable" | "unlock" | "password" | "mfa"
  ) => void;
}) {
  const { users, total, page, pageSize, status } = directory;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const customerNames = useMemo(() => new Map(customerOptions.map((option) => [option.id, option.name])), [customerOptions]);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
  const anchor = useRef<{ button: HTMLElement; top: number; right: number } | null>(null);

  // The menu is fixed to the viewport so the table frame's scroll area cannot clip it, and opens upward
  // when there is no room below. It closes only when its button has actually moved: a scroll that
  // brings the button into view happens as the menu opens and must not dismiss it.
  useEffect(() => {
    if (!managedUserId) return;
    const closeIfAnchorMoved = () => {
      const open = anchor.current;
      if (!open) return;
      const rect = open.button.getBoundingClientRect();
      if (!open.button.isConnected || Math.abs(rect.top - open.top) > 1 || Math.abs(rect.right - open.right) > 1) {
        onManage(null);
      }
    };
    window.addEventListener("scroll", closeIfAnchorMoved, true);
    window.addEventListener("resize", closeIfAnchorMoved);
    return () => {
      window.removeEventListener("scroll", closeIfAnchorMoved, true);
      window.removeEventListener("resize", closeIfAnchorMoved);
    };
  }, [managedUserId, onManage]);

  function placeMenu(button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    anchor.current = { button, top: rect.top, right: rect.right };
    const right = window.innerWidth - rect.right;
    setMenuPosition(
      rect.bottom + 6 + USER_MENU_HEIGHT > window.innerHeight
        ? { position: "fixed", right, bottom: window.innerHeight - rect.top + 6, top: "auto" }
        : { position: "fixed", right, top: rect.bottom + 6 }
    );
  }

  const filtered = hasActiveFilters(directory.filters);
  const loadingFirst = status === "loading" && users.length === 0;
  const showTable = users.length > 0;

  return (
    <section className="operations-table-panel">
      <p aria-live="polite" className="user-result-count" role="status">
        {status === "ready" && filtered ? `${total} ${total === 1 ? "user matches" : "users match"} these filters.` : ""}
      </p>
      {status === "error" ? (
        <WorkspaceState
          action={<ActionButton onClick={directory.reload} variant="secondary">Try again</ActionButton>}
          title="Users could not be loaded"
          tone="error"
        >
          {directory.error ?? "The user list could not be loaded."}
        </WorkspaceState>
      ) : null}
      {loadingFirst ? (
        <div aria-label="Loading users" className="user-skeleton" role="status">
          {[0, 1, 2, 3, 4].map((row) => <i key={row} />)}
        </div>
      ) : null}
      {status === "ready" && total === 0 ? (
        <WorkspaceState
          action={filtered ? <ActionButton onClick={directory.clearFilters} variant="secondary">Clear filters</ActionButton> : undefined}
          title={filtered ? "No users match these filters" : "No users yet"}
        >
          {filtered ? "Try a different name or email, or clear the filters." : "Add the first user to give someone access."}
        </WorkspaceState>
      ) : null}
      <div aria-busy={status === "loading"} className="table-frame" hidden={!showTable}>
        <table className="console-table" aria-label="User access records">
          <thead>
            <tr>
              <th>User</th>
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
                <td className="user-identity">
                  {personName(user) ? <strong>{personName(user)}</strong> : <strong className="user-name-missing">Name not set</strong>}
                  <small>{user.email}</small>
                </td>
                <td className="user-role-cell">
                  <span>{user.role}</span>
                  <small>{formatRole(user.role)}</small>
                </td>
                <td>{scopeLabel(user, customerNames)}</td>
                <td><span className={`user-status status-${user.accountStatus.toLowerCase()}`}>{user.accountStatus}</span></td>
                <td>{user.mfaEnabled ? "Enabled" : "MFA setup required"}</td>
                <td>
                  {user.lastLoginAt ? (
                    <time dateTime={user.lastLoginAt}>{formatInstant(user.lastLoginAt, browserTimeZone())}</time>
                  ) : (
                    "Never"
                  )}
                </td>
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
      {showTable || total > 0 ? (
        <PaginationControls
          label="User access records"
          onPageChange={directory.setPage}
          onPageSizeChange={directory.setPageSize}
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          start={(page - 1) * pageSize}
          total={total}
        />
      ) : null}
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

function scopeLabel(user: AdminUserRecord, customerNames: Map<string, string>): string {
  const ids = user.customerIds ?? (user.customerId ? [user.customerId] : []);
  if (ids.length === 0) return user.role === "CUSTOMER_USER" ? "No customer assigned" : "All customers";
  const names = ids.map((id) => customerNames.get(id));
  // Names when every one is known; otherwise a count, never a raw id or a guess.
  if (names.every((name): name is string => Boolean(name))) return names.join(", ");
  return `${ids.length} ${ids.length === 1 ? "customer" : "customers"}`;
}

function roleSummary(summary: AdminUserSummary | null) {
  return roles.map((role) => ({
    role,
    count: summary ? summary.byRole[role] ?? 0 : null,
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
