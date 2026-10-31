import { expect, test, type Page, type Route } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  bookingApiContext,
  permanentPasswords,
  prepareSchedulingFixture,
  schedulingDate,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

/** Fail the next request matching `url` with `status`, then let later ones through untouched. */
async function failOnce(page: Page, url: RegExp, method: string, status: number, body: unknown) {
  let failed = false;
  await page.route(url, async (route: Route) => {
    if (!failed && route.request().method() === method) {
      failed = true;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    await route.fallback();
  });
}
const apiError = (message: string) => ({ error: { code: "error", message, details: null } });
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name, exact: true }).click();

/** Awaiting approval at consecutive slots of the scheduling day, booked as the customer. */
async function requestSlots(page: Page, slots: number[]) {
  const context = await bookingApiContext(page);
  return page.evaluate(async ({ context, localDate, slots }) => {
    const params = new URLSearchParams({ customer_id: context.customerId, location_id: context.locationId, local_date: localDate, duration_minutes: "60" });
    const ids: string[] = [];
    for (const slot of slots) {
      const quotes = await fetch(`/api/v1/inspection-availability?${params}`, { headers: { authorization: `Bearer ${context.accessToken}` } });
      const items = (await quotes.json()) as { items: Array<{ quote_id: string }> };
      const created = await fetch("/api/v1/inspection-bookings", {
        method: "POST",
        headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ customer_id: context.customerId, location_id: context.locationId, asset_ids: [context.assetId], availability_quote_id: items.items[slot].quote_id })
      });
      if (!created.ok) throw new Error(`Could not create booking (${created.status}).`);
      ids.push(((await created.json()) as { id: string }).id);
    }
    return ids;
  }, { context, localDate: schedulingDate, slots });
}

