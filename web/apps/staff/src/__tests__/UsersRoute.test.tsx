import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemWorkspace } from "../components/SystemWorkspace";
import type { AdminUserRecord } from "../domain/types";
import type { UsersRouteQuery } from "../routing/routeTypes";
import { useHmsRoute } from "../routing/useHmsRoute";

const client = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  getAdminUserSummary: vi.fn(),
  listDevices: vi.fn(),
  disableAdminUser: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const user = (over: Partial<AdminUserRecord> = {}) => ({
  id: "u1", oidcSubject: "s1", email: "jani@example.com", firstName: "Jani", lastName: "Syed", displayName: "Jani Syed",
  role: "INSPECTOR", customerId: null, customerIds: [], accountStatus: "ACTIVE", mustChangePassword: false, mfaEnabled: true,
  lockedUntil: null, lastLoginAt: null, createdAt: "2027-01-01T00:00:00Z", updatedAt: "2027-01-01T00:00:00Z", ...over
}) as AdminUserRecord;

const summary = { total: 40, byRole: { INSPECTOR: 20 }, active: 33, locked: 2, disabled: 5, mfaEnabled: 30, mfaSetupRequired: 10 };
const customers = [{ id: "cust-1", name: "Vopak" }];
const lastCall = () => client.listAdminUsers.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const open = (url: string) => window.history.replaceState(null, "", url);

// The real route hook around the real Users workspace: what the app does, without the rest of the app.
function Harness() {
  const { route, navigate } = useHmsRoute("staff", ["dashboard", "users", "assets"], "dashboard");
  const onChange = useCallback(
    (patch: Partial<UsersRouteQuery>, options?: { replace?: boolean }) =>
      navigate((current) => ({ ...current, users: { ...current.users, ...patch } }), options),
    [navigate]
  );
  const usersRoute = useMemo(() => ({ query: route.users, onChange }), [route.users, onChange]);
  return (
    <>
      <button onClick={() => navigate({ view: "assets" })} type="button">Go to assets</button>
      {route.view === "users" ? <SystemWorkspace actorRoles={["HMS_ADMIN"]} customerOptions={customers} module="users" usersRoute={usersRoute} /> : <p>Assets page</p>}
    </>
  );
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listAdminUsers.mockResolvedValue({ total: 3, etag: null, nextAfter: null, items: [user()] });
  client.getAdminUserSummary.mockResolvedValue(summary);
});

