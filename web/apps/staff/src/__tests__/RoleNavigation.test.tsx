import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HmsApp, modulesForSession } from "../App";
import type { StaffRole, StaffSession } from "../domain/types";

function session(role: StaffRole): StaffSession {
  return {
    userId: role.toLowerCase(),
    displayName: role,
    roles: [role],
    permissions: [],
    customerIds: role === "CUSTOMER_USER" ? ["customer-1"] : [],
    authMode: "bearer"
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("role navigation", () => {
  it.each([
    ["SUPER_ADMIN", ["dashboard", "analytics", "customers", "assets", "products", "reference", "inspections", "certificates", "retest", "sync", "audit", "users", "devices"]],
    ["HMS_ADMIN", ["dashboard", "analytics", "customers", "assets", "products", "reference", "inspections", "certificates", "retest", "audit", "users", "devices"]],
    ["INSPECTOR", ["dashboard", "customers", "assets", "inspections", "retest", "sync"]],
    ["ASSEMBLY", ["dashboard", "customers", "assets", "retest"]],
    ["REVIEWER", ["dashboard", "customers", "assets", "inspections", "certificates", "retest"]],
    ["CUSTOMER_USER", ["dashboard", "customers", "assets", "inspections", "certificates", "retest"]]
  ] as const)("shows the approved %s workspace", (role, expected) => {
    expect(modulesForSession(session(role))).toEqual(expected);
  });

  it("unions modules for a persisted multi-role session", () => {
    const combined = {
      ...session("INSPECTOR"),
      roles: ["INSPECTOR", "REVIEWER"] as StaffRole[]
    };
    expect(modulesForSession(combined)).toEqual([
      "dashboard",
      "customers",
      "assets",
      "inspections",
      "certificates",
      "retest",
      "sync"
    ]);
  });

  it("keeps customer-user record modules read-only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    render(<HmsApp session={session("CUSTOMER_USER")} />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    expect(screen.queryByRole("button", { name: "Add Asset" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspections" }));
    expect(screen.queryByRole("button", { name: "Add Inspection" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    expect(screen.queryByRole("button", { name: "Issue Certificate" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retest Schedule" }));
    expect(await screen.findByRole("heading", { name: "Retest Schedule" })).toBeVisible();
    await user.click((await screen.findAllByRole("button", { name: /open schedule/i }))[0]);
    expect(screen.queryByRole("button", { name: "Save schedule" })).not.toBeInTheDocument();
  });
});
