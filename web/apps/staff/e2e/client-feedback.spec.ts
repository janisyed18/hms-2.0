import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

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
const ASSET_NUMBER = `E2E-IDENT-${STAMP}`;
const ASSET_NAME = "High Pressure Chemical Transfer Hose Assembly 04";
const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1000], [390, 844]];
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

function sql(command: string): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();
}

/** First two words' first letters: the rule under test, written out independently of the app's helper. */
function expectedInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

test.describe("client feedback: customer counts and asset identity", () => {
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
    sql(`DELETE FROM assets WHERE asset_number = '${ASSET_NUMBER}';`);
  });

  test("a customer's asset count follows an asset created while Customers was not open, and survives a reload", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    try {
      await nav.getByRole("button", { name: "Customers", exact: true }).click();
      const card = page.getByRole("button", { name: /Select customer Vopak/ }).first();
      await expect(card).toBeVisible();
      const before = Number((await card.textContent())?.match(/(\d+)\s*Assets/)?.[1]);
      expect(Number.isFinite(before)).toBe(true);
      const customerName = (await card.locator(".customer-name").textContent())?.trim() ?? "Vopak";

      // Leave Customers, then an asset appears (made through the API, as the Assets form would).
      await nav.getByRole("button", { name: "Assets", exact: true }).click();
      const created = await page.evaluate(async ({ number, name }) => {
        const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
        const { access_token: token } = await refresh.json() as { access_token: string };
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const customers = await (await fetch("/api/v1/customers?limit=100", { headers })).json() as {
          items: Array<{ id: string; name: string; locations: Array<{ id: string }> }>;
        };
        const target = customers.items.find((item) => item.name.startsWith("Vopak") && item.locations.length > 0)!;
        const products = await (await fetch("/api/v1/products?limit=1", { headers })).json() as { items: Array<{ id: string }> };
        const response = await fetch("/api/v1/assets", {
          method: "POST",
          headers,
          body: JSON.stringify({ customer_id: target.id, location_id: target.locations[0].id, product_id: products.items[0].id, asset_number: number, asset_name: name })
        });
        return { status: response.status };
      }, { number: ASSET_NUMBER, name: ASSET_NAME });
      expect(created.status).toBe(201);

      await nav.getByRole("button", { name: "Customers", exact: true }).click();
      const refreshedCard = page.getByRole("button", { name: new RegExp(`Select customer ${customerName}`) }).first();
      await expect(refreshedCard).toContainText(new RegExp(`${before + 1}\\s*Assets`));

      // The detail agrees with the card, and lists the asset by name with its number.
      await refreshedCard.click();
      await expect(page.getByLabel("Customer asset summary")).toContainText(new RegExp(`Assets\\s*${before + 1}`));
      const link = page.getByRole("button", { name: `Open asset ${ASSET_NAME}, ${ASSET_NUMBER}` });
      await expect(link).toBeVisible();
      await expect(link).toContainText(`Asset #${ASSET_NUMBER}`);

      // A hard reload reads the same figure.
      // The address names the open customer, so the reload comes back to Customers by itself.
      await page.reload();
      await expect(page.getByRole("button", { name: new RegExp(`Select customer ${customerName}`) }).first())
        .toContainText(new RegExp(`${before + 1}\\s*Assets`));
    } finally {
      await admin.context.close();
    }
  });

  test("Staff: the register names the asset first, finds it by number or name, and holds at every width", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Assets", exact: true }).click();
      const search = page.getByLabel("Search assets", { exact: true });
      for (const query of [ASSET_NUMBER.toLowerCase(), "chemical transfer"]) {
        await search.fill(query);
        const row = page.getByRole("row").filter({ hasText: ASSET_NUMBER });
        await expect(row).toHaveCount(1);
        await expect(row.locator(".asset-identity-name")).toHaveText(ASSET_NAME);
        await expect(row.locator(".asset-identity-number")).toHaveText(`Asset #${ASSET_NUMBER}`);
      }
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(page.locator(".asset-identity-name").filter({ hasText: ASSET_NAME })).toBeVisible();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // Detail: the name is the title, the number is the first thing under it.
      await page.getByRole("row").filter({ hasText: ASSET_NUMBER }).locator(".asset-identity-name").click();
      const detail = page.getByRole("complementary", { name: "Asset detail" });
      await expect(detail.getByRole("heading", { name: ASSET_NAME, level: 2 })).toBeVisible();
      await expect(detail).toContainText(`Asset #${ASSET_NUMBER}`);
    } finally {
      await admin.context.close();
    }
  });

  test("Portal: the company avatar carries its initials and assets are named first at every width", async ({ browser }) => {
    test.setTimeout(240_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const page = customer.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/portal/");
      const header = page.locator(".customer-portal-context");
      await expect(header).toBeVisible();
      const company = (await header.locator("strong").first().textContent())?.trim() ?? "";
      await expect(header.locator(".customer-avatar")).toHaveText(expectedInitials(company));
      await expect(header.locator(".customer-avatar")).toHaveAttribute("aria-hidden", "true");

      // Switching organisation switches the avatar with it.
      await page.getByLabel("Organisation").selectOption({ label: "Vopak" });
      await expect(header.locator("strong").first()).toHaveText("Vopak");
      await expect(header.locator(".customer-avatar")).toHaveText("V");

      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Assets", exact: true }).click();
      await page.getByLabel("Search assets", { exact: true }).fill(ASSET_NUMBER);
      const item = page.locator(".portal-record-button").filter({ hasText: ASSET_NUMBER });
      await expect(item.locator(".asset-identity-name")).toHaveText(ASSET_NAME);
      await expect(item.locator(".asset-identity-number")).toHaveText(`Asset #${ASSET_NUMBER}`);
      await page.getByLabel("Search assets", { exact: true }).fill("chemical transfer hose");
      await expect(item).toHaveCount(1);

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(item.locator(".asset-identity-name")).toBeVisible();
        await expect(header.locator(".customer-avatar")).toBeVisible();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await item.click();
      await expect(page.getByRole("heading", { name: ASSET_NAME, level: 2 })).toBeVisible();
      await expect(page.getByText(new RegExp(`Asset #${ASSET_NUMBER}`))).toBeVisible();
    } finally {
      await customer.context.close();
    }
  });
});
