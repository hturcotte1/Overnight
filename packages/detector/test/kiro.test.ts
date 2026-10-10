// All text in this file is made up for the tests. None of it is Bee data.
// The real runner is tested with Node itself, or a small shell script, standing in for kiro-cli.
// Kiro is never started.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createKiroRunner, stripAnsi } from "../src/index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "overnight-kiro-test-"));
const where = { cwd: dir, kiroHome: path.join(dir, "kiro-home"), timeoutMs: 8_000 };
const run = createKiroRunner({ kiroBinary: process.execPath });
const ESC = String.fromCharCode(27);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("stripAnsi", () => {
  it("removes colour and cursor codes and normalises line ends", () => {
    expect(stripAnsi(`${ESC}[1;32mgreen${ESC}[0m plain${ESC}[2K${ESC}[?25l`)).toBe("green plain");
    expect(stripAnsi(`${ESC}]0;window title${String.fromCharCode(7)}text`)).toBe("text");
    expect(stripAnsi("one\r\ntwo\rthree\n")).toBe("one\ntwo\nthree\n");
  });
});

describe("the real runner", () => {
  it("captures both streams, the exit code, and strips colour codes", async () => {
    const script = "const esc = String.fromCharCode(27); process.stdout.write(esc + '[32mcaf' + String.fromCharCode(233) + esc + '[0m' + String.fromCharCode(13, 10)); process.stderr.write('a note'); process.exitCode = 3;";
    expect(await run(["-e", script], where)).toEqual({ stdout: "café\n", stderr: "a note", exitCode: 3, timedOut: false });
  });

  it("runs in the folder it was given, with a stripped-down environment", async () => {
    process.env.OVERNIGHT_TEST_SECRET = "must-not-be-passed-on";
    try {
      const result = await run(["-e", "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }))"], where);
      const seen = JSON.parse(result.stdout) as { cwd: string; env: Record<string, string> };
      expect(path.basename(seen.cwd)).toBe(path.basename(dir));
      expect(seen.env).toMatchObject({ HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1", KIRO_HOME: where.kiroHome });
      // macOS adds a variable of its own (__CF_USER_TEXT_ENCODING) to every process.
      expect(Object.keys(seen.env).filter((key) => !key.startsWith("__")).sort()).toEqual(["HOME", "KIRO_HOME", "NO_COLOR", "PATH", "TMPDIR"]);
    } finally {
      delete process.env.OVERNIGHT_TEST_SECRET;
    }
  });

  it("kills the whole process group when the time is up", async () => {
    // The stand-in starts a helper of its own and then hangs, the way a stuck kiro-cli would.
    const script = "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log(helper.pid); setTimeout(() => {}, 60000);";
    const started = Date.now();
    const result = await run(["-e", script], { ...where, timeoutMs: 1_500 });

    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(result.error).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(6_000);
    const helperPid = Number(result.stdout.trim());
    expect(helperPid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && isAlive(helperPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(helperPid)).toBe(false);
  });

  it("reports a missing program instead of throwing, and marks it as worth trying again later", async () => {
    const missing = createKiroRunner({ kiroBinary: path.join(dir, "no-such-kiro-cli") });
    expect(await missing(["chat"], where)).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (ENOENT)", unavailable: "missing" });
  });

  it("does not call the program missing when it is the working folder that is gone, or the program cannot be run", async () => {
    const noFolder = await run(["-e", "console.log('never runs')"], { ...where, cwd: path.join(dir, "no-such-folder") });
    expect(noFolder).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (ENOENT)" });

    const notAProgram = path.join(dir, "not-a-program");
    writeFileSync(notAProgram, "just text", { mode: 0o600 });
    const refused = await createKiroRunner({ kiroBinary: notAProgram })(["chat"], where);
    expect(refused).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (EACCES)" });
  });

  it("keeps the arguments out of the error when Node refuses to start the program", async () => {
    // A NUL character makes Node throw before anything starts, and Node's message repeats the argument.
    const result = await run(["chat", `someone should build a page for bin day${String.fromCharCode(0)}`], where);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: "could not start kiro-cli (ERR_INVALID_ARG_VALUE)" });
    expect(JSON.stringify(result)).not.toContain("bin day");
  });
});

// What happens to a chat in flight when the process is told to stop. Each case runs
// helpers/signal-child.ts as its own Node process, with a shell script standing in for kiro-cli.
describe("stop signals", () => {
  const child = fileURLToPath(new URL("./helpers/signal-child.ts", import.meta.url));
  const STAND_IN = [
    "#!/bin/sh",
    "# A stand-in for kiro-cli, for tests. It is not Kiro and sends nothing anywhere.",
    'case "$1" in',
    '  settings) echo "false (global)" ;;',
    '  whoami) echo "Logged in with a test stand-in" ;;',
    // A chat: note that it started (its process id is also its process group), then hang.
    '  *) echo "$$" >> "$KIRO_HOME/chats.log"; exec sleep 30 ;;',
    "esac",
    "",
  ].join("\n");

  interface ChildReport {
    ownHandlerRan: boolean;
    result: Record<string, unknown>;
    afterwards: Record<string, unknown>;
    msToComeBack: number;
    chats: number;
  }

  async function runChild(order: string): Promise<{ exitCode: number | null; signal: string | null; report: ChildReport | null; chatPids: number[] }> {
    const dataDir = mkdtempSync(path.join(dir, `signals-${order}-`));
    const standIn = path.join(dataDir, "stand-in-kiro.sh");
    writeFileSync(standIn, STAND_IN);
    chmodSync(standIn, 0o755);
    mkdirSync(path.join(dataDir, "kiro-detector"), { recursive: true });

    const ended = await new Promise<{ exitCode: number | null; signal: string | null; stdout: string }>((resolve) => {
      const env = { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir() };
      const running = execFile(process.execPath, [child, order, dataDir, standIn], { env, timeout: 25_000 }, (_error, stdout) => {
        resolve({ exitCode: running.exitCode, signal: running.signalCode, stdout });
      });
    });
    let chatPids: number[] = [];
    try {
      chatPids = readFileSync(path.join(dataDir, "kiro-detector", "chats.log"), "utf8").split("\n").filter(Boolean).map(Number);
    } catch {
      // No chat was ever started.
    }
    const lastLine = ended.stdout.trim().split("\n").at(-1) ?? "";
    return { exitCode: ended.exitCode, signal: ended.signal, report: lastLine.startsWith("{") ? (JSON.parse(lastLine) as ChildReport) : null, chatPids };
  }

  async function expectGone(pid: number): Promise<void> {
    for (let i = 0; i < 40 && isAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(false);
  }

  // The three places a program's own handler can be, relative to ours. In every one of them the
  // program is handling the signal, so we must kill Kiro and leave the stopping to the program.
  for (const order of ["before", "after", "in-front"]) {
    it(`kills the chat, starts no other and leaves the process running when the program has its own handler (added ${order})`, async () => {
      const { exitCode, signal, report, chatPids } = await runChild(order);

      // The child got to its last line and ended by itself: nobody called process.exit under it.
      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });
      expect(report).not.toBeNull();
      expect(report!.ownHandlerRan).toBe(true);

      // Exactly one chat was started, and detect() came straight back saying "ask again later".
      expect(report!.chats).toBe(1);
      expect(chatPids).toHaveLength(1);
      expect(report!.result).toEqual({ ok: false, reason: "kiro-cli was stopped: this process is stopping", ms: expect.any(Number), attempts: 1, retryLater: true });
      expect(report!.msToComeBack).toBeLessThan(3_000);
      expect(report!.afterwards).toMatchObject({ ok: false, reason: "kiro-cli was not started: this process is stopping", retryLater: true });
      await expectGone(chatPids[0]!);
    }, 30_000);
  }

  it("kills the chat and ends the process, as Node would have, when nothing else handles the signal", async () => {
    const { exitCode, signal, report, chatPids } = await runChild("none");

    expect({ exitCode, signal }).toEqual({ exitCode: 143, signal: null });
    expect(report).toBeNull();
    expect(chatPids).toHaveLength(1);
    await expectGone(chatPids[0]!);
  }, 30_000);
});
