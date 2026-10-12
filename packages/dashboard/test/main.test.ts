// SYNTHETIC: every title, pitch, quote and line these tests look at is made up by the demo's seed. None of it is Bee data.
//
// The command itself (src/main.ts), started as its own program the way `npm run dashboard` and
// `npm run dashboard:demo` start it. Every run here either shows invented data in a throwaway
// folder, or is pointed at an empty scratch folder with OVERNIGHT_DATA_DIR and never gets as far
// as showing anything. Nothing under ~/.overnight is opened.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DASHBOARD_PORT } from "@overnight/core";
import { afterEach, describe, expect, it } from "vitest";
import { DASHBOARD_USAGE } from "../src/args.ts";
import { IS_THE_REAL_FOLDER } from "../src/demo/folder.ts";
import { DEMO_FOLDER_PREFIX } from "../src/demo/stage.ts";
import { keyCookieName } from "../src/server/guard.ts";
import { removeScratch, scratch } from "./demo-server.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface Run {
  child: ChildProcessByStdio<null, Readable, Readable>;
  out: () => string;
  err: () => string;
  /** Resolves with the exit code (or the signal's name) once the program has ended. */
  ended: Promise<number | string | null>;
  /** The folder the program was given as its temporary folder: a demo makes its own folder in here. */
  tmp: string;
}

const runs: Run[] = [];
const blockers: Server[] = [];

