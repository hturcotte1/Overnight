// The SQLite store. One file (~/.overnight/overnight.db), private to the user.
// It holds what Bee heard, every detector run, and each idea with its timeline.
// All times are ISO 8601 strings in UTC. All idea state changes go through transitionIdea().
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { assertTransition } from "./state-machine.ts";
import type { DetectorVerdict, Idea, IdeaEvent, IdeaState, StoredConversation, StoredUtterance } from "./types.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    key TEXT PRIMARY KEY,
    uuid TEXT UNIQUE,
    bee_id INTEGER UNIQUE,
    state TEXT,
    start_time TEXT,
    end_time TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE detector_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    utterance_count INTEGER NOT NULL,
    word_count INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('idea', 'not_idea', 'skipped', 'failed')),
    verdict_json TEXT,
    reason TEXT,
    ms INTEGER,
    attempts INTEGER
  );
  CREATE TABLE utterances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bee_utterance_id INTEGER,
    conversation_key TEXT NOT NULL REFERENCES conversations(key),
    text TEXT NOT NULL,
    spoken_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('stream', 'backfill')),
    detector_run_id INTEGER REFERENCES detector_runs(id)
  );
  CREATE UNIQUE INDEX utterances_bee_id ON utterances(source, bee_utterance_id) WHERE bee_utterance_id IS NOT NULL;
  CREATE INDEX utterances_by_conversation ON utterances(conversation_key, spoken_at);
  CREATE INDEX utterances_pending ON utterances(conversation_key) WHERE detector_run_id IS NULL;
  CREATE TABLE ideas (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    pitch TEXT NOT NULL,
    quote TEXT NOT NULL,
    confidence REAL NOT NULL,
    conversation_key TEXT NOT NULL,
    detector_run_id INTEGER,
    todo_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    asked_at TEXT,
    ask_expires_at TEXT,
    answered_at TEXT,
    note TEXT
  );
  CREATE INDEX ideas_by_state ON ideas(state);
  CREATE UNIQUE INDEX ideas_by_todo ON ideas(todo_id) WHERE todo_id IS NOT NULL;
  CREATE TABLE idea_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id TEXT NOT NULL REFERENCES ideas(id),
    at TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX idea_events_by_idea ON idea_events(idea_id, id);
  CREATE INDEX idea_events_by_state ON idea_events(to_state, at);
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // utterancesSpokenNear() runs for every line heard, across all conversations.
  `CREATE INDEX utterances_by_spoken_at ON utterances(spoken_at);`,
];

export interface ConversationRef {
  uuid?: string | null;
  beeId?: number | null;
  state?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  deleted?: boolean;
}

export interface NewUtterance {
  beeUtteranceId: number | null;
  conversationKey: string;
  text: string;
  spokenAt: string;
  receivedAt: string;
  source: "stream" | "backfill";
}

export type DetectorOutcome = "idea" | "not_idea" | "skipped" | "failed";

export interface NewDetectorRun {
  conversationKey: string;
  ranAt: string;
  /** Our own utterance ids (StoredUtterance.id) that this run covered. */
  utteranceIds: number[];
  wordCount: number;
  outcome: DetectorOutcome;
  verdict?: DetectorVerdict;
  /** Why it was skipped or failed. Never transcript text. */
  reason?: string;
  ms?: number;
  attempts?: number;
}

export interface NewIdea {
  title: string;
  pitch: string;
  quote: string;
  confidence: number;
  conversationKey: string;
  detectorRunId: number | null;
  note?: string;
}

export interface IdeaPatch {
  note?: string | null;
  todoId?: number | null;
  askedAt?: string | null;
  askExpiresAt?: string | null;
  answeredAt?: string | null;
}

export interface AwaitingDetection {
  conversationKey: string;
  pendingCount: number;
  /** When the newest uncovered line reached us. The quiet timer counts from here. */
  lastReceivedAt: string;
}

type Row = Record<string, unknown>;

function toConversation(row: Row): StoredConversation {
  return {
    key: String(row.key),
    uuid: (row.uuid as string | null) ?? null,
    beeId: (row.bee_id as number | null) ?? null,
    state: (row.state as string | null) ?? null,
    startTime: (row.start_time as string | null) ?? null,
    endTime: (row.end_time as string | null) ?? null,
    deleted: row.deleted === 1,
  };
}

function toUtterance(row: Row): StoredUtterance {
  return {
    id: Number(row.id),
    beeUtteranceId: (row.bee_utterance_id as number | null) ?? null,
    conversationKey: String(row.conversation_key),
    text: String(row.text),
    spokenAt: String(row.spoken_at),
    receivedAt: String(row.received_at),
    source: row.source as "stream" | "backfill",
    detectorRunId: (row.detector_run_id as number | null) ?? null,
  };
}

