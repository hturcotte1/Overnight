// The night clock's every-minute check, on fakes: a store that is a Map, made-up locks, a made-up
// clock, a made-up internet and a wait that takes no time. Nothing is built, nothing is delivered,
// and no real lock, log file, network or Bee is touched.
//
// All times are UTC. The settings are Boise's: in October 1:00 am is 07:00Z and 6:30 am is 12:30Z.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closedRun,
  currentSlot,
  DELIVER_WAITS_FOR_BUILD_MS,
  LATE_AFTER_MS,
  NIGHT_CHECK_FRESH_MS,
  noteChecked,
  noticedRun,
  readCheckedAt,
  readLastNightRun,
  readNightRun,
  SETTLE_MS,
  startedRun,
  waitingRun,
  WOKE_GAP_MS,
  writeNightRun,
} from "@overnight/core";
import type { ClockedJob, NightClockConfig, NightRun } from "@overnight/core";
import { buildJobAlive, nextStartAt, nightLockFile, nightTick, NOT_STARTING_AFTER_MS, runNotStarting, startClockFromNow, WAITING_FOR } from "../src/commands/night-tick.ts";
import type { NightRunMarks, NightTickDeps } from "../src/commands/night-tick.ts";
import type { ReleaseLock } from "../src/single-instance.ts";
import { capture, plain } from "./helpers.ts";
import { collectingLogger } from "./night-fakes.ts";

const config: NightClockConfig = { timeZone: "America/Boise", buildTime: "01:00", deliverTime: "07:00" };
const ROOT = "/made-up/data";
const paths = { root: ROOT };
const MINUTE = 60_000;
const ms = (iso: string) => Date.parse(iso);
const iso = (at: number) => new Date(at).toISOString();

/** The night of Oct 12: the build's time, and the delivery's. */
const BUILD_AT = "2026-10-12T07:00:00.000Z";
const DELIVER_AT = "2026-10-12T12:30:00.000Z";

type Hand = Parameters<NightTickDeps["run"]>[0];

interface SetUp {
  job?: ClockedJob;
  /** The time of the first check. */
  at: string;
  /** What the work does. Default: take its lock, mark the start, work for ten minutes, mark the end, let go, answer 0. */
  work?: (hand: Hand, t: Harness) => Promise<number> | number;
}

/** One data folder with both jobs' records in it, and one job's check to run against it. */
function setUp(options: SetUp) {
  const job = options.job ?? "build";
  const values = new Map<string, string>();
  const t = {
    job,
    values,
    /** Every key written, in order. */
    writes: [] as string[],
    /** Set to make every write fail, as a locked or broken database would. */
    writesFail: false,
    clock: ms(options.at),
    /** Lock files another process holds. */
    heldElsewhere: new Set<string>(),
    /** Lock files that cannot be used at all. */
    broken: new Set<string>(),
    /** What happened, in order: the internet asked, locks taken and let go, the work run. */
    order: [] as string[],
    lockHeldAsked: [] as string[],
    online: true,
    sleeps: [] as number[],
    /** How long a wait really takes. Default: as long as it was asked to. */
    sleepTakes: null as number | null,
    loggersMade: 0,
    log: collectingLogger(job),
    err: capture(),
    runs: 0,
    /** The records as the work found them when it was called. */
    seenByWork: [] as Array<NightRun | null>,
    store: {
      getValue: (key: string): string | null => values.get(key) ?? null,
      setValue: (key: string, value: string): void => {
        if (t.writesFail) throw new Error("database is locked\n    at somewhere");
        t.writes.push(key);
        values.set(key, value);
      },
    },
    takeLock: (file: string): ReleaseLock | null => {
      const name = path.basename(file);
      if (t.broken.has(name)) throw new Error("unable to open database file\n    at somewhere");
      if (t.heldElsewhere.has(name) || t.heldByUs.has(name)) return null;
      t.heldByUs.add(name);
      t.order.push(`lock ${name}`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        t.heldByUs.delete(name);
        t.order.push(`release ${name}`);
      };
    },
    heldByUs: new Set<string>(),
    record: (of: ClockedJob = job) => readNightRun(t.store, of),
    last: (of: ClockedJob = job) => readLastNightRun(t.store, of),
    checkedAt: (of: ClockedJob = job) => readCheckedAt(t.store, of),
    /** Move the clock on and run one check. */
    tick: (at?: string) => {
      if (at !== undefined) t.clock = ms(at);
      return nightTick(deps);
    },
    /** A check each minute, from the minute after now, `count` times. Returns the exit codes. */
    minutes: async (count: number) => {
      const codes: number[] = [];
      for (let i = 0; i < count; i += 1) {
        t.clock += MINUTE;
        codes.push(await nightTick(deps));
      }
      return codes;
    },
    /** The log lines so far, as [level, message]. */
    logged: () => t.log.lines.map((line) => [line.level, line.message]),
  };
  const defaultWork = async (hand: Hand): Promise<number> => {
    const release = hand.takeLock(nightLockFile(job, paths));
    if (release === null) return 1;
    hand.marks.started();
    t.clock += 10 * MINUTE;
    hand.marks.ended("finished");
    release();
    return 0;
  };
  const deps: NightTickDeps = {
    job,
    store: t.store,
    config,
    paths,
    now: () => new Date(t.clock),
    logger: () => {
      t.loggersMade += 1;
      return t.log.logger;
    },
    takeLock: t.takeLock,
    lockHeld: (file) => {
      t.lockHeldAsked.push(file);
      const name = path.basename(file);
      return t.heldElsewhere.has(name) || t.heldByUs.has(name);
    },
    isOnline: async () => {
      t.order.push("online?");
      return t.online;
    },
    sleep: async (waitMs) => {
      t.sleeps.push(waitMs);
      t.clock += t.sleepTakes ?? waitMs;
    },
    writeError: t.err.write,
    run: async (hand) => {
      t.runs += 1;
      t.order.push("work");
      t.seenByWork.push(readNightRun(t.store, job));
      return (options.work ?? defaultWork)(hand, t);
    },
  };
  return t;
}
type Harness = ReturnType<typeof setUp>;

/** As the installer leaves a job: its clock started at `at`, so the slot before that counts as handled. */
function startedFrom(t: Harness, at: string, job: ClockedJob = t.job): void {
  const now = new Date(at);
  writeNightRun(t.store, job, closedRun(noticedRun(currentSlot(job, now, config), now), "first-check", now), now);
}

/** The job asked the clock at `at`: its heartbeat. */
function checked(t: Harness, at: string, job: ClockedJob = t.job): void {
  noteChecked(t.store, job, new Date(at));
}

/** A job that was installed yesterday afternoon and has been waking every minute since. */
function awakeSince(options: SetUp, lastCheck: string): Harness {
  const t = setUp(options);
  startedFrom(t, "2026-10-11T20:00:00.000Z");
  checked(t, lastCheck);
  t.writes.length = 0;
  return t;
}

