// A last-resort time limit for the night's commands.
//
// The builder and the deliver step put their own time limits on everything they start. This one
// is for the day one of those limits fails: a build that never returns would hold the build lock
// for ever, macOS would see the job as still running, and no later night would build anything.
// When the limit passes, the command stops waiting, says so, and ends (the process is then ended
// by main.ts even if something is still holding it open).
import type { STOP_OVERDUE, StopWatch } from "./stop-signals.ts";

export class DeadlinePassed extends Error {
  readonly minutes: number;
  constructor(what: string, ms: number) {
    const minutes = Math.round(ms / 60_000);
    super(`${what} was still going after ${minutes} minutes, which is past its time limit.`);
    this.name = "DeadlinePassed";
    this.minutes = minutes;
  }
}

/** The longest wait a JavaScript timer can hold (about 24 days). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * `work`'s result, or a DeadlinePassed error if it has not settled within `ms`.
 * `what` names the work in the error, in plain words ("The build").
 */
export async function withDeadline<T>(work: Promise<T> | T, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlinePassed(what, ms)), Math.min(Math.max(1, ms), MAX_TIMER_MS));
  });
  const running = Promise.resolve(work);
  // If the limit wins, nobody is waiting for the work any more. Whatever it does afterwards
  // (the database is about to be closed under it) must not stop Node over an unhandled rejection.
  running.catch(() => {});
  try {
    return await Promise.race([running, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export const MINUTE_MS = 60_000;

/** What `settleUnderLimit` is handed. */
export interface LimitedWork<T> {
  /** The work, as the builder or the deliver step handed it back. It was given `stop`'s signal. */
  work: Promise<T> | T;
  /** The command's stop watch (stop-signals.ts). */
  stop: Pick<StopWatch, "settle">;
  /** The last-resort limit, in milliseconds. */
  limitMs: number;
  /** Names the work in the error, in plain words ("The build"). */
  what: string;
  /** Asked at the moment the limit passes: has the work already been told to stop (a stop signal, or the Mac's sleep was noticed)? */
  toldToStop: () => boolean;
}

/**
 * How a night's command waits for its work: for the work itself, under its last-resort limit, and
 * under the stop watch's own wait once the work has been told to stop. Resolves with the work's
 * result, or with STOP_OVERDUE if it was told to stop and did not come back in time. Throws the
 * work's own error, or DeadlinePassed.
 *
 * The limit ends the wait only for work nobody has told to stop. Work that was told to stop is
 * already on a shorter wait (STOP_WAIT_MS), and that one stands. It matters when the Mac wakes
 * from a sleep that outlasted the limit: the sleep watch and the limit come due in the same
 * instant. The watch stops the work, and the work needs a few seconds to end what it started and
 * write down where it got to. Were the limit to end the wait in that instant, the command would
 * close the database under it: the build would stay "building", its credits uncounted, and the
 * command would end "could not finish" over a night that only slept.
 */
export async function settleUnderLimit<T>(limited: LimitedWork<T>): Promise<T | typeof STOP_OVERDUE> {
  const running = Promise.resolve(limited.work);
  try {
    return await limited.stop.settle(withDeadline(running, limited.limitMs, limited.what));
  } catch (error) {
    if (!(error instanceof DeadlinePassed) || !limited.toldToStop()) throw error;
    return limited.stop.settle(running);
  }
}
