// Films the dashboard while one rehearsal idea is really built, checked and published.
//
//   OVERNIGHT_DATA_DIR=... KIRO_HOME=... KIROCREW_HOME=... KIROCREW_PORT=... \
//     node submission/film/capture-build.ts <ideaId>
//
// The four values are the ones spike 11's `hold` prints (a throwaway gateway on its own port and
// a scratch data folder). Without all four it does not start, and it refuses ~/.overnight.
//
// What it does, in order:
//   1. starts the dashboard on that data folder (port 4321) and reads its key link from the
//      dashboard's own output; the link is kept in memory only, never printed or written;
//   2. opens two pages in Playwright's Chromium at 1920x1080, light mode: the idea's own page and
//      the Today page;
//   3. starts `npx overnight rehearse run <ideaId>` (it PUBLISHES: no --no-publish) and, while it
//      runs, saves a PNG of the idea page every second (capture/dashboard/) and of the Today page
//      every 4 seconds (capture/today/), until the idea page says Delivered, and 10 seconds more;
//   4. stops the dashboard and the browser.
// A credit guard stops the rehearsal (as Ctrl-C would) if the build moves on to its second
// builder, or if the Kiro Crew agent has run longer than GUARD_AGENT_MS.
// Every frame's page text is checked for a local path, the key link or the address; the count is
// written to capture/dashboard-frames.json. The rehearsal's own output goes to the data folder's
// logs/film-rehearse.out (it names local paths, so it stays out of the repo).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import type { Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CAPTURE = path.join(HERE, "capture");
const DASH_DIR = path.join(CAPTURE, "dashboard");
const TODAY_DIR = path.join(CAPTURE, "today");
const HOME = homedir();
const SIZE = { width: 1920, height: 1080 };
const PRE_ROLL_MS = 5_000;
const TAIL_MS = 10_000;
/** The longest the Kiro Crew agent may run before the guard stops the rehearsal (about 7.7 credits at the highest rate seen, 1.72 a minute). */
const GUARD_AGENT_MS = 270_000;
/** The longest the whole rehearsal may take before the guard stops it. */
const GUARD_TOTAL_MS = 25 * 60_000;
const FORBIDDEN = [/\/Users\//, /~\//, /key=/i, /127\.0\.0\.1/, /localhost/i, new RegExp(path.basename(HOME), "i")];

const ideaId = process.argv[2] ?? "";
const env = process.env;
for (const name of ["OVERNIGHT_DATA_DIR", "KIRO_HOME", "KIROCREW_HOME", "KIROCREW_PORT"]) {
  if ((env[name] ?? "").trim() === "") throw new Error(`${name} is not set: give the four values spike 11's hold prints.`);
}
const dataDir = path.resolve(env.OVERNIGHT_DATA_DIR ?? "");
if (dataDir === path.join(HOME, ".overnight") || dataDir.startsWith(path.join(HOME, ".overnight") + path.sep)) throw new Error("Refused: that is the real data folder.");
if (env.KIROCREW_PORT === "5476") throw new Error("Refused: 5476 is the live gateway's port.");
if (!/^idea_[A-Za-z0-9_]+$/.test(ideaId)) throw new Error("Usage: node submission/film/capture-build.ts <ideaId>");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const tilde = (text: string): string => text.split(HOME).join("~");
const say = (line: string): void => console.log(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/Boise", hour12: false })}] ${line}`);

function emptyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function ideaState(): string | null {
  const file = path.join(dataDir, "overnight.db");
  if (!existsSync(file)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const row = db.prepare("SELECT state FROM ideas WHERE id = ?").get(ideaId) as { state: string } | undefined;
    return row?.state ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** New JSON lines in the build log since the last look. */
function buildLogReader(): () => Array<{ at?: string; message?: string }> {
  const file = path.join(dataDir, "logs", "build.log");
  let offset = existsSync(file) ? statSync(file).size : 0;
  return () => {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    if (size <= offset) return [];
    const text = readFileSync(file).subarray(offset, size).toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return [];
    offset += Buffer.byteLength(text.slice(0, lastNl + 1));
    return text
      .slice(0, lastNl)
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { at?: string; message?: string }];
        } catch {
          return [];
        }
      });
  };
}