describe("overnight build --if-due: a check that finds nothing due", () => {
  it("writes its heartbeat and is gone: no lock, no log, not a word, nothing asked of the internet", async () => {
    const t = awakeSince({ at: "2026-10-12T06:30:00.000Z" }, "2026-10-12T06:29:00.000Z");
    const before = t.record();

    expect(await t.tick()).toBe(0);
    expect(t.writes).toEqual(["night.build.checkedAt"]);
    expect(t.checkedAt()).toBe("2026-10-12T06:30:00.000Z");
    expect(t.record()).toEqual(before);
    expect(t.order).toEqual([]);
    expect(t.lockHeldAsked).toEqual([]);
    expect(t.loggersMade).toBe(0);
    expect(t.err.lines).toEqual([]);
    expect(t.sleeps).toEqual([]);
    expect(t.runs).toBe(0);
  });

  it("stays that way every minute until the job's time, also after hours asleep", async () => {
    const t = awakeSince({ at: "2026-10-12T00:00:00.000Z" }, "2026-10-11T23:59:00.000Z");
    expect(await t.minutes(30)).toEqual(Array.from({ length: 30 }, () => 0));
    // Asleep from 6:30 pm to 12:59 am: a gap, but nothing is due, so nothing waits and nothing is asked.
    expect(await t.tick("2026-10-12T06:59:00.000Z")).toBe(0);
    expect(t.order).toEqual([]);
    expect(t.sleeps).toEqual([]);
    expect(t.loggersMade).toBe(0);
    expect(t.runs).toBe(0);
    expect(t.writes.every((key) => key === "night.build.checkedAt")).toBe(true);
  });

  it("the deliver job, with nothing due, does not even look at the build's lock", async () => {
    const t = awakeSince({ job: "deliver", at: "2026-10-12T12:00:00.000Z" }, "2026-10-12T11:59:00.000Z");
    t.heldElsewhere.add("build.lock");
    expect(await t.tick()).toBe(0);
    expect(t.lockHeldAsked).toEqual([]);
    expect(t.writes).toEqual(["night.deliver.checkedAt"]);
  });
});

describe("overnight build --if-due: the job's first ever check", () => {
  it("takes the slot that has just passed as handled, says so once in the log, and runs nothing", async () => {
    // 2:00 am, an hour after the build's time, on a data folder the clock has never seen.
    const t = setUp({ at: "2026-10-12T08:00:00.000Z" });
    expect(await t.tick()).toBe(0);
    expect(t.record()).toEqual({ day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T08:00:00.000Z", startedAt: null, closedAt: "2026-10-12T08:00:00.000Z", closedAs: "first-check", waiting: null });
    expect(t.runs).toBe(0);
    // Under the job's lock, and without waiting or asking the internet first: nothing is going to start.
    expect(t.order).toEqual(["lock build.lock", "release build.lock"]);
    expect(t.sleeps).toEqual([]);
    expect(t.log.lines).toHaveLength(1);
    expect(t.log.lines[0]).toMatchObject({ level: "info", message: "night clock: first check, so this slot counts as handled; the first run comes at the next one", job: "build", slotDay: "2026-10-12" });
    // It was not a run, so there is no "last run".
    expect(t.last()).toBeNull();

    // The next minute, and every one until the next night: nothing.
    expect(await t.minutes(3)).toEqual([0, 0, 0]);
    expect(t.log.lines).toHaveLength(1);
    expect(t.order).toEqual(["lock build.lock", "release build.lock"]);

    // The first run is the next slot's.
    expect(await t.tick("2026-10-13T07:00:30.000Z")).toBe(0);
    expect(t.runs).toBe(1);
    expect(t.record()).toMatchObject({ day: "2026-10-13", closedAs: "done" });
  });
});

describe("overnight build --if-due: the job's time has come", () => {
  it("asks the internet, takes the lock once, writes the start down before the work and the end after it", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    expect(await t.tick()).toBe(0);

    expect(t.runs).toBe(1);
    // The work asks for "its" lock and is handed the one the check already holds: taken once, let go once.
    expect(t.order).toEqual(["online?", "lock build.lock", "work", "release build.lock"]);
    expect(t.sleeps).toEqual([]);
    // What the work found when it was called: the slot noticed, stored, and not yet started.
    expect(t.seenByWork).toEqual([{ day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T07:00:30.000Z", startedAt: null, closedAt: null, closedAs: null, waiting: null }]);
    const done = { day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T07:00:30.000Z", startedAt: "2026-10-12T07:00:30.000Z", closedAt: "2026-10-12T07:10:30.000Z", closedAs: "done", waiting: null };
    expect(t.record()).toEqual(done);
    expect(t.last()).toEqual(done);
    expect(t.log.lines).toHaveLength(1);
    expect(t.log.lines[0]).toMatchObject({ level: "info", message: "night clock: starting", job: "build", slotDay: "2026-10-12", lateMinutes: 0 });
    expect(t.err.lines).toEqual([]);
  });

  it("starts nothing more for that slot: the minutes after it, and the whole day after it, are quiet", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    await t.tick();
    expect(await t.minutes(5)).toEqual([0, 0, 0, 0, 0]);
    expect(await t.tick("2026-10-12T23:00:00.000Z")).toBe(0);
    expect(await t.tick("2026-10-13T06:59:59.000Z")).toBe(0);
    expect(t.runs).toBe(1);
    expect(t.order).toEqual(["online?", "lock build.lock", "work", "release build.lock"]);
    // And the next night it runs again, once.
    expect(await t.tick("2026-10-13T07:00:10.000Z")).toBe(0);
    expect(t.runs).toBe(2);
    expect(t.record()).toMatchObject({ day: "2026-10-13", closedAs: "done" });
  });

  it("answers with the work's own exit code", async () => {
    const t = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand) => {
          hand.marks.started();
          hand.marks.ended("cut-short");
          return 143;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await t.tick()).toBe(143);
    expect(t.record()).toMatchObject({ closedAs: "cut-short", startedAt: "2026-10-12T07:00:30.000Z" });
    expect(t.last()).toMatchObject({ closedAs: "cut-short" });
  });

  it("decides again once it holds the lock: a slot another process handled in that instant is not run twice", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    // Between this check's first look and its lock, another process ran the slot and closed it.
    const takeLock = t.takeLock;
    t.takeLock = (file) => {
      const now = new Date(t.clock);
      writeNightRun(t.store, "build", closedRun(startedRun(noticedRun(currentSlot("build", now, config), now), now), "done", now), now);
      return takeLock(file);
    };
    const deps = { ...depsOf(t), takeLock: (file: string) => t.takeLock(file) };
    expect(await nightTick(deps)).toBe(0);
    expect(t.runs).toBe(0);
    expect(t.order).toEqual(["online?", "lock build.lock", "release build.lock"]);
  });

  it("leaves everything alone when another process holds the job's lock, and tries again the next minute", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    const before = t.record();
    // A build started by hand, or a build-now.
    t.heldElsewhere.add("build.lock");
    expect(await t.tick()).toBe(0);
    expect(await t.minutes(2)).toEqual([0, 0]);
    expect(t.runs).toBe(0);
    expect(t.record()).toEqual(before);
    expect(t.writes.every((key) => key === "night.build.checkedAt")).toBe(true);
    expect(t.loggersMade).toBe(0);
    expect(t.err.lines).toEqual([]);

    // That build ends. The slot is still due, so the next check runs it.
    t.heldElsewhere.clear();
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.runs).toBe(1);
  });

  it("hands the work the lock it holds for the job's own lock file, and the ordinary way to take any other", async () => {
    let handed: Hand | null = null;
    const t = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand) => {
          handed = hand;
          return 0;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    await t.tick();
    const hand = handed as Hand | null;
    if (hand === null) throw new Error("the work was not called");
    expect(nightLockFile("build", paths)).toBe(path.join(ROOT, "build.lock"));
    expect(nightLockFile("deliver", paths)).toBe(path.join(ROOT, "deliver.lock"));
    const again = hand.takeLock(path.join(ROOT, "build.lock"));
    expect(again).not.toBeNull();
    // Some other lock: taken the ordinary way, so it is free or it is not.
    const other = hand.takeLock(path.join(ROOT, "deliver.lock"));
    expect(other).not.toBeNull();
    other?.();
    t.heldElsewhere.add("deliver.lock");
    expect(hand.takeLock(path.join(ROOT, "deliver.lock"))).toBeNull();
  });
});

