// Run against Vite previews of both builds; no credentials or backend writes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const output = process.env.HMS_SCREENSHOT_DIR ?? "/tmp/hms-auth-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, url, audience] of [
    ["staff", process.env.HMS_STAFF_BASE_URL ?? "http://127.0.0.1:4184/", "Staff workspace"],
    ["portal", process.env.HMS_PORTAL_BASE_URL ?? "http://127.0.0.1:4185/portal/portal.html", "Customer portal"]
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.fulfill({
      status: route.request().url().endsWith("reset-request") ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().endsWith("reset-request")
        ? { message: "If that email exists, a password reset link has been sent." }
        : { detail: "Invalid email or password" })
    }));
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 720]]) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await expect(page.getByText(audience, { exact: true })).toBeVisible();
      await expect(page.getByAltText("Momentum")).toHaveCount(1);
      assert(await page.getByAltText("Momentum").evaluate(img => img.complete && img.naturalWidth > 0));
      const email = page.getByRole("textbox", { name: "Email", exact: true });
      const password = page.getByLabel("Password", { exact: true });
      const submit = page.getByRole("button", { name: "Sign in securely" });
      await expect(submit).toBeDisabled();
      await email.focus();
      await page.keyboard.press("Tab");
      await expect(password).toBeFocused();
      await email.fill("browser-check@example.invalid");
      await password.fill("not-a-real-password");
      await expect(submit).toBeEnabled();
      await expect(submit).toHaveCSS("background-color", "rgb(31, 95, 191)");
      await expect(submit).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCSS("color", "rgb(16, 24, 40)");
      await expect(email).toHaveCSS("color", "rgb(16, 24, 40)");
      await expect(page.locator(".auth-shell")).not.toHaveCSS("font-family", /Times/);
      for (const control of [email, password, submit]) {
        const box = await control.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width && box.height >= 44);
      }
      await page.getByRole("button", { name: "Show password" }).click();
      await expect(password).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "Hide password" }).click();
      await expect(password).toHaveAttribute("type", "password");
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
    await expect(page.getByRole("button", { name: "Sign in securely" })).toBeEnabled();
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email address" }).fill("browser-check@example.invalid");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("If that email exists, a password reset link has been sent.")).toBeVisible();
    await page.getByRole("button", { name: "Return to sign in" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${name}: 4 viewports, styles, logo, keyboard, password visibility, failed-login retry and reduced-motion recovery passed`);
  }
} finally {
  await browser.close();
}
