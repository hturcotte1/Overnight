// Playwright settings for Overnight's own contract test. Runs INSIDE the deliver sandbox.
// Chromium headless shell with Playwright's default launch. Never set chromiumSandbox: true or a
// channel here: Chromium's own sandbox cannot start inside ours, and full Chromium crashes in it.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Playwright runs EVERY file called contract.spec.ts anywhere under this folder. That is safe
  // only because the verifier runs this from a folder holding our own files and nothing else
  // (the app's tests go in the other harness folder), and checks that before it starts.
  testDir: ".",
  testMatch: "contract.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.PW_OUT ?? "./test-results",
  use: { headless: true },
});