/** The deps of a harness, for the tests that need to swap one. */
function depsOf(t: Harness): NightTickDeps {
  return {
    job: t.job,
    store: t.store,
    config,
    paths,
    now: () => new Date(t.clock),
    logger: () => t.log.logger,
    takeLock: (file) => t.takeLock(file),
    lockHeld: (file) => t.heldElsewhere.has(path.basename(file)),
    isOnline: async () => {
      t.order.push("online?");
      return t.online;
    },
    sleep: async (waitMs) => {
      t.sleeps.push(waitMs);
      t.clock += t.sleepTakes ?? waitMs;
    },
    writeError: t.err.write,
    run: async (hand) => {
      t.runs += 1;
      t.order.push("work");
      hand.marks.started();
      hand.marks.ended("finished");
      return 0;
    },
  };
}

describe("overnight build --if-due: the Mac has only just woken", () => {
  it("waits one minute in place, then asks the internet and runs, and calls the run late", async () => {
    // Asleep from 9:00 pm. Awake at 3:00 am, two hours after the build's time.
    const t = awakeSince({ at: "2026-10-12T09:00:00.000Z" }, "2026-10-12T03:00:00.000Z");
    expect(await t.tick()).toBe(0);
    expect(t.sleeps).toEqual([SETTLE_MS]);
    expect(SETTLE_MS).toBe(60_000);
    expect(t.order).toEqual(["online?", "lock build.lock", "work", "release build.lock"]);
    expect(t.record()).toMatchObject({ day: "2026-10-12", noticedAt: "2026-10-12T09:01:00.000Z", startedAt: "2026-10-12T09:01:00.000Z", closedAs: "done" });
    // 121 minutes after 1:00 am: more than two minutes late is a warning.
    expect(t.log.lines[0]).toMatchObject({ level: "warn", message: "night clock: starting", lateMinutes: 121 });
    expect(LATE_AFTER_MS).toBe(120_000);
  });

  it("takes a check that comes up to two and a half minutes after the last one as no wake at all", async () => {
    const exactly = awakeSince({ at: "2026-10-12T07:02:30.000Z" }, "2026-10-12T07:00:00.000Z");
    expect(WOKE_GAP_MS).toBe(150_000);
    await exactly.tick();
    expect(exactly.sleeps).toEqual([]);
    expect(exactly.runs).toBe(1);

    const over = awakeSince({ at: "2026-10-12T07:02:30.001Z" }, "2026-10-12T07:00:00.000Z");
    await over.tick();
    expect(over.sleeps).toEqual([SETTLE_MS]);
    expect(over.runs).toBe(1);
    expect(over.log.lines[0]).toMatchObject({ level: "warn", lateMinutes: 3 });
  });

  it("calls a start late, with a warning, only when it comes more than two minutes after the job's time", async () => {
    const onTime = awakeSince({ at: "2026-10-12T07:02:00.000Z" }, "2026-10-12T07:01:00.000Z");
    await onTime.tick();
    expect(onTime.log.lines[0]).toMatchObject({ level: "info", message: "night clock: starting", lateMinutes: 2 });
    const late = awakeSince({ at: "2026-10-12T07:02:00.001Z" }, "2026-10-12T07:01:00.000Z");
    await late.tick();
    expect(late.log.lines[0]).toMatchObject({ level: "warn", message: "night clock: starting", lateMinutes: 2 });
  });

  it("waits too when the job has a record but no heartbeat that can be read", async () => {
    const t = setUp({ at: "2026-10-12T07:00:30.000Z" });
    startedFrom(t, "2026-10-11T20:00:00.000Z");
    t.values.set("night.build.checkedAt", "not a time");
    await t.tick();
    expect(t.sleeps).toEqual([SETTLE_MS]);
    expect(t.runs).toBe(1);
  });

  it("starts nothing when the minute's wait took far longer than a minute: the Mac slept through it", async () => {
    // A moment's wake at 3:00 am. The process is frozen during its wait and thawed three hours later.
    const t = awakeSince({ at: "2026-10-12T09:00:00.000Z" }, "2026-10-12T03:00:00.000Z");
    const before = t.record();
    t.sleepTakes = 3 * 3_600_000;
    expect(await t.tick()).toBe(0);
    expect(t.sleeps).toEqual([SETTLE_MS]);
    expect(t.runs).toBe(0);
    // Nothing was asked, locked, written or logged: the next check starts over.
    expect(t.order).toEqual([]);
    expect(t.record()).toEqual(before);
    expect(t.loggersMade).toBe(0);

    // The next check, a minute after the thaw, sees a gap of its own, waits its minute, and runs.
    t.sleepTakes = null;
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.sleeps).toEqual([SETTLE_MS, SETTLE_MS]);
    expect(t.runs).toBe(1);
    expect(t.record()).toMatchObject({ startedAt: "2026-10-12T12:02:00.000Z", closedAs: "done" });
  });

  it("still runs when the wait took up to twice as long as asked", async () => {
    const t = awakeSince({ at: "2026-10-12T09:00:00.000Z" }, "2026-10-12T03:00:00.000Z");
    t.sleepTakes = 2 * SETTLE_MS;
    await t.tick();
    expect(t.runs).toBe(1);
    const slept = awakeSince({ at: "2026-10-12T09:00:00.000Z" }, "2026-10-12T03:00:00.000Z");
    slept.sleepTakes = 2 * SETTLE_MS + 1;
    await slept.tick();
    expect(slept.runs).toBe(0);
  });
});

