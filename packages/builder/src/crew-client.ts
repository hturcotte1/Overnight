// Talking to Kiro Crew: add a job, start it, watch it, cancel it, remove it. Used for builds and
// for the sandbox probe. Everything here follows what the Milestone 2 experiments measured, not
// Crew's documentation:
//   - `kirocrew cron add` prints "Added job: <id> (...)" or exits 1 with "Error: ..." on stderr.
//   - `kirocrew cron trigger <id>` exits 0 even when it fails, so only the text "Triggered job:"
//     counts. A job whose own schedule is due answers "Error: HTTP 409", which is why our jobs get
//     a schedule that is practically never due and are always started by hand.
//   - Crew's own "success" only means a session ended. Whether a job is running, and when it has
//     finished, is read from Crew's files: <crew home>/cron-running/<id>.<run>.json exists while
//     it runs, and <crew home>/cron-history/_index.jsonl gets a row when it ends.
//   - `kirocrew cron remove <id>` takes a job off Crew's list but does NOT end a run that is in
//     progress: a "sleep" job removed while running slept on, and its running marker stayed.
//     kirocrew has no command that ends a run. The gateway has a local web address that does
//     (POST /api/crons/<id>/cancel, with the gateway's own local secret in a header): the run's
//     processes were gone within a second and its history row says "cancelled". It only works
//     while the job is still on the list, so a run is cancelled FIRST and the job removed after.
//
// Crew's files are another program's, and a job inside the gateway can write them. They are read
// with safe-read.ts (never a link, never a pipe, never more than a fixed size) and every line is
// checked against a schema.
//
// Nothing Crew prints is ever logged or returned: replies are matched against fixed patterns and
// turned into our own sentences.
import { existsSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "@overnight/core";
import type { CommandRunner, RunOptions } from "./run.ts";
import { readSmallText } from "./safe-read.ts";

/** 3:00 a.m. on January 1st: a schedule Crew accepts and that is practically never due. */
export const NEVER_DUE_CRON = "0 3 1 1 *";
/** kirocrew is a Python program: a few seconds to start is normal (0.6 s measured). */
export const CREW_COMMAND_TIMEOUT_MS = 60_000;
/**
 * When Overnight is being stopped: how long a `cron add` or `cron trigger` that is already under
 * way is left to finish (killing an add half-way can leave a job nobody knows the id of), and
 * how long the clean-up may take. Together they stay under the 10 seconds a stop may take.
 */
export const STOP_GRACE_MS = 2_000;
export const CANCEL_TIMEOUT_MS = 1_500;
export const STOP_REMOVE_TIMEOUT_MS = 3_500;
/** The port Kiro Crew's gateway listens on unless KIROCREW_PORT says otherwise. */
export const DEFAULT_GATEWAY_PORT = 5476;
/** How long the gateway gets to answer "are you there?" (it answers in a few milliseconds). */
export const GATEWAY_CHECK_TIMEOUT_MS = 5_000;
/** A run's marker is gone but no history row has appeared: how long to wait for the row. */
export const HISTORY_GRACE_MS = 30_000;
export const BUILD_JOB_PREFIX = "overnight-build-";
export const PROBE_JOB_NAME = "overnight-sandbox-probe";

export const GATEWAY_NOT_RUNNING = "the Kiro Crew gateway is not running";
export const JOB_ALREADY_DUE = "Kiro Crew said the job was already due to run (HTTP 409)";

export function defaultKirocrewBinary(): string {
  return path.join(homedir(), ".local", "bin", "kirocrew");
}

export function defaultCrewHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KIROCREW_HOME?.trim() ?? "";
  return fromEnv !== "" && path.isAbsolute(fromEnv) ? fromEnv : path.join(homedir(), ".kiro", "crew");
}

/** Kiro's own folder (settings, saved sessions, agent files): the KIRO_HOME variable, or ~/.kiro. */
export function defaultKiroHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KIRO_HOME?.trim() ?? "";
  return fromEnv !== "" && path.isAbsolute(fromEnv) ? fromEnv : path.join(homedir(), ".kiro");
}

