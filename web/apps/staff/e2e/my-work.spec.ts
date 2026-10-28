import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ASSET = "00000000-0000-7000-8000-0000000000b1";
const INSPECTION = "00000000-0000-7000-8000-0000000000b2";

function sql(statement: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-c", statement],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

function prepare() {
  cleanup();
  sql(`
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, asset_name, lifecycle_status)
      SELECT '${ASSET}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-MY-WORK-1', 'My Work Test Hose', 'IN_SERVICE'
      FROM customers c
      JOIN customer_locations l ON l.customer_id = c.id
      CROSS JOIN (SELECT id FROM products ORDER BY created_at LIMIT 1) p
      WHERE c.code = 'VOPA' LIMIT 1;
    INSERT INTO inspections (id, version, created_at, updated_at, asset_id, inspection_type, status, submitted_at)
      VALUES ('${INSPECTION}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${ASSET}', 'SERVICE', 'SUBMITTED', CURRENT_TIMESTAMP);
  `);
}

function cleanup() {
  sql(`DELETE FROM inspections WHERE id = '${INSPECTION}'; DELETE FROM assets WHERE id = '${ASSET}';`);
}

test.describe("My Work", () => {
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
    prepare();
  });
  test.afterAll(() => cleanup());

  test("shows a responsive authoritative action and opens its inspection target", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.goto("/?view=my-work");
        const card = page.locator(".my-work-card").filter({ hasText: "E2E-MY-WORK-1" });
        await expect(card).toContainText("Awaiting review");
        const action = card.getByRole("button", { name: "Review inspection" });
        const box = await action.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `action inside ${width}px`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `sideways scroll at ${width}px`).toBe(true);
      }

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/?view=my-work");
      await page.locator(".my-work-card").filter({ hasText: "E2E-MY-WORK-1" }).getByRole("button", { name: "Review inspection" }).click();
      await expect.poll(() => new URL(page.url()).search).toBe(`?view=inspections&inspection=${INSPECTION}`);
    } finally {
      await admin.context.close();
    }
  });
});
