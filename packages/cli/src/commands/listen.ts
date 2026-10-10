// `overnight listen`: wire the parts together and run until stopped.
// Only wiring lives here. Hearing, noticing and asking are in @overnight/listener; the Bee and
// Kiro calls are in @overnight/bee and @overnight/detector.
import { errorSummary } from "@overnight/core";
import type { BeeGateway, Config, DataPaths, Detector, DetectorResult, Logger, Store } from "@overnight/core";
import { listenLockFile } from "../single-instance.ts";
import type { ReleaseLock } from "../single-instance.ts";

/** How the parts are made. main.ts passes the real ones; tests pass fakes. */
export interface ListenFactories {
  createBee(options: { logger: Logger }): BeeGateway;
  createDetector(options: { paths: DataPaths; logger: Logger }): Detector & { ensureSetup(): Promise<void> };
  createListener(deps: {
    store: Store;
    bee: BeeGateway;
    detector: Detector;
    config: Config;
    logger: Logger;
    options: { handleSignals: boolean; keepAwake: boolean };
  }): { start(): Promise<void> };
}

export interface ListenDeps {
  store: Store;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  factories: ListenFactories;
  /** Take the one-listener-per-data-folder lock: how to release it, or null if another listener holds it. */
  takeLock: (file: string) => ReleaseLock | null;
}

export const DETECTOR_NOT_SET_UP = "detector is not set up";
export const ALREADY_RUNNING = "another overnight listen is already running on this data folder; not starting a second one";
/** After a failed detector set-up, wait this long before the next try. The same wait the listener leaves between its own retries. */
export const DETECTOR_RETRY_MS = 60_000;

/**
 * The answer while Kiro is not ready. Nothing is sent anywhere. `retryLater` tells the listener
 * to keep the lines and ask again, without counting this as a failed run.
 */
function notSetUp(): DetectorResult {
  return { ok: false, reason: DETECTOR_NOT_SET_UP, ms: 0, attempts: 0, retryLater: true };
}

/** Stands in when Kiro is not ready. Every call gives the "not set up, ask again later" answer. */
export const stubDetector: Detector = { detect: async () => notSetUp() };

export interface RetryingDetector {
  /** What the listener is given. */
  detector: Detector;
  /** One set-up try, shared if one is already under way. Never rejects. */
  trySetup(): Promise<void>;
  /** The listener has stopped: no more tries and no more log lines. */
  stop(): void;
}

/**
 * A detector that keeps trying to get ready.
 *
 * A detector that cannot start (Kiro missing, slow right after login, signed out, content sharing
 * still on) must not stop us hearing and saving: Bee deletes short recordings within minutes, so
 * a line we do not save now is gone for good. And one bad start must not switch idea-noticing off
 * for good either: under launchd this process lives for days. So until set-up has worked, each
 * detect() answers "not set up, ask again later" and, at most once per `retryMs`, tries set-up
 * again first. Once set-up has worked, calls go straight to the real detector.
 */
export function retryingDetector(deps: Pick<ListenDeps, "factories" | "paths" | "logger">, options: { retryMs?: number; nowMs?: () => number } = {}): RetryingDetector {
  const retryMs = options.retryMs ?? DETECTOR_RETRY_MS;
  const nowMs = options.nowMs ?? Date.now;
  let real: ReturnType<ListenFactories["createDetector"]> | null = null;
  let ready = false;
  let stopped = false;
  let failedTries = 0;
  let nextTryAt = 0;
  let underWay: Promise<void> | null = null;

  async function setUpOnce(): Promise<void> {
    try {
      real ??= deps.factories.createDetector({ paths: deps.paths, logger: deps.logger });
      await real.ensureSetup();
      ready = true;
      if (failedTries > 0 && !stopped) deps.logger.info("detector is set up now: ideas are being noticed again", { failedTries });
    } catch (error) {
      failedTries += 1;
      nextTryAt = nowMs() + retryMs;
      if (!stopped) {
        deps.logger.error("detector is not set up: listening and saving continue, and set-up will be tried again", { reason: errorSummary(error), failedTries, retryInMs: retryMs });
      }
    }
  }

  function trySetup(): Promise<void> {
    underWay ??= setUpOnce().finally(() => {
      underWay = null;
    });
    return underWay;
  }

  return {
    detector: {
      detect: async (input) => {
        if (!ready && !stopped) {
          if (underWay !== null) await underWay;
          else if (nowMs() >= nextTryAt) await trySetup();
        }
        return ready && real !== null ? real.detect(input) : notSetUp();
      },
    },
    trySetup,
    stop: () => {
      stopped = true;
    },
  };
}

/** Resolves with the exit code once the listener has stopped: 0 for a clean stop, 1 for a failure or a refused start. */
export async function listen(deps: ListenDeps): Promise<number> {
  const { store, config, paths, logger, factories } = deps;

  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(listenLockFile(paths));
  } catch (error) {
    logger.error("overnight listen could not start: its lock file could not be used", { reason: errorSummary(error), dataDir: paths.root });
    return 1;
  }
  if (release === null) {
    logger.error(ALREADY_RUNNING, { dataDir: paths.root });
    return 1;
  }

  const setup = retryingDetector(deps);
  try {
    logger.info("overnight listen starting", { paused: store.isPaused(config.pausedByDefault), dataDir: paths.root, timeZone: config.timeZone });
    const bee = factories.createBee({ logger });
    // Not awaited: Kiro can take a while to answer, and nothing may be missed while it does. The
    // first detect() waits for this try if it is still under way.
    void setup.trySetup();
    const listener = factories.createListener({ store, bee, detector: setup.detector, config, logger, options: { handleSignals: true, keepAwake: true } });
    await listener.start();
    logger.info("overnight listen stopped");
    return 0;
  } catch (error) {
    logger.error("overnight listen stopped on an error", { reason: errorSummary(error) });
    return 1;
  } finally {
    setup.stop();
    release();
  }
}
