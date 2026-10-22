import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { resetAuthTestAccounts } from "./global-setup";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const customerEmail = "customer.user@example.test";
const customerPassword = "Portal-Customer-47!";
const bookingDate = "2027-10-04";

function credentials(): Record<string, string> {
  const value = process.env.HMS_E2E_ACCOUNTS_JSON;
  if (!value) throw new Error("Development account credentials were not initialized.");
  return JSON.parse(value) as Record<string, string>;
}

function sql(command: string): string {
  return execFileSync(
    "docker",
    [
      "compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
      "-U", "hms", "-d", "hms", "-At", "-c", command
    ],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();
}

function preparePortalFixture(includeCustomerB: boolean) {
  sql(`
    DELETE FROM inspection_appointment_change_requests;
    DELETE FROM inspection_resource_allocations;
    DELETE FROM inspection_appointment_revisions;
    DELETE FROM inspection_appointments;
    DELETE FROM inspections WHERE booking_id IS NOT NULL;
    DELETE FROM inspection_booking_assets;
    DELETE FROM inspection_bookings;
    DELETE FROM inspection_availability_quotes;
    DELETE FROM assets WHERE id = '00000000-0000-7000-8000-000000000043';
    DELETE FROM user_customer_accesses
      WHERE user_id = (SELECT id FROM users WHERE email = '${customerEmail}');
    UPDATE users
      SET customer_id = (SELECT id FROM customers WHERE code = 'VOPA')
      WHERE email = '${customerEmail}';
    INSERT INTO user_customer_accesses (id, version, created_at, updated_at, user_id, customer_id)
      SELECT '00000000-0000-7000-8000-000000000041', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, u.id, c.id
      FROM users u CROSS JOIN customers c
      WHERE u.email = '${customerEmail}' AND c.code = 'VOPA';
    ${includeCustomerB ? `
    INSERT INTO user_customer_accesses (id, version, created_at, updated_at, user_id, customer_id)
      SELECT '00000000-0000-7000-8000-000000000042', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, u.id, c.id
      FROM users u CROSS JOIN customers c
      WHERE u.email = '${customerEmail}' AND c.code = 'ORIC';` : ""}
    INSERT INTO assets (id, version, created_at, updated_at, customer_id, location_id, product_id, asset_number, lifecycle_status)
      SELECT '00000000-0000-7000-8000-000000000043', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c.id, l.id, p.id, 'E2E-ORIC-SECRET', 'IN_SERVICE'
      FROM customers c
      JOIN customer_locations l ON l.customer_id = c.id
      CROSS JOIN (SELECT id FROM products ORDER BY created_at LIMIT 1) p
      WHERE c.code = 'ORIC';
    UPDATE customer_locations
      SET scheduling_timezone = 'UTC', scheduling_open_time = '08:00',
          scheduling_close_time = '12:00', scheduling_weekdays = '[0]',
          scheduling_blackout_dates = '[]'
      WHERE customer_id = (SELECT id FROM customers WHERE code = 'VOPA');
  `);
}

async function signInToPortal(page: Page): Promise<string> {
  await page.goto("/portal/");
  await page.getByLabel("Email").fill(customerEmail);
  await page.getByLabel("Password", { exact: true }).fill(credentials()[customerEmail]);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(customerPassword);
  await page.getByLabel("Confirm password").fill(customerPassword);
  const passwordResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/auth/browser/password") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Set password" }).click();
  const body = await (await passwordResponse).json() as { access_token?: string };
  if (!body.access_token) throw new Error("Password change did not authenticate the portal user.");
  await expect(page.getByRole("region", { name: "Customer portal workspace" })).toBeVisible();
  return body.access_token;
}

async function selectFirstQuote(page: Page) {
  await page.getByLabel("Booking location").selectOption({ index: 1 });
  await page.getByLabel("Booking asset").selectOption({ index: 1 });
  await page.getByLabel("Preferred date").fill(bookingDate);
  await page.getByRole("button", { name: "Find availability" }).click();
  await expect(page.getByRole("radio").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio").first().check();
}

test.describe("customer portal", () => {
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
  });

  test("customer completes the native portal journey and cancels a booking", async ({ page }) => {
    preparePortalFixture(false);
    await signInToPortal(page);

    const navigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(navigation.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "Customers", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Book inspection" })).toBeVisible();

    await navigation.getByRole("button", { name: "Assets", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
    await page.getByRole("button", { name: /997950/ }).click();
    await expect(page.getByRole("heading", { name: "997950" })).toBeVisible();
    await page.getByRole("button", { name: "Back to assets" }).click();

    await navigation.getByRole("button", { name: "Locations", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
    await navigation.getByRole("button", { name: "Bookings", exact: true }).click();
    await selectFirstQuote(page);
    await page.getByRole("button", { name: "Submit booking request" }).click();
    await expect(page.getByRole("button", { name: "Cancel booking" })).toBeVisible();
    await expect(page.getByText("PENDING_APPROVAL")).toBeVisible();
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByText("CANCELLED")).toBeVisible();

    for (const pageName of ["Inspections", "Certificates", "Retests", "Notifications"]) {
      await navigation.getByRole("button", { name: pageName, exact: true }).click();
      await expect(page.getByRole("heading", { name: pageName === "Retests" ? "Retest schedule" : pageName })).toBeVisible();
    }
  });

  test("Customer A cannot fetch Customer B data by a guessed asset id", async ({ page }) => {
    preparePortalFixture(false);
    const customerBAssetId = sql("SELECT id FROM assets WHERE customer_id = (SELECT id FROM customers WHERE code = 'ORIC') LIMIT 1;");
    const accessToken = await signInToPortal(page);

    const response = await page.evaluate(async (assetId) => {
      const result = await fetch(`/api/v1/assets/${assetId.id}`, {
        headers: { Authorization: `Bearer ${assetId.accessToken}` }
      });
      return { status: result.status, body: await result.text() };
    }, { id: customerBAssetId, accessToken });

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("Orica");
  });

  test("multi-customer users can switch organisations and mobile navigation remains usable", async ({ page }) => {
    test.setTimeout(120_000);
    preparePortalFixture(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await signInToPortal(page);

    const organisation = page.getByRole("combobox", { name: "Organisation" });
    await expect(organisation).toBeVisible();
    await organisation.selectOption({ label: "Orica Mining Services" });
    await expect(page.getByText("Orica Mining Services").first()).toBeVisible();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation menu" });
    await drawer.getByRole("button", { name: "Assets", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
  });
});
