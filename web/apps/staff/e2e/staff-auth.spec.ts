import { createHmac } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const roleCases = [
  {
    role: "SUPER_ADMIN",
    email: "super.admin@example.test",
    modules: [
      "Dashboard", "Analytics", "Assets", "Inspections", "Certificates",
      "Retest Schedule", "Sync Queue", "Customers", "Products", "Reference Data",
      "Users & Roles", "Devices", "Audit Log"
    ]
  },
  {
    role: "HMS_ADMIN",
    email: "hms.admin@example.test",
    modules: [
      "Dashboard", "Analytics", "Assets", "Inspections", "Certificates",
      "Retest Schedule", "Customers", "Products", "Reference Data", "Users & Roles",
      "Devices", "Audit Log"
    ]
  },
  {
    role: "INSPECTOR",
    email: "inspector@example.test",
    modules: ["Dashboard", "Assets", "Inspections", "Retest Schedule", "Sync Queue", "Customers"]
  },
  {
    role: "ASSEMBLY",
    email: "assembly@example.test",
    modules: ["Dashboard", "Assets", "Retest Schedule", "Customers"]
  },
  {
    role: "REVIEWER",
    email: "reviewer@example.test",
    modules: ["Dashboard", "Assets", "Inspections", "Certificates", "Retest Schedule", "Customers"]
  },
  {
    role: "CUSTOMER_USER",
    email: "customer.user@example.test",
    modules: ["Dashboard", "Assets", "Inspections", "Certificates", "Retest Schedule", "Customers"]
  }
] as const;

const everyModule = [
  "Dashboard", "Analytics", "Assets", "Inspections", "Certificates", "Retest Schedule",
  "Sync Queue", "Customers", "Products", "Reference Data", "Users & Roles", "Devices",
  "Audit Log"
] as const;

function credentials(): Record<string, string> {
  const value = process.env.HMS_E2E_ACCOUNTS_JSON;
  if (!value) {
    throw new Error("Development account credentials were not initialized.");
  }
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
  if (seconds % 30 >= 27) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("staff browser authentication and role workspaces", () => {
  test.describe.configure({ mode: "serial" });

  for (const [index, account] of roleCases.entries()) {
    test(`${account.role} completes first login, role navigation, refresh login, and logout`, async ({ page, context }) => {
      await context.clearCookies();
      await page.goto("/");

      const temporaryPassword = credentials()[account.email];
      const permanentPassword = `Orbit-Cobalt-${47 + index}!Harbor`;
      await signIn(page, account.email, temporaryPassword);

      await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
      await page.getByLabel("New password").fill(permanentPassword);
      await page.getByLabel("Confirm password").fill(permanentPassword);
      await page.getByRole("button", { name: "Set password" }).click();

      await expect(page.getByRole("heading", { name: "Set up authenticator" })).toBeVisible();
      const secret = (await page.locator(".auth-manual-key code").innerText()).trim();
      await page.getByLabel("Authentication code").fill(await totp(secret));
      await page.getByRole("button", { name: "Verify & finish" }).click();

      await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
      await page.getByLabel("I have saved my recovery codes.").check();
      await page.getByRole("button", { name: "Continue to HMS" }).click();
      await expect(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();

      const navigation = page.getByRole("navigation", { name: "Primary navigation" });
      for (const moduleName of account.modules) {
        await expect(navigation.getByRole("button", { name: moduleName, exact: true })).toBeVisible();
      }
      for (const moduleName of everyModule.filter((name) => !account.modules.includes(name as never))) {
        await expect(navigation.getByRole("button", { name: moduleName, exact: true })).toHaveCount(0);
      }

      await page.getByRole("button", { name: "Sign out" }).first().click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

      await signIn(page, account.email, permanentPassword);
      await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
      await page.getByLabel("Authentication code").fill(await totp(secret));
      await page.getByRole("button", { name: "Verify" }).click();
      await expect(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();

      await page.getByRole("button", { name: "User menu" }).click();
      await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });
  }
});
