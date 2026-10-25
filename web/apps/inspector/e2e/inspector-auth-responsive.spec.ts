import { expect, test, type Page } from "@playwright/test";

type AuthScreen =
  | "sign-in"
  | "validation-error"
  | "forgot-password"
  | "password-change"
  | "mfa-setup"
  | "mfa-code"
  | "recovery-code"
  | "recovery-codes"
  | "access-denied"
  | "pending";

const challenge = "browser-auth-challenge";

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function installAuthApi(page: Page, screen: AuthScreen) {
  await page.route("**/api/v1/auth/browser/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/refresh")) {
      await route.fulfill(json({ detail: "No session" }, 401));
      return;
    }

    if (path.endsWith("/password/reset-request")) {
      await route.fulfill(json({ message: "If the account exists, a reset link is on its way." }));
      return;
    }

    if (path.endsWith("/mfa/enrollment")) {
      await route.fulfill(json({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge,
        otpauth_uri: "otpauth://totp/HMS?secret=ABC123",
        manual_key: "ABCD EFGH IJKL MNOP"
      }));
      return;
    }

    if (path.endsWith("/mfa/confirm")) {
      await route.fulfill(json({
        next_step: "RECOVERY_CODES",
        access_token: "inspector-token",
        expires_in: 900,
        recovery_codes: ["recovery-code-for-a-narrow-screen-0001", "recovery-code-for-a-narrow-screen-0002"]
      }));
      return;
    }

    if (path.endsWith("/me")) {
      await route.fulfill(json({
        user_id: "inspector-1",
        email: "inspector@example.test",
        display_name: "Field Inspector",
        roles: screen === "access-denied" ? ["CUSTOMER"] : ["INSPECTOR"]
      }));
      return;
    }

    if (path.endsWith("/login")) {
      if (screen === "validation-error") {
        await route.fulfill(json({ detail: "The supplied email or password is not valid for this inspector account." }, 401));
        return;
      }
      if (screen === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (screen === "password-change") {
        await route.fulfill(json({ next_step: "PASSWORD_CHANGE_REQUIRED", challenge, expires_in: 900 }));
        return;
      }
      if (screen === "mfa-setup" || screen === "recovery-codes") {
        await route.fulfill(json({ next_step: "MFA_ENROLLMENT_REQUIRED", challenge, expires_in: 900 }));
        return;
      }
      if (screen === "mfa-code" || screen === "recovery-code") {
        await route.fulfill(json({ next_step: "MFA_REQUIRED", challenge, expires_in: 900 }));
        return;
      }
      await route.fulfill(json({
        next_step: "AUTHENTICATED",
        access_token: "inspector-token",
        token_type: "bearer",
        expires_in: 900
      }));
      return;
    }

    await route.fulfill(json({ detail: `Unexpected auth endpoint: ${path}` }, 404));
  });
}

async function expectNoOverflow(page: Page) {
  const layout = await page.locator(".inspector-auth__panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      panelWithinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1
    };
  });
  expect(layout.horizontalOverflow).toBeFalsy();
  expect(layout.panelWithinViewport).toBeTruthy();
}

async function signIn(page: Page) {
  await page.getByLabel("Email").fill("inspector@example.test");
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function openScreen(page: Page, screen: AuthScreen) {
  await installAuthApi(page, screen);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inspector sign in" })).toBeVisible();

  if (screen === "forgot-password") {
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByLabel("Email").fill("inspector@example.test");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    return;
  }

  if (screen === "sign-in") return;

  await signIn(page);

  if (screen === "validation-error") {
    await expect(page.getByRole("alert")).toContainText("not valid");
  } else if (screen === "password-change") {
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  } else if (screen === "mfa-setup") {
    await expect(page.getByRole("heading", { name: "Set up authenticator" })).toBeVisible();
    await expect(page.getByText("ABCD EFGH IJKL MNOP")).toBeVisible();
  } else if (screen === "mfa-code" || screen === "recovery-code") {
    await expect(page.getByRole("heading", { name: "Verify your sign in" })).toBeVisible();
    if (screen === "recovery-code") {
      await page.getByRole("button", { name: "Use recovery code" }).click();
      await expect(page.getByLabel("Recovery code")).toBeVisible();
    }
  } else if (screen === "recovery-codes") {
    await expect(page.getByRole("heading", { name: "Set up authenticator" })).toBeVisible();
    await page.getByLabel("Authentication code").fill("123456");
    await page.getByRole("button", { name: "Verify authenticator" }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  } else if (screen === "access-denied") {
    await expect(page.getByRole("heading", { name: "Inspector access required" })).toBeVisible();
  } else if (screen === "pending") {
    await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  }
}

for (const screen of [
  "sign-in",
  "validation-error",
  "forgot-password",
  "password-change",
  "mfa-setup",
  "mfa-code",
  "recovery-code",
  "recovery-codes",
  "access-denied",
  "pending"
] as const) {
  test(`${screen} is responsive and readable`, async ({ page }) => {
    await openScreen(page, screen);
    await expectNoOverflow(page);
  });
}

test("sign-in supports keyboard focus and touch-safe inputs", async ({ page }) => {
  await openScreen(page, "sign-in");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.getByLabel("Email").focus();
  await expectNoOverflow(page);
  await expect(page.getByLabel("Email")).toHaveCSS("font-size", "16px");
});

test("reduced-motion mode keeps the auth page usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openScreen(page, "mfa-code");
  await expectNoOverflow(page);
});
