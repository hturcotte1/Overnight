// The night clock's rule, one piece at a time. Whole nights are in night-clock-nights.test.ts.
import { describe, expect, it } from "vitest";
import {
  CLOCKED_JOBS,
  DELIVER_LEAD_MINUTES,
  DELIVER_WAITS_FOR_BUILD_MS,
  LATE_AFTER_MS,
  NIGHT_CHECK_FRESH_MS,
  NIGHT_TICK_SECONDS,
  SETTLE_MS,
  WOKE_GAP_MS,
  clockMinus,
  closedRun,
  currentSlot,
  decideNight,
  describeNight,
  nextSlotAt,
  nightRunSchema,
  noteChecked,
  noticedRun,
  readCheckedAt,
  readLastNightRun,
  readNightRun,
  slotIsOpen,
  slotTime,
  startedRun,
  waitingRun,
  writeNightRun,
} from "../src/index.ts";
import type { NightClockConfig, NightFacts, NightRun } from "../src/index.ts";

const config: NightClockConfig = { timeZone: "America/Boise", buildTime: "01:00", deliverTime: "07:00" };

// Oct 12, 2026 in Boise (UTC-6): the build's time is 07:00Z, the deliver job's (6:30 am) is 12:30Z.
const BUILD_AT = "2026-10-12T07:00:00.000Z";
const DELIVER_AT = "2026-10-12T12:30:00.000Z";
const at = (iso: string) => new Date(iso);
const after = (iso: string, ms: number) => new Date(Date.parse(iso) + ms);
const MINUTE = 60_000;

/** A record for the Oct 12 slot, noticed at the slot's own time unless said otherwise. */
function record(job: "build" | "deliver", changes: Partial<NightRun> = {}): NightRun {
  const slotAt = job === "build" ? BUILD_AT : DELIVER_AT;
  return { day: "2026-10-12", slotAt, noticedAt: slotAt, startedAt: null, closedAt: null, closedAs: null, waiting: null, ...changes };
}
const yesterdaysBuild: NightRun = {
  day: "2026-10-11",
  slotAt: "2026-10-11T07:00:00.000Z",
  noticedAt: "2026-10-11T07:00:20.000Z",
  startedAt: "2026-10-11T07:00:20.000Z",
  closedAt: "2026-10-11T07:21:00.000Z",
  closedAs: "done",
  waiting: null,
};
const yesterdaysDeliver: NightRun = { ...yesterdaysBuild, slotAt: "2026-10-11T12:30:00.000Z", noticedAt: "2026-10-11T12:30:20.000Z", startedAt: "2026-10-11T12:30:20.000Z", closedAt: "2026-10-11T12:31:00.000Z" };

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => void values.set(key, value),
  };
}

describe("the numbers other parts are built on", () => {
  it("has the two jobs and the agreed times", () => {
    expect(CLOCKED_JOBS).toEqual(["build", "deliver"]);
    expect(DELIVER_LEAD_MINUTES).toBe(30);
    expect(NIGHT_TICK_SECONDS).toBe(60);
    expect(NIGHT_CHECK_FRESH_MS).toBe(180_000);
    expect(WOKE_GAP_MS).toBe(150_000);
    expect(SETTLE_MS).toBe(60_000);
    expect(DELIVER_WAITS_FOR_BUILD_MS).toBe(20 * MINUTE);
    expect(LATE_AFTER_MS).toBe(120_000);
  });

  it("only calls a gap a sleep, or a job stopped, after more than two missed checks", () => {
    expect(WOKE_GAP_MS).toBeGreaterThan(2 * NIGHT_TICK_SECONDS * 1000);
    expect(NIGHT_CHECK_FRESH_MS).toBeGreaterThanOrEqual(WOKE_GAP_MS);
  });

  it("keeps the minute's wait after a wake, and the minute to the next check, shorter than a gap", () => {
    // Otherwise the check that follows a wait would look like a wake itself: it would wait again,
    // and the deliver job would count its 20 minutes from the start at every check.
    expect(SETTLE_MS + NIGHT_TICK_SECONDS * 1000).toBeLessThan(WOKE_GAP_MS);
  });
});