describe("Users & Roles in the URL", () => {
  it("opens a link carrying all seven values with the controls set and exactly that server query", async () => {
    open("/?view=users&q=syed+jani&role=INSPECTOR&status=ACTIVE&mfa=enabled&customer=cust-1&sort=-last_login_at&page=2&page_size=25");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    expect(screen.getByLabelText("Search users")).toHaveValue("syed jani");
    expect(screen.getByLabelText("Role")).toHaveValue("INSPECTOR");
    expect(screen.getByLabelText("Account status")).toHaveValue("ACTIVE");
    expect(screen.getByLabelText("MFA")).toHaveValue("enabled");
    expect(screen.getByLabelText("Customer")).toHaveValue("cust-1");
    expect(screen.getByLabelText("Sort by")).toHaveValue("-last_login_at");
    expect(screen.getByLabelText("User access records rows per page")).toHaveValue("25");
    // 3 matches at 25 a page cannot have a page 2, so the page clamps; the first request was still the link's own.
    expect(client.listAdminUsers.mock.calls[0][0]).toEqual({
      search: "syed jani", role: "INSPECTOR", accountStatus: "ACTIVE", mfa: "enabled", customerId: "cust-1",
      sort: "-last_login_at", limit: 25, offset: 25
    });
  });

  it("asks the server once per navigation, not once per synchronisation", async () => {
    open("/?view=users&role=INSPECTOR&page=1");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.listAdminUsers).toHaveBeenCalledTimes(1);
    expect(client.getAdminUserSummary).toHaveBeenCalledTimes(1);
  });

  it("changing a filter pushes a history entry, resets to page one, and puts it in the URL", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 60, etag: null, nextAfter: null, items: [user()] });
    open("/?view=users&page=3");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    const before = window.history.length;
    await userEvent.setup().selectOptions(screen.getByLabelText("Role"), "REVIEWER");
    expect(window.location.search).toBe("?view=users&role=REVIEWER");
    expect(window.history.length).toBe(before + 1);
    await waitFor(() => expect(lastCall()).toMatchObject({ role: "REVIEWER", offset: 0 }));
  });

  it("paging pushes, and a new page size starts again from page one", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 60, etag: null, nextAfter: null, items: [user()] });
    open("/?view=users");
    render(<Harness />);
    const actor = userEvent.setup();
    await screen.findByText("Jani Syed");
    await actor.click(screen.getByRole("button", { name: "User access records page 2" }));
    expect(window.location.search).toBe("?view=users&page=2");
    await actor.selectOptions(screen.getByLabelText("User access records rows per page"), "25");
    expect(window.location.search).toBe("?view=users&page_size=25");
  });

  it("typing in the search box does not add a history entry per keystroke", async () => {
    open("/?view=users");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    const before = window.history.length;
    await userEvent.setup().type(screen.getByLabelText("Search users"), "jani");
    await waitFor(() => expect(window.location.search).toBe("?view=users&q=jani"));
    expect(window.history.length).toBe(before); // replaced in place
    expect(client.listAdminUsers.mock.calls.filter(([options]) => options.search === "jani")).toHaveLength(1);
  });

  it("Clear filters removes the filter parameters and keeps nothing stale", async () => {
    open("/?view=users&q=jani&role=INSPECTOR&status=ACTIVE&mfa=enabled&customer=cust-1&sort=email&page_size=25");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }));
    // How the list is ordered and sized is not a filter, so it stays.
    expect(window.location.search).toBe("?view=users&sort=email&page_size=25");
    expect(screen.getByLabelText("Search users")).toHaveValue("");
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "", role: "", offset: 0 }));
  });

  it("corrects the URL when the page it names no longer exists", async () => {
    client.listAdminUsers.mockImplementation(async (options: { offset: number }) => ({
      total: 15, etag: null, nextAfter: null, items: options.offset >= 15 ? [] : [user()]
    }));
    open("/?view=users&page=4");
    const before = window.history.length;
    render(<Harness />);
    await screen.findByText("Jani Syed");
    expect(window.location.search).toBe("?view=users&page=2");
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(window.history.length).toBe(before); // a correction, not a new place to go Back to
  });

  it("restores the filter and the page with Back and Forward across another view", async () => {
    open("/?view=users");
    render(<Harness />);
    const actor = userEvent.setup();
    client.listAdminUsers.mockResolvedValue({ total: 60, etag: null, nextAfter: null, items: [user()] });
    await screen.findByText("Jani Syed");
    await actor.selectOptions(screen.getByLabelText("Role"), "INSPECTOR");
    await actor.click(screen.getByRole("button", { name: "User access records page 2" }));
    await actor.click(screen.getByRole("button", { name: "Go to assets" }));
    expect(await screen.findByText("Assets page")).toBeInTheDocument();
    expect(window.location.search).toBe("?view=assets");

    act(() => window.history.back());
    await screen.findByLabelText("Role");
    expect(window.location.search).toBe("?view=users&role=INSPECTOR&page=2");
    expect(screen.getByLabelText("Role")).toHaveValue("INSPECTOR");
    await waitFor(() => expect(lastCall()).toMatchObject({ role: "INSPECTOR", offset: 10 }));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?view=users&role=INSPECTOR"));
    await waitFor(() => expect(lastCall()).toMatchObject({ role: "INSPECTOR", offset: 0 }));

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByLabelText("Role")).toHaveValue(""));
    expect(window.location.search).toBe("?view=users");
  });

  it("falls back safely from unknown parameters and invalid values", async () => {
    open("/?view=users&status=BOGUS&page=-4&sort=password&utm_source=x");
    render(<Harness />);
    await screen.findByText("Jani Syed");
    expect(window.location.search).toBe("?view=users");
    expect(lastCall()).toMatchObject({ accountStatus: undefined, sort: "name", offset: 0 });
  });
});
