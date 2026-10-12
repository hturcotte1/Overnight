// The page's script (public/app.js), tried in a real browser against pages made by the real
// views. No port is opened and no data folder is read: the headless browser's requests are
// answered from memory, under the same rules for what a page may load that the server sends.
// Every title, quote and time on these pages is invented (test/fixtures.ts).
//
// `page.evaluate` is given text, not functions: this repo is type-checked without the browser's types.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderIdea } from "../src/render/idea.ts";
import { renderDocument } from "../src/render/layout.ts";
import { renderProblem } from "../src/render/problem.ts";
import { renderToday } from "../src/render/today.ts";
import type { Chrome, Story } from "../src/types.ts";
import { boise, fakeChrome, fakeEvents, fakeExtras, fakeSnapshot, NOW, scene } from "./fixtures.ts";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://dashboard.invalid";
const CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Is Playwright's headless browser on this Mac? Without it these tests are skipped, as the morning check's are. */
function browserInstalled(): boolean {
  const folders = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(homedir(), "Library/Caches/ms-playwright"), path.join(homedir(), ".cache/ms-playwright")];
  return folders.some((folder) => folder !== undefined && existsSync(folder) && readdirSync(folder).some((name) => name.startsWith("chromium_headless_shell-")));
}

const ASSETS: Readonly<Record<string, { type: string; body: Buffer }>> = {
  "/assets/app.css": { type: "text/css; charset=utf-8", body: readFileSync(path.join(PACKAGE, "public/app.css")) },
  "/assets/app.js": { type: "text/javascript; charset=utf-8", body: readFileSync(path.join(PACKAGE, "public/app.js")) },
  "/assets/icon.svg": { type: "image/svg+xml", body: readFileSync(path.join(PACKAGE, "public/icon.svg")) },
};
const PICTURE = readFileSync(path.join(PACKAGE, "test/reference/shot.png"));

/** A stand-in for the dashboard's server: one page, changed by the test between looks. */
interface Pretend {
  text: string;
  /** What the page's address answers with. */
  status: 200 | 401 | 500;
  /** True: nothing answers at all, as when the dashboard was stopped. */
  down: boolean;
  /** Every request for the page, with the tag it carried. */
  asked: Array<string | undefined>;
  /** How long the page takes to answer. */
  slowMs: number;
}

const tagOf = (text: string): string => `"${createHash("sha1").update(text).digest("hex")}"`;

async function answer(site: Pretend, route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  const asset = ASSETS[url.pathname];
  if (asset !== undefined) return route.fulfill({ status: 200, contentType: asset.type, body: asset.body });
  if (url.pathname.startsWith("/shots/")) return route.fulfill({ status: 200, contentType: "image/png", body: PICTURE });
  if (url.pathname !== "/page") return route.fulfill({ status: 404, body: "" });
  const carried = route.request().headers()["if-none-match"];
  site.asked.push(carried);
  if (site.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, site.slowMs));
  if (site.down) return route.abort("connectionrefused");
  if (site.status !== 200) return route.fulfill({ status: site.status, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": CSP }, body: "<!doctype html><title>no</title>" });
  const etag = tagOf(site.text);
  if (carried === etag) return route.fulfill({ status: 304, headers: { etag } });
  return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { etag, "content-security-policy": CSP }, body: site.text });
}

/** The real pages look again every 2 or 5 seconds. For the tests they look every tenth of a second. */
const fast = (text: string): string => text.replace(/data-poll-ms="\d+"/, 'data-poll-ms="100"');

type Scene = ReturnType<typeof scene>;

function todayPage(sc: Scene = scene(), chrome: Partial<Chrome> = {}): string {
  return fast(renderDocument(renderToday(sc.s, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c, sc.thumbs), fakeChrome(chrome)).text);
}

