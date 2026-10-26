import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { SystemWorkspace } from "../components/SystemWorkspace";
import type { AdminUserRecord, DeviceRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  listDevices: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  disableAdminUser: vi.fn(),
  enableAdminUser: vi.fn(),
  unlockAdminUser: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  resetAdminUserMfa: vi.fn(),
  updateDevice: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const api = (status: number, message: string, details: unknown = null) => new HmsApiError(status, "code", message, details);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const jane = {
  id: "u1", oidcSubject: "jane", email: "jane@example.com", firstName: "Jane", lastName: "Smith", displayName: "Jane Smith",
  role: "INSPECTOR", customerId: null, customerIds: [], accountStatus: "ACTIVE", mustChangePassword: false, mfaEnabled: true,
  lockedUntil: null, lastLoginAt: null, createdAt: "2027-01-01T00:00:00Z", updatedAt: "2027-01-01T00:00:00Z"
} as AdminUserRecord;
const tablet = {
  deviceId: "dev-0123", displayName: "Field tablet 01", userId: "u1", platform: "ios", appVersion: "1.0", lastSyncAt: null,
  offlineWindowDays: 3, revoked: false, state: "ACTIVE"
} as DeviceRecord;

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, items: [jane] });
  client.listDevices.mockResolvedValue({ total: 1, etag: null, items: [tablet] });
});

function renderUsers() {
  const user = userEvent.setup();
  render(<SystemWorkspace actorRoles={["HMS_ADMIN"]} customerOptions={[{ id: "c1", name: "Vopak" }]} module="users" />);
  return user;
}
async function manage(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(await screen.findByRole("button", { name: "Manage jane@example.com" }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}
const dialog = () => screen.findByRole("alertdialog");

describe("User dialog", () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Add User" }));
    await screen.findByRole("dialog", { name: "Add user" });
  }

  it("marks email and role required, validates inline with focus, and sends nothing while invalid", async () => {
    const user = renderUsers();
    await openAdd(user);
    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Role")).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("First name")).not.toBeRequired();
    expect(screen.getByText("Required fields", { exact: false })).toHaveTextContent("* Required fields");

    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter the user's email address.");
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter a valid email address.");
    expect(client.createAdminUser).not.toHaveBeenCalled();
  });

  it("keeps the dialog and every value when the server refuses, and explains a duplicate email on the field", async () => {
    client.createAdminUser.mockRejectedValueOnce(api(409, "A user with this email already exists."));
    const user = renderUsers();
    await openAdd(user);
    await user.type(screen.getByLabelText("Email"), "jane@example.com");
    await user.type(screen.getByLabelText("First name"), "Jane");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("User not created");
    expect(alert).toHaveTextContent("A user with this email already exists.");
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("A user with this email already exists.");
    expect(screen.getByLabelText("First name")).toHaveValue("Jane");
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
  });

  it("turns a permission failure into plain words and never shows the internal permission name", async () => {
    client.createAdminUser.mockRejectedValueOnce(api(403, "Missing permission: user:admin"));
    const user = renderUsers();
    await openAdd(user);
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Create user" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission to do this.");
    expect(alert.textContent).not.toMatch(/user:admin/);
  });

  it("says Creating…, blocks a second press, and announces success only after the server answers", async () => {
    const create = deferred<{ user: AdminUserRecord; temporaryPassword: string }>();
    client.createAdminUser.mockReturnValue(create.promise);
    const user = renderUsers();
    await openAdd(user);
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Create user" }));
    const busy = await screen.findByRole("button", { name: "Creating…" });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(client.createAdminUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/created successfully/)).toBeNull();

    await act(async () => create.resolve({ user: { ...jane, id: "u2", email: "new@example.com", displayName: "new@example.com" }, temporaryPassword: "Temp-Pass-1" }));
    expect(await screen.findByText("new@example.com created successfully.")).toBeInTheDocument();
    expect(await screen.findByTestId("credential-value")).toHaveTextContent("Temp-Pass-1");
  });
});

