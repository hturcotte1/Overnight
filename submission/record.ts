// Records the demo video: one Playwright page, filmed from start to end as it moves through the
// scenes, so the video is one continuous file. Silent; every scene carries its own caption.
//
//   node submission/record.ts          about 2 min 45 s; writes submission/overnight-demo.webm
//                                      and submission/scene-timings.json
//
// What it opens:
//   - submission/scenes/index.html: the title and text scenes (nothing in them is fetched from outside);
//   - the dashboard with --demo --play on port DEMO_PORT: invented data in a throwaway folder,
//     which the dashboard removes again when it is stopped. Never Overnight's real data;
//   - the real public app on GitHub Pages, inside a phone-sized frame. So it needs the internet.
// It never talks to Bee, Kiro or GitHub's API, never publishes and spends nothing.
// The dashboard's key link is read from its output and never printed or written anywhere.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_VIDEO = path.join(HERE, "overnight-demo.webm");
const OUT_TIMINGS = path.join(HERE, "scene-timings.json");
const SCENES = pathToFileURL(path.join(HERE, "scenes", "index.html")).href;
const CAPTION_SCRIPT = path.join(HERE, "scenes", "dashboard-caption.js");
const DEMO_PORT = 4391;
const SIZE = { width: 1280, height: 720 };

