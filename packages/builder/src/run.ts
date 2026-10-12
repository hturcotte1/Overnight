// Starts outside programs (kirocrew, sandbox-exec + kiro-cli). The only file in this package
// that starts a process, and the only one that listens for stop signals.
//
// The approach is copied from packages/detector/src/kiro.ts: neither tool has a timeout of its
// own that we trust, so the timeout lives here and kills the program's whole process group; and
// the program gets a small environment that we spell out, never our own.
//
// Privacy rule: the `error` text made here names an error code only. Node's own spawn messages
// can repeat the arguments, and an argument can be a whole prompt.
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the program could not be started at all, or was stopped along with this process. */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** When this is aborted the program is stopped: its whole process group is killed. */
  signal?: AbortSignal;
  /**
   * How long a program that is being stopped is left to finish by itself before it is killed.
   * Default 0. (A `kirocrew cron add` that is killed half-way can leave a job nobody knows about.)
   */
  stopGraceMs?: number;
  /**
   * Clean-up (`kirocrew cron remove`): the program may start although this process is stopping.
   * A stop that comes while it runs ends it only after `stopGraceMs`, and not at all when that
   * is not given. Its own time limit always applies.
   */
  cleanup?: boolean;
}

/** Run one program and wait for it. Never rejects: every failure comes back in the result. */
export type CommandRunner = (command: string, args: string[], options: RunOptions) => Promise<CommandResult>;

/**
 * The `error` of a program that was started and then ended by us because this process was told
 * to stop. Unlike the other errors made here, it means the program did run for a while.
 */
export const STOPPED_WHILE_RUNNING = "the program was stopped: this process is stopping";

/** A build prints far less than this. It only stops a runaway process from eating memory. */
const MAX_OUTPUT_CHARS = 1_000_000;
/** How long to wait for the pipes to close after a kill before answering anyway. */
const KILL_GRACE_MS = 2_000;

