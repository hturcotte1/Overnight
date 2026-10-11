// Synthetic test data: every title, pitch, quote and file in these tests is made up. None of it is Bee data.
// Fakes for everything the deliver step talks to: Bee, the verifier, the publisher, the clock.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BeeError, createLogger, dataPaths, ensureDataDirs, parseConfig, Store } from "@overnight/core";
import type { BeeGateway, BeeStream, ChangedSince, Config, DataPaths, Idea, IdeaState, Logger, LoginState, TodoStatus } from "@overnight/core";
import { afterEach } from "vitest";
import type { DeliverDeps, Publisher, PublishJob, PublishResult, Verifier, VerifyJob, VerifyResult } from "../src/index.ts";

/** 6:30 am on Oct 10, 2026 in Boise (UTC-6 in summer time): the normal deliver run. */
export const T_0630 = "2026-10-10T12:30:00.000Z";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TITLE = "Zebra lunch ledger";
export const PITCH = "A pocket ledger that settles whose turn it is to buy the noodles.";
export const QUOTE = "someone should build a zebra-striped lunch ledger";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp folder (its real path), removed after the test. */
export function tempDir(prefix = "overnight-deliver-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Write files given as { "relative/path": "content" } under `root`. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export function movableClock(startIso: string = T_0630) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advance(byMs: number) {
      ms += byMs;
    },
  };
}

/** A logger that keeps every line, at debug level, so tests can check what reaches the log. */
export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ name: "deliver-test", minLevel: "debug", write: (line) => lines.push(line) }), lines };
}

/** Records every call. What it answers is scripted by the test. */
export class FakeBee implements BeeGateway {
  todoCalls: Array<{ text: string; alarmAt: Date }> = [];
  /** Thrown by createTodo, one per call, before it starts succeeding. */
  todoErrors: Error[] = [];
  nextTodoId = 7001;
  factCalls: string[] = [];
  factErrors: Error[] = [];
  nextFactId = 301;
  /** Called at the start of every createTodo, before it answers. */
  onCreateTodo: () => void = () => {};
  /** When set, createTodo does not answer until this resolves (a Bee that is slow, or never answers). */
  todoGate: Promise<void> | null = null;
  factGate: Promise<void> | null = null;

  async createTodo(text: string, alarmAt: Date): Promise<{ id: number }> {
    this.todoCalls.push({ text, alarmAt });
    this.onCreateTodo();
    if (this.todoGate !== null) await this.todoGate;
    const error = this.todoErrors.shift();
    if (error) throw error;
    const id = this.nextTodoId;
    this.nextTodoId += 1;
    return { id };
  }

  async createFact(text: string): Promise<{ id: number }> {
    this.factCalls.push(text);
    if (this.factGate !== null) await this.factGate;
    const error = this.factErrors.shift();
    if (error) throw error;
    const id = this.nextFactId;
    this.nextFactId += 1;
    return { id };
  }

  async loginState(): Promise<LoginState> {
    return "logged-in";
  }
  stream(): BeeStream {
    throw new Error("The deliver step never opens the stream.");
  }
  async changedSince(): Promise<ChangedSince> {
    throw new Error("The deliver step never asks what changed.");
  }
  async transcriptSince(): Promise<null> {
    throw new Error("The deliver step never reads a transcript.");
  }
  async todoStatus(): Promise<TodoStatus> {
    throw new Error("The deliver step never checks a to-do.");
  }
}

export const refused = () => new BeeError("failed", "bee exited with code 1");
export const lostReply = () => new BeeError("timeout", "bee did not answer in time");

/** A verifier that says yes (or whatever the test scripts) and records what it was asked. */
export class FakeVerifier implements Verifier {
  calls: VerifyJob[] = [];
  results: Array<VerifyResult | Error> = [];
  /** Called at the start of every verify. May return a promise to hold the verification up. */
  onVerify: (job: VerifyJob) => void | Promise<void> = () => {};

  async verify(job: VerifyJob): Promise<VerifyResult> {
    this.calls.push(job);
    await this.onVerify(job);
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const distDir = path.join(job.runDir, "site");
    writeTree(distDir, { "index.html": "<h1>made-up app</h1>\n" });
    return {
      ok: true,
      distDir,
      screenshotPhone: `/made-up/screenshots/${job.ideaId}.png`,
      screenshotDesktop: `/made-up/screenshots/${job.ideaId}-desktop.png`,
      checks: { buildOk: true, distFiles: 1, distBytes: 23, sourceFiles: 4, sourceBytes: 900, totalMs: 4200 },
    };
  }
}

