import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Browser, type Page } from "@playwright/test";

import { clearRateLimits } from "./global-setup";
import { chooseOption } from "./choose";


export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const schedulingDate = "2027-10-04";
export const permanentPasswords = {
  admin: "Orbit-Cobalt-48!Harbor",
  customer: "Orbit-Cobalt-52!Harbor",
  inspector: "Orbit-Cobalt-49!Harbor"
};
export const activatedAccounts = new Set<string>();
export const activePasswords = new Map<string, string>();
export const authenticatorSecrets = new Map<string, string>();
const selectedBookingAssets = new WeakMap<Page, string>();

export type SchedulingFixture = {
  blackoutDates?: string[];
  closeTime?: string;
  openTime?: string;
  timezone?: string;
  weekdays?: number[];
};

export function credentials(): Record<string, string> {
  const value = process.env.HMS_E2E_ACCOUNTS_JSON;
  if (!value) throw new Error("Development account credentials were not initialized.");
  return JSON.parse(value) as Record<string, string>;
}

export function sqlList(values: string[] | number[]): string {
  return JSON.stringify(values).replaceAll("'", "''");
}

export function prepareSchedulingFixture({
  blackoutDates = [],
  closeTime = "12:00",
  openTime = "08:00",
  timezone = "Australia/Sydney",
  weekdays = [0]
}: SchedulingFixture = {}) {
  const statement = `
    DELETE FROM inspection_appointment_change_requests;
    DELETE FROM inspection_resource_allocations;
    DELETE FROM inspection_appointment_revisions;
    DELETE FROM inspection_appointments;
    DELETE FROM inspections WHERE booking_id IS NOT NULL;
    DELETE FROM inspection_booking_assets;
    DELETE FROM inspection_bookings;
    DELETE FROM inspection_availability_quotes;
    UPDATE users SET customer_id = (SELECT id FROM customers WHERE name = 'Vopak')
      WHERE email = 'customer.user@example.test';
    UPDATE users SET account_status = 'LOCKED'
      WHERE email = 'inspector-1@example.com';
    UPDATE customer_locations
      SET scheduling_timezone = '${timezone}', scheduling_open_time = '${openTime}',
          scheduling_close_time = '${closeTime}', scheduling_weekdays = '${sqlList(weekdays)}',
          scheduling_blackout_dates = '${sqlList(blackoutDates)}'
      WHERE name = 'Port Botany';
  `;
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "hms", "-d", "hms", "-c", statement],
    { cwd: repoRoot, encoding: "utf8" }
  );
  clearRateLimits();
}

export function decodeBase32(value: string): Buffer {
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

export async function totp(secret: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds % 30 >= 27) await new Promise((resolve) => setTimeout(resolve, 4_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function waitForApiHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch("http://127.0.0.1:8000/health")).ok) return;
    } catch {
      // The local Compose API can still be starting after global seeding.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("The local HMS API did not become healthy within 90 seconds.");
}

export async function finishAuthentication(
  page: Page,
  email: string,
  primaryNavigation: ReturnType<Page["getByRole"]>
) {
  const nextStep = await Promise.race([
    primaryNavigation.waitFor({ state: "visible", timeout: 60_000 }).then(() => "authenticated"),
    page.getByRole("heading", { name: "Set up authenticator" }).waitFor({ state: "visible", timeout: 60_000 }).then(() => "enroll"),
    page.getByRole("heading", { name: "Two-factor authentication" }).waitFor({ state: "visible", timeout: 60_000 }).then(() => "challenge")
  ]);
  if (nextStep === "authenticated") return;
  if (nextStep === "enroll") {
    const secret = (await page.locator(".auth-manual-key code").innerText()).trim();
    authenticatorSecrets.set(email, secret);
    await page.getByLabel("Authentication code").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify & finish" }).click();
    await expect(page.getByLabel("I have saved my recovery codes.")).toBeVisible({ timeout: 60_000 });
    await page.getByLabel("I have saved my recovery codes.").check();
    await page.getByRole("button", { name: "Continue to HMS" }).click();
  } else {
    const secret = authenticatorSecrets.get(email);
    if (!secret) throw new Error(`Authenticator secret is unavailable for ${email}.`);
    await page.getByLabel("Authentication code").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
  }
  await expect(primaryNavigation).toBeVisible({ timeout: 60_000 });
}

