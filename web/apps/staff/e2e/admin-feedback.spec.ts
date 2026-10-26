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

/** Fail the next request matching `url` with `status`, then let later ones through untouched. */
async function failOnce(page: Page, url: RegExp, method: string, status: number, message: string) {
  let failed = false;
  await page.route(url, async (route: Route) => {
    if (!failed && route.request().method() === method) {
      failed = true;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "error", message, details: null } }) });
      return;
    }
    await route.fallback();
  });
}
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name, exact: true }).click();

test.describe("Admin and security interaction feedback", () => {
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

  test("user administration: validation, refusal keeps the dialog, confirmed security actions fail safely then succeed", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    // A step that cannot find its target should fail with that step named, not hold the run until the test timeout.
    page.setDefaultTimeout(15_000);
    const email = `e2e.feedback.${Date.now()}@example.test`;
    try {
      await nav(page, "Users & Roles");
      await page.getByRole("button", { name: "Add User" }).click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await expect(dialog.getByText("* Required fields")).toBeVisible();
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("Email")).toBeFocused();
      await expect(dialog.getByText("Enter the user's email address.")).toBeVisible();

      // A refused create keeps the dialog and the typed values, and explains why on the field.
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByLabel("First name").fill("Feedback");
      await dialog.getByLabel("Last name").fill("Person");
      await failOnce(page, /\/api\/v1\/admin\/users$/, "POST", 409, "A user with this email already exists.");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByRole("alert")).toContainText("A user with this email already exists.");
      await expect(dialog.getByLabel("First name")).toHaveValue("Feedback");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(page.getByTestId("credential-value")).toBeVisible();
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toContainText(email);

      // Security actions ask first, name the person, and a failure changes nothing.
      // The directory is sorted by name and paged by the server, so find the new user by their email.
      await page.getByRole("searchbox", { name: "Search users" }).fill(email);
      const row = page.getByRole("row", { name: new RegExp(email) });
      await expect(row).toBeVisible();
      await page.getByRole("button", { name: `Manage ${email}` }).click();
      await page.getByRole("menuitem", { name: "Disable account" }).click();
      const confirm = page.getByRole("alertdialog", { name: new RegExp(`Disable .*${email.replace(/\./g, "\\.")}`) });
      await failOnce(page, /\/api\/v1\/admin\/users\/[^/]+\/disable$/, "POST", 500, "Internal server error");
      await confirm.getByRole("button", { name: "Disable account" }).click();
      await expect(confirm.getByRole("alert")).toContainText(/service is unavailable/i);
      await expect(row).toContainText("ACTIVE");
      await confirm.getByRole("button", { name: "Disable account" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was disabled" })).toBeVisible();
      await expect(row).toContainText("DISABLED");

      // MFA reset: refused for permission first (nothing changes), then confirmed.
      await page.getByRole("button", { name: `Manage ${email}` }).click();
      await page.getByRole("menuitem", { name: "Reset MFA" }).click();
      const mfa = page.getByRole("alertdialog", { name: /Reset MFA for/ });
      await failOnce(page, /\/api\/v1\/admin\/users\/[^/]+\/mfa-reset$/, "POST", 403, "Missing permission: user:admin");
      await mfa.getByRole("button", { name: "Reset MFA" }).click();
      await expect(mfa.getByRole("alert")).toContainText("You do not have permission to do this.");
      await expect(mfa.getByRole("alert")).not.toContainText("user:admin");
      await mfa.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);

      // Password reset: the temporary password appears only after the server issues it.
      await page.getByRole("button", { name: `Manage ${email}` }).click();
      await page.getByRole("menuitem", { name: "Reset password" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Reset password" }).click();
      await expect(page.getByTestId("credential-value")).toBeVisible();
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("status").filter({ hasText: "had their password reset" })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });

  test("devices: revoke asks first and a failure keeps the device allowed; notifications stay unread when marking fails", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    // A step that cannot find its target should fail with that step named, not hold the run until the test timeout.
    page.setDefaultTimeout(15_000);
    try {
      // The seed has no devices, so present one and let the PATCH go through a controlled route.
      const device = { device_id: "dev-0123", user_id: "u1", platform: "ios", app_version: "1.0", last_sync_at: null, offline_window_days: 3, revoked: false };
      await page.route(/\/api\/v1\/admin\/devices(\?.*)?$/, (route) => route.fulfill({ json: { total: 1, limit: 50, offset: 0, items: [device] } }));
      let attempts = 0;
      await page.route(/\/api\/v1\/admin\/devices\/dev-0123$/, async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Internal server error", details: null } }) });
          return;
        }
        await route.fulfill({ json: { ...device, revoked: true } });
      });
      await nav(page, "Devices");
      await page.getByRole("button", { name: /Revoke dev-0123/ }).click();
      const confirm = page.getByRole("alertdialog", { name: "Revoke dev-0123?" });
      await confirm.getByRole("button", { name: "Revoke device" }).click();
      await expect(confirm.getByRole("alert")).toContainText(/service is unavailable/i);
      await expect(page.getByRole("button", { name: /Revoke dev-0123/ })).toBeVisible(); // still not revoked
      await confirm.getByRole("button", { name: "Revoke device" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was revoked" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Restore dev-0123/ })).toBeVisible();

      // Notifications: a failed mark-read leaves it unread, keeps the menu open and says why.
      // A fresh database has no unread notification, so present one; only the read call is the subject.
      const note = { id: "n-1", category: "inspection", tier: "info", subject: "Inspection submitted", body: "An inspection is ready for review.", customer_id: null, asset_id: null, created_at: new Date().toISOString(), read_at: null };
      await page.route(/\/api\/v1\/notifications\/me(\?.*)?$/, (route) => route.fulfill({ json: { total: 1, unread_total: 1, limit: 12, offset: 0, items: [note] } }));
      await failOnce(page, /\/api\/v1\/notifications\/[^/]+\/read$/, "POST", 500, "Internal server error");
      await page.getByRole("button", { name: "Notifications" }).click();
      const feed = page.getByRole("dialog", { name: "Notifications" });
      const unread = feed.getByRole("button", { name: /Open unread notification/ }).first();
      await expect(unread).toBeVisible();
      await unread.click();
      await expect(feed.getByRole("alert")).toContainText(/service is unavailable/i);
      await expect(feed.getByRole("button", { name: /Open unread notification/ }).first()).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });
  test("the row action menu is fully reachable on the last row at desktop and phone width", async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    // A step that cannot find its target should fail with that step named, not hold the run until the test timeout.
    page.setDefaultTimeout(15_000);
    try {
      for (const [width, height] of [[1440, 800], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.reload();
        const navigation = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true });
        if (!(await navigation.isVisible())) await page.getByRole("button", { name: /menu|navigation/i }).first().click();
        await navigation.click();
        const manage = page.getByRole("button", { name: /^Manage / });
        await manage.last().scrollIntoViewIfNeeded();
        await manage.last().click();
        // Every item must be inside the viewport and be what a pointer actually reaches.
        const reachable = await page.getByRole("menu").evaluate((menu) =>
          [...menu.querySelectorAll("[role=menuitem]")].every((item) => {
            const r = item.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return r.top >= 0 && r.bottom <= innerHeight && !!hit && menu.contains(hit);
          })
        );
        expect(reachable, `${width}px`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.keyboard.press("Escape");
      }
    } finally {
      await admin.context.close();
    }
  });
});
