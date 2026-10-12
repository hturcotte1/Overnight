// The night clock: Overnight's own answer to "is it time to build, or to deliver?".
//
// macOS only wakes each night job once a minute (and at login). Whether a run starts is decided
// here, from the time, the three settings TZ, BUILD_TIME and DELIVER_TIME, and one small record
// per job in the database.
//
// Each job has one slot a day: build at BUILD_TIME, deliver 30 minutes before DELIVER_TIME. A slot
// is named by its local day, and "the slot" is always the latest one at or before now. Two things
// follow from that:
//   - A night is never doubled. A job starts at most once for a slot, and the start is written
//     down before the work begins. A start that was written and never closed is not repeated.
//   - A night is not missed silently. A slot stays due until the next one, so a Mac that was
//     asleep or off catches up when it wakes, and the reason a due slot is not starting is stored.
//
// Everything here is pure, apart from the five small helpers that read and write stored values.
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { nextLocalTime, parseHhMm, previousLocalTime } from "./time.ts";

/** The deliver job starts this long before DELIVER_TIME, so the link is ready when the wrist buzzes. */
export const DELIVER_LEAD_MINUTES = 30;
/** How often macOS wakes each night job to ask the clock. The templates in launchd/ use the same number. */
export const NIGHT_TICK_SECONDS = 60;
/** A job that has not asked the clock for longer than this, and is not running, has stopped waking. */
export const NIGHT_CHECK_FRESH_MS = 180_000;
/** A longer gap than this since a job's previous check means the Mac was asleep or off in between. */
export const WOKE_GAP_MS = 150_000;
/**
 * How long a due run waits in place after such a gap, so a Mac that woke only for a moment starts
 * nothing. This wait and the minute to the job's next check must together stay under WOKE_GAP_MS,
 * or the check that follows a wait would look like a wake itself.
 */
export const SETTLE_MS = 60_000;
/**
 * How long the deliver job waits for a late build. Counted from when it first found its own slot
 * due, or from when the Mac last woke or the internet came back, if that was later.
 */
export const DELIVER_WAITS_FOR_BUILD_MS = 1_200_000;
/** A run that started later than this after its time is called late. */
export const LATE_AFTER_MS = 120_000;

/** The two jobs that go by this clock. */
export type ClockedJob = "build" | "deliver";
export const CLOCKED_JOBS: readonly ClockedJob[] = ["build", "deliver"];

export type NightClockConfig = Pick<Config, "timeZone" | "buildTime" | "deliverTime">;

// ---------- slots ----------