test.describe("Operational interaction feedback", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await waitForApiHealth();
  });

  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    prepareSchedulingFixture();
    clearRateLimits();
  });

  test("reference data, retest schedule and escalation: validation, failure, preserved work, success", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    try {
      // Reference item: required fields, a refused save keeps the drawer, then a successful save.
      await nav(page, "Reference Data");
      await page.getByRole("button", { name: "Add Standard" }).click();
      await page.getByRole("button", { name: "Save standard" }).click();
      await expect(page.getByLabel("Standard code")).toBeFocused();
      await expect(page.getByText("Enter a standard code.")).toBeVisible();
      const code = `E2E${Date.now()}`.slice(0, 14);
      await page.getByLabel("Standard code").fill(code);
      await page.getByLabel("Standard name").fill("E2E Feedback Standard");
      await failOnce(page, /\/api\/v1\/reference\/catalog\/standards$/, "POST", 409, apiError("A standard with this code already exists."));
      await page.getByRole("button", { name: "Save standard" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "A standard with this code already exists." })).toBeVisible();
      await expect(page.getByLabel("Standard name")).toHaveValue("E2E Feedback Standard");
      await page.getByRole("button", { name: "Save standard" }).click();
      await expect(page.getByRole("status").filter({ hasText: "E2E Feedback Standard" })).toContainText("created successfully");

      // Archiving asks first and, on failure, keeps both the dialog and the record.
      await page.getByPlaceholder(/Search standards/).fill(code);
      const row = page.getByRole("row", { name: new RegExp(code) });
      await row.getByRole("button", { name: "Archive" }).click();
      const dialog = page.getByRole("alertdialog", { name: new RegExp(`Archive E2E Feedback Standard — ${code}\\?`) });
      await failOnce(page, /\/api\/v1\/reference\/catalog\/standards\/[^/]+$/, "DELETE", 500, apiError("Internal server error"));
      await dialog.getByRole("button", { name: "Archive standard" }).click();
      await expect(dialog.getByRole("alert")).toContainText(/service is unavailable/i);
      await expect(row).toBeVisible();
      await dialog.getByRole("button", { name: "Archive standard" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was archived" })).toBeVisible();

      // Retest schedule: inline validation, a stale-version failure keeps the typed values, then success.
      await nav(page, "Retest Schedule");
      await page.getByRole("button", { name: /Open schedule .*997950/ }).first().click();
      await page.getByLabel("Reminder interval days").fill("0");
      await page.getByRole("button", { name: "Save schedule" }).click();
      await expect(page.getByLabel("Reminder interval days")).toBeFocused();
      await expect(page.getByText("Enter a whole number of days, 1 or more.")).toBeVisible();
      await page.getByLabel("Reminder interval days").fill("21");
      await failOnce(page, /\/api\/v1\/retest-schedules\/[^/]+$/, "PATCH", 412, apiError("Resource version does not match"));
      await page.getByRole("button", { name: "Save schedule" }).click();
      await expect(page.getByRole("alert").filter({ hasText: /changed by someone else/i })).toBeVisible();
      await expect(page.getByLabel("Reminder interval days")).toHaveValue("21");
      await page.getByRole("button", { name: "Save schedule" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Retest schedule for" })).toContainText("saved successfully");

      // Escalation: confirmation first, a failed send keeps the dialog, a retry reports the result.
      // The seed's retest dates drift relative to today, so make sure something is overdue on screen.
      await page.route(/\/api\/v1\/dashboard/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.overdue_total = 1;
        body.overdue_retests = [{ asset_id: "a1", asset_number: "997950", customer_name: "Vopak", product_name: "Fuel hose", due_at: "2026-01-01", days_overdue: 30, status: "OVERDUE" }];
        await route.fulfill({ response, json: body });
      });
      await nav(page, "Dashboard");
      await page.getByRole("button", { name: "Send Escalation" }).click();
      const escalation = page.getByRole("alertdialog", { name: "Send overdue retest escalations?" });
      await failOnce(page, /\/api\/v1\/retest-schedules\/escalate-overdue$/, "POST", 500, apiError("Internal server error"));
      await escalation.getByRole("button", { name: "Send escalations" }).click();
      await expect(escalation.getByRole("alert")).toContainText(/service is unavailable/i);
      await escalation.getByRole("button", { name: "Send escalations" }).click();
      await expect(page.getByRole("status").filter({ hasText: /escalated successfully|already been escalated/ })).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });

  test("certificate revoke failure, then booking decline and approval conflicts", async ({ browser }) => {
    test.setTimeout(360_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const superAdmin = await signedInPage(browser, "super.admin@example.test", "Orbit-Cobalt-54!Harbor");
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    try {
      // Certificates (managing them needs certificate:approve, which the super admin holds):
      // revoking asks first; a failure leaves the certificate issued.
      const certs = superAdmin.page;
      await nav(certs, "Certificates");
      await certs.getByRole("row", { name: /997950/ }).first().click();
      await certs.getByRole("button", { name: "Revoke certificate" }).click();
      const revoke = certs.getByRole("alertdialog", { name: /Revoke certificate .+\?/ });
      await failOnce(certs, /\/api\/v1\/certificates\/[^/]+\/revoke$/, "POST", 500, apiError("Internal server error"));
      await revoke.getByRole("button", { name: "Revoke certificate" }).click();
      await expect(revoke.getByRole("alert")).toContainText(/service is unavailable/i);
      await revoke.getByRole("button", { name: "Cancel" }).click();
      await expect(certs.getByRole("alertdialog")).toHaveCount(0);
      await expect(certs.getByRole("button", { name: "Revoke certificate" })).toBeVisible();

      // Bookings: a business conflict is explained as stated; a taken time says the booking changed.
      await requestSlots(customer.page, [0, 1]);
      await nav(page, "Inspections");
      const list = page.locator(".inspection-booking-list");
      await expect(list).toContainText("PENDING APPROVAL", { timeout: 60_000 });
      const first = list.locator("article").first();
      await first.getByRole("button", { name: "Decline" }).click();
      const decline = page.getByRole("alertdialog", { name: /Decline the booking at/ });
      await failOnce(page, /\/api\/v1\/inspection-bookings\/[^/]+\/reject$/, "POST", 409, apiError("Only pending inspection bookings can be declined."));
      await decline.getByRole("button", { name: "Decline booking" }).click();
      const conflict = decline.getByRole("alert");
      await expect(conflict).toContainText("Only pending inspection bookings can be declined.");
      await expect(conflict).not.toContainText(/someone else/i);
      await decline.getByRole("button", { name: "Decline booking" }).click();
      await expect(page.getByRole("status").filter({ hasText: "was declined" })).toBeVisible();

      // Staff scheduling workspace: approving into a taken slot explains and refreshes, then succeeds.
      await nav(page, "Scheduling");
      await page.getByLabel("Jump to date").fill(schedulingDate);
      const block = page.getByRole("group", { name: /Dispatch schedule for/ }).getByRole("button", { name: /Awaiting approval/ }).first();
      await block.click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(drawer.getByLabel("Inspector to assign")).toBeFocused();
      await expect(drawer.getByText("Choose an inspector to assign.")).toBeVisible();
      await drawer.getByLabel("Inspector to assign").selectOption({ label: "inspector@example.test" });
      await failOnce(page, /\/api\/v1\/inspection-bookings\/[^/]+\/approve$/, "POST", 409, apiError("The inspector is no longer available for the selected time"));
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(drawer.getByRole("alert")).toContainText(/changed while you were working/);
      await expect(drawer.getByRole("alert")).toContainText("no longer available");
      await drawer.getByLabel("Inspector to assign").selectOption({ label: "inspector@example.test" });
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(page.locator(".toast").filter({ hasText: "Booking approved and inspector assigned." })).toBeVisible();
    } finally {
      await Promise.all([customer.context.close(), superAdmin.context.close(), admin.context.close()]);
    }
  });
});
