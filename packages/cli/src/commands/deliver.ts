// `overnight deliver`: the morning. The background job wakes every minute and runs this, with
// `--if-due`, once Overnight's own clock says it is 30 minutes before DELIVER_TIME (night-tick.ts).
// Only wiring lives here: checking each build inside the sandbox, publishing, the morning Bee
// to-do, the Bee fact and the report are all in @overnight/deliver. This file takes the deliver
// lock, makes the Bee gateway, hands over, and prints one line about how the morning went.
//
// There is no pause check here, on purpose. Whether a paused Overnight still delivers what was
// already approved and built is @overnight/deliver's rule (today: it does), and it is kept in
// that one place.
import { errorSummary } from "@overnight/core";
import type { BeeGateway, Config, DataPaths, Logger, Store } from "@overnight/core";
import { DeadlinePassed, MINUTE_MS, settleUnderLimit } from "../deadline.ts";
import { watchLastResort } from "../last-resort.ts";
import type { WatchLastResort } from "../last-resort.ts";
import { oneLine } from "../output.ts";
import type { Write } from "../output.ts";
import { deliverLockFile } from "../single-instance.ts";
import type { ReleaseLock } from "../single-instance.ts";
import { sleptLine, watchForSleep } from "../sleep-watch.ts";
import type { WatchForSleep } from "../sleep-watch.ts";
import { STOP_OVERDUE, STOP_SIGNAL_LINE, stopWaitText, watchStopSignals } from "../stop-signals.ts";
import type { WatchStopSignals } from "../stop-signals.ts";
import { quietly } from "./build.ts";
import type { KeepAwakeHold } from "./build.ts";
import type { NightRunMarks } from "./night-tick.ts";

type MaybePromise<T> = T | Promise<T>;

/** What a morning comes back with. The lists hold idea ids. */
export interface DeliverResult {
  /** Published, and the morning to-do with the link created. */
  delivered: string[];
  /** Checked or published without success. */
  failed: string[];
  /** The wearer was told "couldn't finish" about these. */
  notified: string[];
  /** True when the morning was cut short by a stop signal. What it had not reached waits for the next run. */
  stopped?: boolean;
  /** Pushed to the apps repo, but the page was not seen live before the wait for it ran out. Left out when there are none. */
  notSeenLive?: string[];
}

/** What delivering one idea comes back with. */
export interface DeliverOutcome {
  ok: boolean;
  url?: string | null;
  /** Why it failed, in plain words. No transcript text. */
  reason?: string | null;
  /** True when the delivery was cut short by a stop signal. */
  stopped?: boolean;
  /** True when the app was pushed but its page was not seen live before the wait for it ran out. */
  notSeenLive?: boolean;
}

/** What a publisher is asked to put on the web: one checked dist folder, under the idea's slug. */
export interface PublishRequest {
  ideaId: string;
  slug: string;
  distDir: string;
  marker: string;
  signal?: AbortSignal;
}

/** Something that publishes in place of the real publisher. Only a rehearsal passes one (rehearse.ts). */
export interface StandInPublisher {
  publish(job: PublishRequest): Promise<{ ok: true; url: string; liveAfterMs: number } | { ok: false; reason: string }>;
}

/** What the deliver step is handed for a morning, or for one idea. */
export interface DeliverRunDeps {
  store: Store;
  bee: BeeGateway;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  /**
   * Aborted when this command is told to stop (a stop signal, see stop-signals.ts). The deliver
   * step then starts nothing new, stops every program it started, and comes back within 10 seconds.
   */
  signal?: AbortSignal;
  /** Left out everywhere but in a rehearsal with --no-publish: the deliver step then uses its own, real publisher. */
  publish?: StandInPublisher;
}

/** The two entry points of @overnight/deliver this command line uses. They never make a Bee gateway themselves: they are handed one. */
export interface DeliverSteps {
  runDeliver(deps: DeliverRunDeps): MaybePromise<DeliverResult>;
  deliverOne(ideaId: string, deps: DeliverRunDeps): MaybePromise<DeliverOutcome>;
}

/**
 * The parts of @overnight/deliver (and the Bee gateway) this command line uses. wiring.ts passes
 * the real ones; tests pass fakes.
 */
export interface DeliverFactories extends DeliverSteps {
  /** The gateway may offer dispose(), which stops any bee program still running. */
  createBee(options: { logger: Logger }): BeeGateway & { dispose?: () => void };
}

