import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OneTimeCredentialDialog } from "../components/OneTimeCredentialDialog";
import { UserAdminDialog } from "../components/UserAdminDialog";
import { SystemWorkspace } from "../components/SystemWorkspace";
import { manageableRoles } from "../components/roleAdmin";

const customers = [
  { id: "c1", name: "Vopak" },
  { id: "c2", name: "Orica" }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function roleOptionLabels(): string[] {
  const select = screen.getByLabelText("Role");
  return within(select).getAllByRole("option").map((o) => o.textContent ?? "");
}

describe("role management matrix", () => {
  it("Super Admin can manage every role including Super Admin", () => {
    expect(manageableRoles(["SUPER_ADMIN"])).toContain("SUPER_ADMIN");
    expect(manageableRoles(["SUPER_ADMIN"])).toHaveLength(6);
  });

  it("HMS Admin manages all roles except Super Admin", () => {
    const managed = manageableRoles(["HMS_ADMIN"]);
    expect(managed).not.toContain("SUPER_ADMIN");
    expect(managed).toEqual(
      expect.arrayContaining([
        "HMS_ADMIN",
        "INSPECTOR",
        "ASSEMBLY",
        "REVIEWER",
        "CUSTOMER_USER"
      ])
    );
  });

  it("non-admin roles manage nobody", () => {
    expect(manageableRoles(["REVIEWER"])).toHaveLength(0);
  });
});

describe("UserAdminDialog", () => {
  it("focuses the first field and closes with Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <UserAdminDialog
        open
        mode="create"
        actorRoles={["HMS_ADMIN"]}
        customers={customers}
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers Super Admin as a role option to a Super Admin actor", () => {
    render(
      <UserAdminDialog
        open
        mode="create"
        actorRoles={["SUPER_ADMIN"]}
        customers={customers}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(roleOptionLabels()).toContain("Super Admin");
  });

  it("never offers Super Admin to an HMS Admin actor", () => {
    render(
      <UserAdminDialog
        open
        mode="create"
        actorRoles={["HMS_ADMIN"]}
        customers={customers}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(roleOptionLabels()).not.toContain("Super Admin");
  });

  it("requires customer access for Customer User and supports multiple assignments", async () => {
    const onSubmit = vi.fn();
    render(
      <UserAdminDialog
        open
        mode="create"
        actorRoles={["HMS_ADMIN"]}
        customers={customers}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "new.user@example.com" }
    });
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "User" } });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "CUSTOMER_USER" }
    });
    // Customer access is required; an operator can assign more than one organisation.
    const submit = screen.getByRole("button", { name: /create user/i });
    const user = userEvent.setup();
    await user.click(submit);
    // Missing access is explained next to the field instead of leaving a dead button.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Customers")).toBeRequired();
    expect(screen.getByLabelText("Customers")).toHaveFocus();
    expect(screen.getByLabelText("Customers")).toHaveAccessibleDescription("Select at least one customer for this user.");
    await user.selectOptions(screen.getByLabelText("Customers"), ["c1", "c2"]);
    expect(screen.getByLabelText("Customers")).not.toHaveAttribute("aria-invalid");
    await user.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "CUSTOMER_USER",
        customerId: "c1",
        customerIds: ["c1", "c2"]
      })
    );
  });

  it("does not show a customer selector for non-customer roles", () => {
    render(
      <UserAdminDialog
        open
        mode="create"
        actorRoles={["HMS_ADMIN"]}
        customers={customers}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "INSPECTOR" }
    });
    expect(screen.queryByLabelText("Customer")).toBeNull();
  });
});

describe("OneTimeCredentialDialog", () => {
  it("focuses its return action and closes with Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <OneTimeCredentialDialog
        credential={{
          title: "Temporary password",
          label: "Password",
          value: "Abc-123-Def-456"
        }}
        onClose={onClose}
      />
    );

    expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the secret once and closes without leaving it reopenable", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <OneTimeCredentialDialog
        credential={{
          title: "Temporary password",
          label: "Password",
          value: "Abc-123-Def-456"
        }}
        onClose={onClose}
      />
    );
    expect(screen.getByTestId("credential-value").textContent).toBe(
      "Abc-123-Def-456"
    );
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
    // Parent drops the credential -> nothing is rendered (cannot reopen).
    rerender(<OneTimeCredentialDialog credential={null} onClose={onClose} />);
    expect(screen.queryByTestId("credential-value")).toBeNull();
  });
});

