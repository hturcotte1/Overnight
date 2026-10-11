// The last resort for the night's commands (build, deliver, build-now, rehearse): an error that
// nobody caught.
//
// An exception thrown outside every `try`, or a promise that fails with nobody waiting on it,
// ends a Node process on the spot. Nothing reaches the command's own log, so under launchd the
// job simply dies: the log stops in the middle of a night, and the only trace is a stack trace
// in the *.launchd.log file, message and all.
//
// So each of those commands watches for both while it works. When one arrives:
//   - One error line goes to the command's own log: which of the two it was, the error's class
//     name, its code if it has one, and the file and line it was thrown at. NEVER its message: a
//     message can carry anything (a title, a path a model chose, a piece of a reply), and a log
//     line must not.
//   - The work is told to stop (the same AbortSignal a stop signal fires). Whatever reacts to
//     that on the spot, such as killing a process group, still happens.
//   - The lock is released.
//   - The process ends with exit code 1. process.exit still runs the "exit" hooks that kill the
//     child process groups.
//
// Nothing here waits for anything: after an error nobody caught, the program's state cannot be
// trusted, so it does only what can be done at once and ends (Node's own advice for this event).
// A build that was under way is left "building"; the next run finds it cut off, and it gets its
// second try on a later night (core's build-retry.ts).
import type { Logger } from "@overnight/core";

export const FAULT_KINDS = ["uncaughtException", "unhandledRejection"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const LAST_RESORT_EXIT_CODE = 1;
/** The one log line, after the command's own name. */
export const LAST_RESORT_LINE = "ended on an error nobody caught; letting go of its lock and exiting";

/** Where these events come from. `process` fits; tests pass an EventEmitter. */
export interface FaultSource {
  on(name: FaultKind, listener: (reason: unknown) => void): unknown;
  removeListener(name: FaultKind, listener: (reason: unknown) => void): unknown;
}

export interface LastResortOptions {
  /** The command's name for the log line and the line on standard error: "overnight build". */
  command: string;
  /** The log to write the one line to. A function, for a command whose log changes with its step. */
  logger: Logger | (() => Logger);
  /**
   * What to let go of before ending, in order: tell the work to stop, stop a helper program,
   * release the lock. Each one is tried, and one that throws does not stop the next.
   */
  letGo: ReadonlyArray<() => void>;
  /** For the one line on standard error (under launchd: the job's *.launchd.log). */
  writeError?: (line: string) => void;
  source?: FaultSource;
  /** Ends the process. Default: process.exit. */
  exitNow?: (code: number) => void;
}

export interface LastResortWatch {
  /** Take the handlers off again. Safe to call more than once. */
  close(): void;
}

/** How a command gets its watch. The command line passes the real one; tests pass their own. */
export type WatchLastResort = (options: LastResortOptions) => LastResortWatch;

const NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,59}$/;
const CODE_SHAPE = /^[A-Za-z0-9_]{1,40}$/;
/**
 * The place in a stack line: "(/full/path/file.ts:12:34)", "file:///full/path/file.ts:12:34" or
 * "node:internal/...:12:34", with or without a function name before it. Only the place is kept.
 */
const STACK_PLACE = /^\s+at .*?\(?((?:file:\/\/\/|node:|\/)[^\s()]*:\d+:\d+)\)?$/;
const MAX_PLACE_CHARS = 300;

/** The stack lines of an error, without the message they start with. Null when the two cannot be told apart. */
function stackLines(error: Error): string[] | null {
  if (typeof error.stack !== "string") return null;
  const message = typeof error.message === "string" ? error.message : "";
  if (message === "") return error.stack.split("\n");
  // The stack begins with the error's name and message, and a message may run over several
  // lines of its own, some of which could look like stack lines. Start after it.
  const messageAt = error.stack.indexOf(message);
  return messageAt === -1 ? null : error.stack.slice(messageAt + message.length).split("\n");
}

/**
 * What may be said about an uncaught error in a log: its class name, its code, and where it was
 * thrown. Everything else about it (its message, its other fields) is left out on purpose.
 */
export function describeFault(reason: unknown): { error: string; code?: string; where?: string } {
  if (!(reason instanceof Error)) return { error: `not an Error (${reason === null ? "null" : typeof reason})` };
  const described: { error: string; code?: string; where?: string } = { error: typeof reason.name === "string" && NAME_SHAPE.test(reason.name) ? reason.name : "Error" };
  const code = (reason as { code?: unknown }).code;
  if (typeof code === "string" && CODE_SHAPE.test(code)) described.code = code;
  for (const line of stackLines(reason) ?? []) {
    const place = STACK_PLACE.exec(line)?.[1];
    if (place !== undefined && place.length <= MAX_PLACE_CHARS) {
      described.where = place;
      break;
    }
  }
  return described;
}

export const watchLastResort: WatchLastResort = (options) => {
  const source: FaultSource = options.source ?? process;
  const exitNow = options.exitNow ?? ((code: number) => process.exit(code));
  let closed = false;
  let handling = false;

  const listeners = FAULT_KINDS.map((kind) => {
    const listener = (reason: unknown): void => {
      // A second error while the first is being dealt with changes nothing: the process is ending.
      if (handling) return;
      handling = true;
      try {
        const logger = typeof options.logger === "function" ? options.logger() : options.logger;
        logger.error(`${options.command}: ${LAST_RESORT_LINE}`, { kind, ...describeFault(reason) });
      } catch {
        // A log line that cannot be written must not get in the way of letting go and ending.
      }
      try {
        options.writeError?.(`"${options.command}" ended on an error nobody caught (${kind}). Its lock was released; the one line about it is in its log.`);
      } catch {
        // The same.
      }
      for (const step of options.letGo) {
        try {
          step();
        } catch {
          // Whatever this one held is dropped by the operating system when the process ends.
        }
      }
      exitNow(LAST_RESORT_EXIT_CODE);
    };
    source.on(kind, listener);
    return [kind, listener] as const;
  });

  return {
    close: () => {
      if (closed) return;
      closed = true;
      for (const [kind, listener] of listeners) source.removeListener(kind, listener);
    },
  };
};
