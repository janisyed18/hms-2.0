import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { chooseOption } from "./choose";
import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  chooseBookingLocationAndAsset,
  openInspections,
  permanentPasswords,
  prepareSchedulingFixture,
  refreshInspectionsWorkspace,
  selectFirstAvailableTime,
  signedInPage,
  submitBookingForm,
  waitForApiHealth
} from "./schedulingSupport";

const SUPER = "super.admin@example.test";
const CUSTOMER = "customer.user@example.test";
const SHOT_DIR = process.env.INSPECTION_SHOT_DIR;

const fitsTheScreen = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function book(page: Page, localDate: string) {
  await openInspections(page);
  await page.getByRole("button", { name: "Book inspection" }).click();
  await chooseBookingLocationAndAsset(page);
  await selectFirstAvailableTime(page, localDate);
  await submitBookingForm(page, "Create booking", "/api/v1/inspection-bookings");
}

const card = (page: Page, text: RegExp | string) =>
  page.locator(".inspection-booking-card").filter({ hasText: text });

test.describe("Inspection operations: booking cards across states and widths", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => { await waitForApiHealth(); });
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    prepareSchedulingFixture({ weekdays: [0, 1, 2, 3, 4] });
  });
  test.afterAll(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    clearRateLimits();
  });

  test("confirmed, pending approval and pending reschedule bookings stay aligned and usable", async ({ browser }, testInfo) => {
    test.setTimeout(580_000);
    const customer = await signedInPage(browser, CUSTOMER, permanentPasswords.customer);
    const admin = await signedInPage(browser, SUPER, permanentPasswords.admin);
    const dir = SHOT_DIR ?? testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    try {
      // A confirmed, assigned booking.
      await book(customer.page, "2027-10-04");
      await openInspections(admin.page);
      await admin.page.getByRole("button", { name: "Assign inspector" }).first().click();
      await admin.page.getByLabel("Assign inspector for Port Botany").selectOption({ label: "inspector@example.test" });
      await admin.page.getByRole("button", { name: "Confirm assignment & approve" }).click();
      await expect(admin.page.locator(".inspection-booking-list")).toContainText("Approved", { timeout: 90_000 });

      // A second one, approved, then a customer reschedule request waiting for the admin.
      await book(customer.page, "2027-10-05");
      await refreshInspectionsWorkspace(admin.page);
      await admin.page.getByRole("button", { name: "Assign inspector" }).first().click();
      await admin.page.getByLabel("Assign inspector for Port Botany").selectOption({ label: "inspector@example.test" });
      await admin.page.getByRole("button", { name: "Confirm assignment & approve" }).click();
      await expect(admin.page.getByRole("button", { name: "Confirm assignment & approve" })).toHaveCount(0, { timeout: 90_000 });
      await expect(async () => {
        await refreshInspectionsWorkspace(customer.page);
        await expect(card(customer.page, /5 Oct 2027/)).toContainText("Approved", { timeout: 4_000 });
      }).toPass({ timeout: 90_000 });
      await card(customer.page, /5 Oct 2027/).getByText("Actions").click();
      await card(customer.page, /5 Oct 2027/).getByRole("button", { name: "Request reschedule" }).click();
      await selectFirstAvailableTime(customer.page, "2027-10-07");
      await submitBookingForm(customer.page, "Request reschedule", "/change-requests");

      // A third, still pending approval.
      await book(customer.page, "2027-10-06");
      await refreshInspectionsWorkspace(admin.page);

      const page = admin.page;
      await expect(page.locator(".inspection-booking-card")).toHaveCount(3);
      // One operational list: filtering changes the visible bookings, not a second register.
      await page.getByRole("combobox", { name: "Filter bookings by status" }).selectOption("REQUESTED");
      await expect(page.locator(".inspection-booking-card")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Assign inspector" })).toHaveCount(1);
      await page.getByRole("combobox", { name: "Filter bookings by status" }).selectOption("RESCHEDULE");
      await expect(page.locator(".inspection-booking-card")).toHaveCount(1);
      await expect(page.locator(".inspection-booking-card")).toContainText("Requested by: Customer");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page.locator(".inspection-booking-card")).toHaveCount(3);
      await expect(page.getByRole("table", { name: "Inspection records" })).toHaveCount(0);

      for (const [label, width, height] of [["desktop-1440", 1440, 1000], ["tablet-1024", 1024, 900], ["mobile-390", 390, 900]] as const) {
        await page.setViewportSize({ width, height });
        await page.getByRole("heading", { name: "Inspection operations" }).scrollIntoViewIfNeeded();
        expect(await fitsTheScreen(page), `${label}: no horizontal page scroll`).toBe(true);
        // The page clips sideways overflow, so check the workspace itself stays inside the viewport.
        expect(await page.evaluate(() => document.querySelector(".inspection-workspace")!.getBoundingClientRect().right <= innerWidth + 1), `${label}: workspace inside the viewport`).toBe(true);
        const rect = await page.locator(".inspection-bookings-panel").evaluate((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth }; });
        console.log(label, JSON.stringify(rect));
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${dir}/admin-${label}-top.png` });
        await page.locator(".inspection-bookings-panel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${dir}/admin-${label}-bookings.png` });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await customer.page.setViewportSize({ width: 1440, height: 1000 });
      await refreshInspectionsWorkspace(customer.page);
      await customer.page.locator(".inspection-bookings-panel").screenshot({ path: `${dir}/customer-bookings-desktop-1440.png` });
      void chooseOption;
    } finally {
      await Promise.all([customer.context.close(), admin.context.close()]);
    }
  });
});
