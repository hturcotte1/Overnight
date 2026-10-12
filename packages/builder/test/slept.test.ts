// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The watch that measures how long the Mac slept while an agent ran. Every clock and timer here
// is the test's own, except where a test says "real": those run the real ones for a moment.
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { awakeMs, SLEPT_WATCH_EVERY_MS, SLEPT_WATCH_GAP_MS, watchSlept } from "../src/slept.ts";
import { clockedSleptWatch, HOUR, MINUTE, movableClock, SECOND } from "./helpers.ts";

/** A watch whose timer the test fires by hand, on a clock the test moves. */
function manualWatch(options: { everyMs?: number; gapMs?: number } = {}) {
  const clock = movableClock();
  const set: Array<{ timer: () => void; everyMs: number }> = [];
  const cleared: unknown[] = [];
  const watch = watchSlept({
    now: clock.ms,
    ...options,
    setTimer: ((timer: () => void, everyMs: number) => (set.push({ timer, everyMs }), timer)) as unknown as typeof setInterval,
    clearTimer: ((timer: unknown) => void cleared.push(timer)) as unknown as typeof clearInterval,
  });
  /** Time passes and the timer fires. */
  const tickAfter = (ms: number): void => {
    clock.advance(ms);
    set[0]?.timer();
  };
  return { clock, watch, set, cleared, tickAfter };
}

