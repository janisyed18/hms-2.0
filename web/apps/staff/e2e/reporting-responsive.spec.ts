import { expect, test, type Page } from "@playwright/test";

import { clearRateLimits, resetAuthTestAccounts } from "./global-setup";
import {
  activatedAccounts,
  activePasswords,
  authenticatorSecrets,
  permanentPasswords,
  signedInPage,
  waitForApiHealth
} from "./schedulingSupport";

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 800], [768, 1024], [390, 844]];

/**
 * Whatever is sticking out past the viewport, named, so a failure says which element is
 * at fault instead of only that the page is too wide. Anything clipped by an ancestor
 * (a panel that scrolls its own content, or a visually hidden wrapper) does not widen
 * the page and is not reported.
 */
async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const widest: Array<{ element: string; right: number; width: number }> = [];
    if (document.documentElement.scrollWidth <= viewport + 1) {
      return { viewport, scrollWidth: document.documentElement.scrollWidth, widest };
    }
    document.querySelectorAll<HTMLElement>("*").forEach((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= viewport + 1) {
        return;
      }
      // Clipped by an ancestor, so it cannot be what grew the document.
      let parent = element.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if (style.overflowX !== "visible" || style.position === "absolute") {
          return;
        }
        parent = parent.parentElement;
      }
      const classes = element.className && typeof element.className === "string"
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
      widest.push({
        element: `${element.tagName.toLowerCase()}${classes}`,
        right: Math.round(box.right),
        width: Math.round(box.width)
      });
    });
    return { viewport, scrollWidth: document.documentElement.scrollWidth, widest: widest.slice(0, 8) };
  });
}

test.describe("reporting workspaces fit every supported width", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => { await waitForApiHealth(); });
  test.beforeEach(() => {
    process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
    activatedAccounts.clear();
    activePasswords.clear();
    authenticatorSecrets.clear();
    clearRateLimits();
  });

  test("the dashboard and analytics never widen the page", async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await signedInPage(browser, "hms.admin@example.test", permanentPasswords.admin);
    const page = admin.page;
    page.setDefaultTimeout(20_000);
    try {
      for (const view of ["dashboard", "analytics"] as const) {
        await page.goto(`/?view=${view}`);
        // The reporting panels carry a visually hidden data table of the activity
        // figures. A CSS table treats a specified width as a minimum, so one that is not
        // inside a clipping wrapper lays out at its content width and widens the page at
        // the narrower breakpoints, which is what this guards.
        await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
        for (const [width, height] of WIDTHS) {
          await page.setViewportSize({ width, height });
          const overflow = await pageOverflow(page);
          expect(
            overflow.scrollWidth,
            `${view} at ${width}px is ${overflow.scrollWidth}px wide: ${JSON.stringify(overflow.widest)}`
          ).toBeLessThanOrEqual(width + 1);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    } finally {
      await admin.context.close();
    }
  });
});
