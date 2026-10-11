// All text in this file is made up for the tests. None of it is Bee data.
// The real runner is tested with Node itself, or a small shell script, standing in for kiro-cli.
// Kiro is never started.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dataPaths } from "@overnight/core";
import type { DetectorInput } from "@overnight/core";
import { buildPrompt, createKiroDetector, createKiroRunner, MAX_ARGUMENT_CHARS, stripAnsi } from "../src/index.ts";

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
    // The same with text waiting to be handed over: nothing is thrown, and the text is in no error.
    const withText = await missing(["chat"], { ...where, stdin: "someone should build a page for bin day. ".repeat(50_000) });
    expect(withText).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (ENOENT)", unavailable: "missing" });
  });

  it("does not call the program missing when it is the working folder that is gone, or the program cannot be run", async () => {
    const noFolder = await run(["-e", "console.log('never runs')"], { ...where, cwd: path.join(dir, "no-such-folder") });
    expect(noFolder).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (ENOENT)" });

    const notAProgram = path.join(dir, "not-a-program");
    writeFileSync(notAProgram, "just text", { mode: 0o600 });
    const refused = await createKiroRunner({ kiroBinary: notAProgram })(["chat"], where);
    expect(refused).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start kiro-cli (EACCES)" });
    const refusedWithText = await createKiroRunner({ kiroBinary: notAProgram })(["chat"], { ...where, stdin: "someone should build a page for bin day" });
    expect(refusedWithText).toEqual(refused);
  });

  it("hands text over on standard input, whole, and it never shows in the program's arguments", async () => {
    // An invented conversation of many lines, with letters outside plain ASCII in it.
    const text = ["[19:00:09] Someone should build a little page for bin day.", "[19:00:15] Crème brûlée first, señor. 日本語 🙂", ...Array.from({ length: 40 }, (_, i) => `[19:01:${String(i).padStart(2, "0")}] invented line ${i}`)].join("\n");
    // The stand-in reads all of its standard input, then asks the system what its own arguments
    // are, the way any other program on the Mac could (ps prints them for every process).
    const standIn = path.join(dir, "reads-stdin.cjs");
    writeFileSync(
      standIn,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => (input += chunk));",
        "process.stdin.on('end', () => {",
        "  const seenByPs = require('node:child_process').execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(process.pid)], { encoding: 'utf8' });",
        "  console.log(JSON.stringify({ input, argv: process.argv.slice(2), seenByPs }));",
        "});",
      ].join("\n"),
    );
    const result = await run([standIn, "chat", "--marker-argument"], { ...where, stdin: text });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const seen = JSON.parse(result.stdout) as { input: string; argv: string[]; seenByPs: string };
    expect(seen.input).toBe(text);
    expect(seen.argv).toEqual(["chat", "--marker-argument"]);
    // ps can see the arguments (the marker is there), and what was said is not among them.
    expect(seen.seenByPs).toContain("--marker-argument");
    for (const words of ["bin day", "Someone should", "invented line", "19:00", "brûlée"]) expect(seen.seenByPs).not.toContain(words);
  });

  it("gives the program an empty standard input when there is no text for it", async () => {
    const script = "let bytes = 0; process.stdin.on('data', (chunk) => (bytes += chunk.length)); process.stdin.on('end', () => console.log(JSON.stringify({ bytes, ended: true })));";
    const result = await run(["-e", script], where);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({ bytes: 0, ended: true });
  });

  it("delivers a text far bigger than a pipe holds at once", async () => {
    const text = "an invented sentence that nobody said. ".repeat(60_000);
    const script = "let bytes = 0; process.stdin.on('data', (chunk) => (bytes += chunk.length)); process.stdin.on('end', () => console.log(bytes));";
    const result = await run(["-e", script], { ...where, stdin: text });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Number(result.stdout.trim())).toBe(Buffer.byteLength(text));
  });

  it("comes back with the exit code, and no error, when the program ends without reading its input", async () => {
    // Far more than a pipe holds, so the write is still waiting when the program goes away. That
    // ends in EPIPE, which must not surface: not as a result error and not as a crash.
    const text = "an invented sentence that nobody said. ".repeat(60_000);
    const unhandled: unknown[] = [];
    const note = (error: unknown): void => void unhandled.push(error);
    process.on("uncaughtException", note);
    try {
      const result = await run(["-e", "process.exitCode = 3;"], { ...where, stdin: text });
      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 3, timedOut: false });
      // Give a late pipe error the time to show up.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", note);
    }
  });

  it("still kills on time when the program never reads its input", async () => {
    const text = "an invented sentence that nobody said. ".repeat(60_000);
    const started = Date.now();
    const result = await run(["-e", "setTimeout(() => {}, 60000);"], { ...where, stdin: text, timeoutMs: 1_000 });
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses to start with an argument long enough to hold a conversation", async () => {
    const said = "Someone should build a little page for bin day. ".repeat(10);
    expect(said.length).toBeGreaterThan(MAX_ARGUMENT_CHARS);
    const marker = path.join(dir, "started");
    const result = await run(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`, said], where);

    expect(result).toEqual({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "kiro-cli was not started: an argument was longer than 200 characters, and text for Kiro must go in on standard input",
    });
    expect(existsSync(marker)).toBe(false);
    // Arguments as long as the limit are still fine.
    expect(await run(["-e", "console.log(process.argv[1].length)", "x".repeat(MAX_ARGUMENT_CHARS)], where)).toMatchObject({ exitCode: 0, stdout: "200\n" });
  });

  it("keeps the arguments out of the error when Node refuses to start the program", async () => {
    // A NUL character makes Node throw before anything starts, and Node's message repeats the argument.
    const result = await run(["chat", `someone should build a page for bin day${String.fromCharCode(0)}`], where);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: "could not start kiro-cli (ERR_INVALID_ARG_VALUE)" });
    expect(JSON.stringify(result)).not.toContain("bin day");
  });
});

// The detector and the real runner together, with a shell script standing in for kiro-cli. This
// is the one place where a whole detect() is shown to start a process without the prompt in its
// arguments.
describe("a detection through the real runner", () => {
  const STAND_IN = [
    "#!/bin/sh",
    "# A stand-in for kiro-cli, for tests. It is not Kiro and sends nothing anywhere.",
    'case "$1" in',
    '  settings) echo "false (global)" ;;',
    '  whoami) echo "Logged in with a test stand-in" ;;',
    "  *)",
    // A chat: keep what it was started with, what ps shows for it, and what came in on standard input.
    '    printf \'%s\\n\' "$@" > "$KIRO_HOME/chat-args.txt"',
    '    ps -ww -o command= -p "$$" > "$KIRO_HOME/chat-ps.txt"',
    '    cat > "$KIRO_HOME/chat-stdin.txt"',
    '    cat "$KIRO_HOME/reply.json" ;;',
    "esac",
    "",
  ].join("\n");

  it("sends the prompt on standard input, and ps sees only the six fixed arguments", async () => {
    const dataDir = mkdtempSync(path.join(dir, "detect-"));
    const standIn = path.join(dataDir, "stand-in-kiro.sh");
    writeFileSync(standIn, STAND_IN);
    chmodSync(standIn, 0o755);
    const paths = dataPaths(dataDir);
    const input: DetectorInput = {
      utterances: [
        { text: "We always forget whose turn it is to pick the board game.", spokenAt: "2026-03-01T19:00:02.000Z" },
        { text: "Someone should build a little page that just picks the next person.", spokenAt: "2026-03-01T19:00:09.000Z" },
      ],
      recentTitles: ["Plant watering tracker"],
    };
    const verdict = {
      reason: "People in a room; one of them sincerely asks for a small tool.",
      likely_media: false,
      is_idea: true,
      confidence: 0.9,
      title: "Game night picker",
      pitch: "Picks whose turn it is to choose the board game.",
      quote: "Someone should build a little page that just picks the next person.",
      said_by_wearer_guess: true,
      buildable_as_static_web_app: true,
    };

    const detector = createKiroDetector({ paths, kiroBinary: standIn, timeoutMs: 8_000 });
    await detector.ensureSetup();
    writeFileSync(path.join(paths.detectorKiroHome, "reply.json"), JSON.stringify(verdict));
    const result = await detector.detect(input);

    expect(result).toMatchObject({ ok: true, attempts: 1, verdict: { title: "Game night picker", is_idea: true } });
    const saved = (name: string): string => readFileSync(path.join(paths.detectorKiroHome, name), "utf8");
    expect(saved("chat-args.txt").trim().split("\n")).toEqual(["chat", "--no-interactive", "--agent", "overnight-detector", "--model", "claude-haiku-4.5"]);
    expect(saved("chat-stdin.txt")).toBe(buildPrompt(input));
    // What any other program could have read while the chat ran.
    const seenByPs = saved("chat-ps.txt");
    expect(seenByPs).toContain("--no-interactive --agent overnight-detector");
    for (const words of ["board game", "picks the next person", "Plant watering", "TRANSCRIPT", "19:00"]) expect(seenByPs).not.toContain(words);
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
