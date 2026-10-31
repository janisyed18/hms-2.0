import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  bookingApiContext,
  permanentPasswords,
  prepareSchedulingFixture,
  refreshInspectionsWorkspace,
  repoRoot,
  schedulingDate,
  selectFirstAvailableTime,
  signedInPage,
  submitBookingForm,
  waitForApiHealth
} from "./schedulingSupport";
import { chooseOption } from "./choose";

const INSPECTOR_EMAIL = "inspector@example.test";

type Context = Awaited<ReturnType<typeof bookingApiContext>>;

/** Two quotes at consecutive slots of the scheduling day, booked as the customer. */
async function bookSlots(page: Page, context: Context, slots: Array<0 | 1>) {
  return page.evaluate(
    async ({ context, localDate, slots }) => {
      const params = new URLSearchParams({
        customer_id: context.customerId,
        location_id: context.locationId,
        local_date: localDate,
        duration_minutes: "60"
      });
      const ids: string[] = [];
      for (const slot of slots) {
        const quotes = await fetch(`/api/v1/inspection-availability?${params}`, {
          headers: { authorization: `Bearer ${context.accessToken}` }
        });
        const items = (await quotes.json()) as { items: Array<{ quote_id: string }> };
        const response = await fetch("/api/v1/inspection-bookings", {
          method: "POST",
          headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            customer_id: context.customerId,
            location_id: context.locationId,
            asset_ids: [context.assetId],
            availability_quote_id: items.items[slot].quote_id
          })
        });
        if (!response.ok) throw new Error(`Could not create booking (${response.status}).`);
        ids.push(((await response.json()) as { id: string }).id);
      }
      return ids;
    },
    { context, localDate: schedulingDate, slots }
  );
}

