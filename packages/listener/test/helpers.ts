// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// Fakes for everything the listener talks to: Bee, the detector and the clock.
import { createLogger, parseConfig, Store } from "@overnight/core";
import type {
  BackfillUtterance,
  BeeEvent,
  BeeGateway,
  BeeStream,
  ChangedSince,
  Config,
  Detector,
  DetectorInput,
  DetectorResult,
  DetectorVerdict,
  LoginState,
  StreamEnd,
  TodoStatus,
} from "@overnight/core";
import { createListener } from "../src/index.ts";
import type { Listener, ListenerOptions, SpawnKeepAwake } from "../src/index.ts";
import type { ListenerContext } from "../src/context.ts";
import { resolveOptions } from "../src/options.ts";

/** 2:00 pm on Oct 9, 2026 in Boise (UTC-6 in summer time). */
export const T0 = "2026-10-09T20:00:00.000Z";
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export function movableClock(startIso: string = T0) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advance(byMs: number) {
      ms += byMs;
    },
    set(iso: string) {
      ms = Date.parse(iso);
    },
  };
}
export type Clock = ReturnType<typeof movableClock>;

/** A stream the test can push events into and end. */
export class FakeStream implements BeeStream {
  closed = false;
  readonly done: Promise<StreamEnd>;
  #finish: (end: StreamEnd) => void = () => {};
  readonly #onEvent: (event: BeeEvent) => void;

  constructor(onEvent: (event: BeeEvent) => void) {
    this.#onEvent = onEvent;
    this.done = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  push(event: BeeEvent): void {
    this.#onEvent(event);
  }

  end(end: StreamEnd = { reason: "ended" }): void {
    this.#finish(end);
  }

  close(): void {
    this.closed = true;
    this.#finish({ reason: "closed" });
  }
}

/** Records every call. What it answers is scripted by the test. */
export class FakeBee implements BeeGateway {
  /** Answers for loginState(), one per call. "logged-in" once they run out. */
  loginStates: Array<LoginState | Error> = [];
  loginCalls = 0;

  streams: FakeStream[] = [];
  /** If set, the next stream() call throws it. */
  streamOpenError: Error | null = null;

  createCalls: Array<{ text: string; alarmAt: Date }> = [];
  /** Thrown by createTodo, one per call, before it starts succeeding. Nothing is created on these calls. */
  createErrors: Error[] = [];
  /** Thrown by createTodo, one per call, AFTER the to-do was made: Bee did the work but its reply was lost. */
  lostReplies: Error[] = [];
  /** Every to-do that exists in the fake Bee, whether or not the caller was told its id. */
  created: number[] = [];
  nextTodoId = 9001;

  /** What todoStatus answers for each to-do id. "open" if not listed. */
  todos = new Map<number, TodoStatus | Error>();
  statusCalls: number[] = [];

  changedCalls: Array<string | null> = [];
  /** Answers for changedSince(), one per call. An empty reply with the same cursor once they run out. */
  changedReplies: Array<ChangedSince | Error> = [];
  /** What transcriptSince answers for each conversation id. */
  transcripts = new Map<number, BackfillUtterance[] | null | Error>();
  transcriptCalls: Array<{ id: number; sinceMs: number }> = [];

  async loginState(): Promise<LoginState> {
    this.loginCalls += 1;
    const next = this.loginStates.shift() ?? "logged-in";
    if (next instanceof Error) throw next;
    return next;
  }

  stream(onEvent: (event: BeeEvent) => void): BeeStream {
    if (this.streamOpenError) {
      const error = this.streamOpenError;
      this.streamOpenError = null;
      throw error;
    }
    const stream = new FakeStream(onEvent);
    this.streams.push(stream);
    return stream;
  }

  get lastStream(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("No stream has been opened.");
    return stream;
  }

  async changedSince(cursor: string | null): Promise<ChangedSince> {
    this.changedCalls.push(cursor);
    const next = this.changedReplies.shift() ?? { nextCursor: cursor, conversationIds: [] };
    if (next instanceof Error) throw next;
    return next;
  }

  async transcriptSince(conversationBeeId: number, sinceMs: number): Promise<BackfillUtterance[] | null> {
    this.transcriptCalls.push({ id: conversationBeeId, sinceMs });
    // null is a real answer here ("Bee no longer has it"), so only a missing entry means "no lines".
    const lines = this.transcripts.has(conversationBeeId) ? (this.transcripts.get(conversationBeeId) ?? null) : [];
    if (lines instanceof Error) throw lines;
    return lines === null ? null : lines.filter((line) => Date.parse(line.spokenAt) >= sinceMs);
  }

  async createTodo(text: string, alarmAt: Date): Promise<{ id: number }> {
    this.createCalls.push({ text, alarmAt });
    const error = this.createErrors.shift();
    if (error) throw error;
    const id = this.nextTodoId;
    this.nextTodoId += 1;
    this.created.push(id);
    const lost = this.lostReplies.shift();
    if (lost) throw lost;
    return { id };
  }

