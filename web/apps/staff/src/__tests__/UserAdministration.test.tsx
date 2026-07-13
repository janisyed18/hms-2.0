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

    expect(screen.getByLabelText("Email")).toHaveFocus();
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

  it("requires a customer only for Customer User and blocks submit until chosen", () => {
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
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "CUSTOMER_USER" }
    });
    // Customer selector now required; submit disabled until a customer is chosen.
    const submit = screen.getByRole("button", { name: /create user/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Customer"), {
      target: { value: "c2" }
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ role: "CUSTOMER_USER", customerId: "c2" })
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ total: 1, limit: 50, offset: 0, items: [apiUser] })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          user: createdUser,
          temporary_password: "Generated-Temp-Password-1234"
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <SystemWorkspace
        module="users"
        source="api"
        actorRoles={["HMS_ADMIN"]}
        customerOptions={customers}
      />
    );

    await screen.findByText("staff@example.com");
    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Email"), "new.inspector@example.com");
    await user.type(screen.getByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Last name"), "Inspector");
    await user.selectOptions(screen.getByLabelText("Role"), "INSPECTOR");
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
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (!init?.method && url.startsWith("/api/v1/admin/users?")) {
        return jsonResponse({
          total: 2,
          limit: 50,
          offset: 0,
          items: [apiUser, lockedUser]
        });
      }
      if (url.endsWith("/disable")) {
        return jsonResponse({ ...apiUser, account_status: "DISABLED" });
      }
      if (url.endsWith("/unlock")) {
        return jsonResponse({
          ...lockedUser,
          account_status: "ACTIVE",
          locked_until: null
        });
      }
      if (url.endsWith("/password-reset")) {
        return jsonResponse({
          user_id: "user-api-1",
          temporary_password: "Reset-Temp-Password-5678"
        });
      }
      if (url.endsWith("/mfa-reset")) {
        return jsonResponse({ ...apiUser, mfa_enabled: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const user = userEvent.setup();

    render(
      <SystemWorkspace
        module="users"
        source="api"
        actorRoles={["HMS_ADMIN"]}
        customerOptions={customers}
      />
    );

    await screen.findByText("locked@example.com");
    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Disable account" }));
    await waitFor(() => expect(screen.getByText("DISABLED")).toBeVisible());

    await user.click(screen.getByRole("button", { name: "Manage locked@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Unlock account" }));
    await waitFor(() => expect(screen.getAllByText("ACTIVE")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset password" }));
    expect(await screen.findByTestId("credential-value")).toHaveTextContent(
      "Reset-Temp-Password-5678"
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    await user.click(screen.getByRole("button", { name: "Manage staff@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset MFA" }));
    await waitFor(() => expect(screen.getByText("MFA setup required")).toBeVisible());
  });
});
