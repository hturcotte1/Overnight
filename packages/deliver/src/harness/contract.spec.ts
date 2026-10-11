// Overnight's own contract test for a built app. Runs INSIDE the deliver sandbox, in the Chromium
// headless shell, against our static server.
//
// It only MEASURES: it loads the page at a phone size and a desktop size, counts what went wrong,
// takes the two screenshots and prints one line of numbers. The verifier (outside the sandbox)
// decides from that line whether the app may be published. Nothing the page says is printed:
// counts and yes/no only, so page text can never reach our logs.
//
// Env: BASE_URL (http://127.0.0.1:<port>/), SHOT_DIR (where the screenshots go).
import { test } from "@playwright/test";
import type { Browser, BrowserContextOptions } from "@playwright/test";

/** The start of the one result line. Keep in step with CONTRACT_MARKER in ../contract.ts. */
const MARKER = "OVERNIGHT_CONTRACT ";

const BASE_URL = process.env.BASE_URL ?? "";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";

interface ViewMeasure {
  loaded: boolean;
  status: number;
  headingVisible: boolean;
  visibleTextChars: number;
  /** How many CSS pixels wider than the screen the page is. 0 when it fits; -1 when unknown. */
  overflowPx: number;
  requests: number;
  nonLocalRequests: number;
  failedRequests: number;
  consoleErrors: number;
  pageErrors: number;
  screenshot: boolean;
  ms: number;
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function measure(browser: Browser, size: { width: number; height: number }, options: BrowserContextOptions, shotFile: string): Promise<ViewMeasure> {
  const m: ViewMeasure = {
    loaded: false,
    status: 0,
    headingVisible: false,
    visibleTextChars: 0,
    overflowPx: -1,
    requests: 0,
    nonLocalRequests: 0,
    failedRequests: 0,
    consoleErrors: 0,
    pageErrors: 0,
    screenshot: false,
    ms: 0,
  };
  const started = Date.now();
  const base = new URL(BASE_URL);
  /** Our own static server, or something that never leaves the page (data:, blob:, about:). */
  const isOurs = (raw: string): boolean => {
    try {
      const url = new URL(raw);
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
      return url.host === base.host;
    } catch {
      return false;
    }
  };

  // Service workers are blocked so that every request goes through the route below.
  const context = await browser.newContext({ ...options, viewport: size, serviceWorkers: "block" });
  try {
    // Block every request that is not to our server, and count that it was attempted.
    await context.route("**/*", (route) => {
      if (isOurs(route.request().url())) return route.continue();
      m.nonLocalRequests += 1;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") m.consoleErrors += 1;
    });
    page.on("pageerror", () => {
      m.pageErrors += 1;
    });
    page.on("request", () => {
      m.requests += 1;
    });
    page.on("requestfailed", () => {
      m.failedRequests += 1;
    });
    page.on("response", (response) => {
      if (response.status() >= 400) m.failedRequests += 1;
    });
    page.on("websocket", (socket) => {
      if (!isOurs(socket.url())) m.nonLocalRequests += 1;
    });

    const response = await page.goto(BASE_URL, { waitUntil: "load", timeout: 30_000 }).catch(() => null);
    m.status = response?.status() ?? 0;
    m.loaded = m.status === 200;
    if (m.loaded) {
      // Give late requests and first renders a moment to show up.
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
      m.headingVisible = await page
        .getByRole("heading")
        .first()
        .isVisible()
        .catch(() => false);
      // Passed as text, not a function: this file is type-checked without the browser's types.
      m.visibleTextChars = Number(await page.evaluate("document.body ? document.body.innerText.trim().length : 0").catch(() => 0));
      // A page with no viewport tag lays out wider than the phone; so does one that needs sideways scrolling.
      const widest = Number(await page.evaluate("Math.max(document.documentElement.scrollWidth, window.innerWidth)").catch(() => Number.NaN));
      m.overflowPx = Number.isFinite(widest) ? Math.max(0, Math.ceil(widest - size.width)) : -1;
      m.screenshot = await page.screenshot({ path: `${SHOT_DIR}/${shotFile}` }).then(
        () => true,
        () => false,
      );
    }
  } finally {
    await context.close().catch(() => {});
    m.ms = Date.now() - started;
  }
  return m;
}

test("the built app loads cleanly on a phone and on a desktop", async ({ browser }) => {
  const phone = await measure(browser, PHONE, { deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "phone.png");
  const desktop = await measure(browser, DESKTOP, {}, "desktop.png");
  console.log(MARKER + JSON.stringify({ phone, desktop }));
});
