// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// Fakes for everything the builder talks to: the clock, the store's ideas, the command runner,
// and a scripted stand-in for Kiro Crew that works on a temp folder. Nothing here starts a
// process or touches the network.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, dataPaths, ensureDataDirs, parseConfig, Store } from "@overnight/core";
import type { Config, DataPaths, Idea, Logger } from "@overnight/core";
import { afterEach } from "vitest";
import type { BuildBackend, BuildJob, BuildOptions, BuildOutcome, CommandResult, CommandRunner, RunOptions } from "../src/index.ts";

/** 1:00 am on Oct 10, 2026 in Boise (UTC-6 in summer time): build time. */
export const T0 = "2026-10-10T07:00:00.000Z";
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export function movableClock(startIso: string = T0) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    ms: () => ms,
    advance(byMs: number) {
      ms += byMs;
    },
    set(iso: string) {
      ms = Date.parse(iso);
    },
  };
}
export type Clock = ReturnType<typeof movableClock>;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp folder (its real path, as macOS temp folders sit behind a link), removed after the test. */
export function tempDir(prefix = "overnight-builder-test-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export function testPaths(root: string = tempDir()): DataPaths {
  const paths = dataPaths(root);
  ensureDataDirs(paths);
  return paths;
}

export function testConfig(dataDir: string, overrides: Record<string, string> = {}): Config {
  return parseConfig({ OVERNIGHT_DATA_DIR: dataDir, PAUSED: "false", ...overrides });
}

/** Collects log lines so a test can check what was (and was not) logged. */
export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ name: "test", minLevel: "debug", write: (line) => lines.push(line) }), lines };
}

// ---------- ideas ----------

export function memoryStore(): Store {
  return new Store(":memory:");
}

let conversationCounter = 0;

/** An idea that was heard, asked about and ticked in Bee at `approvedAtIso`. */
export function approvedIdea(store: Store, options: { title?: string; pitch?: string; quote?: string; approvedAt?: string; heardAt?: string } = {}): Idea {
  const approvedAt = options.approvedAt ?? "2026-10-09T22:00:00.000Z";
  const heardAt = options.heardAt ?? new Date(Date.parse(approvedAt) - 10 * MINUTE).toISOString();
  conversationCounter += 1;
  const conversation = store.resolveConversation({ uuid: `conv-${conversationCounter}` }, heardAt);
  const idea = store.createIdea(
    {
      title: options.title ?? "Coin Flipper",
      pitch: options.pitch ?? "A button that flips a coin and keeps a tally of heads and tails.",
      quote: options.quote ?? "we should just flip a coin for it every single time",
      confidence: 0.9,
      conversationKey: conversation.key,
      detectorRunId: null,
    },
    heardAt,
  );
  store.transitionIdea(idea.id, "asked", { askedAt: heardAt, todoId: 9000 + conversationCounter }, heardAt);
  return store.transitionIdea(idea.id, "approved", { answeredAt: approvedAt, note: "ticked in Bee" }, approvedAt);
}

// ---------- what a build agent leaves behind ----------

/**
 * Write the files a finished build leaves in a workspace. `at` sets the status file's own
 * modification time, for tests that run on a made-up clock.
 */
export function leaveBuild(workspace: string, options: { status?: string; dist?: boolean; raw?: string; at?: Date } = {}): void {
  const status = options.status ?? "built";
  const statusFile = path.join(workspace, "BUILD_STATUS.json");
  writeFileSync(statusFile, options.raw ?? JSON.stringify({ status, build_ok: status === "built", smoke_test: status === "built" ? "passed" : "not_run", skill: "overnight-build", reason: "" }));
  if (options.at) utimesSync(statusFile, options.at, options.at);
  if (options.dist ?? status === "built") {
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    writeFileSync(path.join(workspace, "dist", "index.html"), "<!doctype html><title>made up</title>");
  }
}

// ---------- backends for the night flow ----------

export interface FakeBackend extends BuildBackend {
  jobs: BuildJob[];
  /** What each job found in its workspace when it started. */
  seen: Array<{ files: string[]; brief: string }>;
  /** The stop signal each job was handed. */
  signals: Array<AbortSignal | undefined>;
}

