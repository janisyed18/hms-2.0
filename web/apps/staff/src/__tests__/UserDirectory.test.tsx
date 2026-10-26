import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { SystemWorkspace } from "../components/SystemWorkspace";
import type { AdminUserRecord } from "../domain/types";
import { greetingName, personName } from "../utils/identity";

const client = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  getAdminUserSummary: vi.fn(),
  listDevices: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const person = (over: Partial<AdminUserRecord>): AdminUserRecord => ({
  id: "u1", oidcSubject: "s1", email: "jani@example.com", firstName: "Jani", lastName: "Syed", displayName: "Jani Syed",
  role: "INSPECTOR", customerId: null, customerIds: [], accountStatus: "ACTIVE", mustChangePassword: false, mfaEnabled: true,
  lockedUntil: null, lastLoginAt: null, createdAt: "2027-01-01T00:00:00Z", updatedAt: "2027-01-01T00:00:00Z", ...over
}) as AdminUserRecord;

const jani = person({});
const legacy = person({ id: "u2", email: "old.account@example.com", firstName: null, lastName: null, displayName: "old.account@example.com", role: "ASSEMBLY" });
const client1 = person({ id: "u3", email: "cora@example.com", firstName: "Cora", lastName: "Client", displayName: "Cora Client", role: "CUSTOMER_USER", customerId: "c1", customerIds: ["c1"] });
const summary = { total: 40, byRole: { HMS_ADMIN: 3, SUPER_ADMIN: 1, REVIEWER: 6, INSPECTOR: 20, ASSEMBLY: 4, CUSTOMER_USER: 6 }, active: 33, locked: 2, disabled: 5, mfaEnabled: 30, mfaSetupRequired: 10 };
const customers = [{ id: "c1", name: "Vopak" }, { id: "c2", name: "Orica" }];

const lastCall = () => client.listAdminUsers.mock.calls.at(-1)?.[0] as Record<string, unknown>;

function renderUsers() {
  const user = userEvent.setup();
  render(<SystemWorkspace actorRoles={["HMS_ADMIN"]} customerOptions={customers} module="users" />);
  return user;
}

beforeEach(() => {
  client.listAdminUsers.mockReset();
  client.getAdminUserSummary.mockReset();
  client.listAdminUsers.mockResolvedValue({ total: 3, etag: null, nextAfter: null, items: [jani, legacy, client1] });
  client.getAdminUserSummary.mockResolvedValue(summary);
});

describe("user discovery", () => {
  it("sends the search to the server after a short pause, from page one", async () => {
    const user = renderUsers();
    await screen.findByText("Jani Syed");
    await user.type(screen.getByLabelText("Search users"), "syed");
    expect(client.listAdminUsers.mock.calls.every(([options]) => options.search !== "syed")).toBe(true); // not per keystroke
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "syed", offset: 0 }));
    expect(client.listAdminUsers.mock.calls.filter(([options]) => options.search === "syed")).toHaveLength(1);
  });

  it("sends role, status, MFA, customer and sort as their own parameters and composes them", async () => {
    const user = renderUsers();
    await screen.findByText("Jani Syed");
    await user.selectOptions(screen.getByLabelText("Role"), "INSPECTOR");
    await user.selectOptions(screen.getByLabelText("Account status"), "LOCKED");
    await user.selectOptions(screen.getByLabelText("MFA"), "setup_required");
    await user.selectOptions(screen.getByLabelText("Customer"), "c2");
    await user.selectOptions(screen.getByLabelText("Sort by"), "-last_login_at");
    await waitFor(() =>
      expect(lastCall()).toMatchObject({
        role: "INSPECTOR", accountStatus: "LOCKED", mfa: "setup_required", customerId: "c2", sort: "-last_login_at", search: ""
      })
    );
  });

  it("goes back to page one when a filter changes and pages by offset otherwise", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 25, etag: null, nextAfter: null, items: [jani] });
    const user = renderUsers();
    await screen.findByText("Jani Syed");
    await user.click(screen.getByRole("button", { name: "User access records page 2" }));
    await waitFor(() => expect(lastCall()).toMatchObject({ offset: 10, limit: 10 }));
    await user.selectOptions(screen.getByLabelText("Role"), "REVIEWER");
    await waitFor(() => expect(lastCall()).toMatchObject({ role: "REVIEWER", offset: 0 }));
  });

  it("says how many users match, and Clear filters restores the full directory", async () => {
    const user = renderUsers();
    await screen.findByText("Jani Syed");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, nextAfter: null, items: [jani] });
    await user.selectOptions(screen.getByLabelText("Role"), "INSPECTOR");
    expect(await screen.findByText("1 user matches these filters.")).toBeInTheDocument();
    client.listAdminUsers.mockResolvedValue({ total: 3, etag: null, nextAfter: null, items: [jani, legacy, client1] });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastCall()).toMatchObject({ role: "", search: "", offset: 0 }));
    expect(screen.getByLabelText("Role")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(await screen.findByText("Cora Client")).toBeInTheDocument();
  });

  it("shows directory-wide counts, not counts of the rows on the page", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, nextAfter: null, items: [jani] });
    renderUsers();
    expect(await screen.findByText("40 user accounts")).toBeInTheDocument();
    const metrics = screen.getByText("Active Users").closest("article, div") as HTMLElement;
    expect(within(metrics).getByText("33")).toBeInTheDocument();
    expect(screen.getByText("Admin Seats").parentElement).toHaveTextContent("4"); // 3 HMS + 1 Super
    expect(screen.getByText("Reviewer Seats").parentElement).toHaveTextContent("6");
    expect(screen.getByText("20 users")).toBeInTheDocument(); // role matrix: inspectors
  });
});

