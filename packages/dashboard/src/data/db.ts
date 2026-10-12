// One look at the database, without changing it and without getting in the listener's way.
//
// The listener writes to this file for weeks on end, so the rules here are strict
// (measured in spikes/12-sqlite-read-only.ts):
//   - A connection of our own, opened read-only. Never the store class from core that the other
//     programs use: that one upgrades the database when it opens it.
//   - Open, read everything in ONE short transaction, close. Nothing is kept between looks.
//     A read that stays open is the one thing that hurts the listener: its write-ahead file can
//     then never be tidied and grows without limit.
//   - So: every statement is run with .get() or .all(), which read to the end. A list that is
//     read row by row and left half-read is an open read. Nothing but SQL happens inside the
//     transaction, and the connection is closed whatever happens.
//   - What was heard is never read. The only thing asked about a line is how long it is.
//   - A table that an older database does not have yet (the ledger of what builds cost) is asked
//     for by name first, and left alone when it is not there: this connection never upgrades.
//
// Every row is checked against its shape after the connection is closed. A row that does not fit
// is left out and counted, never shown and never a reason to fail.
//
// Filming is applied in this file, so what it hides never leaves it.
import { lstatSync } from "node:fs";
import Database from "better-sqlite3";
import { CLOCKED_JOBS, IDEA_STATES, isBuildAwaitingRetry, readCheckedAt, readLastNightRun, readNightRun } from "@overnight/core";
import type { BuildCreditsTotal, ClockedJob, IdeaEvent, IdeaState } from "@overnight/core";
import { z } from "zod";
import { REHEARSAL_CONVERSATION_KEY } from "../log-messages.ts";
import { IDEA_ID } from "../types.ts";
import type { DashIdea, DbProblem, FilmingPolicy, HeardGroup, HeardOutcome, NightRecords, Said, Snapshot } from "../types.ts";
import { sqliteWouldWait } from "./safe-read.ts";

/** How long a look waits for the database before it gives up and says "busy". */
const WAIT_MS = 250;
const MAX_HEARD_GROUPS = 6;

// ---------- every statement the dashboard runs (test/db.test.ts reads this block) ----------
// SQL-START
const SQL = {
  // The two flags, and what the night clock has stored. Its keys all start "night."; core names them and reads them.
  smallValues: "SELECT key, value FROM kv WHERE key IN ('paused', 'dashboard_demo') OR key GLOB 'night.*'",
  ideas: "SELECT * FROM ideas ORDER BY created_at DESC, id DESC LIMIT 200",
  events: `SELECT id, idea_id, at, from_state, to_state, note FROM idea_events
    WHERE idea_id IN (SELECT id FROM ideas ORDER BY created_at DESC, id DESC LIMIT 200) ORDER BY id`,
  linesSince: "SELECT COUNT(*) AS n FROM utterances WHERE spoken_at >= ?",
  newestLine: "SELECT received_at FROM utterances ORDER BY id DESC LIMIT 1",
  asksSince: "SELECT COUNT(*) AS n FROM idea_events WHERE to_state = 'asked' AND at >= ?",
  detectorSince: `SELECT outcome, COUNT(*) AS n FROM detector_runs
    WHERE id > (SELECT COALESCE(MAX(id), 0) - 5000 FROM detector_runs) AND ran_at >= ? GROUP BY outcome`,
  conversations: `SELECT conversation_key AS key, COUNT(*) AS lines, MIN(spoken_at) AS first_at, MAX(spoken_at) AS last_at,
      SUM(detector_run_id IS NULL) AS waiting, MAX(detector_run_id) AS last_run_id
    FROM utterances WHERE spoken_at >= ? GROUP BY conversation_key ORDER BY last_at DESC LIMIT ${MAX_HEARD_GROUPS}`,
  lineLengths: "SELECT length(text) AS chars FROM utterances WHERE conversation_key = ? AND spoken_at >= ? ORDER BY spoken_at DESC, id DESC LIMIT 8",
  detectorRun: "SELECT outcome, reason FROM detector_runs WHERE id = ?",
  // Counted over every idea there is, as the commands that refuse a rehearsal folder count them.
  rehearsalIdeas: "SELECT COUNT(*) AS n FROM ideas WHERE conversation_key = ?",
  ledgerThere: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'build_costs'",
  // The same sum the Store makes for the month's ceiling (core, store.ts, buildCreditsBetween).
  creditsBetween: `SELECT COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(CASE WHEN measured = 0 THEN credits ELSE 0 END), 0) AS estimated, COUNT(*) AS tries
    FROM build_costs WHERE at >= ? AND at < ?`,
} as const;
// SQL-END