describe("overnight build --if-due: no real internet", () => {
  it("does not run, stores why and logs it once, asks again each minute, and runs once the internet answers", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    t.online = false;
    expect(await t.tick()).toBe(0);
    expect(t.runs).toBe(0);
    const waiting = { day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T07:00:30.000Z", startedAt: null, closedAt: null, closedAs: null, waiting: "offline" };
    expect(t.record()).toEqual(waiting);
    expect(t.logged()).toEqual([["info", "night clock: waiting for the internet"]]);
    expect(t.log.lines[0]).toMatchObject({ job: "build", slotDay: "2026-10-12", reason: "offline" });
    expect(t.order).toEqual(["online?", "lock build.lock", "release build.lock"]);

    // Ten more minutes offline: asked each time, nothing more written about the slot or logged.
    t.writes.length = 0;
    expect(await t.minutes(10)).toEqual(Array.from({ length: 10 }, () => 0));
    expect(t.record()).toEqual(waiting);
    expect(t.logged()).toHaveLength(1);
    expect(t.writes.every((key) => key === "night.build.checkedAt")).toBe(true);
    expect(t.order.filter((step) => step === "online?")).toHaveLength(11);
    expect(t.runs).toBe(0);

    // The internet is back.
    t.online = true;
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.runs).toBe(1);
    // The work found the slot no longer waiting, and it started 11 minutes late.
    expect(t.seenByWork[0]).toEqual({ ...waiting, waiting: null });
    expect(t.record()).toMatchObject({ startedAt: "2026-10-12T07:11:30.000Z", closedAs: "done", waiting: null });
    expect(t.logged()).toEqual([
      ["info", "night clock: waiting for the internet"],
      ["warn", "night clock: starting"],
    ]);
    // Once is once.
    expect(await t.minutes(3)).toEqual([0, 0, 0]);
    expect(t.runs).toBe(1);
  });

  it("asks only about the internet: there is no rule about mains power, and nothing to ask it with", () => {
    const t = setUp({ at: BUILD_AT });
    expect(Object.keys(depsOf(t)).sort()).toEqual(["config", "isOnline", "job", "lockHeld", "logger", "now", "paths", "run", "sleep", "store", "takeLock", "writeError"]);
    expect(Object.keys(WAITING_FOR).sort()).toEqual(["build-not-started", "build-running", "offline"]);
  });
});

describe("overnight deliver --if-due: a late morning", () => {
  /** The deliver job, awake and due at 6:30 am, on a data folder whose build job is also on the clock. */
  function lateMorning(at: string, lastCheck: string) {
    const t = awakeSince({ job: "deliver", at }, lastCheck);
    return t;
  }

  it("waits for a build that is running, logs that once, and runs when the build has finished", async () => {
    const t = lateMorning("2026-10-12T12:30:10.000Z", "2026-10-12T12:29:10.000Z");
    // A build is running right now: something holds the build lock.
    t.heldElsewhere.add("build.lock");
    expect(await t.tick()).toBe(0);
    expect(t.lockHeldAsked.every((file) => file === path.join(ROOT, "build.lock"))).toBe(true);
    expect(t.lockHeldAsked.length).toBeGreaterThan(0);
    expect(t.runs).toBe(0);
    expect(t.record()).toEqual({ day: "2026-10-12", slotAt: DELIVER_AT, noticedAt: "2026-10-12T12:30:10.000Z", startedAt: null, closedAt: null, closedAs: null, waiting: "build-running" });
    expect(t.logged()).toEqual([["info", "night clock: waiting for the build to finish"]]);
    expect(t.log.lines[0]).toMatchObject({ job: "deliver", slotDay: "2026-10-12", reason: "build-running" });
    // The wait was stored under the deliver lock, with nothing asked of the internet: nothing was going to start.
    expect(t.order).toEqual(["lock deliver.lock", "release deliver.lock"]);

    // The minutes that follow: still waiting, and each check is over before it takes any lock.
    expect(await t.minutes(8)).toEqual(Array.from({ length: 8 }, () => 0));
    expect(t.order).toEqual(["lock deliver.lock", "release deliver.lock"]);
    expect(t.logged()).toHaveLength(1);
    expect(t.runs).toBe(0);

    // The build ends. The next check delivers.
    t.heldElsewhere.clear();
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.runs).toBe(1);
    expect(t.order).toEqual(["lock deliver.lock", "release deliver.lock", "online?", "lock deliver.lock", "work", "release deliver.lock"]);
    expect(t.record()).toMatchObject({ startedAt: "2026-10-12T12:39:10.000Z", closedAs: "done", waiting: null });
  });

  it("runs anyway once it has waited 20 minutes: that build's app goes out the next morning", async () => {
    const t = lateMorning("2026-10-12T12:30:10.000Z", "2026-10-12T12:29:10.000Z");
    t.heldElsewhere.add("build.lock");
    expect(DELIVER_WAITS_FOR_BUILD_MS).toBe(20 * MINUTE);
    await t.tick();
    expect(await t.minutes(19)).toEqual(Array.from({ length: 19 }, () => 0));
    expect(t.runs).toBe(0);
    // Twenty minutes after it first found itself due, with the build still going.
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.runs).toBe(1);
    expect(t.record()).toMatchObject({ startedAt: "2026-10-12T12:50:10.000Z", closedAs: "done" });
  });

  it("waits for a build that is due and about to start: its job is awake and its slot is still open", async () => {
    // The Mac woke at 10:00 am. The build job checked a moment ago and is waiting its minute in place.
    const t = lateMorning("2026-10-12T16:02:00.000Z", "2026-10-12T16:01:00.000Z");
    startedFrom(t, "2026-10-11T20:00:00.000Z", "build");
    checked(t, "2026-10-12T16:01:30.000Z", "build");
    expect(await t.tick()).toBe(0);
    expect(t.runs).toBe(0);
    expect(t.record()).toMatchObject({ waiting: "build-not-started" });
    expect(t.logged()).toEqual([["info", "night clock: waiting for the build, which has not started yet"]]);

    // The build starts: the reason changes, which is stored and logged once more.
    t.heldElsewhere.add("build.lock");
    await t.minutes(1);
    expect(t.record()).toMatchObject({ waiting: "build-running" });
    expect(t.logged()).toEqual([
      ["info", "night clock: waiting for the build, which has not started yet"],
      ["info", "night clock: waiting for the build to finish"],
    ]);
  });

  it("does not wait for a build whose job has stopped waking, or whose slot is already handled", async () => {
    // The build's slot is open, but its job last asked the clock four minutes ago and is not running.
    const stopped = lateMorning("2026-10-12T16:02:00.000Z", "2026-10-12T16:01:00.000Z");
    startedFrom(stopped, "2026-10-11T20:00:00.000Z", "build");
    checked(stopped, "2026-10-12T15:58:00.000Z", "build");
    expect(await stopped.tick()).toBe(0);
    expect(stopped.runs).toBe(1);

    // The build already ran this night.
    const handled = lateMorning("2026-10-12T16:02:00.000Z", "2026-10-12T16:01:00.000Z");
    startedFrom(handled, "2026-10-12T08:00:00.000Z", "build");
    checked(handled, "2026-10-12T16:01:30.000Z", "build");
    expect(await handled.tick()).toBe(0);
    expect(handled.runs).toBe(1);

    // No build job on the clock at all (it is not installed, or still on macOS's calendar).
    const none = lateMorning("2026-10-12T16:02:00.000Z", "2026-10-12T16:01:00.000Z");
    expect(await none.tick()).toBe(0);
    expect(none.runs).toBe(1);
  });

  it("knows the build job is awake by its lock or by a heartbeat of the last three minutes", () => {
    const now = new Date("2026-10-12T16:00:00.000Z");
    expect(NIGHT_CHECK_FRESH_MS).toBe(180_000);
    expect(buildJobAlive(null, true, now)).toBe(true);
    expect(buildJobAlive(null, false, now)).toBe(false);
    expect(buildJobAlive(null, null, now)).toBe(false);
    expect(buildJobAlive("2026-10-12T15:57:00.000Z", false, now)).toBe(true);
    expect(buildJobAlive("2026-10-12T15:56:59.999Z", false, now)).toBe(false);
    expect(buildJobAlive("2026-10-12T15:56:59.999Z", null, now)).toBe(false);
  });

  it("counts the 20 minutes from the wake, not from a moment's wake hours before: the delivery runs after the build", async () => {
    // 7:07 am: the Mac wakes for forty seconds. Both jobs find themselves due; the build job is
    // waiting its minute in place, so the deliver job stores that it waits for the build.
    const t = lateMorning("2026-10-12T13:07:00.000Z", "2026-10-12T03:00:00.000Z");
    startedFrom(t, "2026-10-11T20:00:00.000Z", "build");
    checked(t, "2026-10-12T13:07:00.000Z", "build");
    expect(await t.tick()).toBe(0);
    expect(t.record()).toMatchObject({ noticedAt: "2026-10-12T13:07:00.000Z", waiting: "build-not-started" });

    // 10:00 am: the lid is opened. The build job checks first and waits its minute; then the deliver job checks.
    checked(t, "2026-10-12T16:00:00.000Z", "build");
    expect(await t.tick("2026-10-12T16:00:05.000Z")).toBe(0);
    // Three hours have passed since 7:07, but none of them were minutes in which anything could run.
    expect(t.runs).toBe(0);
    expect(t.record()).toMatchObject({ noticedAt: "2026-10-12T16:00:05.000Z", waiting: "build-not-started" });

    // 10:01: the build starts. It takes ten minutes; the delivery waits for it.
    t.heldElsewhere.add("build.lock");
    expect(await t.minutes(10)).toEqual(Array.from({ length: 10 }, () => 0));
    expect(t.runs).toBe(0);
    t.heldElsewhere.clear();
    expect(await t.minutes(1)).toEqual([0]);
    expect(t.runs).toBe(1);
    expect(t.record()).toMatchObject({ startedAt: "2026-10-12T16:11:05.000Z", closedAs: "done" });
  });

  it("does not start a delivery on a first answer that was only to wait: a run needs the internet asked first", async () => {
    const t = lateMorning("2026-10-12T12:30:10.000Z", "2026-10-12T12:29:10.000Z");
    // The build holds its lock at this check's first look, and has let go by the second, under the deliver lock.
    let looks = 0;
    const deps: NightTickDeps = { ...depsOf(t), lockHeld: () => (looks += 1) === 1 };
    expect(await nightTick(deps)).toBe(0);
    expect(looks).toBe(2);
    expect(t.runs).toBe(0);
    expect(t.order).toEqual(["lock deliver.lock", "release deliver.lock"]);
    // Nothing was stored about the slot: the next check finds it due, asks the internet, and runs.
    expect(t.record()).toMatchObject({ day: "2026-10-11" });
    t.clock += MINUTE;
    expect(await nightTick({ ...depsOf(t), lockHeld: () => false })).toBe(0);
    expect(t.runs).toBe(1);
    expect(t.order).toEqual(["lock deliver.lock", "release deliver.lock", "online?", "lock deliver.lock", "work", "release deliver.lock"]);
  });
});

