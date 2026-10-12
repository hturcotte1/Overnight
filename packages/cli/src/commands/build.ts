// `overnight build`: tonight's builds. The background job wakes every minute and runs this, with
// `--if-due`, once Overnight's own clock says it is BUILD_TIME (night-tick.ts).
// Only wiring lives here: the brief, the workspaces, the two builders and every idea state change
// are in @overnight/builder. This file takes the build lock, picks which builder goes first,
// hands over, and prints one line about how the night went.
import { errorSummary } from "@overnight/core";
import type { Config, DataPaths, Logger, Store } from "@overnight/core";
import { DeadlinePassed, MINUTE_MS, withDeadline } from "../deadline.ts";
import { watchLastResort } from "../last-resort.ts";
import type { WatchLastResort } from "../last-resort.ts";
import { oneLine, plural } from "../output.ts";
import type { Write } from "../output.ts";
import { buildLockFile } from "../single-instance.ts";
import type { ReleaseLock } from "../single-instance.ts";
import { SLEPT_LINE, watchForSleep } from "../sleep-watch.ts";
import type { WatchForSleep } from "../sleep-watch.ts";
import { STOP_OVERDUE, STOP_SIGNAL_LINE, stopWaitText, watchStopSignals } from "../stop-signals.ts";
import type { WatchStopSignals } from "../stop-signals.ts";
import type { NightRunMarks } from "./night-tick.ts";

type MaybePromise<T> = T | Promise<T>;

/** What a night of building comes back with. The lists hold idea ids. */
export interface BuildNightResult {
  built: string[];
  failed: string[];
  /** Why the night was skipped or cut short, in the builder's plain words. Empty when it was not. */
  skipped?: string | null;
}

/** What one build comes back with. */
export interface BuildOutcome {
  ok: boolean;
  /** Which builder made it: "kiro-crew" or "kiro-cli". */
  backend?: string;
  ms?: number;
  /** Why it failed, in plain words. No transcript text. */
  reason?: string;
  couldNotStart?: boolean;
}

/** What the builder is handed for a night, or for one build. */
export interface BuildRunDeps<Backend> {
  store: Store;
  config: Config;
  paths: DataPaths;
  backends: { primary: Backend; fallback: Backend };
  logger: Logger;
  /**
   * Aborted when this command is told to stop (a stop signal, see stop-signals.ts). The builder
   * then starts nothing new, stops what it started, records a cut-off build as interrupted, and
   * comes back within 10 seconds.
   */
  signal?: AbortSignal;
  /** Makes Kiro's hourly sign-in fresh before each try on a builder (see createKiroSignInRenewal). */
  renewSignIn?: RenewSignIn;
}

/** What the sign-in step answers: signed in (and for how much longer, when known), or signed out. */
export type SignInAnswer = { ok: true; leftMs: number | null; waitedMs: number } | { ok: false; reason: string };
export type RenewSignIn = (signal?: AbortSignal) => Promise<SignInAnswer>;

/**
 * The parts of @overnight/builder this command line uses, under the names that package gives
 * them. wiring.ts passes the real ones; tests pass fakes. A backend is opaque here: it is made by
 * one of the two create functions and handed straight back to the builder.
 */
export interface BuildFactories<Backend = unknown> {
  createKiroCrewBackend(options: { paths: DataPaths; logger: Logger; sandboxMode: Config["buildSandbox"] }): Backend;
  createKiroCliBackend(options: { paths: DataPaths; logger: Logger }): Backend;
  runBuildNight(deps: BuildRunDeps<Backend>): MaybePromise<BuildNightResult>;
  buildOne(ideaId: string, deps: BuildRunDeps<Backend>): MaybePromise<BuildOutcome>;
  /**
   * The step that renews Kiro's sign-in outside the sandbox before each build. Optional: tests
   * with stand-in builders leave it out, and then no Kiro program is started.
   */
  createKiroSignInRenewal?(options: { logger: Logger }): RenewSignIn;
}

/** The sign-in step for one run, or nothing when the factories offer none. */
export function signInStep<Backend>(factories: BuildFactories<Backend>, logger: Logger): { renewSignIn?: RenewSignIn } {
  return factories.createKiroSignInRenewal === undefined ? {} : { renewSignIn: factories.createKiroSignInRenewal({ logger }) };
}

export interface BuildDeps<Backend = unknown> {
  store: Store;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  /** Loads @overnight/builder. Called once the build lock is held, also while paused (see `build`). */
  loadFactories: () => Promise<BuildFactories<Backend>>;
  /** Take a one-at-a-time lock: how to release it, or null if another process holds it. */
  takeLock: (file: string) => ReleaseLock | null;
  write: Write;
  writeError: Write;
  /** Watches for stop signals while the night runs. Default: the real one (stop-signals.ts). */
  watchStopSignals?: WatchStopSignals;
  /** Watches for an error nobody caught while the night runs. Default: the real one (last-resort.ts). */
  watchLastResort?: WatchLastResort;
  /** Watches for the Mac having slept while the night runs. Default: the real one (sleep-watch.ts). */
  watchForSleep?: WatchForSleep;
  /**
   * Given by `--if-due`: the night clock's marks for this run. `started` is called just before
   * any work begins, `ended` when it is over. Left out, this command means "now" and the clock
   * is neither read nor written.
   */
  onRun?: NightRunMarks;
  /** Holds the Mac awake while the night runs, also on battery. Left out, nothing holds it. */
  keepAwake?: KeepAwakeHold;
  /** For tests: the last-resort time limit, in milliseconds. */
  limitMs?: number;
}

