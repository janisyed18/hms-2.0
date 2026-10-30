import { expect, test } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

test.describe("portal disabled controls", () => {
  test.beforeAll(async () => {
    await waitForApiHealth();
  });

  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    clearRateLimits();
  });

  test("the booking asset control is visibly disabled until a location is chosen", async ({ browser }) => {
    test.setTimeout(180_000);
    const customer = await signedInPage(browser, "customer.user@example.test", permanentPasswords.customer);
    const page = customer.page;
    page.setDefaultTimeout(15_000);

    try {
      await page.goto("/portal/?view=bookings");
      const asset = page.getByRole("combobox", { name: "Booking asset" });
      await expect(asset).toBeVisible();
      await expect(asset).toBeDisabled();

      const visual = await asset.evaluate((input) => {
        const inputStyle = getComputedStyle(input);
        const shellStyle = getComputedStyle(input.parentElement!);
        return {
          background: inputStyle.backgroundColor,
          borderWidth: inputStyle.borderTopWidth,
          color: inputStyle.color,
          cursor: inputStyle.cursor,
          shellColor: shellStyle.color
        };
      });

      expect(visual.background).toBe("rgba(0, 0, 0, 0)");
      expect(visual.borderWidth).toBe("0px");
      expect(visual.color).toBe(visual.shellColor);
      expect(visual.cursor).toBe("not-allowed");
    } finally {
      await customer.context.close();
    }
  });
});