function toIdea(row: Row): Idea {
  return {
    id: String(row.id),
    state: row.state as IdeaState,
    title: String(row.title),
    pitch: String(row.pitch),
    quote: String(row.quote),
    confidence: Number(row.confidence),
    conversationKey: String(row.conversation_key),
    detectorRunId: (row.detector_run_id as number | null) ?? null,
    todoId: (row.todo_id as number | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    askedAt: (row.asked_at as string | null) ?? null,
    askExpiresAt: (row.ask_expires_at as string | null) ?? null,
    answeredAt: (row.answered_at as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

function toIdeaEvent(row: Row): IdeaEvent {
  return {
    id: Number(row.id),
    ideaId: String(row.idea_id),
    at: String(row.at),
    fromState: (row.from_state as IdeaState | null) ?? null,
    toState: row.to_state as IdeaState,
    note: (row.note as string | null) ?? null,
  };
}

function randomKey(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export class Store {
  readonly #db: Database.Database;

  /** Open (and create or upgrade) the database. Pass ":memory:" in tests. */
  constructor(file: string) {
    const isNew = file !== ":memory:" && !existsSync(file);
    this.#db = new Database(file);
    if (isNew) chmodSync(file, 0o600);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    this.#migrate();
  }

  #migrate(): void {
    const current = Number(this.#db.pragma("user_version", { simple: true }));
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) continue;
      this.#db.transaction(() => {
        this.#db.exec(sql);
        this.#db.pragma(`user_version = ${version + 1}`);
      })();
    }
  }

  close(): void {
    this.#db.close();
  }

  // ---------- conversations ----------

  /**
   * Find or create the conversation that `ref` points at, and record anything new about it.
   * Live utterances name a conversation by uuid; commands and backfill use the numeric id. If we
   * learn that two rows are the same conversation, they are merged.
   */
  resolveConversation(ref: ConversationRef, now: string): StoredConversation {
    const uuid = ref.uuid ?? null;
    const beeId = ref.beeId ?? null;
    if (uuid === null && beeId === null) throw new Error("A conversation needs a uuid or a Bee id.");

    return this.#db.transaction((): StoredConversation => {
      const byUuid = uuid === null ? undefined : (this.#db.prepare("SELECT * FROM conversations WHERE uuid = ?").get(uuid) as Row | undefined);
      const byBeeId = beeId === null ? undefined : (this.#db.prepare("SELECT * FROM conversations WHERE bee_id = ?").get(beeId) as Row | undefined);

      let key: string;
      if (byUuid && byBeeId && byUuid.key !== byBeeId.key) {
        // Two rows for one conversation: keep the uuid row, fold the other into it.
        key = String(byUuid.key);
        const other = String(byBeeId.key);
        for (const table of ["utterances", "detector_runs", "ideas"]) {
          this.#db.prepare(`UPDATE ${table} SET conversation_key = ? WHERE conversation_key = ?`).run(key, other);
        }
        this.#db.prepare("DELETE FROM conversations WHERE key = ?").run(other);
      } else if (byUuid ?? byBeeId) {
        key = String((byUuid ?? byBeeId)?.key);
      } else {
        key = randomKey("c");
        this.#db.prepare("INSERT INTO conversations (key, created_at, updated_at) VALUES (?, ?, ?)").run(key, now, now);
      }

      this.#db
        .prepare(
          `UPDATE conversations SET
             uuid = COALESCE(?, uuid),
             bee_id = COALESCE(?, bee_id),
             state = COALESCE(?, state),
             start_time = COALESCE(?, start_time),
             end_time = COALESCE(?, end_time),
             deleted = CASE WHEN ? THEN 1 ELSE deleted END,
             updated_at = ?
           WHERE key = ?`,
        )
        .run(uuid, beeId, ref.state ?? null, ref.startTime ?? null, ref.endTime ?? null, ref.deleted ? 1 : 0, now, key);
      return toConversation(this.#db.prepare("SELECT * FROM conversations WHERE key = ?").get(key) as Row);
    })();
  }

  getConversation(key: string): StoredConversation | null {
    const row = this.#db.prepare("SELECT * FROM conversations WHERE key = ?").get(key) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  findConversationByBeeId(beeId: number): StoredConversation | null {
    const row = this.#db.prepare("SELECT * FROM conversations WHERE bee_id = ?").get(beeId) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  // ---------- utterances ----------

  /** Save one line. Returns false if a line with the same Bee id and source is already stored. */
  insertUtterance(utterance: NewUtterance): { inserted: boolean; id: number | null } {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO utterances (bee_utterance_id, conversation_key, text, spoken_at, received_at, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(utterance.beeUtteranceId, utterance.conversationKey, utterance.text, utterance.spokenAt, utterance.receivedAt, utterance.source);
    return result.changes === 1 ? { inserted: true, id: Number(result.lastInsertRowid) } : { inserted: false, id: null };
  }

  /** Lines of a conversation spoken within `windowMs` of `spokenAt`. Used to spot backfill repeats. */
  utterancesNear(conversationKey: string, spokenAt: string, windowMs: number): StoredUtterance[] {
    const at = Date.parse(spokenAt);
    const from = new Date(at - windowMs).toISOString();
    const to = new Date(at + windowMs).toISOString();
    const rows = this.#db
      .prepare("SELECT * FROM utterances WHERE conversation_key = ? AND spoken_at BETWEEN ? AND ? ORDER BY spoken_at, id")
      .all(conversationKey, from, to) as Row[];
    return rows.map(toUtterance);
  }

  /**
   * Lines of ANY conversation spoken within `windowMs` of `spokenAt`. Backfill uses this because
   * Bee names a conversation by uuid on the stream and by number elsewhere, so the same line can
   * briefly sit under two conversation rows.
   */
  utterancesSpokenNear(spokenAt: string, windowMs: number): StoredUtterance[] {
    const at = Date.parse(spokenAt);
    const from = new Date(at - windowMs).toISOString();
    const to = new Date(at + windowMs).toISOString();
    const rows = this.#db.prepare("SELECT * FROM utterances WHERE spoken_at BETWEEN ? AND ? ORDER BY spoken_at, id").all(from, to) as Row[];
    return rows.map(toUtterance);
  }

  /** When the newest line of all reached us, or null if nothing has been heard yet. */
  newestUtteranceReceivedAt(): string | null {
    const row = this.#db.prepare("SELECT MAX(received_at) AS at FROM utterances").get() as Row | undefined;
    return (row?.at as string | null) ?? null;
  }

  /** When the newest stored line of a conversation was spoken, or null if it has none. */
  lastSpokenAt(conversationKey: string): string | null {
    const row = this.#db.prepare("SELECT MAX(spoken_at) AS at FROM utterances WHERE conversation_key = ?").get(conversationKey) as Row | undefined;
    return (row?.at as string | null) ?? null;
  }

  /** Conversations that have lines no detector run has covered yet. */
  conversationsAwaitingDetection(): AwaitingDetection[] {
    const rows = this.#db
      .prepare(
        `SELECT conversation_key, COUNT(*) AS pending, MAX(received_at) AS last_received
         FROM utterances WHERE detector_run_id IS NULL
         GROUP BY conversation_key ORDER BY last_received`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      conversationKey: String(row.conversation_key),
      pendingCount: Number(row.pending),
      lastReceivedAt: String(row.last_received),
    }));
  }

  /** The uncovered lines of one conversation, in the order they were spoken. */
  pendingUtterances(conversationKey: string): StoredUtterance[] {
    const rows = this.#db
      .prepare("SELECT * FROM utterances WHERE conversation_key = ? AND detector_run_id IS NULL ORDER BY spoken_at, id")
      .all(conversationKey) as Row[];
    return rows.map(toUtterance);
  }

  countUtterances(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM utterances").get() as Row).n);
  }

  // ---------- detector runs ----------

  /** Record a detector run and mark the lines it covered, in one step. Returns the run id. */
  recordDetectorRun(run: NewDetectorRun): number {
    return this.#db.transaction((): number => {
      const result = this.#db
        .prepare(
          `INSERT INTO detector_runs (conversation_key, ran_at, utterance_count, word_count, outcome, verdict_json, reason, ms, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.conversationKey,
          run.ranAt,
          run.utteranceIds.length,
          run.wordCount,
          run.outcome,
          run.verdict ? JSON.stringify(run.verdict) : null,
          run.reason ?? null,
          run.ms ?? null,
          run.attempts ?? null,
        );
      const runId = Number(result.lastInsertRowid);
      const mark = this.#db.prepare("UPDATE utterances SET detector_run_id = ? WHERE id = ? AND detector_run_id IS NULL");
      for (const id of run.utteranceIds) mark.run(runId, id);
      return runId;
    })();
  }

  countDetectorRuns(outcome?: DetectorOutcome): number {
    const row = outcome
      ? (this.#db.prepare("SELECT COUNT(*) AS n FROM detector_runs WHERE outcome = ?").get(outcome) as Row)
      : (this.#db.prepare("SELECT COUNT(*) AS n FROM detector_runs").get() as Row);
    return Number(row.n);
  }

  // ---------- ideas ----------

  /** A new idea always starts as "heard". */
  createIdea(idea: NewIdea, now: string): Idea {
    const id = `idea_${now.slice(0, 10).replaceAll("-", "")}_${randomBytes(4).toString("hex")}`;
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO ideas (id, state, title, pitch, quote, confidence, conversation_key, detector_run_id, created_at, updated_at, note)
           VALUES (?, 'heard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, idea.title, idea.pitch, idea.quote, idea.confidence, idea.conversationKey, idea.detectorRunId, now, now, idea.note ?? null);
      this.#db.prepare("INSERT INTO idea_events (idea_id, at, from_state, to_state, note) VALUES (?, ?, NULL, 'heard', ?)").run(id, now, idea.note ?? null);
    })();
    return this.getIdea(id) as Idea;
  }

  getIdea(id: string): Idea | null {
    const row = this.#db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Row | undefined;
    return row ? toIdea(row) : null;
  }

  findIdeaByTodoId(todoId: number): Idea | null {
    const row = this.#db.prepare("SELECT * FROM ideas WHERE todo_id = ?").get(todoId) as Row | undefined;
    return row ? toIdea(row) : null;
  }

  /** Ideas, oldest first. Filter by state and/or by creation time. */
  listIdeas(filter: { states?: IdeaState[]; createdSince?: string } = {}): Idea[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    if (filter.createdSince) {
      where.push("created_at >= ?");
      params.push(filter.createdSince);
    }
    const sql = `SELECT * FROM ideas ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.#db.prepare(sql).all(...params) as Row[]).map(toIdea);
  }

  /**
   * Move an idea to a new state. This is the only way an idea's state changes: it checks the
   * state machine, applies the patch and writes the timeline entry in one transaction.
   */
  transitionIdea(id: string, to: IdeaState, patch: IdeaPatch, now: string): Idea {
    return this.#db.transaction((): Idea => {
      const current = this.getIdea(id);
      if (!current) throw new Error(`No idea with id ${id}.`);
      assertTransition(current.state, to);
      const next = {
        note: patch.note === undefined ? current.note : patch.note,
        todoId: patch.todoId === undefined ? current.todoId : patch.todoId,
        askedAt: patch.askedAt === undefined ? current.askedAt : patch.askedAt,
        askExpiresAt: patch.askExpiresAt === undefined ? current.askExpiresAt : patch.askExpiresAt,
        answeredAt: patch.answeredAt === undefined ? current.answeredAt : patch.answeredAt,
      };
      this.#db
        .prepare("UPDATE ideas SET state = ?, note = ?, todo_id = ?, asked_at = ?, ask_expires_at = ?, answered_at = ?, updated_at = ? WHERE id = ?")
        .run(to, next.note, next.todoId, next.askedAt, next.askExpiresAt, next.answeredAt, now, id);
      this.#db.prepare("INSERT INTO idea_events (idea_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)").run(id, now, current.state, to, patch.note ?? null);
      return this.getIdea(id) as Idea;
    })();
  }

  /** Change an idea's note without changing its state (for example "over today's ask limit"). */
  setIdeaNote(id: string, note: string | null, now: string): void {
    this.#db.prepare("UPDATE ideas SET note = ?, updated_at = ? WHERE id = ?").run(note, now, id);
  }

  ideaEvents(id: string): IdeaEvent[] {
    return (this.#db.prepare("SELECT * FROM idea_events WHERE idea_id = ? ORDER BY id").all(id) as Row[]).map(toIdeaEvent);
  }

  /** Titles of ideas created at or after `since`, newest first. For de-duplication. */
  recentIdeaTitles(since: string): string[] {
    const rows = this.#db.prepare("SELECT title FROM ideas WHERE created_at >= ? ORDER BY created_at DESC").all(since) as Row[];
    return rows.map((row) => String(row.title));
  }

  /** How many ideas were asked about between two instants (start inclusive, end exclusive). */
  countAsksBetween(start: string, end: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM idea_events WHERE to_state = 'asked' AND at >= ? AND at < ?").get(start, end) as Row;
    return Number(row.n);
  }

  countIdeasByState(): Partial<Record<IdeaState, number>> {
    const rows = this.#db.prepare("SELECT state, COUNT(*) AS n FROM ideas GROUP BY state").all() as Row[];
    return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.n)])) as Partial<Record<IdeaState, number>>;
  }

  // ---------- small values (backfill cursor, paused flag) ----------

  getValue(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setValue(key: string, value: string, now: string): void {
    this.#db
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, now);
  }

  /** While paused, Overnight still listens and detects but never asks or builds. */
  isPaused(defaultValue: boolean): boolean {
    const stored = this.getValue("paused");
    return stored === null ? defaultValue : stored === "true";
  }

  setPaused(paused: boolean, now: string): void {
    this.setValue("paused", paused ? "true" : "false", now);
  }
}
