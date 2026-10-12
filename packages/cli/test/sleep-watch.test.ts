// Nothing here sleeps or waits: the clock and the timer are made up, and each tick is given by hand.
import { describe, expect, it } from "vitest";
import { SLEEP_WATCH_EVERY_MS, SLEEP_WATCH_GAP_MS, SLEPT_LINE, watchForSleep } from "../src/sleep-watch.ts";
import type { SleepWatchOptions } from "../src/sleep-watch.ts";

/** A made-up timer and wall clock. `tick(lateMs)` is one firing of the timer, that much later than it was due. */
function madeUpClock(start = 1_000_000) {
  let now = start;
  let fire: (() => void) | null = null;
  let everyMs = 0;
  const handle = { unrefs: 0, cleared: 0, unref: () => void (handle.unrefs += 1) };
  const setTimer = ((callback: () => void, ms: number) => {
    fire = callback;
    everyMs = ms;
    return handle;
  }) as unknown as typeof setInterval;
  const clearTimer = ((given: unknown) => {
    if (given === handle) {
      handle.cleared += 1;
      fire = null;
    }
  }) as unknown as typeof clearInterval;
  const slept: number[] = [];
  const options: SleepWatchOptions = { onSleep: (gapMs) => void slept.push(gapMs), now: () => now, setTimer, clearTimer };
  return {
    options,
    slept,
    handle,
    everyMs: () => everyMs,
    /** Is the timer still set? */
    ticking: () => fire !== null,
    /** The timer fires, `lateMs` after it was due. */
    tick(lateMs = 0) {
      now += everyMs + lateMs;
      fire?.();
    },
    /** The wall clock is set back. */
    setBack(ms: number) {
      now -= ms;
    },
  };
}

describe("watching for the Mac having slept", () => {
  it("looks every five seconds, takes a tick a minute late as a sleep, and never holds the process open", () => {
    const clock = madeUpClock();
    watchForSleep(clock.options);
    expect(clock.everyMs()).toBe(5_000);
    expect(SLEEP_WATCH_EVERY_MS).toBe(5_000);
    expect(SLEEP_WATCH_GAP_MS).toBe(60_000);
    // unref: this timer alone never keeps the process alive.
    expect(clock.handle.unrefs).toBe(1);
    expect(SLEPT_LINE).toBe("the Mac went to sleep during the run; what was in progress was stopped and will be tried again");
  });

  it("says nothing while the clock keeps step, however long, and however unevenly the ticks come", () => {
    const clock = madeUpClock();
    watchForSleep(clock.options);
    for (let i = 0; i < 1_000; i += 1) clock.tick();
    // A busy process is late by seconds, not by a minute. Lateness does not add up from tick to tick.
    for (let i = 0; i < 50; i += 1) clock.tick(59_999);
    expect(clock.slept).toEqual([]);
    expect(clock.ticking()).toBe(true);
  });

  it("fires once when the clock has jumped, with how far, and then stops looking", () => {
    const clock = madeUpClock();
    watchForSleep(clock.options);
    clock.tick();
    clock.tick();
    // The process was frozen for two hours: the next tick comes that much late.
    clock.tick(2 * 3_600_000);
    expect(clock.slept).toEqual([2 * 3_600_000]);
    expect(clock.ticking()).toBe(false);
    expect(clock.handle.cleared).toBe(1);
    // A second sleep is nobody's news: the run was already told to stop.
    clock.tick(3_600_000);
    expect(clock.slept).toHaveLength(1);
  });

  it("fires for a tick exactly a minute late, and not for one a millisecond short of it", () => {
    const short = madeUpClock();
    watchForSleep(short.options);
    short.tick(59_999);
    expect(short.slept).toEqual([]);
    const exact = madeUpClock();
    watchForSleep(exact.options);
    exact.tick(60_000);
    expect(exact.slept).toEqual([60_000]);
  });

  it("goes by the settings it is given", () => {
    const clock = madeUpClock();
    watchForSleep({ ...clock.options, everyMs: 200, gapMs: 1_000 });
    expect(clock.everyMs()).toBe(200);
    clock.tick(999);
    expect(clock.slept).toEqual([]);
    clock.tick(1_000);
    expect(clock.slept).toEqual([1_000]);
  });

  it("does not take a clock that was set back for a sleep", () => {
    const clock = madeUpClock();
    watchForSleep(clock.options);
    clock.tick();
    clock.setBack(3_600_000);
    clock.tick();
    clock.tick();
    expect(clock.slept).toEqual([]);
  });

  it("stops looking when it is told to: the timer is cleared and nothing fires after", () => {
    const clock = madeUpClock();
    const watch = watchForSleep(clock.options);
    clock.tick();
    watch.stop();
    expect(clock.handle.cleared).toBe(1);
    expect(clock.ticking()).toBe(false);
    clock.tick(3_600_000);
    expect(clock.slept).toEqual([]);
    // Safe to call again.
    watch.stop();
  });

  it("is done even when the caller's own handling of the news throws", () => {
    const clock = madeUpClock();
    let told = 0;
    watchForSleep({
      ...clock.options,
      onSleep: () => {
        told += 1;
        throw new Error("made-up failure");
      },
    });
    expect(() => clock.tick(120_000)).not.toThrow();
    expect(told).toBe(1);
    expect(clock.ticking()).toBe(false);
  });

  it("with the real timer: sets one that does not hold the process open, and clears it", () => {
    const watch = watchForSleep({ onSleep: () => {}, everyMs: 3_600_000 });
    // If this timer held the process open, the test run would not end for an hour.
    watch.stop();
  });
});
