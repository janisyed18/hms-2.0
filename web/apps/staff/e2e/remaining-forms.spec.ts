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

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1000], [390, 844]];
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("remaining Staff forms on the shared form system", () => {
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

  test("product: validate, create, edit, protect unsaved work, stay usable at every width", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const code = `E2E${Date.now().toString().slice(-8)}`;
    try {
      await page.goto("/?view=products");
      await page.getByRole("button", { name: "Add Product" }).first().click();
      const create = page.getByRole("form", { name: "Add Product" });
      await expect(create).toBeVisible();
      await expect(create.getByText("Unsaved changes")).toHaveCount(0);

      // Validation: nothing is sent, the first gap takes focus and the summary lists what to fix.
      await create.getByRole("button", { name: "Save product" }).click();
      await expect(create.getByLabel("Product code")).toBeFocused();
      await expect(create.getByRole("navigation", { name: "Fields to correct" })).toBeVisible();

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(create.getByRole("button", { name: "Save product" })).toBeInViewport();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await create.getByLabel("Product code").fill(code);
      await create.getByLabel("Product name").fill("E2E remaining-forms hose");
      await create.getByLabel("Category", { exact: true }).fill("Hose");
      await expect(create.getByText("Unsaved changes")).toBeVisible();

      // Dirty Cancel and Escape ask; Keep editing loses nothing.
      await create.getByRole("button", { name: "Cancel" }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(create.getByLabel("Product name")).toHaveValue("E2E remaining-forms hose");
      await page.keyboard.press("Escape");
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();

      await create.getByRole("button", { name: "Save product" }).click();
      await expect(page.getByRole("status").filter({ hasText: /saved successfully|created successfully/i })).toBeVisible();
      await expect(create).toHaveCount(0);

      // Edit: opens clean; an edit then Discard leaves the record unchanged.
      await page.getByLabel("Search products").fill(code);
      const row = page.getByRole("row", { name: new RegExp(code) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Edit" }).click();
      const edit = page.getByRole("form", { name: "Edit Product" });
      await expect(edit.getByLabel("Product name")).toHaveValue("E2E remaining-forms hose");
      await expect(edit.getByText("Unsaved changes")).toHaveCount(0);
      await edit.getByLabel("Product name").fill("Changed then discarded");
      await edit.getByRole("button", { name: "Cancel" }).click();
      await discard.getByRole("button", { name: "Discard changes" }).click();
      await expect(edit).toHaveCount(0);
      await expect(row).toContainText("E2E remaining-forms hose");
    } finally {
      await admin.context.close();
    }
  });

  test("customer: validate, protect unsaved work, and fit every width", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/?view=customers");
      await page.getByRole("button", { name: "Add Customer" }).first().click();
      const form = page.getByRole("form", { name: "Add Customer" });
      await expect(form).toBeVisible();

      await form.getByRole("button", { name: "Save customer" }).click();
      await expect(form.getByLabel("Name", { exact: true })).toBeFocused();
      await expect(form.getByRole("navigation", { name: "Fields to correct" })).toBeVisible();

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(form.getByRole("button", { name: "Save customer" })).toBeInViewport();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await form.getByLabel("Name", { exact: true }).fill("Unsaved Customer");
      await form.getByRole("button", { name: "Cancel" }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Unsaved Customer");
      await form.getByRole("button", { name: "Cancel" }).click();
      await discard.getByRole("button", { name: "Discard changes" }).click();
      await expect(form).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });
});