/** Starts a hold on the Mac's sleep and says how to let go of it (core's startKeepAwake, in its "always" mode). */
export type KeepAwakeHold = (logger: Logger) => { stop(): void };

/** Run one tidy-up step. A step that throws must not stop the ones after it. */
export function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Whatever it held is dropped when the process ends.
  }
}

export const BUILD_ALREADY_RUNNING = "another overnight build is already running on this data folder; not starting a second one";
export const BUILD_PAUSED_LINE = "Overnight is paused: nothing was built. Approved ideas wait until: npx overnight resume";
/** What the builder answers in `skipped` when it built nothing, or stopped building, because Overnight is paused. A test pins it to the builder's own SKIPPED_PAUSED. */
export const BUILD_SKIPPED_PAUSED = "paused";

const OTHER_BACKEND = { "kiro-crew": "kiro-cli", "kiro-cli": "kiro-crew" } as const;

export interface ChosenBackends<Backend> {
  primaryName: Config["buildBackend"];
  fallbackName: Config["buildBackend"];
  backends: { primary: Backend; fallback: Backend };
}

/**
 * Make both builders and put them in order: the one BUILD_BACKEND names goes first, the other is
 * the fallback. Only the Kiro Crew builder is told the sandbox mode (the BUILD_SANDBOX setting,
 * from the settings and nowhere else): it is the one that must run the nightly probe when the
 * gateway sits inside Overnight's own sandbox.
 */
export function chooseBackends<Backend>(
  factories: BuildFactories<Backend>,
  deps: { config: Pick<Config, "buildBackend" | "buildSandbox">; paths: DataPaths; logger: Logger },
): ChosenBackends<Backend> {
  const made = {
    "kiro-crew": factories.createKiroCrewBackend({ paths: deps.paths, logger: deps.logger, sandboxMode: deps.config.buildSandbox }),
    "kiro-cli": factories.createKiroCliBackend({ paths: deps.paths, logger: deps.logger }),
  };
  const primaryName = deps.config.buildBackend;
  const fallbackName = OTHER_BACKEND[primaryName];
  return { primaryName, fallbackName, backends: { primary: made[primaryName], fallback: made[fallbackName] } };
}

/** What one try on one builder may take before this command line stops believing in it: its full BUILD_TIMEOUT_MIN, and 15 minutes for the builder's own winding down. */
export function oneTryLimitMs(config: Pick<Config, "buildTimeoutMin">): number {
  return (config.buildTimeoutMin + 15) * MINUTE_MS;
}

/**
 * The last-resort limit for a whole night: every build tried on both builders, each to its full
 * time, and half an hour on top. With the defaults that is four and a half hours: a night that
 * starts at 01:00 is over, one way or the other, before the morning's deliver at 06:30.
 */
export function buildNightLimitMs(config: Pick<Config, "maxBuildsPerNight" | "buildTimeoutMin">): number {
  return Math.max(1, config.maxBuildsPerNight) * 2 * oneTryLimitMs(config) + 30 * MINUTE_MS;
}

/** "1 built (idea_a), 1 failed (idea_b)". Ids only: titles come from speech and stay out of logs. */
function counts(result: BuildNightResult): string {
  const part = (ids: string[], word: string) => (ids.length === 0 ? `0 ${word}` : `${ids.length} ${word} (${ids.map(oneLine).join(", ")})`);
  return `${part(result.built, "built")}, ${part(result.failed, "failed")}`;
}

/**
 * The one line `overnight build` prints: the counts, then the builder's own words for why
 * nothing, or not everything, was built ("nothing approved", "1 approved idea waits for another
 * night (limit 2 a night)"), when it gave any.
 */
export function buildSummary(result: BuildNightResult): string {
  const skipped = oneLine(result.skipped ?? "");
  return `Tonight's build: ${counts(result)}${skipped === "" ? "" : `; ${skipped}`}.`;
}

/**
 * What `overnight build` prints about a night. Usually the one summary line. While paused, the
 * paused line instead, and then only what did happen all the same: a build found cut off from an
 * earlier run is recorded as failed even during a pause, and a night that was paused part-way
 * may already have built something.
 */
export function buildNightLines(result: BuildNightResult): string[] {
  if (oneLine(result.skipped ?? "") !== BUILD_SKIPPED_PAUSED) return [buildSummary(result)];
  if (result.built.length === 0 && result.failed.length === 0) return [BUILD_PAUSED_LINE];
  if (result.built.length === 0) {
    return [BUILD_PAUSED_LINE, `${plural(result.failed.length, "build")} cut off in an earlier run ${result.failed.length === 1 ? "is" : "are"} now recorded as failed (${result.failed.map(oneLine).join(", ")}).`];
  }
  return [buildSummary(result), "Overnight was paused during the night: the rest waits until: npx overnight resume"];
}

