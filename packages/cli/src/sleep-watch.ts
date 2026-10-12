// Did the Mac sleep while a run was going? For the night's commands: build, deliver, build-now.
//
// Every time limit in a build goes by the wall clock. A Mac that sleeps in the middle of a build
// (its lid closed on battery, say) wakes hours later with the build's process just as it was and
// its time limit long past: a good idea would be failed for good ("ran past its time limit") and
// the wearer told "couldn't finish". So a run watches for the sleep itself, and when it sees one
// it stops what was in progress the way a stop signal would. A build stopped that way on its
// first start gets one more try on a later night (core allows two starts, so one stopped on its
// second start counts as failed), and a delivery leaves its ideas for the next run.
//
// How a sleep is seen: a timer is set to tick every few seconds. While the Mac sleeps this
// process is frozen and the wall clock is not, so the first tick after waking arrives far later
// than it should.

export interface SleepWatchOptions {
  /** Called once, the first time the wall clock is found to have jumped: the process was frozen, so the Mac slept. */
  onSleep: (gapMs: number) => void;
  /** The wall clock, in milliseconds. Default Date.now. */
  now?: () => number;
  /** How often to look. Default every 5 seconds. */
  everyMs?: number;
  /** A tick that arrives this much later than it should means the Mac slept. Default one minute. */
  gapMs?: number;
  /** Replaced in tests. */
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
}

export const SLEEP_WATCH_EVERY_MS = 5_000;
export const SLEEP_WATCH_GAP_MS = 60_000;

/**
 * How the one log line a command writes when its watch fires begins. It promises nothing about
 * what comes next, because that depends on the work: each command adds its own sentence
 * (`sleptLine`).
 */
export const SLEPT_LINE = "the Mac went to sleep during the run; what was in progress was stopped";

/**
 * What follows a stop like that, for each kind of work. The build's is said as a rule: at the
 * moment the watch fires the command does not know which build was running, or whether it was on
 * its first start or its second (core's MAX_BUILD_STARTS is 2).
 */
export const SLEPT_THEN = {
  build: "A build that was on its first start is tried once more on a later night; one on its second start counts as failed",
  deliver: "What was not delivered waits for the next run",
  byHand: "Running the same command again carries on from there",
} as const;

/** The one log line a command writes when its watch fires: what happened, then what follows for that kind of work. */
export function sleptLine(work: keyof typeof SLEPT_THEN): string {
  return `${SLEPT_LINE}. ${SLEPT_THEN[work]}`;
}

export interface SleepWatch {
  /** Stop looking. Safe to call more than once. */
  stop(): void;
  /**
   * Look at the clock right now, as the timer's next tick would, and call `onSleep` if it has
   * jumped. For a command whose time limit came due in the same instant as this watch's tick
   * (the Mac has just woken): whichever timer Node ran first, the sleep is seen. Optional: a
   * watch without it is only ever asked through its own timer.
   */
  look?(): void;
}

/** How a command gets its watch. The command line passes the real one; tests pass their own. */
export type WatchForSleep = (options: SleepWatchOptions) => SleepWatch;

/** Watches for the Mac having slept while a run was going. The timer never keeps the process alive. */
export const watchForSleep: WatchForSleep = (options) => {
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? SLEEP_WATCH_EVERY_MS;
  const gapMs = options.gapMs ?? SLEEP_WATCH_GAP_MS;
  const clearTimer = options.clearTimer ?? clearInterval;
  let last = now();
  let over = false;
  /**
   * One look at the clock. The timer's own tick moves the mark it measures from; a look asked for
   * in between two ticks leaves it where it was, so the tick that follows measures as it always did.
   */
  const lookNow = (isTick: boolean): void => {
    if (over) return;
    const at = now();
    const late = at - last - everyMs;
    if (isTick) last = at;
    // A clock that was set back gives a negative number here, which is no sleep either. So does a
    // look in between two ticks: less than `everyMs` has passed since the mark.
    if (late < gapMs) return;
    over = true;
    clearTimer(timer);
    try {
      options.onSleep(late);
    } catch {
      // Whatever the caller does with the news, the watch itself is done.
    }
  };
  const timer = (options.setTimer ?? setInterval)(() => lookNow(true), everyMs);
  timer.unref?.();
  return {
    stop() {
      over = true;
      clearTimer(timer);
    },
    look: () => lookNow(false),
  };
};