/** A time of day, some minutes earlier, as "HH:MM". It wraps around midnight: 00:10 less 30 minutes is 23:40. */
export function clockMinus(hhmm: string, minutes: number): string {
  const { hour, minute } = parseHhMm(hhmm);
  const total = (((hour * 60 + minute - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The time of day a job's slot comes, as "HH:MM" on the local clock. */
export function slotTime(job: ClockedJob, config: Pick<Config, "buildTime" | "deliverTime">): string {
  return job === "build" ? config.buildTime : clockMinus(config.deliverTime, DELIVER_LEAD_MINUTES);
}

export interface NightSlot {
  /** The slot's local day, YYYY-MM-DD. This is its name. */
  day: string;
  /** The moment the slot's time came. */
  at: Date;
}

/** The job's latest slot at or before `now`. */
export function currentSlot(job: ClockedJob, now: Date, config: NightClockConfig): NightSlot {
  return previousLocalTime(now, slotTime(job, config), config.timeZone);
}

/** When the job's next slot comes, strictly after `now`. */
export function nextSlotAt(job: ClockedJob, now: Date, config: NightClockConfig): Date {
  return nextLocalTime(now, slotTime(job, config), config.timeZone);
}

// ---------- the stored record ----------

/**
 * Why a due slot is not starting yet.
 *   build-running      (deliver) the build is running right now
 *   build-not-started  (deliver) the build is due too and its job is awake, so it is about to start
 *   offline            GitHub did not answer, so there is no real internet
 */
export type NightWait = "build-running" | "build-not-started" | "offline";

/** What is stored about one job's latest slot. Times are UTC, as `toISOString()` writes them. */
export interface NightRun {
  /** The slot's local day, YYYY-MM-DD. */
  day: string;
  /** When the slot's time came. */
  slotAt: string;
  /**
   * When a check first found this slot due. For a deliver slot that is waiting for the build it
   * is moved on when the Mac wakes and when the internet comes back: the 20 minutes count from here.
   */
  noticedAt: string;
  /** When the work started, or null if it has not. Written before the work begins. */
  startedAt: string | null;
  /** When the slot was closed. A closed slot never starts anything. */
  closedAt: string | null;
  /**
   * How it was closed. "done": the run ended by itself. "cut-short": the run was stopped, or its
   * process died. "first-check": handled without a run (the job's first ever check, or its clock
   * was started from now).
   */
  closedAs: "done" | "cut-short" | "first-check" | null;
  /** Why the slot is due and not starting, or null. */
  waiting: NightWait | null;
}

/** True for a time exactly as `toISOString()` writes it, so that text order is time order. */
function isIsoTime(value: string): boolean {
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

const isoTime = z.string().refine(isIsoTime, "must be a UTC time like 2026-10-12T07:00:00.000Z");

export const nightRunSchema: z.ZodType<NightRun> = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a day like 2026-10-12"),
    slotAt: isoTime,
    noticedAt: isoTime,
    startedAt: isoTime.nullable(),
    closedAt: isoTime.nullable(),
    closedAs: z.enum(["done", "cut-short", "first-check"]).nullable(),
    waiting: z.enum(["build-running", "build-not-started", "offline"]).nullable(),
  })
  .refine((run) => (run.closedAt === null) === (run.closedAs === null), "closedAt and closedAs are set together");

// Stored in the database's small values (the kv table), three per job:
//   night.<job>.run        the record of the job's latest slot
//   night.<job>.last       the latest run that started and was closed, for `status`
//   night.<job>.checkedAt  when the job last asked the clock: its heartbeat
type StoredKind = "run" | "last" | "checkedAt";
const storedKey = (job: ClockedJob, kind: StoredKind) => `night.${job}.${kind}`;

function readStoredRun(store: Pick<Store, "getValue">, key: string): NightRun | null {
  const text = store.getValue(key);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = nightRunSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The record of the job's latest slot. Null when there is none, or when what is stored is not a valid record. */
export function readNightRun(store: Pick<Store, "getValue">, job: ClockedJob): NightRun | null {
  return readStoredRun(store, storedKey(job, "run"));
}

/**
 * Store the job's record. A run that started and is now closed is also kept as the job's last run.
 * Throws for a record that could not be read back: stored anyway, it would read as "no record",
 * and the job's next check would quietly take the night as handled.
 */
export function writeNightRun(store: Pick<Store, "setValue">, job: ClockedJob, run: NightRun, now: Date): void {
  const checked = nightRunSchema.safeParse(run);
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Not a valid night clock record for the ${job} job. ${problems}`);
  }
  const text = JSON.stringify(checked.data);
  // The record first: it is the one the next check decides by.
  store.setValue(storedKey(job, "run"), text, now.toISOString());
  if (run.closedAt !== null && run.startedAt !== null) store.setValue(storedKey(job, "last"), text, now.toISOString());
}

/** The job's latest run that started and was closed, or null. It outlives the next slot's record. */
export function readLastNightRun(store: Pick<Store, "getValue">, job: ClockedJob): NightRun | null {
  return readStoredRun(store, storedKey(job, "last"));
}

/** When the job last asked the clock, or null if it never has (or the stored value is not a time). */
export function readCheckedAt(store: Pick<Store, "getValue">, job: ClockedJob): string | null {
  const value = store.getValue(storedKey(job, "checkedAt"));
  return value !== null && isIsoTime(value) ? value : null;
}

/** Write the job's heartbeat: it asked the clock at `now`. */
export function noteChecked(store: Pick<Store, "setValue">, job: ClockedJob, now: Date): void {
  store.setValue(storedKey(job, "checkedAt"), now.toISOString(), now.toISOString());
}

// ---------- the steps a record goes through ----------

/** A new record for a slot that a check has just found due. */
export function noticedRun(slot: NightSlot, now: Date): NightRun {
  return { day: slot.day, slotAt: slot.at.toISOString(), noticedAt: now.toISOString(), startedAt: null, closedAt: null, closedAs: null, waiting: null };
}

/** The same record, waiting for `reason`, or no longer waiting (null). */
export function waitingRun(run: NightRun, reason: NightWait | null): NightRun {
  return { ...run, waiting: reason };
}

/** The same record, with its work started at `now`. A run that has started is not waiting. */
export function startedRun(run: NightRun, now: Date): NightRun {
  return { ...run, startedAt: now.toISOString(), waiting: null };
}

/** The same record, closed at `now`. */
export function closedRun(run: NightRun, how: NonNullable<NightRun["closedAs"]>, now: Date): NightRun {
  return { ...run, closedAt: now.toISOString(), closedAs: how, waiting: null };
}

/**
 * True when the job's current slot is due and its run has not started, so the job will start it
 * at one of its next checks. False when there is no record: a job's first check takes the slot
 * as handled and runs nothing.
 */
export function slotIsOpen(job: ClockedJob, now: Date, config: NightClockConfig, record: NightRun | null): boolean {
  if (record === null) return false;
  const slot = currentSlot(job, now, config);
  if (record.day !== slot.day) return record.day < slot.day;
  return record.startedAt === null && record.closedAt === null;
}

// ---------- the rule ----------

export interface NightFacts {
  job: ClockedJob;
  now: Date;
  config: NightClockConfig;
  /** The job's stored record (`readNightRun`). */
  record: NightRun | null;
  /**
   * For the deliver job only: how the build stands. `open` is `slotIsOpen` for the build job,
   * `running` is whether a build holds the build lock (null: could not tell), `jobAlive` is
   * whether the build job is still waking to ask the clock.
   */
  build?: { open: boolean; running: boolean | null; jobAlive: boolean };
  /** Does the internet answer? Left out when it has not been asked yet, which skips that rule. */
  online?: boolean;
  /**
   * When this job asked the clock the time before this one: what `readCheckedAt` gave before this
   * check's `noteChecked`, null if it gave nothing. It tells a check that the Mac has just woken.
   * Give the same value both times a check asks. Left out, the rule that needs it is skipped.
   */
  previousCheckAt?: string | null;
}

/** True when the check before this one was so long ago that the Mac was asleep or off in between, or there was none. */
function hasJustWoken(previousCheckAt: string | null | undefined, now: Date): boolean {
  if (previousCheckAt === undefined) return false;
  if (previousCheckAt === null) return true;
  // Written this way round so that a value that is not a time counts as a gap too.
  return !(now.getTime() - Date.parse(previousCheckAt) <= WOKE_GAP_MS);
}

/**
 * What a check should do. `run` in an answer is the record as it stands before the answer is
 * acted on: the stored one, or a new one for a slot found due just now. (One exception: in a
 * deliver job's wait for the build, `noticedAt` can have been moved to now. See `decideNight`.)
 * The caller writes the next step itself from that `run` (`closedRun`, `waitingRun`, `startedRun`).
 */
export type NightDecision =
  /** Nothing is due. */
  | { action: "nothing" }
  /** The job's first ever check. Write a record for `slot` that is closed as "first-check", and run nothing. */
  | { action: "adopt"; slot: NightSlot }
  /** `run` started and was never closed, so its process died. Close it as "cut-short", and run nothing. */
  | { action: "close"; run: NightRun }
  /** Due, but not yet. When `changed`, store the record with this reason and say so once. */
  | { action: "wait"; reason: NightWait; run: NightRun; changed: boolean }
  /** Start the work. `lateMs` is how long after the slot's time. `firstNotice`: `run` is not stored yet. */
  | { action: "run"; run: NightRun; lateMs: number; firstNotice: boolean };

/**
 * The rule, in order. It is asked twice for a run: once without the job's lock (and without
 * `online`), then again under the lock with the record read again.
 *
 * The deliver job gives a late build 20 minutes. They are minutes in which the delivery could
 * have run, so they are counted from the start again by the first check after the Mac wakes and
 * by the check that finds the internet back. Otherwise a wait stored in a moment's wake at 7 am
 * would have used them up hours before anyone opens the lid, and the delivery would start with
 * the build instead of after it.
 */
export function decideNight(facts: NightFacts): NightDecision {
  const { job, now, config, record } = facts;
  const slot = currentSlot(job, now, config);

  // The job's first ever check. Whether this slot was already handled some other way (the old
  // calendar job, a run by hand) cannot be known, so it counts as handled: that can cost one
  // night, and can never double one.
  if (record === null) return { action: "adopt", slot };
  // The clock, TZ or the job's time was moved back. Nothing is due until the slot catches up.
  // That holds however far ahead the record is. To drop it as a mistake would be wrong when it is
  // the Mac's clock that is wrong for a moment (years back, after a flat battery): the night that
  // had run would run again once the clock was put right. `describeNight` shows it instead.
  if (record.day > slot.day) return { action: "nothing" };

  const same = record.day === slot.day ? record : null;
  if (same !== null && same.closedAt !== null) return { action: "nothing" };
  // Started and never closed: its process died. A start is never repeated.
  if (same !== null && same.startedAt !== null) return { action: "close", run: same };

  const run = same ?? noticedRun(slot, now);
  const firstNotice = same === null;

  // A late morning: give a late build a while to finish, so its app goes out today.
  if (job === "deliver" && facts.build !== undefined) {
    // Time asleep and time offline are not part of the while (see above): count from now.
    const afresh = same !== null && (hasJustWoken(facts.previousCheckAt, now) || (same.waiting === "offline" && facts.online === true));
    const counted = afresh ? { ...run, noticedAt: now.toISOString() } : run;
    if (now.getTime() - Date.parse(counted.noticedAt) < DELIVER_WAITS_FOR_BUILD_MS) {
      const reason: NightWait | null = facts.build.running === true ? "build-running" : facts.build.open && facts.build.jobAlive ? "build-not-started" : null;
      // Counted afresh is a change as well: the new start has to be stored for the checks that follow.
      if (reason !== null) return { action: "wait", reason, run: counted, changed: firstNotice || afresh || run.waiting !== reason };
    }
  }
  if (facts.online === false) return { action: "wait", reason: "offline", run, changed: firstNotice || run.waiting !== "offline" };
  return { action: "run", run, lateMs: now.getTime() - slot.at.getTime(), firstNotice };
}

// ---------- for `status` and the dashboard ----------

export interface NightView {
  /** The job's current slot. */
  slotAt: string;
  slotDay: string;
  /**
   * "no-record": the job has never asked the clock. "done": nothing is due. "due": the current
   * slot's run has not started. "running": a run that started has not been closed, and the job's
   * lock is not known to be free.
   */
  state: "no-record" | "done" | "due" | "running";
  /** Why a due slot is not starting, when a reason is stored. */
  waiting: NightWait | null;
  nextSlotAt: string;
  /** When the job last asked the clock. */
  checkedAt: string | null;
  /** The newest run that started: the one going now, or the last one closed. `lateMinutes` is whole minutes after its time, rounded down. */
  lastRun: { day: string; startedAt: string; closedAt: string | null; closedAs: NightRun["closedAs"]; lateMinutes: number } | null;
  /**
   * The day the stored record is dated, when that is after the current slot's day. Otherwise null.
   * The Mac's clock, TZ or the job's time was moved back after the record was written, and the job
   * starts nothing until that day has come. A day or two ahead puts itself right. A date far
   * ahead means the job has stopped, and only starting its clock from now (`--from-now`) frees it.
   */
  recordAhead: string | null;
}

/**
 * One job's night, for people. `record`, `last` and `checkedAt` are the three stored values;
 * `running` is whether the job's lock is held (null: could not tell).
 */
export function describeNight(input: {
  job: ClockedJob;
  now: Date;
  config: NightClockConfig;
  record: NightRun | null;
  last: NightRun | null;
  checkedAt: string | null;
  running: boolean | null;
}): NightView {
  const { job, now, config, record, last, running } = input;
  const slot = currentSlot(job, now, config);

  let state: NightView["state"];
  // A run of an earlier slot can still be going when the next slot comes. It is running all the same.
  if (record !== null && record.startedAt !== null && record.closedAt === null && running !== false) state = "running";
  else if (record === null) state = "no-record";
  else state = slotIsOpen(job, now, config, record) ? "due" : "done";

  const newest = record !== null && record.startedAt !== null ? record : last;
  const lastRun =
    newest === null || newest.startedAt === null
      ? null
      : {
          day: newest.day,
          startedAt: newest.startedAt,
          closedAt: newest.closedAt,
          closedAs: newest.closedAs,
          lateMinutes: Math.max(0, Math.floor((Date.parse(newest.startedAt) - Date.parse(newest.slotAt)) / 60_000)),
        };

  return {
    slotAt: slot.at.toISOString(),
    slotDay: slot.day,
    state,
    waiting: state === "due" && record !== null && record.day === slot.day ? record.waiting : null,
    nextSlotAt: nextSlotAt(job, now, config).toISOString(),
    checkedAt: input.checkedAt,
    lastRun,
    recordAhead: record !== null && record.day > slot.day ? record.day : null,
  };
}