/** Crew's own rule for a time zone name. Anything else falls back to the default. */
export function crewTimeZone(wanted: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [wanted, env.TZ]) {
    const zone = candidate?.trim() ?? "";
    if (zone !== "" && zone.length <= 50 && /^[A-Za-z0-9_/+-]+$/.test(zone)) return zone;
  }
  return "America/Boise";
}

export type AddResult = { ok: true; id: string } | { ok: false; reason: string };
export type TriggerResult = { ok: true; triggeredAtMs: number } | { ok: false; reason: string };
export type CrewRunStatus = "success" | "failure" | "timeout" | "cancelled" | "unknown";
export type WaitResult = { finished: true; status: CrewRunStatus } | { finished: false; stopped: boolean };

/** How the kirocrew program is wrapped when the gateway runs inside Overnight's own sandbox. */
export interface CrewCommandSandbox {
  /** Full path of sandbox-exec. */
  exec: string;
  /** Full real path of the profile (sandbox/crew-gateway.sb). */
  profile: string;
  /**
   * The profile's values as sandbox-exec arguments: "-D", "NAME=<full real path>", once for each
   * name the profile asks for (see sandbox-values.ts). The gateway's background job is started
   * with the same names and the same paths.
   */
  defines: string[];
}

export interface CrewClient {
  readonly crewHome: string;
  /** `flags` are the options after the name and the message. */
  addJob(name: string, message: string, flags: string[], signal?: AbortSignal): Promise<AddResult>;
  trigger(id: string, signal?: AbortSignal): Promise<TriggerResult>;
  /**
   * Watch Crew's files until the run that began at `triggeredAtMs` is over, `deadlineMs` passes,
   * or `signal` is aborted (the answer is then `stopped: true`, at once).
   */
  waitUntilFinished(id: string, triggeredAtMs: number, deadlineMs: number, signal?: AbortSignal): Promise<WaitResult>;
  /**
   * End a run that is in progress. Best effort and quick: true only when the gateway said it
   * cancelled the run. Must be called before remove(): the gateway cancels listed jobs only.
   */
  cancel(id: string): Promise<boolean>;
  /**
   * True when Crew said the job was removed. Clean-up: it runs even while Overnight is being
   * stopped. `quick` (used then) gives it a few seconds instead of a minute, and so does a stop
   * (`signal`, or a stop signal to this process) that comes while it is running.
   */
  remove(id: string, options?: { quick?: boolean; signal?: AbortSignal }): Promise<boolean>;
  /**
   * Remove our own jobs left behind by a run that was killed. Skips any that is running. Best
   * effort. When Crew's list holds a job Overnight did not add, that is logged as an error and
   * nothing at all is removed: something else has been adding jobs, and a person should look.
   */
  removeLeftovers(signal?: AbortSignal): Promise<number>;
  /** Kiro credits Crew recorded for a job's runs, or undefined if it recorded none. Best effort. */
  creditsFor(id: string, around: Date[]): number | undefined;
}

export interface CrewClientOptions {
  binary: string;
  crewHome: string;
  /** True when the caller named the Crew home itself; kirocrew is then pointed at it too. */
  crewHomeIsExplicit: boolean;
  run: CommandRunner;
  logger: Logger;
  now: () => Date;
  /** Waits between looks at Crew's files. The real one ends early when `signal` is aborted. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs: number;
  /**
   * The temporary folder kirocrew is given (as TMPDIR) and started in: the build jobs' own,
   * <data>/tmp/build. The sandbox lets a job read and write no other temporary folder.
   */
  tmpDir: string;
  /** Set when the gateway runs inside our sandbox: every kirocrew command of ours then runs inside it too. */
  sandbox?: CrewCommandSandbox;
  /** Sends the cancel request. Default: the real one, over the loopback address. Tests pass a stand-in. */
  postCancel?: (request: CancelRequest) => Promise<number | null>;
}

export interface CancelRequest {
  port: number;
  jobId: string;
  secret: string;
  timeoutMs: number;
}

