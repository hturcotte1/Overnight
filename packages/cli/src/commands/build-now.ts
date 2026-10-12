// `overnight build-now <ideaId>`: build one approved idea and deliver it, right away.
// For testing and filming (SPEC §8). It is the night and the morning for one idea, run back to
// back by the same code: buildOne from @overnight/builder, then deliverOne from @overnight/deliver.
//
// The rules of the night still hold here:
//   - Never build without approval: only an approved idea (or one whose build failed) is built.
//   - Nothing while paused.
//   - One build at a time and one deliver at a time: the same locks as the nightly jobs.
//   - A stop signal (Ctrl-C, a closed window) stops what is running before the process ends.
//   - So does a Mac that slept through part of the run: what was running is stopped, and the
//     same command carries on from there when it is run again.
import { BUILD_INTERRUPTED_REASON, errorSummary, formatLocal } from "@overnight/core";
import type { Config, DataPaths, Idea, IdeaState, Logger, Store } from "@overnight/core";
import { DeadlinePassed, MINUTE_MS, withDeadline } from "../deadline.ts";
import { watchLastResort } from "../last-resort.ts";
import type { WatchLastResort } from "../last-resort.ts";
import { oneLine } from "../output.ts";
import type { Write } from "../output.ts";
import { buildLockFile, deliverLockFile } from "../single-instance.ts";
import type { ReleaseLock } from "../single-instance.ts";
import { SLEPT_LINE, watchForSleep } from "../sleep-watch.ts";
import type { WatchForSleep } from "../sleep-watch.ts";
import { STOP_OVERDUE, STOP_SIGNAL_LINE, stopWaitText, watchStopSignals } from "../stop-signals.ts";
import type { StopWatch, WatchStopSignals } from "../stop-signals.ts";
import { chooseBackends, formatDuration, oneTryLimitMs, quietly, signInStep } from "./build.ts";
import type { BuildFactories, BuildOutcome, KeepAwakeHold } from "./build.ts";
import { DELIVER_ONE_LIMIT_MS, disposeQuietly } from "./deliver.ts";
import type { DeliverFactories, DeliverOutcome } from "./deliver.ts";

export interface BuildNowDeps<Backend = unknown> {
  store: Store;
  config: Config;
  paths: DataPaths;
  /** Writes to logs/build.log. Kept off the screen: this command prints its own lines. */
  buildLogger: Logger;
  /** Writes to logs/deliver.log. */
  deliverLogger: Logger;
  loadBuildFactories: () => Promise<BuildFactories<Backend>>;
  loadDeliverFactories: () => Promise<DeliverFactories>;
  /** Take a one-at-a-time lock: how to release it, or null if another process holds it. */
  takeLock: (file: string) => ReleaseLock | null;
  write: Write;
  writeError: Write;
  now?: () => Date;
  /** Watches for stop signals while the two steps run. Default: the real one (stop-signals.ts). */
  watchStopSignals?: WatchStopSignals;
  /** Watches for an error nobody caught while the two steps run. Default: the real one (last-resort.ts). */
  watchLastResort?: WatchLastResort;
  /** Watches for the Mac having slept while the two steps run. Default: the real one (sleep-watch.ts). */
  watchForSleep?: WatchForSleep;
  /** Holds the Mac awake for the whole command, also on battery. Left out, nothing holds it (a rehearsal is attended, and passes none). */
  keepAwake?: KeepAwakeHold;
  /** The command's name in its log lines. Default "overnight build-now"; a rehearsal, which runs through this code, passes its own. */
  commandName?: string;
  /** For tests: the last-resort time limits, in milliseconds. */
  buildLimitMs?: number;
  deliverLimitMs?: number;
}

export const BUILD_NOW_NAME = "overnight build-now";
/** The command's name for its log lines. */
const nameOf = (deps: { commandName?: string }): string => deps.commandName ?? BUILD_NOW_NAME;

