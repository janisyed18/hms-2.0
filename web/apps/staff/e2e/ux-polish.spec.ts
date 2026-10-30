import { expect, test, type Page } from "@playwright/test";

import { chooseOption, optionTexts } from "./choose";
import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  createAndApproveBooking,
  openInspections,
  permanentPasswords,
  prepareSchedulingFixture,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test.describe("usability polish", () => {
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

  test("staff: search says what it searches, filters show as chips, and an empty result is not an empty list", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/?view=assets");
      const search = page.getByLabel("Search assets", { exact: true });
      await expect(search).toHaveAttribute("placeholder", "Search assets by name, number, serial, customer or location");
      await expect(page.getByRole("button", { name: "Clear search" })).toHaveCount(0);

      await search.fill("no-such-asset-anywhere");
      await expect(page.getByText("No matching assets")).toBeVisible();
      await expect(page.getByText("0 matching assets")).toBeVisible();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(search).toHaveValue("");
      await expect(page.getByText("No matching assets")).toHaveCount(0);

      await search.fill("a");
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(search).toBeFocused();

      // A filter shows as a chip that can be taken off, and all of them can be cleared together.
      await page.getByRole("button", { name: "Filters" }).click();
      await chooseOption(page.getByLabel("Asset lifecycle filter"), "OVERDUE");
      const chips = page.getByRole("group", { name: "Active filters" });
      await expect(chips).toContainText("Lifecycle: Overdue");
      await expect(chips).toContainText("1 filter active");
      await chips.getByRole("button", { name: "Remove filter Lifecycle: Overdue" }).click();
      await expect(chips).toHaveCount(0);
      await chooseOption(page.getByLabel("Asset lifecycle filter"), "DUE");
      await page.getByRole("group", { name: "Active filters" }).getByRole("button", { name: "Clear all" }).click();
      await expect(page.getByRole("group", { name: "Active filters" })).toHaveCount(0);

      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await chooseOption(page.getByLabel("Asset lifecycle filter"), "OVERDUE");
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(page.getByRole("group", { name: "Active filters" })).toBeVisible();
        await page.getByRole("group", { name: "Active filters" }).getByRole("button", { name: "Clear all" }).click();
      }
    } finally {
      await admin.context.close();
    }
  });

  test("staff: one place to add an asset, and two inspection actions that are plainly different", async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signedInPage(browser, "super.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(15_000);
    try {
      await expect(page.getByRole("button", { name: /New asset/i })).toHaveCount(0); // not in the top bar on any page
      await page.goto("/?view=assets");
      await expect(page.getByRole("button", { name: /New asset/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add asset" })).toHaveCount(1);

      await page.goto("/?view=inspections");
      const book = page.getByRole("button", { name: "Book inspection" });
      const create = page.getByRole("button", { name: "Create inspection" });
      await expect(book).toBeVisible();
      await expect(create).toBeVisible();
      await expect(book).toHaveClass(/primary-button/);
      await expect(create).toHaveClass(/secondary-button/);
      await expect(page.getByRole("button", { name: /Add inspection/i })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Awaiting review" })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });

  test("a booked time carries its zone in Staff and in the portal (daylight time)", async ({ browser }) => {
    test.setTimeout(300_000);
    prepareSchedulingFixture();
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      await createAndApproveBooking(customer.page, admin.page); // Mon 4 Oct 2027: daylight time, AEDT

      await openInspections(admin.page);
      await expect(admin.page.locator(".inspection-booking-list")).toContainText(/4 Oct(ober)? 2027, 8:00 am AEDT/);

      await customer.page.goto("/portal/?view=bookings");
      const card = customer.page.locator(".portal-booking-card").first();
      // The booking belongs to one of this user's organisations; walk them until it shows.
      const organisation = customer.page.getByLabel("Organisation");
      for (const name of await optionTexts(organisation)) {
        if (await card.count()) break;
        await chooseOption(organisation, { label: name.trim() });
        await customer.page.waitForTimeout(800);
      }
      await expect(card.locator(".portal-zone")).toHaveText("Australia/Sydney · AEDT");
      await expect(card.locator(".portal-when strong")).toContainText("8:00");
      for (const [width, height] of WIDTHS) {
        await customer.page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(customer.page)).toBe(true);
        await expect(card.locator(".portal-zone")).toBeVisible();
      }
    } finally {
      await customer.context.close();
      await admin.context.close();
    }
  });

  test("portal: the dashboard answers what I have, what needs attention and what to do, at every width", async ({ browser }) => {
    test.setTimeout(180_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const page = customer.page;
    page.setDefaultTimeout(15_000);
    try {
      await page.goto("/portal/");
      const glance = page.getByRole("group", { name: "At a glance" });
      const attention = page.getByRole("heading", { name: "Needs attention" });
      const next = page.getByRole("heading", { name: "Next steps" });
      await expect(glance).toBeVisible();
      await expect(attention).toBeVisible();
      await expect(next).toBeVisible();
      const [a, b, c] = await Promise.all([glance.boundingBox(), attention.boundingBox(), next.boundingBox()]);
      expect(a!.y).toBeLessThan(b!.y);
      expect(b!.y).toBeLessThan(c!.y);
      const nextSection = next.locator("xpath=ancestor::section[1]");
      await expect(nextSection.getByRole("button", { name: "Book inspection" })).toHaveClass(/primary-button/);
      await expect(nextSection.locator(".primary-button")).toHaveCount(1);
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        expect(await noSidewaysScroll(page)).toBe(true);
        await expect(nextSection.getByRole("button", { name: "Book inspection" })).toBeVisible();
      }
    } finally {
      await customer.context.close();
    }
  });
});