async function inspectorId(page: Page, context: Context) {
  return page.evaluate(async ({ accessToken }) => {
    const response = await fetch("/api/v1/admin/users?limit=100&offset=0", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const users = (await response.json()) as { items: Array<{ email: string; id: string }> };
    return users.items.find((user) => user.email === "inspector@example.test")!.id;
  }, context);
}

async function approveViaApi(page: Page, context: Context, bookingId: string, inspector: string) {
  return page.evaluate(
    async ({ accessToken, bookingId, inspector }) => {
      const response = await fetch(`/api/v1/inspection-bookings/${bookingId}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ inspector_user_id: inspector })
      });
      return response.status;
    },
    { accessToken: context.accessToken, bookingId, inspector }
  );
}

async function openScheduling(page: Page, date = schedulingDate) {
  await page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Scheduling", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduling", level: 2 })).toBeVisible();
  await page.getByLabel("Jump to date").fill(date);
  await expect(page.getByRole("heading", { level: 3, name: /4 October 2027/ })).toBeVisible();
}

const dayGrid = (page: Page) => page.getByRole("group", { name: /Dispatch schedule for Monday 4 October/ });

/** A confirmed 8:00 visit for the inspector, and a pending request at the next slot. */
async function scene(browser: Browser) {
  const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
  const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
  const customerContext = await bookingApiContext(customer.page);
  const adminContext = await bookingApiContext(admin.page);
  const [confirmed, requested] = await bookSlots(customer.page, customerContext, [0, 1]);
  const inspector = await inspectorId(admin.page, adminContext);
  expect(await approveViaApi(admin.page, adminContext, confirmed, inspector)).toBe(200);
  return { customer, admin, adminContext, confirmed, requested, inspector };
}

test.describe("staff scheduling and dispatch calendar", () => {
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
  });

  test.afterEach(({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      const logs = execFileSync(
        "docker",
        ["compose", "logs", "--no-color", "--tail=200", "api", "worker", "beat"],
        { cwd: repoRoot, encoding: "utf8", timeout: 10_000 }
      );
      writeFileSync(testInfo.outputPath("service.log"), logs);
    } catch (error) {
      writeFileSync(testInfo.outputPath("service.log"), `Service logs unavailable: ${String(error)}`);
    }
  });

  test.afterAll(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
  });

  test("A: staff open the schedule, see the day, and move through Week and Month", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      await openScheduling(s.admin.page);
      const grid = dayGrid(s.admin.page);
      await expect(grid).toBeVisible();
      // 8:00 am Sydney is the first slot, shown as the location's own time.
      await expect(grid.getByRole("button", { name: /8:00 am to 9:00 am, Vopak, Port Botany, .*Confirmed/ })).toBeVisible();
      await expect(grid.getByText("Unassigned")).toBeVisible();

      await s.admin.page.getByRole("button", { name: "Week" }).click();
      const week = s.admin.page.getByRole("group", { name: /Schedule for the week of 4 October to 10 October 2027/ });
      await expect(week).toBeVisible();
      await expect(week.getByRole("button", { name: /Port Botany/ }).first()).toBeVisible();
      await s.admin.page.getByRole("button", { name: "Next week" }).click();
      await expect(s.admin.page.getByText(/No inspections scheduled for the week of 11 October/)).toBeVisible();
      await s.admin.page.getByRole("button", { name: "Previous week" }).click();
      await expect(week).toBeVisible();

      await s.admin.page.getByRole("button", { name: "Month" }).click();
      const day = s.admin.page.getByRole("button", { name: /^Monday 4 October: 2 visits, 1 unassigned/ });
      await expect(day).toBeVisible();
      await day.click();
      await expect(dayGrid(s.admin.page)).toBeVisible();
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("B: the inspector filter keeps one inspector's work and drops the rest", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      await openScheduling(s.admin.page);
      const grid = dayGrid(s.admin.page);
      await expect(grid.getByRole("button", { name: /Awaiting approval/ })).toBeVisible();
      await s.admin.page.getByRole("group", { name: "Schedule filters" }).getByLabel("Inspector").selectOption({ label: INSPECTOR_EMAIL });
      await expect(grid.getByRole("button", { name: /Confirmed/ })).toBeVisible();
      await expect(grid.getByRole("button", { name: /Awaiting approval/ })).toHaveCount(0);
      await s.admin.page.getByRole("button", { name: /Reset filters/ }).click();
      await expect(grid.getByRole("button", { name: /Awaiting approval/ })).toBeVisible();
      await s.admin.page.getByRole("group", { name: "Schedule filters" }).getByLabel("Customer").selectOption({ label: "Vopak" });
      await expect(grid.getByRole("button", { name: /Vopak/ }).first()).toBeVisible();
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("C: selecting an appointment shows its details and returns focus when closed", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      await openScheduling(s.admin.page);
      const block = dayGrid(s.admin.page).getByRole("button", { name: /8:00 am to 9:00 am, Vopak, Port Botany/ });
      await block.click();
      const drawer = s.admin.page.getByRole("dialog", { name: /Vopak · Port Botany/ });
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(INSPECTOR_EMAIL);
      await expect(drawer).toContainText("Australia/Sydney");
      await expect(drawer).toContainText("980636");
      await expect(drawer).toContainText("revision 1");
      await s.admin.page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(block).toBeFocused();
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("D: rescheduling from the calendar uses the availability flow and needs the customer's confirmation", async ({ browser }) => {
    test.setTimeout(300_000);
    const s = await scene(browser);
    try {
      await openScheduling(s.admin.page);
      await dayGrid(s.admin.page).getByRole("button", { name: /8:00 am to 9:00 am, Vopak, Port Botany/ }).click();
      const drawer = s.admin.page.getByRole("dialog", { name: /Vopak · Port Botany/ });
      await drawer.getByRole("button", { name: "Request reschedule" }).click();

      // The existing form: nothing can be submitted until an available time is chosen.
      const submit = s.admin.page.locator("form.inspection-booking-form").getByRole("button", { name: "Request reschedule" });
      await expect(submit).toBeDisabled();
      await selectFirstAvailableTime(s.admin.page);
      await chooseOption(s.admin.page.getByLabel("Inspector for rescheduled inspection"), { label: INSPECTOR_EMAIL });
      await submitBookingForm(s.admin.page, "Request reschedule", "/change-requests");

      await expect(drawer).toContainText("Waiting for customer confirmation");
      await expect(s.admin.page.locator(".toast").filter({ hasText: "Reschedule requested." })).toBeVisible(); // confirmed in the shell, beyond the drawer
      await s.admin.page.keyboard.press("Escape");
      await expect(dayGrid(s.admin.page).getByRole("button", { name: /Change requested/ })).toBeVisible();

      await refreshInspectionsWorkspace(s.customer.page);
      const confirmed = s.customer.page.waitForResponse(
        (response) => response.url().includes("/confirm") && response.request().method() === "POST"
      );
      await s.customer.page.getByRole("button", { name: "Confirm reschedule" }).click();
      expect((await confirmed).status()).toBe(200);

      // Back on the calendar, the change is no longer pending.
      await s.admin.page.getByRole("button", { name: "Next day" }).click();
      await s.admin.page.getByRole("button", { name: "Previous day" }).click();
      await expect(dayGrid(s.admin.page).getByRole("button", { name: /Change requested/ })).toHaveCount(0);
      // The visit now sits at the new time, and the old 8:00 slot is free again.
      await expect(dayGrid(s.admin.page).getByRole("button", { name: /8:00 am to 9:00 am, Vopak.*Confirmed/ })).toHaveCount(0);
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("E: a stale action is refused, explained, and nothing is overwritten", async ({ browser }) => {
    test.setTimeout(240_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      const customerContext = await bookingApiContext(customer.page);
      const adminContext = await bookingApiContext(admin.page);
      // Two requests for the same slot: only one inspector visit can exist.
      const [first] = await bookSlots(customer.page, customerContext, [0, 0]);
      const inspector = await inspectorId(admin.page, adminContext);
      await openScheduling(admin.page);
      const pendingBlocks = dayGrid(admin.page).getByRole("button", { name: /Awaiting approval/ });
      await expect(pendingBlocks).toHaveCount(2);

      // Someone else approves one of them while this page is open.
      expect(await approveViaApi(admin.page, adminContext, first, inspector)).toBe(200);

      await pendingBlocks.first().click();
      const drawer = admin.page.getByRole("dialog");
      await drawer.getByLabel("Inspector to assign").selectOption({ label: INSPECTOR_EMAIL });
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(drawer.getByRole("alert")).toContainText(/changed while you were working/);
      await expect(drawer).not.toContainText("Booking approved and inspector assigned.");
      await expect(drawer).toBeVisible();
    } finally {
      await Promise.all([customer.context.close(), admin.context.close()]);
    }
  });

  test("F: an unassigned request is visible and can be assigned from the calendar", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      await openScheduling(s.admin.page);
      const grid = dayGrid(s.admin.page);
      await grid.getByRole("button", { name: /Unassigned, Awaiting approval/ }).click();
      const drawer = s.admin.page.getByRole("dialog");
      await drawer.getByLabel("Inspector to assign").selectOption({ label: INSPECTOR_EMAIL });
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(s.admin.page.locator(".toast").filter({ hasText: "Booking approved and inspector assigned." })).toBeVisible();
      await s.admin.page.keyboard.press("Escape");
      await expect(grid.getByRole("button", { name: /Awaiting approval/ })).toHaveCount(0);
      await expect(grid.getByRole("button", { name: /Confirmed/ })).toHaveCount(2);
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("G: the schedule stays usable from desktop to phone width without sideways page scroll", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      // A long customer name is the realistic way to push a filter or table past the screen.
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-c",
          "UPDATE customers SET name = 'Vopak Terminals Australia Pty Ltd Port Botany Bulk Liquids Division' WHERE name = 'Vopak';"],
        { cwd: repoRoot, encoding: "utf8" }
      );
      const page = s.admin.page;
      await page.reload();
      await openScheduling(page);
      const pageOverflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800], [768, 1024], [390, 844]] as const) {
        await page.setViewportSize({ width, height });
        for (const view of ["Calendar", "List", "Awaiting approval"]) {
          await page.getByRole("tab", { name: view }).click();
          if (view === "Calendar") await expect(dayGrid(page)).toBeVisible();
          if (view === "List") await expect(page.getByRole("table", { name: "Scheduled inspections" })).toBeVisible();
          if (view === "Awaiting approval") await expect(page.getByRole("button", { name: /Review request from/ }).first()).toBeVisible();
          expect(await pageOverflow(), `${view} at ${width}px`).toBeLessThanOrEqual(1);
          await expect(page.getByRole("button", { name: "Book inspection" })).toBeVisible();
        }
        await page.getByRole("tab", { name: "Calendar" }).click();
        await page.screenshot({ path: test.info().outputPath(`schedule-${width}.png`) });
      }

      // The review action is a normal button, not a stretched bar, at tablet width.
      await page.setViewportSize({ width: 1024, height: 800 });
      await page.getByRole("tab", { name: "Awaiting approval" }).click();
      const review = await page.getByRole("button", { name: /Review request from/ }).first().boundingBox();
      expect(review!.width).toBeLessThan(200);

      // On a phone the filters fold away until asked for, and the schedule is not pushed off screen.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("tab", { name: "Calendar" }).click();
      const toggle = page.getByRole("button", { name: /^Filters/ });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("group", { name: "Schedule filters" })).toBeHidden();
      await toggle.click();
      await expect(page.getByRole("group", { name: "Schedule filters" })).toBeVisible();
      expect(await pageOverflow()).toBeLessThanOrEqual(1);
      await toggle.click();
      await expect(page.getByRole("group", { name: "Schedule filters" })).toBeHidden();
      await expect(dayGrid(page)).toBeInViewport();
    } finally {
      // Later tests find the seeded customer by its original name.
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-c",
          "UPDATE customers SET name = 'Vopak' WHERE name LIKE 'Vopak Terminals Australia%';"],
        { cwd: repoRoot, encoding: "utf8" }
      );
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });

  test("H: Day, Week and Month navigation keeps the viewed day, and a request flows from Pending to a refreshed schedule", async ({ browser }) => {
    test.setTimeout(240_000);
    const s = await scene(browser);
    try {
      const page = s.admin.page;
      await openScheduling(page);
      await page.getByRole("button", { name: "Week", exact: true }).click();
      await expect(page.getByRole("heading", { level: 3, name: /4 Oct to 10 Oct 2027/ })).toBeVisible();
      await page.getByRole("button", { name: "Month", exact: true }).click();
      await expect(page.getByRole("heading", { level: 3, name: "October 2027" })).toBeVisible();
      // Opening a day from the month returns to Day view on that day.
      await page.getByRole("button", { name: /4 October/ }).first().click();
      await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(dayGrid(page)).toBeVisible();

      // Changing the calendar zone keeps the same calendar day on screen.
      await page.getByLabel("Calendar time zone").selectOption("Australia/Perth");
      await expect(page.getByRole("heading", { level: 3, name: /4 October 2027/ })).toBeVisible();
      await page.getByLabel("Calendar time zone").selectOption("Australia/Sydney");

      // Pending -> drawer -> action -> refreshed state, driven from the keyboard.
      await page.getByRole("tab", { name: /^Awaiting approval/ }).focus();
      await page.keyboard.press("Enter");
      const review = page.getByRole("button", { name: /Review request from/ }).first();
      await review.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await drawer.getByLabel("Inspector to assign").selectOption({ label: INSPECTOR_EMAIL });
      await drawer.getByRole("button", { name: "Assign & approve" }).click();
      await expect(s.admin.page.locator(".toast").filter({ hasText: "Booking approved and inspector assigned." })).toBeVisible();
      // Wait for the queue refresh to drop the request, so focus has nowhere else to return.
      await expect(page.getByRole("button", { name: /Review request from/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      // The request has left the queue, so focus falls back to the open view's tab.
      await expect(page.getByRole("tab", { name: /^Awaiting approval/ })).toBeFocused();
      await page.getByRole("tab", { name: "Calendar" }).click();
      await expect(dayGrid(page).getByRole("button", { name: /Awaiting approval/ })).toHaveCount(0);
    } finally {
      await Promise.all([s.customer.context.close(), s.admin.context.close()]);
    }
  });
});
