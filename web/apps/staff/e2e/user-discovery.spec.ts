import { expect, test, type Page } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

async function openUsers(page: Page) {
  const link = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true });
  if (!(await link.isVisible())) await page.getByRole("button", { name: /menu|navigation/i }).first().click();
  await link.click();
  await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
}

test.describe("User discovery and real-name identity", () => {
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

  test("search, role filter and clear find a real person by name; creating one needs both names", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const stamp = Date.now();
    const last = `Zq${stamp}`;
    const email = `zq.${stamp}@example.test`;
    try {
      // An account that only has an email is greeted without reading the address out.
      const greeting = page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ });
      await expect(greeting).toBeVisible();
      expect(await greeting.innerText()).not.toContain("@");

      await openUsers(page);
      // Legacy accounts with no name stay readable: a placeholder, then the email.
      await expect(page.getByRole("row", { name: /assembly@example\.test/ })).toContainText("Name not set");

      // Creating a user needs a first and a last name, and the first gap takes focus.
      await page.getByRole("button", { name: "Add User" }).click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("Email")).toBeFocused();
      await expect(dialog.getByLabel("First name")).toHaveAccessibleDescription("Enter the user's first name.");
      await expect(dialog.getByLabel("Last name")).toHaveAccessibleDescription("Enter the user's last name.");
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("First name")).toBeFocused();
      await dialog.getByLabel("First name").fill("Quincy");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("Last name")).toBeFocused();
      await dialog.getByLabel("Last name").fill(last);
      await dialog.getByLabel("Role").selectOption("REVIEWER");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await page.getByRole("button", { name: "Done" }).click();

      // Search finds them by last name; the table shows the name first and the email second.
      await page.getByLabel("Search users").fill(last);
      const row = page.getByRole("row", { name: new RegExp(email.replace(/\./g, "\\.")) });
      await expect(row).toHaveCount(1);
      await expect(row.locator("td").first().locator("strong")).toHaveText(`Quincy ${last}`);
      await expect(row.locator("td").first().locator("small")).toHaveText(email);
      await expect(page.getByText("1 user matches these filters.")).toBeVisible();

      // A role filter composes with the search: Inspector excludes a Reviewer.
      await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("INSPECTOR");
      await expect(page.getByText("No users match these filters")).toBeVisible();
      await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("REVIEWER");
      await expect(row).toHaveCount(1);

      // Clear filters restores the whole directory.
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await expect(page.getByLabel("Search users")).toHaveValue("");
      await expect(page.getByRole("combobox", { name: "Role", exact: true })).toHaveValue("");
      await expect(page.getByRole("row", { name: /assembly@example\.test/ })).toBeVisible();
      await expect(page.getByText(/users? match(es)? these filters/)).toHaveCount(0);

      // The directory-wide counts are server counts, not what happens to be on the page.
      const reviewers = page.getByText("Reviewer Seats").locator("..");
      await expect(reviewers).toContainText(/[1-9]/);
    } finally {
      await admin.context.close();
    }
  });

  test("the filters stay usable and the page does not scroll sideways from desktop to phone width", async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      for (const [width, height] of [[1440, 900], [1024, 800], [768, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.reload();
        await openUsers(page);
        for (const label of ["Search users", "Role", "Account status", "MFA", "Sort by"]) {
          const control = label === "Search users" ? page.getByRole("searchbox", { name: label }) : page.getByRole("combobox", { name: label, exact: true });
          await control.scrollIntoViewIfNeeded();
          await expect(control, `${label} at ${width}px`).toBeVisible();
          const box = await control.boundingBox();
          expect(box && box.x >= 0 && box.x + box.width <= width, `${label} inside ${width}px`).toBe(true);
        }
        await page.getByLabel("Search users").fill("assembly");
        await expect(page.getByRole("row", { name: /assembly@example\.test/ })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no sideways scroll at ${width}px`).toBe(true);
        await page.getByRole("button", { name: "Clear filters" }).first().click();
      }
    } finally {
      await admin.context.close();
    }
  });
});
