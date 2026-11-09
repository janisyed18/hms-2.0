import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { chooseOption } from "./choose";
import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  repoRoot,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const STAMP = Date.now().toString().slice(-8);
const PREFIX = `MX${STAMP}`;
const FINAL_LOCATION_MESSAGE = "A customer must have at least one location. Add another location before deleting this one.";
const SUPER = "super.admin@example.test";
const ADMIN = "hms.admin@example.test";

function sql(command: string): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();
}

// The responses are read loosely: each assertion names the field it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ApiResult { status: number; body: any }

const tokens = new WeakMap<Page, Promise<string>>();

/**
 * One refresh at a time per page: the session cookie rotates on every refresh, so overlapping refreshes
 * would invalidate each other. `stale` is the token a caller just saw refused, if any.
 */
function accessToken(page: Page, stale?: string): Promise<string> {
  const current = tokens.get(page);
  if (current) {
    return current.then((token) => {
      if (token !== stale) return token;
      // Another caller may already have started the renewal while this one waited.
      const latest = tokens.get(page);
      return latest && latest !== current ? latest : renew(page);
    });
  }
  return renew(page);
}

function renew(page: Page): Promise<string> {
  const next = page.evaluate(async () => {
    const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
    return ((await refresh.json()) as { access_token: string }).access_token;
  });
  tokens.set(page, next);
  return next;
}

/** Calls the API as whoever is signed in on this page, the way the app does. */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const call = async (token: string) => page.evaluate(async ({ method, path, body, token }) => {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }, { method, path, body, token });
  const token = await accessToken(page);
  const first = await call(token);
  return first.status === 401 ? call(await accessToken(page, token)) : first;
}

/** A location chooses its timezone and uses the normalized repeatable contacts editor. */
async function fillSiteContact(page: Page, scope: ReturnType<Page["getByRole"]>) {
  const zone = scope.getByLabel("Timezone");
  await expect(zone).toHaveValue("");
  await zone.click();
  await zone.fill("Australia/Sydney");
  await page.getByRole("listbox").getByRole("option", { name: "Australia/Sydney", exact: true }).click();
  await scope.getByRole("button", { name: "Add contact" }).click();
  const contact = scope.getByRole("group", { name: "Location contacts" }).last();
  await contact.getByLabel("Contact 1 name").fill("Site Person");
  await contact.getByLabel("Contact 1 phone").fill("+61 400 000 000");
  await contact.getByLabel("Contact 1 email").fill("site.person@example.test");
}

const location = (name: string) => ({
  name,
  site_contact_name: "Site Person",
  site_contact_mobile: "+61 400 000 000",
  site_contact_email: "site.person@example.test",
  scheduling_timezone: "Australia/Sydney",
  scheduling_open_time: "07:00",
  scheduling_close_time: "15:00",
  scheduling_weekdays: [0, 1, 2, 3, 4],
  scheduling_blackout_dates: [] as string[]
});

/** Clicks Save product and waits for the server's answer, so what follows reads the saved state. */
async function saveProduct(page: Page) {
  const saved = page.waitForResponse((response) => /\/api\/v1\/products(\/[^/]+)?$/.test(new URL(response.url()).pathname) && ["POST", "PATCH"].includes(response.request().method()));
  await page.getByRole("button", { name: "Save product" }).click();
  expect((await saved).status()).toBeLessThan(300);
}

/** Opens a searchable list, narrows it to `text`, and chooses the match. */
async function pickRemote(page: Page, control: ReturnType<Page["getByLabel"]>, text: string) {
  await control.click();
  await control.fill(text);
  await page.getByRole("listbox").getByRole("option").filter({ hasText: text }).first().click();
}