export interface DeliverDeps {
  store: Store;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  /** Loads @overnight/deliver and @overnight/bee. Called only once there is something to do with them. */
  loadFactories: () => Promise<DeliverFactories>;
  /** Take a one-at-a-time lock: how to release it, or null if another process holds it. */
  takeLock: (file: string) => ReleaseLock | null;
  write: Write;
  writeError: Write;
  /** Watches for stop signals while the morning runs. Default: the real one (stop-signals.ts). */
  watchStopSignals?: WatchStopSignals;
  /** Watches for an error nobody caught while the morning runs. Default: the real one (last-resort.ts). */
  watchLastResort?: WatchLastResort;
  /** Watches for the Mac having slept while the morning runs. Default: the real one (sleep-watch.ts). */
  watchForSleep?: WatchForSleep;
  /**
   * Given by `--if-due`: the night clock's marks for this run. `started` is called just before
   * any work begins, `ended` when it is over. Left out, this command means "now" and the clock
   * is neither read nor written.
   */
  onRun?: NightRunMarks;
  /** Holds the Mac awake while the morning runs, also on battery. Left out, nothing holds it. */
  keepAwake?: KeepAwakeHold;
  /** For tests: the last-resort time limit, in milliseconds. */
  limitMs?: number;
}

export const DELIVER_ALREADY_RUNNING = "another overnight deliver is already running on this data folder; not starting a second one";

/**
 * The last-resort limit for one idea. It only has to sit above the deliver step's own limits
 * added up, so that it never fires first on a slow morning: installing 5 minutes, installing
 * through the registry 8, building 5, the page test 3, the app's own test 4, git and gh about 9,
 * waiting for the link to go live 10, the Bee to-do and fact about 3. Roughly 48 minutes.
 */
export const DELIVER_ONE_LIMIT_MS = 60 * MINUTE_MS;

/**
 * The last-resort limit for a whole morning: an hour for each idea waiting to be checked and
 * published, and 15 minutes on top (telling the wearer about a failed build takes seconds).
 */
export function deliverLimitMs(store: Pick<Store, "countIdeasByState">): number {
  const counts = store.countIdeasByState();
  const waiting = (counts.built ?? 0) + (counts.published ?? 0);
  return Math.max(1, waiting) * DELIVER_ONE_LIMIT_MS + 15 * MINUTE_MS;
}

/**
 * The one line `overnight deliver` prints. Ids only: titles come from speech and stay out of logs.
 * A page that was pushed but not seen live is said too: its link went to the wrist all the same,
 * and for a few minutes it may not open.
 */
export function deliverSummary(result: DeliverResult): string {
  const part = (ids: string[], word: string) => (ids.length === 0 ? `0 ${word}` : `${ids.length} ${word} (${ids.map(oneLine).join(", ")})`);
  const unseen = result.notSeenLive ?? [];
  const notLive = unseen.length === 0 ? "" : ` ${unseen.length} pushed but not seen live yet (${unseen.map(oneLine).join(", ")}): the link usually starts working a few minutes later.`;
  const cutShort = result.stopped === true ? " Stopped before the morning was done: the rest waits for the next run." : "";
  return `This morning: ${part(result.delivered, "delivered")}, ${part(result.failed, "failed")}, ${part(result.notified, "told about a failure")}.${notLive}${cutShort}`;
}

/**
 * Resolves with the exit code. 0 whenever the command ran, even if an idea could not be published
 * (that is recorded on the idea, and the wearer is told). 1 only when the command itself could not
 * run (another deliver has the lock, a package would not load, or it ran past every limit).
 * 130, 143 or 129 when it was stopped by a signal (see stop-signals.ts).
 */