describe("slots", () => {
  it("takes minutes off a time of day, around midnight too", () => {
    expect(clockMinus("07:00", 30)).toBe("06:30");
    expect(clockMinus("00:10", 30)).toBe("23:40");
    expect(clockMinus("00:00", 30)).toBe("23:30");
    expect(clockMinus("09:08", 0)).toBe("09:08");
    expect(() => clockMinus("9am", 30)).toThrow();
  });

  it("puts the build at BUILD_TIME and the deliver job 30 minutes before DELIVER_TIME", () => {
    expect(slotTime("build", config)).toBe("01:00");
    expect(slotTime("deliver", config)).toBe("06:30");
    expect(slotTime("deliver", { buildTime: "01:00", deliverTime: "00:10" })).toBe("23:40");
  });

  it("finds the latest slot at or before now, named by its local day", () => {
    expect(currentSlot("build", at(BUILD_AT), config)).toEqual({ day: "2026-10-12", at: at(BUILD_AT) });
    expect(currentSlot("build", after(BUILD_AT, -1), config)).toEqual({ day: "2026-10-11", at: at("2026-10-11T07:00:00.000Z") });
    expect(currentSlot("deliver", at(DELIVER_AT), config)).toEqual({ day: "2026-10-12", at: at(DELIVER_AT) });
    // The slot stays the current one all day: there is no hour after which it is given up.
    expect(currentSlot("build", after(BUILD_AT, 23 * 60 * MINUTE + 59 * MINUTE), config).day).toBe("2026-10-12");
  });

  it("names a deliver slot before midnight by the day it falls on", () => {
    const late = { ...config, deliverTime: "00:10" };
    // 23:40 on Oct 11 in Boise is 05:40Z on Oct 12.
    expect(currentSlot("deliver", at("2026-10-12T05:45:00.000Z"), late)).toEqual({ day: "2026-10-11", at: at("2026-10-12T05:40:00.000Z") });
  });

  it("finds the next slot, strictly after now", () => {
    expect(nextSlotAt("build", after(BUILD_AT, -1), config).toISOString()).toBe(BUILD_AT);
    expect(nextSlotAt("build", at(BUILD_AT), config).toISOString()).toBe("2026-10-13T07:00:00.000Z");
    expect(nextSlotAt("deliver", at(BUILD_AT), config).toISOString()).toBe(DELIVER_AT);
  });

  it("finds the next slot 25 hours on when the clocks go back, and 23 when they go forward", () => {
    // Nov 1, 2026, between the two 1:00 ams: the next build is not the second one.
    expect(nextSlotAt("build", at("2026-11-01T07:30:00.000Z"), config).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(describeNight({ job: "build", now: at("2026-11-01T08:00:00.000Z"), config, record: null, last: null, checkedAt: null, running: null })).toMatchObject({
      slotAt: "2026-11-01T07:00:00.000Z",
      slotDay: "2026-11-01",
      nextSlotAt: "2026-11-02T08:00:00.000Z",
    });
    // Mar 14, 2027: 1:00 am is 08:00Z that night and 07:00Z the next.
    expect(nextSlotAt("build", at("2027-03-14T08:00:00.000Z"), config).toISOString()).toBe("2027-03-15T07:00:00.000Z");
  });
});

describe("the steps a record goes through", () => {
  const slot = { day: "2026-10-12", at: at(BUILD_AT) };

  it("starts as noticed, with nothing else set", () => {
    expect(noticedRun(slot, after(BUILD_AT, 20_000))).toEqual({
      day: "2026-10-12",
      slotAt: BUILD_AT,
      noticedAt: "2026-10-12T07:00:20.000Z",
      startedAt: null,
      closedAt: null,
      closedAs: null,
      waiting: null,
    });
  });

  it("can wait for a reason and stop waiting", () => {
    const noticed = noticedRun(slot, at(BUILD_AT));
    const waiting = waitingRun(noticed, "offline");
    expect(waiting).toEqual({ ...noticed, waiting: "offline" });
    expect(waitingRun(waiting, null)).toEqual(noticed);
    // Nothing is changed in place.
    expect(noticed.waiting).toBeNull();
  });

  it("is no longer waiting once it has started or been closed", () => {
    const waiting = waitingRun(noticedRun(slot, at(BUILD_AT)), "offline");
    const started = startedRun(waiting, after(BUILD_AT, 5 * MINUTE));
    expect(started).toEqual({ ...waiting, startedAt: "2026-10-12T07:05:00.000Z", waiting: null });
    expect(closedRun(started, "done", after(BUILD_AT, 25 * MINUTE))).toEqual({ ...started, closedAt: "2026-10-12T07:25:00.000Z", closedAs: "done" });
    expect(closedRun(waiting, "first-check", at(BUILD_AT))).toMatchObject({ startedAt: null, closedAt: BUILD_AT, closedAs: "first-check", waiting: null });
    expect(closedRun(started, "cut-short", after(BUILD_AT, 6 * MINUTE)).closedAs).toBe("cut-short");
  });

  it("makes a valid record at every step", () => {
    const noticed = noticedRun(slot, at(BUILD_AT));
    const steps = [noticed, waitingRun(noticed, "build-running"), startedRun(noticed, at(BUILD_AT)), closedRun(startedRun(noticed, at(BUILD_AT)), "done", at(BUILD_AT)), closedRun(noticed, "first-check", at(BUILD_AT))];
    for (const step of steps) expect(nightRunSchema.parse(step)).toEqual(step);
  });

  it("can wait for each of the four reasons, and no other", () => {
    const noticed = noticedRun(slot, at(BUILD_AT));
    for (const reason of ["build-running", "build-not-started", "lid-closed", "offline"] as const) {
      const waiting = waitingRun(noticed, reason);
      expect(nightRunSchema.parse(waiting), reason).toEqual({ ...noticed, waiting: reason });
      // Stored and read back as it was.
      const store = memoryStore();
      writeNightRun(store, "build", waiting, at(BUILD_AT));
      expect(readNightRun(store, "build"), reason).toEqual(waiting);
    }
    expect(nightRunSchema.safeParse({ ...noticed, waiting: "on-battery" }).success).toBe(false);
    expect(nightRunSchema.safeParse({ ...noticed, waiting: "lid closed" }).success).toBe(false);
  });
});

describe("the stored values", () => {
  it("stores a record under the job's own name and reads it back", () => {
    const store = memoryStore();
    expect(readNightRun(store, "build")).toBeNull();
    writeNightRun(store, "build", record("build"), at(BUILD_AT));
    expect(readNightRun(store, "build")).toEqual(record("build"));
    expect(readNightRun(store, "deliver")).toBeNull();
    expect([...store.values.keys()]).toEqual(["night.build.run"]);
  });

  it("reads nothing from a value that is not a record", () => {
    const store = memoryStore();
    const stored = (value: string) => {
      store.values.set("night.build.run", value);
      return readNightRun(store, "build");
    };
    const good = record("build");
    expect(stored(JSON.stringify(good))).toEqual(good);
    expect(stored("{not json")).toBeNull();
    expect(stored("null")).toBeNull();
    expect(stored('"2026-10-12"')).toBeNull();
    // One bad field is enough.
    expect(stored(JSON.stringify({ ...good, day: "Oct 12" }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, slotAt: "2026-10-12 07:00" }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, noticedAt: "2026-10-12T07:00:00Z" }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, startedAt: 1_791_788_400_000 }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, waiting: "on-battery" }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, closedAs: "finished", closedAt: BUILD_AT }))).toBeNull();
    // Closed needs both the time and the way, or neither.
    expect(stored(JSON.stringify({ ...good, closedAt: BUILD_AT }))).toBeNull();
    expect(stored(JSON.stringify({ ...good, closedAs: "done" }))).toBeNull();
    const { waiting: _waiting, ...missingOne } = good;
    expect(stored(JSON.stringify(missingOne))).toBeNull();
    // A field this version does not know is left out, not a reason to drop the record.
    expect(stored(JSON.stringify({ ...good, somethingNew: true }))).toEqual(good);
  });

  it("keeps the last run that started and was closed, and only that", () => {
    const store = memoryStore();
    const open = record("build");
    const started = startedRun(open, after(BUILD_AT, 20_000));
    const done = closedRun(started, "done", after(BUILD_AT, 20 * MINUTE));

    writeNightRun(store, "build", open, at(BUILD_AT));
    writeNightRun(store, "build", waitingRun(open, "offline"), at(BUILD_AT));
    writeNightRun(store, "build", started, at(BUILD_AT));
    expect(readLastNightRun(store, "build")).toBeNull();

    writeNightRun(store, "build", done, at(BUILD_AT));
    expect(readLastNightRun(store, "build")).toEqual(done);
    expect(readNightRun(store, "build")).toEqual(done);
    expect(readLastNightRun(store, "deliver")).toBeNull();

    // The next day's slot, closed without a run, replaces the record and leaves the last run alone.
    const nextDay = closedRun(noticedRun({ day: "2026-10-13", at: at("2026-10-13T07:00:00.000Z") }, at("2026-10-13T07:00:10.000Z")), "first-check", at("2026-10-13T07:00:10.000Z"));
    writeNightRun(store, "build", nextDay, at("2026-10-13T07:00:10.000Z"));
    expect(readNightRun(store, "build")).toEqual(nextDay);
    expect(readLastNightRun(store, "build")).toEqual(done);

    // A run that was cut short is a last run too.
    const cut = closedRun(startedRun(noticedRun({ day: "2026-10-14", at: at("2026-10-14T07:00:00.000Z") }, at("2026-10-14T07:00:00.000Z")), at("2026-10-14T07:00:00.000Z")), "cut-short", at("2026-10-14T07:05:00.000Z"));
    writeNightRun(store, "build", cut, at("2026-10-14T07:05:00.000Z"));
    expect(readLastNightRun(store, "build")).toEqual(cut);
  });

  it("refuses to store a record that could not be read back, and stores nothing", () => {
    const store = memoryStore();
    const good = closedRun(startedRun(record("build"), at(BUILD_AT)), "done", after(BUILD_AT, MINUTE));
    expect(() => writeNightRun(store, "build", { ...good, noticedAt: "2026-10-12T07:00:00Z" }, at(BUILD_AT))).toThrow("Not a valid night clock record for the build job. noticedAt: must be a UTC time");
    expect(() => writeNightRun(store, "deliver", { ...good, closedAs: null }, at(BUILD_AT))).toThrow("closedAt and closedAs are set together");
    expect(() => writeNightRun(store, "build", { ...good, waiting: "on-battery" as never }, at(BUILD_AT))).toThrow("waiting");
    expect(store.values.size).toBe(0);
  });

  it("reads nothing from a last run that is not a record", () => {
    const store = memoryStore();
    store.values.set("night.deliver.last", "[]");
    expect(readLastNightRun(store, "deliver")).toBeNull();
  });

  it("keeps each job's heartbeat, in the one shape that sorts as text", () => {
    const store = memoryStore();
    expect(readCheckedAt(store, "build")).toBeNull();
    noteChecked(store, "build", at("2026-10-12T07:01:00.250Z"));
    expect(readCheckedAt(store, "build")).toBe("2026-10-12T07:01:00.250Z");
    expect(store.values.get("night.build.checkedAt")).toBe("2026-10-12T07:01:00.250Z");
    expect(readCheckedAt(store, "deliver")).toBeNull();
    noteChecked(store, "build", at("2026-10-12T07:02:00.000Z"));
    expect(readCheckedAt(store, "build")).toBe("2026-10-12T07:02:00.000Z");

    for (const bad of ["yesterday", "", "2026-10-12T07:01:00Z", "1791788400000"]) {
      store.values.set("night.build.checkedAt", bad);
      expect(readCheckedAt(store, "build")).toBeNull();
    }
  });

  it("gives every stored value the time it was written", () => {
    const calls: Array<[string, string]> = [];
    const store = { setValue: (key: string, _value: string, now: string) => void calls.push([key, now]) };
    const done = closedRun(startedRun(record("build"), at(BUILD_AT)), "done", after(BUILD_AT, MINUTE));
    writeNightRun(store, "build", done, after(BUILD_AT, MINUTE));
    noteChecked(store, "deliver", after(BUILD_AT, 2 * MINUTE));
    expect(calls).toEqual([
      ["night.build.run", "2026-10-12T07:01:00.000Z"],
      ["night.build.last", "2026-10-12T07:01:00.000Z"],
      ["night.deliver.checkedAt", "2026-10-12T07:02:00.000Z"],
    ]);
  });
});

