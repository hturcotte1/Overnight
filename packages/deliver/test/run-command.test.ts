// Synthetic test data: the only programs started here are this Node, running one-line made-up scripts.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const node = process.execPath;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runCommand", () => {
  it("returns what the program printed and its exit code", async () => {
    const result = await runCommand(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], { timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, timedOut: false });
  });

  it("gives the program exactly the environment it was handed, or ours when none was", async () => {
    process.env.OVERNIGHT_MADE_UP_SECRET = "made-up-token";
    try {
      const print = "console.log(JSON.stringify([process.env.OVERNIGHT_MADE_UP_SECRET ?? null, process.env.ONLY ?? null]))";
      const stripped = await runCommand(node, ["-e", print], { env: { ONLY: "this" }, timeoutMs: 10_000 });
      expect(JSON.parse(stripped.stdout)).toEqual([null, "this"]);
      const inherited = await runCommand(node, ["-e", print], { timeoutMs: 10_000 });
      expect(JSON.parse(inherited.stdout)).toEqual(["made-up-token", null]);
    } finally {
      delete process.env.OVERNIGHT_MADE_UP_SECRET;
    }
  });

  it("runs in the folder it was given", async () => {
    const dir = tempDir();
    const result = await runCommand(node, ["-e", "console.log(process.cwd())"], { cwd: dir, timeoutMs: 10_000 });
    expect(result.stdout.trim()).toBe(dir);
  });

  it("stops a program at its time limit, together with everything it started", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "grandchild.pid");
    // The program starts a second one that would run for a minute, then waits for a minute itself.
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => {}, 60000);
    `;
    const started = Date.now();
    const result = await runCommand(node, ["-e", script], { timeoutMs: 700 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    await sleep(200);
    expect(alive(grandchild)).toBe(false);
  });

  it("also clears up what a program left running after it exited normally", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "left-behind.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      console.log("done");
    `;
    const started = Date.now();
    const result = await runCommand(node, ["-e", script], { timeoutMs: 20_000 });

    expect(result).toMatchObject({ stdout: "done\n", exitCode: 0, timedOut: false });
    // It did not wait for the left-behind program (which holds the output pipe open) to finish.
    expect(Date.now() - started).toBeLessThan(8_000);
    await sleep(200);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("says so, without throwing, when the program cannot be started", async () => {
    const result = await runCommand(path.join(tempDir(), "no-such-program"), [], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: "Could not start no-such-program (ENOENT)." });
  });

  it("keeps only the newest part of very long output", async () => {
    const result = await runCommand(node, ["-e", "process.stdout.write('a'.repeat(3 * 1024 * 1024) + 'THE-END')"], { timeoutMs: 20_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(1024 * 1024);
    expect(result.stdout.endsWith("THE-END")).toBe(true);
  });

  it("a program that finished in time is not reported as timed out, even when something still holds its output open past the limit", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "holder.pid");
    // The helper moves into a session of its own (so the group kill misses it) and keeps the output pipe.
    const started = Date.now();
    const result = await runCommand(node, ["-e", strayScript(pidFile, "/bin/sleep", ["30"], "inherit")], { timeoutMs: 1_500 });
    try {
      expect(result).toMatchObject({ stdout: "done\n", exitCode: 0, timedOut: false });
      // It waited for the pipe (about two seconds), which is longer than the limit, and still got it right.
      expect(Date.now() - started).toBeGreaterThan(1_500);
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      killQuietly(Number(readFileSync(pidFile, "utf8")));
    }
  });
});