export async function deliver(deps: DeliverDeps): Promise<number> {
  const { store, config, paths, logger } = deps;

  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(deliverLockFile(paths));
  } catch (error) {
    logger.error("overnight deliver could not start: its lock file could not be used", { reason: errorSummary(error), dataDir: paths.root });
    deps.writeError(`Overnight could not use its deliver lock. ${errorSummary(error)}`);
    return 1;
  }
  if (release === null) {
    logger.error(DELIVER_ALREADY_RUNNING, { dataDir: paths.root });
    deps.writeError(`Not started: ${DELIVER_ALREADY_RUNNING}.`);
    return 1;
  }

  const stop = (deps.watchStopSignals ?? watchStopSignals)({ onStop: (signal) => logger.warn(`overnight deliver: ${STOP_SIGNAL_LINE}`, { signal }) });
  // The Mac slept through part of the morning: the deliver step is told to stop, as by a stop
  // signal. What it had not finished stays as it was, for the next run.
  let slept = false;
  const sleepWatch = (deps.watchForSleep ?? watchForSleep)({
    onSleep: (gapMs) => {
      slept = true;
      logger.warn(sleptLine("deliver"), { gapSeconds: Math.round(gapMs / 1000) });
      stop.stopWork();
    },
  });
  // Asked when the morning's last-resort limit passes: has the deliver step been told to stop
  // already? A Mac that slept past the limit wakes with the limit and the sleep watch due in the
  // same instant, and the limit's timer can be the one that runs first. So the watch looks right now.
  const toldToStop = (): boolean => {
    sleepWatch.look?.();
    return slept || stop.received() !== null;
  };
  let bee: ReturnType<DeliverFactories["createBee"]> | null = null;
  // An error nobody caught: one log line, the deliver step is told to stop, any bee program still
  // running is stopped, the lock goes, exit 1.
  const lastResort = (deps.watchLastResort ?? watchLastResort)({
    command: "overnight deliver",
    logger,
    letGo: [() => stop.abort(), () => disposeQuietly(bee), release],
    writeError: deps.writeError,
  });
  let started = false;
  // Only a morning that ended by itself is "finished". Stopped, slept through, overdue or failed, it was cut short.
  let how: "finished" | "cut-short" = "cut-short";
  let hold: { stop(): void } | null = null;
  try {
    const factories = await deps.loadFactories();
    // Told to stop while the packages were loading, or the Mac slept meanwhile: start nothing.
    if (stop.signal.aborted) return stop.exitCode() ?? 0;
    bee = factories.createBee({ logger });
    // The night clock writes the start down before any work begins. If it cannot, nothing begins.
    deps.onRun?.started();
    started = true;
    hold = deps.keepAwake?.(logger) ?? null;
    logger.info("overnight deliver starting", { dataDir: paths.root, timeZone: config.timeZone, deliverTime: config.deliverTime });
    const result = await settleUnderLimit({
      work: factories.runDeliver({ store, bee, config, paths, logger, signal: stop.signal }),
      stop,
      limitMs: deps.limitMs ?? deliverLimitMs(store),
      what: "The morning's deliver",
      toldToStop,
    });
    if (result === STOP_OVERDUE) {
      logger.error(`overnight deliver: the deliver step did not stop in time after ${slept && stop.received() === null ? "the Mac's sleep was noticed" : "the stop signal"}; ending anyway`, { waitedFor: stopWaitText() });
      deps.writeError(`"overnight deliver" was told to stop, and the deliver step had not stopped ${stopWaitText()} later. Ending anyway.`);
      return stop.exitCode() ?? 1;
    }
    logger.info("overnight deliver finished", { delivered: result.delivered.length, failed: result.failed.length, notified: result.notified.length, notSeenLive: result.notSeenLive?.length ?? 0, stoppedBySignal: stop.received() ?? undefined, stoppedBySleep: slept || undefined });
    deps.write(deliverSummary(result));
    if (stop.exitCode() === null && !slept && result.stopped !== true) how = "finished";
    // After a sleep the code is still 0: nothing went wrong that a person has to fix.
    return stop.exitCode() ?? 0;
  } catch (error) {
    // Past its last-resort limit, with nothing having told it to stop: nobody is waiting any
    // more, so tell the deliver step to stop too.
    if (error instanceof DeadlinePassed) stop.abort();
    logger.error("overnight deliver stopped on an error", { reason: errorSummary(error) });
    deps.writeError(`"overnight deliver" could not finish. ${errorSummary(error)}`);
    return stop.exitCode() ?? 1;
  } finally {
    sleepWatch.stop();
    // Before the lock goes: the clock's record is closed while this run still holds it.
    if (started) quietly(() => deps.onRun?.ended(how));
    quietly(() => hold?.stop());
    lastResort.close();
    stop.close();
    disposeQuietly(bee);
    release();
  }
}

/** Stop whatever bee program the gateway still has running. Never throws. */
export function disposeQuietly(bee: { dispose?: () => void } | null): void {
  try {
    bee?.dispose?.();
  } catch {
    // Nothing more to stop.
  }
}