/** Start the command. Its temporary folder is one of ours, and it is never left to find the real data folder by itself. */
function start(args: readonly string[], env: Record<string, string> = {}): Run {
  const tmp = scratch();
  const child = spawn(process.execPath, [MAIN, ...args], {
    // Whatever happens, a run that is not a demo reads this empty folder and no other.
    env: { ...process.env, TMPDIR: tmp, OVERNIGHT_DATA_DIR: path.join(tmp, "no-data-here"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const ended = new Promise<number | string | null>((resolve) => child.on("close", (code, signal) => resolve(code ?? signal)));
  const run: Run = { child, out: () => out, err: () => err, ended, tmp };
  runs.push(run);
  return run;
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await run.ended;
  }
  await Promise.all(blockers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  removeScratch();
});

/** Wait until the program has printed something that matches, or has ended. */
async function printed(run: Run, pattern: RegExp, text: () => string = run.out): Promise<RegExpExecArray> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const match = pattern.exec(text());
    if (match !== null) return match;
    if (Date.now() > deadline || run.child.exitCode !== null) throw new Error(`the dashboard did not print what was expected (it has ${run.child.exitCode === null ? "not ended" : "ended"})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Take a port and hold it. True when it is held, by us or already by another program. */
async function holdPort(port: number): Promise<boolean> {
  const server = createServer((socket) => socket.destroy());
  const held = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(true) : reject(error)));
    server.listen(port, "127.0.0.1", () => {
      blockers.push(server);
      resolve(true);
    });
  });
  return held;
}

const LINK = /^Overnight dashboard: (http:\/\/127\.0\.0\.1:(\d+)\/\?key=([A-Za-z0-9_-]{32}))$/m;

async function page(port: number, key: string, address: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${address}`, { headers: { Cookie: `${keyCookieName(port)}=${key}` }, redirect: "manual" });
  return { status: response.status, text: await response.text() };
}

const demoFolders = (tmp: string): string[] => readdirSync(tmp).filter((name) => name.startsWith(DEMO_FOLDER_PREFIX));

describe("npm run dashboard:demo", { timeout: 20_000 }, () => {
  it("prints its link, shows the invented scene, and puts everything away when it is stopped with Ctrl-C", async () => {
    const port = await freePort();
    const run = start(["--demo", "--port", String(port)]);
    const link = await printed(run, LINK);
    expect(link[2]).toBe(String(port));
    await printed(run, /^Demo data: everything shown is invented\. Stop it with Ctrl-C\.$/m);
    expect(run.out().split("\n").filter((line) => line !== "")).toHaveLength(2);
    expect(run.out()).not.toContain("Filming mode");
    expect(run.err()).toBe("");

    // One folder of its own, in the temporary folder it was given.
    expect(demoFolders(run.tmp)).toHaveLength(1);
    expect(readdirSync(run.tmp)).toHaveLength(1);

    const key = link[3] ?? "";
    const withoutKey = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(withoutKey.status).toBe(401);
    // Even the page that shows nothing says the data would be invented: the command was told so.
    expect(await withoutKey.text()).toContain('data-pill="demo">DEMO DATA: invented<');
    const opened = await fetch(link[1] ?? "", { redirect: "manual" });
    expect(opened.status).toBe(303);
    const today = await page(port, key, "/");
    expect(today.status).toBe(200);
    expect(today.text).toContain("<title>DEMO · Today · Overnight</title>");
    expect(today.text).toContain("Kiro Crew is building");
    expect(today.text).toContain("Chore Wheel");
    expect(today.text).toContain('data-pill="demo">DEMO DATA: invented<');
    // The demo holds the locks the real programs would, so the page says what the scene says.
    expect(today.text).toContain('data-pill="listening">Listening<');
    expect(today.text).toContain('data-pill="private">Shows what was said<');
    // The pretend clock: 1:02 AM in the demo's own zone, whatever time it really is.
    expect(today.text).toMatch(/<span data-clock="wall">1:0[2-3] AM<\/span>/);
    const settings = await page(port, key, "/settings");
    expect(settings.text).toContain("Invented data (demo)");
    expect(settings.text).toContain(`http://127.0.0.1:${port}`);
    expect(settings.text).toContain(DEMO_FOLDER_PREFIX);

    run.child.kill("SIGINT");
    expect(await run.ended).toBe(0);
    expect(readdirSync(run.tmp)).toEqual([]);
    // Nothing answers any more.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(run.err()).toBe("");
  });

  it("hides what was said with --filming, says so when it starts, and stops cleanly on a stop from outside", async () => {
    const port = await freePort();
    // The idea named here is not in the scene; the page still says which quotes were let through.
    const run = start(["--demo", "--filming", "--show-quote", "idea_20261012_n0th1ng0", "--port", String(port)]);
    const link = await printed(run, LINK);
    await printed(run, /^Filming mode is on: what was said is hidden\.$/m);
    expect((await page(port, link[3] ?? "", "/settings")).text.replace(/<[^>]+>/g, " ")).toMatch(/Quotes let through\s+idea_20261012_n0th1ng0/);
    const today = await page(port, link[3] ?? "", "/");
    expect(today.text).toContain('data-pill="filming">FILMING: what was said is hidden<');
    expect(today.text).not.toContain("it would be cool if a wheel just picked who does the dishes");
    expect(today.text).toContain("Hidden while filming");
    run.child.kill("SIGTERM");
    expect(await run.ended).toBe(0);
    expect(readdirSync(run.tmp)).toEqual([]);
  });

  it("with --play says so, and the invented night starts by itself", async () => {
    const port = await freePort();
    const run = start(["--demo", "--play", "--port", String(port)]);
    const link = await printed(run, LINK);
    await printed(run, /^An invented night starts in a few seconds and ticks through by itself\.$/m);
    const key = link[3] ?? "";
    const packagesMark = async (): Promise<string | undefined> => /data-check="mark-packages" data-status="(\w+)"/.exec((await page(port, key, "/")).text)?.[1];
    expect(await packagesMark()).toBe("todo");
    // Three seconds after the start the first step runs: the build's packages are "installed".
    await expect.poll(packagesMark, { timeout: 8000, interval: 250 }).toBe("done");
    // A closed terminal window stops it as cleanly as Ctrl-C does.
    run.child.kill("SIGHUP");
    expect(await run.ended).toBe(0);
    expect(readdirSync(run.tmp)).toEqual([]);
  });

  it("refuses, in the demo's own plain sentence, to make its folder inside the real data folder", async () => {
    // A pretend home folder with a pretend ~/.overnight, handed to the program as its temporary folder.
    const home = scratch();
    const real = path.join(home, ".overnight");
    mkdirSync(real);
    const run = start(["--demo", "--port", String(await freePort())], { HOME: home, TMPDIR: real });
    expect(await run.ended).toBe(1);
    expect(run.err().trim()).toBe(IS_THE_REAL_FOLDER);
    expect(run.err()).not.toContain(home);
    expect(run.out()).toBe("");
    expect(readdirSync(real)).toEqual([]);
  });

  // This start used to work: the whole throwaway folder (database, logs, lock files) was built inside the real data folder.
  it.runIf(process.platform === "darwin")("refuses the same when the real data folder is given by the Mac's other name for it, under /System/Volumes/Data", async () => {
    const home = scratch();
    const real = path.join(home, ".overnight");
    mkdirSync(real);
    const run = start(["--demo", "--port", String(await freePort())], { HOME: home, TMPDIR: path.join("/System/Volumes/Data", real) });
    expect(await run.ended).toBe(1);
    expect(run.err().trim()).toBe(IS_THE_REAL_FOLDER);
    expect(run.err()).not.toContain(home);
    expect(run.out()).toBe("");
    expect(readdirSync(real)).toEqual([]);
  });

  it("says so in one sentence when its port is taken, and leaves no folder behind", async () => {
    const port = await freePort();
    expect(await holdPort(port)).toBe(true);
    const run = start(["--demo", "--port", String(port)]);
    expect(await run.ended).toBe(1);
    expect(run.err().trim()).toBe(`Port ${port} is in use. The dashboard may already be running. Stop it first, or pick another: npm run dashboard:demo -- --port 4322`);
    expect(run.out()).toBe("");
    expect(readdirSync(run.tmp)).toEqual([]);
  });
});

describe("npm run dashboard", { timeout: 20_000 }, () => {
  it("shows real data on the one fixed port only: when that port is taken it says so and ends, having made nothing", async () => {
    // The port is held here, or by whatever already has it (perhaps a dashboard that is really running: it is left alone).
    expect(await holdPort(DASHBOARD_PORT)).toBe(true);
    const run = start([]);
    expect(await run.ended).toBe(1);
    expect(run.err().trim()).toBe(`Port ${DASHBOARD_PORT} is in use. The dashboard may already be running. Stop it first.`);
    expect(run.out()).toBe("");
    // No data folder was made, and no demo folder either.
    expect(readdirSync(run.tmp)).toEqual([]);
  });

  it("stops on a bad setting, names it, and says where settings live", async () => {
    const run = start([], { MAX_ASKS_PER_DAY: "many" });
    expect(await run.ended).toBe(2);
    const lines = run.err().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Bad setting\. MAX_ASKS_PER_DAY: /);
    expect(lines[1]).toBe("Settings live in the .env file at the top of the repo (see .env.example).");
    expect(run.out()).toBe("");
    expect(readdirSync(run.tmp)).toEqual([]);
  });

  it("refuses a wrong option in one sentence, before anything is opened", async () => {
    for (const [args, sentence] of [
      [["--port", "4999"], `--port only works with --demo: Overnight's real data is only ever shown on port ${DASHBOARD_PORT}.`],
      [["--play"], "--play only works with --demo: it runs an invented night on invented data."],
      [["--loud"], 'The dashboard has no option "--loud"; --help lists the ones it has.'],
    ] as Array<[string[], string]>) {
      const run = start(args);
      expect(await run.ended, args.join(" ")).toBe(2);
      expect(run.err().trim()).toBe(sentence);
      expect(run.out()).toBe("");
      expect(readdirSync(run.tmp)).toEqual([]);
    }
  });

  // `npm run dashboard --filming` and `npm run dashboard --demo` used to start: with every quote shown, and on the real data.
  it("refuses to start when npm kept one of its options: typed before the two dashes, --filming or --demo never arrives", async () => {
    for (const [option, env] of [
      ["--filming", { npm_config_filming: "true" }],
      ["--demo", { npm_config_demo: "true" }],
    ] as Array<[string, Record<string, string>]>) {
      const run = start([], { npm_lifecycle_event: "dashboard", ...env });
      expect(await run.ended, option).toBe(2);
      expect(run.err().trim()).toBe(`${option} was typed before npm's two dashes, so npm kept it and the dashboard was not started without it. Put it after the two dashes: npm run dashboard -- ${option}`);
      expect(run.out()).toBe("");
      expect(readdirSync(run.tmp)).toEqual([]);
    }
    // Said before a wrong option is: "4400" is all that reaches the script of `npm run dashboard:demo --port 4400`.
    const run = start(["--demo", "4400"], { npm_lifecycle_event: "dashboard:demo", npm_config_port: "true" });
    expect(await run.ended).toBe(2);
    expect(run.err().trim()).toBe("--port was typed before npm's two dashes, so npm kept it and the dashboard was not started without it. Put it after the two dashes: npm run dashboard:demo -- --port <n>");
    expect(readdirSync(run.tmp)).toEqual([]);
  });

  it("starts as usual when the option npm kept was also given properly", async () => {
    const port = await freePort();
    const run = start(["--demo", "--filming", "--port", String(port)], { npm_config_filming: "true", npm_config_demo: "true" });
    await printed(run, LINK);
    await printed(run, /^Filming mode is on: what was said is hidden\.$/m);
    run.child.kill("SIGINT");
    expect(await run.ended).toBe(0);
    expect(run.err()).toBe("");
  });

  it("--help prints the options and starts nothing", async () => {
    const run = start(["--help"]);
    expect(await run.ended).toBe(0);
    expect(run.out().trim()).toBe(DASHBOARD_USAGE);
    expect(run.err()).toBe("");
    expect(readdirSync(run.tmp)).toEqual([]);
  });
});