  async todoStatus(id: number): Promise<TodoStatus> {
    this.statusCalls.push(id);
    const status = this.todos.get(id) ?? "open";
    if (status instanceof Error) throw status;
    return status;
  }
}

export function ideaVerdict(overrides: Partial<DetectorVerdict> = {}): DetectorVerdict {
  return {
    is_idea: true,
    confidence: 0.9,
    title: "Whose turn to pay",
    pitch: "Tap who paid for lunch and see whose turn is next.",
    quote: "someone should build a tiny app that tracks whose turn it is",
    said_by_wearer_guess: true,
    likely_media: false,
    buildable_as_static_web_app: true,
    reason: "a wish for a small tool",
    ...overrides,
  };
}

export function notIdeaVerdict(): DetectorVerdict {
  return {
    is_idea: false,
    confidence: 0.9,
    title: "",
    pitch: "",
    quote: "",
    said_by_wearer_guess: false,
    likely_media: false,
    buildable_as_static_web_app: false,
    reason: "small talk about the weather",
  };
}

/** Answers from a script, one entry per call. Says "not an idea" once the script runs out. */
export class FakeDetector implements Detector {
  inputs: DetectorInput[] = [];
  script: Array<DetectorVerdict | DetectorResult | Error> = [];
  /** Runs while a detect() call is "with the model", so a test can make things happen mid-call. */
  duringCall: (() => void) | null = null;

  async detect(input: DetectorInput): Promise<DetectorResult> {
    this.inputs.push(structuredClone(input));
    this.duringCall?.();
    const next = this.script.shift() ?? notIdeaVerdict();
    if (next instanceof Error) throw next;
    return "ok" in next ? next : { ok: true, verdict: next, ms: 4, attempts: 1 };
  }

  /** The text the detector was shown on its nth call. */
  textsOf(call: number): string[] {
    return (this.inputs[call]?.utterances ?? []).map((line) => line.text);
  }
}

export const failedRun = (reason = "no JSON in the reply"): DetectorResult => ({ ok: false, reason, ms: 7, attempts: 2 });

/** What the detector answers when it cannot even try (not set up yet, Kiro signed out). */
export const notReady = (reason = "the detector is not set up"): DetectorResult => ({ ok: false, reason, ms: 0, attempts: 0, retryLater: true });

export interface LogLine {
  level: string;
  message: string;
  [field: string]: unknown;
}

export function testConfig(env: Record<string, string> = {}): Config {
  // A data folder that does not exist: nothing in these tests may touch the real one.
  // Tests exercise the live behaviour unless they pause on purpose. (The product default is paused.)
  return parseConfig({ OVERNIGHT_DATA_DIR: "/nonexistent/overnight-tests", PAUSED: "false", ...env });
}

export interface Rig {
  store: Store;
  bee: FakeBee;
  detector: FakeDetector;
  clock: Clock;
  config: Config;
  options: ListenerOptions;
  listener: Listener;
  /** The same pieces as a context, for calling one part of the listener directly. */
  ctx: ListenerContext;
  /** Every log line written so far, as text and parsed. */
  logText: string[];
  logs(): LogLine[];
  /** Deliver a spoken line as the stream would, stamped with the clock's current time. */
  hear(text: string, uuid?: string): number;
  /** Let work started by an event (not by a pass) finish. */
  settle(): Promise<void>;
}

export interface RigSetup {
  options?: Partial<ListenerOptions>;
  env?: Record<string, string>;
  start?: string;
  /** Use this store instead of a new one, as a listener does when it starts again on the same data. */
  store?: Store;
  spawnKeepAwake?: SpawnKeepAwake;
  wallClock?: () => number;
}

export function makeRig(setup: RigSetup = {}): Rig {
  const store = setup.store ?? new Store(":memory:");
  const bee = new FakeBee();
  const detector = new FakeDetector();
  const clock = movableClock(setup.start ?? T0);
  const config = testConfig(setup.env);
  const logText: string[] = [];
  const logger = createLogger({ name: "listener-test", minLevel: "debug", write: (line) => logText.push(line), now: clock.now });
  const listener = createListener({ store, bee, detector, config, logger, now: clock.now, options: setup.options, spawnKeepAwake: setup.spawnKeepAwake, wallClock: setup.wallClock });
  const options = resolveOptions(setup.options);
  let nextLineId = 5000;

  return {
    store,
    bee,
    detector,
    clock,
    config,
    options,
    listener,
    ctx: { store, bee, detector, config, logger, now: clock.now, options, onLoggedOut: () => {} },
    logText,
    logs: () => logText.map((line) => JSON.parse(line) as LogLine),
    hear(text, uuid = "conv-a") {
      const beeUtteranceId = nextLineId;
      nextLineId += 1;
      listener.handleEvent({ type: "utterance", beeUtteranceId, conversationUuid: uuid, text, spokenAt: clock.iso() });
      return beeUtteranceId;
    },
    // stop() without start() only waits for event-triggered work.
    settle: () => listener.stop(),
  };
}

/** Two made-up lines that add up to a buildable idea. Nineteen words. */
export const IDEA_LINES = ["you know what, someone should build a tiny app", "that tracks whose turn it is to pay for lunch"];

/** Hear the idea lines, wait out the quiet time, and run one detection pass with `verdict` scripted. */
export async function hearAndDetect(rig: Rig, verdict: DetectorVerdict, uuid = "conv-a", lines: string[] = IDEA_LINES): Promise<void> {
  for (const line of lines) rig.hear(line, uuid);
  rig.clock.advance(rig.options.quietMs);
  rig.detector.script.push(verdict);
  await rig.listener.runDetectionPass();
}
