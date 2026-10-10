// Synthetic test data. These tests run Bee's real library against a made-up stand-in program
// (fake-bee.ts), never the real `bee` and never the network. None of the text is Bee data.
//
// The other test files use a hand-written fake client. This one checks the things only the real
// library can show: how it reports a command that is killed for taking too long, what its stream
// does when we close it, and what happens when the program is missing altogether.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBeeClient } from "@beeai/cli/lib";
import { BeeError } from "@overnight/core";
import type { BeeEvent } from "@overnight/core";
import { createBeeGateway } from "../src/index.ts";
import { captureLogger } from "./fakes.ts";

const FAKE_BEE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-bee.ts");
const EXIT_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "exit-child.ts");

function gatewayFor(scenario: string, timeoutMs = 5000, env: Record<string, string> = {}) {
  const client = createBeeClient({ command: process.execPath, baseArgs: ["--no-warnings", FAKE_BEE, scenario], env });
  const log = captureLogger();
  return { bee: createBeeGateway({ client, logger: log.logger, timeoutMs }), log };
}

const isRunning = (pid: number): boolean => {
  try {
    // Signal 0 sends nothing. It only asks whether the process is there.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * A file in which stand-in programs note their process ids (see notePid in fake-bee.ts), so a
 * test can check they were really stopped and not merely no longer waited for.
 */
function pidFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "overnight-bee-test-"));
  const file = path.join(dir, "pids");
  const pids = (): number[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
  return {
    env: { FAKE_BEE_PID_FILE: file },
    pids,
    /** Waits up to two seconds for every noted process to be gone, and says whether they are. */
    allGone: async (): Promise<boolean> => {
      for (let waited = 0; waited < 2000; waited += 25) {
        if (!pids().some(isRunning)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return !pids().some(isRunning);
    },
    /** Stops whatever a failing test left running, and removes the file. */
    cleanUp: (): void => {
      for (const pid of pids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, as it should be.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ASK = "💡 Build tonight? Chore wheel";
const ALARM = new Date("2026-10-09T18:02:00.000Z");

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return error instanceof BeeError ? error.kind : `not a BeeError: ${String(error)}`;
  }
}

// Node stops the whole program on a promise rejection nobody handles. Count them, so a test
// fails if the gateway lets one through.
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

describe("commands through the real library", () => {
  it("reads replies, and tells logged-in from logged-out", async () => {
    const { bee, log } = gatewayFor("ok");
    expect(await bee.loginState()).toBe("logged-in");
    expect(await gatewayFor("logged-out").bee.loginState()).toBe("logged-out");
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|Quillfeather/);
  });

  it("creates a to-do with the text as one argument and each flag as its own word", async () => {
    expect(await gatewayFor("ok").bee.createTodo(ASK, ALARM)).toEqual({ id: 12 });
  });

  it("finds the to-do when the create's reply comes too late, and stops the late program", async () => {
    const noted = pidFile();
    try {
      // The stand-in's `todos create` answers after five seconds; its `todos list` holds the to-do.
      const { bee, log } = gatewayFor("create-slow", 1500, noted.env);
      expect(await bee.createTodo(ASK, ALARM)).toEqual({ id: 77 });
      expect(noted.pids()).toHaveLength(1);
      expect(await noted.allGone()).toBe(true);
      expect(log.messages()).toContain("Bee to-do found after a failed create");
      expect(log.lines.join("\n")).not.toMatch(/Chore wheel|Bee's own/);
    } finally {
      noted.cleanUp();
    }
  });

  it("does not go looking for a to-do when the bee program could not even be started", async () => {
    const log = captureLogger();
    const bee = createBeeGateway({ command: path.join(tmpdir(), "overnight-no-such-folder", "bee"), timeoutMs: 2000, logger: log.logger });
    expect(await kindOf(bee.createTodo(ASK, ALARM))).toBe("failed");
    const commands = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.message === "Bee command failed");
    expect(commands.map((line) => line.command)).toEqual(["todos create"]);
  });

  it("tells completed from deleted by the program's exit code and error text", async () => {
    const { bee } = gatewayFor("ok");
    expect(await bee.todoStatus(11)).toBe("completed");
    expect(await bee.todoStatus(404)).toBe("deleted");
    expect(await kindOf(gatewayFor("logged-out").bee.todoStatus(11))).toBe("logged-out");
  });

  it("reads changes and stored transcripts", async () => {
    const { bee } = gatewayFor("ok");
    expect(await bee.changedSince(null)).toEqual({ nextCursor: "first-cursor", conversationIds: [9001] });
    expect(await bee.changedSince("first-cursor")).toEqual({ nextCursor: "later-cursor", conversationIds: [9001] });
    expect(await bee.transcriptSince(9001, 0)).toEqual([{ beeUtteranceId: 30, text: "a made-up stored line", spokenAt: "2025-10-09T18:00:05.000Z" }]);
    expect(await bee.transcriptSince(404, 0)).toBeNull();
  });

  it("kills a command that takes too long and reports a timeout", async () => {
    const noted = pidFile();
    try {
      const { bee } = gatewayFor("hang", 1500, noted.env);
      const started = Date.now();
      expect(await Promise.all([kindOf(bee.todoStatus(11)), bee.loginState()])).toEqual(["timeout", "unknown"]);
      expect(Date.now() - started).toBeLessThan(4000);
      // Both stand-ins got going, and both were stopped. Giving up on them is not enough: a
      // program left running would pile up, one for every command that timed out.
      expect(noted.pids()).toHaveLength(2);
      expect(await noted.allGone()).toBe(true);
    } finally {
      noted.cleanUp();
    }
  });

  it("stops a command that is still running when the gateway is told to stop", async () => {
    const noted = pidFile();
    try {
      const { bee } = gatewayFor("hang", 30_000, noted.env);
      const pending = kindOf(bee.todoStatus(11));
      for (let waited = 0; waited < 3000 && noted.pids().length === 0; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(noted.pids()).toHaveLength(1);
      expect(noted.pids().every(isRunning)).toBe(true);
      bee.dispose();
      expect(await pending).toBe("timeout");
      expect(await noted.allGone()).toBe(true);
    } finally {
      noted.cleanUp();
    }
  });

  it("leaves no bee program behind when the process exits with a command and a stream still running", async () => {
    const noted = pidFile();
    try {
      // A process of its own (exit-child.ts) starts a command and a stream that never finish, and
      // then exits, as the listener does when its stop grace runs out.
      const child = spawn(process.execPath, ["--no-warnings", EXIT_CHILD, FAKE_BEE], { env: { ...process.env, ...noted.env }, stdio: "ignore" });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code).toBe(0);
      expect(noted.pids()).toHaveLength(2);
      expect(await noted.allGone()).toBe(true);
    } finally {
      noted.cleanUp();
    }
  }, 20_000);

  it("reports output that is not JSON without repeating it", async () => {
    const { bee } = gatewayFor("not-json");
    try {
      await bee.changedSince(null);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BeeError);
      expect((error as BeeError).kind).toBe("bad-response");
      expect((error as BeeError).message).not.toContain("Peregrine");
    }
  });

  it("keeps what the program printed out of the error when it fails without an error message", async () => {
    const { bee } = gatewayFor("stdout-only");
    for (const call of [() => bee.todoStatus(11), () => bee.changedSince(null), () => bee.transcriptSince(9001, 0), () => bee.createTodo(ASK, ALARM)]) {
      try {
        await call();
        throw new Error("expected a failure");
      } catch (error) {
        expect(error).toBeInstanceOf(BeeError);
        expect((error as BeeError).kind).toBe("bad-response");
        expect((error as BeeError).message).toMatch(/^bee [a-z ]+ failed with an unrecognised error$/);
      }
    }
  });

  it("keeps what the program printed out of the log when it fails without an error message", async () => {
    // With nothing on standard error, Bee's library takes standard output for the error message.
    const { bee, log } = gatewayFor("stdout-only");
    expect(await bee.loginState()).toBe("unknown");
    expect(await kindOf(bee.todoStatus(11))).toBe("bad-response");
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|Quillfeather|made-up line/);
  });

  it("reports an argument Node refuses to pass on, without repeating the argument", async () => {
    const { bee, log } = gatewayFor("ok");
    try {
      await bee.changedSince("made-up-cursor\u0000Peregrine");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BeeError);
      expect((error as BeeError).kind).toBe("failed");
      expect((error as BeeError).message).toBe("bee changed failed: the bee program could not be started (ERR_INVALID_ARG_VALUE).");
    }
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|made-up-cursor/);
  });

  it("reports a missing bee program as a failure, not as logged out", async () => {
    const bee = createBeeGateway({ command: path.join(tmpdir(), "overnight-no-such-folder", "bee"), timeoutMs: 2000 });
    expect(await bee.loginState()).toBe("unknown");
    expect(await kindOf(bee.todoStatus(11))).toBe("failed");
  });
});

