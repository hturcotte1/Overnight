// Runs kiro-cli as a child process. This is the only file in the package that starts a process.
//
// Kiro has no timeout flag and can hang, so the timeout lives here and kills Kiro's whole process
// group. Kiro gets a stripped-down environment: nothing from our own environment reaches it.
//
// Privacy rule: the `error` text made here names an error code only. Node's own spawn messages
// can repeat the arguments, and the last argument is the prompt with the transcript in it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface KiroRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when kiro-cli could not be started at all, or was stopped along with this process. Never contains prompt text. */
  error?: string;
  /**
   * Set next to `error` when nothing was wrong with the request itself: kiro-cli is not installed
   * ("missing"), or this process is stopping ("stopping"). The same call is worth making again later.
   */
  unavailable?: "missing" | "stopping";
}

/** Run kiro-cli once with these arguments. Never rejects: every failure comes back in the result. */
export type KiroRunner = (args: string[], options: { cwd: string; kiroHome: string; timeoutMs: number }) => Promise<KiroRunResult>;

/** A real reply is under a kilobyte. This only stops a runaway process from eating memory. */
const MAX_OUTPUT_CHARS = 1_000_000;
/** How long to wait for the pipes to close after a kill before answering anyway. */
const KILL_GRACE_MS = 2_000;

export function kiroBinaryCandidates(): string[] {
  return [path.join(homedir(), ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli"];
}

/** Full path of kiro-cli, or null. Never looked up on PATH: background jobs do not have one. */
export function findKiroBinary(): string | null {
  return kiroBinaryCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/** Remove colour and cursor codes, and make every line ending a plain newline. */
export function stripAnsi(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- escape sequences start with a control character
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
      // eslint-disable-next-line no-control-regex -- as above
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n")
  );
}

// Kiro runs in its own process group so that a timeout can kill everything it started. The price
// is that Ctrl-C, or launchd stopping us, no longer reaches it. So we pass those on ourselves.
const STOP_SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
const liveGroups = new Set<number>();
let cleanupInstalled = false;
/**
 * True from the first stop signal (or the start of exit) onwards. No new Kiro is started after
 * that, and a run that was cut short says so instead of looking like a failure worth a retry.
 * Nothing sets it back: in this program a handled stop signal always means "shut down".
 */
let stopping = false;
/** Stop signals that had a handler taken off the list during the emit that is running right now. */
const handledThisEmit = new Set<string>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function killLiveGroups(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => {
    stopping = true;
    killLiveGroups();
  });
  // Listening for a signal switches off Node's "stop on this signal". If the program has a
  // handler of its own, stopping is its job and we must not exit under it. If we are the only
  // listener, we stop the process as Node would have.
  //
  // Telling the two apart has a catch: a handler added with process.once is taken off the list
  // just before it runs. Ours is put at the front (prependListener), so normally it runs first
  // and still counts the others. In case another handler was put in front of ours later, Node's
  // "removeListener" event tells us about any handler taken off while the signal is being
  // delivered; a signal that had one is being handled by the program.
  process.on("removeListener", (event) => {
    if (typeof event !== "string" || !STOP_SIGNALS.some(([signal]) => signal === event)) return;
    handledThisEmit.add(event);
    // Runs as soon as the delivery in progress (if any) is over.
    process.nextTick(() => handledThisEmit.delete(event));
  });
  for (const [signal, exitCode] of STOP_SIGNALS) {
    process.prependListener(signal, () => {
      stopping = true;
      killLiveGroups();
      if (process.listenerCount(signal) === 1 && !handledThisEmit.has(signal)) process.exit(exitCode);
    });
  }
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

/** The real runner. `kiroBinary` overrides where kiro-cli is looked for. */
export function createKiroRunner(options: { kiroBinary?: string } = {}): KiroRunner {
  return (args, runOptions) =>
    new Promise<KiroRunResult>((resolve) => {
      const failed = (error: string, unavailable?: KiroRunResult["unavailable"]): void =>
        resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, error, ...(unavailable === undefined ? {} : { unavailable }) });
      if (stopping) return failed("kiro-cli was not started: this process is stopping", "stopping");
      const binary = options.kiroBinary ?? findKiroBinary();
      if (!binary) return failed(`kiro-cli was not found (looked in ${kiroBinaryCandidates().join(" and ")})`, "missing");
      // ENOENT can also mean the working folder is gone, so look before calling the program missing.
      const couldNotStart = (error: unknown): [string, KiroRunResult["unavailable"]] => {
        const code = errorCode(error);
        return [`could not start kiro-cli (${code})`, code === "ENOENT" && !existsSync(binary) ? "missing" : undefined];
      };

      // Only what kiro-cli needs. The Kiro sign-in is found through HOME.
      const env = {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
        NO_COLOR: "1",
        KIRO_HOME: runOptions.kiroHome,
      };

      installCleanup();
      let child;
      try {
        child = spawn(binary, args, { cwd: runOptions.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (error) {
        return failed(...couldNotStart(error));
      }
      const pid = child.pid;
      if (pid !== undefined) liveGroups.add(pid);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      // setEncoding decodes UTF-8 properly even when a character is split across two chunks.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
      });

      const finish = (exitCode: number | null, startError?: [string, KiroRunResult["unavailable"]]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (pid !== undefined) liveGroups.delete(pid);
        // A run that ends badly while we are stopping was killed by us, not by anything it was sent.
        // (One that had already finished cleanly keeps its answer.)
        const [error, unavailable] = startError ?? (stopping && exitCode !== 0 ? ["kiro-cli was stopped: this process is stopping", "stopping" as const] : []);
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode,
          timedOut,
          ...(error === undefined ? {} : { error }),
          ...(unavailable === undefined ? {} : { unavailable }),
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) killGroup(pid);
        child.kill("SIGKILL");
        // If something outside the group still holds the pipes open, do not wait for it.
        graceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, KILL_GRACE_MS);
      }, runOptions.timeoutMs);

      child.once("error", (error) => finish(null, couldNotStart(error)));
      child.once("close", (code) => finish(code));
    });
}
