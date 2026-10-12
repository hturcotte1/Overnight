// Whole nights on the night clock: the table of nights the clock was designed against.
//
// `mac()` below is a small stand-in for a Mac and for the command macOS wakes every minute
// (`overnight build --if-due`, `overnight deliver --if-due`). It follows that command's steps in
// the same order: write the heartbeat, decide, wait a minute in place after a gap, ask whether
// the internet answers, take the job's lock, read the record and decide again, act. Both times
// it decides, it says when the job's check before this one was. The clock is made up, and the
// Mac sleeps, wakes and goes offline when a test says so.
//
// What is under test is core's rule: when exactly each job starts, and that no slot is ever
// started twice. All times are UTC. Boise is six hours behind in October, so 1:00 am is 07:00Z,
// 6:30 am is 12:30Z and 10:00 am is 16:00Z.
import { describe, expect, it } from "vitest";
import {
  NIGHT_CHECK_FRESH_MS,
  NIGHT_TICK_SECONDS,
  SETTLE_MS,
  WOKE_GAP_MS,
  closedRun,
  decideNight,
  noteChecked,
  noticedRun,
  readCheckedAt,
  readLastNightRun,
  readNightRun,
  slotIsOpen,
  startedRun,
  waitingRun,
  writeNightRun,
} from "../src/index.ts";
import type { ClockedJob, NightClockConfig, NightFacts, NightRun, NightWait } from "../src/index.ts";

const config: NightClockConfig = { timeZone: "America/Boise", buildTime: "01:00", deliverTime: "07:00" };
const TICK_MS = NIGHT_TICK_SECONDS * 1000;
const MINUTE = 60_000;
const ms = (iso: string) => Date.parse(iso);
const iso = (at: number) => new Date(at).toISOString();

type Span = [from: string, until: string];

interface MacOptions {
  /** The first check. Later ones come every 60 seconds, for both jobs, while the Mac is awake. */
  from: string;
  /** When the Mac is asleep or off. Nothing runs then: a process that was going is frozen. */
  asleep?: Span[];
  /** When GitHub does not answer. */
  offline?: Span[];
  /** How long a build's work takes. Default 10 minutes. */
  buildMinutes?: number;
  /** Which job's check comes first each minute. Default the build's. */
  first?: ClockedJob;
  /** A run's process is killed at this moment: no goodbye, its lock is simply free again. */
  kill?: { job: ClockedJob; at: string };
}

/** A job's process, when it outlives the moment it was woken. */
type Process =
  /** Waiting a minute in place after a gap, before it starts anything. `previous` is the heartbeat it found. */
  | { doing: "settling"; since: number; previous: string | null }
  /** Doing the night's work, under the job's lock. `seenAt` is when it last noticed the time. */
  | { doing: "working"; run: NightRun; until: number; seenAt: number };

