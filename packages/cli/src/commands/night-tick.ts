// `overnight build --if-due` and `overnight deliver --if-due`: one check of the night clock.
// And `--from-now`, which starts a job's clock from this moment.
//
// macOS wakes each night job every minute, and at login, with `--if-due`. Whether anything runs
// is decided by Overnight's own clock (night-clock.ts in @overnight/core), from the time, the
// settings TZ, BUILD_TIME and DELIVER_TIME, and one small record per job in the database.
// Nearly every check ends at once: it writes its heartbeat, finds nothing due, and is gone,
// without taking a lock, printing a word or opening a log file.
//
// When the job's slot is due, a check goes on, in this order:
//   - If the check before this one was long ago, the Mac has only just woken (or been switched
//     on). It waits one minute in place first, so a Mac that woke for a moment starts nothing.
//   - It asks whether there is real internet. Without it the slot stays due and the next check
//     asks again.
//   - It takes the job's lock, reads the record again and decides again. Only then does it act.
//   - The start is written down before the work begins, and the end when it is over. A start is
//     never repeated: a run whose process died is closed as cut short by the next check.
//
// Plain `overnight build` and `overnight deliver` (no switch) mean "do it now" and never come
// here: they neither read nor write the clock's records.
import {
  closedRun,
  currentSlot,
  decideNight,
  errorSummary,
  formatLocal,
  LATE_AFTER_MS,
  nextSlotAt,
  NIGHT_CHECK_FRESH_MS,
  noteChecked,
  noticedRun,
  parseHhMm,
  readCheckedAt,
  readNightRun,
  SETTLE_MS,
  slotIsOpen,
  slotTime,
  startedRun,
  waitingRun,
  WOKE_GAP_MS,
  writeNightRun,
  zonedTimeToUtc,
} from "@overnight/core";
import type { ClockedJob, DataPaths, Logger, NightClockConfig, NightDecision, NightFacts, NightRun, NightWait, Store } from "@overnight/core";
import type { Write } from "../output.ts";
import { buildLockFile, deliverLockFile } from "../single-instance.ts";
import type { ReleaseLock } from "../single-instance.ts";

/** How a run tells the clock where it stands. `build` and `deliver` are handed these by `--if-due`. */
export interface NightRunMarks {
  /**
   * Called just before the work begins: writes down that this slot's run has started. Throws if
   * that cannot be written, and then nothing may be started.
   */
  started(): void;
  /** Called when the work is over: "finished" if it ended by itself, "cut-short" if it was stopped. Never throws. */
  ended(how: "finished" | "cut-short"): void;
}

export interface NightTickDeps {
  job: ClockedJob;
  store: Pick<Store, "getValue" | "setValue">;
  config: NightClockConfig;
  paths: Pick<DataPaths, "root">;
  now: () => Date;
  /** The job's log. Asked for only when there is something to log, so a check that finds nothing due opens no file. */
  logger: () => Logger;
  /** Take a one-at-a-time lock: how to release it, or null if another process holds it. */
  takeLock: (file: string) => ReleaseLock | null;
  /** Does some process hold this lock right now? Null if that could not be told. The deliver job asks it of the build lock. */
  lockHeld: (file: string) => boolean | null;
  /** Does the internet answer (online.ts)? */
  isOnline: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** For the one line said when the check itself fails. Under launchd it lands in the job's *.launchd.log. */
  writeError: Write;
  /**
   * The work: `overnight build` or `overnight deliver`, handed the lock this check already holds
   * and the marks to call. Resolves with the exit code.
   */
  run: (hand: { takeLock: (file: string) => ReleaseLock | null; marks: NightRunMarks }) => Promise<number>;
}

/** What a due slot is waiting for, in words for the log and for `overnight status`. */
export const WAITING_FOR: Record<NightWait, string> = {
  "build-running": "the build to finish",
  "build-not-started": "the build, which has not started yet",
  offline: "the internet",
};

/** The lock a job's run holds: the same one plain `overnight build` and `overnight deliver` take. */
export function nightLockFile(job: ClockedJob, paths: Pick<DataPaths, "root">): string {
  return job === "build" ? buildLockFile(paths) : deliverLockFile(paths);
}

