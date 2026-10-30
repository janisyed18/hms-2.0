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

const conflict = {
  error: { code: "conflict", message: "Serial number is already assigned to another asset.", details: null }
};

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

test.describe("Staff interaction feedback", () => {
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

  test("asset: validation, server failure keeps the work, success, then archive failure and success", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    const name = `E2E Feedback Hose ${Date.now()}`;
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Assets", exact: true }).click();
      await page.getByRole("button", { name: "Add Asset" }).click();
      await expect(page.getByRole("heading", { name: "Add Asset" })).toBeVisible();

      // Required fields are marked, and an empty save explains itself and focuses the first gap.
      await expect(page.getByText("* Required fields")).toBeVisible();
      // Choose an agent that has a site, so the first gap is the asset name.
      await chooseOption(page.getByLabel("Agent"), { label: "Vopak" });
      await expect(page.getByLabel("Location")).not.toHaveText("Select location");
      await page.getByRole("button", { name: "Save asset" }).click();
      await expect(page.getByLabel("Asset Name")).toBeFocused();
      await expect(page.getByLabel("Asset Name")).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("Enter an asset name.")).toBeVisible();
      await expect(page.getByText("Enter a serial number.")).toBeVisible();

      // A server refusal keeps the drawer and the typed values, and says why.
      await page.getByLabel("Asset Name").fill(name);
      await page.getByLabel("Serial Number").fill(`SN-${Date.now()}`);
      await failOnce(page, /\/api\/v1\/assets$/, "POST", 409, conflict);
      await page.getByRole("button", { name: "Save asset" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Asset could not be saved" });
      await expect(alert).toContainText("Serial number is already assigned to another asset.");
      await expect(page.getByRole("heading", { name: "Add Asset" })).toBeVisible();
      await expect(page.getByLabel("Asset Name")).toHaveValue(name);

      // Saving again works: success is announced, the drawer closes.
      await page.getByRole("button", { name: "Save asset" }).click();
      const success = page.getByRole("status").filter({ hasText: "created successfully" });
      await expect(success).toContainText(name);
      await expect(page.getByRole("heading", { name: "Add Asset" })).toHaveCount(0);

      // Archiving asks first, by name and HMS number; a failed archive leaves everything in place.
      await page.getByPlaceholder("Search assets...").fill(name);
      const row = page.getByRole("row", { name: new RegExp(name) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Archive" }).click();
      const dialog = page.getByRole("alertdialog", { name: new RegExp(`Archive ${name} — .+\\?`) });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await failOnce(page, /\/api\/v1\/assets\/[^/]+$/, "DELETE", 500, { error: { code: "internal", message: "Internal server error", details: null } });
      await dialog.getByRole("button", { name: "Archive asset" }).click();
      await expect(dialog.getByRole("alert")).toContainText(/service is unavailable/i);
      await expect(dialog).toBeVisible();
      await expect(row).toBeVisible();

      await dialog.getByRole("button", { name: "Archive asset" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was archived" })).toContainText(name);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(row).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });

  test("product: the same foundation, in another workspace", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    const code = `E2E-${Date.now()}`.slice(0, 20);
    const form = page.locator("form.customer-drawer");
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Products", exact: true }).click();
      await page.getByRole("button", { name: "Add Product" }).click();
      await page.getByRole("button", { name: "Save product" }).click();
      await expect(form.getByLabel("Product code")).toBeFocused();
      await expect(page.getByText("Enter a product code.")).toBeVisible();

      await form.getByLabel("Product code").fill(code);
      await form.getByLabel("Product name").fill("E2E Feedback Product");
      await form.getByLabel("Category", { exact: true }).fill("E2E");
      await failOnce(page, /\/api\/v1\/products$/, "POST", 500, { error: { code: "internal", message: "psycopg.errors.UniqueViolation", details: null } });
      await page.getByRole("button", { name: "Save product" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Product could not be saved" });
      await expect(alert).toContainText(/service is unavailable/i);
      await expect(alert).not.toContainText("psycopg");
      await expect(form.getByLabel("Product name")).toHaveValue("E2E Feedback Product");

      await page.getByRole("button", { name: "Save product" }).click();
      await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toContainText("E2E Feedback Product");

      await page.getByRole("button", { name: "Archive E2E Feedback Product" }).click();
      const dialog = page.getByRole("alertdialog", { name: /Archive E2E Feedback Product — /i });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Archive E2E Feedback Product" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive product" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was archived" })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });
});