async function startDashboard(): Promise<{ child: ChildProcess; keyUrl: string }> {
  const child = spawn(process.execPath, [path.join(ROOT, "packages/dashboard/src/main.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const keyUrl = await new Promise<string>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error("the dashboard printed no link within 20 s")), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const found = /Overnight dashboard: (http:\/\/127\.0\.0\.1:4321\/\?key=[A-Za-z0-9_-]+)/.exec(seen);
      if (found?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`the dashboard ended (exit code ${code})`)));
  });
  return { child, keyUrl };
}

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body.innerText);
  } catch {
    return "";
  }
}

async function main(): Promise<number> {
  emptyDir(DASH_DIR);
  emptyDir(TODAY_DIR);
  const { child: dashboard, keyUrl } = await startDashboard();
  say("dashboard up (link kept in memory)");
  const browser = await chromium.launch();
  let rehearse: ChildProcess | null = null;
  let exitCode: number | null = null;
  const frames: Array<{ file: string; tMs: number; state: string | null; flagged: boolean }> = [];
  const todayFrames: Array<{ file: string; tMs: number; flagged: boolean }> = [];
  const events: Array<{ tMs: number; what: string }> = [];
  let guardStopped: string | null = null;
  try {
    const open = async (route: string): Promise<Page> => {
      const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, colorScheme: "light" });
      const page = await context.newPage();
      await page.goto(keyUrl);
      await page.goto(`http://127.0.0.1:4321${route}`);
      await page.waitForLoadState("networkidle");
      return page;
    };
    const ideaPage = await open(`/ideas/${ideaId}`);
    const todayPage = await open("/");
    const readLog = buildLogReader();

    const start = Date.now();
    const t = (): number => Date.now() - start;
    let crewStartedAt: number | null = null;
    let crewEnded = false;
    let deliveredShownAt: number | null = null;
    let deliveredInDbAt: number | null = null;
    let rehearseStartedAt: number | null = null;

    for (let n = 0; ; n += 1) {
      const due = start + n * 1000;
      await wait(due - Date.now());
      const tMs = t();

      // One idea-page frame every second.
      const file = `frame-${String(n + 1).padStart(5, "0")}.png`;
      await ideaPage.screenshot({ path: path.join(DASH_DIR, file), type: "png" });
      const text = await pageText(ideaPage);
      const flagged = FORBIDDEN.some((pattern) => pattern.test(text));
      const state = ideaState();
      frames.push({ file, tMs, state, flagged });
      // The Today page every 4 seconds.
      if (n % 4 === 0) {
        const todayFile = `frame-${String(n / 4 + 1).padStart(5, "0")}.png`;
        await todayPage.screenshot({ path: path.join(TODAY_DIR, todayFile), type: "png" });
        const todayText = await pageText(todayPage);
        todayFrames.push({ file: todayFile, tMs, flagged: FORBIDDEN.some((pattern) => pattern.test(todayText)) });
      }

      // The rehearsal starts after the pre-roll.
      if (rehearse === null && tMs >= PRE_ROLL_MS) {
        const out = createWriteStream(path.join(dataDir, "logs", "film-rehearse.out"), { flags: "a", mode: 0o600 });
        rehearse = spawn("npx", ["overnight", "rehearse", "run", ideaId], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        rehearse.stdout?.pipe(out);
        rehearse.stderr?.pipe(out);
        rehearse.stdout?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split("\n")) if (/^(\d\. |  Done|Link: )/.test(line)) say(`rehearsal: ${tilde(line)}`);
        });
        rehearse.on("exit", (code, signal) => {
          exitCode = code ?? (signal === null ? -1 : 128);
          events.push({ tMs: t(), what: `rehearsal ended (exit code ${exitCode})` });
          say(`rehearsal ended, exit code ${exitCode}`);
        });
        rehearseStartedAt = tMs;
        events.push({ tMs, what: "rehearsal started" });
        say("rehearsal started");
      }

      // The build log, for the film's timings and for the credit guard.
      for (const line of readLog()) {
        const message = line.message ?? "";
        if (/build starting|build started|kiro crew build started|kiro crew job ended|build finished|build failed|build try counted|moved out of the builders' reach|sandbox/.test(message)) events.push({ tMs, what: message });
        if (message === "kiro crew build started") crewStartedAt = Date.now();
        if (message === "kiro crew job ended") crewEnded = true;
        if (message.startsWith("build failed; trying the other backend once") && guardStopped === null) guardStopped = "the first builder failed and the second was about to start";
      }
      if (guardStopped === null && crewStartedAt !== null && !crewEnded && Date.now() - crewStartedAt > GUARD_AGENT_MS) guardStopped = `the Kiro Crew agent ran past ${GUARD_AGENT_MS / 1000} s`;
      if (guardStopped === null && rehearseStartedAt !== null && exitCode === null && tMs - rehearseStartedAt > GUARD_TOTAL_MS) guardStopped = "the rehearsal ran past its time";
      if (guardStopped !== null && rehearse?.pid !== undefined && exitCode === null && !events.some((e) => e.what.startsWith("guard"))) {
        events.push({ tMs, what: `guard: ${guardStopped}` });
        say(`GUARD: stopping the rehearsal: ${guardStopped}`);
        try {
          process.kill(-rehearse.pid, "SIGINT");
        } catch {
          rehearse.kill("SIGINT");
        }
      }

      // Delivered, as the idea page itself shows it (its first badge), and 10 seconds more.
      if (deliveredInDbAt === null && state === "delivered") deliveredInDbAt = tMs;
      if (deliveredShownAt === null && deliveredInDbAt !== null) {
        const badge = await ideaPage.evaluate(() => (document.querySelector("main")?.innerText ?? "").trim()).catch(() => "");
        // The page looks again every few seconds; 20 s after the database says so is past any doubt.
        if (badge.startsWith("Delivered") || tMs >= deliveredInDbAt + 20_000) {
          deliveredShownAt = tMs;
          events.push({ tMs, what: "the idea page shows Delivered" });
          say("the idea page shows Delivered");
        }
      }
      if (deliveredShownAt !== null && tMs >= deliveredShownAt + TAIL_MS && exitCode !== null) break;
      // A rehearsal that ended without delivering: 10 more seconds, then stop.
      if (exitCode !== null && deliveredShownAt === null && state !== "delivered") {
        const ended = events.find((e) => e.what.startsWith("rehearsal ended"));
        if (ended !== undefined && tMs >= ended.tMs + TAIL_MS) break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    dashboard.kill("SIGINT");
    await wait(1500);
    if (dashboard.exitCode === null) dashboard.kill("SIGTERM");
    writeFileSync(
      path.join(CAPTURE, "dashboard-frames.json"),
      `${JSON.stringify(
        {
          ideaId,
          dashboard: { dir: "dashboard", intervalMs: 1000, count: frames.length, flagged: frames.filter((f) => f.flagged).map((f) => f.file), frames: frames.map(({ file, tMs, state }) => ({ file, tMs, state })) },
          today: { dir: "today", intervalMs: 4000, count: todayFrames.length, flagged: todayFrames.filter((f) => f.flagged).map((f) => f.file) },
          events,
          rehearsalExitCode: exitCode,
          guardStopped,
        },
        null,
        2,
      )}\n`,
    );
  }
  say(`frames: ${readdirSync(DASH_DIR).length} idea page, ${readdirSync(TODAY_DIR).length} Today page; flagged: ${frames.filter((f) => f.flagged).length} and ${todayFrames.filter((f) => f.flagged).length}`);
  return exitCode === 0 && guardStopped === null ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`capture stopped: ${tilde(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  },
);