function mac(options: MacOptions) {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key) ?? null, setValue: (key: string, value: string) => void values.set(key, value) };
  const locks = new Set<ClockedJob>();
  const processes = new Map<ClockedJob, Process>();
  const order: ClockedJob[] = options.first === "deliver" ? ["deliver", "build"] : ["build", "deliver"];
  const within = (spans: Span[] | undefined, at: number) => (spans ?? []).some(([from, until]) => at >= ms(from) && at < ms(until));
  const workMs: Record<ClockedJob, number> = { build: (options.buildMinutes ?? 10) * MINUTE, deliver: MINUTE };

  const starts: Array<{ job: ClockedJob; at: string; slotDay: string; lateMs: number }> = [];
  const waits: Array<{ job: ClockedJob; at: string; reason: NightWait }> = [];
  const settles: Array<{ job: ClockedJob; at: string }> = [];
  const ends: Array<{ job: ClockedJob; at: string; how: "done" | "cut-short" }> = [];
  let clock = ms(options.from);
  let killed = false;

  /** What the deliver job is told about the build. The build job is told nothing. */
  function buildFacts(job: ClockedJob, at: number): Pick<NightFacts, "build"> {
    if (job !== "deliver") return {};
    const checkedAt = readCheckedAt(store, "build");
    const running = locks.has("build");
    return {
      build: {
        open: slotIsOpen("build", new Date(at), config, readNightRun(store, "build")),
        running,
        jobAlive: running || (checkedAt !== null && at - ms(checkedAt) <= NIGHT_CHECK_FRESH_MS),
      },
    };
  }

  /** The check, from the lock onwards. `online` is only asked when the first answer was to run. */
  function underTheLock(job: ClockedJob, at: number, previous: string | null, online: boolean | undefined): void {
    if (locks.has(job)) return;
    locks.add(job);
    const now = new Date(at);
    const decision = decideNight({ job, now, config, record: readNightRun(store, job), ...buildFacts(job, at), previousCheckAt: previous, ...(online === undefined ? {} : { online }) });
    if (decision.action === "adopt") writeNightRun(store, job, closedRun(noticedRun(decision.slot, now), "first-check", now), now);
    if (decision.action === "close") writeNightRun(store, job, closedRun(decision.run, "cut-short", now), now);
    if (decision.action === "wait" && decision.changed) {
      writeNightRun(store, job, waitingRun(decision.run, decision.reason), now);
      waits.push({ job, at: iso(at), reason: decision.reason });
    }
    if (decision.action === "run") {
      let run = decision.run;
      if (decision.firstNotice || run.waiting !== null) {
        run = waitingRun(run, null);
        writeNightRun(store, job, run, now);
      }
      // The start is written down before the work begins.
      run = startedRun(run, now);
      writeNightRun(store, job, run, now);
      starts.push({ job, at: iso(at), slotDay: run.day, lateMs: decision.lateMs });
      processes.set(job, { doing: "working", run, until: at + workMs[job], seenAt: at });
      return; // The lock is held until the work ends.
    }
    locks.delete(job);
  }

  /** macOS wakes the job: one check. */
  function check(job: ClockedJob, at: number): void {
    const now = new Date(at);
    const previous = readCheckedAt(store, job);
    noteChecked(store, job, now);
    const decision = decideNight({ job, now, config, record: readNightRun(store, job), ...buildFacts(job, at), previousCheckAt: previous });
    if (decision.action === "nothing" || (decision.action === "wait" && !decision.changed)) return;
    if (decision.action !== "run") return underTheLock(job, at, previous, undefined);
    if (previous === null || at - ms(previous) > WOKE_GAP_MS) {
      processes.set(job, { doing: "settling", since: at, previous });
      settles.push({ job, at: iso(at) });
      return;
    }
    underTheLock(job, at, previous, !within(options.offline, at));
  }

  function endWork(job: ClockedJob, working: Extract<Process, { doing: "working" }>, at: number, how: "done" | "cut-short"): void {
    writeNightRun(store, job, closedRun(working.run, how, new Date(at)), new Date(at));
    ends.push({ job, at: iso(at), how });
    locks.delete(job);
    processes.delete(job);
  }

  /** A process that was already going gets on with it. */
  function carryOn(job: ClockedJob, process: Process, at: number): void {
    if (process.doing === "settling") {
      if (at - process.since < SETTLE_MS) return;
      processes.delete(job);
      // The minute took far longer than a minute: the Mac slept. Start nothing; the next check starts over.
      if (at - process.since > 2 * SETTLE_MS) return;
      return underTheLock(job, at, process.previous, !within(options.offline, at));
    }
    // The time jumped while the work was going: the Mac slept through part of the run. It is cut short.
    if (at - process.seenAt > TICK_MS) return endWork(job, process, at, "cut-short");
    process.seenAt = at;
    if (at >= process.until) endWork(job, process, at, "done");
  }

  function minute(at: number): void {
    if (within(options.asleep, at)) return;
    if (options.kill !== undefined && !killed && at >= ms(options.kill.at) && processes.get(options.kill.job)?.doing === "working") {
      killed = true;
      processes.delete(options.kill.job);
      locks.delete(options.kill.job);
    }
    for (const job of order) {
      const process = processes.get(job);
      // macOS starts no second copy of a job whose process is still there.
      if (process !== undefined) carryOn(job, process, at);
      else check(job, at);
    }
  }

  return {
    store,
    starts,
    waits,
    settles,
    ends,
    /** Let time pass, up to and including this moment. */
    until(end: string) {
      for (; clock <= ms(end); clock += TICK_MS) minute(clock);
      return this;
    },
    startsOf: (job: ClockedJob) => starts.filter((start) => start.job === job).map((start) => start.at),
    record: (job: ClockedJob) => readNightRun(store, job),
    last: (job: ClockedJob) => readLastNightRun(store, job),
  };
}