describe("overnight build --if-due: a run that did not end well", () => {
  it("closes a run that started and never ended as cut short, warns once, and starts nothing again for that slot", async () => {
    const t = awakeSince({ at: "2026-10-12T07:20:00.000Z" }, "2026-10-12T07:00:30.000Z");
    // The build started at 1:00 am and its process was killed: no end was written, and its lock is free.
    const started = startedRun(noticedRun(currentSlot("build", new Date("2026-10-12T07:00:30.000Z"), config), new Date("2026-10-12T07:00:30.000Z")), new Date("2026-10-12T07:00:31.000Z"));
    writeNightRun(t.store, "build", started, new Date("2026-10-12T07:00:31.000Z"));

    expect(await t.tick()).toBe(0);
    expect(t.runs).toBe(0);
    const closed = { ...started, closedAt: "2026-10-12T07:20:00.000Z", closedAs: "cut-short" };
    expect(t.record()).toEqual(closed);
    // It did start, so it is the job's last run.
    expect(t.last()).toEqual(closed);
    expect(t.log.lines).toHaveLength(1);
    expect(t.log.lines[0]).toMatchObject({ level: "warn", message: "night clock: a run that started never ended, so its slot is closed as cut short; nothing is started again for it", job: "build", slotDay: "2026-10-12", startedAt: "2026-10-12T07:00:31.000Z" });
    // No wait and no question to the internet: nothing was going to start.
    expect(t.order).toEqual(["lock build.lock", "release build.lock"]);
    expect(t.sleeps).toEqual([]);

    expect(await t.minutes(5)).toEqual([0, 0, 0, 0, 0]);
    expect(t.runs).toBe(0);
    expect(t.log.lines).toHaveLength(1);
  });

  it("leaves a run that is still going alone: its lock is held, so its record is not this check's to close", async () => {
    const t = awakeSince({ at: "2026-10-12T07:20:00.000Z" }, "2026-10-12T07:00:30.000Z");
    const started = startedRun(noticedRun(currentSlot("build", new Date("2026-10-12T07:00:30.000Z"), config), new Date("2026-10-12T07:00:30.000Z")), new Date("2026-10-12T07:00:31.000Z"));
    writeNightRun(t.store, "build", started, new Date("2026-10-12T07:00:31.000Z"));
    t.heldElsewhere.add("build.lock");
    expect(await t.tick()).toBe(0);
    expect(t.record()).toEqual(started);
    expect(t.loggersMade).toBe(0);
  });

  it("when the work gives up before it marked a start, leaves the slot due, and the next check tries again", async () => {
    let tries = 0;
    const t = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        // The builder would not load the first time.
        work: (hand) => {
          tries += 1;
          if (tries === 1) return 1;
          hand.marks.started();
          hand.marks.ended("finished");
          return 0;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await t.tick()).toBe(1);
    expect(t.record()).toEqual({ day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T07:00:30.000Z", startedAt: null, closedAt: null, closedAs: null, waiting: null });
    expect(t.last()).toBeNull();
    // The lock was let go by the check itself.
    expect(t.order).toEqual(["online?", "lock build.lock", "work", "release build.lock"]);

    expect(await t.minutes(1)).toEqual([0]);
    expect(tries).toBe(2);
    expect(t.record()).toMatchObject({ noticedAt: "2026-10-12T07:00:30.000Z", startedAt: "2026-10-12T07:01:30.000Z", closedAs: "done" });
  });

  it("closes the slot as cut short when the work marked a start and then threw, or never marked an end", async () => {
    const threw = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand) => {
          hand.marks.started();
          throw new Error("made-up failure\n    at somewhere");
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await threw.tick()).toBe(1);
    expect(threw.record()).toMatchObject({ startedAt: "2026-10-12T07:00:30.000Z", closedAs: "cut-short" });
    expect(threw.err.lines).toEqual(['"overnight build --if-due" could not check the night clock. made-up failure']);
    expect(threw.order.at(-1)).toBe("release build.lock");

    const silent = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand) => {
          hand.marks.started();
          return 0;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await silent.tick()).toBe(0);
    expect(silent.record()).toMatchObject({ closedAs: "cut-short" });
  });

  it("marks: a start that cannot be written throws and nothing counts as started; an end that cannot be written is logged and thrown nowhere", async () => {
    let marks: NightRunMarks | null = null;
    const outcome: string[] = [];
    const t = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand, harness) => {
          marks = hand.marks;
          harness.writesFail = true;
          try {
            hand.marks.started();
            outcome.push("started");
          } catch (error) {
            outcome.push(`start refused: ${(error as Error).message.split("\n")[0]}`);
          }
          // Not started, so there is nothing to end.
          hand.marks.ended("finished");
          harness.writesFail = false;
          return 1;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await t.tick()).toBe(1);
    expect(outcome).toEqual(["start refused: database is locked"]);
    expect(t.record()).toMatchObject({ startedAt: null, closedAt: null });
    expect(t.logged()).toEqual([]);
    expect(marks).not.toBeNull();

    // The end: the write fails, one error line says what happens next, and the caller's tidy-up goes on.
    const ending = awakeSince(
      {
        at: "2026-10-12T07:00:30.000Z",
        work: (hand, harness) => {
          hand.marks.started();
          // Calling it twice changes nothing.
          hand.marks.started();
          harness.writesFail = true;
          expect(() => hand.marks.ended("finished")).not.toThrow();
          harness.writesFail = false;
          // Too late to say it again: the run has said how it ended.
          hand.marks.ended("finished");
          return 0;
        },
      },
      "2026-10-12T06:59:30.000Z",
    );
    expect(await ending.tick()).toBe(0);
    expect(ending.logged()).toEqual([
      ["info", "night clock: starting"],
      ["error", "night clock: could not write down that the run ended; the next check closes its slot as cut short"],
    ]);
    expect(ending.log.lines[1]).toMatchObject({ job: "build", slotDay: "2026-10-12", reason: "database is locked" });
    expect(ending.record()).toMatchObject({ startedAt: "2026-10-12T07:00:30.000Z", closedAt: null });
    // And so it does.
    expect(await ending.minutes(1)).toEqual([0]);
    expect(ending.record()).toMatchObject({ closedAs: "cut-short" });
    expect(ending.runs).toBe(1);
  });
});

