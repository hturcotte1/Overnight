// How long was the Mac asleep while an agent ran?
//
// What a try cost is worked out from how long its agent ran: the estimate is 2 credits a minute,
// and a builder's own figure is believed only when it fits that time (night.ts). The time comes
// off the wall clock, and the wall clock keeps going while the Mac sleeps. A build that the lid
// was closed on two minutes in, and that was stopped when the Mac woke six hours later, was
// counted as a full-length try: 90 credits for an agent that worked for two minutes. Five nights
// like that closed the month. So the time asleep is measured here and left out.
//
// How a sleep is seen: the way the command line's own sleep watch sees it
// (packages/cli/src/sleep-watch.ts), with the same two figures. A timer is set to tick every few
// seconds. While the Mac sleeps this process is frozen and the wall clock is not, so the first
// tick after waking arrives far later than it should. That lateness is the time asleep. Unlike
// the command line's watch, this one stops nothing and keeps counting: a Mac can sleep more than
// once during one build.
//
// The watch reads the real clock and real timers unless it is given others. A backend's own
// clock (which tests replace) is not used for it: on a made-up clock that a test moves by hand,
// no time is ever "asleep".

export interface SleptWatchOptions {
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

export interface SleptWatch {
  /** Stop watching. Answers how long the Mac slept since the watch began, in milliseconds. Safe to call twice. */
  stop(): number;
}

/** How a backend gets its watch. The real one unless a test passes its own. */
export type StartSleptWatch = () => SleptWatch;

export const SLEPT_WATCH_EVERY_MS = 5_000;
export const SLEPT_WATCH_GAP_MS = 60_000;

/** Counts the time the Mac sleeps from now until `stop()`. The timer never keeps the process alive. */
export function watchSlept(options: SleptWatchOptions = {}): SleptWatch {
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? SLEPT_WATCH_EVERY_MS;
  const gapMs = options.gapMs ?? SLEPT_WATCH_GAP_MS;
  const clearTimer = options.clearTimer ?? clearInterval;
  let last = now();
  let sleptMs = 0;
  let over = false;
  /** One look at the clock. `dueMs` is how long after the last look this one was due. */
  const look = (dueMs: number): void => {
    const at = now();
    const late = at - last - dueMs;
    last = at;
    // A clock that was set back gives a negative number here, which is no sleep either.
    if (late >= gapMs) sleptMs += late;
  };
  const timer = (options.setTimer ?? setInterval)(() => {
    if (!over) look(everyMs);
  }, everyMs);
  timer.unref?.();
  return {
    stop() {
      if (over) return sleptMs;
      over = true;
      clearTimer(timer);
      // A run can end before the tick that was overdue when the Mac woke has arrived. So one
      // last look, due at once: the last tick was under five seconds ago unless the Mac slept
      // since.
      look(0);
      return sleptMs;
    },
  };
}

/**
 * How long an agent was really at work: the time on the clock from its start to its end, less
 * the time the Mac slept in between, and never less than nothing.
 */
export function awakeMs(startedMs: number, endedMs: number, sleptMs: number): number {
  return Math.max(0, endedMs - startedMs - Math.max(0, sleptMs));
}
