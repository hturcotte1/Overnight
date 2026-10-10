// Decides what the detector reads from one conversation's pending lines. Pure.
import type { StoredUtterance } from "@overnight/core";
import type { ListenerOptions } from "./options.ts";
import { countWords } from "./text.ts";

export interface BatchPlan {
  /** Lines that have waited too long to act on. A "skipped" run covers them; they are never sent. */
  stale: StoredUtterance[];
  /** Every other pending line. One run covers them all. */
  fresh: StoredUtterance[];
  /** The newest fresh lines, up to the word limit. This is all the detector reads. */
  send: StoredUtterance[];
  staleWords: number;
  freshWords: number;
  sendWords: number;
}

const totalWords = (lines: StoredUtterance[]) => lines.reduce((sum, line) => sum + countWords(line.text), 0);
const NONE: ReadonlySet<number> = new Set();

/**
 * Since when a line has been ours to act on. For a line from the stream that is when it reached
 * us: the watch can deliver a line hours after it was spoken, and it is news to us all the same.
 * A backfilled line has no such moment (it is fetched whenever we reconnect), so it counts from
 * when it was spoken.
 */
function waitingSinceMs(line: StoredUtterance): number {
  return Date.parse(line.source === "stream" ? line.receivedAt : line.spokenAt);
}

/**
 * `pending` must be in spoken order, which is how the store returns it. Lines whose id is in
 * `keep` are never stale, however long they have waited.
 */
export function planBatch(
  pending: StoredUtterance[],
  nowMs: number,
  options: Pick<ListenerOptions, "staleAfterMs" | "maxWordsPerRun">,
  keep: ReadonlySet<number> = NONE,
): BatchPlan {
  const staleBefore = nowMs - options.staleAfterMs;
  // A line whose time cannot be read counts as fresh: better to look at it than to drop it.
  const isStale = (line: StoredUtterance) => waitingSinceMs(line) < staleBefore && !keep.has(line.id);
  const stale = pending.filter(isStale);
  const fresh = pending.filter((line) => !isStale(line));

  // Walk back from the newest line until the word limit is reached. The newest line always goes.
  let sendWords = 0;
  let from = fresh.length;
  while (from > 0) {
    const words = countWords(fresh[from - 1]?.text ?? "");
    if (from < fresh.length && sendWords + words > options.maxWordsPerRun) break;
    sendWords += words;
    from -= 1;
  }

  return { stale, fresh, send: fresh.slice(from), staleWords: totalWords(stale), freshWords: totalWords(fresh), sendWords };
}