describe("the stream through the real library", () => {
  const collect = () => {
    const events: BeeEvent[] = [];
    let wake: (() => void) | null = null;
    return {
      events,
      onEvent: (event: BeeEvent) => {
        events.push(event);
        wake?.();
      },
      /** Resolves once `count` events have arrived. */
      got: async (count: number) => {
        while (events.length < count) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    };
  };

  it('asks for all five types on one stream, and ends with "ended" when the program exits normally', async () => {
    const seen = collect();
    const stream = gatewayFor("stream-ends").bee.stream(seen.onEvent);
    expect(await stream.done).toEqual({ reason: "ended" });
    expect(seen.events).toEqual([
      { type: "connected" },
      { type: "utterance", beeUtteranceId: 1, conversationUuid: "0f0e0d0c-1111-4222-8333-444455556666", text: "a made-up line from the fake program", spokenAt: "2026-10-09T18:00:05.000Z" },
    ]);
  });

  it('ends with "closed", not an error, and stops the bee program, when we close it', async () => {
    const noted = pidFile();
    try {
      const seen = collect();
      const stream = gatewayFor("stream-waits", 5000, noted.env).bee.stream(seen.onEvent);
      await seen.got(2);
      expect(noted.pids()).toHaveLength(1);
      expect(noted.pids().every(isRunning)).toBe(true);
      stream.close();
      expect(await stream.done).toEqual({ reason: "closed" });
      expect(await noted.allGone()).toBe(true);
    } finally {
      noted.cleanUp();
    }
  });

  it("keeps a character whole when its bytes arrive in two pieces", async () => {
    // The stand-in cuts the second line inside the two bytes of its "é". Left to itself Bee's
    // library decodes each piece alone and delivers two "unknown character" marks instead.
    const seen = collect();
    const stream = gatewayFor("stream-split").bee.stream(seen.onEvent);
    expect(await stream.done).toEqual({ reason: "ended" });
    const texts = seen.events.flatMap((event) => (event.type === "utterance" ? [event.text] : []));
    expect(texts).toEqual(["a made-up line from the fake program", "a made-up café line, cut in two"]);
  });

  it('ends with "error" and the first line of the program\'s error when it dies', async () => {
    const seen = collect();
    const stream = gatewayFor("stream-fails").bee.stream(seen.onEvent);
    expect(await stream.done).toEqual({ reason: "error", message: "The made-up connection dropped." });
    expect(seen.events).toHaveLength(2);
  });

  it("ends with an error, and no unhandled rejection, when the bee program is missing", async () => {
    const bee = createBeeGateway({ command: path.join(tmpdir(), "overnight-no-such-folder", "bee") });
    const end = await bee.stream(() => {}).done;
    expect(end.reason).toBe("error");
    expect(end.message).toMatch(/ENOENT/);
  });
});
