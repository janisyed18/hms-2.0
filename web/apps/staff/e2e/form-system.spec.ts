import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";
import { chooseOption } from "./choose";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ASSET = "00000000-0000-7000-8000-0000000000c1";

function sql(command: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

function prepare() {
  cleanup();
  sql(`
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, asset_name, customer_serial_no, lifecycle_status)
      SELECT '${ASSET}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-FORM-1', 'Form Test Hose', 'SN-FORM-1', 'IN_SERVICE'
      FROM customers c
      JOIN customer_locations l ON l.customer_id = c.id
      CROSS JOIN (SELECT id FROM products ORDER BY created_at LIMIT 1) p
      WHERE c.code = 'VOPA' LIMIT 1;
  `);
}

function cleanup() {
  sql(`DELETE FROM assets WHERE id = '${ASSET}';`);
}

/** Fail the next request matching `url` with `status`, then let later ones through untouched. */
async function failOnce(page: Page, url: RegExp, method: string, status: number, body: unknown) {
  let failed = false;
  await page.route(url, async (route: Route) => {
    if (!failed && route.request().method() === method) {
      failed = true;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    await route.fallback();
  });
}

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1000], [390, 844]];
const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("shared Staff form system", () => {
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

  test.afterAll(() => cleanup());

  test("asset: edit, protect unsaved work, save, and the deep link stays exact", async ({ browser }) => {
    test.setTimeout(240_000);
    prepare();
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const deepLink = `/?view=assets&asset=${ASSET}`;
    const form = page.getByRole("form", { name: "Edit asset" });
    try {
      await page.goto(deepLink);
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toContainText("Form Test Hose");
      await page.getByRole("complementary", { name: "Asset detail" }).getByRole("button", { name: "Edit" }).click();
      await expect(form).toBeVisible();
      await expect(form.getByLabel("Asset Name")).toHaveValue("Form Test Hose");

      // Clean forms leave at once; nothing is asked.
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);

      // Dirty: Cancel, Escape and Back each ask first, and keeping the work loses nothing.
      // Opening Edit hands the screen to the form, so come back to the record the way a person would.
      await page.goto(deepLink);
      await page.getByRole("complementary", { name: "Asset detail" }).getByRole("button", { name: "Edit" }).click();
      await form.getByLabel("Asset Name").fill("Form Test Hose edited");
      await expect(form.getByText("Unsaved changes")).toBeVisible();
      const before = here(page);

      await form.getByRole("button", { name: "Cancel" }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(form.getByLabel("Asset Name")).toHaveValue("Form Test Hose edited");

      await page.keyboard.press("Escape");
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(form.getByLabel("Asset Name")).toHaveValue("Form Test Hose edited");

      await page.goBack();
      await expect(discard).toBeVisible();
      expect(here(page)).toBe(before);
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(form.getByLabel("Asset Name")).toHaveValue("Form Test Hose edited");

      // A refusal keeps every value; the retry saves and the form is clean again.
      await failOnce(page, /\/api\/v1\/assets\/[^/]+$/, "PATCH", 500, { error: { code: "internal", message: "Internal server error", details: null } });
      await failOnce(page, /\/api\/v1\/assets\/[^/]+$/, "PUT", 500, { error: { code: "internal", message: "Internal server error", details: null } });
      await form.getByRole("button", { name: "Save asset" }).click();
      await expect(form.getByRole("alert")).toContainText("Asset could not be saved");
      await expect(form.getByLabel("Asset Name")).toHaveValue("Form Test Hose edited");
      await form.getByRole("button", { name: "Save asset" }).click();
      await expect(page.getByRole("status").filter({ hasText: "saved successfully" })).toBeVisible();
      await expect(form).toHaveCount(0);

      // Saved, reloaded, deep-linked: the edit persisted and the address is exact.
      await page.goto(deepLink);
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toContainText("Form Test Hose edited");
      expect(here(page)).toBe(deepLink);

      // A saved form leaves no unload prompt behind.
      const prompted = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prompted).toBe(false);
    } finally {
      await admin.context.close();
    }
  });

  test("asset: create validates, keeps the work, and fits every width", async ({ browser }) => {
    test.setTimeout(240_000);
    prepare();
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/?view=assets");
      await page.getByRole("button", { name: "Add asset" }).click();
      const form = page.getByRole("form", { name: "Add asset" });
      await expect(form).toBeVisible();
      await chooseOption(form.getByLabel("Agent"), { label: "Vopak" });
      await form.getByRole("button", { name: "Save asset" }).click();
      await expect(form.getByLabel("Asset Name")).toBeFocused();
      await form.getByRole("button", { name: "Serial Number" }).click();
      await expect(form.getByLabel("Serial Number")).toBeFocused();

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        const box = await form.boundingBox();
        expect(box && box.x + box.width <= width + 1).toBe(true);
        await expect(form.getByRole("button", { name: "Save asset" })).toBeInViewport();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      const name = `E2E Form Create ${Date.now()}`;
      await form.getByLabel("Asset Name").fill(name);
      await form.getByLabel("Serial Number").fill(`SN-${Date.now()}`);
      await form.getByRole("button", { name: "Save asset" }).click();
      await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toContainText(name);
      await expect(form).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });

  test("asset: the whole edit works from the keyboard", async ({ browser }) => {
    test.setTimeout(240_000);
    prepare();
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(`/?view=assets&asset=${ASSET}`);
      const edit = page.getByRole("complementary", { name: "Asset detail" }).getByRole("button", { name: "Edit" });
      await edit.focus();
      await page.keyboard.press("Enter");
      const form = page.getByRole("form", { name: "Edit asset" });
      await expect(form.getByLabel("Agent")).toBeFocused(); // focus moved into the form
      await page.keyboard.press("Tab");
      await expect(form.getByLabel("Location")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(form.getByLabel("Asset Name")).toBeFocused(); // logical order
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("Keyboard hose");

      // Escape asks; the safe answer is focused first; keeping returns to where the person was.
      await page.keyboard.press("Escape");
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discard.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(discard).toHaveCount(0);
      await expect(form.getByLabel("Asset Name")).toBeFocused();
      await expect(form.getByLabel("Asset Name")).toHaveValue("Keyboard hose");

      // Tab stays inside the form, and Enter saves.
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Tab");
        expect(await form.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      }
      await form.getByLabel("Asset Name").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "saved successfully" })).toBeVisible();
      await expect(form).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });

  test("user: create, edit, protect unsaved work, and routing survives Back/Forward", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const stamp = Date.now();
    const email = `form.${stamp}@example.test`;
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true }).click();
      await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();

      // Create: validation, then correction, then success.
      await page.getByRole("button", { name: "Add user" }).click();
      const create = page.getByRole("dialog", { name: "Add user" });
      await create.getByRole("button", { name: "Create user" }).click();
      await expect(create.getByLabel("Email")).toBeFocused();
      await create.getByRole("button", { name: "Last name" }).click();
      await expect(create.getByLabel("Last name")).toBeFocused();
      await create.getByLabel("Email").fill(email);
      await create.getByLabel("First name").fill("Formy");
      await create.getByLabel("Last name").fill("Person");
      await create.getByRole("button", { name: "Create user" }).click();
      await expect(page.getByTestId("credential-value")).toBeVisible();
      await page.getByRole("button", { name: "Done" }).click();

      // Edit: find them by email, change name and role.
      await page.getByRole("searchbox", { name: "Search users" }).fill(email);
      await expect(page.getByRole("row", { name: new RegExp(email) })).toBeVisible();
      // The search reaches the address after a short pause; capture it only once it has.
      await expect(page).toHaveURL(/[?&]q=form\./);
      const listUrl = here(page);
      await page.getByRole("button", { name: `Manage ${email}` }).click();
      await page.getByRole("menuitem", { name: "Edit user" }).click();
      const edit = page.getByRole("dialog", { name: "Edit user" });
      await expect(edit.getByLabel("First name")).toHaveValue("Formy");
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(edit.getByRole("button", { name: "Save changes" })).toBeInViewport();
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await edit.getByRole("button", { name: "Cancel" }).click();
      await expect(edit).toHaveCount(0); // clean: immediate

      await page.getByRole("button", { name: `Manage ${email}` }).click();
      await page.getByRole("menuitem", { name: "Edit user" }).click();
      await edit.getByLabel("First name").fill("Formal");
      await chooseOption(edit.getByLabel("Role"), "REVIEWER");
      await expect(edit.getByText("Unsaved changes")).toBeVisible();

      await page.keyboard.press("Escape");
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(edit.getByLabel("First name")).toHaveValue("Formal");

      await page.goBack();
      await expect(discard).toBeVisible();
      expect(here(page)).toBe(listUrl);
      await discard.getByRole("button", { name: "Keep editing" }).click();

      await failOnce(page, /\/api\/v1\/admin\/users\/[^/]+$/, "PATCH", 500, { error: { code: "internal", message: "Internal server error", details: null } });
      await failOnce(page, /\/api\/v1\/admin\/users\/[^/]+$/, "PUT", 500, { error: { code: "internal", message: "Internal server error", details: null } });
      await edit.getByRole("button", { name: "Save changes" }).click();
      await expect(edit.getByRole("alert")).toContainText("User not updated");
      await expect(edit.getByLabel("First name")).toHaveValue("Formal");
      await expect(edit.getByLabel("Role")).toHaveText("Reviewer");
      await edit.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("status").filter({ hasText: "updated successfully" })).toBeVisible();
      await expect(edit).toHaveCount(0);

      // The name is the identity; the row, the route and Back/Forward all agree.
      const row = page.getByRole("row", { name: new RegExp(email) });
      await expect(row).toContainText("Formal Person");
      await expect(row).toContainText(/reviewer/i);
      expect(here(page)).toBe(listUrl);
      await page.goBack();
      await page.goForward();
      await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });
});
