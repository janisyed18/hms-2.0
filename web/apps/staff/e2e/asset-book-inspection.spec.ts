import { expect, test, type Page } from "@playwright/test";

import { resetAuthTestAccounts } from "./global-setup";
import { chooseOption } from "./choose";
import { activatedAccounts, activePasswords, authenticatorSecrets, permanentPasswords, prepareSchedulingFixture, schedulingDate, signedInPage, submitBookingForm, waitForApiHealth } from "./schedulingSupport";

const navigate = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name, exact: true }).click();

/**
 * From a customer's Locations tab, follow the first location's asset count to the register narrowed to that
 * location, then open the asset at `index` in it. Returns the asset's number as the detail shows it.
 */
async function openLocationAsset(page: Page, index = 0) {
  await navigate(page, "Customers");
  await page.getByRole("button", { name: /Vopak/ }).first().click();
  await page.getByRole("tab", { name: /Locations/ }).click();
  await page.getByRole("button", { name: /^View \d+ assets? at / }).first().click();
  await expect(page).toHaveURL(/view=assets.*customer=.*location=/);
  const row = page.locator(".asset-register-table tbody tr").nth(index);
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByRole("complementary", { name: "Asset detail" });
  await expect(detail).toBeVisible();
  return (await detail.getByText("Asset number", { exact: true }).locator("xpath=following-sibling::*[1]").innerText()).trim();
}

test.describe("Customer location to asset to booking", () => {
  test.beforeAll(async () => {
    await waitForApiHealth();
  });

  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
  });

  test("a location's asset link opens that asset, and Book Inspection opens the booking form prefilled from it", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    // The location's asset count is the link; it opens the register narrowed to that customer and location.
    const assetNumber = await openLocationAsset(page);
    const detail = page.getByRole("complementary", { name: "Asset detail" });
    await expect(detail).toContainText(assetNumber);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/asset-detail.png` : undefined });

    // The header actions wrap instead of pushing the page wider on a phone.
    const wide = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail.getByRole("button", { name: "Book Inspection" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "sideways scroll at 390px").toBe(true);
    const phoneBox = await detail.getByRole("button", { name: "Edit" }).boundingBox();
    expect(phoneBox && phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 390, "Edit inside 390px").toBe(true);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/asset-detail-mobile.png` });
    if (wide) await page.setViewportSize(wide);

    await detail.getByRole("button", { name: "Book Inspection" }).click();
    const form = page.locator("form.inspection-booking-form");
    await expect(form).toBeVisible();
    await expect(page).toHaveURL(/book_asset=/);
    await expect(page.getByRole("combobox", { name: "Booking customer" })).toHaveValue("Vopak");
    await expect(page.getByLabel("Booking location")).toContainText("Port Botany");
    const ticked = form.locator("fieldset.booking-asset-list input[type=checkbox]:checked");
    await expect(ticked).toHaveCount(1);
    await expect(form.getByRole("checkbox", { name: new RegExp(assetNumber) })).toBeChecked();
    // Nothing the asset cannot supply is invented: the date and time are still the person's to choose.
    await expect(page.getByLabel("Preferred inspection date")).toHaveValue("");
    await expect(form.getByRole("button", { name: "Create booking" })).toBeDisabled();
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/booking-prefilled.png` : undefined });

    await form.getByRole("button", { name: "Close booking form" }).click();
    await expect(page).not.toHaveURL(/book_asset=/);
  });

  test("an asset id that does not exist still opens the booking form, blank, with the reason", async ({ browser }) => {
    test.setTimeout(120_000);
    const { page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    await page.evaluate(() => {
      history.pushState({}, "", "/?view=inspections&book_asset=no-such-asset");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("alert").filter({ hasText: "Asset not loaded" })).toBeVisible();
    const form = page.locator("form.inspection-booking-form");
    await expect(form).toBeVisible();
    await expect(form.locator("fieldset.booking-asset-list input[type=checkbox]:checked")).toHaveCount(0);
    await expect(page.getByLabel("Booking location")).toContainText("Choose a customer first");
  });

  test("an asset-started booking is created for that asset's own customer and location and shows in the list", async ({ browser }) => {
    test.setTimeout(240_000);
    prepareSchedulingFixture();
    const { page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const assetNumber = await openLocationAsset(page);
    await page.getByRole("complementary", { name: "Asset detail" }).getByRole("button", { name: "Book Inspection" }).click();

    const form = page.locator("form.inspection-booking-form");
    await expect(form.getByRole("checkbox", { name: new RegExp(assetNumber) })).toBeChecked();
    await page.getByLabel("Preferred inspection date").fill(schedulingDate);
    const time = page.getByLabel("Available inspection time");
    await expect(time).toBeEnabled();
    await chooseOption(time, { first: true });

    const request = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/v1/inspection-bookings"));
    await submitBookingForm(page, "Create booking", "/api/v1/inspection-bookings");
    const body = (await request).postDataJSON() as { location_id?: string; asset_ids?: string[] };
    expect(body.asset_ids).toHaveLength(1);
    expect(body.location_id).toBeTruthy();

    // The form closes, the address drops the asset, and the booking is listed with that asset.
    await expect(form).toBeHidden();
    await expect(page).not.toHaveURL(/book_asset=/);
    await expect(page.locator(".inspection-booking-list")).toContainText("Requested", { timeout: 90_000 });
    await expect(page.locator(".inspection-booking-list")).toContainText(assetNumber);
  });

  test("moving the address from one asset to another reloads the form for the second asset", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const idOf = async (index: number) => {
      await openLocationAsset(page, index);
      const id = new URL(page.url()).searchParams.get("asset");
      await page.goBack();
      return id;
    };
    const first = await idOf(0);
    const second = await idOf(1);
    expect(first && second && first !== second, "two different asset ids").toBe(true);
    const openFormNumber = async () => {
      const form = page.locator("form.inspection-booking-form");
      await expect(form).toBeVisible();
      const ticked = form.locator("fieldset.booking-asset-list input[type=checkbox]:checked");
      await expect(ticked).toHaveCount(1);
      return (await ticked.first().evaluate((box) => (box as HTMLInputElement).labels?.[0]?.textContent ?? "")).trim();
    };
    const seen: string[] = [];
    for (const id of [first, second]) {
      await page.evaluate((assetId) => {
        history.pushState({}, "", `/?view=inspections&book_asset=${assetId}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, id);
      if (!seen.length) seen.push(await openFormNumber());
    }
    // The second asset is fetched after the address moves, so wait for the form to follow it.
    await expect.poll(openFormNumber, { timeout: 30_000 }).not.toEqual(seen[0]);
  });
});