describe("whether a slot is open", () => {
  const now = after(BUILD_AT, 5 * MINUTE);
  const open = (stored: NightRun | null) => slotIsOpen("build", now, config, stored);

  it("is not open without a record: the first check runs nothing", () => {
    expect(open(null)).toBe(false);
  });

  it("is open when the record is for an earlier day, or for today and not started", () => {
    expect(open(yesterdaysBuild)).toBe(true);
    expect(open(record("build"))).toBe(true);
    expect(open(record("build", { waiting: "offline" }))).toBe(true);
  });

  it("is not open once today's run has started or the slot is closed", () => {
    expect(open(record("build", { startedAt: BUILD_AT }))).toBe(false);
    expect(open(record("build", { startedAt: BUILD_AT, closedAt: BUILD_AT, closedAs: "done" }))).toBe(false);
    expect(open(record("build", { closedAt: BUILD_AT, closedAs: "first-check" }))).toBe(false);
  });

  it("is not open when the record is ahead of the clock", () => {
    expect(open(record("build", { day: "2026-10-13" }))).toBe(false);
  });

  it("goes by the job's own slot", () => {
    // 1:05 am: the deliver job's current slot is still yesterday's 6:30 am.
    expect(slotIsOpen("deliver", now, config, yesterdaysDeliver)).toBe(false);
    expect(slotIsOpen("deliver", after(DELIVER_AT, 1), config, yesterdaysDeliver)).toBe(true);
  });
});