/** Signs in starting from `startUrl` (the root by default), so a deep link can be followed through the login. */
export async function completeLogin(page: Page, email: string, permanentPassword: string, startUrl = "/") {
  const isActivated = activatedAccounts.has(email);
  const password = activePasswords.get(email) ?? credentials()[email];
  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await page.goto(startUrl);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  if (!isActivated) {
    const initialState = await Promise.race([
      page.getByLabel("New password").waitFor({ state: "visible", timeout: 60_000 }).then(() => "password"),
      primaryNavigation.waitFor({ state: "visible", timeout: 60_000 }).then(() => "dashboard")
    ]);
    if (initialState === "dashboard") {
      activatedAccounts.add(email);
      activePasswords.set(email, password);
      return;
    }
    await page.getByLabel("New password").fill(permanentPassword);
    await page.getByLabel("Confirm password").fill(permanentPassword);
    await page.getByRole("button", { name: "Set password" }).click();
    activatedAccounts.add(email);
    activePasswords.set(email, permanentPassword);
  }
  await finishAuthentication(page, email, primaryNavigation);
}

export async function signedInPage(browser: Browser, email: string, permanentPassword: string) {
  const context = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  const page = await context.newPage();
  await completeLogin(page, email, permanentPassword);
  return { context, page };
}

/**
 * Inspection Operations, settled. It shows one management view at a time, so this waits
 * for whichever the role lands on rather than assuming the record register is up.
 */
export async function openInspections(page: Page) {
  await page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Inspections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inspection operations" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Inspection management view" })).toBeVisible();
  await expect(page.getByText(/^Loading (bookings|inspections)$/)).toHaveCount(0, { timeout: 30_000 });
}

/** Switches to the inspection record register and waits for it. */
export async function openInspectionRecords(page: Page) {
  await page.getByRole("button", { name: "Inspection records", exact: true }).click();
  await expect(page.getByText("Loading inspections")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Inspection records" })).toBeVisible();
}

export async function refreshInspectionsWorkspace(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await navigation.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(navigation).toBeVisible();
  await openInspections(page);
}

// A new booking starts with nothing chosen: the customer, then the location, then the
// assets. (A reschedule keeps the booking's own location and assets.)
export async function chooseBookingLocationAndAsset(page: Page) {
  const location = page.getByLabel("Booking location");
  await expect(location).toHaveText("Choose a customer first");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator("form.inspection-booking-form").getByRole("button", { name: "Create booking" })).toBeDisabled();
  await chooseOption(page.getByRole("combobox", { name: "Booking customer" }), { label: "Vopak" });
  await expect(location).toHaveText("Choose the location");
  await chooseOption(location, { label: "Port Botany" });
  const assetLabel = await page.evaluate(async () => {
    const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
    const { access_token: token } = await refresh.json() as { access_token: string };
    const headers = { authorization: `Bearer ${token}` };
    const customers = await (await fetch("/api/v1/customers?search=Vopak&limit=100", { headers })).json() as {
      items: Array<{ id: string; name: string; locations: Array<{ id: string; name: string }> }>;
    };
    const customer = customers.items.find((item) => item.name === "Vopak");
    const locationRecord = customer?.locations.find((item) => item.name === "Port Botany");
    if (!locationRecord) throw new Error("The seeded Vopak / Port Botany fixture is unavailable.");
    const assets = await (await fetch(
      `/api/v1/assets?customer_id=${encodeURIComponent(customer.id)}&location_id=${encodeURIComponent(locationRecord.id)}&new_work_only=true&sort=asset_number&limit=50`,
      { headers }
    )).json() as { items: Array<{ asset_name?: string | null; asset_number: string }> };
    const asset = assets.items[0];
    if (!asset) throw new Error("The seeded Port Botany asset fixture is unavailable.");
    return asset.asset_name ? `${asset.asset_name} — ${asset.asset_number}` : asset.asset_number;
  });
  selectedBookingAssets.set(page, assetLabel);
  const asset = page.getByRole("checkbox", { name: assetLabel, exact: true });
  await expect(asset).toBeVisible();
  await expect(asset).not.toBeChecked();
  await asset.check();
}

/** Every asset checkbox the booking form offers; the fieldset holds no other checkbox. */
function bookingAssetCheckboxes(page: Page) {
  return page.locator("form.inspection-booking-form fieldset.booking-asset-list input[type=checkbox]");
}