describe("overnight build --if-due: the check itself fails", () => {
  it("says so in one line on the error stream and exits 1 when the heartbeat cannot be written", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    t.writesFail = true;
    expect(await t.tick()).toBe(1);
    expect(t.err.lines).toEqual(['"overnight build --if-due" could not check the night clock. database is locked']);
    expect(t.order).toEqual([]);
    expect(t.runs).toBe(0);
    expect(t.loggersMade).toBe(0);
  });

  it("the same when the job's lock file cannot be used, with nothing started", async () => {
    const t = awakeSince({ job: "deliver", at: "2026-10-12T12:30:30.000Z" }, "2026-10-12T12:29:30.000Z");
    t.broken.add("deliver.lock");
    expect(await t.tick()).toBe(1);
    expect(t.err.lines).toEqual(['"overnight deliver --if-due" could not check the night clock. unable to open database file']);
    expect(t.runs).toBe(0);
  });
});

describe("overnight build --from-now", () => {
  function fromNow(t: Harness, job: ClockedJob = t.job) {
    const out = capture();
    const err = capture();
    const code = startClockFromNow({ job, store: t.store, config, paths, now: () => new Date(t.clock), takeLock: t.takeLock }, out.write, err.write);
    return { code, out: out.lines, err: err.lines };
  }

  it("on a data folder the clock has never seen: writes the current slot down as handled and says when the first run is", () => {
    // 2:00 pm on Oct 11, as at the switch-over.
    const t = setUp({ at: "2026-10-11T20:00:00.000Z" });
    const said = fromNow(t);
    expect(said).toEqual({ code: 0, out: ["The build clock starts from now: the next build is Oct 12, 1:00 AM (America/Boise)."], err: [] });
    expect(t.record()).toEqual({ day: "2026-10-11", slotAt: "2026-10-11T07:00:00.000Z", noticedAt: "2026-10-11T20:00:00.000Z", startedAt: null, closedAt: "2026-10-11T20:00:00.000Z", closedAs: "first-check", waiting: null });
    // Under the job's lock, which it lets go of. It is not a check, so it writes no heartbeat.
    expect(t.order).toEqual(["lock build.lock", "release build.lock"]);
    expect(t.checkedAt()).toBeNull();

    const deliver = setUp({ job: "deliver", at: "2026-10-11T20:00:00.000Z" });
    expect(fromNow(deliver)).toEqual({ code: 0, out: ["The deliver clock starts from now: the next deliver is Oct 12, 6:30 AM (America/Boise)."], err: [] });
    expect(deliver.record()).toMatchObject({ day: "2026-10-11", slotAt: "2026-10-11T12:30:00.000Z", closedAs: "first-check" });
  });

  it("closes a slot that was due and had not run: nothing missed before now is run", async () => {
    // The Mac was off for three days. At 10:00 am the job is installed again.
    const t = setUp({ at: "2026-10-12T16:00:00.000Z" });
    startedFrom(t, "2026-10-08T20:00:00.000Z");
    expect(fromNow(t).code).toBe(0);
    expect(t.record()).toMatchObject({ day: "2026-10-12", slotAt: BUILD_AT, startedAt: null, closedAs: "first-check" });
    // So the every-minute check finds nothing due until 1:00 am the next night.
    checked(t, "2026-10-12T16:00:00.000Z");
    expect(await t.minutes(3)).toEqual([0, 0, 0]);
    expect(t.runs).toBe(0);

    // Today's slot, noticed and waiting for the internet: closed too, and no longer waiting.
    const waiting = setUp({ at: "2026-10-12T07:30:00.000Z" });
    const now = new Date("2026-10-12T07:00:30.000Z");
    writeNightRun(waiting.store, "build", waitingRun(noticedRun(currentSlot("build", now, config), now), "offline"), now);
    expect(fromNow(waiting).code).toBe(0);
    expect(waiting.record()).toEqual({ day: "2026-10-12", slotAt: BUILD_AT, noticedAt: "2026-10-12T07:00:30.000Z", startedAt: null, closedAt: "2026-10-12T07:30:00.000Z", closedAs: "first-check", waiting: null });
  });

  it("leaves a record of today's slot that is already closed exactly as it is", () => {
    const t = setUp({ at: "2026-10-12T16:00:00.000Z" });
    const ran = closedRun(startedRun(noticedRun(currentSlot("build", new Date(BUILD_AT), config), new Date(BUILD_AT)), new Date(BUILD_AT)), "done", new Date("2026-10-12T07:20:00.000Z"));
    writeNightRun(t.store, "build", ran, new Date("2026-10-12T07:20:00.000Z"));
    t.writes.length = 0;
    expect(fromNow(t)).toEqual({ code: 0, out: ["The build clock starts from now: the next build is Oct 13, 1:00 AM (America/Boise)."], err: [] });
    expect(t.record()).toEqual(ran);
    expect(t.writes).toEqual([]);
  });

  it("closes a run of today's slot that started and died as cut short, and frees a record that is dated ahead", () => {
    const died = setUp({ at: "2026-10-12T16:00:00.000Z" });
    const started = startedRun(noticedRun(currentSlot("build", new Date(BUILD_AT), config), new Date(BUILD_AT)), new Date(BUILD_AT));
    writeNightRun(died.store, "build", started, new Date(BUILD_AT));
    expect(fromNow(died).code).toBe(0);
    expect(died.record()).toEqual({ ...started, closedAt: "2026-10-12T16:00:00.000Z", closedAs: "cut-short" });
    expect(died.last()).toMatchObject({ closedAs: "cut-short" });

    // The Mac's clock once read January: the record is months ahead, and the job would start nothing until then.
    const ahead = setUp({ at: "2026-10-12T16:00:00.000Z" });
    startedFrom(ahead, "2027-01-05T20:00:00.000Z");
    expect(ahead.record()).toMatchObject({ day: "2027-01-05" });
    expect(fromNow(ahead).code).toBe(0);
    expect(ahead.record()).toMatchObject({ day: "2026-10-12", closedAs: "first-check" });
  });

  it("refuses while the job's lock is held, in words for the error stream, and changes nothing", () => {
    const t = setUp({ at: "2026-10-12T07:10:00.000Z" });
    startedFrom(t, "2026-10-11T20:00:00.000Z");
    const before = t.record();
    t.writes.length = 0;
    t.heldElsewhere.add("build.lock");
    expect(fromNow(t)).toEqual({ code: 1, out: [], err: ["A build is running right now on this data folder. Try again when it has finished. Nothing was changed."] });
    expect(t.record()).toEqual(before);
    expect(t.writes).toEqual([]);

    const deliver = setUp({ job: "deliver", at: "2026-10-12T12:40:00.000Z" });
    deliver.heldElsewhere.add("deliver.lock");
    expect(fromNow(deliver)).toEqual({ code: 1, out: [], err: ["A deliver is running right now on this data folder. Try again when it has finished. Nothing was changed."] });
    // Only its own lock counts: a build that is running does not stop the deliver job's clock being started.
    const other = setUp({ job: "deliver", at: "2026-10-12T12:40:00.000Z" });
    other.heldElsewhere.add("build.lock");
    expect(fromNow(other).code).toBe(0);
  });

  it("says so and exits 1 when its lock or the database cannot be used", () => {
    const noLock = setUp({ at: "2026-10-12T16:00:00.000Z" });
    noLock.broken.add("build.lock");
    expect(fromNow(noLock)).toEqual({ code: 1, out: [], err: ["Overnight could not use its build lock. unable to open database file Nothing was changed."] });

    const noWrite = setUp({ at: "2026-10-12T16:00:00.000Z" });
    noWrite.writesFail = true;
    expect(fromNow(noWrite)).toEqual({ code: 1, out: [], err: ["The build clock could not be started from now. database is locked"] });
    // The lock was let go all the same.
    expect(noWrite.order).toEqual(["lock build.lock", "release build.lock"]);
  });

  it("prints both lines through the one writer when it is given only one", () => {
    const t = setUp({ at: "2026-10-12T07:10:00.000Z" });
    t.heldElsewhere.add("build.lock");
    const out = capture();
    expect(startClockFromNow({ job: "build", store: t.store, config, paths, now: () => new Date(t.clock), takeLock: t.takeLock }, out.write)).toBe(1);
    expect(out.lines).toEqual(["A build is running right now on this data folder. Try again when it has finished. Nothing was changed."]);
    expect(plain(iso(t.clock))).toBe("2026-10-12T07:10:00.000Z");
  });
});

