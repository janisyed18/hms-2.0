import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ASSET = "00000000-0000-7000-8000-0000000000a1";
const INSPECTION = "00000000-0000-7000-8000-0000000000a2";

function sql(command: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

// One asset of its own with an inspection submitted for review, so the journey does not lean on
// whatever state the shared seed data happens to be in.
function prepare() {
  cleanup();
  sql(`
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, asset_name, lifecycle_status)
      SELECT '${ASSET}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-WORKFLOW-1', 'Workflow Test Hose', 'IN_SERVICE'
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

const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

test.describe("asset workflow summary", () => {
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

  test("an asset deep link shows its workflow, and the next action lands on the exact inspection", async ({ browser }) => {
    test.setTimeout(150_000);
    const reviewer = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = reviewer.page;
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(`/?view=assets&asset=${ASSET}`);
      const detail = page.getByRole("complementary", { name: "Asset detail" });
      await expect(detail).toContainText("Workflow Test Hose");
      const card = detail.getByRole("region", { name: "Workflow" });
      await expect(card).toContainText("Inspection submitted — awaiting approval");
      await expect(card).toContainText("waiting for an authorised reviewer");

      await card.getByRole("button", { name: "Review inspection" }).click();
      await expect.poll(() => here(page)).toBe(`/?view=inspections&inspection=${INSPECTION}`);
      await expect(page.getByRole("complementary", { name: "Inspection detail" })).toBeVisible();

      // Back returns to the asset, with its workflow.
      await page.goBack();
      await expect(page.getByRole("complementary", { name: "Asset detail" }).getByRole("region", { name: "Workflow" })).toContainText("awaiting approval");
    } finally {
      await reviewer.context.close();
    }
  });

  test("someone who may not approve sees the status but is offered no action", async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(`/?view=assets&asset=${ASSET}`);
      const card = page.getByRole("complementary", { name: "Asset detail" }).getByRole("region", { name: "Workflow" });
      await expect(card).toContainText("Inspection submitted — awaiting approval");
      await expect(card.getByRole("button")).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });

  test("the card fits from desktop to phone width without sideways scrolling", async ({ browser }) => {
    test.setTimeout(150_000);
    const admin = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      for (const [width, height] of [[1440, 900], [1024, 800], [768, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`/?view=assets&asset=${ASSET}`);
        const card = page.getByRole("region", { name: "Workflow" });
        await expect(card).toContainText("awaiting approval");
        const button = card.getByRole("button", { name: "Review inspection" });
        const box = await button.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `button inside ${width}px`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `sideways scroll at ${width}px`).toBe(true);
      }
    } finally {
      await admin.context.close();
    }
  });
});