export const BUILD_NOW_PAUSED = "Overnight is paused, so nothing is built or delivered. Turn it on first with: npx overnight resume";
export const BUILD_NOW_BUILD_BUSY = "A build is already running on this data folder (the nightly build, or another build-now). Try again when it has finished.";
export const BUILD_NOW_DELIVER_BUSY = "A deliver is already running on this data folder, so this command did not publish or deliver. Run the same command again when it has finished.";
/** Printed after the link when the page was pushed but had not been seen live when the wait for it ran out. */
export const BUILD_NOW_NOT_SEEN_LIVE = "The page was not seen live before Overnight stopped waiting for it. It usually appears a few minutes later.";
/**
 * The reason recorded on a build that was found cut off. It is core's own constant, the one the
 * builder records too: core's rule for a second try (build-retry.ts) goes by these exact words.
 */
export const BUILD_CUT_OFF_REASON = BUILD_INTERRUPTED_REASON;

/** What build-now does with an idea in each state. A Record, so a new state cannot be forgotten. */
const PLAN: Record<IdeaState, "build" | "deliver" | "done" | "not-approved" | "building"> = {
  heard: "not-approved",
  asked: "not-approved",
  rejected: "not-approved",
  expired: "not-approved",
  approved: "build",
  // A failed build may be tried again (the state machine allows build_failed → building).
  build_failed: "build",
  building: "building",
  // Already built: go straight to checking, publishing and delivering.
  built: "deliver",
  publish_failed: "deliver",
  published: "deliver",
  delivered: "done",
};

const WHY_NOT: Partial<Record<IdeaState, string>> = {
  heard: "it was heard but never asked about",
  asked: "it is still waiting for an answer on the watch",
  rejected: "it was turned down",
  expired: "nobody answered in time",
};

/** The last-resort limit for one build: both builders tried in turn, each to its full time, and 15 minutes on top. */
function buildOneLimitMs(config: Pick<Config, "buildTimeoutMin">): number {
  return 2 * oneTryLimitMs(config) + 15 * MINUTE_MS;
}

/** When a build that is "building" now counts as cut off: its time limit and 15 minutes after it began. Null if the idea has no usable start time. */
function cutOffAt(idea: Idea, config: Pick<Config, "buildTimeoutMin">): Date | null {
  const since = Date.parse(idea.buildStartedAt ?? idea.updatedAt);
  return Number.isFinite(since) ? new Date(since + oneTryLimitMs(config)) : null;
}

/**
 * An idea left "building" by a build that was cut off (a crash, a closed window, a power cut)
 * would otherwise be refused here for ever, and only a full nightly run frees it. So, as that
 * run does: a build still "building" past its time limit plus 15 minutes is over, whatever
 * happened to it, and is recorded as failed, through the state machine. The retry then goes the
 * ordinary way (build_failed → building).
 *
 * Two things must both hold, and only the idea named is touched:
 *   - No build is running on this data folder right now. The build lock is the proof: every
 *     build holds it, so it is taken for the moment this looks. (A Mac that slept through a
 *     build wakes with an old "building" idea and a build process that is still alive.)
 *   - The build is past that limit. A younger one is left alone even with nobody holding the
 *     lock: its Kiro Crew job may still be working in the idea's folder.
 */
function failIfCutOff<Backend>(idea: Idea, deps: BuildNowDeps<Backend>, now: Date): Idea {
  if (idea.state !== "building") return idea;
  const overAt = cutOffAt(idea, deps.config);
  if (overAt === null || now.getTime() <= overAt.getTime()) return idea;
  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(buildLockFile(deps.paths));
  } catch {
    // The lock cannot be looked at, so nothing is known about a running build. Leave the idea alone.
    return idea;
  }
  if (release === null) return idea;
  try {
    // Read again under the lock: the build that held it a moment ago may just have finished.
    const current = deps.store.getIdea(idea.id);
    if (current === null || current.state !== "building") return current ?? idea;
    const failed = deps.store.transitionIdea(idea.id, "build_failed", { failureReason: BUILD_CUT_OFF_REASON, note: BUILD_CUT_OFF_REASON }, now.toISOString());
    deps.buildLogger.warn(`${nameOf(deps)}: a build was found interrupted and marked failed`, { ideaId: idea.id, backend: idea.buildBackend });
    return failed;
  } catch (error) {
    deps.buildLogger.warn(`${nameOf(deps)}: could not mark an interrupted build as failed`, { ideaId: idea.id, reason: errorSummary(error) });
    return deps.store.getIdea(idea.id) ?? idea;
  } finally {
    release();
  }
}

