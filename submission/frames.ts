// Takes still frames out of the recorded video, to check each scene by eye, and prints its length.
//
//   node submission/frames.ts      after submission/record.ts; writes submission/frames/*.png
//
// It uses the ffmpeg that Playwright installs (nothing new is downloaded) and the scene start
// times that record.ts wrote to submission/scene-timings.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = path.join(HERE, "overnight-demo.webm");
const TIMINGS = path.join(HERE, "scene-timings.json");
const FRAMES = path.join(HERE, "frames");

/** Where in each scene to take a frame: seconds after it starts, or, below zero, before it ends. */
const PICKS: ReadonlyArray<{ scene: string; at: number; name: string }> = [
  { scene: "1 title", at: 4, name: "01-title" },
  { scene: "2 the idea", at: -0.8, name: "02-the-idea" },
  { scene: "3 how it works", at: 9, name: "03a-how-it-works-midway" },
  { scene: "3 how it works", at: -0.8, name: "03b-how-it-works" },
  { scene: "4 the dashboard, an invented night", at: 4, name: "04a-dashboard-first-build" },
  { scene: "4 the dashboard, an invented night", at: 26, name: "04b-dashboard-second-build" },
  { scene: "4 the dashboard, an invented night", at: -1, name: "04c-dashboard-morning" },
  { scene: "4b one idea's own page", at: 3, name: "05a-idea-page" },
  { scene: "4b one idea's own page", at: -0.8, name: "05b-idea-page-brief" },
  { scene: "5a the first real night", at: -0.8, name: "06-first-real-night" },
  { scene: "5b the real app", at: 2, name: "07a-real-app" },
  { scene: "5b the real app", at: -0.8, name: "07b-real-app-after-taps" },
  { scene: "5c the to-do on the wrist", at: -0.8, name: "08-the-to-do" },
  { scene: "6 guardrails", at: -0.8, name: "09-guardrails" },
  { scene: "7 built with", at: -0.8, name: "10-built-with" },
  { scene: "8 close", at: -0.8, name: "11-close" },
];

function playwrightFfmpeg(): string {
  const cache = path.join(homedir(), "Library", "Caches", "ms-playwright");
  for (const name of existsSync(cache) ? readdirSync(cache).filter((entry) => entry.startsWith("ffmpeg-")).sort().reverse() : []) {
    const binary = path.join(cache, name, "ffmpeg-mac");
    if (existsSync(binary)) return binary;
  }
  throw new Error("Playwright's ffmpeg is not installed.");
}

const ffmpeg = playwrightFfmpeg();
const marks = JSON.parse(readFileSync(TIMINGS, "utf8")) as Array<{ scene: string; start: number }>;
const ends = new Map(marks.map((mark, index) => [mark.scene, marks[index + 1]?.start ?? mark.start]));
const starts = new Map(marks.map((mark) => [mark.scene, mark.start]));

const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", VIDEO], { encoding: "utf8" });
const duration = /Duration: (\d\d:\d\d:\d\d\.\d\d)/.exec(probe.stderr)?.[1] ?? "unknown";
console.log(`Length: ${duration}`);

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
for (const pick of PICKS) {
  const start = starts.get(pick.scene);
  const end = ends.get(pick.scene);
  if (start === undefined || end === undefined) throw new Error(`No timing for scene "${pick.scene}".`);
  const at = pick.at >= 0 ? start + pick.at : end + pick.at;
  const out = path.join(FRAMES, `${pick.name}.png`);
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", VIDEO, "-frames:v", "1", out]);
  if (result.status !== 0) throw new Error(`ffmpeg could not take the frame at ${at.toFixed(2)} s.`);
  console.log(`${at.toFixed(1).padStart(6)} s  frames/${pick.name}.png`);
}