/** No slot is ever started twice, and never before its time. */
function expectOneStartPerSlot(starts: ReturnType<typeof mac>["starts"]): void {
  const seen = new Set<string>();
  for (const start of starts) {
    const slot = `${start.job} ${start.slotDay}`;
    expect(seen.has(slot), `${slot} was started twice`).toBe(false);
    seen.add(slot);
    expect(start.lateMs).toBeGreaterThanOrEqual(0);
  }
}

// Every night below begins the same way: the jobs are put in place at 2:00 pm on Oct 11 with no
// record of their own, long after that day's build and delivery.
const SWITCH_OVER = "2026-10-11T20:00:00.000Z";
const BEDTIME: Span = ["2026-10-12T05:00:00.000Z", "2026-10-12T16:00:00.000Z"]; // asleep from 11 pm until 10 am

describe("the night clock, night by night", () => {
  it("switch-over at 2:00 pm: both first checks take today's slot as handled, and the first build is at 1:00 am that night", () => {
    const night = mac({ from: SWITCH_OVER }).until("2026-10-11T20:00:00.000Z");
    expect(night.record("build")).toEqual({ day: "2026-10-11", slotAt: "2026-10-11T07:00:00.000Z", noticedAt: SWITCH_OVER, startedAt: null, closedAt: SWITCH_OVER, closedAs: "first-check", waiting: null });
    expect(night.record("deliver")).toEqual({ day: "2026-10-11", slotAt: "2026-10-11T12:30:00.000Z", noticedAt: SWITCH_OVER, startedAt: null, closedAt: SWITCH_OVER, closedAs: "first-check", waiting: null });
    expect(night.starts).toEqual([]);
    // A first check is not a run, so it is nobody's "last run".
    expect(night.last("build")).toBeNull();
    expect(night.last("deliver")).toBeNull();

    night.until("2026-10-12T06:59:00.000Z");
    expect(night.starts).toEqual([]);
    night.until("2026-10-12T14:00:00.000Z");
    expect(night.starts).toEqual([
      { job: "build", at: "2026-10-12T07:00:00.000Z", slotDay: "2026-10-12", lateMs: 0 },
      { job: "deliver", at: "2026-10-12T12:30:00.000Z", slotDay: "2026-10-12", lateMs: 0 },
    ]);
    expect(night.settles).toEqual([]);
    expect(night.waits).toEqual([]);
  });

  it("awake all night, on mains or on battery with the lid open: build within 60 s of 1:00 am, deliver within 60 s of 6:30 am", () => {
    // The checks happen to fall 37 seconds past each minute. The clock is not told what the Mac
    // runs on, so a night on battery is this same night.
    const night = mac({ from: "2026-10-11T20:00:37.000Z" }).until("2026-10-13T06:00:37.000Z");
    expect(night.starts).toEqual([
      { job: "build", at: "2026-10-12T07:00:37.000Z", slotDay: "2026-10-12", lateMs: 37_000 },
      { job: "deliver", at: "2026-10-12T12:30:37.000Z", slotDay: "2026-10-12", lateMs: 37_000 },
    ]);
    expect(night.ends).toEqual([
      { job: "build", at: "2026-10-12T07:10:37.000Z", how: "done" },
      { job: "deliver", at: "2026-10-12T12:31:37.000Z", how: "done" },
    ]);
    expect(night.last("build")).toMatchObject({ day: "2026-10-12", closedAs: "done" });
    expect(night.settles).toEqual([]);
  });

  it("asleep until 3:00 am: the first check sees the gap and waits a minute, the build starts at 3:01, delivery is at 6:30 as usual", () => {
    const night = mac({ from: SWITCH_OVER, asleep: [["2026-10-12T05:00:00.000Z", "2026-10-12T09:00:00.000Z"]] }).until("2026-10-12T14:00:00.000Z");
    expect(night.settles).toEqual([{ job: "build", at: "2026-10-12T09:00:00.000Z" }]);
    expect(night.starts).toEqual([
      { job: "build", at: "2026-10-12T09:01:00.000Z", slotDay: "2026-10-12", lateMs: 121 * MINUTE },
      { job: "deliver", at: "2026-10-12T12:30:00.000Z", slotDay: "2026-10-12", lateMs: 0 },
    ]);
    expect(night.waits).toEqual([]);
  });

  it("asleep until 10:00 am: the build starts at 10:01, the delivery waits for it and runs when it has finished", () => {
    const night = mac({ from: SWITCH_OVER, asleep: [BEDTIME] }).until("2026-10-12T20:00:00.000Z");
    expect(night.starts).toEqual([
      { job: "build", at: "2026-10-12T16:01:00.000Z", slotDay: "2026-10-12", lateMs: 9 * 60 * MINUTE + MINUTE },
      { job: "deliver", at: "2026-10-12T16:11:00.000Z", slotDay: "2026-10-12", lateMs: 3.5 * 60 * MINUTE + 11 * MINUTE },
    ]);
    expect(night.ends[0]).toEqual({ job: "build", at: "2026-10-12T16:11:00.000Z", how: "done" });
    // Each reason is said once, not every minute.
    expect(night.waits).toEqual([
      { job: "deliver", at: "2026-10-12T16:00:00.000Z", reason: "build-not-started" },
      { job: "deliver", at: "2026-10-12T16:01:00.000Z", reason: "build-running" },
    ]);
  });

  it("asleep until 10:00 am, the same when the deliver job's check comes first each minute", () => {
    const night = mac({ from: SWITCH_OVER, asleep: [BEDTIME], first: "deliver" }).until("2026-10-12T20:00:00.000Z");
    // The deliver job cannot see yet that the build job is awake, so it gets as far as its own
    // minute's wait. By the time it holds its lock the build is about to start, and it waits.
    expect(night.settles).toEqual([
      { job: "deliver", at: "2026-10-12T16:00:00.000Z" },
      { job: "build", at: "2026-10-12T16:00:00.000Z" },
    ]);
    expect(night.waits).toEqual([
      { job: "deliver", at: "2026-10-12T16:01:00.000Z", reason: "build-not-started" },
      { job: "deliver", at: "2026-10-12T16:02:00.000Z", reason: "build-running" },
    ]);
    expect(night.startsOf("build")).toEqual(["2026-10-12T16:01:00.000Z"]);
    expect(night.ends[0]).toEqual({ job: "build", at: "2026-10-12T16:11:00.000Z", how: "done" });
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T16:12:00.000Z"]);
  });

  it("asleep until 10:00 am with a 45-minute build: the delivery stops waiting after 20 minutes, and that app goes out the next morning", () => {
    const night = mac({ from: SWITCH_OVER, asleep: [BEDTIME], buildMinutes: 45 }).until("2026-10-13T14:00:00.000Z");
    expect(night.startsOf("build")).toEqual(["2026-10-12T16:01:00.000Z", "2026-10-13T07:00:00.000Z"]);
    // 10:20 am: twenty minutes after the deliver job first found its slot due. The build is still going.
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T16:20:00.000Z", "2026-10-13T12:30:00.000Z"]);
    expect(night.ends.slice(0, 2)).toEqual([
      { job: "deliver", at: "2026-10-12T16:21:00.000Z", how: "done" },
      { job: "build", at: "2026-10-12T16:46:00.000Z", how: "done" },
    ]);
    expectOneStartPerSlot(night.starts);
  });

  it("asleep until 10:00 am, awake for 40 seconds at 7:07 am: the delivery's 20 minutes do not run out while the Mac sleeps on", () => {
    // In that short wake the deliver job finds its slot due and the build about to start, and
    // stores that it is waiting. The build job does not get past its minute's wait.
    const night = mac({
      from: SWITCH_OVER,
      asleep: [
        ["2026-10-12T05:00:00.000Z", "2026-10-12T13:07:00.000Z"],
        ["2026-10-12T13:07:40.000Z", "2026-10-12T16:00:00.000Z"],
      ],
    }).until("2026-10-12T15:59:00.000Z");
    expect(night.waits).toEqual([{ job: "deliver", at: "2026-10-12T13:07:00.000Z", reason: "build-not-started" }]);
    expect(night.record("deliver")).toMatchObject({ day: "2026-10-12", noticedAt: "2026-10-12T13:07:00.000Z", startedAt: null, waiting: "build-not-started" });
    expect(night.starts).toEqual([]);

    // 10:00 am, nearly three hours later: the lid is opened. The wait is counted from here.
    night.until("2026-10-12T20:00:00.000Z");
    expect(night.waits.slice(1)).toEqual([
      { job: "deliver", at: "2026-10-12T16:01:00.000Z", reason: "build-not-started" },
      { job: "deliver", at: "2026-10-12T16:02:00.000Z", reason: "build-running" },
    ]);
    expect(night.startsOf("build")).toEqual(["2026-10-12T16:02:00.000Z"]);
    expect(night.ends[0]).toEqual({ job: "build", at: "2026-10-12T16:12:00.000Z", how: "done" });
    // After the build, not with it: the app goes out this morning.
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T16:12:00.000Z"]);
    expectOneStartPerSlot(night.starts);
  });

  it("asleep until 10:00 am, awake for 40 seconds every 15 minutes: nothing starts in the night, and the delivery waits for the build", () => {
    // What a sleeping Mac really does: it wakes by itself to look after things, a few times an hour.
    const LID_CLOSED = ms("2026-10-12T05:00:00.000Z"); // 11 pm
    const LID_OPENED = ms("2026-10-12T16:00:00.000Z"); // 10 am
    const asleep: Span[] = [];
    for (let wake = LID_CLOSED; wake < LID_OPENED; wake += 15 * MINUTE) asleep.push([iso(wake === LID_CLOSED ? wake : wake + 40_000), iso(wake + 15 * MINUTE)]);

    const night = mac({ from: SWITCH_OVER, asleep }).until(iso(LID_OPENED - MINUTE));
    expect(night.starts).toEqual([]);
    // Each job was woken in the night and saw its slot due. Neither got through its minute's wait.
    expect(night.settles.filter((settle) => settle.job === "build").length).toBeGreaterThan(10);
    expect(night.settles.filter((settle) => settle.job === "deliver").length).toBeGreaterThan(5);
    expect(night.waits).toEqual([{ job: "deliver", at: "2026-10-12T12:30:00.000Z", reason: "build-not-started" }]);

    night.until("2026-10-12T20:00:00.000Z");
    expect(night.startsOf("build")).toEqual(["2026-10-12T16:01:00.000Z"]);
    expect(night.waits.slice(1)).toEqual([{ job: "deliver", at: "2026-10-12T16:01:00.000Z", reason: "build-running" }]);
    expect(night.ends[0]).toEqual({ job: "build", at: "2026-10-12T16:11:00.000Z", how: "done" });
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T16:11:00.000Z"]);
    expectOneStartPerSlot(night.starts);
  });

  it("the Mac sleeps in the middle of a build: the run is cut short when it wakes, the slot is not started again, the next night builds", () => {
    // The lid is closed at 1:05 am and opened at 3:00 am. The build needed 20 minutes.
    const night = mac({ from: SWITCH_OVER, buildMinutes: 20, asleep: [["2026-10-12T07:05:00.000Z", "2026-10-12T09:00:00.000Z"]] }).until("2026-10-12T09:00:00.000Z");
    expect(night.ends).toEqual([{ job: "build", at: "2026-10-12T09:00:00.000Z", how: "cut-short" }]);
    expect(night.record("build")).toMatchObject({ day: "2026-10-12", startedAt: "2026-10-12T07:00:00.000Z", closedAt: "2026-10-12T09:00:00.000Z", closedAs: "cut-short" });
    expect(night.last("build")).toEqual(night.record("build"));

    night.until("2026-10-13T14:00:00.000Z");
    expect(night.startsOf("build")).toEqual(["2026-10-12T07:00:00.000Z", "2026-10-13T07:00:00.000Z"]);
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T12:30:00.000Z", "2026-10-13T12:30:00.000Z"]);
    expectOneStartPerSlot(night.starts);
  });

  it("woke at 8:00 am on a network with no real internet: both wait, the build runs when GitHub answers, and the delivery after it", () => {
    const morning = {
      from: SWITCH_OVER,
      asleep: [["2026-10-12T05:00:00.000Z", "2026-10-12T14:00:00.000Z"]] as Span[],
      offline: [["2026-10-12T05:00:00.000Z", "2026-10-12T14:30:00.000Z"]] as Span[],
    };
    const night = mac(morning).until("2026-10-12T14:29:00.000Z");
    expect(night.starts).toEqual([]);
    expect(night.record("build")).toMatchObject({ day: "2026-10-12", startedAt: null, closedAt: null, waiting: "offline" });
    expect(night.record("deliver")).toMatchObject({ day: "2026-10-12", startedAt: null, closedAt: null, waiting: "offline" });
    // Half an hour of checks, and each reason was stored and said once.
    expect(night.waits).toEqual([
      { job: "deliver", at: "2026-10-12T14:00:00.000Z", reason: "build-not-started" },
      { job: "build", at: "2026-10-12T14:01:00.000Z", reason: "offline" },
      { job: "deliver", at: "2026-10-12T14:20:00.000Z", reason: "offline" },
    ]);

    night.until("2026-10-12T20:00:00.000Z");
    expect(night.startsOf("build")).toEqual(["2026-10-12T14:30:00.000Z"]);
    expect(night.record("build")).toMatchObject({ waiting: null, closedAs: "done" });
    // The half hour without the internet was not time the build could have used. The delivery
    // gives it 20 minutes from now, so the app goes out this morning.
    expect(night.waits.slice(3)).toEqual([{ job: "deliver", at: "2026-10-12T14:30:00.000Z", reason: "build-running" }]);
    expect(night.ends[0]).toEqual({ job: "build", at: "2026-10-12T14:40:00.000Z", how: "done" });
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T14:40:00.000Z"]);

    // The same when the deliver job's check comes first each minute: it sees the build about to start.
    const other = mac({ ...morning, first: "deliver" }).until("2026-10-12T20:00:00.000Z");
    expect(other.startsOf("build")).toEqual(["2026-10-12T14:30:00.000Z"]);
    expect(other.startsOf("deliver")).toEqual(["2026-10-12T14:41:00.000Z"]);
    expect(other.waits.filter((wait) => wait.at >= "2026-10-12T14:30:00.000Z")).toEqual([
      { job: "deliver", at: "2026-10-12T14:30:00.000Z", reason: "build-not-started" },
      { job: "deliver", at: "2026-10-12T14:31:00.000Z", reason: "build-running" },
    ]);
  });

  it("a brief wake in the night starts nothing: the minute's wait never completes", () => {
    // Asleep from 11 pm. macOS wakes the Mac by itself for 20 seconds at 3:00 am. A person opens it at 8:00 am.
    const night = mac({
      from: SWITCH_OVER,
      asleep: [
        ["2026-10-12T05:00:00.000Z", "2026-10-12T09:00:00.000Z"],
        ["2026-10-12T09:00:20.000Z", "2026-10-12T14:00:00.000Z"],
      ],
    }).until("2026-10-12T14:00:00.000Z");
    // The build job was woken at 3:00, saw the gap and began its minute's wait. It was frozen
    // there for five hours, found the time had jumped, and gave up.
    expect(night.settles[0]).toEqual({ job: "build", at: "2026-10-12T09:00:00.000Z" });
    expect(night.starts).toEqual([]);
    expect(night.record("build")).toMatchObject({ day: "2026-10-11", closedAs: "first-check" });

    night.until("2026-10-12T20:00:00.000Z");
    // The next check starts over: a gap, a minute's wait, and then the build.
    expect(night.settles.filter((settle) => settle.job === "build")).toEqual([
      { job: "build", at: "2026-10-12T09:00:00.000Z" },
      { job: "build", at: "2026-10-12T14:01:00.000Z" },
    ]);
    expect(night.startsOf("build")).toEqual(["2026-10-12T14:02:00.000Z"]);
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T14:12:00.000Z"]);
  });

  it("off for three days: one build for the latest slot, then one delivery", () => {
    // Shut down at 10 pm on Oct 12, switched on at 10 am on Oct 16.
    const night = mac({ from: SWITCH_OVER, asleep: [["2026-10-13T04:00:00.000Z", "2026-10-16T16:00:00.000Z"]] }).until("2026-10-16T23:00:00.000Z");
    expect(night.starts).toEqual([
      { job: "build", at: "2026-10-12T07:00:00.000Z", slotDay: "2026-10-12", lateMs: 0 },
      { job: "deliver", at: "2026-10-12T12:30:00.000Z", slotDay: "2026-10-12", lateMs: 0 },
      { job: "build", at: "2026-10-16T16:01:00.000Z", slotDay: "2026-10-16", lateMs: 9 * 60 * MINUTE + MINUTE },
      { job: "deliver", at: "2026-10-16T16:11:00.000Z", slotDay: "2026-10-16", lateMs: 3.5 * 60 * MINUTE + 11 * MINUTE },
    ]);
  });

  it("Nov 1, when 1:00 am comes twice: one build, and 25 hours to the next", () => {
    const night = mac({ from: "2026-10-31T20:00:00.000Z" }).until("2026-11-02T14:00:00.000Z");
    const builds = night.startsOf("build");
    expect(builds).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
    expect(ms(builds[1] ?? "") - ms(builds[0] ?? "")).toBe(25 * 60 * MINUTE);
    // 6:30 am is 13:30Z once the clocks have gone back.
    expect(night.startsOf("deliver")).toEqual(["2026-11-01T13:30:00.000Z", "2026-11-02T13:30:00.000Z"]);
    expectOneStartPerSlot(night.starts);
  });

  it("the build's process is killed after it started: the next check closes the slot as cut short, nothing restarts, the next night builds", () => {
    const night = mac({ from: SWITCH_OVER, kill: { job: "build", at: "2026-10-12T07:05:00.000Z" } }).until("2026-10-12T07:04:00.000Z");
    expect(night.record("build")).toMatchObject({ startedAt: "2026-10-12T07:00:00.000Z", closedAt: null });

    night.until("2026-10-12T07:05:00.000Z");
    const closed = { day: "2026-10-12", startedAt: "2026-10-12T07:00:00.000Z", closedAt: "2026-10-12T07:05:00.000Z", closedAs: "cut-short" };
    expect(night.record("build")).toMatchObject(closed);
    expect(night.last("build")).toMatchObject(closed);
    // The process never said goodbye: the slot was closed by the next check.
    expect(night.ends).toEqual([]);

    night.until("2026-10-13T14:00:00.000Z");
    expect(night.startsOf("build")).toEqual(["2026-10-12T07:00:00.000Z", "2026-10-13T07:00:00.000Z"]);
    expect(night.startsOf("deliver")).toEqual(["2026-10-12T12:30:00.000Z", "2026-10-13T12:30:00.000Z"]);
    expectOneStartPerSlot(night.starts);
  });
});