describe("when the clock will next start a job by itself", () => {
  const next = (job: ClockedJob, now: string, record: NightRun | null, settings: NightClockConfig = config) => nextStartAt(job, new Date(now), settings, record).toISOString();
  /** The record of the slot at or before `at`, by the settings given, taken through the steps named. */
  const recordOf = (job: ClockedJob, at: string, steps: { started?: boolean; closedAs?: NonNullable<NightRun["closedAs"]> } = {}, settings: NightClockConfig = config): NightRun => {
    const noticed = new Date(at);
    let run = noticedRun(currentSlot(job, noticed, settings), noticed);
    if (steps.started) run = startedRun(run, noticed);
    if (steps.closedAs !== undefined) run = closedRun(run, steps.closedAs, noticed);
    return run;
  };

  it("is the job's next time on an ordinary day, whatever the record of an earlier slot says", () => {
    // Noon on Oct 12, after a night that ran, was cut short, or was only adopted; and before any record.
    const noon = "2026-10-12T18:00:00.000Z";
    for (const record of [null, recordOf("build", BUILD_AT, { started: true, closedAs: "done" }), recordOf("build", BUILD_AT, { started: true, closedAs: "cut-short" }), recordOf("build", BUILD_AT, { closedAs: "first-check" }), recordOf("build", "2026-10-10T07:00:00.000Z", { started: true, closedAs: "done" })]) {
      expect(next("build", noon, record)).toBe("2026-10-13T07:00:00.000Z");
    }
    expect(next("deliver", noon, recordOf("deliver", DELIVER_AT, { started: true, closedAs: "done" }))).toBe("2026-10-13T12:30:00.000Z");
    // A slot that is due and not yet run does not change what comes after it.
    expect(next("build", "2026-10-12T07:00:30.000Z", recordOf("build", "2026-10-11T07:00:00.000Z", { closedAs: "done", started: true }))).toBe("2026-10-13T07:00:00.000Z");
  });

  it("is a day later when the job's time was moved later on a day whose run had already happened", () => {
    // Oct 12: the build ran at 1:00 am. BUILD_TIME is then set to 15:00.
    const ran = recordOf("build", BUILD_AT, { started: true, closedAs: "done" });
    const moved: NightClockConfig = { ...config, buildTime: "15:00", deliverTime: "16:00" };
    // 2:30 pm: today's 3:00 pm is the next time by the settings, and the record already holds Oct 12.
    expect(next("build", "2026-10-12T20:30:00.000Z", ran, moved)).toBe("2026-10-13T21:00:00.000Z");
    // 3:36 pm: the same answer, now also the next time by the settings.
    expect(next("build", "2026-10-12T21:36:00.000Z", ran, moved)).toBe("2026-10-13T21:00:00.000Z");
    // The delivery, moved from 6:30 am to 3:30 pm, the same way.
    expect(next("deliver", "2026-10-12T20:30:00.000Z", recordOf("deliver", DELIVER_AT, { started: true, closedAs: "done" }), moved)).toBe("2026-10-13T21:30:00.000Z");
  });

  it("agrees with the clock's own rule, minute by minute: nothing starts before the time it names, and a run starts at it", async () => {
    // The same day, driven through the real check: the build runs at 1:00 am, then BUILD_TIME moves to 15:00.
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    expect(await t.tick()).toBe(0);
    expect(t.runs).toBe(1);
    const moved: NightClockConfig = { ...config, buildTime: "15:00" };
    const named = nextStartAt("build", new Date("2026-10-12T20:30:00.000Z"), moved, t.record());
    expect(named.toISOString()).toBe("2026-10-13T21:00:00.000Z");
    // A check a minute from 2:30 pm on Oct 12 until a minute after the time named, with the new setting.
    const late = setUp({ at: "2026-10-12T20:30:00.000Z" });
    for (const [key, value] of t.values) late.values.set(key, value);
    const startedAt: string[] = [];
    const deps = { job: "build" as const, store: late.store, config: moved, paths, now: () => new Date(late.clock), logger: () => late.log.logger, takeLock: late.takeLock, lockHeld: () => false, isOnline: async () => true, sleep: async () => {}, writeError: late.err.write };
    while (late.clock <= named.getTime() + MINUTE) {
      await nightTick({
        ...deps,
        run: async (hand) => {
          startedAt.push(iso(late.clock));
          hand.marks.started();
          hand.marks.ended("finished");
          return 0;
        },
      });
      late.clock += MINUTE;
    }
    // Not at 3:00 pm on Oct 12, which the settings alone would promise: at the time named, and once.
    expect(startedAt).toEqual(["2026-10-13T21:00:00.000Z"]);
  });

  it("follows a record that is dated ahead: nothing before its day is past, and on its day only a run that was noticed and never begun", () => {
    const noon = "2026-10-12T18:00:00.000Z";
    // TZ was set ahead for a while: the record is of Oct 14. Tomorrow's and the day after's times start nothing.
    const ahead = recordOf("build", "2026-10-14T07:00:00.000Z", { started: true, closedAs: "done" });
    expect(next("build", noon, ahead)).toBe("2026-10-15T07:00:00.000Z");
    // The Mac's clock once read January 5.
    expect(next("build", noon, recordOf("build", "2027-01-05T08:00:00.000Z", { closedAs: "first-check" }))).toBe("2027-01-06T08:00:00.000Z");
    // Started on that day and never closed: closed as cut short when its day comes, and not run again.
    expect(next("build", noon, recordOf("build", "2026-10-14T07:00:00.000Z", { started: true }))).toBe("2026-10-15T07:00:00.000Z");
    // Noticed on that day and never begun: that is the one run the clock still starts on the record's own day.
    expect(next("build", noon, recordOf("build", "2026-10-14T07:00:00.000Z"))).toBe("2026-10-14T07:00:00.000Z");
    // The last day of a month, and of a year.
    expect(next("build", noon, recordOf("build", "2026-10-31T07:00:00.000Z", { closedAs: "done", started: true }))).toBe("2026-11-01T07:00:00.000Z");
    expect(next("build", noon, recordOf("build", "2026-12-31T08:00:00.000Z", { closedAs: "done", started: true }))).toBe("2027-01-01T08:00:00.000Z");
  });
});

