// Films a real published app being used on a phone-sized page, frame by frame, at 30 fps.
//
//   node submission/film/capture-app.ts game  [light|dark]   Game Night Scores, about 20 s, into capture/app/
//   node submission/film/capture-app.ts plant [light|dark]   Plant Watering Tracker, about 8 s, into capture/plant/
//
// The page is the real public app on GitHub Pages, opened at 390x844 CSS pixels with a device
// scale factor of 3 (each PNG is 1170x2532), as a touch phone. Nothing in the app is changed.
// Time is stepped, not recorded: the page's clock is Playwright's fake clock and every CSS
// animation or transition is paused and moved on by exactly 1/30 s per frame, so each frame is
// sharp and the motion is even however long a screenshot takes. The taps are real taps on the
// app's own buttons; where each one landed (CSS pixels, frame number) is written to
// capture/<dir>/taps.json so the edit can draw a finger there.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Locator, Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 3;

const APPS = {
  game: { url: "https://hturcotte1.github.io/overnight-apps/game-night-scores/", dir: "app" },
  plant: { url: "https://hturcotte1.github.io/overnight-apps/plant-watering-tracker/", dir: "plant" },
} as const;
type AppName = keyof typeof APPS;

const which = process.argv[2] as AppName;
const scheme = (process.argv[3] ?? "light") as "light" | "dark";
if (!(which in APPS) || !["light", "dark"].includes(scheme)) throw new Error("Usage: node submission/film/capture-app.ts game|plant [light|dark]");
const app = APPS[which];
const outDir = path.join(HERE, "capture", scheme === "light" ? app.dir : `${app.dir}-dark`);

/** One step of the film: at `at` seconds, do this. */
type Cue = { at: number; run: (film: Film) => Promise<void> };

class Film {
  frame = 0;
  readonly taps: Array<{ frame: number; tMs: number; x: number; y: number; what: string; scrollY?: number }> = [];
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  /** A real tap on the element's middle, remembered for the edit. */
  async tap(target: Locator, what: string): Promise<void> {
    const box = await target.boundingBox();
    if (box === null) throw new Error(`nothing to tap: ${what}`);
    this.taps.push({ frame: this.frame + 1, tMs: Math.round((this.frame * 1000) / FPS), x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), what });
    await target.tap({ timeout: 5_000 });
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined) last.scrollY = await this.page.evaluate(() => window.scrollY);
  }

  /** Types one character (each call is one frame's worth of typing). */
  async key(char: string): Promise<void> {
    await this.page.keyboard.type(char);
  }
}

/** Typing a word, two frames a letter, starting at `at`. */
function typeCues(at: number, word: string): Cue[] {
  return [...word].map((char, index) => ({ at: at + (index * 2) / FPS, run: (film: Film) => film.key(char) }));
}

/** The plant tracker, about 8 s: the example plants, then two of them watered. */
function plantCues(page: Page): { seconds: number; cues: Cue[] } {
  return {
    seconds: 8,
    cues: [
      { at: 1.0, run: (f) => f.tap(page.getByRole("button", { name: "Try an example" }), "Try an example") },
      { at: 3.4, run: (f) => f.tap(page.getByRole("button", { name: "Water Basil" }), "water Basil") },
      { at: 5.4, run: (f) => f.tap(page.getByRole("button", { name: "Water Fern" }), "water Fern") },
    ],
  };
}

/**
 * Game Night Scores, 20 s: three players added, points tapped, and who is winning. The app puts
 * the leader on top with a crown, so the lead changes hands a few times and ends with one clear
 * winner. Scores after each tap (Ava, Milo, Juno; no ties, so the order is never a toss-up):
 * 5/0/0, 5/10/0, 5/11/0, 15/11/0, 15/11/10, 15/11/20, 15/11/21, 25/11/21, 25/16/21, 25/26/21,
 * 30/26/21, 31/26/21, 32/26/21. Every tap is on a button that is fully on screen, so the page
 * never scrolls.
 */
function gameCues(page: Page): { seconds: number; cues: Cue[] } {
  const input = page.getByLabel("Player name");
  const add = page.getByRole("button", { name: "Add player" });
  const points = (amount: number, who: string): Cue["run"] => (f) => f.tap(page.getByRole("button", { name: `Add ${amount} to ${who}`, exact: true }), `+${amount} ${who}`);
  const player = (at: number, name: string): Cue[] => [
    { at, run: (f) => f.tap(input, "the name field") },
    ...typeCues(at + 0.25, name),
    { at: at + 0.25 + (name.length * 2) / FPS + 0.3, run: (f) => f.tap(add, `Add ${name}`) },
  ];
  return {
    seconds: 20,
    cues: [
      ...player(0.8, "Ava"),
      ...player(2.0, "Milo"),
      ...player(3.2, "Juno"),
      { at: 4.6, run: points(5, "Ava") },
      { at: 5.5, run: points(10, "Milo") },
      { at: 6.4, run: points(1, "Milo") },
      { at: 7.3, run: points(10, "Ava") },
      { at: 8.3, run: points(10, "Juno") },
      { at: 9.1, run: points(10, "Juno") },
      { at: 10.1, run: points(1, "Juno") },
      { at: 11.0, run: points(10, "Ava") },
      { at: 12.0, run: points(5, "Milo") },
      { at: 12.8, run: points(10, "Milo") },
      { at: 13.8, run: points(5, "Ava") },
      { at: 14.8, run: points(1, "Ava") },
      { at: 15.4, run: points(1, "Ava") },
    ],
  };
}

async function main(): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, colorScheme: scheme, locale: "en-US", timezoneId: "America/Boise" });
    const page = await context.newPage();
    await page.clock.install({ time: new Date() });
    await page.goto(app.url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.clock.runFor(500);
    const plan = which === "plant" ? plantCues(page) : gameCues(page);
    const film = new Film(page);
    const total = Math.round(plan.seconds * FPS);
    const cues = [...plan.cues].sort((a, b) => a.at - b.at);
    let next = 0;
    const started = Date.now();
    for (let f = 0; f < total; f += 1) {
      film.frame = f;
      const t = f / FPS;
      while (next < cues.length && (cues[next]?.at ?? Infinity) <= t + 1e-9) {
        await cues[next]?.run(film);
        next += 1;
      }
      const dt = Math.round(((f + 1) * 1000) / FPS) - Math.round((f * 1000) / FPS);
      await page.clock.runFor(dt);
      // Every animation and transition is held, then moved on by this frame's share of time.
      await page.evaluate((step) => {
        const held = ((window as unknown as { __filmHeld?: Map<Animation, number> }).__filmHeld ??= new Map());
        for (const animation of document.getAnimations()) {
          const at = held.get(animation);
          if (at === undefined) {
            held.set(animation, 0);
            animation.pause();
            animation.currentTime = 0;
          } else {
            held.set(animation, at + step);
            animation.currentTime = at + step;
          }
        }
      }, dt);
      await page.screenshot({ path: path.join(outDir, `frame-${String(f + 1).padStart(5, "0")}.png`), type: "png" });
    }
    if (next < cues.length) throw new Error(`${cues.length - next} cues were never reached`);
    writeFileSync(path.join(outDir, "taps.json"), `${JSON.stringify({ app: which, url: app.url, scheme, fps: FPS, viewport: VIEWPORT, deviceScaleFactor: SCALE, frames: total, taps: film.taps }, null, 2)}\n`);
    console.log(`${which} (${scheme}): ${total} frames at ${FPS} fps, ${VIEWPORT.width * SCALE}x${VIEWPORT.height * SCALE}, ${film.taps.length} taps, in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await browser.close();
  }
}

await main();
