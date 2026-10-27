import { expect, test, type Page } from "@playwright/test";

import { mockBootstrapResponse } from "../src/data/mockSync";

// The signed-in workspace at four real viewport sizes. The suite's other projects only set a device
// profile, so this file fixes its own sizes and runs once.
test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(testInfo.project.name !== "desktop", "sets its own viewports");
});

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1024], [390, 844]];

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function openWorkspace(page: Page) {
  await page.route("**/api/v1/auth/browser/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/refresh")) {
      await route.fulfill(json({ next_step: "AUTHENTICATED", access_token: "inspector-token", token_type: "bearer", expires_in: 900 }));
    } else if (path.endsWith("/me")) {
      await route.fulfill(json({ user_id: "inspector-1", email: "inspector@example.test", display_name: "Field Inspector", roles: ["INSPECTOR"] }));
    } else {
      await route.fulfill(json({ detail: "unexpected" }, 404));
    }
  });
  await page.route("**/api/v1/sync/bootstrap**", (route) => route.fulfill(json(mockBootstrapResponse)));
  await page.route("**/api/v1/sync/changes**", (route) => route.fulfill(json({ cursor: mockBootstrapResponse.cursor, has_more: false, changes: [] })));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /open HOS-2024-0891/i })).toBeVisible();
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector(".app-content") as HTMLElement;
    return document.documentElement.scrollWidth <= innerWidth + 1 && content.scrollWidth <= content.clientWidth + 1;
  });
const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};
const inViewport = (b: { x: number; y: number; width: number; height: number }, width: number, height: number) =>
  b.x >= -1 && b.y >= -1 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1;

test.describe("Inspector responsive shell", () => {
  for (const [width, height] of WIDTHS) {
    test(`${width}x${height}: Work, Capture and Queue fit, with the right navigation`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openWorkspace(page);

      // No device frame, and the app owns the whole window.
      await expect(page.locator(".inspector-stage, .inspector-device")).toHaveCount(0);
      const app = await box(page, ".inspector-app");
      expect(Math.round(app.width)).toBe(width);
      expect(await noSidewaysScroll(page)).toBe(true);

      // Status stays visible as ordinary page information.
      await expect(page.getByLabel("Sync status")).toContainText("Online");
      await expect(page.getByLabel("Sync status")).toContainText("queued");
      expect(inViewport(await box(page, '[aria-label="Sync status"]'), width, height)).toBe(true);

      // Navigation: bottom bar on a phone, left rail on a tablet, sidebar on a desktop.
      const nav = await box(page, '[aria-label="Inspector navigation"]');
      if (width < 768) {
        expect(nav.y + nav.height).toBeGreaterThan(height - 2);
        expect(Math.round(nav.width)).toBe(width);
      } else {
        expect(nav.x).toBeLessThan(2);
        expect(nav.height).toBeGreaterThan(height * 0.5);
        expect(nav.width).toBeGreaterThanOrEqual(width >= 1200 ? 220 : 90);
        expect(nav.width).toBeLessThanOrEqual(width >= 1200 ? 260 : 120);
      }
      for (const name of ["Work", "Capture", "Queue", "Scan"]) {
        expect(inViewport(await page.getByRole("navigation", { name: "Inspector navigation" }).getByRole("button", { name }).boundingBox() ?? { x: -9, y: -9, width: 0, height: 0 }, width, height)).toBe(true);
      }

      // Work uses the width it has.
      const list = await box(page, ".work-list");
      if (width >= 1200) expect(list.width).toBeGreaterThan(900);
      const cards = await page.locator(".work-card").evaluateAll((nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().left))).size);
      if (width >= 768) expect(cards).toBeGreaterThanOrEqual(2);
      else expect(cards).toBe(1);

      // Capture: context and form side by side on a desktop; the actions are always reachable.
      await page.getByRole("button", { name: /open HOS-2024-0891/i }).click();
      await expect(page.getByRole("button", { name: "Save Draft" })).toBeVisible();
      expect(await noSidewaysScroll(page)).toBe(true);
      const context = await box(page, ".capture-context");
      const main = await box(page, ".capture-main");
      if (width >= 1200) {
        expect(context.x + context.width).toBeLessThanOrEqual(main.x + 1);
        expect(main.width).toBeGreaterThan(600);
      } else {
        expect(main.y).toBeGreaterThanOrEqual(context.y + context.height - 1);
      }
      for (const name of ["Queue Test Result", "Save Draft", "Submit"]) {
        expect(inViewport(await page.getByRole("button", { name, exact: true }).boundingBox() ?? { x: -9, y: -9, width: 0, height: 0 }, width, height)).toBe(true);
      }
      // The action bar stays reachable at the foot of a long form.
      await page.locator(".capture-main").evaluate((el) => el.scrollIntoView({ block: "end" }));
      expect(inViewport((await page.getByRole("button", { name: "Save Draft" }).boundingBox()) ?? { x: -9, y: -9, width: 0, height: 0 }, width, height)).toBe(true);

      // Save a draft, and the Queue shows it with its actions in reach.
      await page.getByLabel("Test time minutes").selectOption("5");
      await page.getByLabel("Pressure test result").selectOption("PASS");
      await page.getByRole("button", { name: "Save Draft" }).click();
      await page.getByRole("navigation", { name: "Inspector navigation" }).getByRole("button", { name: "Queue" }).click();
      await expect(page.getByLabel("Sync queue")).toBeVisible();
      await expect(page.getByLabel("Sync status")).toContainText("1 queued");
      expect(await noSidewaysScroll(page)).toBe(true);
      expect(inViewport((await page.getByRole("button", { name: "Push Changes" }).boundingBox()) ?? { x: -9, y: -9, width: 0, height: 0 }, width, height)).toBe(true);
    });
  }

  test("leaving a capture with unsaved edits asks first, by keyboard too", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page);
    await page.getByRole("button", { name: /open HOS-2024-0891/i }).click();
    await page.getByLabel("Asset tag").fill("KEYBOARD-TAG");
    await page.getByRole("navigation", { name: "Inspector navigation" }).getByRole("button", { name: "Work" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Asset tag")).toHaveValue("KEYBOARD-TAG");
    await page.getByRole("button", { name: "Work queue" }).click();
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByLabel("Work queue")).toBeVisible();
  });

  test("the offline state is shown, and a draft can still be saved", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByLabel("Sync status")).toContainText("Offline");
    await page.getByRole("button", { name: /open HOS-2024-0891/i }).click();
    await page.getByLabel("Test time minutes").selectOption("5");
    await page.getByLabel("Pressure test result").selectOption("PASS");
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect(page.getByLabel("Sync status")).toContainText("1 queued");
    await expect(page.getByLabel("Sync status")).toContainText("Offline");
  });

  test("navigation shows a visible keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page);
    const work = page.getByRole("navigation", { name: "Inspector navigation" }).getByRole("button", { name: "Work" });
    await work.focus();
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAccessibleName("Capture");
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineWidth);
    expect(outline).toBe("solid 3px");
  });
});
