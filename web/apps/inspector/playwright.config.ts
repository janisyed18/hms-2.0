import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  outputDir: "test-results/artifacts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "test-results/report" }]
  ],
  use: {
    baseURL: "http://127.0.0.1:5174",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5174",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "narrow-320", use: { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true } },
    { name: "tablet-portrait", use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: "tablet-landscape", use: { viewport: { width: 1024, height: 768 }, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } }
  ]
});