describe("Account actions", () => {
  it.each([
    ["Disable account", "Disable Jane Smith (jane@example.com)?", client.disableAdminUser],
    ["Reset MFA", "Reset MFA for Jane Smith (jane@example.com)?", client.resetAdminUserMfa],
    ["Reset password", "Reset the password for Jane Smith (jane@example.com)?", client.resetAdminUserPassword]
  ])("%s asks first by name, and a failure leaves the account as it was", async (item, title, call) => {
    call.mockRejectedValueOnce(api(500, "psycopg.errors.OperationalError: connection refused"));
    const user = renderUsers();
    await manage(user, item);
    const confirm = await screen.findByRole("alertdialog", { name: title });
    expect(call).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: item }));

    const failure = await within(await dialog()).findByRole("alert");
    expect(failure).toHaveTextContent(/service is unavailable/i);
    expect(failure.textContent).not.toMatch(/psycopg|OperationalError/);
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.queryByTestId("credential-value")).toBeNull();
    expect(screen.queryByText(/was disabled|had MFA reset|password reset/)).toBeNull();
  });

  it("disables only after confirmation, shows Disabling…, and reports success after the answer", async () => {
    const done = deferred<AdminUserRecord>();
    client.disableAdminUser.mockReturnValue(done.promise);
    const user = renderUsers();
    await manage(user, "Disable account");
    await user.click(within(await dialog()).getByRole("button", { name: "Disable account" }));
    const busy = await screen.findByRole("button", { name: "Disabling…" });
    expect(busy).toBeDisabled();
    expect(screen.queryByText(/was disabled/)).toBeNull();
    await act(async () => done.resolve({ ...jane, accountStatus: "DISABLED" }));
    expect(await screen.findByText("Jane Smith (jane@example.com) was disabled.")).toBeInTheDocument();
    expect(screen.getByText("DISABLED")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows a populated last sign-in as a readable time, and Never when there is none", async () => {
    client.listAdminUsers.mockResolvedValue({
      total: 2, etag: null,
      items: [{ ...jane, lastLoginAt: "2026-10-26T00:26:48.986993Z" }, { ...jane, id: "u2", email: "new@example.com", lastLoginAt: null }]
    });
    renderUsers();
    const time = (await screen.findByText(/26 Oct 2026/)).closest("time");
    expect(time).toHaveAttribute("datetime", "2026-10-26T00:26:48.986993Z");
    expect(time?.textContent).not.toMatch(/986993|T00:/);
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("shows the temporary password only after a successful reset", async () => {
    client.resetAdminUserPassword.mockResolvedValue({ userId: "u1", temporaryPassword: "Reset-Temp-1" });
    const user = renderUsers();
    await manage(user, "Reset password");
    await user.click(within(await dialog()).getByRole("button", { name: "Reset password" }));
    expect(await screen.findByTestId("credential-value")).toHaveTextContent("Reset-Temp-1");
    expect(screen.getByText(/had their password reset/)).toBeInTheDocument();
  });

  it("a business conflict is shown as the server states it, not as a stale edit", async () => {
    client.unlockAdminUser.mockRejectedValueOnce(api(409, "This account is not locked."));
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, items: [{ ...jane, accountStatus: "LOCKED", lockedUntil: "2099-01-01T00:00:00Z" }] });
    const user = renderUsers();
    await manage(user, "Unlock account");
    await user.click(within(await dialog()).getByRole("button", { name: "Unlock account" }));
    const failure = await within(await dialog()).findByRole("alert");
    expect(failure).toHaveTextContent("This account is not locked.");
    expect(failure).not.toHaveTextContent(/someone else|refresh/i);
  });

  it("can be cancelled from the keyboard without calling the server", async () => {
    const user = renderUsers();
    await manage(user, "Disable account");
    await dialog();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(client.disableAdminUser).not.toHaveBeenCalled();
  });
});

describe("Devices", () => {
  const renderDevices = () => {
    const user = userEvent.setup();
    render(<SystemWorkspace actorRoles={["HMS_ADMIN"]} customerOptions={[]} module="devices" />);
    return user;
  };

  it("revokes only after confirmation, names the device by name and id, and keeps it allowed when revoking fails", async () => {
    client.updateDevice.mockRejectedValueOnce(api(500, "Internal server error"));
    const user = renderDevices();
    await user.click(await screen.findByRole("button", { name: "Revoke Field tablet 01 — dev-0123" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke Field tablet 01 — dev-0123?" });
    expect(client.updateDevice).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Revoke device" }));
    expect(await within(await dialog()).findByRole("alert")).toHaveTextContent(/service is unavailable/i);
    expect(screen.getByRole("button", { name: "Revoke Field tablet 01 — dev-0123" })).toBeInTheDocument(); // still not revoked

    client.updateDevice.mockResolvedValueOnce({ ...tablet, revoked: true, state: "REVOKED" });
    await user.click(within(await dialog()).getByRole("button", { name: "Revoke device" }));
    expect(await screen.findByText("Field tablet 01 — dev-0123 was revoked and is blocked from syncing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Field tablet 01 — dev-0123" })).toBeInTheDocument();
  });

  it("restores without a dialog but never silently: Restoring…, a failure message, and success after the answer", async () => {
    client.listDevices.mockResolvedValue({ total: 1, etag: null, items: [{ ...tablet, revoked: true, state: "REVOKED" }] });
    client.updateDevice.mockRejectedValueOnce(api(403, "Missing permission: device:admin"));
    const restore = deferred<DeviceRecord>();
    client.updateDevice.mockReturnValueOnce(restore.promise);
    const user = renderDevices();
    await user.click(await screen.findByRole("button", { name: "Restore Field tablet 01 — dev-0123" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission to do this.");
    expect(screen.getByRole("button", { name: "Restore Field tablet 01 — dev-0123" })).toBeInTheDocument(); // still revoked

    await user.click(screen.getByRole("button", { name: "Restore Field tablet 01 — dev-0123" }));
    expect(await screen.findByRole("button", { name: "Restoring Field tablet 01 — dev-0123" })).toBeDisabled();
    await act(async () => restore.resolve({ ...tablet, revoked: false }));
    expect(await screen.findByText("Field tablet 01 — dev-0123 was restored and can sync again.")).toBeInTheDocument();
  });
});
