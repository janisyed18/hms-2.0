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

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1024], [390, 844]];

const note = (id: string, patch: Record<string, unknown> = {}) => ({
  id, event_ref: "e", category: "INSPECTION_SUBMITTED", tier: "IMPORTANT", channel: "IN_APP", recipient_type: "USER",
  recipient_id: "me", recipient_address: null, subject: `Inspection ${id} awaiting review`, body: "Ready for review.",
  status: "SENT", attempts: 1, provider_message_id: null, error: null, customer_id: null, asset_id: null,
  subject_type: "inspection", subject_id: `inspection-${id}`, created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  sent_at: null, read_at: null as string | null, ...patch
});

async function mockFeed(page: Page, feed: Array<ReturnType<typeof note>>) {
  const posts: string[] = [];
  await page.route(/\/api\/v1\/notifications\/me(\?.*)?$/, (route) =>
    route.fulfill({ json: { total: feed.length, unread_total: feed.filter((n) => !n.read_at).length, limit: 12, offset: 0, items: feed } })
  );
  await page.route(/\/api\/v1\/notifications\/me\/read-all$/, (route) => {
    posts.push("read-all");
    feed.forEach((n) => { n.read_at = new Date().toISOString(); });
    return route.fulfill({ json: { updated: feed.length, unread_total: 0 } });
  });
  await page.route(/\/api\/v1\/notifications\/[^/]+\/read$/, (route) => {
    const id = route.request().url().split("/").slice(-2)[0];
    posts.push(id);
    const found = feed.find((n) => n.id === id);
    if (found) found.read_at = new Date().toISOString();
    return route.fulfill({ json: found });
  });
  return posts;
}

test.describe("notification center", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => { await waitForApiHealth(); });
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    clearRateLimits();
  });

  test("the bell, its panel and the page work from desktop to phone, and a click goes to the record", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    const feed = [note("a"), note("b"), note("c", { read_at: new Date().toISOString(), subject: "Inspection c awaiting review" })];
    const posts = await mockFeed(page, feed);
    try {
      await page.goto("/?view=dashboard");
      const bell = page.getByRole("button", { name: "Notifications, 2 unread" });
      await expect(bell).toBeVisible();

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await bell.click();
        const panel = page.getByRole("dialog", { name: "Notifications" });
        await expect(panel.getByRole("button", { name: /^Open/ })).toHaveCount(3);
        const box = await panel.boundingBox();
        expect(box && box.x >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(bell).toBeFocused();
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // View all, then back through the panel; the page is addressable and keeps the unread filter.
      await bell.click();
      await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "View all notifications" }).click();
      await expect(page).toHaveURL(/view=notifications/);
      const all = page.getByRole("region", { name: "All notifications" });
      await expect(all.getByRole("button", { name: /^Open/ })).toHaveCount(3);
      await all.getByRole("button", { name: /^Unread/ }).click();
      await expect(all.getByRole("button", { name: /^Open/ })).toHaveCount(2);

      // Clicking one reads it (once) and lands on that inspection's address.
      await all.getByRole("button", { name: "Open unread notification Inspection a awaiting review" }).click();
      await expect(page).toHaveURL(/view=inspections/);
      await expect(page).toHaveURL(/inspection=inspection-a/);
      expect(posts).toEqual(["a"]);

      // Mark all read: a single request, and the badge clears.
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Mark all read" }).click();
      await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
      expect(posts).toEqual(["a", "read-all"]);
    } finally {
      await admin.context.close();
    }
  });
});
