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
const ASSET = "00000000-0000-7000-8000-0000000000b1";
const INSPECTION = "00000000-0000-7000-8000-0000000000b2";
const PRESSURE_TEST = "00000000-0000-7000-8000-0000000000b3";

function sql(command: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

// An asset of its own with a not-yet-started inspection whose form is already complete, so the
// journey exercises the lifecycle and not the form.
const MEASUREMENTS = JSON.stringify({
  schema_version: 1,
  working_pressure_kpa: 21000,
  test_duration_minutes: 1,
  ohms_end_a: 0.2,
  ohms_end_b: 0.2,
  ohms_total: 0.4,
  conditions: {
    chemical_attack: "PASS",
    rust_in_fittings: "PASS",
    end_fitting_damage: "PASS",
    kink_or_dent: "PASS",
    fitting_seal_damage: "PASS",
    wire_corrosion: "PASS",
    bend_at_fitting: "PASS"
  },
  certificate_result: "PASS"
});

function prepare() {
  cleanup();
  sql(`
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, asset_name, lifecycle_status)
      SELECT '${ASSET}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-LIFECYCLE-1', 'Lifecycle Test Hose', 'IN_SERVICE'
      FROM customers c
      JOIN customer_locations l ON l.customer_id = c.id
      CROSS JOIN (SELECT id FROM products ORDER BY created_at LIMIT 1) p
      WHERE c.code = 'VOPA' LIMIT 1;
    INSERT INTO inspections (id, version, created_at, updated_at, asset_id, inspection_type, status, result)
      VALUES ('${INSPECTION}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${ASSET}', 'SERVICE', 'DRAFT', 'PASS');
    INSERT INTO pressure_test_results (id, version, created_at, updated_at, inspection_id, applied_pressure_kpa, hold_time_seconds, passed, measurements)
      VALUES ('${PRESSURE_TEST}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${INSPECTION}', 42000, 60, true, '${MEASUREMENTS}'::json);
  `);
}

function cleanup() {
  sql(`
    DELETE FROM pressure_test_results WHERE id = '${PRESSURE_TEST}';
    DELETE FROM inspections WHERE id = '${INSPECTION}';
    DELETE FROM assets WHERE id = '${ASSET}';
  `);
}

const SLOW = { timeout: 25_000 };
const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1000], [390, 844]];

const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const detailOf = (page: Page) => page.getByRole("complementary", { name: "Inspection detail" });
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("inspection lifecycle", () => {
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

  test("start, submit, send back, rework, resubmit, approve — with the asset's next action following along", async ({ browser }) => {
    test.setTimeout(240_000);
    const session = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = session.page;
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(`/?view=inspections&inspection=${INSPECTION}`);
      const detail = detailOf(page);

      // Not started: read-only, with Start as the only way forward.
      await expect(detail.getByRole("button", { name: "Start inspection" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toHaveCount(0);

      await detail.getByRole("button", { name: "Start inspection" }).click();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Save progress" })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Start inspection" })).toHaveCount(0);

      await detail.getByRole("button", { name: "Submit inspection" }).click();
      await expect(detail.getByRole("button", { name: "Request changes" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Approve inspection" })).toBeVisible();

      // Send it back; a reason is required.
      await detail.getByRole("button", { name: "Request changes" }).click();
      await detail.getByRole("button", { name: "Send back for changes" }).click();
      await expect(detail.getByRole("alert").or(detail.getByText("Say what needs to change"))).toBeVisible();
      await detail.getByLabel("What needs to change").fill("Hold time must be re-tested");
      await detail.getByRole("button", { name: "Send back for changes" }).click();
      await expect(detail.getByRole("status").filter({ hasText: "Changes required" })).toContainText("Hold time must be re-tested", SLOW);
      await expect(detail.getByRole("button", { name: "Begin rework" })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toHaveCount(0);

      // The asset's workflow now points at the rework, on the exact inspection.
      await page.goto(`/?view=assets&asset=${ASSET}`);
      const card = page.getByRole("complementary", { name: "Asset detail" }).getByRole("region", { name: "Workflow" });
      await expect(card).toContainText("Inspection changes required", SLOW);
      await card.getByRole("button", { name: "Rework inspection" }).click();
      await expect.poll(() => here(page)).toBe(`/?view=inspections&inspection=${INSPECTION}`);

      // Rework is explicit, then resubmit and approve.
      await detail.getByRole("button", { name: "Begin rework" }).click();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toBeVisible(SLOW);
      await expect(detail.getByText("Hold time must be re-tested")).toHaveCount(0);
      await detail.getByRole("button", { name: "Submit inspection" }).click();
      await detail.getByRole("button", { name: "Approve inspection" }).click();
      await expect(detail.getByRole("button", { name: "Approve inspection" })).toHaveCount(0, SLOW);
      await expect(detail.getByText("Approved").first()).toBeVisible();
      for (const name of ["Start inspection", "Save progress", "Submit inspection", "Begin rework", "Request changes"]) {
        await expect(detail.getByRole("button", { name })).toHaveCount(0);
      }
    } finally {
      await session.context.close();
    }
  });

  test("a first-time inspection and a changes-required one fit from desktop to phone width", async ({ browser }) => {
    test.setTimeout(240_000);
    const session = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = session.page;
    page.setDefaultTimeout(20_000);
    try {
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await page.goto(`/?view=inspections&inspection=${INSPECTION}`);
        const start = detailOf(page).getByRole("button", { name: "Start inspection" });
        await expect(start).toBeVisible(SLOW);
        const box = await start.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `Start inside ${width}px`).toBe(true);
        expect(await noSidewaysScroll(page), `first-time sideways scroll at ${width}px`).toBe(true);
      }

      sql(`UPDATE inspections SET status = 'REJECTED', rejected_at = CURRENT_TIMESTAMP,
             rejection_reason = 'Hold time must be re-tested, with a much longer explanation that has to wrap on a narrow screen without pushing the page sideways' WHERE id = '${INSPECTION}';`);
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await page.goto(`/?view=inspections&inspection=${INSPECTION}`);
        const rework = detailOf(page).getByRole("button", { name: "Begin rework" });
        await expect(rework).toBeVisible(SLOW);
        const box = await rework.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `Begin rework inside ${width}px`).toBe(true);
        expect(await noSidewaysScroll(page), `rejected sideways scroll at ${width}px`).toBe(true);
      }
    } finally {
      await session.context.close();
    }
  });
});
