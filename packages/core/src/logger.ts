// A small JSON-lines logger: one line per event, to the console and (optionally) to a file.
//
// Privacy rule: log lines never contain what was said, a person's name, a token or a raw Bee
// payload. Log ids, counts, states and durations instead. The `fields` type below only accepts
// simple values to make dumping an object by accident harder; it cannot check content.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Shown on every line, for example "listener". */
  name: string;
  /** If set, lines are also appended to this file (created with its folder if missing). */
  file?: string;
  /** Lines below this level are dropped. Default "info". */
  minLevel?: LogLevel;
  /**
   * Where console lines go. Default: process.stdout when a person is watching (a terminal), and
   * nowhere when there is a log file and no terminal, so a background job does not log twice.
   * Tests pass a collector.
   */
  write?: (line: string) => void;
  /** When the log file is larger than this at start-up it is renamed to "<file>.1". Default 10 MB. */
  maxFileBytes?: number;
  now?: () => Date;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const minLevel = ORDER[options.minLevel ?? "info"];
  const toConsole = (line: string) => void process.stdout.write(line + "\n");
  const write = options.write ?? (options.file && !process.stdout.isTTY ? () => {} : toConsole);
  const now = options.now ?? (() => new Date());
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  // The listener runs for weeks, so check the size as we go, not only at start-up.
  const checkEveryBytes = Math.min(1024 * 1024, Math.max(1, Math.floor(maxFileBytes / 2)));
  let bytesSinceCheck = 0;
  if (options.file) {
    mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    rotateIfLarge(options.file, maxFileBytes);
  }

  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (ORDER[level] < minLevel) return;
    const line = JSON.stringify({ at: now().toISOString(), level, name: options.name, message, ...base, ...fields });
    write(line);
    if (options.file) {
      try {
        appendFileSync(options.file, line + "\n", { mode: 0o600 });
        bytesSinceCheck += line.length + 1;
        if (bytesSinceCheck >= checkEveryBytes) {
          bytesSinceCheck = 0;
          rotateIfLarge(options.file, maxFileBytes);
        }
      } catch {
        // A full disk or a missing folder must not take the listener down.
      }
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/** Keep one old file: a log that has grown past the limit becomes "<file>.1" and a new one starts. */
function rotateIfLarge(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or it cannot be moved: carry on with the file as it is.
  }
}

/** A logger that drops everything. For tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** The first line of an error's message, trimmed. Safe to log: our own errors carry no transcript text. */
export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").slice(0, 200);
}
