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

function sql(command: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

function sqlValue(command: string): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-At", "-c", command],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();
}

// An asset of its own, with no inspection: the journey creates one through the real Add Inspection flow.
function prepare() {
  cleanup();
  sql(`
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, asset_name, lifecycle_status)
      SELECT '${ASSET}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-LIFECYCLE-1', 'Lifecycle Test Hose', 'IN_SERVICE'
      FROM customers c
      JOIN customer_locations l ON l.customer_id = c.id
      CROSS JOIN (SELECT id FROM products ORDER BY created_at LIMIT 1) p
      WHERE c.code = 'VOPA' LIMIT 1;
  `);
}

// For the layout checks only, which need a record in a given state without walking there.
function seedInspection(status: "DRAFT" | "REJECTED", reason = "") {
  sql(`
    INSERT INTO inspections (id, version, created_at, updated_at, asset_id, inspection_type, status, rejection_reason, rejected_at)
      VALUES ('${INSPECTION}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${ASSET}', 'SERVICE', '${status}',
              ${reason ? `'${reason}'` : "NULL"}, ${status === "REJECTED" ? "CURRENT_TIMESTAMP" : "NULL"});
  `);
}

function cleanup() {
  sql(`
    DELETE FROM pressure_test_results WHERE inspection_id IN (SELECT id FROM inspections WHERE asset_id = '${ASSET}');
    DELETE FROM inspections WHERE asset_id = '${ASSET}';
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
const reviewerOf = (page: Page) => detailOf(page).getByText("Reviewer", { exact: true }).locator("xpath=following-sibling::strong");
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
      // The real creation flow captures no work: only the asset and the type.
      await page.goto("/?view=inspections");
      await page.getByRole("button", { name: "Add Inspection" }).click();
      const drawer = page.getByRole("heading", { name: "Add Inspection" }).locator("xpath=ancestor::form");
      await drawer.getByLabel("Inspection asset").selectOption(await drawer.locator("option", { hasText: "E2E-LIFECYCLE-1" }).getAttribute("value") ?? "");
      for (const label of ["Instruction", "Working pressure kPa", "Ohms total", "Certificate result", "Inspection notes"]) {
        await expect(drawer.getByLabel(label)).toHaveCount(0);
      }
      await drawer.getByRole("button", { name: "Create inspection" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("inspection"), SLOW).not.toBeNull();
      const inspectionId = new URL(page.url()).searchParams.get("inspection")!;
      const detail = detailOf(page);

      // Not started: read-only, with Start as the only way forward, and nothing started yet.
      await expect(detail.getByRole("button", { name: "Start inspection" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toHaveCount(0);
      await expect(detail.getByLabel("Inspection notes")).toBeDisabled();
      expect(sqlValue(`SELECT started_at IS NULL FROM inspections WHERE id = '${inspectionId}'`)).toBe("t");

      await detail.getByRole("button", { name: "Start inspection" }).click();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Save progress" })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Start inspection" })).toHaveCount(0);
      expect(sqlValue(`SELECT started_at IS NOT NULL FROM inspections WHERE id = '${inspectionId}'`)).toBe("t");

      // The work is recorded only now that it is in progress.
      await detail.getByLabel("Instruction").selectOption("PASS");
      await detail.getByLabel("Working pressure kPa").fill("21000");
      await detail.getByLabel("Test pressure kPa").fill("31500");
      await detail.getByLabel("Test time minutes").selectOption("1");
      await detail.getByLabel("Pressure test result").selectOption("PASS");
      await detail.getByLabel("Ohms end A").fill("0.2");
      await detail.getByLabel("Ohms end B").fill("0.2");
      await detail.getByLabel("Ohms total").fill("0.4");
      await detail.getByRole("button", { name: "Pass all" }).click();
      await detail.getByLabel("Certificate result").selectOption("PASS");

      await detail.getByRole("button", { name: "Submit inspection" }).click();
      await expect(detail.getByRole("button", { name: "Request changes" })).toBeVisible(SLOW);
      await expect(detail.getByRole("button", { name: "Approve inspection" })).toBeVisible();
      await expect(reviewerOf(page)).toHaveText("Not reviewed");

      // Send it back; a reason is required.
      await detail.getByRole("button", { name: "Request changes" }).click();
      await detail.getByRole("button", { name: "Send back for changes" }).click();
      await expect(detail.getByRole("alert").or(detail.getByText("Say what needs to change"))).toBeVisible();
      await detail.getByLabel("What needs to change").fill("Hold time must be re-tested");
      await detail.getByRole("button", { name: "Send back for changes" }).click();
      await expect(detail.getByRole("status").filter({ hasText: "Changes required" })).toContainText("Hold time must be re-tested", SLOW);
      await expect(detail.getByRole("button", { name: "Begin rework" })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toHaveCount(0);
      await expect(reviewerOf(page)).not.toHaveText("Not reviewed");

      // The asset's workflow now points at the rework, on the exact inspection.
      await page.goto(`/?view=assets&asset=${ASSET}`);
      const card = page.getByRole("complementary", { name: "Asset detail" }).getByRole("region", { name: "Workflow" });
      await expect(card).toContainText("Inspection changes required", SLOW);
      await card.getByRole("button", { name: "Rework inspection" }).click();
      await expect.poll(() => here(page)).toBe(`/?view=inspections&inspection=${inspectionId}`);

      // Rework is explicit, then resubmit and approve.
      await detail.getByRole("button", { name: "Begin rework" }).click();
      await expect(detail.getByRole("button", { name: "Submit inspection" })).toBeVisible(SLOW);
      // The reviewer's instructions stay while the work is redone, even across a reload; the old reviewer does not.
      await expect(detail.getByRole("status").filter({ hasText: "Rework requested" })).toContainText("Hold time must be re-tested");
      await expect(reviewerOf(page)).toHaveText("Not reviewed");
      await page.reload();
      await expect(detail.getByRole("status").filter({ hasText: "Rework requested" })).toContainText("Hold time must be re-tested", SLOW);
      await expect(reviewerOf(page)).toHaveText("Not reviewed");

      // Resubmitting ends the guidance and still names no reviewer until someone reviews.
      await detail.getByRole("button", { name: "Submit inspection" }).click();
      await expect(detail.getByRole("button", { name: "Approve inspection" })).toBeVisible(SLOW);
      await expect(detail.getByText("Rework requested")).toHaveCount(0);
      await expect(reviewerOf(page)).toHaveText("Not reviewed");
      await detail.getByRole("button", { name: "Approve inspection" }).click();
      await expect(detail.getByRole("button", { name: "Approve inspection" })).toHaveCount(0, SLOW);
      await expect(reviewerOf(page)).not.toHaveText("Not reviewed");
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
      seedInspection("DRAFT");
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await page.goto(`/?view=inspections&inspection=${INSPECTION}`);
        const start = detailOf(page).getByRole("button", { name: "Start inspection" });
        await expect(start).toBeVisible(SLOW);
        const box = await start.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `Start inside ${width}px`).toBe(true);
        expect(await noSidewaysScroll(page), `first-time sideways scroll at ${width}px`).toBe(true);
      }

      sql(`DELETE FROM inspections WHERE id = '${INSPECTION}'`);
      seedInspection("REJECTED", "Hold time must be re-tested, with a much longer explanation that has to wrap on a narrow screen without pushing the page sideways");
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
