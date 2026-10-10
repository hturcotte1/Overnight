// Shared types and the contracts between packages.
// packages/bee implements BeeGateway. packages/detector implements Detector.
// packages/listener is written against these interfaces only, so its tests can use fakes.

// ---------- Ideas ----------

export const IDEA_STATES = [
  "heard",
  "asked",
  "approved",
  "rejected",
  "expired",
  "building",
  "built",
  "build_failed",
  "published",
  "publish_failed",
  "delivered",
] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

export interface Idea {
  id: string;
  state: IdeaState;
  title: string;
  pitch: string;
  /** Short verbatim quote from the conversation. The only transcript text that leaves the store. */
  quote: string;
  confidence: number;
  conversationKey: string;
  detectorRunId: number | null;
  /** Bee to-do that carries the ask, once asked. */
  todoId: number | null;
  createdAt: string;
  updatedAt: string;
  askedAt: string | null;
  /** When an unanswered ask expires. */
  askExpiresAt: string | null;
  answeredAt: string | null;
  /** Why the idea is where it is (for example "over the daily ask limit"). No transcript text. */
  note: string | null;
}

export interface IdeaEvent {
  id: number;
  ideaId: string;
  at: string;
  fromState: IdeaState | null;
  toState: IdeaState;
  note: string | null;
}

// ---------- What we store of what Bee heard ----------

/** All times are ISO 8601 strings in UTC. */
export interface StoredUtterance {
  id: number;
  /** Bee's utterance id when it came from the live stream; null for backfilled lines. */
  beeUtteranceId: number | null;
  conversationKey: string;
  text: string;
  spokenAt: string;
  receivedAt: string;
  source: "stream" | "backfill";
  /** Detector run that covered this line, or null if no run has covered it yet. */
  detectorRunId: number | null;
}

export interface StoredConversation {
  /** Our own key. Bee has two ids for a conversation and we may learn them at different times. */
  key: string;
  uuid: string | null;
  beeId: number | null;
  state: string | null;
  startTime: string | null;
  endTime: string | null;
  deleted: boolean;
}

// ---------- Bee ----------

/**
 * Events from Bee's live stream, already validated and stripped down by packages/bee.
 * Nothing here carries a transcript, a summary or a person's name, on purpose: the raw
 * COMPLETED conversation event contains all three and must never be stored or logged.
 */
export type BeeEvent =
  | { type: "connected" }
  | {
      type: "utterance";
      beeUtteranceId: number;
      conversationUuid: string;
      text: string;
      spokenAt: string;
    }
  | {
      type: "conversation";
      kind: "new" | "update" | "delete";
      beeId: number;
      uuid: string | null;
      state: string | null;
      startTime: string | null;
      endTime: string | null;
    }
  | { type: "todo-deleted"; todoId: number };

export type StreamEnd = { reason: "closed" | "ended" | "error"; message?: string };

export interface BeeStream {
  /** Stop listening. Safe to call more than once. */
  close(): void;
  /** Resolves when the stream is over, whatever the cause. Never rejects. */
  done: Promise<StreamEnd>;
}

export type LoginState = "logged-in" | "logged-out" | "unknown";
export type TodoStatus = "open" | "completed" | "deleted";

export interface BackfillUtterance {
  /** Bee's id for this line in its stored transcript. Not the same id space as the live stream. */
  beeUtteranceId: number | null;
  text: string;
  spokenAt: string;
}

export interface ChangedSince {
  /** Cursor to pass next time. Null if Bee did not return one. */
  nextCursor: string | null;
  /** Numeric ids of conversations that changed. */
  conversationIds: number[];
}

/**
 * Every Bee call the product makes. Each method has its own timeout and throws a BeeError with
 * a clear message on failure. Methods never return or log names, tokens or raw payloads.
 */
export interface BeeGateway {
  loginState(): Promise<LoginState>;
  /** Open the live stream. Events are delivered in arrival order. */
  stream(onEvent: (event: BeeEvent) => void): BeeStream;
  /** What changed since the cursor. With no cursor, use the result only for its nextCursor. */
  changedSince(cursor: string | null): Promise<ChangedSince>;
  /** Lines of a stored transcript spoken at or after sinceMs. Returns null if Bee no longer has it. */
  transcriptSince(conversationBeeId: number, sinceMs: number): Promise<BackfillUtterance[] | null>;
  /**
   * Create a to-do with an alarm. The error kind says whether it is safe to try again:
   * "failed" and "logged-out" mean Bee refused and nothing was created; "timeout" and
   * "bad-response" mean the to-do MAY exist, so the caller must not create another one.
   */
  createTodo(text: string, alarmAt: Date): Promise<{ id: number }>;
  /** "deleted" only when Bee positively says the to-do does not exist. Any other failure throws. */
  todoStatus(id: number): Promise<TodoStatus>;
}

export class BeeError extends Error {
  readonly kind: "timeout" | "logged-out" | "not-found" | "bad-response" | "failed";
  constructor(kind: BeeError["kind"], message: string) {
    super(message);
    this.name = "BeeError";
    this.kind = kind;
  }
}

// ---------- Detector ----------

export interface DetectorVerdict {
  is_idea: boolean;
  confidence: number;
  /** At most 6 words. Empty when not an idea. */
  title: string;
  /** At most 40 words. Empty when not an idea. */
  pitch: string;
  /** At most 25 words, copied word for word from the conversation. Empty when not an idea. */
  quote: string;
  said_by_wearer_guess: boolean;
  likely_media: boolean;
  buildable_as_static_web_app: boolean;
  reason: string;
}

export interface DetectorInput {
  /** Text and times only. No speaker names, no ids. */
  utterances: Array<{ text: string; spokenAt: string }>;
  /** Titles of ideas from the last 14 days, so the model can avoid repeats. */
  recentTitles: string[];
}

export type DetectorResult =
  | { ok: true; verdict: DetectorVerdict; ms: number; attempts: number }
  | {
      ok: false;
      reason: string;
      ms: number;
      attempts: number;
      /**
       * True when the detector could not even try (not set up yet, Kiro signed out, process
       * stopping). The caller keeps the lines and asks again later without counting a failure.
       */
      retryLater?: boolean;
    };

export interface Detector {
  /** Never throws: a bad or missing model reply comes back as { ok: false }. */
  detect(input: DetectorInput): Promise<DetectorResult>;
}
