// Reading the end of build.log and deliver.log.
//
// Each line is one JSON object: {at, level, name, message, ...fields} (packages/core/src/logger.ts).
// Only a short list of field names is kept (LOG_FIELDS). Everything else is dropped as the line
// is read: a start line carries the data folder's path, which holds the account's name, and a
// failure line carries a free-form reason. Nothing free-form from a log ever reaches a page.
//
// A line that is not JSON, is not that shape or is far too long is skipped. A log is written by
// other programs while we read it, so a half-written last line is normal.
import { z } from "zod";
import { LOG_FIELDS } from "../log-messages.ts";
import { readTail } from "./safe-read.ts";

export interface LogLine {
  at: string;
  level: string;
  name: string;
  message: string;
  fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** A longer line than this is not one of ours. (Counted in characters, which is never more than the bytes.) */
const MAX_LINE_CHARS = 64 * 1024;
/** No field the dashboard reads is anywhere near this long: an id, a builder's name, a step's name. */
const MAX_FIELD_CHARS = 200;
const DEFAULT_TAIL_BYTES = 1024 * 1024;

const envelope = z.object({
  at: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value))),
  level: z.string().max(20),
  name: z.string().max(40),
  message: z.string(),
});

const KEPT_FIELDS: ReadonlySet<string> = new Set(LOG_FIELDS);

/** A value simple enough to keep: a short text, a number, yes or no, or nothing. */
function simpleValue(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= MAX_FIELD_CHARS;
}

function parseLine(line: string): LogLine | null {
  if (line.length > MAX_LINE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const head = envelope.safeParse(parsed);
  if (!head.success) return null;
  const all = parsed as Record<string, unknown>;
  const fields: Record<string, string | number | boolean | null> = {};
  for (const name of Object.keys(all)) {
    const value = all[name];
    // A field of the wrong kind (a list, an object, a very long text) is dropped; the line stays.
    if (KEPT_FIELDS.has(name) && simpleValue(value)) fields[name] = value;
  }
  return { ...head.data, fields: Object.freeze(fields) };
}

/** The lines of a log, in the order they were written. Lines that cannot be read are left out. */
export function parseLogText(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const parsed = parseLine(line);
    if (parsed !== null) lines.push(parsed);
  }
  return lines;
}

/** The last `maxBytes` (1 MiB unless told otherwise) of a log file, as lines. A missing log is no lines. */
export function readLogTail(file: string, maxBytes: number = DEFAULT_TAIL_BYTES): LogLine[] {
  const text = readTail(file, maxBytes);
  return text === null ? [] : parseLogText(text);
}
