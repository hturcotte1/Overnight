// Run a small outside program for its answer only: did it start, how did it end.
// Used by `overnight preflight` for checks like "is gh logged in?". What these programs print
// often names the account (an email address, a user name), so by default nothing they print is
// read at all. When a check does need the text, it is handed back to that check alone, capped,
// and never logged or printed from here.
import { spawn } from "node:child_process";

export interface QuietResult {
  /** False when the program could not be started at all (not installed, not on the PATH given). */
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** What it printed, only when `keepOutput` was asked for. Otherwise "". */
  output: string;
}

export interface QuietOptions {
  /** The program's whole environment. Nothing of ours is inherited. */
  env: Record<string, string>;
  timeoutMs: number;
  cwd?: string;
  /** Keep what the program prints (both streams, at most 64 KiB) for the caller to look at. */
  keepOutput?: boolean;
}

const MAX_OUTPUT_CHARS = 64 * 1024;
/** How long to wait for the output to close after a kill before answering anyway. */
const KILL_GRACE_MS = 2_000;

/** Run one program to the end, or until `timeoutMs` passes. Never rejects. */
export function runQuiet(command: string, args: string[], options: QuietOptions): Promise<QuietResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<QuietResult, "output" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut, output });
    };
    let child;
    try {
      child = spawn(command, args, {
        env: options.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdio: ["ignore", options.keepOutput ? "pipe" : "ignore", options.keepOutput ? "pipe" : "ignore"],
      });
    } catch {
      resolve({ started: false, exitCode: null, timedOut: false, output: "" });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // If something it started still holds its output open, do not wait for that either.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ started: true, exitCode: null });
      }, KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        if (output.length < MAX_OUTPUT_CHARS) output += chunk.slice(0, MAX_OUTPUT_CHARS - output.length);
      });
    }
    child.once("error", () => finish({ started: false, exitCode: null }));
    child.once("close", (code) => finish({ started: true, exitCode: code }));
  });
}
