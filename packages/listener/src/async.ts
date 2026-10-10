// Small helpers for the run loop's timing.

/** Wait `ms`, or until `signal` aborts, whichever comes first. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Wrap `work` so that it never runs twice at once: a call made while it is running gets the run
 * already in progress. This is what keeps a pass from overlapping itself.
 */
export function singleFlight(work: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= work().finally(() => {
      running = null;
    });
    return running;
  };
}

/**
 * True once `work` has settled (either way), or false if it is still going after `ms`.
 * `whenLate` runs at that very moment, before anything waiting on the answer does.
 * Never rejects, and leaves no timer behind.
 */
export function settlesWithin(work: Promise<unknown>, ms: number, whenLate: () => void = () => {}): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      whenLate();
      resolve(false);
    }, Math.max(0, ms));
    const settled = () => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settled, settled);
  });
}
