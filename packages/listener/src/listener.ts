// The always-on loop: keep one Bee stream open, hand its events to hear.ts, backfill after each
// connect, and run the detection and approval passes on a timer. Everything it touches is passed
// in, so the tests run it against fakes and a clock they control.
import { errorSummary } from "@overnight/core";
import type { BeeEvent, BeeGateway, BeeStream, Config, Detector, Idea, Logger, LoginState, Store, StreamEnd } from "@overnight/core";
import { createApprovals } from "./approval.ts";
import { createAsker } from "./asking.ts";
import { settlesWithin, singleFlight, sleep } from "./async.ts";
import { runBackfillOnce } from "./backfill.ts";
import { beeErrorKind } from "./context.ts";
import type { ListenerContext } from "./context.ts";
import { createDetection } from "./detection.ts";
import { createEventHandler } from "./hear.ts";
import { startKeepAwake } from "./keep-awake.ts";
import type { SpawnKeepAwake } from "./keep-awake.ts";
import { resolveOptions } from "./options.ts";
import type { ListenerOptions } from "./options.ts";

export interface ListenerDeps {
  store: Store;
  bee: BeeGateway;
  detector: Detector;
  config: Config;
  logger: Logger;
  /** Where "now" comes from for everything stored or compared. Default: the real clock. */
  now?: () => Date;
  options?: Partial<ListenerOptions>;
  /** Starts the program that holds the Mac awake. Default: macOS's own caffeinate. Tests pass a fake. */
  spawnKeepAwake?: SpawnKeepAwake;
  /** The wall clock in milliseconds, read only to notice that the Mac slept. Default: Date.now. Tests pass their own. */
  wallClock?: () => number;
}

export interface Listener {
  /**
   * Run until stop() is called, and resolve only then. A Bee outage, a logged-out Bee or a failing
   * pass never ends it. It rejects only if the run loop itself breaks (a bug), after shutting down.
   */
  start(): Promise<void>;
  /**
   * Stop the timers, close the stream and wait for the work in progress, but for no longer than
   * stopGraceMs. Then let start() resolve either way. Never rejects.
   */
  stop(): Promise<void>;
  /** Take one event from Bee's stream. Never throws. */
  handleEvent(event: BeeEvent): void;
  /** Run the detector on every conversation that has gone quiet. One pass. Never rejects. */
  runDetectionPass(): Promise<void>;
  /** Check the answer to every open ask. One pass. Never rejects. */
  runApprovalPass(): Promise<void>;
  /** Fetch what the stream missed. One run. Never rejects. */
  runBackfill(): Promise<void>;
}

