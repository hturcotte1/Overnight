// Did the Mac sleep while a run was going? For the night's commands: build, deliver, build-now.
//
// Every time limit in a build goes by the wall clock. A Mac that sleeps in the middle of a build
// (its lid closed on battery, say) wakes hours later with the build's process just as it was and
// its time limit long past: a good idea would be failed for good ("ran past its time limit") and
// the wearer told "couldn't finish". So a run watches for the sleep itself, and when it sees one
// it stops what was in progress the way a stop signal would. A build stopped that way gets one
// more try on a later night, and a delivery leaves its ideas for the next morning.
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
/** The one log line a command writes when its watch fires. */
export const SLEPT_LINE = "the Mac went to sleep during the run; what was in progress was stopped and will be tried again";

/** How a command gets its watch. The command line passes the real one; tests pass their own. */
export type WatchForSleep = (options: SleepWatchOptions) => { stop(): void };

/** Watches for the Mac having slept while a run was going. The timer never keeps the process alive. */
export const watchForSleep: WatchForSleep = (options) => {
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? SLEEP_WATCH_EVERY_MS;
  const gapMs = options.gapMs ?? SLEEP_WATCH_GAP_MS;
  const clearTimer = options.clearTimer ?? clearInterval;
  let last = now();
  let over = false;
  const timer = (options.setTimer ?? setInterval)(() => {
    if (over) return;
    const at = now();
    const late = at - last - everyMs;
    last = at;
    // A clock that was set back gives a negative number here, which is no sleep either.
    if (late < gapMs) return;
    over = true;
    clearTimer(timer);
    try {
      options.onSleep(late);
    } catch {
      // Whatever the caller does with the news, the watch itself is done.
    }
  }, everyMs);
  timer.unref?.();
  return {
    stop() {
      over = true;
      clearTimer(timer);
    },
  };
};