/** A made-up build script: starts a helper in a session of its own, writes down its pid, says "done" and exits. */
function strayScript(pidFile: string, program: string, args: string[], stdio: "inherit" | "ignore", lingerMs = 0): string {
  return `
    const { spawn } = require("node:child_process");
    const helper = spawn(${JSON.stringify(program)}, ${JSON.stringify(args)}, { detached: true, stdio: ["ignore", ${JSON.stringify(stdio)}, ${JSON.stringify(stdio)}] });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    helper.unref();
    console.log("done");
    setTimeout(() => {}, ${lingerMs});
  `;
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

describe("runCommand: being stopped", () => {
  it("kills the program and everything it started when the stop signal fires, and says so", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "grandchild.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => {}, 60000);
    `;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 600);
    const started = Date.now();
    const result = await runCommand(node, ["-e", script], { timeoutMs: 60_000, signal: stop.signal });

    expect(result).toMatchObject({ exitCode: null, timedOut: false, stopped: true });
    expect(Date.now() - started).toBeLessThan(3_000);
    await sleep(200);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("starts nothing when the stop signal has already fired", async () => {
    const dir = tempDir();
    const marker = path.join(dir, "ran.txt");
    const stop = new AbortController();
    stop.abort();
    const result = await runCommand(node, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { timeoutMs: 10_000, signal: stop.signal });
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, stopped: true });
    await sleep(300);
    expect(existsSync(marker)).toBe(false);
  });

  it("is not marked stopped when the signal never fires", async () => {
    const stop = new AbortController();
    const result = await runCommand(node, ["-e", "console.log('fine')"], { timeoutMs: 10_000, signal: stop.signal });
    expect(result).toEqual({ stdout: "fine\n", stderr: "", exitCode: 0, timedOut: false });
  });
});

// These start real programs and read the real process table, the way the verifier does on macOS.
describe.skipIf(process.platform !== "darwin")("runCommand: hunting down what a tracked program left running", () => {
  it("reports nothing for a program that cleans up after itself", async () => {
    const result = await runCommand(node, ["-e", "console.log('tidy')"], { timeoutMs: 20_000, track: {} });
    expect(result).toEqual({ stdout: "tidy\n", stderr: "", exitCode: 0, timedOut: false, leftovers: { escaped: 0, expected: 0, unconfirmed: false } });
  });

  it("does not hand the program anything but its own environment plus the tag", async () => {
    const result = await runCommand(node, ["-e", "console.log(Object.keys(process.env).sort().join(','))"], { env: { ONLY: "this" }, timeoutMs: 20_000, track: {} });
    // (macOS adds __CF_USER_TEXT_ENCODING to every program by itself.)
    expect(result.stdout.trim().split(",").filter((name) => !name.startsWith("__"))).toEqual(["ONLY", "OVERNIGHT_RUN_TAG"]);
  });

  it("finds and kills a helper that left the process group and outlived the program (by the tag it inherited)", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "stray.pid");
    const result = await runCommand(node, ["-e", strayScript(pidFile, node, ["-e", "setTimeout(() => {}, 60000)"], "ignore")], { timeoutMs: 20_000, track: {} });
    const stray = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result).toMatchObject({ stdout: "done\n", exitCode: 0, timedOut: false, leftovers: { escaped: 1, expected: 0, unconfirmed: false } });
      expect(alive(stray)).toBe(false);
    } finally {
      killQuietly(stray);
    }
  });

  it("finds and kills a system program that left the group while the program was still running (by the family tree)", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "stray.pid");
    // /bin/sleep ships with macOS, so its environment (and the tag) cannot be seen: only its parent gives it away.
    const result = await runCommand(node, ["-e", strayScript(pidFile, "/bin/sleep", ["60"], "ignore", 1_200)], { timeoutMs: 20_000, track: {} });
    const stray = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result).toMatchObject({ exitCode: 0, leftovers: { escaped: 1, expected: 0, unconfirmed: false } });
      expect(alive(stray)).toBe(false);
    } finally {
      killQuietly(stray);
    }
  });

  it("also does so when the program had to be stopped at its time limit", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "stray.pid");
    const result = await runCommand(node, ["-e", strayScript(pidFile, node, ["-e", "setTimeout(() => {}, 60000)"], "ignore", 60_000)], { timeoutMs: 900, track: {} });
    const stray = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result).toMatchObject({ exitCode: null, timedOut: true, leftovers: { escaped: 1, unconfirmed: false } });
      expect(alive(stray)).toBe(false);
    } finally {
      killQuietly(stray);
    }
  });

  it("counts a helper whose program lives in an expected folder separately, and kills it all the same", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "stray.pid");
    const result = await runCommand(node, ["-e", strayScript(pidFile, node, ["-e", "setTimeout(() => {}, 60000)"], "ignore")], { timeoutMs: 20_000, track: { expectUnder: [path.dirname(realpathSync(node))] } });
    const stray = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result.leftovers).toEqual({ escaped: 0, expected: 1, unconfirmed: false });
      expect(alive(stray)).toBe(false);
    } finally {
      killQuietly(stray);
    }
  });

  it("finds and kills a system program that left the group, by the fresh folder it still works in, however quickly its parent exited", async () => {
    const dir = tempDir();
    const box = path.join(dir, "box");
    mkdirSync(path.join(box, "app"), { recursive: true });
    const pidFile = path.join(dir, "stray.pid");
    // No tag to see (a system program), no parent left to ask, no pipe held: only where it lives gives it away.
    const result = await runCommand(node, ["-e", strayScript(pidFile, "/bin/sleep", ["60"], "ignore")], { cwd: path.join(box, "app"), timeoutMs: 20_000, track: { livesUnder: [box] } });
    const stray = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result).toMatchObject({ stdout: "done\n", exitCode: 0, leftovers: { escaped: 1, expected: 0, unconfirmed: false } });
      expect(alive(stray)).toBe(false);
    } finally {
      killQuietly(stray);
    }
  });

  it("says it could not confirm everything is gone when something it cannot find still holds the program's output", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "holder.pid");
    // A system program in its own session, started by a program that exits at once: no tag to
    // see, no parent left to ask. Only the pipe it still holds gives it away.
    const result = await runCommand(node, ["-e", strayScript(pidFile, "/bin/sleep", ["30"], "inherit")], { timeoutMs: 20_000, track: {} });
    try {
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, leftovers: { unconfirmed: true } });
    } finally {
      killQuietly(Number(readFileSync(pidFile, "utf8")));
    }
  });
});
