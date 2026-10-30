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

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const insideViewport = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    return Boolean(rect) && rect!.left >= 0 && rect!.right <= innerWidth + 1 && rect!.top >= 0 && rect!.bottom <= innerHeight + 1;
  }, selector);

test.describe("shared controls and success feedback", () => {
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

  test("a saved record is confirmed in a toast that outlives the drawer and goes by itself", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const code = `VIS${Date.now().toString().slice(-8)}`;
    try {
      await page.goto("/?view=products");
      await page.getByRole("button", { name: "Add product" }).first().click();
      const form = page.getByRole("form", { name: "Add product" });
      await form.getByLabel("Product code").fill(code);
      await form.getByLabel("Product name").fill("Toast check hose");
      await form.getByLabel("Category", { exact: true }).fill("Hose");
      await form.getByRole("button", { name: "Save product" }).click();

      const toast = page.locator(".toast").filter({ hasText: "created successfully" });
      await expect(toast).toBeVisible();
      await expect(form).toHaveCount(0); // the drawer closed; the confirmation did not go with it
      // Moving to another workspace does not take it away either.
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Customers", exact: true }).click();
      await expect(toast).toBeVisible();
      expect(await insideViewport(page, ".toast")).toBe(true);
      await expect(toast).toHaveCount(0, { timeout: 10_000 }); // about four seconds
    } finally {
      await admin.context.close();
    }
  });

  test("the close button dismisses a confirmation, and a failure is never a disappearing toast", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.setViewportSize({ width: 390, height: 844 }); // the phone: the toast must fit here too
      await page.goto("/?view=products");
      await page.getByRole("button", { name: "Add product" }).first().click();
      const form = page.getByRole("form", { name: "Add product" });
      await form.getByLabel("Product code").fill(`VIS${Date.now().toString().slice(-8)}`);
      await form.getByLabel("Product name").fill("Refused hose");
      await form.getByLabel("Category", { exact: true }).fill("Hose");
      await page.route(/\/api\/v1\/products$/, async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Internal server error", details: null } }) });
        } else await route.fallback();
      });
      await form.getByRole("button", { name: "Save product" }).click();
      // The failure stays beside the form, takes focus, and nothing says "success".
      const alert = form.getByRole("alert");
      await expect(alert).toContainText("could not be saved");
      await expect(alert).toBeFocused();
      await expect(page.locator(".toast")).toHaveCount(0);
      await page.unroute(/\/api\/v1\/products$/);
      await form.getByRole("button", { name: "Save product" }).click();
      const toast = page.locator(".toast").filter({ hasText: "created successfully" });
      await expect(toast).toBeVisible();
      expect(await insideViewport(page, ".toast")).toBe(true);
      await toast.getByRole("button", { name: "Dismiss confirmation" }).click();
      await expect(toast).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });

  test("user form: grouped, keyboard-complete Role list, Escape closes the list before the form, focus lands on a server refusal", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Users & Roles", exact: true }).click();
      await page.getByRole("button", { name: "Add user" }).click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await expect(dialog.getByRole("heading", { name: "Identity" })).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Access" })).toBeVisible();

      const role = dialog.getByRole("combobox", { name: "Role" });
      await role.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("listbox", { name: "Role" })).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(role).not.toHaveText("HMS Admin");
      const chosen = (await role.textContent())?.trim() ?? "";

      await role.click();
      await expect(page.getByRole("listbox", { name: "Role" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(dialog).toBeVisible(); // the first Escape only closed the list
      await expect(role).toHaveText(chosen);

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await role.click();
        expect(await insideViewport(page, ".choice-menu")).toBe(true);
        await page.keyboard.press("Escape");
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // Required fields: focus goes to the first gap at once.
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByLabel("Email")).toBeFocused();

      // A server refusal: the message stays, takes focus, and the values are kept.
      await dialog.getByLabel("Email").fill(`visual.${Date.now()}@example.test`);
      await dialog.getByLabel("First name").fill("Vee");
      await dialog.getByLabel("Last name").fill("Sual");
      await page.route(/\/api\/v1\/admin\/users$/, async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Internal server error", details: null } }) });
        } else await route.fallback();
      });
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByRole("alert")).toContainText("User not created");
      await expect(dialog.getByRole("alert")).toBeFocused();
      await expect(dialog.getByLabel("First name")).toHaveValue("Vee");
      await expect(role).toHaveText(chosen);
    } finally {
      await admin.context.close();
    }
  });

  test("asset form: a searchable Agent list that narrows as you type and chooses with Enter", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/?view=assets");
      await page.getByRole("button", { name: "Add asset" }).first().click();
      const form = page.getByRole("form", { name: "Add asset" });
      const agent = form.getByRole("combobox", { name: "Agent" });
      await agent.click();
      const options = page.getByRole("listbox", { name: "Agent" }).getByRole("option");
      expect(await options.count()).toBeGreaterThan(1);
      await agent.fill("vopa");
      await expect(options).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(agent).toHaveValue("Vopak");
      await expect(form).toBeVisible(); // Enter chose; it did not submit
      await expect(form.getByText("Unsaved changes")).toBeVisible();
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(form.getByRole("button", { name: "Save asset" })).toBeInViewport();
      }
    } finally {
      await admin.context.close();
    }
  });
});

test.describe("portal", () => {
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    clearRateLimits();
  });

  test("the dashboard actions read as a hierarchy, and the booking lists work from the keyboard at every width", async ({ browser }) => {
    test.setTimeout(180_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const page = customer.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/portal/");
      const book = page.getByRole("button", { name: "Book inspection" }).first();
      const view = page.getByRole("button", { name: "View assets" }).first();
      await expect(book).toBeVisible();
      const [bookBg, viewBg] = await Promise.all([
        book.evaluate((el) => getComputedStyle(el).backgroundColor),
        view.evaluate((el) => getComputedStyle(el).backgroundColor)
      ]);
      expect(bookBg).not.toBe(viewBg); // the main action is not dressed like the others
      await expect(book).toHaveClass(/primary-button/);
      await expect(view).toHaveClass(/secondary-button/);

      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Bookings", exact: true }).click();
      const location = page.getByRole("combobox", { name: "Booking location" });
      await expect(location).toBeVisible();
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await location.click();
        expect(await insideViewport(page, ".choice-menu")).toBe(true);
        await page.keyboard.press("Escape");
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await location.focus();
      await page.keyboard.press("ArrowDown"); // opens on the current entry
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(location).not.toHaveText("Select a location");
      const asset = page.getByRole("combobox", { name: "Booking asset" });
      await asset.click();
      await expect(page.getByRole("listbox", { name: "Booking asset" }).getByRole("option").first()).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(asset).not.toHaveValue("");
    } finally {
      await customer.context.close();
    }
  });
});