describe("the rule, line by line", () => {
  const now = after(BUILD_AT, 20_000);
  const build = (changes: Partial<NightFacts> = {}) => decideNight({ job: "build", now, config, record: yesterdaysBuild, ...changes });
  const deliverNow = after(DELIVER_AT, 20_000);
  const deliver = (changes: Partial<NightFacts> = {}) => decideNight({ job: "deliver", now: deliverNow, config, record: yesterdaysDeliver, ...changes });
  const buildIsLate = { open: true, running: false, jobAlive: true };

  it("1. takes the slot as handled at the job's first ever check", () => {
    expect(build({ record: null })).toEqual({ action: "adopt", slot: { day: "2026-10-12", at: at(BUILD_AT) } });
    // Whatever else is true.
    expect(build({ record: null, online: false })).toMatchObject({ action: "adopt" });
    expect(deliver({ record: null, build: { open: true, running: true, jobAlive: true } })).toEqual({ action: "adopt", slot: { day: "2026-10-12", at: at(DELIVER_AT) } });
  });

  it("2. does nothing while the record is ahead of the clock", () => {
    expect(build({ record: record("build", { day: "2026-10-13" }) })).toEqual({ action: "nothing" });
    // Even a record that was started and never closed is left alone there.
    expect(build({ record: record("build", { day: "2026-10-13", startedAt: "2026-10-13T07:00:00.000Z" }) })).toEqual({ action: "nothing" });
  });

  it("2. does nothing however far ahead the record is, so a clock that is wrong for a moment cannot run a night twice", () => {
    // The Oct 12 build ran. Then the Mac's clock reads New Year 2001 for a while (a flat battery).
    const ran = record("build", { startedAt: BUILD_AT, closedAt: "2026-10-12T07:20:00.000Z", closedAs: "done" });
    expect(build({ record: ran, now: at("2001-01-01T09:00:00.000Z") })).toEqual({ action: "nothing" });
    // Had the record been dropped there as a mistake, this check, with the clock right again,
    // would start Oct 12's build a second time.
    expect(build({ record: ran, now: at("2026-10-12T09:00:00.000Z") })).toEqual({ action: "nothing" });

    // The other way round: a record written while the clock was ahead stops the job until that
    // day. Nothing here puts it right; `describeNight` is what shows it (see `recordAhead`).
    const fromAhead: NightRun = { day: "2027-01-05", slotAt: "2027-01-05T08:00:00.000Z", noticedAt: "2027-01-05T08:00:00.000Z", startedAt: "2027-01-05T08:00:00.000Z", closedAt: "2027-01-05T08:10:00.000Z", closedAs: "done", waiting: null };
    for (const day of ["2026-10-13", "2026-11-13", "2026-12-13", "2027-01-04", "2027-01-05"]) {
      expect(build({ record: fromAhead, now: at(`${day}T09:00:00.000Z`) }), day).toEqual({ action: "nothing" });
    }
    expect(build({ record: fromAhead, now: at("2027-01-06T09:00:00.000Z") })).toMatchObject({ action: "run", firstNotice: true });
  });

  it("3. does nothing once today's slot is closed, however it was closed", () => {
    for (const closedAs of ["done", "cut-short", "first-check"] as const) {
      const closed = record("build", { startedAt: closedAs === "first-check" ? null : BUILD_AT, closedAt: BUILD_AT, closedAs });
      expect(build({ record: closed })).toEqual({ action: "nothing" });
      expect(build({ record: closed, online: true, now: after(BUILD_AT, 20 * 60 * MINUTE) })).toEqual({ action: "nothing" });
    }
  });

  it("4. closes a run that started and was never closed, and starts nothing", () => {
    const died = record("build", { startedAt: BUILD_AT });
    expect(build({ record: died })).toEqual({ action: "close", run: died });
    expect(build({ record: died, online: true })).toEqual({ action: "close", run: died });
    expect(build({ record: died, online: false })).toEqual({ action: "close", run: died });
  });

  it("5. notices a new slot when the record is an earlier day's, whatever state that one was left in", () => {
    const noticed = noticedRun({ day: "2026-10-12", at: at(BUILD_AT) }, now);
    expect(build()).toEqual({ action: "run", run: noticed, lateMs: 20_000, firstNotice: true });
    const neverClosed = { ...yesterdaysBuild, closedAt: null, closedAs: null };
    expect(build({ record: neverClosed })).toEqual({ action: "run", run: noticed, lateMs: 20_000, firstNotice: true });
    const neverStarted = { ...neverClosed, startedAt: null, waiting: "offline" as const };
    expect(build({ record: neverStarted })).toEqual({ action: "run", run: noticed, lateMs: 20_000, firstNotice: true });
  });

  it("5. carries on with today's record when it is open", () => {
    const open = record("build", { noticedAt: "2026-10-12T07:00:05.000Z" });
    expect(build({ record: open })).toEqual({ action: "run", run: open, lateMs: 20_000, firstNotice: false });
  });

  it("6. has the deliver job wait while a build is running", () => {
    const decision = deliver({ build: { open: false, running: true, jobAlive: true } });
    expect(decision).toEqual({ action: "wait", reason: "build-running", run: noticedRun({ day: "2026-10-12", at: at(DELIVER_AT) }, deliverNow), changed: true });
    // A running build is waited for even when its own job has stopped asking the clock.
    expect(deliver({ build: { open: false, running: true, jobAlive: false } })).toMatchObject({ action: "wait", reason: "build-running" });
    // "Could not tell" is not "running".
    expect(deliver({ build: { open: false, running: null, jobAlive: true } })).toMatchObject({ action: "run" });
    expect(deliver({ build: { open: false, running: false, jobAlive: true } })).toMatchObject({ action: "run" });
  });

  it("7. has the deliver job wait for a build that is due and about to start", () => {
    expect(deliver({ build: buildIsLate })).toMatchObject({ action: "wait", reason: "build-not-started", changed: true });
    expect(deliver({ build: { open: true, running: null, jobAlive: true } })).toMatchObject({ action: "wait", reason: "build-not-started" });
    // A build job that has stopped waking will not start it, so there is nothing to wait for.
    expect(deliver({ build: { open: true, running: false, jobAlive: false } })).toMatchObject({ action: "run" });
    expect(deliver({ build: { open: false, running: false, jobAlive: true } })).toMatchObject({ action: "run" });
  });

  it("6 before 7: a running build is the reason given when both are true", () => {
    expect(deliver({ build: { open: true, running: true, jobAlive: true } })).toMatchObject({ action: "wait", reason: "build-running" });
  });

  it("6 and 7 stop applying 20 minutes after the deliver job first found its slot due", () => {
    const waiting = record("deliver", { noticedAt: "2026-10-12T16:00:00.000Z", waiting: "build-running" });
    const running = { open: false, running: true, jobAlive: true };
    const facts = { record: waiting, build: running };
    expect(deliver({ ...facts, now: at("2026-10-12T16:19:59.999Z") })).toEqual({ action: "wait", reason: "build-running", run: waiting, changed: false });
    expect(deliver({ ...facts, now: at("2026-10-12T16:20:00.000Z") })).toEqual({ action: "run", run: waiting, lateMs: 3.5 * 60 * MINUTE + 20 * MINUTE, firstNotice: false });
    expect(deliver({ record: waiting, build: buildIsLate, now: at("2026-10-12T16:20:00.000Z") })).toMatchObject({ action: "run" });
    // The 20 minutes count from the first notice, not from the slot's time.
    expect(deliver({ ...facts, now: at("2026-10-12T16:05:00.000Z") })).toMatchObject({ action: "wait" });
  });

  describe("6 and 7 do not count time asleep", () => {
    // 7:07 am: the sleeping Mac wakes by itself for 40 seconds. The deliver job finds its slot due
    // and the build about to start, and stores that it is waiting. Then the Mac sleeps on.
    const SHORT_WAKE = "2026-10-12T13:07:35.000Z";
    const stored = record("deliver", { noticedAt: SHORT_WAKE, waiting: "build-not-started" });
    // 10:00 am: the lid is opened.
    const opened = at("2026-10-12T16:00:00.000Z");

    it("counts the 20 minutes from now at the first check after the Mac wakes, and says the wait changed so that it is stored", () => {
      const decision = deliver({ record: stored, build: buildIsLate, now: opened, previousCheckAt: SHORT_WAKE });
      expect(decision).toEqual({ action: "wait", reason: "build-not-started", run: { ...stored, noticedAt: "2026-10-12T16:00:00.000Z" }, changed: true });
      // Nothing is changed in place.
      expect(stored.noticedAt).toBe(SHORT_WAKE);
      // A job that has no earlier check on record has just woken too.
      expect(deliver({ record: stored, build: buildIsLate, now: opened, previousCheckAt: null })).toEqual(decision);
      expect(deliver({ record: stored, build: buildIsLate, now: opened, previousCheckAt: "not a time" })).toEqual(decision);
    });

    it("then waits for the build like on any late morning, for 20 minutes from there", () => {
      const counted = record("deliver", { noticedAt: "2026-10-12T16:00:00.000Z", waiting: "build-not-started" });
      const running = { open: false, running: true, jobAlive: true };
      // 10:01, the next check, a minute after the one before: the build has started.
      expect(deliver({ record: counted, build: running, now: at("2026-10-12T16:01:00.000Z"), previousCheckAt: "2026-10-12T16:00:00.000Z" })).toEqual({ action: "wait", reason: "build-running", run: counted, changed: true });
      const waiting = { ...counted, waiting: "build-running" as const };
      expect(deliver({ record: waiting, build: running, now: at("2026-10-12T16:19:00.000Z"), previousCheckAt: "2026-10-12T16:18:00.000Z" })).toEqual({ action: "wait", reason: "build-running", run: waiting, changed: false });
      expect(deliver({ record: waiting, build: running, now: at("2026-10-12T16:20:00.000Z"), previousCheckAt: "2026-10-12T16:19:00.000Z" })).toMatchObject({ action: "run", run: waiting });
    });

    it("only when the check before was more than a gap ago", () => {
      const facts = { record: stored, build: buildIsLate, now: opened };
      expect(deliver({ ...facts, previousCheckAt: new Date(opened.getTime() - WOKE_GAP_MS).toISOString() })).toMatchObject({ action: "run", run: stored });
      expect(deliver({ ...facts, previousCheckAt: new Date(opened.getTime() - WOKE_GAP_MS - 1).toISOString() })).toMatchObject({ action: "wait", changed: true });
      // The Mac was awake all along: the 20 minutes really are over.
      expect(deliver({ ...facts, previousCheckAt: "2026-10-12T15:59:00.000Z" })).toEqual({ action: "run", run: stored, lateMs: 3.5 * 60 * MINUTE, firstNotice: false });
    });

    it("skips the rule when it is not told when the check before was", () => {
      expect(deliver({ record: stored, build: buildIsLate, now: opened })).toEqual({ action: "run", run: stored, lateMs: 3.5 * 60 * MINUTE, firstNotice: false });
    });

    it("says the wait changed even when the reason is the one already stored", () => {
      // A second short wake, at 7:22 am: still waiting for the same thing, but counted from 7:22 now.
      const decision = deliver({ record: stored, build: buildIsLate, now: at("2026-10-12T13:22:10.000Z"), previousCheckAt: SHORT_WAKE });
      expect(decision).toEqual({ action: "wait", reason: "build-not-started", run: { ...stored, noticedAt: "2026-10-12T13:22:10.000Z" }, changed: true });
    });

    it("leaves the record as it stands when there is no build to wait for", () => {
      const noBuild = { open: false, running: false, jobAlive: true };
      const decision = deliver({ record: stored, build: noBuild, now: opened, previousCheckAt: SHORT_WAKE, online: true });
      expect(decision).toEqual({ action: "run", run: stored, lateMs: 3.5 * 60 * MINUTE, firstNotice: false });
      expect(decision.action === "run" && decision.run).toBe(stored);
      // Offline is not a wait for the build: nothing new to store.
      const offline = { ...stored, waiting: "offline" as const };
      expect(deliver({ record: offline, build: noBuild, now: opened, previousCheckAt: SHORT_WAKE, online: false })).toEqual({ action: "wait", reason: "offline", run: offline, changed: false });
    });

    it("has nothing to count afresh on a first notice, and nothing at all for the build job", () => {
      // Yesterday's record: today's slot is noticed now in any case.
      expect(deliver({ build: buildIsLate, now: opened, previousCheckAt: "2026-10-12T05:00:00.000Z" })).toEqual({ action: "wait", reason: "build-not-started", run: noticedRun({ day: "2026-10-12", at: at(DELIVER_AT) }, opened), changed: true });
      // The build job's record is handed back as it stands.
      const waitingBuild = record("build", { noticedAt: "2026-10-12T07:00:05.000Z", waiting: "offline" });
      const decision = build({ record: waitingBuild, now: opened, previousCheckAt: "2026-10-12T07:00:05.000Z", online: false });
      expect(decision).toEqual({ action: "wait", reason: "offline", run: waitingBuild, changed: false });
      expect(build({ record: waitingBuild, now: opened, previousCheckAt: "2026-10-12T07:00:05.000Z", online: true })).toMatchObject({ action: "run", run: waitingBuild });
    });
  });

  describe("6 and 7 do not count time offline", () => {
    // Woke at 8:00 am with no real internet. The deliver job gave the build its 20 minutes, then
    // stored that it is waiting for the internet. At 8:30 GitHub answers again.
    const stored = record("deliver", { noticedAt: "2026-10-12T14:00:00.000Z", waiting: "offline" });
    const back = at("2026-10-12T14:30:00.000Z");
    const facts = { record: stored, build: buildIsLate, now: back, previousCheckAt: "2026-10-12T14:29:00.000Z" };

    it("counts the 20 minutes from now at the check that finds the internet back", () => {
      expect(deliver({ ...facts, online: true })).toEqual({ action: "wait", reason: "build-not-started", run: { ...stored, noticedAt: "2026-10-12T14:30:00.000Z" }, changed: true });
      const running = { open: false, running: true, jobAlive: true };
      expect(deliver({ ...facts, build: running, online: true })).toMatchObject({ action: "wait", reason: "build-running", run: { noticedAt: "2026-10-12T14:30:00.000Z" }, changed: true });
      // It does not need to be told when the check before was.
      expect(deliver({ record: stored, build: buildIsLate, now: back, online: true })).toMatchObject({ action: "wait", reason: "build-not-started", changed: true });
    });

    it("not before the internet has been asked, and not while it is still away", () => {
      // The first time a check asks, without the lock: the answer that sends it to ask the internet.
      expect(deliver(facts)).toEqual({ action: "run", run: stored, lateMs: 2 * 60 * MINUTE, firstNotice: false });
      expect(deliver({ ...facts, online: false })).toEqual({ action: "wait", reason: "offline", run: stored, changed: false });
    });

    it("runs when the internet is back and there is no build to wait for", () => {
      expect(deliver({ ...facts, build: { open: false, running: false, jobAlive: true }, online: true })).toEqual({ action: "run", run: stored, lateMs: 2 * 60 * MINUTE, firstNotice: false });
    });

    it("only for a record that was waiting for the internet", () => {
      // Waiting for the build, with its 20 minutes over, and online all along: it runs.
      const forBuild = { ...stored, waiting: "build-running" as const };
      expect(deliver({ ...facts, record: forBuild, online: true })).toMatchObject({ action: "run", run: forBuild });
    });
  });

  it("6 and 7 are for the deliver job only, and only when the build's state is given", () => {
    expect(build({ build: { open: true, running: true, jobAlive: true } })).toMatchObject({ action: "run" });
    expect(deliver()).toMatchObject({ action: "run" });
  });

  describe("the lid closed on battery (after 6 and 7, before 8)", () => {
    const noticed = noticedRun({ day: "2026-10-12", at: at(BUILD_AT) }, now);
    const noBuild = { open: false, running: false, jobAlive: true };

    it("waits when the Mac is on battery with its lid closed: the build job", () => {
      expect(build({ lidClosedOnBattery: true })).toEqual({ action: "wait", reason: "lid-closed", run: noticed, changed: true });
      // Whatever the internet says.
      expect(build({ lidClosedOnBattery: true, online: true })).toEqual({ action: "wait", reason: "lid-closed", run: noticed, changed: true });
    });

    it("waits when the Mac is on battery with its lid closed: the deliver job", () => {
      const deliverNoticed = noticedRun({ day: "2026-10-12", at: at(DELIVER_AT) }, deliverNow);
      expect(deliver({ lidClosedOnBattery: true })).toEqual({ action: "wait", reason: "lid-closed", run: deliverNoticed, changed: true });
      // With no build to wait for, told so or not.
      expect(deliver({ build: noBuild, lidClosedOnBattery: true, online: true })).toEqual({ action: "wait", reason: "lid-closed", run: deliverNoticed, changed: true });
    });

    it("skips the question when it was not asked, and runs when the answer is no", () => {
      expect(build()).toMatchObject({ action: "run" });
      expect(build({ online: true })).toMatchObject({ action: "run" });
      expect(build({ lidClosedOnBattery: false })).toMatchObject({ action: "run" });
      expect(build({ lidClosedOnBattery: false, online: true })).toEqual({ action: "run", run: noticed, lateMs: 20_000, firstNotice: true });
      expect(deliver({ build: noBuild, lidClosedOnBattery: false, online: true })).toMatchObject({ action: "run", lateMs: 20_000 });
    });

    it("only a plain yes holds a run up: a reading that could not be made is handed over as no, and is never in the way", () => {
      // The caller turns "unknown" power, a Mac without a lid and a tool that failed into false,
      // or leaves the fact out. Neither is a yes.
      // @ts-expect-error The fact is a yes or a no. "Could not tell" has no value of its own here.
      const unknown: NightFacts = { job: "build", now, config, record: yesterdaysBuild, online: true, lidClosedOnBattery: null };
      expect(decideNight(unknown)).toMatchObject({ action: "run" });
      // @ts-expect-error Nor is a word a yes.
      const word: NightFacts = { job: "build", now, config, record: yesterdaysBuild, online: true, lidClosedOnBattery: "unknown" };
      expect(decideNight(word)).toMatchObject({ action: "run" });
    });

    it("after 6 and 7: the deliver job names the build first, for its 20 minutes", () => {
      expect(deliver({ build: buildIsLate, lidClosedOnBattery: true })).toMatchObject({ action: "wait", reason: "build-not-started" });
      expect(deliver({ build: { open: false, running: true, jobAlive: true }, lidClosedOnBattery: true })).toMatchObject({ action: "wait", reason: "build-running" });
      // After the 20 minutes the lid is what is left to wait for. It does not run.
      const waited = record("deliver", { noticedAt: DELIVER_AT, waiting: "build-not-started" });
      expect(deliver({ record: waited, build: buildIsLate, lidClosedOnBattery: true, now: after(DELIVER_AT, 20 * MINUTE) })).toEqual({ action: "wait", reason: "lid-closed", run: waited, changed: true });
    });

    it("before 8: the lid is the reason given when the internet is away as well", () => {
      expect(build({ lidClosedOnBattery: true, online: false })).toMatchObject({ action: "wait", reason: "lid-closed" });
      expect(deliver({ build: noBuild, lidClosedOnBattery: true, online: false })).toMatchObject({ action: "wait", reason: "lid-closed" });
      // With the lid open, or on mains power, the internet is asked as before.
      expect(build({ lidClosedOnBattery: false, online: false })).toMatchObject({ action: "wait", reason: "offline" });
    });

    it("says the wait changed the first time and when the reason is a new one, and not while it stays the same", () => {
      const stored = record("build", { noticedAt: "2026-10-12T07:01:00.000Z", waiting: "lid-closed" });
      // The next moment's wake, a quarter of an hour on: the same answer, and nothing new to store or say.
      const again = build({ record: stored, lidClosedOnBattery: true, now: after(BUILD_AT, 16 * MINUTE), previousCheckAt: "2026-10-12T07:01:00.000Z" });
      expect(again).toEqual({ action: "wait", reason: "lid-closed", run: stored, changed: false });
      // Noticed and stored, but not waiting for anything yet.
      expect(build({ record: record("build"), lidClosedOnBattery: true })).toMatchObject({ action: "wait", reason: "lid-closed", changed: true });
      // It was waiting for the internet, and then the plug was pulled with the lid closed.
      expect(build({ record: record("build", { waiting: "offline" }), lidClosedOnBattery: true })).toMatchObject({ action: "wait", reason: "lid-closed", changed: true });
      // And the other way: the lid is open again, and now the internet is away.
      expect(build({ record: stored, lidClosedOnBattery: false, online: false })).toEqual({ action: "wait", reason: "offline", run: stored, changed: true });
    });

    it("runs once the lid is opened or the Mac is plugged in, and hands back the record as it stands", () => {
      const stored = record("build", { noticedAt: "2026-10-12T07:01:00.000Z", waiting: "lid-closed" });
      // 8:00 am: seven hours after the build's time.
      const opened = after(BUILD_AT, 7 * 60 * MINUTE);
      const decision = build({ record: stored, lidClosedOnBattery: false, online: true, now: opened });
      expect(decision).toEqual({ action: "run", run: stored, lateMs: 7 * 60 * MINUTE, firstNotice: false });
      expect(decision.action === "run" && decision.run).toBe(stored);
      // The first time a check asks, before it has read the lid: the answer that sends it to read it.
      expect(build({ record: stored, now: opened })).toMatchObject({ action: "run", run: stored });
    });

    it("keeps the slot due for as long as the lid stays closed: there is no hour after which it starts anyway", () => {
      const stored = record("build", { noticedAt: "2026-10-12T07:01:00.000Z", waiting: "lid-closed" });
      expect(build({ record: stored, lidClosedOnBattery: true, now: after(BUILD_AT, 23 * 60 * MINUTE + 59 * MINUTE) })).toEqual({ action: "wait", reason: "lid-closed", run: stored, changed: false });
      // The next day's time has come: that slot is found due, and waits in its turn.
      expect(build({ record: stored, lidClosedOnBattery: true, now: after(BUILD_AT, 24 * 60 * MINUTE) })).toMatchObject({ action: "wait", reason: "lid-closed", run: { day: "2026-10-13", waiting: null }, changed: true });
    });

    it("comes after lines 1 to 4: a first check, a closed slot, a record ahead and a run that died are answered as before", () => {
      expect(build({ record: null, lidClosedOnBattery: true })).toMatchObject({ action: "adopt" });
      expect(build({ record: record("build", { day: "2026-10-13" }), lidClosedOnBattery: true })).toEqual({ action: "nothing" });
      expect(build({ record: record("build", { startedAt: BUILD_AT, closedAt: BUILD_AT, closedAs: "done" }), lidClosedOnBattery: true })).toEqual({ action: "nothing" });
      const died = record("build", { startedAt: BUILD_AT });
      expect(build({ record: died, lidClosedOnBattery: true })).toEqual({ action: "close", run: died });
    });

    it("does not count the deliver job's 20 minutes afresh by itself: waking does that, as on any morning", () => {
      // The delivery was due in a moment's wake at 6:31 am, with no build to wait for, and stored that it waits for the lid.
      const stored = record("deliver", { noticedAt: "2026-10-12T12:31:00.000Z", waiting: "lid-closed" });
      const SHORT_WAKE = "2026-10-12T12:31:00.000Z";
      // The next wake: still closed. The record is handed back as it stands, and nothing is stored again.
      expect(deliver({ record: stored, build: noBuild, lidClosedOnBattery: true, now: at("2026-10-12T12:46:00.000Z"), previousCheckAt: SHORT_WAKE })).toEqual({ action: "wait", reason: "lid-closed", run: stored, changed: false });
      // 8:00 am: opened. A build that is late as well is waited for, with the 20 minutes counted from this waking.
      const opened = at("2026-10-12T14:00:00.000Z");
      expect(deliver({ record: stored, build: buildIsLate, lidClosedOnBattery: false, online: true, now: opened, previousCheckAt: SHORT_WAKE })).toEqual({
        action: "wait",
        reason: "build-not-started",
        run: { ...stored, noticedAt: "2026-10-12T14:00:00.000Z" },
        changed: true,
      });
      // With no build to wait for it simply runs.
      expect(deliver({ record: stored, build: noBuild, lidClosedOnBattery: false, online: true, now: opened, previousCheckAt: SHORT_WAKE })).toEqual({ action: "run", run: stored, lateMs: 90 * MINUTE, firstNotice: false });
    });
  });

  it("8. waits when the internet does not answer, and skips the question when it was not asked", () => {
    const noticed = noticedRun({ day: "2026-10-12", at: at(BUILD_AT) }, now);
    expect(build({ online: false })).toEqual({ action: "wait", reason: "offline", run: noticed, changed: true });
    expect(build({ online: true })).toMatchObject({ action: "run" });
    expect(build()).toMatchObject({ action: "run" });
    expect(deliver({ online: false })).toMatchObject({ action: "wait", reason: "offline" });
  });

  it("6 and 7 before 8: the deliver job names the build first", () => {
    expect(deliver({ build: buildIsLate, online: false })).toMatchObject({ action: "wait", reason: "build-not-started" });
    // After the 20 minutes the internet is the only thing left to wait for.
    const waited = record("deliver", { noticedAt: DELIVER_AT, waiting: "build-not-started" });
    expect(deliver({ record: waited, build: buildIsLate, online: false, now: after(DELIVER_AT, 20 * MINUTE) })).toEqual({ action: "wait", reason: "offline", run: waited, changed: true });
  });

  it("9. otherwise runs, and says how late", () => {
    expect(build({ now: at(BUILD_AT), online: true })).toMatchObject({ action: "run", lateMs: 0, firstNotice: true });
    expect(build({ now: after(BUILD_AT, 2 * 60 * MINUTE + MINUTE), online: true })).toMatchObject({ action: "run", lateMs: 121 * MINUTE });
    expect(deliver({ online: true, build: { open: false, running: false, jobAlive: true } })).toMatchObject({ action: "run", lateMs: 20_000 });
    // A slot stays due until the next one: 23 hours late still runs.
    expect(build({ now: after(BUILD_AT, 23 * 60 * MINUTE), online: true })).toMatchObject({ action: "run", lateMs: 23 * 60 * MINUTE });
  });

  it("says a wait changed the first time, and when the reason is a new one", () => {
    expect(build({ online: false })).toMatchObject({ action: "wait", changed: true });
    const offline = record("build", { waiting: "offline" });
    expect(build({ record: offline, online: false })).toEqual({ action: "wait", reason: "offline", run: offline, changed: false });
    // Noticed and stored, but not waiting for anything yet.
    expect(build({ record: record("build"), online: false })).toMatchObject({ action: "wait", changed: true });
    const forBuild = record("deliver", { waiting: "build-not-started" });
    expect(deliver({ record: forBuild, build: buildIsLate })).toMatchObject({ action: "wait", reason: "build-not-started", changed: false });
    expect(deliver({ record: forBuild, build: { open: false, running: true, jobAlive: true } })).toMatchObject({ action: "wait", reason: "build-running", changed: true });
  });

  it("hands back the record as it stands, for the caller to take the next step", () => {
    const offline = record("build", { waiting: "offline" });
    // Online again: the answer is to run, and the record still says what it was waiting for.
    const decision = build({ record: offline, online: true });
    expect(decision).toEqual({ action: "run", run: offline, lateMs: 20_000, firstNotice: false });
    expect(decision.action === "run" && decision.run).toBe(offline);
  });

  it("has no rule about mains power: on battery a build runs like any other", () => {
    // @ts-expect-error The facts have no power source. The owner's decision of Oct 11: the Mac is kept awake on battery too.
    const facts: NightFacts = { job: "build", now, config, record: yesterdaysBuild, online: true, power: "battery" };
    expect(decideNight(facts)).toMatchObject({ action: "run", lateMs: 20_000 });
    // On battery with the lid open, as the caller reports it: not a reason to wait.
    expect(build({ lidClosedOnBattery: false, online: true })).toMatchObject({ action: "run", lateMs: 20_000 });
  });

  it("goes by day names on the night the clocks go back: one slot, 25 hours long", () => {
    // Nov 1, 2026. The first 1:00 am is 07:00Z; the build runs then.
    const ran = closedRun(startedRun(noticedRun({ day: "2026-11-01", at: at("2026-11-01T07:00:00.000Z") }, at("2026-11-01T07:00:10.000Z")), at("2026-11-01T07:00:10.000Z")), "done", at("2026-11-01T07:20:00.000Z"));
    // The second 1:00 am, an hour later, is the same day's slot: nothing.
    expect(build({ record: ran, now: at("2026-11-01T08:00:00.000Z") })).toEqual({ action: "nothing" });
    expect(build({ record: ran, now: at("2026-11-02T07:59:59.000Z") })).toEqual({ action: "nothing" });
    expect(build({ record: ran, now: at("2026-11-02T08:00:00.000Z") })).toMatchObject({ action: "run", lateMs: 0, firstNotice: true });
  });

  it("starts on time where the clocks skip midnight, for a job timed inside the skipped hour", () => {
    // Havana, Mar 14, 2027: midnight becomes 1 am, so 00:30 does not exist. It is taken as 04:30Z.
    const havana = { timeZone: "America/Havana", buildTime: "00:30", deliverTime: "07:00" };
    const ran: NightRun = { day: "2027-03-13", slotAt: "2027-03-13T05:30:00.000Z", noticedAt: "2027-03-13T05:30:00.000Z", startedAt: "2027-03-13T05:30:00.000Z", closedAt: "2027-03-13T05:40:00.000Z", closedAs: "done", waiting: null };
    expect(decideNight({ job: "build", now: at("2027-03-14T04:29:00.000Z"), config: havana, record: ran })).toEqual({ action: "nothing" });
    // Not half an hour late, when the local day turns.
    expect(decideNight({ job: "build", now: at("2027-03-14T04:30:00.000Z"), config: havana, record: ran })).toMatchObject({ action: "run", lateMs: 0, run: { day: "2027-03-14", slotAt: "2027-03-14T04:30:00.000Z" } });
    // And `status` never names the day after as the next build while this one has not come up.
    expect(describeNight({ job: "build", now: at("2027-03-14T04:30:00.000Z"), config: havana, record: ran, last: ran, checkedAt: null, running: false })).toMatchObject({ state: "due", slotDay: "2027-03-14", nextSlotAt: "2027-03-15T04:30:00.000Z" });
  });

  it("finds the day already closed when BUILD_TIME is moved later the same day", () => {
    const ran = record("build", { startedAt: BUILD_AT, closedAt: "2026-10-12T07:20:00.000Z", closedAs: "done" });
    const moved = { ...config, buildTime: "15:00" };
    // 3:00 pm on Oct 12 is 21:00Z: a new time, the same day's slot.
    expect(decideNight({ job: "build", now: at("2026-10-12T21:00:00.000Z"), config: moved, record: ran })).toEqual({ action: "nothing" });
    expect(decideNight({ job: "build", now: at("2026-10-13T21:00:00.000Z"), config: moved, record: ran })).toMatchObject({ action: "run", lateMs: 0 });
  });
});

