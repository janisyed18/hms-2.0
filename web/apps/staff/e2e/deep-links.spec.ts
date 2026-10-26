import { expect, test, type Page, type Request } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  completeLogin,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

async function nav(page: Page, name: string) {
  const link = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name, exact: true });
  if (!(await link.isVisible())) await page.getByRole("button", { name: /menu|navigation/i }).first().click();
  await link.click();
}

test.describe("shared URL and deep-link routing", () => {
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

  test("a Users link opens with its controls set and the server asked exactly that; Back and Forward restore it", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      const requests: string[] = [];
      page.on("request", (request: Request) => {
        if (request.url().includes("/api/v1/admin/users?")) requests.push(new URL(request.url()).search);
      });

      // Straight to a deep URL, not clicked into from the dashboard.
      await page.goto("/?view=users&role=INSPECTOR&status=ACTIVE&sort=name&page=1");
      await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Role", exact: true })).toHaveValue("INSPECTOR");
      await expect(page.getByRole("combobox", { name: "Account status" })).toHaveValue("ACTIVE");
      await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("name");
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      const query = new URLSearchParams(requests[0]);
      expect(Object.fromEntries(query)).toMatchObject({ role: "INSPECTOR", account_status: "ACTIVE", sort: "name", limit: "10", offset: "0" });
      expect(here(page)).toBe("/?view=users&role=INSPECTOR&status=ACTIVE"); // canonical: defaults left out

      // Unknown and invalid parameters never break it, and are cleaned out of the address.
      await page.goto("/?view=users&status=BOGUS&page=-4&sort=password&utm_source=x&unknown=1");
      await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
      await expect.poll(() => here(page)).toBe("/?view=users");

      // Filter, page, another view, then Back twice unwinds exactly those steps.
      await page.getByRole("combobox", { name: "User access records rows per page" }).selectOption("5");
      await expect.poll(() => here(page)).toBe("/?view=users&page_size=5");
      await page.getByRole("button", { name: "User access records page 2" }).click();
      await expect.poll(() => here(page)).toBe("/?view=users&page=2&page_size=5");
      await nav(page, "Assets");
      await expect.poll(() => here(page)).toBe("/?view=assets");

      await page.goBack();
      await expect.poll(() => here(page)).toBe("/?view=users&page=2&page_size=5");
      await expect(page.getByRole("combobox", { name: "User access records rows per page" })).toHaveValue("5");
      await expect(page.getByText("Page 2 of")).toBeVisible();
      await page.goBack();
      await expect.poll(() => here(page)).toBe("/?view=users&page_size=5");
      await expect(page.getByText("Page 1 of")).toBeVisible();
      await page.goForward();
      await expect.poll(() => here(page)).toBe("/?view=users&page=2&page_size=5");

      // Typing in the search box replaces one history entry instead of adding one per letter.
      const entries = await page.evaluate(() => window.history.length);
      await page.getByRole("searchbox", { name: "Search users" }).fill("hms");
      await expect.poll(() => here(page)).toBe("/?view=users&q=hms&page_size=5");
      expect(await page.evaluate(() => window.history.length)).toBe(entries);
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await expect.poll(() => here(page)).toBe("/?view=users&page_size=5");
    } finally {
      await admin.context.close();
    }
  });

  test("an asset, an inspection and a customer reopen from their links, also after a reload", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      await nav(page, "Assets");
      await page.locator("tr.is-clickable").first().click();
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toBeVisible();
      await expect.poll(() => here(page)).toMatch(/^\/\?view=assets&asset=[\w-]+$/);
      const assetLink = here(page);
      const assetName = await page.getByRole("complementary", { name: "Asset detail" }).locator("h2, h1").first().innerText();
      await page.goto(assetLink);
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toContainText(assetName);
      await page.reload();
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toContainText(assetName);
      await page.getByRole("button", { name: "Close asset detail" }).click();
      await expect.poll(() => here(page)).toBe("/?view=assets");
      await page.goBack();
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toBeVisible();

      // A link to an asset that is not there shows nothing of it and stops naming it.
      await page.goto("/?view=assets&asset=00000000-0000-0000-0000-000000000000");
      await expect(page.getByText("The selected asset could not be opened.")).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Asset detail" })).toHaveCount(0);
      await expect.poll(() => here(page)).toBe("/?view=assets");

      await nav(page, "Inspections");
      await expect(page.getByRole("table", { name: "Inspection records" })).toBeVisible();
      await page.getByRole("table", { name: "Inspection records" }).locator("tr.is-clickable").first().click();
      await expect(page.getByRole("complementary", { name: "Inspection detail" })).toBeVisible();
      await expect.poll(() => here(page)).toMatch(/^\/\?view=inspections&inspection=[\w-]+$/);
      const inspectionLink = here(page);
      await page.goto(inspectionLink);
      await expect(page.getByRole("complementary", { name: "Inspection detail" })).toBeVisible();

      await nav(page, "Customers");
      await page.locator("button.customer-card").first().click();
      await expect.poll(() => here(page)).toMatch(/^\/\?view=customers&customer=[\w-]+$/);
      const customerLink = here(page);
      await page.goto(customerLink);
      await expect(page.getByRole("tablist", { name: "Customer detail tabs" })).toBeVisible();
      await page.goto("/?view=customers&customer=00000000-0000-0000-0000-000000000000");
      await expect(page.getByRole("alert").filter({ hasText: "Customer unavailable" })).toBeVisible();
      await expect.poll(() => here(page)).toBe("/?view=customers");
    } finally {
      await admin.context.close();
    }
  });

  test("a view the account may not open never appears, even from a link", async ({ browser }) => {
    test.setTimeout(120_000);
    const inspector = await signedInPage(browser, "inspector@example.test", permanentPasswords.inspector);
    const page = inspector.page;
    page.setDefaultTimeout(20_000);
    try {
      // Not even a request for the directory is made while the link is being corrected.
      const directoryRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v1/admin/users")) directoryRequests.push(request.url());
      });
      await page.goto("/?view=users&role=INSPECTOR");
      // The workspace the account does have opens instead (an inspector's dashboard says it is not for them).
      await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
      await expect(page.getByText("Dashboard is not available to inspectors")).toBeVisible();
      await expect(page.getByRole("button", { name: "Users & Roles" })).toHaveCount(0);
      expect(directoryRequests).toEqual([]);
      await expect(page.getByRole("heading", { name: "User Directory" })).toHaveCount(0);
      await expect.poll(() => here(page)).toBe("/");
    } finally {
      await inspector.context.close();
    }
  });

  test("a deep link survives signing in and opens where it pointed", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    try {
      // The usual login (password change, authenticator), but starting from the link instead of "/".
      await completeLogin(page, "hms.admin@example.test", permanentPasswords.admin, "/?view=users&status=ACTIVE");
      await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Account status" })).toHaveValue("ACTIVE");
      expect(here(page)).toBe("/?view=users&status=ACTIVE");
    } finally {
      await context.close();
    }
  });

  test("direct links at every width open without sideways scrolling and without request loops", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      const directory: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v1/admin/users?")) directory.push(request.url());
      });
      for (const [width, height] of [[1440, 900], [1024, 800], [768, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        directory.length = 0;
        await page.goto("/?view=users&role=INSPECTOR&status=ACTIVE&sort=email");
        await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("email");
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `sideways scroll at ${width}px`).toBe(true);
        // One navigation, one request: nothing in the URL/state sync asks again.
        expect(directory, `requests at ${width}px`).toHaveLength(1);
        await page.reload();
        await expect(page.getByRole("combobox", { name: "Role", exact: true })).toHaveValue("INSPECTOR");
        expect(here(page)).toBe("/?view=users&role=INSPECTOR&status=ACTIVE&sort=email");
      }
    } finally {
      await admin.context.close();
    }
  });
});