const LOGIN_COMMAND = "node spikes/00-bee-login.ts";
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createListener(deps: ListenerDeps): Listener {
  const options = resolveOptions(deps.options);
  const wallClock = deps.wallClock ?? Date.now;
  const ctx: ListenerContext = {
    store: deps.store,
    bee: deps.bee,
    detector: deps.detector,
    config: deps.config,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    options,
    onLoggedOut: () => noteLoggedOut(),
  };
  const { bee, logger } = ctx;
  const approvals = createApprovals(ctx);
  const detection = createDetection(ctx, createAsker(ctx));

  // ---------- run state ----------

  let stopSignal: AbortController | null = null;
  let running: Promise<void> | null = null;
  let currentStream: BeeStream | null = null;
  /** Work started by an event rather than a pass. stop() waits for it. */
  const background = new Set<Promise<void>>();
  /** True while we know Bee is logged out. The passes wait: nothing can be asked or answered. */
  let beeLoggedOut = false;
  /**
   * True once a stop has given up waiting for the work in progress. Whoever runs us may close the
   * store next, so that work must change nothing more. A new start() clears it.
   */
  let abandoned = false;
  /**
   * Since when lines may have gone missing with no backfill yet to fetch them: the moment a
   * stream ended, or we started up. Null once a backfill has caught up. See runBackfillOnce.
   */
  let gapSince: Date | null = null;
  let gapsOpened = 0;

  const stopping = () => abandoned || (stopSignal?.signal.aborted ?? false);

  function noteGap(at: Date = ctx.now()): void {
    if (gapSince === null || at.getTime() < gapSince.getTime()) gapSince = at;
    gapsOpened += 1;
  }

  /**
   * A pass was told "logged out" by Bee. Hold the passes back and drop the stream, so the stream
   * loop goes back to checking the login (and saying how to log in) once a minute.
   */
  function noteLoggedOut(): void {
    beeLoggedOut = true;
    currentStream?.close();
  }

  function inBackground(work: Promise<void>): void {
    background.add(work);
    void work.finally(() => background.delete(work));
  }

  // ---------- the three passes ----------

  /** Whatever goes wrong inside a pass is logged here and goes no further. */
  const guarded = (name: string, work: () => Promise<void>) => async () => {
    try {
      await work();
    } catch (error) {
      logger.error(`${name} failed`, { error: errorSummary(error) });
    }
  };

  const runDetectionPass = singleFlight(guarded("detection pass", () => detection.runPass(stopping, () => abandoned)));
  const runApprovalPass = singleFlight(guarded("approval pass", () => approvals.runPass(stopping, () => abandoned)));
  const runBackfill = singleFlight(
    guarded("backfill", async () => {
      const opened = gapsOpened;
      const caughtUp = await runBackfillOnce(ctx, gapSince, stopping);
      // If the stream dropped again while this ran, there is a newer gap it did not cover.
      if (caughtUp && opened === gapsOpened) gapSince = null;
    }),
  );

  // ---------- events ----------

  /** Bee says a to-do was deleted. If it carried one of our asks, read the answer now instead of at the next pass. */
  async function checkAnswerNow(idea: Idea): Promise<void> {
    try {
      const result = await approvals.check(idea, () => abandoned);
      if (result === "logged-out") {
        logger.warn("could not check an ask: Bee is logged out", { ideaId: idea.id });
        noteLoggedOut();
      }
    } catch (error) {
      logger.error("could not record the answer to an ask", { ideaId: idea.id, error: errorSummary(error) });
    }
  }

  const handleEvent = createEventHandler(ctx, (idea) => inBackground(checkAnswerNow(idea)));

  // ---------- the run loop ----------

  /** Returns once Bee is not known to be logged out. While it is, says so and checks again later. */
  async function waitForLogin(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let state: LoginState;
      try {
        state = await bee.loginState();
      } catch (error) {
        logger.warn("could not check the Bee login", { kind: beeErrorKind(error) });
        state = "unknown";
      }
      if (state !== "logged-out") {
        // "unknown" (offline, say) is not "logged out": carry on and let the stream find out.
        logger.info("Bee login checked", { state });
        beeLoggedOut = false;
        return;
      }
      // Do not exit here: launchd would only start us again, in a loop.
      beeLoggedOut = true;
      logger.error(`Bee is logged out, so nothing can be heard or asked. To log in, run: ${LOGIN_COMMAND}`, { checkAgainInMs: options.loginRecheckMs });
      await sleep(options.loginRecheckMs, signal);
    }
  }

  /**
   * Backfill once per connect: when Bee's connect message arrives, or after a short wait if it
   * never does. If the backfill fails it is tried again a few times while this stream lives;
   * otherwise what was missed would wait for the next disconnect, which may be hours away.
   */
  async function backfillOnceConnected(stream: BeeStream, sawConnect: Promise<void>, signal: AbortSignal): Promise<void> {
    const streamOver = new AbortController();
    void stream.done.then(() => streamOver.abort());
    const whileStreamLives = AbortSignal.any([signal, streamOver.signal]);

    const waited = new AbortController();
    await Promise.race([sawConnect, sleep(options.connectGraceMs, AbortSignal.any([whileStreamLives, waited.signal]))]);
    waited.abort();

    // A stream that ended before it connected never worked, so there is nothing to catch up on yet.
    for (let attempt = 1; attempt <= options.backfillMaxAttempts && !whileStreamLives.aborted; attempt += 1) {
      await runBackfill();
      if (gapSince === null) return;
      await sleep(options.retryDelayMs, whileStreamLives);
    }
  }

  /**
   * Open one stream and stay with it until it is over. `idleMs` is set if we closed it ourselves
   * because nothing at all had arrived for that long: Bee's CLI swallows the keep-alives, so a
   * dead connection looks exactly like a quiet room, and a fresh stream is the only way to tell.
   */
  async function listenOnce(signal: AbortSignal): Promise<{ end: StreamEnd; idleMs: number | null }> {
    const idle: { ms: number | null; timer?: NodeJS.Timeout } = { ms: null };
    let stream: BeeStream | null = null;
    try {
      let connected = () => {};
      const sawConnect = new Promise<void>((resolve) => {
        connected = resolve;
      });
      void sawConnect.then(() => logger.info("Bee stream connected"));
      let lastEventAt = performance.now();
      const opened = bee.stream((event) => {
        lastEventAt = performance.now();
        if (idle.ms === null) idle.timer?.refresh();
        if (event.type === "connected") connected();
        handleEvent(event);
      });
      stream = opened;
      currentStream = opened;
      logger.info("listening on a new Bee stream");
      // Node cannot time anything longer than MAX_TIMER_MS: it would fire at once instead.
      if (options.streamIdleReopenMs > 0 && options.streamIdleReopenMs <= MAX_TIMER_MS) {
        idle.timer = setTimeout(() => {
          idle.ms = Math.round(performance.now() - lastEventAt);
          logger.info("nothing from Bee for a while; opening a fresh stream in case this one has died", { idleMs: idle.ms });
          opened.close();
        }, options.streamIdleReopenMs);
      }
      inBackground(backfillOnceConnected(opened, sawConnect, signal));
      const end = await opened.done;
      return { end, idleMs: idle.ms };
    } catch (error) {
      logger.error("could not open the Bee stream", { kind: beeErrorKind(error) });
      return { end: { reason: "error" }, idleMs: null };
    } finally {
      clearTimeout(idle.timer);
      if (currentStream === stream) currentStream = null;
    }
  }

  /** `bee stream` does not reconnect by itself. Whenever it ends, for any reason, open a new one. */
  async function streamLoop(signal: AbortSignal): Promise<void> {
    let restartsInARow = 0;
    while (!signal.aborted) {
      await waitForLogin(signal);
      if (signal.aborted) break;

      const openedAt = performance.now();
      const { end, idleMs } = await listenOnce(signal);
      // From here until the next backfill, anything said is missing. On a stream that went
      // silent, that may be anything since just after the last event it gave us.
      noteGap(idleMs === null ? ctx.now() : new Date(ctx.now().getTime() - idleMs + 1));
      if (signal.aborted) break;

      const livedMs = Math.round(performance.now() - openedAt);
      if (livedMs > options.streamHealthyMs) restartsInARow = 0;
      // Our own tidy reopening of a silent stream: nothing went wrong, so no warning and no wait.
      if (idleMs !== null) continue;
      const delays = options.reconnectDelaysMs;
      const retryInMs = delays[Math.min(restartsInARow, delays.length - 1)] ?? 1000;
      restartsInARow += 1;
      logger.warn("Bee stream ended; opening a new one", { reason: end.reason, livedMs, retryInMs });
      await sleep(retryInMs, signal);
    }
  }

  /** Detection, then approvals, every pollMs. One after the other, so a pass never overlaps itself. */
  async function pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(options.pollMs, signal);
      if (signal.aborted) break;
      if (beeLoggedOut) continue;
      await runDetectionPass();
      if (signal.aborted || beeLoggedOut) continue;
      await runApprovalPass();
    }
  }

  /**
   * Notice that the Mac slept: a steady tick that reads the wall clock, and a tick that comes far
   * too late means the clock ran on while we did not. It ticks by itself, apart from the passes,
   * so a sleep that begins while a pass is waiting on Bee or Kiro is seen all the same. A stream
   * can look open after a sleep and be dead, so open a fresh one; its backfill fetches what was
   * missed. Returns the function that stops the tick.
   */
  function watchForWake(): () => void {
    let lastTick = wallClock();
    const tick = setInterval(() => {
      try {
        const now = wallClock();
        const lateMs = now - lastTick - options.wakeCheckMs;
        lastTick = now;
        if (lateMs <= options.wakeGapMs) return;
        logger.warn("the Mac seems to have been asleep; reopening the Bee stream to catch up", { lateMs });
        // Lines went missing from when the sleep began, not from now.
        noteGap(new Date(ctx.now().getTime() - lateMs));
        currentStream?.close();
      } catch (error) {
        // An error thrown from a timer would take the whole process down.
        logger.error("the sleep check failed", { error: errorSummary(error) });
      }
    }, options.wakeCheckMs);
    return () => clearInterval(tick);
  }

  function stopOnSignals(): () => void {
    const onSignal = (name: NodeJS.Signals) => {
      logger.info("stop signal received", { signal: name });
      void stop();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    return () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    };
  }

  async function run(): Promise<void> {
    const abort = new AbortController();
    stopSignal = abort;
    abandoned = false;
    const { signal } = abort;
    // "always": on battery too, so the listener keeps hearing while the lid is open (the owner's decision, Oct 11).
    const keepAwake = options.keepAwake ? startKeepAwake(logger, process.pid, deps.spawnKeepAwake, "always") : null;
    const forgetSignals = options.handleSignals ? stopOnSignals() : () => {};
    const stopWatchingForWake = watchForWake();
    logger.info("listener starting", { pollMs: options.pollMs, quietMs: options.quietMs, keepAwake: options.keepAwake });

    // Neither loop should ever throw. If one does, half a listener is worse than none: shut the
    // other one down too and let start() reject, so whoever runs us (launchd, through the CLI)
    // sees a failure and starts afresh.
    const broken: unknown[] = [];
    const shutDownOn = (name: string) => (error: unknown) => {
      logger.error(`${name} broke; shutting down`, { error: errorSummary(error) });
      broken.push(error);
      abort.abort();
      currentStream?.close();
    };
    let finishedInTime = true;
    try {
      // Whatever was said while we were not running is missing until a backfill fetches it.
      noteGap();
      const work = Promise.all([streamLoop(signal).catch(shutDownOn("the stream loop")), pollLoop(signal).catch(shutDownOn("the poll loop"))]).then(() =>
        Promise.allSettled([...background]),
      );
      // Once asked to stop, wait for the work in progress, but not for long: a detector call can
      // take minutes, and launchd kills a job that has not gone 30 seconds after its stop signal.
      const stopRequested = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      // The flag is set the instant the wait runs out, so the pass cannot slip through in between.
      const giveUp = () => {
        abandoned = true;
      };
      finishedInTime = await Promise.race([work.then(() => true), stopRequested.then(() => settlesWithin(work, options.stopGraceMs, giveUp))]);
    } finally {
      abort.abort();
      currentStream?.close();
      stopWatchingForWake();
      keepAwake?.stop();
      forgetSignals();
      stopSignal = null;
      if (!finishedInTime) logger.warn("stopping although a pass was still running; what it was working on stays pending for the next start", { waitedMs: options.stopGraceMs });
      logger.info("listener stopped", { clean: broken.length === 0, waitedForWork: finishedInTime });
    }
    if (broken.length > 0) throw broken[0];
  }

  function start(): Promise<void> {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  }

  async function stop(): Promise<void> {
    stopSignal?.abort();
    currentStream?.close();
    // If the run broke, start() is what reports it. stop() only waits for the end, and the run
    // itself never waits longer than the grace time.
    if (running !== null) await running.catch(() => {});
    if (abandoned || background.size === 0) return;
    // Not running, so this is work an event started outside a run. The same limit applies.
    const finished = await settlesWithin(Promise.allSettled([...background]), options.stopGraceMs);
    if (!finished) logger.warn("stopping although work started by a Bee event was still running", { waitedMs: options.stopGraceMs });
  }

  return { start, stop, handleEvent, runDetectionPass, runApprovalPass, runBackfill };
}
