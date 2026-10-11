// All text in this file is made up for the tests. None of it is Bee data.
// The real command runner is tested with Node itself standing in for the outside program.
// Neither Kiro nor Kiro Crew is started.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRunner } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const run = createCommandRunner();
const node = process.execPath;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, withinMs = 3_000): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

describe("the real command runner", () => {
  it("captures both streams and the exit code, and strips colour codes", async () => {
    const script = "const esc = String.fromCharCode(27); process.stdout.write(esc + '[32mcaf' + String.fromCharCode(233) + esc + '[0m' + String.fromCharCode(13, 10)); process.stderr.write('a note'); process.exitCode = 3;";
    expect(await run(node, ["-e", script], { timeoutMs: 8_000 })).toEqual({ stdout: "café\n", stderr: "a note", exitCode: 3, timedOut: false });
  });

  it("runs in the folder and with the environment it was given, and nothing else", async () => {
    process.env.OVERNIGHT_TEST_SECRET = "must-not-be-passed-on";
    try {
      const dir = tempDir();
      const result = await run(node, ["-e", "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }))"], { cwd: dir, env: { ONLY: "this", PATH: "/usr/bin:/bin" }, timeoutMs: 8_000 });
      const seen = JSON.parse(result.stdout) as { cwd: string; env: Record<string, string> };
      expect(path.basename(seen.cwd)).toBe(path.basename(dir));
      // macOS adds a variable of its own (__CF_USER_TEXT_ENCODING) to every process.
      expect(Object.keys(seen.env).filter((key) => !key.startsWith("__")).sort()).toEqual(["ONLY", "PATH"]);
    } finally {
      delete process.env.OVERNIGHT_TEST_SECRET;
    }
  });

  it("gives a small environment of its own when none is named, never ours", async () => {
    process.env.OVERNIGHT_TEST_SECRET = "must-not-be-passed-on";
    try {
      const result = await run(node, ["-e", "console.log(JSON.stringify(process.env))"], { timeoutMs: 8_000 });
      const env = JSON.parse(result.stdout) as Record<string, string>;
      expect(Object.keys(env).filter((key) => !key.startsWith("__")).sort()).toEqual(["HOME", "NO_COLOR", "PATH", "TMPDIR"]);
      expect(env).toMatchObject({ HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1" });
    } finally {
      delete process.env.OVERNIGHT_TEST_SECRET;
    }
  });

  it("kills the whole process group when the time is up", async () => {
    // The stand-in starts a helper of its own and then hangs, the way a stuck build would.
    const script = "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log(helper.pid); setTimeout(() => {}, 60000);";
    const started = Date.now();
    const result = await run(node, ["-e", script], { timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const helperPid = Number(result.stdout.trim());
    expect(helperPid).toBeGreaterThan(0);
    expect(await waitUntilGone(helperPid)).toBe(true);
  });

  it("does not leave anything running, or wait for it, when the program ends but a helper lives on", async () => {
    // Like a build that forgets to stop its preview server: the helper keeps the output open.
    const script = "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); helper.unref(); console.log(helper.pid);";
    const started = Date.now();
    const result = await run(node, ["-e", script], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await waitUntilGone(Number(result.stdout.trim()))).toBe(true);
  });

  it("answers with an error, naming a code only, when the program does not exist", async () => {
    const result = await run(path.join(tempDir(), "no-such-program"), ["--secret-looking-argument"], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start the program (ENOENT)" });
    expect(JSON.stringify(result)).not.toContain("secret-looking");
  });

  it("stops the program, and everything it started, as soon as its stop signal is aborted", async () => {
    const script = "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log(helper.pid); setTimeout(() => {}, 60000);";
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 400);
    const result = await run(node, ["-e", script], { timeoutMs: 30_000, signal: stop.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: "the program was stopped: this process is stopping" });
    expect(await waitUntilGone(Number(result.stdout.trim()))).toBe(true);
  });

  it("does not start a program whose stop signal is already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const marker = path.join(tempDir(), "started.txt");
    const result = await run(node, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { timeoutMs: 5_000, signal: stop.signal });
    expect(result).toMatchObject({ exitCode: null, error: "the program was not started: this process is stopping" });
    expect(existsSync(marker)).toBe(false);
  });

  it("lets a program that is being stopped finish by itself within its grace time", async () => {
    // Like `kirocrew cron add` caught by a stop: it is about to print the id of the job it added.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const quick = await run(node, ["-e", "setTimeout(() => { console.log('Added job: 76be9f71'); }, 600);"], { timeoutMs: 30_000, signal: stop.signal, stopGraceMs: 5_000 });
    expect(quick).toEqual({ stdout: "Added job: 76be9f71\n", stderr: "", exitCode: 0, timedOut: false });

    // One that does not finish in time is killed when the grace time is up.
    const again = new AbortController();
    setTimeout(() => again.abort(), 100);
    const started = Date.now();
    const slow = await run(node, ["-e", "setTimeout(() => {}, 60000);"], { timeoutMs: 30_000, signal: again.signal, stopGraceMs: 500 });
    expect(slow).toMatchObject({ exitCode: null, timedOut: false, error: "the program was stopped: this process is stopping" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("runs clean-up even when the stop signal is already aborted, under its own time limit", async () => {
    const stop = new AbortController();
    stop.abort();
    const done = await run(node, ["-e", "console.log('Removed job: 76be9f71')"], { timeoutMs: 8_000, signal: stop.signal, cleanup: true });
    expect(done).toEqual({ stdout: "Removed job: 76be9f71\n", stderr: "", exitCode: 0, timedOut: false });

    const started = Date.now();
    const hung = await run(node, ["-e", "setTimeout(() => {}, 60000);"], { timeoutMs: 500, cleanup: true });
    expect(hung).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives clean-up that is caught by a stop its grace time, and no more", async () => {
    // A removal that hangs: without a limit it would hold up the stop for its whole minute.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    const hung = await run(node, ["-e", "setTimeout(() => {}, 60000);"], { timeoutMs: 30_000, cleanup: true, signal: stop.signal, stopGraceMs: 400 });
    expect(hung).toMatchObject({ exitCode: null, timedOut: false, error: "the program was stopped: this process is stopping" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(5_000);

    // One that finishes inside its grace time is left to.
    const again = new AbortController();
    setTimeout(() => again.abort(), 100);
    const done = await run(node, ["-e", "setTimeout(() => { console.log('Removed job: 76be9f71'); }, 400);"], { timeoutMs: 30_000, cleanup: true, signal: again.signal, stopGraceMs: 5_000 });
    expect(done).toEqual({ stdout: "Removed job: 76be9f71\n", stderr: "", exitCode: 0, timedOut: false });
  });

  it("stops listening to the stop signal once the program has ended", async () => {
    const stop = new AbortController();
    const result = await run(node, ["-e", "process.exitCode = 0"], { timeoutMs: 8_000, signal: stop.signal });
    expect(result.exitCode).toBe(0);
    // Aborting afterwards changes nothing and reaches nobody.
    stop.abort();
    expect(result.error).toBeUndefined();
  });

  it("keeps the end of a very long output", async () => {
    const script = "process.stdout.write('a'.repeat(1500000)); process.stdout.write('b'.repeat(1500000)); process.stdout.write('THE-END');";
    const result = await run(node, ["-e", script], { timeoutMs: 20_000 });
    expect(result.stdout.length).toBeLessThanOrEqual(1_000_000);
    expect(result.stdout.endsWith("THE-END")).toBe(true);
  });
});