/** A backend whose answers are scripted, one per call. The last one repeats. */
export function fakeBackend(
  name: BuildBackend["name"],
  answers: Array<"built" | "failed" | "cannot-start" | "throws" | ((job: BuildJob, options: BuildOptions) => Promise<BuildOutcome> | BuildOutcome)>,
): FakeBackend {
  const jobs: BuildJob[] = [];
  const seen: FakeBackend["seen"] = [];
  const signals: FakeBackend["signals"] = [];
  let call = 0;
  return {
    name,
    jobs,
    seen,
    signals,
    async build(job, options = {}) {
      jobs.push(job);
      signals.push(options.signal);
      seen.push({ files: readdirSync(job.workspace).sort(), brief: readFileSync(job.briefPath, "utf8") });
      const answer = answers[Math.min(call, answers.length - 1)] ?? "built";
      call += 1;
      if (typeof answer === "function") return answer(job, options);
      if (answer === "throws") throw new Error("made-up backend crash");
      if (answer === "built") {
        leaveBuild(job.workspace);
        return { ok: true, backend: name, ms: 1234 };
      }
      return { ok: false, backend: name, ms: 55, reason: answer === "failed" ? "the builder reported that the build failed" : "the gateway is not running", couldNotStart: answer === "cannot-start" };
    },
  };
}

// ---------- the command runner ----------

export interface RunCall {
  command: string;
  args: string[];
  options: RunOptions;
}

export function reply(stdout = "", extra: Partial<CommandResult> = {}): CommandResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, ...extra };
}

/** A runner that records every call and answers with `handler`. */
export function recordingRunner(handler: (call: RunCall) => CommandResult | Promise<CommandResult>): { run: CommandRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    calls,
    run: async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      return handler(call);
    },
  };
}

// ---------- a scripted Kiro Crew ----------

export interface FakeCrewJob {
  id: string;
  name: string;
  message: string;
  flags: string[];
  removed: boolean;
}

/**
 * Stands in for the kirocrew program and the gateway behind it. It answers `cron add`,
 * `cron trigger` and `cron remove` with the texts the experiments recorded, and keeps Crew's
 * files (crons.json, cron-running/, cron-history/_index.jsonl, usage/tokens/) in a temp folder.
 * A triggered job "runs" until the test's clock has moved `runForMs`; `tick()` is called by the
 * fake sleep.
 */
export class FakeCrew {
  readonly home: string;
  readonly binary: string;
  readonly jobs: FakeCrewJob[] = [];
  /** Every kirocrew command, as kirocrew saw it (a sandbox-exec wrapper is taken off). */
  readonly calls: RunCall[] = [];
  /** For each call: the sandbox-exec arguments it was wrapped in, or null when it was run directly. */
  readonly wrappers: Array<string[] | null> = [];
  /** Every cancel request the backend sent, and what the stand-in gateway answers (an HTTP status, or null). */
  readonly cancels: Array<{ port: number; jobId: string; secret: string; timeoutMs: number }> = [];
  cancelStatus: number | null = 200;
  /** Called at the start of every kirocrew command, before it is answered. */
  onCommand: (call: RunCall) => void | Promise<void> = () => {};
  /** What `cron add` prints instead of adding, once per entry. */
  addReplies: CommandResult[] = [];
  /** What `cron trigger` prints instead of starting the job, once per entry. */
  triggerReplies: CommandResult[] = [];
  /** How long a triggered job runs on the test clock. Infinity: it never finishes. */
  runForMs = 2 * MINUTE;
  /** How long after the trigger the "running" marker appears. */
  startDelayMs = 0;
  /** What the job does to the world when it ends (write BUILD_STATUS.json, probe results, ...). */
  onJobEnd: (job: FakeCrewJob) => void = () => {};
  /** The status Crew records. It says "success" whenever a session ends. */
  historyStatus = "success";
  /** Set to false to stand in for a Crew whose history cannot be written. */
  writeHistory = true;
  credits: number | null = 3.6;
  /** The credits Crew records for a run that was cancelled. Null: it records none (not measured yet for the real one). */
  creditsWhenCancelled: number | null = null;
  #nextId = 0x76be9f71;
  #running: Array<{ job: FakeCrewJob; marker: string; markerWritten: boolean; startedMs: number; endsAtMs: number }> = [];
  readonly #clock: Clock;

