import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  createAndApproveBooking,
  permanentPasswords,
  prepareSchedulingFixture,
  repoRoot,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const SUPER = "super.admin@example.test";
const ADMIN = "hms.admin@example.test";
const SECOND_INSPECTOR = "inspector-1@example.com";
const SECOND_INSPECTOR_NAME = "Ivy Inspector";

const fitsTheScreen = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

function setSecondInspector(status: "ACTIVE" | "LOCKED") {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-c",
      `UPDATE users SET account_status = '${status}' WHERE email = '${SECOND_INSPECTOR}';`],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

test.describe("Delete customer and Change inspector", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => { await waitForApiHealth(); });
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    prepareSchedulingFixture();
  });
  test.afterAll(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    clearRateLimits();
  });

  async function createDisposableCustomer(page: Page, name: string) {
    await page.goto("/?view=customers");
    await page.getByRole("button", { name: "Add customer" }).first().click();
    const form = page.getByRole("form", { name: "Add customer" });
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Location name").fill("Head Office");
    const zone = form.getByLabel("Timezone");
    await zone.click();
    await zone.fill("Australia/Sydney");
    await page.getByRole("listbox").getByRole("option", { name: "Australia/Sydney", exact: true }).click();
    await form.getByRole("button", { name: "Add contact" }).click();
    const contact = form.getByRole("group", { name: "Location contacts" }).last();
    await contact.getByLabel("Contact 1 name").fill("Site Person");
    await contact.getByLabel("Contact 1 phone").fill("+61 400 000 000");
    await contact.getByLabel("Contact 1 email").fill("site.person@example.test");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("status").filter({ hasText: "created successfully" })).toBeVisible();
    await page.getByLabel("Search customers", { exact: true }).fill(name);
    await page.getByRole("button", { name: `Select customer ${name}` }).click();
    await expect(page.getByRole("heading", { name: "Customer lifecycle" })).toBeVisible();
  }

  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    test(`Remove customer: archive is recommended, deletion needs the typed name, and history is kept (${label})`, async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const { context, page } = await signedInPage(browser, SUPER, permanentPasswords.admin);
      const name = `Zz Removal ${Date.now().toString(36)}`;
      try {
        await page.setViewportSize({ width, height });
        await createDisposableCustomer(page, name);
        await expect(page.getByText("Super Admin only")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`customer-lifecycle-${label}.png`) });
        await page.getByRole("button", { name: "Delete customer" }).click();

        const dialog = page.getByRole("alertdialog");
        await expect(dialog.getByRole("heading", { name: "Remove Customer" })).toBeVisible();
        await expect(dialog.getByText("Recommended")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`remove-step1-${label}.png`) });

        // Escape leaves everything as it was.
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);

        await page.getByRole("button", { name: "Delete customer" }).click();
        await dialog.getByRole("radio", { name: /Delete Customer and Related Data/ }).check();
        await dialog.getByRole("button", { name: /Continue/ }).click();
        await expect(dialog.getByRole("heading", { name: "Delete Customer and Related Data" })).toBeVisible();
        await expect(dialog.getByText(/Deletion Impact/)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`remove-step2-${label}.png`) });
        await dialog.getByRole("button", { name: /Continue/ }).click();

        const remove = dialog.getByRole("button", { name: /Delete Customer$/ });
        await expect(remove).toBeDisabled();
        await dialog.getByLabel(/Type the customer name/).fill(name);
        await dialog.getByRole("checkbox").check();
        await expect(remove).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath(`remove-step3-${label}.png`) });
        expect(await fitsTheScreen(page)).toBe(true);
        await remove.click();

        await expect(dialog.getByRole("heading", { name: "Customer Deleted Successfully" })).toBeVisible({ timeout: 60_000 });
        await expect(dialog).toContainText(/DEL-\d{4}-\d{6}/);
        await page.screenshot({ path: testInfo.outputPath(`remove-success-${label}.png`) });
        await dialog.getByRole("button", { name: /View in History/ }).click();

        await expect(page.getByRole("heading", { name: "Deleted Customers (History)" })).toBeVisible();
        // View in History opens that batch's records.
        const records = page.getByRole("dialog", { name: new RegExp(`${name} · DEL-`) });
        await expect(records).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`history-records-${label}.png`) });
        await records.getByRole("button", { name: "Close" }).click();
        await expect(page.getByRole("table").getByText(name)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`history-${label}.png`) });
      } finally {
        await context.close();
      }
    });
  }

  test("only a Super Admin is offered Delete customer", async ({ browser }) => {
    const { context, page } = await signedInPage(browser, ADMIN, permanentPasswords.admin);
    try {
      await page.goto("/?view=customers");
      await page.getByLabel("Search customers", { exact: true }).fill("Vopak");
      await page.getByRole("button", { name: /^Select customer Vopak/ }).first().click();
      await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete customer" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Archive customer" })).toHaveCount(0);
      await expect(page.getByText("Super Admin only")).toHaveCount(0);
      // The history is not offered either (the server refuses it too: see the backend authorization tests).
      await expect(page.getByRole("button", { name: "Deleted customers" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("Change inspector: one dialog, refusal keeps the choice, then it saves (desktop and mobile)", async ({ browser }, testInfo) => {
    test.setTimeout(300_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, ADMIN, permanentPasswords.admin);
    try {
      await createAndApproveBooking(customer.page, admin.page);
      // The locked second inspector becomes assignable only for this test.
      setSecondInspector("ACTIVE");
      const page = admin.page;
      // One navigation only: a reload straight followed by another races two session refreshes.
      await page.goto("/?view=inspections");
      await expect(page.getByText(/^Loading (bookings|inspections)$/)).toHaveCount(0, { timeout: 30_000 });

      const card = page.locator(".inspection-booking-card").filter({ hasText: "Port Botany" }).first();
      // The card names the field, then the inspector. Exact, so "Change inspector" is not a match.
      await expect(card.getByText("Inspector", { exact: true })).toBeVisible();
      await expect(card.locator(".assigned-inspector__name")).toContainText("inspector@example.test");
      // The old three-picker row is gone: no Reassign button, one Change inspector beside the name.
      await expect(page.getByRole("button", { name: /Reassign inspector/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("booking-card-desktop.png") });

      for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await card.getByRole("button", { name: "Change inspector for Port Botany" }).click();
        const dialog = page.getByRole("dialog", { name: "Change inspector" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/appointment date, time, location and assets stay the same/i)).toBeVisible();
        // The current inspector is shown as current, never offered as their own replacement.
        await dialog.getByRole("combobox", { name: /New inspector/ }).click();
        await expect(dialog.getByText("Current inspector", { exact: true }).last()).toBeVisible();
        await expect(dialog.getByRole("option", { name: /inspector@example.test/ })).toHaveCount(0);
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
        expect(await fitsTheScreen(page)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`change-inspector-${label}.png`) });
        // The first Escape closes the list, the second closes the dialog.
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        // Cancelling changed nothing.
        await expect(card.locator(".assigned-inspector__name")).toContainText("inspector@example.test");
      }

      await page.setViewportSize({ width: 1440, height: 900 });
      await card.getByRole("button", { name: "Change inspector for Port Botany" }).click();
      const dialog = page.getByRole("dialog", { name: "Change inspector" });
      // A booked inspector is warned about inside the dialog, and cannot be saved.
      await page.route("**/inspector-availability*", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ booking_id: "x", eligible: true, blocked_reason: null, available: false, reason: "inspector_busy", suggested_inspector_ids: [] }) })
      );
      const pickSecond = async () => {
        await dialog.getByRole("combobox", { name: /New inspector/ }).click();
        await dialog.getByRole("option", { name: new RegExp(SECOND_INSPECTOR_NAME) }).click();
      };
      await pickSecond();
      await expect(dialog.getByText("This inspector is already scheduled during the selected time. Choose another inspector or reschedule the inspection.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save change" })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath("change-inspector-busy-desktop.png") });
      await page.unroute("**/inspector-availability*");
      await pickSecond();
      await expect(dialog.getByText("Available", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("change-inspector-available-desktop.png") });

      // A refusal keeps the dialog open with the chosen replacement and says why.
      await page.route("**/reassign-inspector", (route) =>
        route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "That inspector already has an appointment at this time." }) })
      );
      await dialog.getByRole("button", { name: "Save change" }).click();
      await expect(dialog.getByText("That inspector already has an appointment at this time.")).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: /New inspector/ })).toContainText(SECOND_INSPECTOR_NAME);
      await page.screenshot({ path: testInfo.outputPath("change-inspector-refused-desktop.png") });
      await page.unroute("**/reassign-inspector");

      // Retrying without choosing again saves it and closes the dialog.
      await dialog.getByRole("button", { name: "Save change" }).click();
      // The real reassignment can be slow on a busy machine; a server action gets the same wait as elsewhere.
      await expect(dialog).toHaveCount(0, { timeout: 90_000 });
      await expect(card.locator(".assigned-inspector__name")).toContainText(SECOND_INSPECTOR_NAME);
    } finally {
      setSecondInspector("LOCKED");
      await Promise.all([customer.context.close(), admin.context.close()]);
    }
  });
});