/**
 * Is the build job still waking to ask the clock? Yes while a build holds the build lock (a job
 * that is building does not check the time), or when its last check was moments ago.
 */
export function buildJobAlive(checkedAt: string | null, running: boolean | null, now: Date): boolean {
  if (running === true) return true;
  return checkedAt !== null && now.getTime() - Date.parse(checkedAt) <= NIGHT_CHECK_FRESH_MS;
}

/** What the deliver job is told about the build: is its slot still to run, is it running, is its job awake. */
function buildFacts(deps: Pick<NightTickDeps, "store" | "config" | "paths" | "lockHeld">, now: Date): NonNullable<NightFacts["build"]> {
  const running = deps.lockHeld(buildLockFile(deps.paths));
  return {
    open: slotIsOpen("build", now, deps.config, readNightRun(deps.store, "build")),
    running,
    jobAlive: buildJobAlive(readCheckedAt(deps.store, "build"), running, now),
  };
}

/**
 * The clock's answer at `now`, from the record as stored at this moment. `previousCheckAt` is the
 * job's heartbeat from before this check wrote its own; `online` is left out until it was asked.
 */
function decide(deps: NightTickDeps, now: Date, previousCheckAt: string | null, online: boolean | undefined): NightDecision {
  const facts: NightFacts = { job: deps.job, now, config: deps.config, record: readNightRun(deps.store, deps.job), previousCheckAt, ...(online === undefined ? {} : { online }) };
  const alone = decideNight(facts);
  // How the build stands only matters to a delivery that is otherwise ready to go. Asking it
  // means looking at the build lock, which the checks that find nothing due have no need to do.
  if (deps.job !== "deliver" || (alone.action !== "run" && alone.action !== "wait")) return alone;
  return decideNight({ ...facts, build: buildFacts(deps, now) });
}

/** True when the job's check before this one was so long ago that the Mac was asleep or off in between, or there was none. */
function wokeJustNow(previousCheckAt: string | null, now: Date): boolean {
  return previousCheckAt === null || !(now.getTime() - Date.parse(previousCheckAt) <= WOKE_GAP_MS);
}

/**
 * One check. Resolves with the exit code: 0 when nothing was due, when a due run has to wait, or
 * when another process holds the job's lock; the run's own exit code when one was started; 1 when
 * the check itself failed (the database could not be read or written, the lock file not used).
 */
export async function nightTick(deps: NightTickDeps): Promise<number> {
  const { job, store } = deps;
  const lockFile = nightLockFile(job, deps.paths);
  let release: ReleaseLock | null = null;
  try {
    // The heartbeat: this job is awake and asking. Read the one before it first.
    const previous = readCheckedAt(store, job);
    noteChecked(store, job, deps.now());

    const first = decide(deps, deps.now(), previous, undefined);
    if (first.action === "nothing" || (first.action === "wait" && !first.changed)) return 0;

    let online: boolean | undefined;
    if (first.action === "run") {
      if (wokeJustNow(previous, deps.now())) {
        // Just woken: stay put for a minute before starting anything.
        const since = deps.now().getTime();
        await deps.sleep(SETTLE_MS);
        // The minute took far longer than a minute, so the Mac slept through it. Start nothing:
        // the next check starts over.
        if (deps.now().getTime() - since > 2 * SETTLE_MS) return 0;
      }
      online = await deps.isOnline();
    }

    release = deps.takeLock(lockFile);
    // Another process has the job's lock: a run by hand, or a build-now. It is not ours to judge.
    if (release === null) return 0;

    // Under the lock: read the record again and decide again. The first answer was only a hint.
    const now = deps.now();
    const decision = decide(deps, now, previous, online);
    if (decision.action === "adopt") {
      writeNightRun(store, job, closedRun(noticedRun(decision.slot, now), "first-check", now), now);
      deps.logger().info("night clock: first check, so this slot counts as handled; the first run comes at the next one", { job, slotDay: decision.slot.day });
      return 0;
    }
    if (decision.action === "close") {
      writeNightRun(store, job, closedRun(decision.run, "cut-short", now), now);
      deps.logger().warn("night clock: a run that started never ended, so its slot is closed as cut short; nothing is started again for it", { job, slotDay: decision.run.day, startedAt: decision.run.startedAt });
      return 0;
    }
    if (decision.action === "wait") {
      if (decision.changed) {
        writeNightRun(store, job, waitingRun(decision.run, decision.reason), now);
        deps.logger().info(`night clock: waiting for ${WAITING_FOR[decision.reason]}`, { job, slotDay: decision.run.day, reason: decision.reason });
      }
      return 0;
    }
    if (decision.action === "nothing") return 0;
    // Only a check that has asked about the internet may start a run. (Its first answer was to
    // wait or to tidy up, and things changed in the instant since.) The next check asks.
    if (online === undefined) return 0;
    return await runSlot(deps, decision.run, decision.firstNotice, now, lockFile, release);
  } catch (error) {
    deps.writeError(`"overnight ${job} --if-due" could not check the night clock. ${errorSummary(error)}`);
    return 1;
  } finally {
    // The run has let go of it already; letting go twice is safe.
    release?.();
  }
}