const apiUser = {
  id: "user-api-1",
  oidc_subject: "local:user-api-1",
  email: "staff@example.com",
  first_name: "Sam",
  last_name: "Staff",
  role: "HMS_ADMIN",
  customer_id: null,
  account_status: "ACTIVE",
  must_change_password: false,
  mfa_enabled: true,
  locked_until: null,
  last_login_at: "2026-07-12T01:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-12T01:00:00Z"
};

const summaryBody = { total: 2, by_role: { INSPECTOR: 2 }, active: 1, locked: 1, disabled: 0, mfa_enabled: 0, mfa_setup_required: 2 };

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body
  };
}

describe("SystemWorkspace user lifecycle", () => {
  it("creates a user and displays the generated temporary password once", async () => {
    const createdUser = {
      ...apiUser,
      id: "user-api-2",
      oidc_subject: "local:user-api-2",
      email: "new.inspector@example.com",
      first_name: "New",
      last_name: "Inspector",
      role: "INSPECTOR",
      mfa_enabled: false,
      must_change_password: true
    };
    let created = false;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/users/summary")) return jsonResponse(summaryBody);
      if (init?.method === "POST") {
        created = true;
        return jsonResponse({ user: createdUser, temporary_password: "Generated-Temp-Password-1234" });
      }
      const items = created ? [createdUser, apiUser] : [apiUser];
      return jsonResponse({ total: items.length, limit: 50, offset: 0, items });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <SystemWorkspace
        module="users"
        actorRoles={["HMS_ADMIN"]}
        customerOptions={customers}
      />
    );

    await screen.findByText("staff@example.com");
    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Email"), "new.inspector@example.com");
    await user.type(screen.getByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Last name"), "Inspector");
    await user.selectOptions(within(screen.getByRole("dialog")).getByLabelText("Role"), "INSPECTOR");
    await user.click(screen.getByRole("button", { name: /create user/i }));

    expect(await screen.findByTestId("credential-value")).toHaveTextContent(
      "Generated-Temp-Password-1234"
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("credential-value")).not.toBeInTheDocument();
    expect(screen.getByText("new.inspector@example.com")).toBeVisible();
  });

  it("wires disable, unlock, password reset, and MFA reset actions", async () => {
    const lockedUser = {
      ...apiUser,
      id: "user-api-locked",
      oidc_subject: "local:user-api-locked",
      email: "locked@example.com",
      role: "INSPECTOR",
      account_status: "LOCKED",
      locked_until: "2026-07-12T03:00:00Z"
    };
    // A small server: the list is whatever the actions have made of the records so far, as in life.
    const records: Record<string, Record<string, unknown>> = { [apiUser.id]: apiUser, [lockedUser.id]: lockedUser };
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/users/summary")) return jsonResponse(summaryBody);
      if (!init?.method && url.startsWith("/api/v1/admin/users?")) {
        const items = Object.values(records);
        return jsonResponse({ total: items.length, limit: 50, offset: 0, items });
      }
      const change = (id: string, values: Record<string, unknown>) => {
        records[id] = { ...records[id], ...values };
        return jsonResponse(records[id]);
      };
      if (url.endsWith("/disable")) return change(apiUser.id, { account_status: "DISABLED" });
      if (url.endsWith("/unlock")) return change(lockedUser.id, { account_status: "ACTIVE", locked_until: null });
      if (url.endsWith("/password-reset")) {
        return jsonResponse({
          user_id: "user-api-1",
          temporary_password: "Reset-Temp-Password-5678"
        });
      }
      if (url.endsWith("/mfa-reset")) return change(apiUser.id, { mfa_enabled: false });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const confirmDialog = async (button: string) =>
      user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: button }));

    render(
      <SystemWorkspace
        module="users"
        actorRoles={["HMS_ADMIN"]}
        customerOptions={customers}
      />
    );

    await screen.findByText("locked@example.com");
    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Disable account" }));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/disable"), expect.anything());
    await confirmDialog("Disable account");
    await waitFor(() => expect(screen.getByText("DISABLED")).toBeVisible());
    expect(screen.getByText(/was disabled\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage locked@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Unlock account" }));
    await confirmDialog("Unlock account");
    await waitFor(() => expect(screen.getAllByText("ACTIVE")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset password" }));
    await confirmDialog("Reset password");
    expect(await screen.findByTestId("credential-value")).toHaveTextContent(
      "Reset-Temp-Password-5678"
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset MFA" }));
    await confirmDialog("Reset MFA");
    await waitFor(() => expect(screen.getByText("MFA setup required")).toBeVisible());
  });
});
