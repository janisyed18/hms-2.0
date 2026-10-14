import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { resetAuthTestAccounts } from "./global-setup";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const schedulingDate = "2027-10-04";
const permanentPasswords = {
  admin: "Orbit-Cobalt-48!Harbor",
  customer: "Orbit-Cobalt-52!Harbor",
  inspector: "Orbit-Cobalt-49!Harbor"
};
const activatedAccounts = new Set<string>();
const activePasswords = new Map<string, string>();
const authenticatorSecrets = new Map<string, string>();

type SchedulingFixture = {
  blackoutDates?: string[];
  closeTime?: string;
  openTime?: string;
  timezone?: string;
  weekdays?: number[];
};

function credentials(): Record<string, string> {
  const value = process.env.HMS_E2E_ACCOUNTS_JSON;
  if (!value) throw new Error("Development account credentials were not initialized.");
  return JSON.parse(value) as Record<string, string>;
}

function sqlList(values: string[] | number[]): string {
  return JSON.stringify(values).replaceAll("'", "''");
}

function prepareSchedulingFixture({
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
  const limiterKeys = execFileSync(
    "docker",
    ["compose", "exec", "-T", "redis", "redis-cli", "--scan", "--pattern", "hms:login-rate:*"],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim().split("\n").filter(Boolean);
  if (limiterKeys.length) {
    execFileSync(
      "docker",
      ["compose", "exec", "-T", "redis", "redis-cli", "DEL", ...limiterKeys],
      { cwd: repoRoot, encoding: "utf8" }
    );
  }
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

async function waitForApiHealth() {
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

async function finishAuthentication(
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

async function completeLogin(page: Page, email: string, permanentPassword: string) {
  const isActivated = activatedAccounts.has(email);
  const password = activePasswords.get(email) ?? credentials()[email];
  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await page.goto("/");
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

async function signedInPage(browser: Browser, email: string, permanentPassword: string) {
  const context = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  const page = await context.newPage();
  await completeLogin(page, email, permanentPassword);
  return { context, page };
}

async function openInspections(page: Page) {
  await page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Inspections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inspection operations" })).toBeVisible();
  await expect(page.getByText("Loading inspections")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Inspection records" })).toBeVisible();
}

async function refreshInspectionsWorkspace(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await navigation.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(navigation).toBeVisible();
  await openInspections(page);
}

async function selectFirstAvailableTime(page: Page, localDate = schedulingDate) {
  await expect(page.getByRole("checkbox", { name: "980636" })).toBeChecked();
  const dateInput = page.getByLabel("Preferred inspection date");
  await dateInput.fill(localDate);
  await expect(page.getByText(/Available time \(/)).toBeVisible();
  const timeSelect = page.getByLabel("Available inspection time");
  await expect(timeSelect).toBeEnabled();
  await timeSelect.selectOption({ index: 1 });
}

async function submitBookingForm(
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

async function createAndApproveBooking(customer: Page, admin: Page, localDate = schedulingDate) {
  await openInspections(customer);
  await customer.getByRole("button", { name: "Book inspection" }).click();
  await selectFirstAvailableTime(customer, localDate);
  await submitBookingForm(customer, "Create booking", "/api/v1/inspection-bookings");
  await expect(customer.locator(".inspection-booking-list")).toContainText("PENDING APPROVAL", { timeout: 90_000 });

  await openInspections(admin);
  const inspectorSelect = admin.getByLabel("Assign inspector for Port Botany");
  await inspectorSelect.selectOption({ label: "inspector@example.test" });
  await admin.getByRole("button", { name: "Assign & approve" }).click();
  await expect(admin.locator(".inspection-booking-list")).toContainText("APPROVED", { timeout: 90_000 });
}

async function bookingApiContext(page: Page) {
  return page.evaluate(async () => {
    const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
    if (!refresh.ok) throw new Error(`Could not refresh the browser session (${refresh.status}).`);
    const { access_token: accessToken } = await refresh.json() as { access_token: string };
    const response = await fetch("/api/v1/assets?limit=50&offset=0", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Could not load assets (${response.status}).`);
    const data = await response.json() as { items: Array<{ customer: { id: string }; id: string; location: { id: string } | null }> };
    const asset = data.items.find((item) => item.location !== null);
    if (!asset?.location) throw new Error("Expected a location-bound asset.");
    return { accessToken, assetId: asset.id, customerId: asset.customer.id, locationId: asset.location.id };
  });
}

async function availabilityFromApi(page: Page, localDate: string) {
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

test.describe("scheduling release workflow", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await waitForApiHealth();
  });

  test.beforeEach(() => {
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

  test("customer booking, admin assignment, and two-party rescheduling", async ({ browser }) => {
    test.setTimeout(300_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const inspector = await signedInPage(browser, "inspector@example.test", permanentPasswords.inspector);
    try {
      await createAndApproveBooking(customer.page, admin.page);
      await openInspections(inspector.page);
      await expect(inspector.page.getByRole("table", { name: "Inspection records" })).toContainText("DRAFT");

      await refreshInspectionsWorkspace(customer.page);
      await expect(customer.page.locator(".inspection-booking-list time")).toContainText("8:00");
      await customer.page.getByRole("button", { name: "Request reschedule" }).click();
      await selectFirstAvailableTime(customer.page);
      await submitBookingForm(customer.page, "Request reschedule", "/change-requests");
      await expect(customer.page.locator(".inspection-booking-list")).toContainText("Awaiting admin approval", { timeout: 90_000 });

      await refreshInspectionsWorkspace(admin.page);
      const rescheduleInspector = admin.page.getByLabel("Assign inspector for reschedule at Port Botany");
      await rescheduleInspector.selectOption({ label: "inspector@example.test" });
      await admin.page.getByRole("button", { name: "Approve reschedule" }).click();
      await expect(admin.page.locator(".inspection-booking-list")).toContainText("APPROVED");

      await admin.page.getByRole("button", { name: "Request reschedule" }).click();
      await selectFirstAvailableTime(admin.page);
      await admin.page.getByLabel("Inspector for rescheduled inspection").selectOption({ label: "inspector@example.test" });
      await submitBookingForm(admin.page, "Request reschedule", "/change-requests");
      await expect(admin.page.locator(".inspection-booking-list")).toContainText("Awaiting customer confirmation", { timeout: 90_000 });

      await refreshInspectionsWorkspace(customer.page);
      await customer.page.getByRole("button", { name: "Confirm reschedule" }).click();
      await expect(customer.page.locator(".inspection-booking-list")).toContainText("APPROVED");
    } finally {
      await Promise.all([customer.context.close(), admin.context.close(), inspector.context.close()]);
    }
  });

  test("cancellation releases the confirmed allocation and restores availability", async ({ browser }) => {
    test.setTimeout(120_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      const customerContext = await bookingApiContext(customer.page);
      const adminContext = await bookingApiContext(admin.page);
      const availability = await availabilityFromApi(customer.page, schedulingDate);
      const initialSlot = availability.payload.items[0];
      if (!initialSlot) throw new Error("Expected an available slot to cancel.");
      const bookingId = await customer.page.evaluate(async ({ context, quoteId }) => {
        const response = await fetch("/api/v1/inspection-bookings", {
          method: "POST",
          headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            customer_id: context.customerId,
            location_id: context.locationId,
            asset_ids: [context.assetId],
            availability_quote_id: quoteId
          })
        });
        if (!response.ok) throw new Error(`Could not create booking (${response.status}).`);
        return (await response.json() as { id: string }).id;
      }, { context: customerContext, quoteId: initialSlot.quote_id });
      const inspectorId = await admin.page.evaluate(async ({ accessToken }) => {
        const response = await fetch("/api/v1/admin/users?limit=100&offset=0", {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const users = await response.json() as { items: Array<{ email: string; id: string }> };
        return users.items.find((user) => user.email === "inspector@example.test")?.id;
      }, adminContext);
      expect(inspectorId).toBeTruthy();
      const approval = await admin.page.evaluate(async ({ accessToken, bookingId, inspectorId }) => {
        const response = await fetch(`/api/v1/inspection-bookings/${bookingId}/approve`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ inspector_user_id: inspectorId })
        });
        return response.status;
      }, { accessToken: adminContext.accessToken, bookingId, inspectorId });
      expect(approval).toBe(200);
      const cancellation = await customer.page.evaluate(async ({ accessToken, bookingId }) => {
        const response = await fetch(`/api/v1/inspection-bookings/${bookingId}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ reason: "Customer cannot access the site." })
        });
        return { booking: await response.json() as { status: string }, status: response.status };
      }, { accessToken: customerContext.accessToken, bookingId });
      expect(cancellation.status).toBe(200);
      expect(cancellation.booking.status).toBe("CANCELLED");
      const restoredAvailability = await availabilityFromApi(customer.page, schedulingDate);
      expect(restoredAvailability.payload.items.map((slot) => slot.starts_at)).toContain(
        initialSlot.starts_at
      );
    } finally {
      await Promise.all([customer.context.close(), admin.context.close()]);
    }
  });

  test("overlapping approvals return a business conflict", async ({ browser }) => {
    test.setTimeout(180_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      const customerContext = await bookingApiContext(customer.page);
      const adminContext = await bookingApiContext(admin.page);
      const result = await customer.page.evaluate(async ({ context, localDate }) => {
        const availability = async () => {
          const params = new URLSearchParams({
            customer_id: context.customerId,
            location_id: context.locationId,
            local_date: localDate,
            duration_minutes: "60"
          });
          const response = await fetch(`/api/v1/inspection-availability?${params}`, {
            headers: { authorization: `Bearer ${context.accessToken}` }
          });
          if (!response.ok) throw new Error(`Could not quote availability (${response.status}).`);
          return (await response.json() as { items: Array<{ quote_id: string; starts_at: string }> }).items[0];
        };
        const firstQuote = await availability();
        const secondQuote = await availability();
        if (!firstQuote || !secondQuote || firstQuote.starts_at !== secondQuote.starts_at) {
          throw new Error("Expected two quotes for the same available slot.");
        }
        const create = async (quoteId: string) => {
          const response = await fetch("/api/v1/inspection-bookings", {
            method: "POST",
            headers: {
              authorization: `Bearer ${context.accessToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              customer_id: context.customerId,
              location_id: context.locationId,
              asset_ids: [context.assetId],
              availability_quote_id: quoteId
            })
          });
          if (!response.ok) throw new Error(`Could not create booking (${response.status}).`);
          return (await response.json() as { id: string }).id;
        };
        return { firstBookingId: await create(firstQuote.quote_id), secondBookingId: await create(secondQuote.quote_id) };
      }, { context: customerContext, localDate: schedulingDate });

      const inspectorId = await admin.page.evaluate(async ({ accessToken }) => {
        const response = await fetch("/api/v1/admin/users?limit=100&offset=0", {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) throw new Error(`Could not load inspectors (${response.status}).`);
        const users = await response.json() as { items: Array<{ email: string; id: string }> };
        const inspector = users.items.find((user) => user.email === "inspector@example.test");
        if (!inspector) throw new Error("Expected inspector test account.");
        return inspector.id;
      }, adminContext);

      const approval = async (bookingId: string) => admin.page.evaluate(async ({ accessToken, bookingId, inspectorId }) => {
        const response = await fetch(`/api/v1/inspection-bookings/${bookingId}/approve`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ inspector_user_id: inspectorId })
        });
        return { body: await response.json(), status: response.status };
      }, { accessToken: adminContext.accessToken, bookingId, inspectorId });

      const approvals = await Promise.all([
        approval(result.firstBookingId),
        approval(result.secondBookingId)
      ]);
      expect(approvals.map((response) => response.status).sort()).toEqual([200, 409]);
    } finally {
      await Promise.all([customer.context.close(), admin.context.close()]);
    }
  });

  test("blackout dates expose no slot and reject a direct booking bypass", async ({ browser }) => {
    test.setTimeout(90_000);
    prepareSchedulingFixture({ blackoutDates: [schedulingDate] });
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    try {
      await openInspections(customer.page);
      await customer.page.getByRole("button", { name: "Book inspection" }).click();
      await customer.page.getByLabel("Preferred inspection date").fill(schedulingDate);
      const timeSelect = customer.page.getByLabel("Available inspection time");
      await expect(timeSelect).toBeDisabled();
      await expect(timeSelect).toContainText("No times available");

      const context = await bookingApiContext(customer.page);
      const response = await customer.page.evaluate(async ({ context }) => {
        const result = await fetch("/api/v1/inspection-bookings", {
          method: "POST",
          headers: {
            authorization: `Bearer ${context.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            customer_id: context.customerId,
            location_id: context.locationId,
            asset_ids: [context.assetId],
            scheduled_at: "2027-10-03T21:00:00Z"
          })
        });
        return { body: await result.json(), status: result.status };
      }, { context });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("validation_error");
    } finally {
      await customer.context.close();
    }
  });

  test("DST-invalid local intervals are absent from the browser and availability API", async ({ browser }) => {
    test.setTimeout(90_000);
    prepareSchedulingFixture({ closeTime: "04:00", openTime: "01:00", timezone: "America/New_York", weekdays: [6] });
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    try {
      await openInspections(customer.page);
      await customer.page.getByRole("button", { name: "Book inspection" }).click();
      await customer.page.getByLabel("Preferred inspection date").fill("2027-03-14");
      const springTimeSelect = customer.page.getByLabel("Available inspection time");
      await expect(springTimeSelect).toBeEnabled({ timeout: 30_000 });
      const springOptions = await springTimeSelect.locator("option").allTextContents();
      expect(springOptions).toEqual(["Select a time", "3:00 AM - 4:00 AM"]);

      prepareSchedulingFixture({ closeTime: "03:00", openTime: "00:00", timezone: "America/New_York", weekdays: [6] });
      await refreshInspectionsWorkspace(customer.page);
      await customer.page.getByRole("button", { name: "Book inspection" }).click();
      await customer.page.getByLabel("Preferred inspection date").fill("2027-11-07");
      const fallTimeSelect = customer.page.getByLabel("Available inspection time");
      await expect(fallTimeSelect).toBeEnabled({ timeout: 30_000 });
      const fallOptions = await fallTimeSelect.locator("option").allTextContents();
      expect(fallOptions).toEqual(["Select a time", "2:00 AM - 3:00 AM"]);

      const availability = await availabilityFromApi(customer.page, "2027-11-07");
      expect(availability.status).toBe(200);
      expect(availability.payload.items.map((slot) => slot.starts_at)).toEqual(["2027-11-07T07:00:00Z"]);
    } finally {
      await customer.context.close();
    }
  });
});