/** Start the work for a slot that is due, under the job's lock, with the marks that write its start and its end. */
async function runSlot(deps: NightTickDeps, due: NightRun, firstNotice: boolean, now: Date, lockFile: string, held: ReleaseLock): Promise<number> {
  const { job, store } = deps;
  let run = due;
  // Stored before anything else, so that `status` can say the slot is due while the work loads.
  if (firstNotice || run.waiting !== null) {
    run = waitingRun(run, null);
    writeNightRun(store, job, run, now);
  }

  let started: NightRun | null = null;
  let over = false;
  const marks: NightRunMarks = {
    started() {
      if (started !== null) return;
      const at = deps.now();
      const record = startedRun(run, at);
      // If this throws, nothing was written and nothing may start: the caller stops there.
      writeNightRun(store, job, record, at);
      started = record;
      const lateMs = at.getTime() - Date.parse(run.slotAt);
      const fields = { job, slotDay: run.day, lateMinutes: Math.max(0, Math.floor(lateMs / 60_000)) };
      if (lateMs > LATE_AFTER_MS) deps.logger().warn("night clock: starting", fields);
      else deps.logger().info("night clock: starting", fields);
    },
    ended(how) {
      if (started === null || over) return;
      over = true;
      try {
        const at = deps.now();
        writeNightRun(store, job, closedRun(started, how === "finished" ? "done" : "cut-short", at), at);
      } catch (error) {
        // Left started and not closed, the slot is closed as cut short by the next check. It is not run again either way.
        try {
          deps.logger().error("night clock: could not write down that the run ended; the next check closes its slot as cut short", { job, slotDay: run.day, reason: errorSummary(error) });
        } catch {
          // Nothing more to say it with.
        }
      }
    },
  };

  try {
    // The work takes "its" lock as it always does, and gets the one this check already holds.
    return await deps.run({ takeLock: (file) => (file === lockFile ? held : deps.takeLock(file)), marks });
  } finally {
    // A run that began and never said how it ended did not end well.
    marks.ended("cut-short");
  }
}

/**
 * `--from-now`: start the job's clock from this moment. The current slot is written down as
 * handled, so nothing that was due before now is run, and the first run is at the job's next
 * time. scripts/install-agents.sh asks for this just before it puts a job in place.
 *
 * Refuses, with exit code 1 and nothing changed, while the job's lock is held: a run is going,
 * and its record is not ours to rewrite. A record of today's slot that is already closed is left
 * exactly as it is. Refusals go to `writeError`; the one line about the new start goes to `write`.
 */
