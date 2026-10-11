// Stop signals for the night's commands: build, deliver and build-now.
//
// macOS stops a background job with SIGTERM (uninstall, restart, logout). Ctrl-C is SIGINT, and a
// closed terminal window is SIGHUP. Left alone, Node ends the process on the spot. The lock is
// dropped, but nothing gets to tidy up: a Kiro Crew job keeps building with nobody watching, the
// idea stays "building", and whatever the deliver step had started (an install, a build script,
// a browser) is left running without a time limit.
//
// So each of the three commands watches for those signals while it works:
//   - First signal: the AbortSignal the builder or the deliver step was handed is aborted. They
//     stop what they started and come back (their promise: within 10 seconds). The command then
//     releases its lock and the process ends with the code a shell reports for that signal.
//   - Second signal: the process ends at once. process.exit still runs the "exit" hooks that kill
//     the child process groups.
//   - If the work has not come back STOP_WAIT_MS after the first signal, the command stops
//     waiting and ends anyway, well inside the 60 seconds macOS gives the job (ExitTimeOut).
//
// `overnight listen` does not use this: the listener has its own handling in @overnight/listener.

/** The exit code a shell reports for a process ended by each signal: 128 + the signal's number. */
export const STOP_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type StopSignalName = keyof typeof STOP_EXIT_CODES;
export const STOP_SIGNAL_NAMES = Object.keys(STOP_EXIT_CODES) as StopSignalName[];

/** The builder and the deliver step promise to come back within 10 seconds. This is how long we believe it. */
export const STOP_WAIT_MS = 20_000;

/** The one log line a command writes at the first stop signal, after its own name. */
export const STOP_SIGNAL_LINE = "stop signal received: stopping what is running, then ending";

/** What `settle` resolves with when a stop signal came and the work did not come back in time. */
export const STOP_OVERDUE = Symbol("the work did not stop in time");

/** Where signals come from. `process` fits; tests pass an EventEmitter. */
export interface SignalSource {
  on(name: StopSignalName, listener: () => void): unknown;
  removeListener(name: StopSignalName, listener: () => void): unknown;
}

export interface StopWatchOptions {
  /** Called once, at the first stop signal. For the command's one log line. */
  onStop?: (name: StopSignalName) => void;
  /** How long the work is given to come back after the first signal. Default STOP_WAIT_MS. */
  waitMs?: number;
  source?: SignalSource;
  /** Ends the process at once, on a second signal. Default: process.exit. */
  exitNow?: (code: number) => void;
}

export interface StopWatch {
  /** Aborted at the first stop signal (or by `abort`). Handed to the builder and the deliver step. */
  readonly signal: AbortSignal;
  /** The first stop signal that arrived, or null if none has. */
  received(): StopSignalName | null;
  /** The exit code that goes with it (130, 143 or 129), or null if no signal has arrived. */
  exitCode(): number | null;
  /**
   * `work`'s own result or error. Or STOP_OVERDUE, if a stop signal arrived and `work` had still
   * not settled `waitMs` later: nobody waits for it any more, and whatever it does afterwards is
   * ignored.
   */
  settle<T>(work: Promise<T> | T): Promise<T | typeof STOP_OVERDUE>;
  /** Abort without a signal: the command itself has given up on the work (its time limit passed). */
  abort(): void;
  /** Take the handlers off again. Safe to call more than once. */
  close(): void;
}

/** How a command gets its watch. The command line passes the real one; tests pass their own. */
export type WatchStopSignals = (options?: StopWatchOptions) => StopWatch;

export const watchStopSignals: WatchStopSignals = (options = {}) => {
  const source: SignalSource = options.source ?? process;
  const exitNow = options.exitNow ?? ((code: number) => process.exit(code));
  const waitMs = Math.max(0, options.waitMs ?? STOP_WAIT_MS);
  const controller = new AbortController();
  let first: StopSignalName | null = null;
  let closed = false;
  let overdueTimer: NodeJS.Timeout | undefined;
  let markOverdue: () => void = () => {};
  const overdue = new Promise<typeof STOP_OVERDUE>((resolve) => {
    markOverdue = () => resolve(STOP_OVERDUE);
  });

  const listeners = STOP_SIGNAL_NAMES.map((name) => {
    const listener = (): void => {
      if (first !== null) {
        // Asked twice: stop being careful.
        exitNow(STOP_EXIT_CODES[name]);
        return;
      }
      first = name;
      overdueTimer = setTimeout(markOverdue, waitMs);
      try {
        options.onStop?.(name);
      } catch {
        // A log line that cannot be written must not get in the way of stopping.
      }
      controller.abort();
    };
    source.on(name, listener);
    return [name, listener] as const;
  });

  return {
    signal: controller.signal,
    received: () => first,
    exitCode: () => (first === null ? null : STOP_EXIT_CODES[first]),
    settle: async <T>(work: Promise<T> | T): Promise<T | typeof STOP_OVERDUE> => {
      const running = Promise.resolve(work);
      // If "overdue" wins, nobody is waiting for the work any more. A late error from it must not
      // stop Node over an unhandled rejection.
      running.catch(() => {});
      return Promise.race([running, overdue]);
    },
    abort: () => controller.abort(),
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(overdueTimer);
      for (const [name, listener] of listeners) source.removeListener(name, listener);
    },
  };
};

/** "20 seconds", for the line that says the work did not stop in time. */
export function stopWaitText(waitMs: number = STOP_WAIT_MS): string {
  const seconds = Math.round(waitMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