describe.skipIf(!browserInstalled())("public/app.js in a browser", { timeout: 30_000 }, () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    await browser?.close();
  });

  /** Opens the pretend dashboard's page. `errors` collects what the browser's console and the page itself complain about. */
  async function open(text: string): Promise<{ site: Pretend; page: Page; errors: string[] }> {
    const site: Pretend = { text, status: 200, down: false, asked: [], slowMs: 0 };
    // The browser is put in another time zone than the pages are, so a time shown in the browser's own zone would be caught.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "Asia/Tokyo" });
    contexts.push(context);
    await context.route("**/*", (route) => answer(site, route));
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(`page error: ${error.name}`));
    await page.goto(`${ORIGIN}/page`);
    return { site, page, errors };
  }

  const text = (page: Page, selector: string): Promise<string> => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? "(not there)"`) as Promise<string>;
  const truthy = (page: Page, expression: string): Promise<boolean> => page.evaluate(`Boolean(${expression})`) as Promise<boolean>;
  /**
   * Waits until something is true on the page, asking from here. Playwright's own waitForFunction
   * cannot be used with text: it runs the text with eval inside the page, which the page's rules refuse.
   */
  const until = (page: Page, expression: string): Promise<void> => expect.poll(() => truthy(page, expression), { timeout: 5_000, interval: 25 }).toBe(true);
  const looksSince = async (page: Page, site: Pretend, more: number): Promise<void> => {
    const from = site.asked.length;
    await expect.poll(() => site.asked.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + more);
    await page.waitForTimeout(50);
  };

  it("sets every clock by the server's time, which here is a pretend 1:02 AM, and keeps them going", async () => {
    const { page, errors } = await open(todayPage());
    await until(page, `document.querySelector("#story .hero__clock time")?.classList.contains("on")`);
    // The build began at 1:00:48 and the server says it is 1:02:00, whatever this Mac's own clock says.
    expect(await text(page, "#story .hero__clock time")).toMatch(/^1:1[2-4]$/);
    expect(await text(page, '#story [data-check="agent"] time')).toMatch(/^1:1[2-4]$/);
    expect(await text(page, "#lane-heard [data-since]")).toBe("2 h ago");
    expect(await text(page, '#clock [data-clock="wall"]')).toBe("1:02 AM");
    expect(await text(page, "#story .hero__wall")).toBe("1:02 AM");
    const before = await text(page, "#story .hero__clock time");
    await until(page, `document.querySelector("#story .hero__clock time").textContent !== ${JSON.stringify(before)}`);
    expect(await text(page, "#story .hero__clock time")).toMatch(/^1:1[3-6]$/);
    expect(errors).toEqual([]);
  });

  it("writes a short time as seconds, a long one with its hours, and leaves words it cannot read alone", async () => {
    const sc = scene();
    const story: Story = { ...sc.hero.story, runningSince: boise(10, 23, 59, 53), checks: [{ key: "odd", label: "Odd", status: "active", detail: null, since: "not a time" }] };
    const s = { ...sc.s, lastHeardAt: boise(11, 1, 1, 48) };
    const { page, errors } = await open(fast(renderDocument(renderToday(s, { ...sc.hero, story }, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c), fakeChrome()).text));
    await until(page, `document.querySelector("#story .hero__clock time")?.classList.contains("on")`);
    expect(await text(page, "#story .hero__clock time")).toMatch(/^1:02:0[7-9]$/);
    expect(await text(page, "#lane-heard [data-since]")).toMatch(/^1[2-4] s ago$/);
    expect(await text(page, '#story [data-check="odd"] time')).toBe("since unknown time");
    expect(errors).toEqual([]);
  });

  it("asks again with the tag it was given, and leaves a page that has not changed exactly as it is", async () => {
    const page1 = todayPage();
    const { site, page, errors } = await open(page1);
    await page.evaluate(`document.getElementById("story").mark = "same"; document.getElementById("pills").mark = "same"`);
    await looksSince(page, site, 3);
    // The browser's own first request, then the script's first look (it has no tag yet), then looks that carry the tag.
    expect(site.asked.slice(0, 2)).toEqual([undefined, undefined]);
    expect(site.asked.slice(2).every((tag) => tag === tagOf(page1))).toBe(true);
    expect(await page.evaluate(`[document.getElementById("story").mark, document.getElementById("pills").mark]`)).toEqual(["same", "same"]);
    expect(await truthy(page, `document.getElementById("notice").hidden`)).toBe(true);
    expect(await truthy(page, `document.querySelector(".pop")`)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("moves in only the part that changed, and pops the step and the ticks that changed", async () => {
    const sc = scene();
    const { site, page, errors } = await open(todayPage(sc));
    await page.evaluate(`document.getElementById("story").mark = "old"; document.getElementById("lane-heard").mark = "old"; document.querySelector("main").mark = "old"`);

    // The build finishes: the step is done, the "Built" tick turns, and a new tick appears.
    const built: Story = {
      ...sc.hero.story,
      runningSince: null,
      runningLabel: null,
      steps: sc.hero.story.steps.map((step) => (step.key === "built" ? { ...step, status: "done", label: "Built", detail: "Kiro Crew · 2 min 40 s" } : step)),
      checks: [...sc.hero.story.checks.slice(0, 2), { key: "built", label: "Built", status: "done", detail: null, since: null }, { key: "checked", label: "Checked in the sandbox", status: "todo", detail: null, since: null }],
    };
    site.text = todayPage({ ...sc, hero: { ...sc.hero, story: built } });
    await until(page, `document.querySelector('#story [data-step="built"]')?.dataset.status === "done"`);

    expect(await page.evaluate(`[document.getElementById("story").mark ?? null, document.getElementById("lane-heard").mark, document.querySelector("main").mark]`)).toEqual([null, "old", "old"]);
    const popped = (selector: string): Promise<boolean> => truthy(page, `document.querySelector(${JSON.stringify(selector)}).classList.contains("pop")`);
    expect(await popped('#story [data-step="built"]')).toBe(true);
    expect(await popped('#story [data-step="heard"]')).toBe(false);
    expect(await popped('#story [data-step="checked"]')).toBe(false);
    expect(await popped('#story [data-check="built"]')).toBe(true); // was to do, is done
    expect(await popped('#story [data-check="checked"]')).toBe(true); // new for an idea already on screen
    expect(await popped('#story [data-check="sign-in"]')).toBe(false);
    expect(await truthy(page, `document.querySelector("#story .hero__clock")`)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("pops nothing when another idea takes the hero's place", async () => {
    const sc = scene();
    const { site, page } = await open(todayPage(sc));
    const packing = sc.ideas.packing;
    const story = sc.stories.get(packing.id);
    if (story === undefined) throw new Error("the scene has no story for the delivered idea");
    const ticked: Story = { ...story, checks: [{ key: "told", label: "Sent to the wrist", status: "done", detail: null, since: null }] };
    site.text = todayPage({ ...sc, hero: { idea: packing, story: ticked, extras: fakeExtras() }, line: { over: "This morning", before: "", title: packing.title, after: "was delivered" } });
    await until(page, `document.querySelector("#story .hero__now")?.textContent.includes("Packing Checklist")`);
    expect(await truthy(page, `document.querySelector('#story [data-check="told"]')`)).toBe(true);
    expect(await truthy(page, `document.querySelector(".pop")`)).toBe(false);
  });

  it("keeps the brief and the notes open when they were opened, through a change", async () => {
    const sc = scene();
    const packing = sc.ideas.packing;
    const story = sc.stories.get(packing.id) ?? sc.hero.story;
    const events = fakeEvents(packing, ["heard", "asked", "approved", "building", "built", "published", "delivered"]);
    const ideaPage = (notes: string): string =>
      fast(renderDocument(renderIdea(sc.s, packing, story, fakeExtras({ brief: { text: "The brief, as it was written.", cut: false }, notes: { text: notes, cut: false } }), events, sc.c), fakeChrome({ current: "ideas" })).text);
    const { site, page, errors } = await open(ideaPage("First notes."));
    expect(await page.evaluate(`[document.getElementById("brief-text").open, document.getElementById("notes-text").open]`)).toEqual([false, false]);
    await page.evaluate(`document.getElementById("brief-text").open = true; document.getElementById("notes-text").open = true`);

    site.text = ideaPage("Second notes.");
    await until(page, `document.querySelector("#notes pre")?.textContent === "Second notes."`);
    expect(await page.evaluate(`[document.getElementById("brief-text").open, document.getElementById("notes-text").open]`)).toEqual([true, true]);
    expect(await text(page, "#brief pre")).toBe("The brief, as it was written.");
    expect(errors).toEqual([]);
  });

  it("replaces the whole middle when the page turns from nothing saved yet into a day with data", async () => {
    const sc = scene();
    const nothing = fast(renderDocument(renderToday(fakeSnapshot({ problem: "missing" }), null, sc.line, null, sc.queue, new Map(), sc.c), fakeChrome({ problem: "missing", running: { listener: false, build: false, deliver: false } })).text);
    const { site, page, errors } = await open(nothing);
    expect(await text(page, "#empty h1")).toBe("Nothing saved yet");
    expect(await text(page, '#pills [data-pill="listening"]')).toBe("Not listening");

    site.text = todayPage(sc);
    await until(page, `document.querySelector("#story .hero__now")`);
    expect(await truthy(page, `document.getElementById("empty")`)).toBe(false);
    expect(await text(page, "#story .hero__now")).toBe("Kiro Crew is building “Chore Wheel”");
    expect(await text(page, '#pills [data-pill="listening"]')).toBe("Listening");
    // The clocks in the new middle are running at once.
    expect(await text(page, "#story .hero__clock time")).toMatch(/^1:1\d$/);
    expect(errors).toEqual([]);
  });

  it("takes the server's time anew with every new page", async () => {
    const { site, page } = await open(todayPage());
    await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`);
    expect(await text(page, '#clock [data-clock="wall"]')).toBe("1:02 AM");
    site.text = todayPage(scene(), { nowMs: NOW.getTime() + 60 * 60_000, paused: true });
    await until(page, `document.querySelector('#pills [data-pill="paused"]')`);
    expect(await text(page, '#clock [data-clock="wall"]')).toBe("2:02 AM");
    expect(await text(page, "#story .hero__wall")).toBe("2:02 AM");
    expect(await text(page, "#story .hero__clock time")).toMatch(/^1:01:1\d$/);
  });

  it("says so when the dashboard stops answering or no longer knows its key, and takes it back when it answers", async () => {
    const { site, page } = await open(todayPage());
    const noticeShown = (): Promise<boolean> => truthy(page, `!document.getElementById("notice").hidden`);
    expect(await noticeShown()).toBe(false);

    site.status = 401;
    await until(page, `!document.getElementById("notice").hidden`);
    expect(await text(page, "#notice")).toBe("The dashboard has stopped or was restarted. Open its new link.");
    // What was on the page stays on the page.
    expect(await text(page, "#story .hero__now")).toBe("Kiro Crew is building “Chore Wheel”");

    site.status = 200;
    await until(page, `document.getElementById("notice").hidden`);

    site.down = true;
    await until(page, `!document.getElementById("notice").hidden`);
    site.down = false;
    await until(page, `document.getElementById("notice").hidden`);

    // One page that could not be made is not the dashboard stopping: it just looks again.
    site.status = 500;
    await looksSince(page, site, 3);
    expect(await noticeShown()).toBe(false);
  });

  it("looks at once when the tab is looked at again, never while it is hidden, and never twice at the same time", async () => {
    // This page would look again only after a minute, so every look here comes from the tab being shown.
    const { site, page } = await open(todayPage().replace('data-poll-ms="100"', 'data-poll-ms="60000"'));
    await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`);
    expect(site.asked).toHaveLength(1);
    const shown = `document.dispatchEvent(new Event("visibilitychange"))`;

    await page.evaluate(shown);
    await expect.poll(() => site.asked.length, { timeout: 5_000 }).toBe(2);

    await page.evaluate(`Object.defineProperty(document, "hidden", { value: true, configurable: true }); ${shown}`);
    await page.waitForTimeout(150);
    expect(site.asked).toHaveLength(2);

    site.slowMs = 400;
    await page.evaluate(`Object.defineProperty(document, "hidden", { value: false, configurable: true }); for (let i = 0; i < 5; i += 1) ${shown}`);
    await page.waitForTimeout(150);
    expect(site.asked).toHaveLength(3);
  });

  it("does not ask again for a page with nothing live in its middle, and still shows the time", async () => {
    const { site, page, errors } = await open(fast(renderDocument(renderProblem("not-found", { port: 4321 }), fakeChrome({ current: "none" })).text));
    await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`);
    await page.waitForTimeout(500);
    expect(site.asked).toHaveLength(1);
    expect(await text(page, '#clock [data-clock="wall"]')).toBe("1:02 AM");
    expect(await truthy(page, `document.getElementById("notice").hidden`)).toBe(true);
    expect(errors).toEqual([]);
  });
});