  constructor(clock: Clock, home: string = tempDir("overnight-fake-crew-")) {
    this.#clock = clock;
    this.home = home;
    this.binary = path.join(home, "kirocrew");
    writeFileSync(this.binary, "#!/bin/sh\n# stand-in: never run\n");
    mkdirSync(path.join(home, "cron-running"), { recursive: true });
    mkdirSync(path.join(home, "cron-history"), { recursive: true });
    this.writeSettings({ sandbox: "strict" });
    this.#saveStore();
  }

  writeSettings(agent: Record<string, unknown>): void {
    writeFileSync(path.join(this.home, "config.json"), JSON.stringify({ meta: { lastTouchedVersion: "0.8.0" }, agent }));
  }

  installSkill(text: string): string {
    const file = path.join(this.home, "skills", "overnight-build", "SKILL.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  /** Put a job in Crew's store as if an earlier, killed run had left it there. */
  leaveJob(name: string): FakeCrewJob {
    const job: FakeCrewJob = { id: (this.#nextId++).toString(16), name, message: "", flags: [], removed: false };
    this.jobs.push(job);
    this.#saveStore();
    return job;
  }

  /** Give the stand-in gateway a local secret, as a running gateway has. */
  writeSecret(secret = "0123456789abcdef0123456789abcdef", port = 5476): void {
    mkdirSync(path.join(this.home, "run"), { recursive: true });
    writeFileSync(path.join(this.home, "run", `gateway-${port}-127.0.0.1.secret`), secret);
  }

  /** Stands in for the gateway's cancel address: a cancelled run ends at once, with a "cancelled" history row. */
  postCancel = async (request: { port: number; jobId: string; secret: string; timeoutMs: number }): Promise<number | null> => {
    this.cancels.push(request);
    if (this.cancelStatus !== 200) return this.cancelStatus;
    const run = this.#running.find((candidate) => candidate.job.id === request.jobId);
    if (!run) return 409;
    this.#running.splice(this.#running.indexOf(run), 1);
    rmSync(run.marker, { force: true });
    const row = { run_id: "e1b21a2415cf", job_id: run.job.id, trigger: "manual", started_at: run.startedMs / 1000, finished_at: this.#clock.ms() / 1000, status: "cancelled", error: "Cancelled by user" };
    appendFileSync(path.join(this.home, "cron-history", "_index.jsonl"), `${JSON.stringify(row)}\n`);
    if (this.creditsWhenCancelled !== null) this.#writeUsage(run.job.id, this.creditsWhenCancelled);
    return 200;
  };

  get run(): CommandRunner {
    return async (command, givenArgs, options) => {
      // In "overnight" mode kirocrew is wrapped: sandbox-exec -f <profile> -D ... <kirocrew> <args>.
      const at = givenArgs.indexOf(this.binary);
      const wrapped = command.endsWith("sandbox-exec") && at !== -1;
      const args = wrapped ? givenArgs.slice(at + 1) : givenArgs;
      const call = { command: wrapped ? this.binary : command, args, options };
      this.calls.push(call);
      this.wrappers.push(wrapped ? givenArgs.slice(0, at) : null);
      await this.onCommand(call);
      const [group, action, ...rest] = args;
      if (group !== "cron") return reply("", { exitCode: 2, stderr: "usage" });
      if (action === "add") return this.#add(rest);
      if (action === "trigger") return this.#trigger(rest[0] ?? "");
      if (action === "remove") return this.#remove(rest[0] ?? "");
      return reply("Usage: kirocrew cron {list|add|update|remove|pause|resume|trigger|preview}");
    };
  }

  /** The fake sleep: move the clock, then let running jobs end if their time has come. */
  sleep = async (ms: number): Promise<void> => {
    this.#clock.advance(ms);
    this.tick();
  };

  tick(): void {
    for (const run of [...this.#running]) {
      if (!run.markerWritten && this.#clock.ms() >= run.startedMs) this.#writeMarker(run);
      if (this.#clock.ms() < run.endsAtMs) continue;
      this.#running.splice(this.#running.indexOf(run), 1);
      this.onJobEnd(run.job);
      rmSync(run.marker, { force: true });
      if (this.writeHistory) {
        const row = { run_id: "e1b21a2415cf", job_id: run.job.id, trigger: "manual", started_at: run.startedMs / 1000, finished_at: this.#clock.ms() / 1000, duration_ms: this.#clock.ms() - run.startedMs, status: this.historyStatus, summary: "made-up summary", error: "" };
        appendFileSync(path.join(this.home, "cron-history", "_index.jsonl"), `${JSON.stringify(row)}\n`);
      }
      if (this.credits !== null) this.#writeUsage(run.job.id, this.credits);
    }
  }

  /** One row in Crew's usage file for the day on the test clock, as Crew writes them. */
  #writeUsage(jobId: string, credits: number): void {
    const day = new Date(this.#clock.ms()).toISOString().slice(0, 10);
    mkdirSync(path.join(this.home, "usage", "tokens"), { recursive: true });
    appendFileSync(path.join(this.home, "usage", "tokens", `${day}.jsonl`), `${JSON.stringify({ _type: "tokens", slot: `cron:${jobId}:1b0dad96`, model: "", credits })}\n`);
  }

  isRunning(id: string): boolean {
    return this.#running.some((run) => run.job.id === id);
  }

  commands(): string[] {
    return this.calls.map((call) => call.args.slice(0, 2).join(" "));
  }

  #saveStore(): void {
    const jobs = this.jobs.filter((job) => !job.removed).map((job) => ({ id: job.id, name: job.name, message: job.message, enabled: true }));
    writeFileSync(path.join(this.home, "crons.json"), JSON.stringify({ version: 2, jobs }));
  }

  #add(rest: string[]): CommandResult {
    const scripted = this.addReplies.shift();
    if (scripted) return scripted;
    const [name = "", message = "", ...flags] = rest;
    const job: FakeCrewJob = { id: (this.#nextId++).toString(16), name, message, flags, removed: false };
    this.jobs.push(job);
    this.#saveStore();
    return reply(`Added job: ${job.id} (${name}) [At 3:00 AM MDT]\n`);
  }

  #trigger(id: string): CommandResult {
    const scripted = this.triggerReplies.shift();
    if (scripted) return scripted;
    const job = this.jobs.find((candidate) => candidate.id === id && !candidate.removed);
    if (!job) return reply(`Job not found: ${id}\n`);
    const startedMs = this.#clock.ms() + this.startDelayMs;
    const marker = path.join(this.home, "cron-running", `${id}.b717fc944da04eb7b8b5429b10c7e51d.json`);
    const run = { job, marker, markerWritten: false, startedMs, endsAtMs: startedMs + this.runForMs };
    this.#running.push(run);
    if (this.startDelayMs === 0) this.#writeMarker(run);
    return reply(`Triggered job: ${job.name} (${id})\n`);
  }

  #writeMarker(run: { job: FakeCrewJob; marker: string; markerWritten: boolean; startedMs: number }): void {
    writeFileSync(run.marker, JSON.stringify({ job_id: run.job.id, name: run.job.name, started_at: run.startedMs / 1000, pid: 97461 }));
    run.markerWritten = true;
  }

  #remove(id: string): CommandResult {
    const job = this.jobs.find((candidate) => candidate.id === id && !candidate.removed);
    if (!job) return reply(`Job not found: ${id}\n`);
    job.removed = true;
    this.#saveStore();
    return reply(`Removed job: ${id}\n`);
  }
}

/** The value after a flag in a job's flags, or undefined. */
export function flagValue(flags: string[], flag: string): string | undefined {
  const at = flags.indexOf(flag);
  return at === -1 ? undefined : flags[at + 1];
}