/** What to say about an idea that is (still, as far as anyone can tell) being built. */
function stillBuildingLine(idea: Idea, config: Pick<Config, "buildTimeoutMin" | "timeZone">, now: Date): string {
  const overAt = cutOffAt(idea, config);
  const base = 'Not started: this idea is marked as being built right now (state "building").';
  if (overAt === null) return base;
  // Past the limit and still "building": failIfCutOff left it alone, so a build holds the lock.
  if (now.getTime() > overAt.getTime()) return `${base} A build is running on this data folder (the nightly build, or another build-now). Try again when it has finished.`;
  return `${base} If that build was cut off, it is given up on at ${formatLocal(overAt, config.timeZone)} (its time limit and 15 minutes after it began): run this command again after that.`;
}

/**
 * Resolves with the exit code: 0 only when the idea ends up delivered. 130, 143 or 129 when it
 * was stopped by a signal. 1 when the Mac slept through part of the run: what was running was
 * stopped, the idea is not delivered, and the same command carries on from where it stands.
 */
export async function buildNow<Backend>(ideaId: string, deps: BuildNowDeps<Backend>): Promise<number> {
  const { store, config, write, writeError } = deps;
  const now = deps.now ?? (() => new Date());
  const shownId = oneLine(ideaId).slice(0, 80);

  if (store.isPaused(config.pausedByDefault)) {
    writeError(BUILD_NOW_PAUSED);
    return 1;
  }
  const found = store.getIdea(ideaId);
  if (found === null) {
    writeError(`No idea has the id "${shownId}". See the ids with: npx overnight ideas --all`);
    return 1;
  }
  const idea = failIfCutOff(found, deps, now());

  const plan = PLAN[idea.state];
  if (plan === "not-approved") {
    writeError(`Not built: only an approved idea is ever built, and this one is "${idea.state}" (${WHY_NOT[idea.state] ?? "not approved"}).`);
    return 1;
  }
  if (plan === "building") {
    writeError(stillBuildingLine(idea, config, now()));
    return 1;
  }
  if (plan === "done") {
    write(`Already delivered${idea.publishedUrl === null ? "." : `: ${oneLine(idea.publishedUrl)}`}`);
    return 0;
  }

  write(`Idea ${idea.id}: ${oneLine(idea.title)}`);
  if (found.state === "building" && idea.state === "build_failed") write("  An earlier build of this idea was cut off. It is recorded as failed, and the build is tried again now.");

  // One watch for the whole command. The log line goes to the log of the step that is running.
  let stepLogger = plan === "build" ? deps.buildLogger : deps.deliverLogger;
  const stop = (deps.watchStopSignals ?? watchStopSignals)({
    onStop: (signal) => {
      stepLogger.warn(`${nameOf(deps)}: ${STOP_SIGNAL_LINE}`, { ideaId: idea.id, signal });
      writeError("  Stopping: told to stop. Ending what is running first.");
    },
  });
  // The Mac slept through part of the run: the step that is running is told to stop, as by a
  // stop signal. A build stopped that way is tried again; a delivery picks up where it was.
  let slept = false;
  const sleepWatch = (deps.watchForSleep ?? watchForSleep)({
    onSleep: (gapMs) => {
      slept = true;
      stepLogger.warn(SLEPT_LINE, { ideaId: idea.id, gapSeconds: Math.round(gapMs / 1000) });
      writeError("  Stopping: the Mac went to sleep during the run. Ending what is running first.");
      stop.stopWork();
    },
  });
  // An error nobody caught: one log line (in the log of the step that is running), the step is
  // told to stop, whatever a step holds right now (its lock, its bee program) is let go, exit 1.
  const held: HeldNow = new Set();
  const lastResort = (deps.watchLastResort ?? watchLastResort)({
    command: nameOf(deps),
    logger: () => stepLogger,
    letGo: [() => stop.abort(), () => letGoOf(held)],
    writeError,
  });
  /** The exit code if a stop signal has arrived or the Mac slept, after saying where the idea was left. Null if neither. */
  const stoppedCode = (): number | null => {
    const code = stop.exitCode();
    if (code !== null) {
      writeError(`  Stopped. The idea is now "${store.getIdea(idea.id)?.state ?? "unknown"}".`);
      return code;
    }
    if (!slept) return null;
    writeError(`  Stopped, because the Mac went to sleep during the run. The idea is now "${store.getIdea(idea.id)?.state ?? "unknown"}". Run the same command again to carry on.`);
    return 1;
  };

  // One hold for the whole command, from the first step to the last.
  let hold: { stop(): void } | null = null;
  try {
    hold = deps.keepAwake?.(stepLogger) ?? null;
    // ---------- step 1: build ----------
    if (plan === "build") {
      const outcome = await buildStep(idea.id, deps, stop, held);
      const stopped = stoppedCode();
      if (stopped !== null) return stopped;
      if (outcome === null) return 1;
      if (!outcome.ok) {
        // Read back where the idea stands: a build that was turned away before it began leaves the
        // idea as it was, and a build that ran and failed is recorded on it.
        const recorded = store.getIdea(idea.id)?.state === "build_failed";
        writeError(`  ${recorded ? "The build failed" : "The build did not start"}: ${oneLine(outcome.reason ?? "no reason was given")}`);
        writeError(recorded ? "  Nothing was published. The reason is saved on the idea: npx overnight ideas --all" : "  Nothing was built or published, and the idea is as it was.");
        return 1;
      }
      const took = outcome.ms === undefined ? "" : ` in ${formatDuration(outcome.ms)}`;
      write(`  Built${outcome.backend === undefined ? "" : ` by ${oneLine(outcome.backend)}`}${took}.`);
    } else {
      write(`1. Build: skipped, it is already built (state "${idea.state}").`);
    }

    // ---------- step 2: check, publish, deliver ----------
    stepLogger = deps.deliverLogger;
    const delivered = await deliverStep(idea.id, deps, stop, held);
    const stopped = stoppedCode();
    if (stopped !== null) return stopped;
    if (delivered === null) return 1;
    if (!delivered.ok) {
      writeError(`  Not delivered: ${oneLine(delivered.reason ?? "no reason was given")}`);
      return 1;
    }
    // Say where the idea really ended up, read back from the store, not what we expect.
    const after = store.getIdea(idea.id);
    const url = delivered.url ?? after?.publishedUrl ?? null;
    write(`  Done: the idea is now "${after?.state ?? "unknown"}".`);
    write(url === null ? "No link came back. Look it up with: npx overnight ideas --all" : `Link: ${oneLine(url)}`);
    if (delivered.notSeenLive === true) write(BUILD_NOW_NOT_SEEN_LIVE);
    return 0;
  } finally {
    sleepWatch.stop();
    quietly(() => hold?.stop());
    lastResort.close();
    stop.close();
  }
}

