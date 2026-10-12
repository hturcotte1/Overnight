// Every wait and every limit the listener uses, in one place. The CLI runs with the defaults;
// tests shrink them so nothing has to sleep for real.

export interface ListenerOptions {
  /** Run the detector once a conversation has had no new line for this long. */
  quietMs: number;
  /** A batch with fewer words than this is recorded as "too short" and never sent. */
  minWords: number;
  /** Send at most this many words (the most recent lines). The run still covers every pending line. */
  maxWordsPerRun: number;
  /**
   * Pending lines older than this are recorded as "too old" and never sent. A line from the
   * stream is as old as the time since it reached us (the watch can deliver hours late); a
   * backfilled line is as old as the time since it was spoken.
   */
  staleAfterMs: number;
  /** After this many failed detector runs on the same batch, record a "failed" run and move on. */
  detectorMaxAttempts: number;
  /**
   * After a failed detector run, to-do or backfill, wait at least this long before trying that
   * one again. Without it three tries would be over in three passes (half a minute), and a short
   * network drop would cost the idea. Also the wait after the detector says it is not ready.
   */
  retryDelayMs: number;
  /** The ask's alarm goes off this long after the to-do is created. */
  askLeadMs: number;
  /** An ask made with less than this left before the cutoff runs until the next day's cutoff. */
  minAskWindowMs: number;
  /** How many times in total to try creating the ask's Bee to-do. */
  askMaxAttempts: number;
  /** An idea that has waited this long to be asked (quiet hours, Bee logged out) is not asked any more. */
  askMaxAgeMs: number;
  /** How far back to look for an idea with a similar title. */
  dedupeWindowDays: number;
  /** How often the detection and approval passes run. */
  pollMs: number;
  /** Two lines are the same line if they were spoken within this long of each other and read alike. */
  backfillFuzzyWindowMs: number;
  /** How alike two lines must read (shared words over all words, 0 to 1) to count as the same line. */
  backfillSimilarity: number;
  /** How far back to fetch a conversation we have no lines for. */
  backfillDefaultLookbackMs: number;
  /** Fetch from this long before the newest stored line, so a line that arrived out of order is not missed. */
  backfillOverlapMs: number;
  /** A backfill that fails is tried again (retryDelayMs apart) up to this many times per connect. */
  backfillMaxAttempts: number;
  /** Waits between stream restarts. The last one repeats. */
  reconnectDelaysMs: number[];
  /** A stream that lived longer than this was healthy, so the next restart uses the first delay again. */
  streamHealthyMs: number;
  /** Backfill this long after opening a stream if Bee's connect message has not arrived by then. */
  connectGraceMs: number;
  /**
   * A stream on which nothing at all has arrived for this long is closed and a new one opened.
   * Bee's CLI swallows keep-alives, so a dead connection and a quiet room look the same. 0 (or
   * anything longer than about 24 days, the longest a timer can run) means never.
   */
  streamIdleReopenMs: number;
  /** While Bee is logged out, check again this often. */
  loginRecheckMs: number;
  /** How often the wall clock is checked for a jump, which is how a sleeping Mac shows up. */
  wakeCheckMs: number;
  /** A wall-clock check that comes this late means the Mac was asleep, so the stream is reopened to catch up. */
  wakeGapMs: number;
  /** stop() waits this long for work in progress, then returns anyway. launchd kills a job 30 seconds after asking it to stop. */
  stopGraceMs: number;
  /** Hold the Mac awake while the listener runs, on battery too. Nothing holds it awake on battery once its lid is closed. */
  keepAwake: boolean;
  /** Stop cleanly on SIGTERM and SIGINT. The CLI turns this on; tests leave it off. */
  handleSignals: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const DEFAULT_OPTIONS: ListenerOptions = {
  quietMs: 2 * MINUTE,
  minWords: 6,
  maxWordsPerRun: 1500,
  staleAfterMs: 6 * HOUR,
  detectorMaxAttempts: 3,
  retryDelayMs: MINUTE,
  askLeadMs: 2 * MINUTE,
  minAskWindowMs: HOUR,
  askMaxAttempts: 3,
  askMaxAgeMs: 12 * HOUR,
  dedupeWindowDays: 14,
  pollMs: 10 * SECOND,
  backfillFuzzyWindowMs: 3 * SECOND,
  backfillSimilarity: 0.8,
  backfillDefaultLookbackMs: 6 * HOUR,
  backfillOverlapMs: MINUTE,
  backfillMaxAttempts: 3,
  reconnectDelaysMs: [1 * SECOND, 2 * SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  streamHealthyMs: MINUTE,
  connectGraceMs: 5 * SECOND,
  streamIdleReopenMs: 15 * MINUTE,
  loginRecheckMs: MINUTE,
  wakeCheckMs: 5 * SECOND,
  wakeGapMs: 30 * SECOND,
  stopGraceMs: 10 * SECOND,
  keepAwake: false,
  handleSignals: false,
};

/** The defaults with `overrides` on top. A key set to undefined keeps its default. */
export function resolveOptions(overrides: Partial<ListenerOptions> = {}): ListenerOptions {
  const given = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_OPTIONS, ...given };
}
