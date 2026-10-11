// Playwright settings for the app's OWN smoke test (tests/smoke.spec.ts, written by the build
// agent), run with our Playwright against our static server. Runs INSIDE the deliver sandbox.
// The app's own playwright.config.ts is never used: it could start servers or change how the
// browser launches. Never set chromiumSandbox: true or a channel here (see contract.config.ts).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./app-smoke/tests",
  testMatch: "smoke.spec.ts",
  timeout: 60_000,
  workers: 1,
  // The test is agent-written and may be a little flaky; one second try is fair.
  retries: 1,
  reporter: [["list"]],
  outputDir: process.env.PW_OUT ?? "./test-results",
  use: { baseURL: process.env.SMOKE_BASE_URL, headless: true },
});
