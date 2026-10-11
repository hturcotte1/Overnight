// The real command runner: start one program, wait for it with a time limit, and make sure
// nothing it started is left behind. Output is kept in memory only (the newest part, if there is
// a lot) and is never logged from here.
//
// Nothing in here may throw or leave an "error" event without a listener: a program we start (and
// some of them run code an AI agent wrote) must never be able to take our own process down.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { RUN_TAG_NAME, watchProcessTree } from "./process-watch.ts";
import type { Leftovers, ProcessWatch } from "./process-watch.ts";
import type { CommandRunner } from "./types.ts";

/** How much of each output stream is kept: the newest bytes. Enough for npm's error codes and our test's result line. */
const KEEP_BYTES = 1024 * 1024;
/** After the program itself has exited, how long to wait for its output pipes to close. */
const DRAIN_MS = 2_000;
/** The same wait when we are being stopped: shorter, because the caller has seconds, not minutes. */
const STOP_DRAIN_MS = 300;
/** After a kill, how long to wait for the program to be reported as ended before giving up on it. */
const KILL_WAIT_MS = 3_000;

/** Programs that are running right now (by process group), so they can be stopped if we are. */
const running = new Map<number, ProcessWatch | null>();
let exitHookInstalled = false;

function killGroup(pid: number): void {
  try {
    // A negative pid means "the whole process group".
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Kill every program started through runCommand that is still going, and what it is known to have started. For shutdown handlers. */
export function killRunningCommands(): void {
  for (const [pid, watch] of running) {
    killGroup(pid);
    try {
      watch?.killKnown();
    } catch {
      // Best effort: we are on the way out.
    }
  }
  running.clear();
}

/** Keeps the newest `limit` bytes of a stream. */
function tailCollector(limit: number) {
  let chunks: Buffer[] = [];
  let size = 0;
  return {
    add(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit * 2) {
        chunks = [Buffer.concat(chunks).subarray(size - limit)];
        size = limit;
      }
    },
    text(): string {
      const all = Buffer.concat(chunks);
      return (all.length > limit ? all.subarray(all.length - limit) : all).toString("utf8");
    },
  };
}

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const name = path.basename(command);
    const signal = options.signal;
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, stopped: true });
      return;
    }
    const stdout = tailCollector(KEEP_BYTES);
    const stderr = tailCollector(KEEP_BYTES);
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let exited = false;
    let closed = false;
    let swept = false;
    let exitCode: number | null = null;
    let leftovers: Leftovers | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killWaitTimer: NodeJS.Timeout | undefined;

    // A tracked program carries a random tag in its environment, so that what it starts can be recognised.
    const tag = options.track === undefined ? null : randomBytes(12).toString("hex");
    const baseEnv = options.env ?? process.env;
    const env = tag === null ? baseEnv : { ...baseEnv, [RUN_TAG_NAME]: tag };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // detached: the program leads its own process group, so the whole group can be killed at once.
      child = spawn(command, args, { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: `Could not start ${name}.` });
      return;
    }
    const pid = child.pid;
    let watch: ProcessWatch | null = null;
    if (pid !== undefined) {
      if (tag !== null && options.track !== undefined) watch = watchProcessTree(pid, tag, options.track);
      running.set(pid, watch);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", killRunningCommands);
      }
    }

    // The time limit. (It only ever fires later, once everything below is in place.)
    const limitTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      killNow();
    }, options.timeoutMs);

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(limitTimer);
      clearTimeout(drainTimer);
      clearTimeout(killWaitTimer);
      signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined) {
        // Also on success: a build script may have left something running in the background.
        killGroup(pid);
        running.delete(pid);
      }
      // If we are leaving without the usual sweep (the program could not be started or stopped),
      // the watch must still be ended: it kills what it knows of and stops reading the process table.
      if (watch !== null && !swept) void watch.finish();
      // Whatever still holds the other end of the pipes must not keep handles open in our process.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        timedOut,
        ...(error === undefined ? {} : { error }),
        ...(stopped ? { stopped: true as const } : {}),
        ...(leftovers === undefined ? {} : { leftovers }),
      });
    };

    /** Kill the program now and make sure we return even if it is never reported as ended. */
    const killNow = () => {
      if (pid !== undefined) killGroup(pid);
      else child.kill("SIGKILL");
      clearTimeout(killWaitTimer);
      killWaitTimer = setTimeout(() => {
        if (!exited) {
          watch?.killKnown();
          if (watch !== null) leftovers = { escaped: 0, expected: 0, unconfirmed: true };
          finish(`Could not stop ${name}.`);
        }
      }, KILL_WAIT_MS);
    };

    const onAbort = () => {
      if (settled || exited) return;
      stopped = true;
      clearTimeout(limitTimer);
      killNow();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    /** The program has ended: hunt down what it left, then give the pipes a moment to deliver the rest. */
    const afterExit = async () => {
      if (watch !== null) {
        try {
          leftovers = await watch.finish();
        } catch {
          leftovers = { escaped: 0, expected: 0, unconfirmed: true };
        }
      }
      swept = true;
      if (closed) {
        finish();
        return;
      }
      drainTimer = setTimeout(
        () => {
          // Everything we know of is dead and the pipes are still open: something we could not
          // find holds them. For a tracked program that means "not confirmed gone".
          if (leftovers !== undefined) leftovers = { ...leftovers, unconfirmed: true };
          finish();
        },
        stopped || signal?.aborted ? STOP_DRAIN_MS : DRAIN_MS,
      );
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    // A pipe that breaks is not our problem; without a listener it would be an uncaught exception.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (exited) return;
      watch?.killKnown();
      finish(`Could not start ${name}${error.code ? ` (${error.code})` : ""}.`);
    });
    child.once("exit", (code) => {
      exitCode = code;
      exited = true;
      // The program ended in time: the limit must not fire while we wait for its pipes to close.
      clearTimeout(limitTimer);
      clearTimeout(killWaitTimer);
      // Something it started may still hold the output pipes open. Kill the group first.
      if (pid !== undefined) killGroup(pid);
      void afterExit();
    });
    child.once("close", () => {
      closed = true;
      if (exited && swept) finish();
    });
  });
