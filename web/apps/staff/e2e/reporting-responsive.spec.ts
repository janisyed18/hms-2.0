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
        await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
        if (view === "dashboard") {
          // Measuring before this table exists would have missed the regression that
          // prompted this spec. A CSS table treats a specified width as a minimum, so one
          // that is not inside a clipping wrapper lays out at its content width and
          // widens the page at the narrower breakpoints.
          await expect(
            page.getByRole("table", { name: /Recorded activity by/ })
          ).toBeAttached();
          await expect(page.getByLabel("Operational trend legend")).toBeVisible();
        } else {
          await expect(page.getByText("Fleet retest status")).toBeVisible();
        }
        for (const [width, height] of WIDTHS) {
          await page.setViewportSize({ width, height });
          const plain = await pageOverflow(page);
          expect(
            plain.scrollWidth,
            `${view} at ${width}px is ${plain.scrollWidth}px wide: ${JSON.stringify(plain.widest)}`
          ).toBeLessThanOrEqual(width + 1);

          // Again with the notification panel open, which is how the overflow was first
          // seen: the panel is the widest overlay the workspace can show.
          const bell = page.getByRole("button", { name: /^Notifications/ });
          await bell.click();
          const panel = page.getByRole("dialog", { name: "Notifications" });
          await expect(panel).toBeVisible();
          const withPanel = await pageOverflow(page);
          expect(
            withPanel.scrollWidth,
            `${view} at ${width}px with the notification panel open is ${withPanel.scrollWidth}px wide: ${JSON.stringify(withPanel.widest)}`
          ).toBeLessThanOrEqual(width + 1);
          await page.keyboard.press("Escape");
          await expect(panel).toHaveCount(0);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    } finally {
      await admin.context.close();
    }
  });
});