/** The labels of the assets currently ticked, so a selection can be compared before and after. */
async function checkedBookingAssets(page: Page): Promise<string[]> {
  return bookingAssetCheckboxes(page).evaluateAll((inputs) =>
    inputs
      .filter((input) => (input as HTMLInputElement).checked)
      .map((input) => input.closest("label")?.textContent?.trim() ?? "")
      .sort()
  );
}

export async function selectFirstAvailableTime(page: Page, localDate = schedulingDate) {
  const form = page.locator("form.inspection-booking-form");
  // Two ways in, and they carry their assets differently. A new booking ticked one asset
  // itself, so hold the form to that identity. A reschedule opens on the booking's own
  // assets, already ticked and locked, and never recorded one here.
  const rescheduling = (await form.getByRole("button", { name: "Request reschedule" }).count()) > 0;
  if (rescheduling) {
    await expect(bookingAssetCheckboxes(page).first()).toBeDisabled();
  } else {
    const assetLabel = selectedBookingAssets.get(page);
    expect(assetLabel, "a new booking must choose its asset before its time").toBeTruthy();
    await expect(form.getByRole("checkbox", { name: assetLabel!, exact: true })).toBeChecked();
  }
  const selectedBefore = await checkedBookingAssets(page);
  expect(selectedBefore.length).toBeGreaterThan(0);

  const dateInput = page.getByLabel("Preferred inspection date");
  await dateInput.fill(localDate);
  await expect(page.getByText(/Available time \(/)).toBeVisible();
  const timeSelect = page.getByLabel("Available inspection time");
  await expect(timeSelect).toBeEnabled();
  await chooseOption(timeSelect, { first: true });
  // Picking a date and a time says nothing about which assets the visit covers.
  expect(await checkedBookingAssets(page)).toEqual(selectedBefore);
}

export async function submitBookingForm(
  page: Page,
  buttonName: "Create booking" | "Request reschedule",
  responsePath: string
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes(responsePath),
    { timeout: 90_000 }
  );
  await page.locator("form.inspection-booking-form").getByRole("button", { name: buttonName }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
}

export async function createAndApproveBooking(customer: Page, admin: Page, localDate = schedulingDate) {
  await openInspections(customer);
  await customer.getByRole("button", { name: "Book inspection" }).click();
  await chooseBookingLocationAndAsset(customer);
  await selectFirstAvailableTime(customer, localDate);
  await submitBookingForm(customer, "Create booking", "/api/v1/inspection-bookings");
  await expect(customer.locator(".inspection-booking-list")).toContainText("Requested", { timeout: 90_000 });

  await openInspections(admin);
  const inspectorSelect = admin.getByLabel("Assign inspector for Port Botany");
  await inspectorSelect.selectOption({ label: "inspector@example.test" });
  await admin.getByRole("button", { name: "Assign & approve" }).click();
  await expect(admin.locator(".inspection-booking-list")).toContainText("Approved", { timeout: 90_000 });
}

export async function bookingApiContext(page: Page) {
  return page.evaluate(async () => {
    const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
    if (!refresh.ok) throw new Error(`Could not refresh the browser session (${refresh.status}).`);
    const { access_token: accessToken } = await refresh.json() as { access_token: string };
    const response = await fetch("/api/v1/assets?limit=50&offset=0", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Could not load assets (${response.status}).`);
    const data = await response.json() as { items: Array<{ asset_number: string; customer: { id: string }; id: string; location: { id: string } | null }> };
    const asset = data.items.find((item) => item.location !== null);
    if (!asset?.location) throw new Error("Expected a location-bound asset.");
    return { accessToken, assetId: asset.id, assetNumber: asset.asset_number, customerId: asset.customer.id, locationId: asset.location.id };
  });
}

export async function availabilityFromApi(page: Page, localDate: string) {
  const context = await bookingApiContext(page);
  return page.evaluate(async ({ context, localDate }) => {
    const params = new URLSearchParams({
      customer_id: context.customerId,
      location_id: context.locationId,
      local_date: localDate,
      duration_minutes: "60"
    });
    const response = await fetch(`/api/v1/inspection-availability?${params}`, {
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    return {
      payload: await response.json() as { items: Array<{ quote_id: string; starts_at: string }> },
      status: response.status
    };
  }, { context, localDate });
}