/** What the step that is running holds right now: how to let go of each thing (its lock, its bee program). */
type HeldNow = Set<() => void>;

/** Let go of everything in `held`, each one tried on its own. For the last resort only: a step lets go of its own things when it ends. */
function letGoOf(held: HeldNow): void {
  for (const letGo of [...held]) {
    try {
      letGo();
    } catch {
      // The operating system drops it when the process ends.
    }
  }
}

/** Run the build under the build lock. Null means it could not even start, or was cut short (the reason is already printed). */
async function buildStep<Backend>(ideaId: string, deps: BuildNowDeps<Backend>, stop: StopWatch, held: HeldNow): Promise<BuildOutcome | null> {
  const { store, config, paths, write, writeError } = deps;
  const logger = deps.buildLogger;
  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(buildLockFile(paths));
  } catch (error) {
    writeError(`Overnight could not use its build lock. ${errorSummary(error)}`);
    return null;
  }
  if (release === null) {
    writeError(BUILD_NOW_BUILD_BUSY);
    return null;
  }
  held.add(release);
  try {
    const factories = await deps.loadBuildFactories();
    // Told to stop while the builder was loading, or the Mac slept meanwhile: start nothing.
    if (stop.signal.aborted) return null;
    const chosen = chooseBackends(factories, { config, paths, logger });
    write(`1. Build: starting with ${chosen.primaryName} (${chosen.fallbackName} if that fails). This can take up to ${config.buildTimeoutMin} minutes each.`);
    logger.info(`${nameOf(deps)}: build starting`, { ideaId, primary: chosen.primaryName, fallback: chosen.fallbackName, sandboxMode: config.buildSandbox });
    const building = withDeadline(factories.buildOne(ideaId, { store, config, paths, backends: chosen.backends, logger, signal: stop.signal, ...signInStep(factories, logger) }), deps.buildLimitMs ?? buildOneLimitMs(config), "The build");
    const outcome = await stop.settle(building);
    if (outcome === STOP_OVERDUE) {
      logger.error(`${nameOf(deps)}: the builder did not stop in time after ${stop.received() === null ? "it was told to stop" : "the stop signal"}; ending anyway`, { ideaId, waitedFor: stopWaitText() });
      return null;
    }
    logger.info(`${nameOf(deps)}: build finished`, { ideaId, ok: outcome.ok, backend: outcome.backend, ms: outcome.ms, stoppedBySignal: stop.received() ?? undefined });
    return outcome;
  } catch (error) {
    // Past its last-resort limit: nobody is waiting any more, so tell the builder to stop too.
    if (error instanceof DeadlinePassed) stop.abort();
    logger.error(`${nameOf(deps)}: the build stopped on an error`, { ideaId, reason: errorSummary(error) });
    writeError(`  The build could not be run. ${errorSummary(error)}`);
    return null;
  } finally {
    held.delete(release);
    release();
  }
}

