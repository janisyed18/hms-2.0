import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
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

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=|\s/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 authenticator secret.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function totp(secret: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds % 30 >= 27) await new Promise((resolve) => setTimeout(resolve, 4_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
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
  await page.getByRole("button", { name: "Set password" }).click();
  const workspace = page.getByRole("region", { name: "Customer portal workspace" });
  const nextStep = await Promise.race([
    workspace.waitFor({ state: "visible", timeout: 60_000 }).then(() => "authenticated"),
    page.getByRole("heading", { name: "Set up authenticator" })
      .waitFor({ state: "visible", timeout: 60_000 }).then(() => "enroll")
  ]);
  if (nextStep === "enroll") {
    const secret = (await page.locator(".auth-manual-key code").innerText()).trim();
    await page.getByLabel("Authentication code").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify & finish" }).click();
    await expect(page.getByLabel("I have saved my recovery codes.")).toBeVisible();
    await page.getByLabel("I have saved my recovery codes.").check();
    await page.getByRole("button", { name: "Continue to HMS" }).click();
  }
  await expect(workspace).toBeVisible();
  const token = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/browser/refresh", {
      method: "POST",
      credentials: "include"
    });
    if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
    return (await response.json() as { access_token?: string }).access_token;
  });
  if (!token) throw new Error("Authenticated portal session did not return an access token.");
  return token;
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

  test("portal links restore the workspace, organisation and asset, and refuse what is not theirs", async ({ page }) => {
    test.setTimeout(180_000);
    preparePortalFixture(false);
    await signInToPortal(page);
    page.setDefaultTimeout(20_000);
    const here = () => new URL(page.url()).pathname + new URL(page.url()).search;

    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Assets", exact: true }).click();
    await expect.poll(here).toMatch(/^\/portal\/\?view=assets&customer=[\w-]+$/);
    await page.locator(".portal-record-button").first().click();
    await expect.poll(here).toMatch(/^\/portal\/\?view=assets&customer=[\w-]+&asset=[\w-]+$/);
    const link = here();
    const heading = await page.locator(".portal-panel h2").first().innerText();

    await page.goto(link);
    await expect(page.locator(".portal-panel h2").first()).toHaveText(heading);
    await page.reload();
    await expect(page.locator(".portal-panel h2").first()).toHaveText(heading);
    await page.getByRole("button", { name: "Back to assets" }).click();
    await expect.poll(here).toMatch(/^\/portal\/\?view=assets&customer=[\w-]+$/);
    await page.goBack();
    await expect(page.locator(".portal-panel h2").first()).toHaveText(heading);

    // An asset that is not this organisation's is not shown, and the link stops naming it.
    const organisation = new URL(page.url()).searchParams.get("customer");
    await page.goto(`/portal/?view=assets&customer=${organisation}&asset=00000000-0000-0000-0000-000000000000`);
    await expect(page.getByRole("alert").filter({ hasText: "That asset could not be found" })).toBeVisible();
    await expect.poll(here).toBe(`/portal/?view=assets&customer=${organisation}`);

    // An organisation the account cannot see is never swapped for one it can.
    await page.goto("/portal/?view=assets&customer=00000000-0000-0000-0000-000000000000");
    await expect(page.getByText("Organisation unavailable")).toBeVisible();

    // Staff views do not exist under /portal/.
    await page.goto("/portal/?view=users");
    await expect(page.getByRole("region", { name: "Customer portal workspace" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBeNull();
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
    await expect(page.getByText("Your inspection request was submitted for approval.")).toBeFocused();
    await expect(page.getByRole("button", { name: "Cancel booking" })).toBeVisible();
    await expect(page.locator(".portal-status", { hasText: "Awaiting approval" })).toBeVisible();
    // The request survives a reload, and the form starts fresh.
    await page.reload();
    await navigation.getByRole("button", { name: "Bookings", exact: true }).click();
    await expect(page.locator(".portal-status", { hasText: "Awaiting approval" })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    // Cancelling asks first, and can be backed out of.
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await page.getByRole("button", { name: "Keep booking" }).click();
    await expect(page.locator(".portal-status", { hasText: "Awaiting approval" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await page.getByRole("button", { name: "Yes, cancel this booking" }).click();
    await expect(page.getByText("The booking was cancelled and the time was released.")).toBeFocused();
    await expect(page.locator(".portal-status", { hasText: "Cancelled" })).toBeVisible();

    for (const pageName of ["Inspections", "Certificates", "Retests", "Notifications"]) {
      await navigation.getByRole("button", { name: pageName, exact: true }).click();
      await expect(page.getByRole("heading", { name: pageName === "Retests" ? "Retest schedule" : pageName })).toBeVisible();
    }
  });

  test("the booking form works at every width with long names, and the site's time zone is shown with the times", async ({ page }) => {
    test.setTimeout(240_000);
    preparePortalFixture(false);
    sql(`UPDATE customer_locations SET name = 'Port Botany Bulk Liquids Terminal Berth 4 Extended Operations Name'
         WHERE customer_id = (SELECT id FROM customers WHERE code = 'VOPA');`);
    try {
      await signInToPortal(page);
      for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto("/portal/");
        await expect(page.getByRole("region", { name: "Customer portal workspace" })).toBeVisible();
        if (width < 800) {
          await page.getByRole("button", { name: "Open navigation menu" }).click();
          await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Bookings", exact: true }).click();
        } else {
          await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Bookings", exact: true }).click();
        }
        await selectFirstQuote(page);
        await expect(page.getByRole("group", { name: /Available times on .*UTC/ })).toBeVisible();
        await expect(page.getByText(/You are requesting/)).toContainText("Port Botany Bulk Liquids Terminal Berth 4");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `page overflow at ${width}px`).toBeLessThanOrEqual(1);
        const short = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".portal-booking button, .portal-booking select, .portal-booking input[type=date]"))
            .filter((element) => element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().height < 40)
            .map((element) => element.textContent?.trim() || element.getAttribute("aria-label"))
        );
        expect(short, `controls under 40px tall at ${width}px`).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`booking-${width}.png`) });
      }
    } finally {
      sql(`UPDATE customer_locations SET name = 'Port Botany'
           WHERE customer_id = (SELECT id FROM customers WHERE code = 'VOPA');`);
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

  test("Customer A cannot read, cancel or price Customer B's scheduling by guessed ids", async ({ page }) => {
    test.setTimeout(180_000);
    preparePortalFixture(true);
    sql(`UPDATE customer_locations
         SET scheduling_timezone = 'UTC', scheduling_open_time = '08:00',
             scheduling_close_time = '12:00', scheduling_weekdays = '[0]', scheduling_blackout_dates = '[]'
         WHERE customer_id = (SELECT id FROM customers WHERE code = 'ORIC');`);
    const ids = sql(`SELECT c.id || '|' || l.id FROM customers c JOIN customer_locations l ON l.customer_id = c.id WHERE c.code = 'ORIC' LIMIT 1;`).split("|");
    const accessToken = await signInToPortal(page);

    // While the user can still act for both organisations, create a booking for Customer B.
    const bookingId = await page.evaluate(async ({ accessToken, customerId, locationId, assetId, date }) => {
      const headers = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const quotes = await fetch(`/api/v1/inspection-availability?customer_id=${customerId}&location_id=${locationId}&local_date=${date}&duration_minutes=60`, { headers });
      const slot = ((await quotes.json()) as { items: Array<{ quote_id: string }> }).items[0];
      const created = await fetch("/api/v1/inspection-bookings", {
        method: "POST",
        headers,
        body: JSON.stringify({ customer_id: customerId, location_id: locationId, asset_ids: [assetId], availability_quote_id: slot.quote_id })
      });
      return ((await created.json()) as { id: string }).id;
    }, { accessToken, customerId: ids[0], locationId: ids[1], assetId: "00000000-0000-7000-8000-000000000043", date: bookingDate });
    expect(bookingId).toBeTruthy();

    // Now remove access to Customer B and try guessed identifiers.
    sql(`DELETE FROM user_customer_accesses WHERE id = '00000000-0000-7000-8000-000000000042';`);
    const attempts = await page.evaluate(async ({ accessToken, customerId, locationId, bookingId, date }) => {
      const headers = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const read = async (path: string, init: RequestInit = {}) => {
        const result = await fetch(path, { headers, ...init });
        return { status: result.status, body: await result.text() };
      };
      return {
        detail: await read(`/api/v1/inspection-bookings/${bookingId}`),
        cancel: await read(`/api/v1/inspection-bookings/${bookingId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "guess" }) }),
        availability: await read(`/api/v1/inspection-availability?customer_id=${customerId}&location_id=${locationId}&local_date=${date}&duration_minutes=60`),
        list: await read(`/api/v1/inspection-bookings?customer_id=${customerId}`)
      };
    }, { accessToken, customerId: ids[0], locationId: ids[1], bookingId, date: bookingDate });

    expect([403, 404]).toContain(attempts.detail.status);
    expect([403, 404]).toContain(attempts.cancel.status);
    expect([403, 404]).toContain(attempts.availability.status);
    for (const attempt of Object.values(attempts)) {
      expect(attempt.body).not.toContain("Orica");
      expect(attempt.body).not.toContain("E2E-ORIC-SECRET");
    }
    const listed = JSON.parse(attempts.list.body) as { items?: unknown[] };
    expect(attempts.list.status === 200 ? listed.items ?? [] : []).toEqual([]);
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
