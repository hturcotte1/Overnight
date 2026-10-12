// SYNTHETIC: every title, pitch, quote and line on these pages is made up by the demo's seed. None of it is Bee data.
//
// The whole dashboard in a real browser: the real server and the real site over the demo's
// stage (what `npm run dashboard:demo` shows), on a port the system picks, driven by the
// headless browser Playwright installs. Skipped when that browser is not installed, as the
// morning check's own browser tests are.
//
// `page.evaluate` is given text, not functions: this repo is type-checked without the browser's
// types. And a page condition is waited for from here (expect.poll), never with Playwright's
// waitForFunction, which runs its text with eval inside the page; the dashboard's own rules for
// what a page may run refuse that.
//
// With SHOTS_DIR=<folder> the first test also saves a picture of every view (invented data only).
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DemoIdeaKey } from "../src/demo/seed.ts";
import { openDemoStage } from "../src/demo/stage.ts";
import type { DemoStage } from "../src/demo/stage.ts";
import { browserInstalled, closeServers, pageAddresses, removeScratch, scratch, seeded, serve } from "./demo-server.ts";
import type { Served } from "./demo-server.ts";

const SHOTS_DIR = process.env.SHOTS_DIR;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
const SCHEMES = ["light", "dark"] as const;

describe.skipIf(!browserInstalled())("the dashboard in a browser", { timeout: 30_000 }, () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const stages: DemoStage[] = [];
  const others: Server[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})));
    await closeServers();
    await Promise.all(others.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    for (const stage of stages.splice(0)) stage.close();
    removeScratch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** The demo's stage, served. The pretend clock stands still unless `running` is asked for. */
  async function demo(o: { running?: boolean } = {}): Promise<{ stage: DemoStage; served: Served }> {
    const opened = Date.now();
    const stage = openDemoStage({ under: scratch(), realNow: o.running === true ? undefined : () => opened });
    stages.push(stage);
    return { stage, served: await serve(stage, { clock: stage.now }) };
  }

  interface Watched {
    page: Page;
    /** What the browser's console and the page itself complained about. */
    errors: string[];
    /** Every address the page asked for. */
    asked: string[];
    dialogs: string[];
  }

  async function newPage(o: { size?: keyof typeof SIZES; scheme?: (typeof SCHEMES)[number]; bypassCSP?: boolean } = {}): Promise<Watched> {
    // The browser is put in another time zone than the pages are, so a time shown in the browser's own zone would stand out.
    const context = await browser.newContext({ viewport: SIZES[o.size ?? "desktop"], colorScheme: o.scheme ?? "light", timezoneId: "Asia/Tokyo", deviceScaleFactor: 1, bypassCSP: o.bypassCSP === true });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const watched: Watched = { page, errors: [], asked: [], dialogs: [] };
    page.on("console", (message) => {
      if (message.type() === "error") watched.errors.push(message.text());
    });
    page.on("pageerror", (error) => watched.errors.push(`page error: ${error.name}`));
    page.on("request", (request) => watched.asked.push(request.url()));
    page.on("dialog", (dialog) => {
      watched.dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    return watched;
  }

  const value = <T>(page: Page, expression: string): Promise<T> => page.evaluate(expression) as Promise<T>;
  const truthy = (page: Page, expression: string): Promise<boolean> => value<boolean>(page, `Boolean(${expression})`);
  const until = (page: Page, expression: string, what: string): Promise<void> => expect.poll(() => truthy(page, expression), { timeout: 5000, interval: 25, message: what }).toBe(true);
  const text = (page: Page, selector: string): Promise<string> => value<string>(page, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? "(not there)"`);
  /** Is there such an element, with a size, that is not hidden? */
  const seen = (page: Page, selector: string): Promise<boolean> =>
    truthy(page, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })()`);
  const notWiderThanTheScreen = (page: Page): Promise<boolean> => truthy(page, "document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth");

  it("shows every view at phone and desktop size, in light and dark, from its key link", { timeout: 90_000 }, async () => {
    const { stage, served } = await demo();
    const views: Array<[string, string, string]> = [
      ["today", "/", "Kiro Crew is building"],
      ["ideas", "/ideas", "Ideas"],
      ["idea-delivered", `/ideas/${stage.ideaIds.packingChecklist}`, "Packing Checklist"],
      ["idea-building", `/ideas/${stage.ideaIds.choreWheel}`, "Chore Wheel"],
      ["nights", "/nights", "Nights"],
      ["settings", "/settings", "Settings"],
    ];
    if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true });
    const backgrounds = new Map<string, string>();

    for (const size of ["phone", "desktop"] as const) {
      for (const scheme of SCHEMES) {
        const { page, errors, asked, dialogs } = await newPage({ size, scheme });
        // The key link: one hop sets the cookie, the next shows the plain address.
        const opened = await page.goto(served.keyUrl);
        expect(opened?.status()).toBe(200);
        expect(page.url()).toBe(`${served.origin}/`);
        expect(await value<string>(page, "document.cookie")).toBe("");

        for (const [name, address, heading] of views) {
          const where = `${name}, ${size}, ${scheme}`;
          const answer = await page.goto(served.origin + address);
          expect(answer?.status(), where).toBe(200);
          expect(await seen(page, "h1"), where).toBe(true);
          expect(await text(page, "h1"), where).toContain(heading);
          expect(await seen(page, '[data-pill="demo"]'), where).toBe(true);
          expect(await text(page, '[data-pill="demo"]'), where).toBe("DEMO DATA: invented");
          expect(await text(page, '[data-pill="listening"]'), where).toBe("Listening");
          expect(await value<string>(page, "document.title"), where).toMatch(/^DEMO · .* · Overnight$/);
          // The script has run: the clock in the corner is the pretend one, in the pages' own zone and not the browser's.
          await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`, where);
          expect(await text(page, '#clock [data-clock="wall"]'), where).toBe("1:02 AM");
          // The stylesheet has loaded, and nothing sticks out sideways.
          expect(await notWiderThanTheScreen(page), where).toBe(true);
          const background = await value<string>(page, "getComputedStyle(document.body).backgroundColor");
          expect(background, where).toMatch(/^rgb/);
          backgrounds.set(`${name} ${size} ${scheme}`, background);
          // Every picture the page asks for arrives whole. (Those further down are only asked for once they come near the screen.)
          await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
          await until(page, "Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)", `${where}: pictures`);
          await page.evaluate("window.scrollTo(0, 0)");
          if (SHOTS_DIR !== undefined) await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${size}-${scheme}.png`), fullPage: true });
        }

        // Today's running clock: the build began 72 seconds before the scene's 1:02 AM.
        await page.goto(`${served.origin}/`);
        await until(page, `document.querySelector('#story .hero__clock [data-clock="elapsed"]').classList.contains("on")`, `${size} ${scheme}`);
        // (The page's own clock runs on from there, so a slow moment may show a second or two more.)
        expect(await text(page, "#story .hero__clock [data-clock='elapsed']")).toMatch(/^1:1[2-9]$/);
        expect(await text(page, "#story .hero__now")).toBe("Kiro Crew is building “Chore Wheel”");

        expect(errors, `${size} ${scheme}`).toEqual([]);
        expect(dialogs).toEqual([]);
        // Nothing was asked of any other host: no font, no picture, no script from outside.
        expect(asked.length).toBeGreaterThan(views.length);
        for (const address of asked) expect(address.startsWith(`${served.origin}/`), address.slice(0, 60)).toBe(true);
      }
    }

    // Light and dark really are two looks.
    for (const [name] of views) {
      for (const size of ["phone", "desktop"]) expect(backgrounds.get(`${name} ${size} light`), `${name} ${size}`).not.toBe(backgrounds.get(`${name} ${size} dark`));
    }
    expect(served.logged).toEqual([]);
  });

  it("opens from its key link when that link is clicked on another site's page, and gives that site nothing else", async () => {
    const { stage, served } = await demo();
    const picture = `${served.origin}/shots/${stage.ideaIds.packingChecklist}/phone.png`;
    // Another site, invented: a page with the link on it, a picture taken from the dashboard and the dashboard in a frame.
    const other = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Another site</title><a id="go" href="${served.keyUrl}">The dashboard</a><img id="pic" src="${picture}" alt=""><iframe id="frame" src="${served.origin}/ideas"></iframe>`);
    });
    others.push(other);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const address = other.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    // Opened under the name localhost: to a browser that is another site than 127.0.0.1, so the click is a cross-site one.
    const elsewhere = `http://localhost:${address.port}/`;

    const { page, dialogs } = await newPage();
    const carried: Array<Record<string, string>> = [];
    page.on("request", (request) => {
      if (request.url() === served.keyUrl) void request.allHeaders().then((headers) => carried.push(headers));
    });
    await page.goto(elsewhere);
    await page.click("#go");
    await until(page, `location.href === ${JSON.stringify(`${served.origin}/`)}`, "the click lands on the plain address");
    expect(await text(page, "#story .hero__now")).toBe("Kiro Crew is building “Chore Wheel”");
    expect(await seen(page, '[data-pill="demo"]')).toBe(true);
    await expect.poll(() => carried.length).toBeGreaterThan(0);
    expect(carried[0]?.["sec-fetch-site"]).toBe("cross-site");
    expect(carried[0]?.["sec-fetch-mode"]).toBe("navigate");

    // The browser now holds the key. Back on the other site, its picture and its frame still get nothing.
    await page.goto(elsewhere);
    await until(page, `document.getElementById("pic").complete`, "the picture request has ended");
    expect(await value<number>(page, `document.getElementById("pic").naturalWidth`)).toBe(0);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    const inFrame = frame === undefined ? "" : await frame.content().catch(() => "");
    expect(inFrame).not.toContain("Chore Wheel");
    expect(inFrame).not.toContain("Ideas");
    // The same picture, asked for by the dashboard's own page, is there.
    await page.goto(`${served.origin}/ideas/${stage.ideaIds.packingChecklist}`);
    await until(page, `Array.from(document.images).length === 2 && Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)`, "the dashboard's own pictures load");
    expect(dialogs).toEqual([]);
  });

  it("holds hostile text as text with the browser's own safety net switched off", { timeout: 60_000 }, async () => {
    // Every title, pitch, quote, note, reason and log field ends with markup; the published links are a script and a data address.
    const scene = seeded({ hostile: true });
    const served = await serve(scene);
    for (const size of ["phone", "desktop"] as const) {
      // bypassCSP: the rules for what a page may run are not applied, so only the escaping stands between the text and the page.
      const { page, errors, dialogs, asked } = await newPage({ size, bypassCSP: true });
      await page.goto(served.keyUrl);
      for (const address of pageAddresses(scene.ideaIds)) {
        const answer = await page.goto(served.origin + address);
        expect(answer?.status(), address).toBe(200);
        expect(await value<number>(page, `document.querySelectorAll("xss-probe").length`), address).toBe(0);
        expect(await value<number>(page, `document.querySelectorAll("[data-xss-probe]").length`), address).toBe(0);
        expect(await value<number>(page, `document.querySelectorAll("script").length`), address).toBe(1);
        expect(await value<number>(page, `document.querySelectorAll('img[src="x"], [onerror], [onmouseover], [onclick], [style]').length`), address).toBe(0);
        // Every link leads to a web address: the dashboard's own, or an https one.
        expect(await value<string[]>(page, `Array.from(document.links, (link) => link.protocol).filter((protocol) => protocol !== "http:" && protocol !== "https:")`), address).toEqual([]);
        expect(await value<string[]>(page, `Array.from(document.links, (link) => link.href).filter((href) => !href.startsWith(${JSON.stringify(`${served.origin}/`)}) && !href.startsWith("https://example.invalid/"))`), address).toEqual([]);
        // The text is there to be read, markup and all.
        expect(await truthy(page, `document.body.textContent.includes("<xss-probe>")`), address).toBe(address !== "/settings");
        // A 300-letter word does not push the page wider than the screen.
        expect(await notWiderThanTheScreen(page), `${address} ${size}`).toBe(true);
      }
      expect(dialogs).toEqual([]);
      expect(errors).toEqual([]);
      for (const address of asked) expect(address.startsWith(`${served.origin}/`), address.slice(0, 60)).toBe(true);
    }
    expect(served.logged).toEqual([]);
  });

  it("follows an invented night step by step, with no reload", { timeout: 90_000 }, async () => {
    const { stage, served } = await demo({ running: true });
    const chore = stage.ideaIds.choreWheel;
    const lunch = stage.ideaIds.lunchTurns;
    const today = await newPage();
    await today.page.goto(served.keyUrl);
    // A tab on the page of each of the night's two ideas. On the one being built, the brief is opened.
    const own: Record<string, Page> = {};
    for (const id of [chore, lunch]) {
      const page = await today.page.context().newPage();
      page.setDefaultTimeout(5000);
      await page.goto(`${served.origin}/ideas/${id}`);
      own[id] = page;
    }
    const idea = own[chore] as Page;
    await idea.evaluate(`document.getElementById("brief-text").open = true`);
    const pages = [today.page, ...Object.values(own)];
    // A mark only a page that is never loaded again keeps.
    for (const page of pages) await page.evaluate("window.neverReloaded = true");
    const firstClock = await text(today.page, "#story .hero__clock [data-clock='elapsed']");

    /** One of the story's seven steps, or one of the night's ticks, of this idea, in this state. Both lists carry the idea's id. */
    const step = (key: string, status: string) => (id: string): string => `document.querySelector('#story [data-idea="${id}"] [data-step="${key}"][data-status="${status}"]')`;
    const tick = (key: string, status: string) => (id: string): string => `document.querySelector('#story [data-idea="${id}"] [data-check="${key}"][data-status="${status}"]')`;
    /** What each step of the night changes on the page, for the idea it is about. */
    const shows: Record<string, (id: string) => string> = {
      "build-started": step("built", "active"),
      "sign-in-ready": tick("sign-in", "done"),
      "sandbox-check-passed": tick("sandbox", "done"),
      "agent-started": tick("agent", "active"),
      "file-build-status": tick("mark-started", "done"),
      "file-package-json": tick("mark-project", "done"),
      "file-node-modules": tick("mark-packages", "done"),
      "file-dist": tick("mark-app", "done"),
      "file-build-notes": tick("mark-notes", "done"),
      built: step("built", "done"),
      "deliver-starting": step("checked", "active"),
      verified: step("checked", "done"),
      pushed: tick("pushed", "done"),
      "live-and-published": step("published", "done"),
      "told-and-delivered": step("delivered", "done"),
      fact: tick("fact", "done"),
    };
    /** Asks a page to look now instead of at its next turn (the script looks whenever its tab comes to the front). */
    const lookNow = (page: Page): Promise<unknown> => page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
    const wallClock = (): Promise<string> => text(today.page, "#clock [data-clock='wall']");

    const played: string[] = [];
    for (;;) {
      const name = stage.nextStep();
      if (name === null) break;
      const key = stage.lastStepIdea() as DemoIdeaKey;
      const id = stage.ideaIds[key];
      played.push(`${key} ${name}`);
      const expected = shows[name];
      if (expected === undefined) throw new Error(`a step the test has no words for: ${name}`);
      // The first step is left to the page's own two-second turn. After that the pages are asked to look at once, to keep the test short.
      if (played.length > 1) await lookNow(today.page);
      // The idea's own page shows every step of its night: there the story is the only one on the page.
      const page = own[id] as Page;
      await lookNow(page);
      await until(page, expected(id), `the idea's page shows "${key} ${name}"`);
      // Today leads with one idea at a time. When the first app of the morning is delivered, it turns to the one still on its way.
      const todayHasMovedOn = key === "lunchTurns" && (name === "told-and-delivered" || name === "fact");
      if (todayHasMovedOn) await until(today.page, step("checked", "active")(chore), `Today has turned to the other app at "${key} ${name}"`);
      else await until(today.page, expected(id), `Today shows "${key} ${name}"`);
      // A step whose state changed pops, once, as it changes.
      if (key === "choreWheel" && (name === "built" || name === "told-and-delivered")) expect(await truthy(today.page, `${expected(id)}.classList.contains("pop")`), `${name} pops`).toBe(true);
      if (key === "choreWheel" && name === "file-build-notes") await idea.evaluate(`document.getElementById("notes-text").open = true`);
      // The pretend clock: the night at 1:02 AM, the morning's checks from 6:30 AM, and nobody told before 7:00 AM.
      if (name === "built") expect(await wallClock(), `${key} built`).toMatch(/^1:0[2-4] AM$/);
      if (key === "lunchTurns" && name === "deliver-starting") await expect.poll(wallClock, { timeout: 5000, interval: 25 }).toBe("6:30 AM");
      if (key === "lunchTurns" && name === "live-and-published") expect(await wallClock()).toMatch(/^6:3[0-2] AM$/);
      if (name === "told-and-delivered") await expect.poll(wallClock, { timeout: 5000, interval: 25 }).toMatch(/^7:0[0-2] AM$/);
    }
    // Both ideas are built before the morning; then the morning takes the app built last first.
    expect(played).toHaveLength(25);
    expect(played.indexOf("lunchTurns built")).toBeLessThan(played.indexOf("lunchTurns deliver-starting"));
    expect(played.indexOf("choreWheel built")).toBeLessThan(played.indexOf("lunchTurns build-started"));
    expect(played.at(-1)).toBe("choreWheel fact");

    // The night ends on the app that was delivered last, with all seven steps done and its link.
    expect(await text(today.page, "#story .hero__now")).toBe("“Chore Wheel” was delivered");
    expect(await value<string[]>(today.page, `Array.from(document.querySelectorAll('#story [data-step]'), (step) => step.dataset.status)`)).toEqual(Array.from({ length: 7 }, () => "done"));
    expect(await seen(today.page, "#story a.button")).toBe(true);
    await until(today.page, `document.querySelector("#story img.hero__shot")?.naturalWidth > 0`, "the hero shows the app's picture");
    // Its times are a night's and a morning's, not all one minute: built at night, delivered when the quiet hours were over.
    expect(await value<string[]>(today.page, `Array.from(document.querySelectorAll('#story [data-step="built"] .step__time, #story [data-step="delivered"] .step__time'), (time) => time.textContent)`)).toEqual([expect.stringMatching(/^1:0[2-4] AM$/), expect.stringMatching(/^7:0[0-2] AM$/)]);
    // The line about the night: two delivered, none failed; the build that was cut short is said on its own.
    expect(await text(today.page, "#lastnight .lastnight__label")).toBe("Last night");
    expect(await text(today.page, "#lastnight .lastnight__headline")).toBe("Worked: 2 apps built and delivered. 1 cut short, to be built once more.");
    // Both ideas' own pages went all the way too, and what was opened stayed open.
    for (const page of Object.values(own)) expect(await value<string[]>(page, `Array.from(document.querySelectorAll('#story [data-step]'), (step) => step.dataset.status)`)).toEqual(Array.from({ length: 7 }, () => "done"));
    expect(await truthy(idea, `document.getElementById("brief-text").open && document.getElementById("notes-text").open`)).toBe(true);
    expect(await truthy(idea, `Array.from(document.images).length === 2`)).toBe(true);
    // No tick carries the player's own two and a half seconds.
    for (const page of Object.values(own)) expect(await text(page, "#story .checks")).not.toContain("2.5 s");
    // The clocks ran on by the pretend clock, and no page was ever loaded again.
    for (const page of pages) expect(await truthy(page, "window.neverReloaded === true")).toBe(true);
    expect(await wallClock()).toMatch(/^7:0[0-2] AM$/);
    expect(firstClock).toMatch(/^1:\d\d$/);
    expect(await text(today.page, "#lane-heard [data-clock='ago']")).toMatch(/^\d h ago$/);
    expect(await truthy(today.page, `document.getElementById("notice").hidden`)).toBe(true);
    expect(today.errors).toEqual([]);
    for (const address of today.asked) expect(address.startsWith(`${served.origin}/`), address.slice(0, 60)).toBe(true);
    if (SHOTS_DIR !== undefined) {
      await today.page.screenshot({ path: path.join(SHOTS_DIR, "today-after-the-night-desktop-light.png"), fullPage: true });
      await idea.screenshot({ path: path.join(SHOTS_DIR, "idea-after-the-night-desktop-light.png"), fullPage: true });
    }
    expect(served.logged).toEqual([]);
  });

  // ---------- how the pages hold together at widths in between, and what can be read on them ----------

  /** The words of the matched elements that the browser has broken across two lines: 'class: "word"'. */
  const brokenWords = (selector: string): string => `(() => {
    const broken = [];
    for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of node.textContent.matchAll(/\\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
          if (lines.size > 1) broken.push(element.className + ': "' + match[0] + '"');
        }
      }
    }
    return broken;
  })()`;

  /** A new page of the given width with the key already in hand. */
  async function pageAt(served: Served, width: number, o: { height?: number; scheme?: (typeof SCHEMES)[number] } = {}): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: o.height ?? 900 }, colorScheme: o.scheme ?? "light", timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(served.keyUrl);
    return page;
  }

  // With an ordinary longer title the big clock used to break in the middle of its digits ("3:0" over "4") at every desktop width.
  it("keeps the hero's running clock on one line while a long headline wraps beside it", async () => {
    const { stage, served } = await demo();
    const title = "Shared Grocery List Sorted by Each Shop Aisle";
    expect(title).toHaveLength(45);
    // The test's own throwaway folder: the idea being built gets a longer, invented title.
    const db = new Database(stage.paths.database);
    try {
      db.prepare("UPDATE ideas SET title = ? WHERE id = ?").run(title, stage.ideaIds.choreWheel);
    } finally {
      db.close();
    }
    for (const width of [761, 800, 1024, 1280]) {
      const page = await pageAt(served, width);
      await until(page, `document.querySelector('#story .hero__clock [data-clock="elapsed"]')?.classList.contains("on")`, `the clock runs at ${width}`);
      expect(await text(page, "#story .hero__now")).toBe(`Kiro Crew is building “${title}”`);
      expect(await value<string[]>(page, brokenWords("#story .hero__clock b")), `at ${width}`).toEqual([]);
      // The clock keeps its own width: the headline is what gives way.
      const sizes = await value<{ clock: number; clockNeeds: number; headlineLines: number }>(
        page,
        `(() => { const clock = document.querySelector("#story .hero__clock b"); const now = document.querySelector("#story .hero__now"); return { clock: clock.getBoundingClientRect().width, clockNeeds: clock.scrollWidth, headlineLines: Math.round(now.getBoundingClientRect().height / parseFloat(getComputedStyle(now).lineHeight)) }; })()`,
      );
      // (A box's own width comes in fractions of a pixel, what it needs in whole ones.)
      expect(Math.ceil(sizes.clock), `at ${width}`).toBeGreaterThanOrEqual(sizes.clockNeeds);
      expect(sizes.headlineLines, `at ${width}`).toBeGreaterThanOrEqual(2);
      expect(await notWiderThanTheScreen(page), `at ${width}`).toBe(true);
    }
  });

  // From 761 to 900 px wide, "Recipe Doubler" beside "waits for another night" used to get a box 12 px wide: thirteen lines of one letter each.
  it("wraps a row in the three lanes, never a word in it, in a window half a screen wide", async () => {
    const { served } = await demo();
    for (const width of [761, 800, 850, 900, 1000, 1280]) {
      const page = await pageAt(served, width);
      await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`, `the script ran at ${width}`);
      expect(await value<number>(page, `document.querySelectorAll("#lane-tonight .row").length`)).toBe(3);
      expect(await value<string[]>(page, brokenWords(".lane .row b, .lane .row small, .lane .tag")), `at ${width}`).toEqual([]);
      // Every title has room for its longest word.
      const tight = await value<string[]>(
        page,
        `Array.from(document.querySelectorAll(".lane .row b")).filter((b) => { const probe = document.createElement("span"); probe.className = "nowrap"; probe.textContent = b.textContent.trim().split(/\\s+/).reduce((a, w) => (w.length > a.length ? w : a), ""); b.append(probe); const needs = probe.getBoundingClientRect().width; probe.remove(); return b.getBoundingClientRect().width + 0.5 < needs; }).map((b) => b.textContent)`,
      );
      expect(tight, `at ${width}`).toEqual([]);
      expect(await notWiderThanTheScreen(page), `at ${width}`).toBe(true);
    }
  });

  // On a phone the rows of a night were ragged: dots beside one title and below the next, words right-aligned on one row and left on the next.
  it("lays out a night's rows on a phone as three lines from the left: the title, the seven dots, the words", async () => {
    const { served } = await demo();
    const page = await pageAt(served, 390, { height: 844 });
    await page.goto(`${served.origin}/nights`);
    const rows = await value<Array<{ title: string; lefts: number[]; tops: number[] }>>(
      page,
      `Array.from(document.querySelectorAll(".night__ideas .row"), (row) => { const parts = [row.querySelector(".row__name"), row.querySelector(".mini"), row.querySelector("small")].map((part) => part.getBoundingClientRect()); return { title: row.querySelector("b").textContent, lefts: parts.map((part) => Math.round(part.left)), tops: parts.map((part) => Math.round(part.top)) }; })`,
    );
    expect(rows.length).toBeGreaterThan(5);
    const left = rows[0]?.lefts[0];
    for (const row of rows) {
      expect(row.lefts, row.title).toEqual([left, left, left]);
      expect(row.tops[1], row.title).toBeGreaterThan(row.tops[0] ?? 0);
      expect(row.tops[2], row.title).toBeGreaterThan(row.tops[1] ?? 0);
    }
    expect(await notWiderThanTheScreen(page)).toBe(true);
    // On a wide screen a row is one line again, with its words at the right.
    const wide = await pageAt(served, 1280);
    await wide.goto(`${served.origin}/nights`);
    expect(await truthy(wide, `Array.from(document.querySelectorAll(".night__ideas .row")).every((row) => { const name = row.querySelector(".row__name").getBoundingClientRect(); const words = row.querySelector("small").getBoundingClientRect(); return words.left > name.right && Math.abs(words.top - name.top) < 12; })`)).toBe(true);
  });

  // The "…" that ends a failed step's reason used to be cut off at the right edge ("Kiro.." for "Kiro…").
  it("gives the three-line cut under a step room for its ellipsis", async () => {
    const { stage, served } = await demo();
    const page = await pageAt(served, 1280);
    await page.goto(`${served.origin}/ideas/${stage.ideaIds.baleYieldCalculator}`);
    const cut = await value<Array<{ clamped: boolean; left: number; right: number; ellipsis: number; align: string }>>(
      page,
      `Array.from(document.querySelectorAll("#story .step__detail"), (detail) => { const style = getComputedStyle(detail); const pen = document.createElement("canvas").getContext("2d"); pen.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily; return { clamped: detail.scrollHeight > detail.clientHeight + 1, left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), ellipsis: pen.measureText("…").width, align: style.textAlign }; })`,
    );
    const clamped = cut.filter((detail) => detail.clamped);
    // The quote under Heard and the reason under "Could not build" are both longer than three lines.
    expect(clamped.length).toBeGreaterThanOrEqual(2);
    for (const detail of clamped) {
      // The lines are centred and the browser hangs the "…" on the last one without centring it again, so it sticks out by up to half its width.
      expect(detail.align).toBe("center");
      expect(detail.ellipsis).toBeGreaterThan(5);
      expect(detail.right).toBeGreaterThanOrEqual(detail.ellipsis / 2);
      expect(detail.left).toBeGreaterThanOrEqual(detail.ellipsis / 2);
    }
  });

  // In light mode the green and amber labels were under 4.5 to 1 ("Listening", "yes", "could not check", "Cut short"),
  // and so, once the tints were read as the colours they are, were "Could not build", "Building" and grey on a chip.
  it("writes every word on every page at a contrast of at least 4.5 to 1, in light and in dark", { timeout: 90_000 }, async () => {
    const { stage, served } = await demo();
    /** The texts on the page whose colour is too close to what they stand on. A background made of a picture or stripes is passed over. */
    const tooFaint = `(() => {
      const parse = (colour) => {
        let m = colour.match(/^rgba?\\(([^)]+)\\)/);
        if (m) { const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
        m = colour.match(/^color\\(srgb ([^)]+)\\)/);
        if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(parseFloat); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] }; }
        return null;
      };
      const light = ({ r, g, b }) => { const part = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b); };
      const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
      const faint = [];
      for (const element of document.querySelectorAll("body *")) {
        if (!Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim() !== "")) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden") continue;
        const chain = [];
        for (let e = element; e; e = e.parentElement) chain.push(e);
        let ground = { r: 255, g: 255, b: 255, a: 1 };
        let opacity = 1;
        let skip = false;
        let unread = false;
        for (const e of chain.reverse()) {
          const s = getComputedStyle(e);
          opacity *= parseFloat(s.opacity);
          if (s.backgroundImage !== "none") skip = true;
          const colour = parse(s.backgroundColor);
          if (colour === null) unread = true;
          else if (colour.a > 0) ground = over(colour, ground);
        }
        if (skip) continue;
        const ink = parse(style.color);
        const name = element.tagName.toLowerCase() + "." + String(element.className).split(" ").join(".") + ' "' + element.textContent.trim().slice(0, 24) + '"';
        if (ink === null || unread) { faint.push(name + " (a colour this test cannot read)"); continue; }
        const shown = over({ ...ink, a: ink.a * opacity }, ground);
        const [a, b] = [light(shown), light(ground)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 4.5) faint.push(name + " " + ratio.toFixed(2));
      }
      return Array.from(new Set(faint));
    })()`;
    for (const scheme of SCHEMES) {
      const page = await pageAt(served, 1280, { scheme });
      let looked = 0;
      for (const address of pageAddresses(stage.ideaIds)) {
        await page.goto(served.origin + address);
        await until(page, `document.querySelector('#clock [data-clock="wall"]').classList.contains("on")`, `the script ran on ${address}`);
        expect(await value<string[]>(page, tooFaint), `${address}, ${scheme}`).toEqual([]);
        looked += await value<number>(page, `document.querySelectorAll(".state, .tag, .pill, .yes, .no, .check small").length`);
      }
      // The labels this is about were really on those pages.
      expect(looked).toBeGreaterThan(100);
      for (const label of [".pill--live", ".tag--warn", ".state--waiting", ".state--failed", ".state--delivered"]) {
        await page.goto(`${served.origin}/`);
        expect(await value<number>(page, `document.querySelectorAll(${JSON.stringify(label)}).length`), label).toBeGreaterThan(0);
      }
    }
  });

  it("says the dashboard has stopped when it stops answering, and that it needs its link when opened without it", async () => {
    const { served } = await demo();
    const { page } = await newPage();
    const refused = await page.goto(`${served.origin}/`);
    expect(refused?.status()).toBe(401);
    expect(await text(page, "h1")).toBe("Open it from its link");
    expect(await text(page, "main")).toContain(`It starts with ${served.origin}/?key=`);
    await page.goto(served.keyUrl);
    expect(await truthy(page, `document.getElementById("notice").hidden`)).toBe(true);
    await served.close();
    await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
    await until(page, `!document.getElementById("notice").hidden`, "the notice shows");
    expect(await text(page, "#notice")).toBe("The dashboard has stopped or was restarted. Open its new link.");
    // What was on the page stays there to be read.
    expect(await text(page, "#story .hero__now")).toBe("Kiro Crew is building “Chore Wheel”");
  });
});