/** Run the deliver step under the deliver lock. Null means it could not even start, or was cut short (the reason is already printed). */
async function deliverStep<Backend>(ideaId: string, deps: BuildNowDeps<Backend>, stop: StopWatch, held: HeldNow): Promise<DeliverOutcome | null> {
  const { store, config, paths, write, writeError } = deps;
  const logger = deps.deliverLogger;
  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(deliverLockFile(paths));
  } catch (error) {
    writeError(`Overnight could not use its deliver lock. ${errorSummary(error)}`);
    return null;
  }
  if (release === null) {
    writeError(BUILD_NOW_DELIVER_BUSY);
    return null;
  }
  let bee: ReturnType<DeliverFactories["createBee"]> | null = null;
  const stopBee = (): void => disposeQuietly(bee);
  held.add(stopBee);
  held.add(release);
  try {
    const factories = await deps.loadDeliverFactories();
    // Told to stop while the packages were loading, or the Mac slept meanwhile: start nothing.
    if (stop.signal.aborted) return null;
    bee = factories.createBee({ logger });
    write("2. Deliver: installing, building and testing a clean copy inside the sandbox, then publishing.");
    logger.info(`${nameOf(deps)}: deliver starting`, { ideaId });
    const delivering = withDeadline(factories.deliverOne(ideaId, { store, bee, config, paths, logger, signal: stop.signal }), deps.deliverLimitMs ?? DELIVER_ONE_LIMIT_MS, "Checking and publishing");
    const outcome = await stop.settle(delivering);
    if (outcome === STOP_OVERDUE) {
      logger.error(`${nameOf(deps)}: the deliver step did not stop in time after ${stop.received() === null ? "it was told to stop" : "the stop signal"}; ending anyway`, { ideaId, waitedFor: stopWaitText() });
      return null;
    }
    logger.info(`${nameOf(deps)}: deliver finished`, { ideaId, ok: outcome.ok, stoppedBySignal: stop.received() ?? undefined });
    return outcome;
  } catch (error) {
    // Past its last-resort limit: nobody is waiting any more, so tell the deliver step to stop too.
    if (error instanceof DeadlinePassed) stop.abort();
    logger.error(`${nameOf(deps)}: deliver stopped on an error`, { ideaId, reason: errorSummary(error) });
    writeError(`  Checking and publishing could not be run. ${errorSummary(error)}`);
    return null;
  } finally {
    held.delete(stopBee);
    held.delete(release);
    disposeQuietly(bee);
    release();
  }
}