/** The functions the scenes page offers the recorder (scenes/index.html). */
interface ScenesPage {
  show(id: string): void;
  reveal(): void;
  step(n: number): void;
  caption(main: string, sub: string): void;
  doing(text: string): void;
  tapAt(x: number, y: number): void;
}
/** The one function the caption script adds to the dashboard (scenes/dashboard-caption.js). */
interface CaptionedPage {
  demoCaption(main: string, sub: string): void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The captions of "How it works", one per step. */
const HOW_CAPTIONS: ReadonlyArray<[string, string]> = [
  ["Bee streams each line it hears to Overnight, on this Mac.", "Bee is a wearable that listens. Here it runs on an Apple Watch."],
  ["When the talk goes quiet, Kiro decides: was that an app idea?", "Kiro CLI runs as a detector with no tools: it can only read and answer."],
  ["A Bee to-do buzzes the wrist: “💡 Build tonight?”", "Ticking it is the yes. Nothing is built without it."],
  ["At 1:00 AM, Kiro Crew builds the app from a one-page brief.", "It works inside Overnight's own macOS sandbox."],
  ["At 6:30 AM the app is tested in a second sandbox.", "A headless browser opens it and checks that it works, because an AI wrote it."],
  ["If it passes, Overnight publishes it to GitHub Pages.", "A static page: no backend, no keys."],
  ["At 7:00 AM the link arrives on the wrist.", "Bee is also given a fact, so it remembers what was built."],
];

const NIGHT_CAPTION = "The dashboard, playing a night of invented demo data";

/** Starts the dashboard on invented data and gives back its key link once it has printed it. */
function startDashboard(): { child: ChildProcess; link: Promise<string> } {
  const child = spawn(process.execPath, [path.join(ROOT, "packages", "dashboard", "src", "main.ts"), "--demo", "--play", "--port", String(DEMO_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const link = new Promise<string>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error("The dashboard printed no link within 20 s.")), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const found = /Overnight dashboard: (http:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(seen);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The dashboard stopped before it printed its link (exit code ${String(code)}).`));
    });
  });
  // Its error output only ever says what went wrong, never the link.
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`dashboard: ${chunk.toString("utf8")}`));
  return { child, link };
}

function stopDashboard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** Playwright's own ffmpeg, if it is installed: used only to write the video's length into its header. */
function playwrightFfmpeg(): string | null {
  const cache = path.join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const name of readdirSync(cache).filter((entry) => entry.startsWith("ffmpeg-")).sort().reverse()) {
    const binary = path.join(cache, name, "ffmpeg-mac");
    if (existsSync(binary)) return binary;
  }
  return null;
}

function run(program: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<void> {
  const videoDir = mkdtempSync(path.join(tmpdir(), "overnight-video-"));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: "light",
    // Lets the caption script add its strip to the dashboard, whose page rules allow only its own styles.
    bypassCSP: true,
    recordVideo: { dir: videoDir, size: SIZE },
  });
  await context.addInitScript({ path: CAPTION_SCRIPT });
  const page = await context.newPage();
  const startedAt = Date.now();
  const marks: Array<{ scene: string; start: number }> = [];
  const mark = (scene: string): void => {
    marks.push({ scene, start: Math.round((Date.now() - startedAt) / 100) / 10 });
    console.log(`${marks.at(-1)?.start.toFixed(1).padStart(6)} s  ${scene}`);
  };
  const scenes = (page_: Page) => ({
    show: (id: string) => page_.evaluate((scene) => (window as unknown as ScenesPage).show(scene), id),
    reveal: () => page_.evaluate(() => (window as unknown as ScenesPage).reveal()),
    step: (n: number) => page_.evaluate((count) => (window as unknown as ScenesPage).step(count), n),
    caption: (main: string, sub = "") => page_.evaluate(([m, s]) => (window as unknown as ScenesPage).caption(m ?? "", s ?? ""), [main, sub]),
    doing: (text: string) => page_.evaluate((t) => (window as unknown as ScenesPage).doing(t), text),
    tapAt: (x: number, y: number) => page_.evaluate(([px, py]) => (window as unknown as ScenesPage).tapAt(px ?? 0, py ?? 0), [x, y]),
  });
  const s = scenes(page);
  const dashCaption = (main: string, sub = "") => page.evaluate(([m, t]) => (window as unknown as CaptionedPage).demoCaption(m ?? "", t ?? ""), [main, sub]);

  let dashboard: ChildProcess | null = null;
  try {
    // 1. Title
    await page.goto(`${SCENES}#title`);
    mark("1 title");
    await wait(6000);

    // 2. The idea
    await s.show("idea");
    mark("2 the idea");
    await wait(600);
    for (let line = 0; line < 3; line += 1) {
      await s.reveal();
      await wait(3000);
    }
    await wait(500);

    // 3. How it works
    await s.show("how");
    mark("3 how it works");
    await wait(1400);
    let started: ReturnType<typeof startDashboard> | null = null;
    for (let n = 1; n <= 7; n += 1) {
      const words = HOW_CAPTIONS[n - 1] ?? ["", ""];
      await s.step(n);
      await s.caption(words[0], words[1]);
      // The dashboard takes a moment to start, and its invented night begins 3 s after it does.
      if (n === 7) started = startDashboard();
      await wait(n === 7 ? 3400 : 2450);
    }
    if (started === null) throw new Error("The dashboard was not started.");
    dashboard = started.child;
    const link = await started.link;

    // 4. The night, on the dashboard (invented demo data)
    try {
      await page.goto(link);
    } catch {
      // Playwright's own message would hold the key link.
      throw new Error("The demo dashboard's page did not open.");
    }
    mark("4 the dashboard, an invented night");
    await dashCaption(NIGHT_CAPTION, "1:00 AM: Kiro Crew builds the first approved idea. The ticks fill in as it works.");
    const hero = page.locator(".hero").first();
    let phase = "first build";
    const nightStarted = Date.now();
    let leaveAt = Number.POSITIVE_INFINITY;
    while (Date.now() < Math.min(leaveAt, nightStarted + 56_000)) {
      const text = (await hero.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (phase === "first build" && /building “Lunch Turns”/.test(text)) {
        phase = "second build";
        await dashCaption(NIGHT_CAPTION, "Then the next approved idea, one at a time: at most two a night.");
      } else if (phase === "second build" && /^THIS MORNING/i.test(text)) {
        phase = "morning";
        await dashCaption(NIGHT_CAPTION, "6:30 AM: each app is tested in the sandbox and published. At 7:00 the link goes to the wrist.");
      } else if (phase === "morning" && (/“Lunch Turns” was delivered/.test(text) || /“Chore Wheel”/.test(text))) {
        phase = "leaving";
        leaveAt = Date.now() + 2200;
      }
      await wait(250);
    }
    const ideaHref = await page.locator("a", { hasText: "Lunch Turns" }).first().getAttribute("href");
    if (!ideaHref) throw new Error("The demo's Lunch Turns page was not linked from Today.");
    await dashCaption("One idea's own page: every step, with its time", "Invented demo data, as on every dashboard page in this video.");
    await page.goto(new URL(ideaHref, page.url()).href);
    mark("4b one idea's own page");
    await wait(4200);
    await page.evaluate(() => window.scrollTo({ top: 330, behavior: "smooth" }));
    await dashCaption("What the build and the morning's checks recorded", "");
    await wait(3600);
    const brief = page.locator("details.doc", { hasText: "The brief" }).first();
    await brief.locator("summary").click();
    await brief.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "start" }));
    await dashCaption("The brief: all the build agent was given", "Our own fixed words, plus the idea's title and pitch. Never the words that were said.");
    await wait(5000);

    // 5. The first real night
    await page.goto(`${SCENES}#night`);
    await stopDashboard(dashboard);
    dashboard = null;
    mark("5a the first real night");
    await wait(700);
    for (let row = 0; row < 5; row += 1) {
      await s.reveal();
      await wait(row === 4 ? 2600 : 2300);
    }

    await s.show("app");
    mark("5b the real app");
    const frame = page.frameLocator("#appframe");
    const example = frame.getByRole("button", { name: "Try an example" });
    await example.waitFor({ timeout: 15_000 });
    await wait(2600);
    await s.doing("One tap on “Try an example” fills in four plants.");
    const exampleBox = await example.boundingBox();
    if (exampleBox) await s.tapAt(exampleBox.x + exampleBox.width / 2, exampleBox.y + exampleBox.height / 2);
    await wait(250);
    await example.click();
    await wait(3800);
    const basil = frame.getByRole("button", { name: "Water Basil" });
    await s.doing("Tap a plant when you water it, and its counter starts again.");
    const basilBox = await basil.boundingBox();
    if (basilBox) await s.tapAt(basilBox.x + basilBox.width / 2, basilBox.y + basilBox.height / 2);
    await wait(250);
    await basil.click();
    await wait(4200);

    await s.show("todo");
    mark("5c the to-do on the wrist");
    await s.caption("In the morning, the link was on the wrist.", "An illustration: the words as Overnight sent them, not a screenshot of Bee's app.");
    await wait(8000);

    // 6. Guardrails
    await s.show("guard");
    mark("6 guardrails");
    await wait(800);
    for (let line = 0; line < 6; line += 1) {
      await s.reveal();
      await wait(line === 3 ? 3200 : 2300);
    }
    await wait(800);

    // 7. Built with
    await s.show("built");
    mark("7 built with");
    await wait(600);
    for (let card = 0; card < 6; card += 1) {
      await s.reveal();
      await wait(card === 5 ? 5200 : 450);
    }

    // 8. Close
    await s.show("close");
    mark("8 close");
    await wait(6000);
    mark("end");
  } finally {
    if (dashboard) await stopDashboard(dashboard);
    await context.close();
    await browser.close();
  }

  const recorded = readdirSync(videoDir).filter((name) => name.endsWith(".webm"));
  if (recorded.length !== 1 || !recorded[0]) throw new Error(`Expected one video, found ${recorded.length}.`);
  const raw = path.join(videoDir, recorded[0]);
  // The browser writes the video as a stream, with no length in its header. Copying it through
  // ffmpeg, without changing a frame, writes the length in, so players can show it.
  const ffmpeg = playwrightFfmpeg();
  rmSync(OUT_VIDEO, { force: true });
  if (ffmpeg === null || (await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", raw, "-c", "copy", OUT_VIDEO])) !== 0) copyFileSync(raw, OUT_VIDEO);
  rmSync(videoDir, { recursive: true, force: true });
  writeFileSync(OUT_TIMINGS, `${JSON.stringify(marks, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, OUT_VIDEO)} (${(statSync(OUT_VIDEO).size / 1_000_000).toFixed(1)} MB) and ${path.relative(ROOT, OUT_TIMINGS)}.`);
}

await main();