describe("a run that is due and does not start", () => {
  const NOW = "2026-10-12T07:29:30.000Z";
  const asked = (record: NightRun | null, lockHeld: boolean | null = false, now: string = NOW, job: ClockedJob = "build") => runNotStarting({ job, now: new Date(now), config, record, lockHeld });
  const tried = (at: string, job: ClockedJob = "build") => noticedRun(currentSlot(job, new Date(at), config), new Date(at));

  it("is what the record shows after tries that ended before the work began: open, started by nothing, waiting for nothing, for over three minutes", async () => {
    // The real check, with a builder that will not load: one try a minute from 1:00 am, each exiting 1.
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z", work: () => 1 }, "2026-10-12T06:59:30.000Z");
    expect(await t.tick()).toBe(1);
    expect(asked(t.record(), false, iso(t.clock))).toBe(false);
    expect(await t.minutes(3)).toEqual([1, 1, 1]);
    // Three minutes after the first try, to the millisecond: not yet. A moment later: yes.
    expect(NOT_STARTING_AFTER_MS).toBe(3 * MINUTE);
    expect(t.record()).toMatchObject({ noticedAt: "2026-10-12T07:00:30.000Z", startedAt: null, closedAt: null, waiting: null });
    expect(asked(t.record(), false, "2026-10-12T07:03:30.000Z")).toBe(false);
    expect(asked(t.record(), false, "2026-10-12T07:03:30.001Z")).toBe(true);
    expect(await t.minutes(26)).toEqual(new Array(26).fill(1));
    expect(t.runs).toBe(30);
    expect(asked(t.record(), false, iso(t.clock))).toBe(true);
    // Nothing about the tries is stored anywhere else: the record and the heartbeat are all there is.
    expect([...new Set(t.writes)].sort()).toEqual(["night.build.checkedAt", "night.build.run"]);
  });

  it("is not said while some process holds the job's lock, of a run that started, was closed or is waiting for something, or of another day's record", () => {
    const record = tried("2026-10-12T07:00:30.000Z");
    expect(asked(record)).toBe(true);
    // Not being able to tell about the lock does not hide it.
    expect(asked(record, null)).toBe(true);
    // A try is going right now (its work is still loading), or a build-now has the lock.
    expect(asked(record, true)).toBe(false);
    expect(asked(null)).toBe(false);
    expect(asked(startedRun(record, new Date("2026-10-12T07:00:31.000Z")))).toBe(false);
    expect(asked(closedRun(record, "first-check", new Date("2026-10-12T07:00:31.000Z")))).toBe(false);
    expect(asked(waitingRun(record, "offline"))).toBe(false);
    expect(asked(waitingRun(tried("2026-10-12T12:30:30.000Z", "deliver"), "build-running"), false, "2026-10-12T12:45:00.000Z", "deliver")).toBe(false);
    // Yesterday's record, left open: today's slot gets a record of its own at the job's next check.
    expect(asked(record, false, "2026-10-13T07:10:00.000Z")).toBe(false);
    // The delivery's is seen the same way.
    expect(asked(tried("2026-10-12T12:30:30.000Z", "deliver"), false, "2026-10-12T12:45:00.000Z", "deliver")).toBe(true);
  });

  it("is not what a job whose lock was busy leaves behind: that check writes no record at all", async () => {
    const t = awakeSince({ at: "2026-10-12T07:00:30.000Z" }, "2026-10-12T06:59:30.000Z");
    t.heldElsewhere.add("build.lock");
    expect(await t.tick()).toBe(0);
    expect(await t.minutes(10)).toEqual(new Array(10).fill(0));
    expect(asked(t.record(), false, iso(t.clock))).toBe(false);
  });
});
