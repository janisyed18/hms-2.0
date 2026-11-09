import { expect, test } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import { activatedAccounts, activePasswords, permanentPasswords, signedInPage, waitForApiHealth } from "./schedulingSupport";

const noSidewaysScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("Asset and Customer form layout", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => { await waitForApiHealth(); });
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    clearRateLimits();
  });

  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    test(`Asset form: compact Asset Number and one vertical panel per end (${label})`, async ({ browser }, testInfo) => {
      const { context, page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
      try {
        await page.setViewportSize({ width, height });
        // A direct link: on a phone the navigation sits behind the menu button.
        await page.goto("/?view=assets");
        await page.getByRole("button", { name: "Add asset" }).first().click();

        const number = page.getByRole("group", { name: "Asset Number" });
        await number.scrollIntoViewIfNeeded();
        await expect(number.getByRole("radio", { name: "Automatic" })).toBeChecked();
        // The selector is one short row, not the tall stack it was.
        expect((await number.boundingBox())!.height).toBeLessThan(90);
        await page.screenshot({ path: testInfo.outputPath(`asset-identity-${label}.png`) });

        const endA = page.getByRole("group", { name: "End A" });
        const endB = page.getByRole("group", { name: "End B" });
        await endA.scrollIntoViewIfNeeded();
        for (const end of [endA, endB]) {
          const boxes = await end.getByRole("combobox").evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { x: Math.round(rect.x), y: Math.round(rect.y) };
          }));
          expect(boxes).toHaveLength(5);
          // One column: every field has the same left edge, and each sits below the one before.
          expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
          expect(boxes.every((box, index) => index === 0 || box.y > boxes[index - 1].y)).toBe(true);
        }
        const a = (await endA.boundingBox())!;
        const b = (await endB.boundingBox())!;
        if (label === "desktop") {
          expect(b.x).toBeGreaterThan(a.x + a.width - 2); // End B to the right of End A
          expect(Math.abs(b.y - a.y)).toBeLessThan(4);
        } else {
          expect(b.y).toBeGreaterThan(a.y + a.height - 2); // stacked on a phone
          expect(await noSidewaysScroll(page)).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath(`asset-ends-${label}.png`) });
      } finally {
        await context.close();
      }
    });
  }

  test("Customer form: add another location, then remove it", async ({ browser }, testInfo) => {
    const { context, page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      await page.goto("/?view=customers");
      await page.getByRole("button", { name: "Add customer" }).first().click();
      await expect(page.getByRole("textbox", { name: "Location name" })).toHaveCount(1);
      await page.getByRole("button", { name: "Add another location" }).click();
      await expect(page.getByRole("textbox", { name: "Location name" })).toHaveCount(2);
      await expect(page.getByRole("heading", { name: "Location 2" })).toBeVisible();
      await page.getByRole("button", { name: "Remove location 2" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("customer-second-location.png") });
      await page.getByRole("button", { name: "Remove location 2" }).click();
      await expect(page.getByRole("textbox", { name: "Location name" })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