export function startClockFromNow(deps: Pick<NightTickDeps, "job" | "store" | "config" | "paths" | "now" | "takeLock">, write: Write, writeError: Write = write): number {
  const { job, store, config } = deps;
  let release: ReleaseLock | null;
  try {
    release = deps.takeLock(nightLockFile(job, deps.paths));
  } catch (error) {
    writeError(`Overnight could not use its ${job} lock. ${errorSummary(error)} Nothing was changed.`);
    return 1;
  }
  if (release === null) {
    writeError(`A ${job} is running right now on this data folder. Try again when it has finished. Nothing was changed.`);
    return 1;
  }
  try {
    const now = deps.now();
    const slot = currentSlot(job, now, config);
    const record = readNightRun(store, job);
    if (record !== null && record.day === slot.day) {
      // Nobody holds the lock, so a run that started and was never closed has died: it was cut short.
      if (record.closedAt === null) writeNightRun(store, job, closedRun(record, record.startedAt === null ? "first-check" : "cut-short", now), now);
    } else {
      // No record, an older day's, or one dated ahead of the clock: from now on, this slot is the handled one.
      writeNightRun(store, job, closedRun(noticedRun(slot, now), "first-check", now), now);
    }
    write(`The ${job} clock starts from now: the next ${job} is ${formatLocal(nextSlotAt(job, now, config), config.timeZone)} (${config.timeZone}).`);
    return 0;
  } catch (error) {
    writeError(`The ${job} clock could not be started from now. ${errorSummary(error)}`);
    return 1;
  } finally {
    release();
  }
}

// ---------- for `status` and `preflight`: what the clock will do, and whether it is getting anywhere ----------

/** The moment the job's time comes on the local day named (YYYY-MM-DD): that day's slot. */
function slotOn(job: ClockedJob, day: string, config: NightClockConfig): Date {
  const { hour, minute } = parseHhMm(slotTime(job, config));
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return zonedTimeToUtc(year, month, date, hour, minute, config.timeZone);
}

/** The day after the one named, as YYYY-MM-DD. */
function dayAfter(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  // Date.UTC normalises day overflow (for example day 32).
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/**
 * When the clock next starts the job by itself: the first of its times after `now` that its
 * record does not already cover. `record` is the job's stored record (`readNightRun`).
 *
 * Usually that is simply the job's next time. It is a later one when the record is dated on that
 * day or after it, which happens when BUILD_TIME or DELIVER_TIME is moved later on a day whose
 * run has already happened, and when TZ or the Mac's clock is moved back: the clock starts
 * nothing before the record's day, and on that day only a run that was noticed and never begun
 * (`decideNight` in @overnight/core). So saying "today at the new time" would promise a run the
 * clock will not start.
 */
export function nextStartAt(job: ClockedJob, now: Date, config: NightClockConfig, record: NightRun | null): Date {
  const next = nextSlotAt(job, now, config);
  if (record === null) return next;
  // `next` is itself a slot's time, so the slot "at or before" it is that one: this is its day.
  if (record.day < currentSlot(job, next, config).day) return next;
  const stillToRun = record.startedAt === null && record.closedAt === null;
  return slotOn(job, stillToRun ? record.day : dayAfter(record.day), config);
}

/**
 * How long a due run may stand tried and not begun before it is said not to start. The job
 * tries once a minute, so by then two or three tries have ended before the work began.
 */
export const NOT_STARTING_AFTER_MS = 180_000;

/**
 * True when the job keeps trying to start the run that is due and the work never begins: every
 * try ends first (the builder will not load, say), with exit code 1 and a line in the job's log.
 * Nothing is stored about such a try, on purpose: it is tried again a minute later. But the
 * record shows it. A check writes the current slot's record open, started by nothing and waiting
 * for nothing, only at the moment it hands over to the work (`runSlot`); the work then writes the
 * start within moments, or the try has failed. So a record that still stands like that minutes
 * later, with nobody holding the job's lock, is a run that does not start.
 * `lockHeld` is whether some process holds the job's lock right now (null: could not tell).
 */
export function runNotStarting(input: { job: ClockedJob; now: Date; config: NightClockConfig; record: NightRun | null; lockHeld: boolean | null }): boolean {
  const { record, now } = input;
  if (record === null || record.startedAt !== null || record.closedAt !== null || record.waiting !== null) return false;
  // A try is going right now (its work is still loading), or another run has the lock.
  if (input.lockHeld === true) return false;
  if (record.day !== currentSlot(input.job, now, input.config).day) return false;
  return now.getTime() - Date.parse(record.noticedAt) > NOT_STARTING_AFTER_MS;
}