describe("states", () => {
  it("shows a skeleton while the first page loads", async () => {
    client.listAdminUsers.mockReturnValue(new Promise(() => undefined));
    renderUsers();
    expect(await screen.findByRole("status", { name: "Loading users" })).toBeInTheDocument();
  });

  it("explains an empty filtered result and offers Clear filters", async () => {
    const user = renderUsers();
    await screen.findByText("Jani Syed");
    client.listAdminUsers.mockResolvedValue({ total: 0, etag: null, nextAfter: null, items: [] });
    await user.type(screen.getByLabelText("Search users"), "nobody");
    expect(await screen.findByText("No users match these filters")).toBeInTheDocument();
    client.listAdminUsers.mockResolvedValue({ total: 3, etag: null, nextAfter: null, items: [jani, legacy, client1] });
    await user.click(within(screen.getByText("No users match these filters").closest("section") as HTMLElement).getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Jani Syed")).toBeInTheDocument();
  });

  it("tells the first-time admin there are no users yet", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 0, etag: null, nextAfter: null, items: [] });
    renderUsers();
    expect(await screen.findByText("No users yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("shows a safe error with Try again, and keeps the filters", async () => {
    client.listAdminUsers.mockRejectedValueOnce(new HmsApiError(500, "internal", "psycopg.errors.OperationalError: boom", null));
    const user = renderUsers();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Users could not be loaded");
    expect(alert.textContent).not.toMatch(/psycopg/);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Jani Syed")).toBeInTheDocument();
  });

  it("ignores a slow answer to an earlier search", async () => {
    let resolveSlow: (value: unknown) => void = () => undefined;
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, nextAfter: null, items: [legacy] });
    const user = renderUsers();
    await screen.findByText("old.account@example.com");
    client.listAdminUsers.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));
    await user.type(screen.getByLabelText("Search users"), "j");
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "j" }));
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, nextAfter: null, items: [client1] });
    await user.type(screen.getByLabelText("Search users"), "o");
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "jo" }));
    expect(await screen.findByText("Cora Client")).toBeInTheDocument();
    // The earlier, slower answer arrives last and must not replace what the latest search found.
    await act(async () => resolveSlow({ total: 1, etag: null, nextAfter: null, items: [jani] }));
    expect(screen.getByText("Cora Client")).toBeInTheDocument();
    expect(screen.queryByText("Jani Syed")).toBeNull();
  });
});

describe("identity", () => {
  it("shows the name first and the email second, and customer names instead of ids", async () => {
    renderUsers();
    const row = (await screen.findByText("Cora Client")).closest("tr") as HTMLElement;
    const cell = within(row).getByText("Cora Client").closest("td") as HTMLElement;
    expect(cell.firstElementChild).toHaveTextContent("Cora Client");
    expect(cell.lastElementChild).toHaveTextContent("cora@example.com");
    expect(row).toHaveTextContent("Vopak");
    expect(row.textContent).not.toMatch(/\bc1\b/);
  });

  it("never shows a raw customer id when the customer's name is not known", async () => {
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, nextAfter: null, items: [person({ ...client1, id: "u9", email: "z@example.com", customerIds: ["c9", "c1"] })] });
    renderUsers();
    const row = (await screen.findByText("z@example.com")).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("2 customers");
    expect(row.textContent).not.toMatch(/c9/);
  });

  it("keeps a legacy account without a name readable", async () => {
    renderUsers();
    const row = (await screen.findByText("old.account@example.com")).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("Name not set");
    expect(row).toHaveTextContent("ASSEMBLY");
  });

  it("builds a person's name only from names that exist", () => {
    expect(personName({ firstName: "Jani", lastName: "Syed" })).toBe("Jani Syed");
    expect(personName({ firstName: " Jani ", lastName: null })).toBe("Jani");
    expect(personName({ firstName: null, lastName: "" })).toBeNull();
  });

  it("never greets someone by their email address", () => {
    expect(greetingName({ displayName: "Jani Syed", email: "jani@example.com" })).toBe("Jani Syed");
    expect(greetingName({ displayName: "jani@example.com", email: "jani@example.com" })).toBeNull();
    expect(greetingName({ displayName: "JANI@Example.com", email: "jani@example.com" })).toBeNull();
    expect(greetingName({ displayName: "  " })).toBeNull();
  });
});