/** What a program gets when the caller names no environment: enough to run, nothing of ours. */
export function minimalEnv(extraPath: string[] = []): Record<string, string> {
  return {
    HOME: homedir(),
    PATH: [...extraPath, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
  };
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

// Each program runs in its own process group so that a timeout can kill everything it started
// (an agent starts npm, which starts a build tool, which starts a browser). The price is that
// Ctrl-C, or launchd stopping us, no longer reaches it. So we pass those on ourselves: a build
// agent must never be left running with nobody watching it.
const STOP_SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;

/** A program that is running now. */
interface Live {
  /** Stop it: kill its process group, after its grace time if it has one. */
  stop(): void;
  /** Kill its process group now. */
  kill(): void;
}
const livePrograms = new Set<Live>();
let cleanupInstalled = false;
/** True from the first stop signal (or the start of exit) onwards. Nothing new is started after that, except clean-up. */
let stopping = false;

/**
 * Has this process been told to stop? A stop signal ends the process at once only when nobody
 * else is listening for it (see installCleanup). While a build is running the night flow listens
 * (onStopSignal), so the process lives on for the few seconds it takes to end the build properly.
 */
export function isStopping(): boolean {
  return stopping;
}
/** Stop signals that had a handler taken off the list during the emit that is running right now. */
const handledThisEmit = new Set<string>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Tell every running program to stop. (Clean-up decides for itself how long it still gets: see stop().) */
function stopLivePrograms(): void {
  for (const program of livePrograms) program.stop();
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => {
    stopping = true;
    // The process is going: nothing may outlive it, not even clean-up.
    for (const program of livePrograms) program.kill();
    livePrograms.clear();
  });
  // Listening for a signal switches off Node's "stop on this signal". If the program has a
  // handler of its own, stopping is its job and we must not exit under it. If we are the only
  // listener, we stop the process as Node would have. A handler added with process.once is taken
  // off the list just before it runs, so the "removeListener" event is used to notice those.
  // (packages/detector installs the same kind of handler for its own Kiro runs. The two are never
  // used in one process: `overnight listen` runs the detector, `overnight build` runs this.)
  process.on("removeListener", (event) => {
    if (typeof event !== "string" || !STOP_SIGNALS.some(([signal]) => signal === event)) return;
    handledThisEmit.add(event);
    process.nextTick(() => handledThisEmit.delete(event));
  });
  for (const [signal, exitCode] of STOP_SIGNALS) {
    process.prependListener(signal, () => {
      stopping = true;
      stopLivePrograms();
      if (process.listenerCount(signal) === 1 && !handledThisEmit.has(signal)) process.exit(exitCode);
    });
  }
}

/**
 * Listen for a stop signal (Ctrl-C, launchd stopping the job, a closed terminal). `onStop` is
 * called once, on the first one. While somebody listens this way the process is NOT ended by
 * the signal: the listener is expected to wind things down and let the program finish.
 * Returns a function that stops listening.
 */
export function onStopSignal(onStop: () => void): () => void {
  let told = false;
  const handler = (): void => {
    stopping = true;
    stopLivePrograms();
    if (told) return;
    told = true;
    onStop();
  };
  for (const [signal] of STOP_SIGNALS) process.on(signal, handler);
  return () => {
    for (const [signal] of STOP_SIGNALS) process.removeListener(signal, handler);
  };
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

/** Keep the end of a long output: the last lines say how a run finished. */
function appendCapped(current: string, chunk: string): string {
  const joined = current + chunk;
  return joined.length > 2 * MAX_OUTPUT_CHARS ? joined.slice(-MAX_OUTPUT_CHARS) : joined;
}

/** The real runner. */
export function createCommandRunner(): CommandRunner {
  return (command, args, options) =>
    new Promise<CommandResult>((resolve) => {
      const failed = (error: string): void => resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, error });
      const cleanup = options.cleanup === true;
      if ((stopping || options.signal?.aborted === true) && !cleanup) return failed("the program was not started: this process is stopping");

      installCleanup();
      let child;
      try {
        child = spawn(command, args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.env ?? minimalEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        return failed(`could not start the program (${errorCode(error)})`);
      }
      const pid = child.pid;

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let stopRequested = false;
      let graceTimer: NodeJS.Timeout | undefined;
      let stopTimer: NodeJS.Timeout | undefined;
      // setEncoding decodes UTF-8 properly even when a character is split across two chunks.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk);
      });

      const finish = (exitCode: number | null, startError?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        clearTimeout(stopTimer);
        options.signal?.removeEventListener("abort", stop);
        livePrograms.delete(program);
        // A run that ends badly after it was told to stop was killed by us.
        const error = startError ?? (stopRequested && exitCode !== 0 ? STOPPED_WHILE_RUNNING : undefined);
        resolve({
          stdout: stripAnsi(stdout.slice(-MAX_OUTPUT_CHARS)),
          stderr: stripAnsi(stderr.slice(-MAX_OUTPUT_CHARS)),
          exitCode,
          timedOut,
          ...(error === undefined ? {} : { error }),
        });
      };

      /** Kill whatever is left in the group, and stop waiting for its output soon after. */
      const endGroup = (exitCode: number | null): void => {
        if (pid !== undefined) killGroup(pid);
        // If something outside the group still holds the pipes open, do not wait for it.
        graceTimer ??= setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode);
        }, KILL_GRACE_MS);
      };

      const kill = (): void => {
        if (settled) return;
        child.kill("SIGKILL");
        endGroup(null);
      };

      /** Told to stop: killed now, or after the grace time if it has one and has not finished by then. */
      function stop(): void {
        if (settled || stopRequested) return;
        // Clean-up with no grace time of its own is left to finish (or to run into its time limit).
        if (cleanup && options.stopGraceMs === undefined) return;
        stopRequested = true;
        const graceMs = options.stopGraceMs ?? 0;
        if (graceMs <= 0) kill();
        else stopTimer = setTimeout(kill, graceMs);
      }

      const program: Live = { stop, kill };
      livePrograms.add(program);
      options.signal?.addEventListener("abort", stop, { once: true });
      // The stop may have come while the program was being started. (Clean-up that is started
      // after a stop is the answer to that stop: it runs under its own time limit.)
      if ((stopping || options.signal?.aborted === true) && !cleanup) stop();

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);

      child.once("error", (error) => finish(null, `could not start the program (${errorCode(error)})`));
      // The program itself has ended. Anything it left running in its group (a preview server, a
      // browser) goes too: it would otherwise hold the output open and keep running unwatched.
      child.once("exit", (code) => {
        if (!timedOut) endGroup(code);
      });
      child.once("close", (code) => finish(timedOut ? null : code));
    });
}