describe("the night clock, on nights nobody planned", () => {
  /** The same made-up numbers every run: a small generator with a fixed start. */
  function numbers(seed: number) {
    let state = seed;
    return (below: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor((state / 2 ** 32) * below);
    };
  }

  it("never starts a slot twice, and leaves nothing due once the Mac has been awake and online for hours", () => {
    const from = ms(SWITCH_OVER);
    const lastTrouble = from + 58 * 60 * MINUTE; // nothing below begins later than this
    const end = lastTrouble + 13 * 60 * MINUTE; // 1:00 pm on Oct 14
    const seen = { starts: 0, settles: 0, cutShort: 0, killed: 0, waits: new Set<string>() };

    for (let seed = 1; seed <= 12; seed += 1) {
      const next = numbers(seed);
      // Sleeps, naps and offline spells of odd lengths at odd moments.
      const spans = (count: number, longestMinutes: number): Span[] =>
        Array.from({ length: count }, () => {
          const start = from + next(58 * 60) * MINUTE + next(60) * 1000;
          return [iso(start), iso(start + next(longestMinutes * 60) * 1000)] as Span;
        });
      const night = mac({
        from: SWITCH_OVER,
        asleep: [...spans(5, 9 * 60), ...spans(8, 25)],
        offline: spans(4, 90),
        buildMinutes: 1 + next(120),
        first: seed % 2 === 0 ? "deliver" : "build",
        ...(seed % 3 === 0 ? { kill: { job: "build" as const, at: iso(from + next(58 * 60) * MINUTE) } } : {}),
      });
      // The longest sleep is over at least four hours before this moment, and so is every offline spell.
      night.until(iso(end));

      expectOneStartPerSlot(night.starts);
      for (const job of ["build", "deliver"] as const) {
        const record = night.record(job);
        expect(slotIsOpen(job, new Date(end), config, record), `seed ${seed}: the ${job} slot is still due`).toBe(false);
        expect(decideNight({ job, now: new Date(end), config, record }), `seed ${seed}: ${job}`).toEqual({ action: "nothing" });
        // Today's slot was not skipped: it has a run of its own.
        expect(record, `seed ${seed}: ${job}`).toMatchObject({ day: "2026-10-14" });
        expect(record?.startedAt, `seed ${seed}: ${job}`).not.toBeNull();
      }

      seen.starts += night.starts.length;
      seen.settles += night.settles.length;
      seen.cutShort += night.ends.filter((ended) => ended.how === "cut-short").length;
      seen.killed += night.starts.length - night.ends.length;
      for (const wait of night.waits) seen.waits.add(wait.reason);
    }

    // The nights were not all quiet ones: every path was taken somewhere.
    expect(seen.starts).toBeGreaterThan(60);
    expect(seen.settles).toBeGreaterThan(20);
    expect(seen.cutShort).toBeGreaterThan(0);
    expect(seen.killed).toBeGreaterThan(0);
    expect([...seen.waits].sort()).toEqual(["build-not-started", "build-running", "offline"]);
  });
});