const JOB_ID = /^[a-f0-9]{6,12}$/;
const storeSchema = z.object({ jobs: z.array(z.object({ id: z.string(), name: z.string() })) });
const historyRowSchema = z.object({ job_id: z.string(), started_at: z.number(), status: z.string().optional() });
const usageRowSchema = z.object({ slot: z.string(), credits: z.number() });
/** Crew's history index holds at most 2,000 short rows (under 1 MB). Anything larger is not read. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** The gateway's local secret is 32 characters. */
const MAX_SECRET_BYTES = 512;
const SECRET = /^[A-Za-z0-9_+/=.-]{8,256}$/;

/** A sleep that ends early when `signal` is aborted. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The port our kirocrew commands talk to: KIROCREW_PORT when it is a port number, otherwise Crew's default. */
export function gatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KIROCREW_PORT?.trim() ?? "";
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : DEFAULT_GATEWAY_PORT;
  return port >= 1 && port <= 65_535 ? port : DEFAULT_GATEWAY_PORT;
}

/**
 * Ask the gateway on this Mac to cancel a run. Answers the HTTP status, or null when there was no
 * answer. Only ever the loopback address; the reply's text is not read.
 */
async function postCancelRequest(request: CancelRequest): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${request.port}/api/crons/${request.jobId}/cancel`, {
      method: "POST",
      headers: { "X-Internal-Secret": request.secret },
      body: "",
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Is a Kiro Crew gateway answering on this Mac? Asked of the gateway's own "health" address over
 * the loopback address, with a short time limit. The reply's text is not read. Never throws.
 */
export async function gatewayAnswers(port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const limit = AbortSignal.timeout(GATEWAY_CHECK_TIMEOUT_MS);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: "error", signal: signal === undefined ? limit : AbortSignal.any([limit, signal]) });
    await response.body?.cancel().catch(() => {});
    return response.status === 200;
  } catch {
    return false;
  }
}

/** kirocrew gets a small environment of its own, plus the variables that say which Crew instance to talk to. */
function crewEnv(options: CrewClientOptions): Record<string, string> {
  const user = userInfo().username;
  const env: Record<string, string> = {
    HOME: homedir(),
    USER: user,
    LOGNAME: user,
    // macOS's own programs first: nothing in a user-writable folder can stand in for one of them.
    PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin", path.dirname(options.binary), "/usr/local/bin"].join(":"),
    TMPDIR: options.tmpDir,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };
  for (const key of ["KIROCREW_HOME", "KIROCREW_PORT", "KIRO_HOME", "KIROCREW_WORKSPACE"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  if (options.crewHomeIsExplicit) env.KIROCREW_HOME = options.crewHome;
  return env;
}

/** One of Crew's record files, or null when it is missing, too large, or not a plain file. */
function readRecord(file: string): string | null {
  return readSmallText(file, MAX_RECORD_BYTES);
}

/** Each line that parses and fits the schema. Bad lines are skipped: these are another program's files. */
function jsonLines<T>(text: string | null, schema: z.ZodType<T>): T[] {
  if (text === null) return [];
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // not JSON
    }
  }
  return rows;
}

function knownStatus(status: string | undefined): CrewRunStatus {
  return status === "success" || status === "failure" || status === "timeout" || status === "cancelled" ? status : "unknown";
}

/** "2026-10-10" both as this Mac's clock says it and in UTC: Crew names its usage files by local date. */
function dateKeys(at: Date): string[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, at.toISOString().slice(0, 10)];
}

export function createCrewClient(options: CrewClientOptions): CrewClient {
  const { binary, crewHome, run, logger, now, sleep, pollMs, sandbox } = options;
  const postCancel = options.postCancel ?? postCancelRequest;

  /** Run kirocrew. In "overnight" mode it runs inside the same sandbox as the gateway it talks to. */
  const kirocrew = (args: string[], extra: Pick<RunOptions, "signal" | "stopGraceMs" | "cleanup"> & { timeoutMs?: number } = {}) => {
    // Started in the build jobs' temporary folder, never in whatever folder Overnight itself was
    // started in: kirocrew asks for its working folder as soon as it starts and stops with an
    // error when it may not look at it, and inside the sandbox this repo (where the nightly job
    // starts) is closed. (Measured: "PermissionError: Operation not permitted" from os.getcwd().)
    const runOptions: RunOptions = { cwd: options.tmpDir, env: crewEnv(options), timeoutMs: CREW_COMMAND_TIMEOUT_MS, ...extra };
    if (sandbox === undefined) return run(binary, args, runOptions);
    const wrapped = ["-f", sandbox.profile, ...sandbox.defines, binary, ...args];
    return run(sandbox.exec, wrapped, runOptions);
  };

  /** The gateway's local secret, for the cancel request only. Never logged, never returned. */
  function localSecret(port: number): string | null {
    // The first two are the gateway's own record for the port it listens on; the last is the older, home-wide one.
    for (const file of [path.join(crewHome, "run", `gateway-${port}-127.0.0.1.secret`), path.join(crewHome, "run", `gateway-${port}.secret`), path.join(crewHome, ".local_secret")]) {
      const text = readSmallText(file, MAX_SECRET_BYTES)?.trim() ?? "";
      if (SECRET.test(text)) return text;
    }
    return null;
  }

  function isRunning(id: string): boolean {
    try {
      return readdirSync(path.join(crewHome, "cron-running")).some((name) => name.startsWith(`${id}.`) && name.endsWith(".json"));
    } catch {
      return false;
    }
  }

  function historyRow(id: string, triggeredAtMs: number): { status: CrewRunStatus } | null {
    const rows = jsonLines(readRecord(path.join(crewHome, "cron-history", "_index.jsonl")), historyRowSchema);
    // Crew stamps a run in seconds, a moment after our trigger call began. One second of slack for rounding.
    const row = rows.findLast((candidate) => candidate.job_id === id && candidate.started_at * 1000 >= triggeredAtMs - 1000);
    return row ? { status: knownStatus(row.status) } : null;
  }

  async function cancel(id: string): Promise<boolean> {
    if (!JOB_ID.test(id)) return false;
    const port = gatewayPort();
    const secret = localSecret(port);
    if (secret === null) {
      logger.warn("could not ask kiro crew to cancel a run: its local secret was not found", { jobId: id });
      return false;
    }
    const status = await postCancel({ port, jobId: id, secret, timeoutMs: CANCEL_TIMEOUT_MS });
    // 200: cancelled. 409: the job was not running (nothing to cancel). Anything else is logged.
    if (status === 200) logger.info("kiro crew run cancelled", { jobId: id });
    else if (status !== 409) logger.warn("kiro crew did not cancel a run", { jobId: id, httpStatus: status });
    return status === 200;
  }

  async function remove(id: string, removeOptions: { quick?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    if (!JOB_ID.test(id)) return false;
    const quick = removeOptions.quick === true || removeOptions.signal?.aborted === true;
    // Clean-up: it runs although Overnight may be stopping, and then it has to be quick, whether
    // the stop came before it started or comes while it runs.
    const result = await kirocrew(["cron", "remove", id], {
      cleanup: true,
      timeoutMs: quick ? STOP_REMOVE_TIMEOUT_MS : CREW_COMMAND_TIMEOUT_MS,
      stopGraceMs: STOP_REMOVE_TIMEOUT_MS,
      ...(removeOptions.signal === undefined ? {} : { signal: removeOptions.signal }),
    });
    const removed = result.stdout.includes("Removed job");
    if (!removed) logger.warn("kiro crew did not confirm that a job was removed", { jobId: id, timedOut: result.timedOut });
    return removed;
  }

  return {
    crewHome,

    async addJob(name, message, flags, signal) {
      // Left a moment to finish when Overnight is stopped: its reply is the only place the new job's id is.
      const result = await kirocrew(["cron", "add", name, message, ...flags], { ...(signal === undefined ? {} : { signal }), stopGraceMs: STOP_GRACE_MS });
      // The id first: a job that was added must be removed later, however the command ended.
      const id = /Added job:\s*([a-f0-9]{6,12})\b/.exec(result.stdout)?.[1];
      if (id !== undefined) return { ok: true, id };
      if (result.error !== undefined) return { ok: false, reason: "kirocrew could not be started" };
      if (result.timedOut) return { ok: false, reason: "kirocrew did not answer in time" };
      return { ok: false, reason: "Kiro Crew did not accept the job" };
    },

    async trigger(id, signal) {
      // Taken before the call: Crew's own start time and every file the job writes come after it.
      const triggeredAtMs = now().getTime();
      const result = await kirocrew(["cron", "trigger", id], { ...(signal === undefined ? {} : { signal }), stopGraceMs: STOP_GRACE_MS });
      if (result.stdout.includes("Triggered job:")) return { ok: true, triggeredAtMs };
      const said = `${result.stdout}\n${result.stderr}`;
      if (/cannot reach gateway/i.test(said)) return { ok: false, reason: GATEWAY_NOT_RUNNING };
      if (/HTTP 409/.test(said)) return { ok: false, reason: JOB_ALREADY_DUE };
      if (result.timedOut) return { ok: false, reason: "kirocrew did not answer in time" };
      return { ok: false, reason: "Kiro Crew did not start the job" };
    },

    async waitUntilFinished(id, triggeredAtMs, deadlineMs, signal) {
      let sawRunning = false;
      let goneSinceMs: number | null = null;
      for (;;) {
        if (isRunning(id)) {
          sawRunning = true;
          goneSinceMs = null;
        } else {
          const row = historyRow(id, triggeredAtMs);
          if (row) return { finished: true, status: row.status };
          // Crew's history is best effort (its own words). A run we watched start and stop is
          // over even if the row never comes.
          if (sawRunning) {
            goneSinceMs ??= now().getTime();
            if (now().getTime() - goneSinceMs >= HISTORY_GRACE_MS) return { finished: true, status: "unknown" };
          }
        }
        if (signal?.aborted === true) return { finished: false, stopped: true };
        const left = deadlineMs - now().getTime();
        if (left <= 0) return { finished: false, stopped: false };
        await sleep(Math.min(pollMs, left), signal);
      }
    },

    cancel,
    remove,

    async removeLeftovers(signal) {
      const text = readRecord(path.join(crewHome, "crons.json"));
      if (text === null) return 0;
      let jobs: Array<{ id: string; name: string }>;
      try {
        const parsed = storeSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return 0;
        jobs = parsed.data.jobs;
      } catch {
        return 0;
      }
      const isOurs = (job: { name: string }): boolean => job.name.startsWith(BUILD_JOB_PREFIX) || job.name === PROBE_JOB_NAME;
      // A job on the list that Overnight did not add: a job inside the gateway can add jobs of its
      // own (it can reach the gateway like we do), and one that runs on a schedule would outlive
      // the night. We do not know what it is, so it is not ours to remove, and neither is anything
      // else until a person has looked. Only the count is logged: the name is somebody else's text.
      const strangers = jobs.filter((job) => !isOurs(job)).length;
      if (strangers > 0) {
        logger.error("kiro crew's job list holds a job that Overnight did not add: nothing was removed (look at it with: kirocrew cron list)", { jobsNotOurs: strangers, jobsOurs: jobs.length - strangers });
        return 0;
      }
      let removed = 0;
      for (const job of jobs) {
        if (!JOB_ID.test(job.id) || isRunning(job.id)) continue;
        // Told to stop: the rest can wait for the next run.
        if (signal?.aborted === true) break;
        if (await remove(job.id, signal === undefined ? {} : { signal })) removed += 1;
      }
      if (removed > 0) logger.info("removed kiro crew jobs left behind by an earlier run", { removed });
      return removed;
    },

    creditsFor(id, around) {
      const files = new Set(around.flatMap(dateKeys));
      let total = 0;
      let found = false;
      for (const day of files) {
        const file = path.join(crewHome, "usage", "tokens", `${day}.jsonl`);
        if (!existsSync(file)) continue;
        for (const row of jsonLines(readRecord(file), usageRowSchema)) {
          if (!row.slot.startsWith(`cron:${id}:`) || !Number.isFinite(row.credits)) continue;
          total += row.credits;
          found = true;
        }
      }
      return found ? Math.round(total * 1000) / 1000 : undefined;
    },
  };
}
