// A last-resort time limit for the night's commands.
//
// The builder and the deliver step put their own time limits on everything they start. This one
// is for the day one of those limits fails: a build that never returns would hold the build lock
// for ever, macOS would see the job as still running, and no later night would build anything.
// When the limit passes, the command stops waiting, says so, and ends (the process is then ended
// by main.ts even if something is still holding it open).

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
