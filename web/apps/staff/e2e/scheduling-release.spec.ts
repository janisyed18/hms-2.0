import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { resetAuthTestAccounts } from "./global-setup";
import {
  repoRoot,
  schedulingDate,
  permanentPasswords,
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  prepareSchedulingFixture,
  waitForApiHealth,
  signedInPage,
  openInspections,
  refreshInspectionsWorkspace,
  chooseBookingLocationAndAsset,
  selectFirstAvailableTime,
  submitBookingForm,
  createAndApproveBooking,
  bookingApiContext,
  availabilityFromApi
} from "./schedulingSupport";

test.describe("scheduling release workflow", () => {
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

  test("customer booking, admin assignment, and two-party rescheduling", async ({ browser }) => {
    test.setTimeout(300_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const inspector = await signedInPage(browser, "inspector@example.test", permanentPasswords.inspector);
    try {
      await createAndApproveBooking(customer.page, admin.page);
      await openInspections(inspector.page);
      await expect(inspector.page.getByRole("table", { name: "Inspection records" })).toContainText("Draft");

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
      await chooseBookingLocationAndAsset(customer.page);
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
      await chooseBookingLocationAndAsset(customer.page);
      await customer.page.getByLabel("Preferred inspection date").fill("2027-03-14");
      const springTimeSelect = customer.page.getByLabel("Available inspection time");
      await expect(springTimeSelect).toBeEnabled({ timeout: 30_000 });
      const springOptions = await springTimeSelect.locator("option").allTextContents();
      expect(springOptions).toEqual(["Select a time", "3:00 AM - 4:00 AM"]);

      // The form holds a chosen location and date, so leaving it asks first; this test means to discard.
      await customer.page.getByRole("button", { name: "Cancel" }).click();
      await customer.page.getByRole("alertdialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();
      prepareSchedulingFixture({ closeTime: "03:00", openTime: "00:00", timezone: "America/New_York", weekdays: [6] });
      await refreshInspectionsWorkspace(customer.page);
      await customer.page.getByRole("button", { name: "Book inspection" }).click();
      await chooseBookingLocationAndAsset(customer.page);
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

  test("a new booking starts blank and drops everything that depended on the location", async ({ browser }) => {
    test.setTimeout(120_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    try {
      await openInspections(customer.page);
      await customer.page.getByRole("button", { name: "Book inspection" }).click();
      await chooseBookingLocationAndAsset(customer.page);
      await selectFirstAvailableTime(customer.page);
      const create = customer.page.locator("form.inspection-booking-form").getByRole("button", { name: "Create booking" });
      await expect(create).toBeEnabled();

      // Going back to "Choose the location" clears the assets, the date, the times and the quote.
      await customer.page.getByLabel("Booking location").selectOption("");
      await expect(customer.page.getByRole("checkbox")).toHaveCount(0);
      await expect(customer.page.getByLabel("Preferred inspection date")).toHaveValue("");
      await expect(customer.page.getByLabel("Preferred inspection date")).toBeDisabled();
      await expect(customer.page.getByLabel("Available inspection time")).toHaveCount(0);
      await expect(create).toBeDisabled();

      // Choosing the location again does not bring the old asset back.
      await customer.page.getByLabel("Booking location").selectOption({ label: "Vopak - Port Botany" });
      await expect(customer.page.getByRole("checkbox", { name: "980636" })).not.toBeChecked();
      await expect(create).toBeDisabled();
    } finally {
      await customer.context.close();
    }
  });

  test("customer cards show the API's asset count and agree with the customer detail", async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    try {
      const expected = await admin.page.evaluate(async () => {
        const refresh = await fetch("/api/v1/auth/browser/refresh", { method: "POST" });
        const { access_token: accessToken } = await refresh.json() as { access_token: string };
        const headers = { authorization: `Bearer ${accessToken}` };
        const customers = await (await fetch("/api/v1/customers?limit=100", { headers })).json() as {
          items: Array<{ id: string; name: string; metrics: { asset_count: number } }>;
        };
        const target = customers.items.find((item) => item.name === "Vopak") ?? customers.items[0];
        const assets = await (await fetch(`/api/v1/assets?customer_id=${target.id}&limit=1`, { headers })).json() as { total: number };
        return { name: target.name, fromMetrics: target.metrics.asset_count, fromAssetList: assets.total };
      });
      expect(expected.fromMetrics).toBe(expected.fromAssetList);
      expect(expected.fromMetrics).toBeGreaterThan(0);

      await admin.page.getByRole("navigation", { name: "Primary navigation" })
        .getByRole("button", { name: "Customers", exact: true }).click();
      // Searching narrows the list but must not change the customer's own count.
      await admin.page.getByPlaceholder("Search customers...").fill(expected.name);
      const card = admin.page.getByRole("button", { name: `Select customer ${expected.name}` });
      await expect(card).toContainText(new RegExp(`${expected.fromMetrics}\\s*Assets`));
      await card.click();
      const summary = admin.page.getByLabel("Customer asset summary");
      await expect(summary).toContainText(new RegExp(`Assets\\s*${expected.fromMetrics}`));
    } finally {
      await admin.context.close();
    }
  });
});