/**
 * Resolves with the exit code. 0 whenever the command ran, even if a build failed: the failure is
 * recorded on the idea, and the morning tells the wearer. 1 only when the command itself could
 * not run (another build has the lock, the builder would not load, or it ran past every limit).
 * 130, 143 or 129 when it was stopped by a signal (see stop-signals.ts).
 *
 * There is no pause check here, on purpose. The builder is always called: it starts no build
 * while paused, but it first records a build that was cut off (a crash, a restart) as failed, so
 * that one is never left "building" for as long as a pause lasts. It says "paused" in `skipped`.
 */
export async function build<Backend>(deps: BuildDeps<Backend>): Promise<number> {
  const { store, config, paths, logger } = deps;

  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(buildLockFile(paths));
  } catch (error) {
    logger.error("overnight build could not start: its lock file could not be used", { reason: errorSummary(error), dataDir: paths.root });
    deps.writeError(`Overnight could not use its build lock. ${errorSummary(error)}`);
    return 1;
  }
  if (release === null) {
    logger.error(BUILD_ALREADY_RUNNING, { dataDir: paths.root });
    deps.writeError(`Not started: ${BUILD_ALREADY_RUNNING}.`);
    return 1;
  }

  const stop = (deps.watchStopSignals ?? watchStopSignals)({ onStop: (signal) => logger.warn(`overnight build: ${STOP_SIGNAL_LINE}`, { signal }) });
  // The Mac slept through part of the night: every time limit is long past for no good reason.
  // The builder is told to stop, as by a stop signal, and what it was building gets another try.
  let slept = false;
  const sleepWatch = (deps.watchForSleep ?? watchForSleep)({
    onSleep: (gapMs) => {
      slept = true;
      logger.warn(SLEPT_LINE, { gapSeconds: Math.round(gapMs / 1000) });
      stop.stopWork();
    },
  });
  // An error nobody caught: one log line, the builder is told to stop, the lock goes, exit 1.
  const lastResort = (deps.watchLastResort ?? watchLastResort)({ command: "overnight build", logger, letGo: [() => stop.abort(), release], writeError: deps.writeError });
  let started = false;
  // Only a night that ended by itself is "finished". Stopped, slept through, overdue or failed, it was cut short.
  let how: "finished" | "cut-short" = "cut-short";
  let hold: { stop(): void } | null = null;
  try {
    const factories = await deps.loadFactories();
    // Told to stop while the builder was loading, or the Mac slept meanwhile: start nothing.
    if (stop.signal.aborted) return stop.exitCode() ?? 0;
    const chosen = chooseBackends(factories, { config, paths, logger });
    // The night clock writes the start down before any work begins. If it cannot, nothing begins.
    deps.onRun?.started();
    started = true;
    hold = deps.keepAwake?.(logger) ?? null;
    logger.info("overnight build starting", { primary: chosen.primaryName, fallback: chosen.fallbackName, sandboxMode: config.buildSandbox, dataDir: paths.root });
    const night = withDeadline(factories.runBuildNight({ store, config, paths, backends: chosen.backends, logger, signal: stop.signal, ...signInStep(factories, logger) }), deps.limitMs ?? buildNightLimitMs(config), "The night's build");
    const result = await stop.settle(night);
    if (result === STOP_OVERDUE) {
      logger.error(`overnight build: the builder did not stop in time after ${slept && stop.received() === null ? "the Mac's sleep was noticed" : "the stop signal"}; ending anyway`, { waitedFor: stopWaitText() });
      deps.writeError(`"overnight build" was told to stop, and the builder had not stopped ${stopWaitText()} later. Ending anyway.`);
      return stop.exitCode() ?? 1;
    }
    logger.info("overnight build finished", { built: result.built.length, failed: result.failed.length, skipped: oneLine(result.skipped ?? "").slice(0, 200) || undefined, stoppedBySignal: stop.received() ?? undefined, stoppedBySleep: slept || undefined });
    for (const line of buildNightLines(result)) deps.write(line);
    if (stop.exitCode() === null && !slept) how = "finished";
    // After a sleep the code is still 0: nothing went wrong that a person has to fix.
    return stop.exitCode() ?? 0;
  } catch (error) {
    // Past its last-resort limit: nobody is waiting any more, so tell the builder to stop too.
    if (error instanceof DeadlinePassed) stop.abort();
    logger.error("overnight build stopped on an error", { reason: errorSummary(error) });
    deps.writeError(`"overnight build" could not finish. ${errorSummary(error)}`);
    return stop.exitCode() ?? 1;
  } finally {
    sleepWatch.stop();
    // Before the lock goes: the clock's record is closed while this run still holds it.
    if (started) quietly(() => deps.onRun?.ended(how));
    quietly(() => hold?.stop());
    lastResort.close();
    stop.close();
    release();
  }
}

/** "2 min 22 s", "52 s", "1 h 4 min". For the lines build-now prints. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