describe("a job's night, for people", () => {
  const now = after(BUILD_AT, 5 * MINUTE);
  const view = (changes: Partial<Parameters<typeof describeNight>[0]> = {}) => describeNight({ job: "build", now, config, record: null, last: null, checkedAt: null, running: false, ...changes });
  const lastNight = { day: "2026-10-11", startedAt: "2026-10-11T07:00:20.000Z", closedAt: "2026-10-11T07:21:00.000Z", closedAs: "done", lateMinutes: 0 };

  it("says so when the job has never asked the clock", () => {
    expect(view()).toEqual({
      slotAt: BUILD_AT,
      slotDay: "2026-10-12",
      state: "no-record",
      waiting: null,
      nextSlotAt: "2026-10-13T07:00:00.000Z",
      checkedAt: null,
      lastRun: null,
      recordAhead: null,
    });
  });

  it("passes the heartbeat through", () => {
    expect(view({ checkedAt: "2026-10-12T07:04:30.000Z" }).checkedAt).toBe("2026-10-12T07:04:30.000Z");
  });

  it("is due when the current slot's run has not started", () => {
    expect(view({ record: yesterdaysBuild, last: yesterdaysBuild })).toMatchObject({ state: "due", waiting: null, lastRun: lastNight });
    expect(view({ record: record("build"), last: yesterdaysBuild })).toMatchObject({ state: "due", waiting: null, lastRun: lastNight });
  });

  it("says why a due slot is waiting", () => {
    expect(view({ record: record("build", { waiting: "offline" }) })).toMatchObject({ state: "due", waiting: "offline", lastRun: null });
    expect(view({ record: record("build", { waiting: "lid-closed" }) })).toMatchObject({ state: "due", waiting: "lid-closed", lastRun: null });
    expect(describeNight({ job: "deliver", now: after(DELIVER_AT, MINUTE), config, record: record("deliver", { waiting: "lid-closed" }), last: null, checkedAt: null, running: false })).toMatchObject({ state: "due", waiting: "lid-closed" });
    const deliverView = describeNight({ job: "deliver", now: after(DELIVER_AT, MINUTE), config, record: record("deliver", { waiting: "build-running" }), last: null, checkedAt: null, running: false });
    expect(deliverView).toMatchObject({ state: "due", waiting: "build-running", slotAt: DELIVER_AT, nextSlotAt: "2026-10-13T12:30:00.000Z" });
    // A reason left on an earlier day's record is not today's reason.
    expect(view({ record: { ...yesterdaysBuild, startedAt: null, closedAt: null, closedAs: null, waiting: "offline" } })).toMatchObject({ state: "due", waiting: null });
  });

  it("is running while a started run is not closed, with that run as the last one", () => {
    const started = record("build", { startedAt: "2026-10-12T07:00:20.000Z" });
    const expected = { state: "running", waiting: null, lastRun: { day: "2026-10-12", startedAt: "2026-10-12T07:00:20.000Z", closedAt: null, closedAs: null, lateMinutes: 0 } };
    expect(view({ record: started, last: yesterdaysBuild, running: true })).toMatchObject(expected);
    // Could not tell whether the lock is held: take the record's word.
    expect(view({ record: started, last: yesterdaysBuild, running: null })).toMatchObject(expected);
  });

  it("is not running once the job's lock is free: that run's process died, and the slot will not start again", () => {
    const started = record("build", { startedAt: "2026-10-12T07:00:20.000Z" });
    expect(view({ record: started, running: false })).toMatchObject({ state: "done", lastRun: { day: "2026-10-12", closedAt: null, closedAs: null } });
  });

  it("is running when an earlier slot's run is still going as the next slot comes", () => {
    const stillGoing = { ...yesterdaysBuild, startedAt: "2026-10-12T06:50:00.000Z", closedAt: null, closedAs: null };
    expect(view({ record: stillGoing, running: true })).toMatchObject({ state: "running", slotDay: "2026-10-12", lastRun: { day: "2026-10-11", lateMinutes: 23 * 60 + 50 } });
    // If it died instead, today's slot is simply due.
    expect(view({ record: stillGoing, running: false })).toMatchObject({ state: "due" });
  });

  it("is done when today's slot is closed, and shows how the last run went", () => {
    const done = record("build", { startedAt: "2026-10-12T07:00:20.000Z", closedAt: "2026-10-12T07:03:00.000Z", closedAs: "done" });
    expect(view({ record: done, last: done })).toMatchObject({ state: "done", lastRun: { day: "2026-10-12", startedAt: "2026-10-12T07:00:20.000Z", closedAt: "2026-10-12T07:03:00.000Z", closedAs: "done", lateMinutes: 0 } });
    const cut = { ...done, closedAs: "cut-short" as const };
    expect(view({ record: cut, last: cut })).toMatchObject({ state: "done", lastRun: { closedAs: "cut-short" } });
    // A lock held by a run started by hand does not make a closed slot "running".
    expect(view({ record: done, last: done, running: true })).toMatchObject({ state: "done" });
  });

  it("is done after a first check, with the last run from before", () => {
    const adopted = record("build", { closedAt: BUILD_AT, closedAs: "first-check" });
    expect(view({ record: adopted })).toMatchObject({ state: "done", lastRun: null });
    expect(view({ record: adopted, last: yesterdaysBuild })).toMatchObject({ state: "done", lastRun: lastNight });
  });

  it("is done while the record is ahead of the clock, and says which day the record is dated", () => {
    expect(view({ record: record("build", { day: "2026-10-13", closedAt: BUILD_AT, closedAs: "first-check" }) })).toMatchObject({ state: "done", waiting: null, recordAhead: "2026-10-13" });
  });

  it("shows a job that a record dated far ahead has stopped, for as long as it stays stopped", () => {
    // Written while the Mac's clock read Jan 5, 2027. Nothing is due until then, and that must not look healthy.
    const fromAhead: NightRun = { day: "2027-01-05", slotAt: "2027-01-05T08:00:00.000Z", noticedAt: "2027-01-05T08:00:00.000Z", startedAt: "2027-01-05T08:00:00.000Z", closedAt: "2027-01-05T08:10:00.000Z", closedAs: "done", waiting: null };
    for (const day of ["2026-10-13", "2026-12-13", "2027-01-04"]) {
      expect(view({ record: fromAhead, last: fromAhead, now: at(`${day}T09:00:00.000Z`) }), day).toMatchObject({ state: "done", slotDay: day, recordAhead: "2027-01-05" });
    }
    // On the day itself the record is simply that day's, closed. The day after, the job runs again.
    expect(view({ record: fromAhead, last: fromAhead, now: at("2027-01-05T09:00:00.000Z") })).toMatchObject({ state: "done", recordAhead: null });
    expect(view({ record: fromAhead, last: fromAhead, now: at("2027-01-06T09:00:00.000Z") })).toMatchObject({ state: "due", recordAhead: null });
  });

  it("says no record is ahead in every usual state", () => {
    const done = record("build", { startedAt: "2026-10-12T07:00:20.000Z", closedAt: "2026-10-12T07:03:00.000Z", closedAs: "done" });
    for (const stored of [null, yesterdaysBuild, record("build"), record("build", { waiting: "offline" }), record("build", { startedAt: "2026-10-12T07:00:20.000Z" }), done]) {
      expect(view({ record: stored, running: null }).recordAhead).toBeNull();
    }
  });

  it("counts lateness in whole minutes, rounded down", () => {
    const startedAt = (iso: string) => view({ record: record("build", { startedAt: iso, closedAt: iso, closedAs: "done" }) }).lastRun?.lateMinutes;
    expect(startedAt("2026-10-12T07:00:59.999Z")).toBe(0);
    expect(startedAt("2026-10-12T07:01:00.000Z")).toBe(1);
    expect(startedAt("2026-10-12T09:01:30.000Z")).toBe(121);
    // A clock that was set back in between is not "minus two minutes late".
    expect(startedAt("2026-10-12T06:58:00.000Z")).toBe(0);
  });
});