/**
 * A read-only connection to `file`, which must already exist. `query_only` is a second fence:
 * even a statement that tried to write would be refused by SQLite itself.
 */
export function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: WAIT_MS });
  try {
    db.pragma("query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// ---------- the look itself: SQL and nothing else ----------

interface RawLook {
  version: unknown;
  flags: unknown[];
  ideas: unknown[];
  events: unknown[];
  lines: unknown;
  newest: unknown;
  asks: unknown;
  detector: unknown[];
  conversations: Array<{ row: unknown; lengths: unknown[]; run: unknown }>;
  rehearsals: unknown;
  /** Null when this database has no ledger yet: nothing has been counted. */
  credits: unknown;
}

/** When the look counts from: the page's day, and the calendar month the credit ceiling goes by. All UTC instants. */
interface LookTimes { dayStart: string; month: { start: string; end: string } }

function property(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>)[name] : undefined;
}

function look(db: Database.Database, when: LookTimes): RawLook {
  const { dayStart } = when;
  return db.transaction((): RawLook => {
    const version = db.pragma("user_version", { simple: true });
    // A file with nothing in it yet has no tables to ask.
    if (version === 0) return { version, flags: [], ideas: [], events: [], lines: null, newest: null, asks: null, detector: [], conversations: [], rehearsals: null, credits: null };
    const conversations = db.prepare(SQL.conversations).all(dayStart);
    // A database from before Milestone 3 has no ledger. Asking it for one would fail the whole look.
    const ledgerThere = property(db.prepare(SQL.ledgerThere).get(), "n") === 1;
    return {
      version,
      flags: db.prepare(SQL.smallValues).all(),
      ideas: db.prepare(SQL.ideas).all(),
      events: db.prepare(SQL.events).all(),
      lines: db.prepare(SQL.linesSince).get(dayStart),
      newest: db.prepare(SQL.newestLine).get(),
      asks: db.prepare(SQL.asksSince).get(dayStart),
      detector: db.prepare(SQL.detectorSince).all(dayStart),
      conversations: conversations.map((row) => {
        const key = property(row, "key");
        const lastRun = property(row, "last_run_id");
        return {
          row,
          lengths: typeof key === "string" ? db.prepare(SQL.lineLengths).all(key, dayStart) : [],
          run: typeof lastRun === "number" ? db.prepare(SQL.detectorRun).get(lastRun) : undefined,
        };
      }),
      rehearsals: db.prepare(SQL.rehearsalIdeas).get(REHEARSAL_CONVERSATION_KEY),
      credits: ledgerThere ? db.prepare(SQL.creditsBetween).get(when.month.start, when.month.end) : null,
    };
  })();
}

// ---------- the shapes of the rows ----------

/** A column that may hold nothing, or may not exist yet in an older database: both become null. */
const orNull = <T extends z.ZodType>(type: T) => type.nullish().transform((value): z.output<T> | null => value ?? null);

const ideaState = z.enum(IDEA_STATES);
const count = z.number().int().nonnegative();

const ideaRow = z.object({
  id: z.string().regex(IDEA_ID),
  state: ideaState,
  title: z.string(),
  pitch: z.string(),
  quote: z.string(),
  confidence: z.number(),
  conversation_key: z.string(),
  detector_run_id: orNull(z.number()),
  created_at: z.string(),
  updated_at: z.string(),
  asked_at: orNull(z.string()),
  ask_expires_at: orNull(z.string()),
  answered_at: orNull(z.string()),
  note: orNull(z.string()),
  // From here on: columns that Milestone 2 added.
  slug: orNull(z.string()),
  build_backend: orNull(z.string()),
  build_started_at: orNull(z.string()),
  built_at: orNull(z.string()),
  published_url: orNull(z.string()),
  published_at: orNull(z.string()),
  delivered_at: orNull(z.string()),
  morning_todo_id: orNull(z.number()),
  fact_id: orNull(z.number()),
  failure_reason: orNull(z.string()),
  failure_notified_at: orNull(z.string()),
});
type IdeaRow = z.output<typeof ideaRow>;

const eventRow = z.object({
  id: z.number().int(),
  idea_id: z.string(),
  at: z.string(),
  from_state: orNull(ideaState),
  to_state: ideaState,
  note: orNull(z.string()),
});

const flagRow = z.object({ key: z.string(), value: z.string() });
const countRow = z.object({ n: count });
const newestRow = z.object({ received_at: z.string() });
const detectorCountRow = z.object({ outcome: z.enum(["idea", "not_idea", "skipped", "failed"]), n: count });
const conversationRow = z.object({ key: z.string(), lines: count, first_at: z.string(), last_at: z.string(), waiting: count, last_run_id: orNull(z.number().int()) });
const lengthRow = z.object({ chars: count });
const runRow = z.object({ outcome: z.enum(["idea", "not_idea", "skipped", "failed"]), reason: orNull(z.string()) });
const amount = z.number().nonnegative();
const creditsRow = z.object({ credits: amount, estimated: amount, tries: count });

/** Reads rows against a shape and keeps count of the ones that did not fit. */
class RowReader {
  unreadable = 0;

  one<T extends z.ZodType>(shape: T, row: unknown): z.output<T> | null {
    const parsed = shape.safeParse(row);
    if (parsed.success) return parsed.data;
    this.unreadable += 1;
    return null;
  }

  all<T extends z.ZodType>(shape: T, rows: readonly unknown[]): Array<z.output<T>> {
    const kept: Array<z.output<T>> = [];
    for (const row of rows) {
      const read = this.one(shape, row);
      if (read !== null) kept.push(read);
    }
    return kept;
  }
}

// ---------- from rows to what the pages see ----------

/** While filming, an idea in one of these states (nobody has approved it) is shown without its title and pitch. */
const NOT_APPROVED: ReadonlySet<IdeaState> = new Set<IdeaState>(["heard", "asked", "rejected", "expired"]);
export const HIDDEN_TITLE = "An idea (hidden while filming)";

function toDashIdea(row: IdeaRow, events: readonly IdeaEvent[], filming: FilmingPolicy): DashIdea {
  // Filming hides what was said. `--show-quote` lets one agreed idea through, whole.
  const letThrough = !filming.on || filming.showQuoteFor.has(row.id);
  const hidden = !letThrough && NOT_APPROVED.has(row.state);
  const quote: Said = row.quote === "" ? { shown: false, why: "none" } : letThrough ? { shown: true, text: row.quote } : { shown: false, why: "filming" };
  const buildStarts = events.filter((event) => event.toState === "building").length;
  return {
    id: row.id,
    state: row.state,
    title: hidden ? HIDDEN_TITLE : row.title,
    pitch: hidden ? "" : row.pitch,
    quote,
    hidden,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    askedAt: row.asked_at,
    askExpiresAt: row.ask_expires_at,
    answeredAt: row.answered_at,
    note: row.note,
    // The folder name of the published app is made from the title.
    slug: hidden ? null : row.slug,
    buildBackend: row.build_backend,
    buildStartedAt: row.build_started_at,
    builtAt: row.built_at,
    publishedUrl: row.published_url,
    publishedAt: row.published_at,
    deliveredAt: row.delivered_at,
    failureReason: row.failure_reason,
    failureNotifiedAt: row.failure_notified_at,
    rehearsal: row.conversation_key === REHEARSAL_CONVERSATION_KEY,
    buildStarts,
    awaitingRetry: isBuildAwaitingRetry({ state: row.state, failureReason: row.failure_reason, failureNotifiedAt: row.failure_notified_at }, buildStarts),
    hasMorningTodo: row.morning_todo_id !== null,
    hasFact: row.fact_id !== null,
  };
}

/** One bar per line, 1 to 7 long: a short line is a short bar. Lengths only; the words are never read. */
function barFor(chars: number): number {
  return Math.min(7, Math.max(1, Math.ceil(chars / 15)));
}

/** The two reasons the listener gives for not sending a conversation to the detector (listener, detection.ts). */
const SKIP_REASONS: Readonly<Record<string, HeardOutcome>> = { "too short": "too_short", "too old": "too_old" };

/** What became of a conversation. The detector's own reason is used only to tell the two skips apart; it is never passed on. */
function heardOutcome(waiting: number, run: z.output<typeof runRow> | null): HeardOutcome {
  if (waiting > 0) return "listening";
  if (run === null) return "skipped";
  if (run.outcome !== "skipped") return run.outcome;
  return (run.reason !== null && Object.hasOwn(SKIP_REASONS, run.reason) ? SKIP_REASONS[run.reason] : undefined) ?? "skipped";
}

/** What the database part of one look gives. The month's credits come as the ledger's bare sum (null: it could not be read); the look's caller holds them against the limit. */
export type DatabaseData = Pick<Snapshot, "demoMark" | "paused" | "linesHeard" | "lastHeardAt" | "asks" | "detector" | "heard" | "ideas" | "events" | "rehearsalIdeas" | "nightClock" | "unreadableRows"> & {
  creditsThisMonth: BuildCreditsTotal | null;
};

/** A sum of credits to three decimals, as the Store gives it: adding fractions leaves stray digits otherwise. */
function toThreeDecimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The night clock's stored values for one job, read by core's own readers from the rows of this
 * look. A record that does not fit core's shape comes back as null, as it does for every other
 * program: it is never shown and never a reason to fail.
 */
function nightRecords(values: ReadonlyMap<string, string>, job: ClockedJob): NightRecords {
  const stored = { getValue: (key: string): string | null => values.get(key) ?? null };
  return { record: readNightRun(stored, job), last: readLastNightRun(stored, job), checkedAt: readCheckedAt(stored, job) };
}

function shape(raw: RawLook, q: { filming: FilmingPolicy; pausedByDefault: boolean }): DatabaseData {
  const rows = new RowReader();

  const flags = new Map(rows.all(flagRow, raw.flags).map((flag) => [flag.key, flag.value]));
  const pausedFlag = flags.get("paused");

  const ideaRows = rows.all(ideaRow, raw.ideas);
  const events = new Map<string, IdeaEvent[]>(ideaRows.map((row) => [row.id, []]));
  for (const event of rows.all(eventRow, raw.events)) {
    // An event of an idea that was left out goes with it.
    events.get(event.idea_id)?.push({ id: event.id, ideaId: event.idea_id, at: event.at, fromState: event.from_state, toState: event.to_state, note: event.note });
  }
  const ideas = ideaRows.map((row) => toDashIdea(row, events.get(row.id) ?? [], q.filming));

  const detector = { idea: 0, not_idea: 0, skipped: 0, failed: 0 };
  for (const row of rows.all(detectorCountRow, raw.detector)) detector[row.outcome] = row.n;

  const ideaByRun = new Map<number, string>();
  for (const row of ideaRows) if (row.detector_run_id !== null) ideaByRun.set(row.detector_run_id, row.id);

  const heard: HeardGroup[] = [];
  for (const conversation of raw.conversations) {
    const row = rows.one(conversationRow, conversation.row);
    if (row === null) continue;
    const run = conversation.run === undefined ? null : rows.one(runRow, conversation.run);
    const outcome = heardOutcome(row.waiting, run);
    heard.push({
      id: row.key,
      firstAt: row.first_at,
      lastAt: row.last_at,
      lines: row.lines,
      // Read newest first; shown in the order they were said.
      bars: rows.all(lengthRow, conversation.lengths).map((line) => barFor(line.chars)).reverse(),
      outcome,
      ideaId: outcome === "idea" && row.last_run_id !== null ? (ideaByRun.get(row.last_run_id) ?? null) : null,
    });
  }

  // No ledger yet: nothing has been counted, which is what the Store will say once it has made one.
  const credits = raw.credits === null ? { credits: 0, estimated: 0, tries: 0 } : rows.one(creditsRow, raw.credits);

  return {
    demoMark: flags.get("dashboard_demo") === "true",
    // No row yet: nobody has run `overnight pause` or `resume`, so the setting decides (the same rule as core's).
    paused: pausedFlag === undefined ? q.pausedByDefault : pausedFlag === "true",
    linesHeard: raw.lines === null ? 0 : (rows.one(countRow, raw.lines)?.n ?? 0),
    lastHeardAt: raw.newest === undefined || raw.newest === null ? null : (rows.one(newestRow, raw.newest)?.received_at ?? null),
    asks: raw.asks === null ? 0 : (rows.one(countRow, raw.asks)?.n ?? 0),
    detector,
    heard,
    ideas,
    events,
    rehearsalIdeas: raw.rehearsals === null ? 0 : (rows.one(countRow, raw.rehearsals)?.n ?? 0),
    creditsThisMonth: credits === null ? null : { credits: toThreeDecimals(credits.credits), estimated: toThreeDecimals(credits.estimated), tries: credits.tries },
    nightClock: Object.fromEntries(CLOCKED_JOBS.map((job) => [job, nightRecords(flags, job)])) as Record<ClockedJob, NightRecords>,
    unreadableRows: rows.unreadable,
  };
}

// ---------- when the look fails ----------

function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

/** True only when we can see for ourselves that there is no such file. */
function isMissing(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

function problemOf(error: unknown, file: string): DbProblem {
  const code = codeOf(error);
  if (code.startsWith("SQLITE_BUSY")) return "busy";
  // SQLite says "cannot open" for a file that is not there; for a folder that is not there,
  // better-sqlite3 throws a plain TypeError with no code. Either way: is the file there?
  if (isMissing(file)) return "missing";
  // A database that is not Overnight's yet: it was made, and nothing has set it up.
  if (error instanceof Error && error.message.includes("no such table")) return "empty";
  return "unreadable";
}

/**
 * Everything the pages need from the database, read in one look. Never throws and never waits
 * longer than the 250 ms a busy database is given: a database that is missing, empty, busy or
 * unreadable comes back as that, by name. Anything that is not a plain file is "unreadable"
 * without being opened.
 * `options.open` is for tests: it stands in for opening the connection.
 */
export function readDatabase(
  file: string,
  q: LookTimes & { filming: FilmingPolicy; pausedByDefault: boolean },
  options?: { open?: (file: string) => Database.Database },
): { ok: true; data: DatabaseData } | { ok: false; problem: DbProblem } {
  // Looked at before anything is opened: a named pipe under the database's name (or beside it) would make SQLite wait for ever.
  if (sqliteWouldWait(file)) return { ok: false, problem: "unreadable" };
  let raw: RawLook;
  try {
    const db = (options?.open ?? openReadOnly)(file);
    try {
      raw = look(db, q);
    } finally {
      // Whatever happened: no connection, and so no read, outlives the look.
      db.close();
    }
  } catch (error) {
    return { ok: false, problem: problemOf(error, file) };
  }
  if (raw.version === 0) return { ok: false, problem: "empty" };
  try {
    return { ok: true, data: shape(raw, q) };
  } catch {
    return { ok: false, problem: "unreadable" };
  }
}
