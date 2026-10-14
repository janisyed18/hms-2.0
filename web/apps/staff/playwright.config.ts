import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/artifacts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "test-results/report" }]
  ],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: process.env.HMS_STAFF_BASE_URL ?? "http://127.0.0.1:8080",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
