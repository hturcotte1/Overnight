// A small JSON-lines logger: one line per event, to the console and (optionally) to a file.
//
// Privacy rule: log lines never contain what was said, a person's name, a token or a raw Bee
// payload. Log ids, counts, states and durations instead. The `fields` type below only accepts
// simple values to make dumping an object by accident harder; it cannot check content.
import { appendFileSync, mkdirSync } from "node:fs";
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
  /** Where console lines go. Default: process.stdout. Tests pass a collector. */
  write?: (line: string) => void;
  now?: () => Date;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const minLevel = ORDER[options.minLevel ?? "info"];
  const write = options.write ?? ((line: string) => void process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date());
  if (options.file) mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });

  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (ORDER[level] < minLevel) return;
    const line = JSON.stringify({ at: now().toISOString(), level, name: options.name, message, ...base, ...fields });
    write(line);
    if (options.file) {
      try {
        appendFileSync(options.file, line + "\n", { mode: 0o600 });
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