test.describe("management UX and data correctness", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await waitForApiHealth();
  });

  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    clearRateLimits();
  });

  test.afterAll(() => {
    // These records are synthetic and created above; remove them so other specs see the usual data.
    try {
      sql(`
        DELETE FROM products WHERE code LIKE '${PREFIX}%';
        DELETE FROM customer_location_contacts WHERE location_id IN (SELECT id FROM customer_locations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '${PREFIX}%'));
        DELETE FROM customer_contacts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '${PREFIX}%');
        DELETE FROM customer_locations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '${PREFIX}%');
        DELETE FROM customers WHERE name LIKE '${PREFIX}%';
      `);
    } catch (error) {
      console.warn("management-ux cleanup skipped:", error instanceof Error ? error.message : error);
    }
  });

  test("Add asset: nothing is chosen for the person, and changing the customer clears the location", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      const a = await api(page, "POST", "/api/v1/customers", { name: `${PREFIX} Alpha`, locations: [location("Alpha North"), location("Alpha South")].slice(0, 1) });
      expect(a.status).toBe(201);
      expect((await api(page, "POST", `/api/v1/customers/${a.body.id}/locations`, location("Alpha South"))).status).toBe(201);
      const b = await api(page, "POST", "/api/v1/customers", { name: `${PREFIX} Bravo`, locations: [location("Bravo East")] });
      expect(b.status).toBe(201);
      expect((await api(page, "POST", `/api/v1/customers/${b.body.id}/locations`, location("Bravo West"))).status).toBe(201);

      await page.goto("/?view=assets");
      await page.getByRole("button", { name: "Add asset" }).first().click();
      const form = page.getByRole("form", { name: "Add asset" });
      await expect(form).toBeVisible();

      // The vocabulary is Customer, never Agent.
      await expect(form.getByLabel("Agent")).toHaveCount(0);
      // The initial state, before any interaction: all three are empty.
      const customer = form.getByLabel("Customer");
      const place = form.getByLabel("Location");
      const product = form.getByRole("combobox", { name: "Product" });
      await expect(customer).toHaveValue("");
      await expect(customer).toHaveAttribute("placeholder", "Select a customer");
      await expect(place).toBeDisabled();
      await expect(place).toHaveText("Select a customer first");
      await expect(product).toHaveValue("");
      await expect(product).toHaveAttribute("placeholder", "Select a product");

      await pickRemote(page, customer, `${PREFIX} Alpha`);
      await expect(place).toBeEnabled();
      await expect(place).toHaveText("Select a location"); // the first location is not chosen for them
      await chooseOption(place, { label: "Alpha South" });
      await expect(place).toHaveText("Alpha South");

      await pickRemote(page, customer, `${PREFIX} Bravo`);
      await expect(place).toBeEnabled();
      await expect(place).toHaveText("Select a location"); // the old location is gone and no other is picked
      await form.getByRole("button", { name: "Save asset" }).click();
      await expect(place).toBeFocused();
    } finally {
      await admin.context.close();
    }
  });

  test("selectors reach records past the old 50/100 boundaries", async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      const batches = Array.from({ length: 11 }, (_, batch) => batch);
      for (const batch of batches) {
        const results = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
          const n = batch * 10 + i + 1;
          const pad = String(n).padStart(3, "0");
          const customerResult = await api(page, "POST", "/api/v1/customers", { name: `${PREFIX} Bulk ${pad}`, locations: [location(`Site ${pad}`)] });
          const productResult = await api(page, "POST", "/api/v1/products", { category: "E2E", sub_category: null, code: `${PREFIX}P${pad}`, name: `${PREFIX} Product ${pad}`, standard_id: null, enabled: true });
          return [customerResult.status, productResult.status];
        }));
        for (const [c, p] of results) {
          expect(c).toBe(201);
          expect(p).toBe(201);
        }
      }
      const total = await api(page, "GET", "/api/v1/customers?limit=1");
      expect(total.body.total).toBeGreaterThan(101);

      // Add asset: customer #101 and product #101 are found by searching, not by paging a capped list.
      await page.goto("/?view=assets");
      await page.getByRole("button", { name: "Add asset" }).first().click();
      const form = page.getByRole("form", { name: "Add asset" });
      await pickRemote(page, form.getByLabel("Customer"), `${PREFIX} Bulk 101`);
      await expect(form.getByLabel("Customer")).toHaveValue(`${PREFIX} Bulk 101`);
      await expect(form.getByLabel("Location")).toBeEnabled();
      await pickRemote(page, form.getByRole("combobox", { name: "Product" }), `${PREFIX} Product 101`);
      await expect(form.getByRole("combobox", { name: "Product" })).toHaveValue(`${PREFIX} Product 101`);
      await form.getByRole("button", { name: "Cancel" }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await discard.getByRole("button", { name: "Discard changes" }).click();

      // Add user (Customer User): a customer beyond the old first page can be assigned.
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true }).click();
      await page.getByRole("button", { name: "Add user" }).click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await chooseOption(dialog.getByLabel("Role"), "CUSTOMER_USER");
      const assign = dialog.getByLabel("Customers");
      await assign.click();
      await assign.fill(`${PREFIX} Bulk 101`);
      await page.getByRole("listbox").getByRole("option").filter({ hasText: `${PREFIX} Bulk 101` }).first().click();
      await expect(dialog.getByRole("list", { name: "Assigned customers" })).toContainText(`${PREFIX} Bulk 101`);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("alertdialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();

      // The Customers page reports the system-wide total, and search reaches past the first page.
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Customers", exact: true }).click();
      await page.getByLabel("Search customers", { exact: true }).fill(`${PREFIX} Bulk 101`);
      await expect(page.getByRole("button", { name: `Select customer ${PREFIX} Bulk 101` })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });

  test("customer: first location is required, Details show Overview / Locations / Contacts, and the last location stays", async ({ browser }) => {
    test.setTimeout(300_000);
    const superAdmin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const hms = await signedInPage(browser, ADMIN, permanentPasswords.admin);
    const page = superAdmin.page;
    page.setDefaultTimeout(15_000);
    const name = `${PREFIX} Lifecycle`;
    try {
      // Backend invariant: no customer without a location.
      const none = await api(page, "POST", "/api/v1/customers", { name: `${PREFIX} Nothing`, locations: [] });
      expect(none.status).toBeGreaterThanOrEqual(400);
      expect(none.status).toBeLessThan(500);
      expect((await api(page, "GET", `/api/v1/customers?search=${PREFIX}%20Nothing`)).body.total).toBe(0);

      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Customers", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Staff Locations" })).toHaveCount(0);
      await page.getByRole("button", { name: "Add customer" }).first().click();
      const form = page.getByRole("form", { name: "Add customer" });
      // The location's scheduling data is visible before Save; nothing is saved invisibly.
      await expect(form.getByLabel("Timezone")).toBeVisible();
      await expect(form.getByText(/Blackout/i).first()).toBeVisible();
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByRole("button", { name: "Save customer" }).click();
      await expect(form.getByLabel("Location name")).toBeFocused(); // a customer cannot be saved without its first location
      await form.getByLabel("Location name").fill("Head Office");
      await fillSiteContact(page, form);
      await form.getByRole("button", { name: "Save customer" }).click();
      await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toBeVisible();

      await page.getByLabel("Search customers", { exact: true }).fill(name);
      await page.getByRole("button", { name: `Select customer ${name}` }).click();
      await expect(page.getByRole("tab")).toHaveText(["Overview", "Locations (1)", "Contacts (0)"]);

      // Locations come from the customer's own locations: this one has no assets yet and still shows, with 0.
      await page.getByRole("tab", { name: /Locations/ }).click();
      const card = page.getByRole("dialog").locator("article").filter({ hasText: "Head Office" });
      await expect(card).toBeVisible();
      await expect(card).toContainText(/0\s*assets/);
      await expect(page.getByText("Active locations")).toHaveCount(0);

      // The only location cannot be deleted, in the UI or by the API, even by a Super Admin.
      await expect(page.getByRole("button", { name: "Delete Head Office" })).toBeDisabled();
      await expect(page.getByText(FINAL_LOCATION_MESSAGE)).toBeVisible();
      const created = (await api(page, "GET", `/api/v1/customers?search=${encodeURIComponent(name)}`)).body.items[0];
      const only = created.locations[0].id;
      const blocked = await api(page, "DELETE", `/api/v1/customers/${created.id}/locations/${only}`);
      expect(blocked.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(blocked.body)).toContain(FINAL_LOCATION_MESSAGE);

      // Add a second location, edit it, then a Super Admin deletes it.
      await page.getByRole("button", { name: "Add location" }).click();
      const add = page.getByRole("form", { name: "Add location" });
      await add.getByLabel("Location name").fill("Annex");
      await fillSiteContact(page, add);
      await add.getByRole("button", { name: "Save location" }).click();
      await expect(page.getByRole("tab", { name: "Locations (2)" })).toBeVisible();
      await page.getByRole("button", { name: "Edit Annex" }).click();
      const edit = page.getByRole("form", { name: "Edit location" });
      await edit.getByLabel("Location name").fill("Annex Two");
      await edit.getByRole("button", { name: "Save location" }).click();
      await expect(page.getByText("Annex Two")).toBeVisible();

      // A non-Super-Admin cannot delete a location (403) and is not offered the control.
      const second = (await api(page, "GET", `/api/v1/customers/${created.id}`)).body.locations.find((l: { name: string }) => l.name === "Annex Two");
      const denied = await api(hms.page, "DELETE", `/api/v1/customers/${created.id}/locations/${second.id}`);
      expect(denied.status).toBe(403);

      await page.getByRole("button", { name: "Delete Annex Two" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete location" }).click();
      await expect(page.getByRole("tab", { name: "Locations (1)" })).toBeVisible();

      // Contacts are managed from their own tab: add one, then edit it.
      await page.getByRole("tab", { name: /Contacts/ }).click();
      await page.getByRole("button", { name: "Add contact" }).click();
      const contact = page.getByRole("form", { name: "Add contact" });
      await contact.getByLabel("Name", { exact: true }).fill("Dana Contact");
      await contact.getByLabel("Email").fill("dana.contact@example.test");
      await contact.getByRole("button", { name: "Save contact" }).click();
      await expect(page.getByRole("tab", { name: "Contacts (1)" })).toBeVisible();
      await expect(page.getByText("Dana Contact")).toBeVisible();
      await page.getByRole("button", { name: "Edit Dana Contact" }).click();
      const editContact = page.getByRole("form", { name: "Edit contact" });
      await editContact.getByLabel("Name", { exact: true }).fill("Dana Renamed");
      await editContact.getByRole("button", { name: "Save contact" }).click();
      await expect(page.getByText("Dana Renamed")).toBeVisible();

      // Archive is reversible and keeps history; archived customers leave new-work selectors; Delete is offered beside it.
      await page.getByRole("tab", { name: "Overview" }).click();
      await page.getByRole("button", { name: "Archive customer" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive customer" }).click();
      await expect(page.getByRole("button", { name: "Restore customer" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete customer" })).toBeVisible();
      const offered = await api(page, "GET", `/api/v1/customers?search=${encodeURIComponent(name)}`);
      expect(offered.body.total).toBe(0); // the default list is active customers only
      expect((await api(page, "GET", `/api/v1/customers?search=${encodeURIComponent(name)}&lifecycle=archived`)).body.total).toBe(1);
      expect((await api(hms.page, "DELETE", `/api/v1/customers/${created.id}`)).status).toBe(403);

      await page.getByRole("button", { name: "Restore customer" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Restore customer" }).click();
      await expect(page.getByRole("button", { name: "Archive customer" })).toBeVisible();
      expect((await api(page, "GET", `/api/v1/customers?search=${encodeURIComponent(name)}`)).body.total).toBe(1);

      // Delete does not need an archive step: an unused active customer is deleted in one confirmed step,
      // after the server has said nothing is linked to it.
      await page.getByRole("button", { name: "Delete customer" }).click();
      const confirmDelete = page.getByRole("alertdialog");
      await expect(confirmDelete.getByRole("heading", { name: /^Delete / })).toBeVisible();
      await expect(confirmDelete.getByText(/This cannot be undone/)).toBeVisible();
      await confirmDelete.getByRole("button", { name: "Delete customer" }).click();
      await expect(page.getByRole("status").filter({ hasText: "permanently deleted" })).toBeVisible();
      expect((await api(page, "GET", `/api/v1/customers/${created.id}`)).status).toBe(404);
      await expect(page.getByRole("dialog", { name: name })).toHaveCount(0);
    } finally {
      await superAdmin.context.close();
      await hms.context.close();
    }
  });

  test("users: Role starts empty and is required; only a Super Admin deletes, never themselves", async ({ browser }) => {
    test.setTimeout(240_000);
    const superAdmin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const hms = await signedInPage(browser, ADMIN, permanentPasswords.admin);
    const page = superAdmin.page;
    page.setDefaultTimeout(15_000);
    const email = `mx.${STAMP}@example.test`;
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true }).click();
      await page.getByRole("button", { name: "Add user" }).click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await expect(dialog.getByLabel("Role")).toHaveText("Select a role"); // no role (SUPER_ADMIN or other) is implied
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByLabel("First name").fill("Mx");
      await dialog.getByLabel("Last name").fill("Person");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("Role")).toBeFocused();
      await expect(dialog.getByText(/select a role/i).first()).toBeVisible();
      await chooseOption(dialog.getByLabel("Role"), "REVIEWER");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(page.getByTestId("credential-value")).toBeVisible();
      await page.getByRole("button", { name: "Done" }).click();

      const users = await api(page, "GET", `/api/v1/admin/users?search=${encodeURIComponent(email)}`);
      const created = users.body.items.find((u: { email: string }) => u.email === email);
      expect(created).toBeTruthy();
      // HMS Admin may not delete users; a Super Admin may, but not themselves.
      expect((await api(hms.page, "DELETE", `/api/v1/admin/users/${created.id}`)).status).toBe(403);
      const me = (await api(page, "GET", "/api/v1/admin/users?search=super.admin@example.test")).body.items[0];
      const self = await api(page, "DELETE", `/api/v1/admin/users/${me.id}`);
      expect(self.status).toBeGreaterThanOrEqual(400);
      expect((await api(page, "DELETE", `/api/v1/admin/users/${created.id}`)).status).toBeLessThan(300);
      const after = await api(page, "GET", `/api/v1/admin/users?search=${encodeURIComponent(email)}`);
      expect(after.body.items.find((u: { email: string }) => u.email === email)).toBeFalsy();
    } finally {
      await superAdmin.context.close();
      await hms.context.close();
    }
  });

  test("products: add, edit keeps the standard, disable/enable, and Delete is Super Admin only", async ({ browser }) => {
    test.setTimeout(300_000);
    const superAdmin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const hms = await signedInPage(browser, ADMIN, permanentPasswords.admin);
    const page = superAdmin.page;
    page.setDefaultTimeout(15_000);
    const code = `${PREFIX}PX`;
    try {
      const standards = await api(page, "GET", "/api/v1/reference/catalog/standards?limit=5");
      const standard = standards.body.items.find((item: { enabled: boolean }) => item.enabled);
      expect(standard).toBeTruthy();

      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Products", exact: true }).click();
      await page.getByRole("button", { name: "Add product" }).click();
      const form = page.locator("form.customer-drawer");
      await form.getByLabel("Product code").fill(code);
      await form.getByLabel("Product name").fill(`${PREFIX} Hose`);
      await form.getByLabel("Category", { exact: true }).fill("E2E");
      await form.getByLabel("Standard").click();
      await page.getByRole("listbox").locator(`[data-value="${standard.id}"]`).click();
      await page.getByRole("button", { name: "Save product" }).click();
      await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toBeVisible();

      // Edit: the standard is populated, and renaming / recategorising does not clear it.
      await page.getByPlaceholder(/Search products/).fill(code);
      const row = page.getByRole("row", { name: new RegExp(code) });
      await row.getByRole("button", { name: "Edit" }).click();
      const edit = page.locator("form.customer-drawer");
      await expect(edit.getByLabel("Standard")).toHaveValue(new RegExp(standard.code));
      await edit.getByLabel("Product name").fill(`${PREFIX} Hose Renamed`);
      await edit.getByLabel("Category", { exact: true }).fill("E2E Changed");
      await saveProduct(page);
      const afterEdit = (await api(page, "GET", `/api/v1/products?search=${code}`)).body.items[0];
      expect(afterEdit.standard_id).toBe(standard.id);
      expect(afterEdit.name).toBe(`${PREFIX} Hose Renamed`);

      // Deliberately changing the standard works.
      await row.getByRole("button", { name: "Edit" }).click();
      await page.locator("form.customer-drawer").getByLabel("Standard").click();
      await page.getByRole("listbox").locator('[data-value=""]').click();
      await saveProduct(page);
      expect((await api(page, "GET", `/api/v1/products?search=${code}`)).body.items[0].standard_id).toBeNull();

      // Disable removes it from new-work selection; Enable brings it back.
      await page.getByRole("button", { name: `Disable ${PREFIX} Hose Renamed` }).click();
      await expect(page.getByRole("status").filter({ hasText: "was disabled" })).toBeVisible();
      expect((await api(page, "GET", `/api/v1/products?search=${code}`)).body.total).toBe(0);
      // A disabled product is no longer offered when adding an asset.
      await page.goto("/?view=assets");
      await page.getByRole("button", { name: "Add asset" }).first().click();
      const assetForm = page.getByRole("form", { name: "Add asset" });
      const productList = assetForm.getByRole("combobox", { name: "Product" });
      await productList.click();
      await productList.fill(code);
      await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(0);
      await assetForm.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Products", exact: true }).click();
      await page.getByPlaceholder(/Search products/).fill(code);
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByLabel("Product status filter").selectOption("DISABLED");
      await page.getByRole("button", { name: `Enable ${PREFIX} Hose Renamed` }).click();
      await expect(page.getByRole("status").filter({ hasText: "was enabled" })).toBeVisible();
      expect((await api(page, "GET", `/api/v1/products?search=${code}`)).body.total).toBe(1);

      // Delete: the control is Super Admin only, and the API agrees.
      await page.getByLabel("Product status filter").selectOption("ACTIVE");
      await expect(page.getByRole("button", { name: `Delete ${PREFIX} Hose Renamed` })).toBeVisible();
      await hms.page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Products", exact: true }).click();
      await hms.page.getByPlaceholder(/Search products/).fill(code);
      await expect(hms.page.getByRole("button", { name: `Edit` }).first()).toBeVisible();
      await expect(hms.page.getByRole("button", { name: `Delete ${PREFIX} Hose Renamed` })).toHaveCount(0);
      expect((await api(hms.page, "DELETE", `/api/v1/products/${afterEdit.id}`)).status).toBe(403);

      // A product that assets use cannot be destructively removed.
      const customer = (await api(page, "GET", "/api/v1/customers?limit=1")).body.items[0];
      const asset = await api(page, "POST", "/api/v1/assets", { customer_id: customer.id, location_id: customer.locations[0].id, product_id: afterEdit.id, asset_number: `${PREFIX}-A1`, asset_name: "Dependent" });
      expect(asset.status).toBe(201);
      const refused = await api(page, "DELETE", `/api/v1/products/${afterEdit.id}`);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      sql(`DELETE FROM assets WHERE asset_number = '${PREFIX}-A1';`);
    } finally {
      await superAdmin.context.close();
      await hms.context.close();
    }
  });
});