export class FakePublisher implements Publisher {
  calls: PublishJob[] = [];
  results: Array<PublishResult | Error> = [];
  /** Called at the start of every publish. */
  onPublish: (job: PublishJob) => void | Promise<void> = () => {};

  async publish(job: PublishJob): Promise<PublishResult> {
    this.calls.push(job);
    await this.onPublish(job);
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? { ok: true, url: `https://made-up-owner.github.io/overnight-apps/${job.slug}/`, liveAfterMs: 21_000 };
  }
}

export interface Rig {
  store: Store;
  bee: FakeBee;
  verifier: FakeVerifier;
  publisher: FakePublisher;
  config: Config;
  paths: DataPaths;
  clock: ReturnType<typeof movableClock>;
  logLines: string[];
  deps: DeliverDeps;
  /** Create an idea and walk it to `state` the way the earlier steps would. `failureReason` is for "build_failed". */
  idea(state: IdeaState, overrides?: { title?: string; slug?: string | null; failureReason?: string }): Idea;
  /** What the night builder does on a later night: start this idea's build once more, and end it as told. */
  buildAgain(ideaId: string, end: "built" | { failureReason: string }): Idea;
  /** The states an idea has been through, in order. */
  states(ideaId: string): string[];
}

export function makeRig(options: { env?: Record<string, string>; startIso?: string } = {}): Rig {
  const dataDir = tempDir();
  const config = parseConfig({ OVERNIGHT_DATA_DIR: dataDir, ...options.env });
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const store = new Store(":memory:");
  const bee = new FakeBee();
  const verifier = new FakeVerifier();
  const publisher = new FakePublisher();
  const clock = movableClock(options.startIso);
  const { logger, lines } = collectingLogger();
  let made = 0;

  const WALK: IdeaState[] = ["asked", "approved", "building", "built"];
  function idea(state: IdeaState, overrides: { title?: string; slug?: string | null; failureReason?: string } = {}): Idea {
    made += 1;
    const title = overrides.title ?? TITLE;
    const slug = overrides.slug === undefined ? `zebra-lunch-ledger-${made}` : overrides.slug;
    // Earlier than "now", and each idea a second after the one before, so their order is fixed.
    const at = new Date(clock.now().getTime() - HOUR + made * 1000).toISOString();
    const created = store.createIdea({ title, pitch: PITCH, quote: QUOTE, confidence: 0.9, conversationKey: `c_made_up_${made}`, detectorRunId: null }, at);
    const go = (to: IdeaState, patch = {}) => store.transitionIdea(created.id, to, patch, at);
    for (const step of WALK) {
      if (step === "building") go(step, { slug, buildBackend: "kiro-crew", buildStartedAt: at });
      else if (step === "built") {
        if (state === "build_failed") {
          go("build_failed", { failureReason: overrides.failureReason ?? "The build agent ran out of time." });
          break;
        }
        go(step, { builtAt: at });
      } else go(step);
      if (step === state) break;
    }
    if (state === "published" || state === "delivered") go("published", { publishedUrl: `https://made-up-owner.github.io/overnight-apps/${slug}/`, publishedAt: at });
    if (state === "delivered") go("delivered", { deliveredAt: at, morningTodoId: 6000 + made });
    if (state === "publish_failed") go("publish_failed", { failureReason: "The app's build command (npm run build) failed." });
    const result = store.getIdea(created.id);
    if (result === null || result.state !== state) throw new Error(`The test rig cannot make an idea in state ${state}.`);
    return result;
  }

  function buildAgain(ideaId: string, end: "built" | { failureReason: string }): Idea {
    const at = clock.iso();
    store.transitionIdea(ideaId, "building", { buildStartedAt: at, failureReason: null }, at);
    return end === "built" ? store.transitionIdea(ideaId, "built", { builtAt: at }, at) : store.transitionIdea(ideaId, "build_failed", { failureReason: end.failureReason }, at);
  }

  return {
    store,
    bee,
    verifier,
    publisher,
    config,
    paths,
    clock,
    logLines: lines,
    deps: { store, bee, config, paths, logger, now: clock.now, verify: verifier, publish: publisher, retryDelayMs: 0 },
    idea,
    buildAgain,
    states: (ideaId) => store.ideaEvents(ideaId).map((event) => event.toState),
  };
}