describe("the watch for time asleep", () => {
  it("uses the two figures the command line's own sleep watch uses: a look every 5 seconds, and a minute late means asleep", () => {
    expect([SLEPT_WATCH_EVERY_MS, SLEPT_WATCH_GAP_MS]).toEqual([5_000, 60_000]);
    const { set } = manualWatch();
    expect(set).toHaveLength(1);
    expect(set[0]?.everyMs).toBe(5_000);
  });

  it("counts nothing while the ticks come when they should, however long the run", () => {
    const { watch, tickAfter } = manualWatch();
    for (let n = 0; n < 45 * 12; n += 1) tickAfter(5 * SECOND);
    expect(watch.stop()).toBe(0);
  });

  it("counts nothing for a tick that is late by less than a minute: a busy Mac is not a sleeping one", () => {
    const { watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    tickAfter(64 * SECOND + 999);
    tickAfter(5 * SECOND);
    expect(watch.stop()).toBe(0);
  });

  it("counts how late the tick was when it is a minute late or more: that is the time asleep", () => {
    const { watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    // Exactly a minute late.
    tickAfter(65 * SECOND);
    tickAfter(5 * SECOND);
    expect(watch.stop()).toBe(MINUTE);

    const long = manualWatch();
    long.tickAfter(5 * SECOND);
    long.tickAfter(6 * HOUR + 5 * SECOND);
    expect(long.watch.stop()).toBe(6 * HOUR);
  });

  it("keeps counting after a sleep: a Mac can sleep more than once during one build", () => {
    const { watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    tickAfter(2 * HOUR + 5 * SECOND);
    for (let n = 0; n < 12; n += 1) tickAfter(5 * SECOND);
    tickAfter(3 * HOUR + 5 * SECOND);
    tickAfter(5 * SECOND);
    expect(watch.stop()).toBe(5 * HOUR);
  });

  it("sees a sleep that ended just before the run did, when the overdue tick has not arrived yet", () => {
    const { clock, watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    // Four seconds after a tick the lid is closed. Six hours later the Mac wakes and the run
    // ends at once, before the timer has fired.
    clock.advance(4 * SECOND + 6 * HOUR);
    expect(watch.stop()).toBe(4 * SECOND + 6 * HOUR);
  });

  it("does not take the last few seconds of a run for a sleep", () => {
    const { clock, watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    clock.advance(4 * SECOND + 999);
    expect(watch.stop()).toBe(0);
  });

  it("counts nothing when the clock is set back", () => {
    const { watch, tickAfter } = manualWatch();
    tickAfter(5 * SECOND);
    tickAfter(-HOUR);
    tickAfter(5 * SECOND);
    expect(watch.stop()).toBe(0);
  });

  it("clears its timer when it is stopped, answers the same again, and counts nothing after that", () => {
    const { clock, watch, set, cleared, tickAfter } = manualWatch();
    tickAfter(2 * HOUR + 5 * SECOND);
    expect(watch.stop()).toBe(2 * HOUR);
    expect(cleared).toEqual([set[0]?.timer]);
    // A tick that was already on its way, and a second stop, hours later.
    tickAfter(3 * HOUR);
    clock.advance(3 * HOUR);
    expect(watch.stop()).toBe(2 * HOUR);
    expect(cleared).toHaveLength(1);
  });

  it("goes by the figures it is given", () => {
    const { watch, tickAfter } = manualWatch({ everyMs: SECOND, gapMs: 10 * SECOND });
    tickAfter(SECOND);
    tickAfter(10 * SECOND + 999);
    expect(watch.stop()).toBe(0);
    const late = manualWatch({ everyMs: SECOND, gapMs: 10 * SECOND });
    late.tickAfter(11 * SECOND);
    expect(late.watch.stop()).toBe(10 * SECOND);
  });

  it("the real watch, on the real clock: nothing asleep in a moment, and its timer does not keep the process alive", async () => {
    const watch = watchSlept({ everyMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(watch.stop()).toBe(0);
    // With no figures given it starts, and stops, the same way.
    expect(watchSlept().stop()).toBe(0);
    // (A timer that kept the process alive would hang this test file at its end.)
  });
});

/**
 * The real watch in a real process of its own, with short figures (a look every 50 ms, a second
 * late means asleep). It prints "watching", and when it is sent a line it prints what it counted.
 */
const WATCHER = `
import { watchSlept } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "slept.ts"))};
const watch = watchSlept({ everyMs: 50, gapMs: 1000 });
process.stdin.once("data", () => { console.log(String(watch.stop())); process.exit(0); });
console.log("watching");
`;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the watcher, leave it for a second and a half (frozen, or not), and ask what it counted. */
async function watchedFor(freeze: boolean): Promise<number> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", WATCHER], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const lines: string[] = [];
    let waiting: (() => void) | null = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lines.push(...chunk.split("\n").filter((line) => line !== ""));
      waiting?.();
    });
    const nextLine = async (): Promise<string> => {
      const limit = Date.now() + 15_000;
      while (lines.length === 0 && Date.now() < limit) {
        await Promise.race([new Promise<void>((resolve) => (waiting = resolve)), pause(200)]);
      }
      return lines.shift() ?? "(the watcher said nothing)";
    };
    expect(await nextLine()).toBe("watching");
    // Frozen is what a sleeping Mac's processes are: they do not run, and the wall clock does.
    if (freeze) child.kill("SIGSTOP");
    await pause(1_500);
    if (freeze) child.kill("SIGCONT");
    // Awake again for a moment, as a build is before it is stopped: the overdue tick arrives.
    await pause(300);
    child.stdin.write("how long?\n");
    return Number(await nextLine());
  } finally {
    child.kill("SIGKILL");
  }
}

describe("the real watch, real clock and real timers, in a process that is frozen", () => {
  it("counts the time a process was frozen, which is what sleep does to it, and nothing for one that ran all along", async () => {
    const [frozen, running] = await Promise.all([watchedFor(true), watchedFor(false)]);
    // Frozen for 1.5 seconds: all of it counted, give or take a look and the test's own timing.
    expect(frozen).toBeGreaterThanOrEqual(1_300);
    expect(frozen).toBeLessThan(5_000);
    expect(running).toBe(0);
  }, 40_000);
});

describe("the test's own way of putting a Mac to sleep (helpers.ts)", () => {
  it("awake time is not seen as sleep, and a sleep is seen to within one look", () => {
    const clock = movableClock();
    const mac = clockedSleptWatch(clock);
    expect(mac.running()).toBe(0);
    const watch = mac.start();
    expect(mac.running()).toBe(1);
    mac.awake(2 * MINUTE);
    mac.asleep(6 * HOUR);
    mac.awake(7 * SECOND);
    expect(watch.stop()).toBe(6 * HOUR - 5 * SECOND);
    expect(mac.running()).toBe(0);
  });
});

describe("how long an agent was really at work", () => {
  it("is the time on the clock less the time asleep, and never less than nothing", () => {
    expect(awakeMs(1_000, 6 * HOUR + 2 * MINUTE + 1_000, 6 * HOUR)).toBe(2 * MINUTE);
    expect(awakeMs(1_000, 3 * MINUTE + 1_000, 0)).toBe(3 * MINUTE);
    // A clock set back in the middle, or a watch that counted more than passed.
    expect(awakeMs(5_000, 1_000, 0)).toBe(0);
    expect(awakeMs(0, MINUTE, 2 * MINUTE)).toBe(0);
    expect(awakeMs(0, MINUTE, -HOUR)).toBe(MINUTE);
  });
});
