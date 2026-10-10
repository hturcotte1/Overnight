// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import type { StoredUtterance } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { planBatch } from "../src/batch.ts";
import { HOUR, MINUTE, T0 } from "./helpers.ts";

const NOW = Date.parse(T0);
const LIMITS = { staleAfterMs: 6 * HOUR, maxWordsPerRun: 10 };

let nextId = 1;
function line(text: string, agoMs: number): StoredUtterance {
  const at = new Date(NOW - agoMs).toISOString();
  const id = nextId;
  nextId += 1;
  return { id, beeUtteranceId: 100 + id, conversationKey: "c_test", text, spokenAt: at, receivedAt: at, source: "stream", detectorRunId: null };
}

describe("planBatch", () => {
  it("sends everything when the batch is small and recent", () => {
    const pending = [line("one two three", 5 * MINUTE), line("four five", 4 * MINUTE)];
    const plan = planBatch(pending, NOW, LIMITS);
    expect(plan.stale).toEqual([]);
    expect(plan.send).toEqual(pending);
    expect(plan).toMatchObject({ freshWords: 5, sendWords: 5, staleWords: 0 });
  });

  it("measures a stream line from when it arrived, and a backfilled line from when it was spoken", () => {
    const spokenLongAgo = new Date(NOW - 7 * HOUR).toISOString();
    const arrivedJustNow = new Date(NOW - 3 * MINUTE).toISOString();
    // The watch delivered this one seven hours late. It is news to us, so the detector reads it.
    const lateFromTheStream = { ...line("the watch held on to this all morning", 0), spokenAt: spokenLongAgo, receivedAt: arrivedJustNow };
    // The same times on a line a backfill fetched: it really is old.
    const backfilled = { ...line("this was fetched from the stored transcript", 0), spokenAt: spokenLongAgo, receivedAt: arrivedJustNow, source: "backfill" as const };
    // And a stream line that has been sitting with us for seven hours.
    const leftWaiting = line("this one arrived this morning and waited", 7 * HOUR);

    const plan = planBatch([lateFromTheStream, backfilled, leftWaiting], NOW, LIMITS);
    expect(plan.fresh).toEqual([lateFromTheStream]);
    expect(plan.stale).toEqual([backfilled, leftWaiting]);
  });

  it("is exact at the six-hour line", () => {
    const justInside = line("six hours ago to the millisecond", 6 * HOUR);
    const justOutside = line("one millisecond more than six hours", 6 * HOUR + 1);
    const plan = planBatch([justOutside, justInside], NOW, LIMITS);
    expect(plan.fresh).toEqual([justInside]);
    expect(plan.stale).toEqual([justOutside]);
  });

  it("never sets aside a line it was told to keep", () => {
    const kept = line("the detector was not ready for this one", 30 * HOUR);
    const notKept = line("nobody asked to keep this one", 30 * HOUR);
    const plan = planBatch([kept, notKept], NOW, LIMITS, new Set([kept.id]));
    expect(plan.fresh).toEqual([kept]);
    expect(plan.stale).toEqual([notKept]);
  });

  it("sets aside lines spoken too long ago", () => {
    const old = line("this was said this morning", 7 * HOUR);
    const recent = line("and this just now", 3 * MINUTE);
    const plan = planBatch([old, recent], NOW, LIMITS);
    expect(plan.stale).toEqual([old]);
    expect(plan.fresh).toEqual([recent]);
    expect(plan.send).toEqual([recent]);
    expect(plan.staleWords).toBe(5);
  });

  it("keeps the newest lines when there are too many words, and still covers them all", () => {
    const pending = [line("a b c d e f", 9 * MINUTE), line("g h i j k l", 8 * MINUTE), line("m n o p", 7 * MINUTE)];
    const plan = planBatch(pending, NOW, LIMITS);
    // 4 + 6 = 10 words fit; the oldest line would make 16.
    expect(plan.send.map((sent) => sent.text)).toEqual(["g h i j k l", "m n o p"]);
    expect(plan.fresh).toHaveLength(3);
    expect(plan).toMatchObject({ freshWords: 16, sendWords: 10 });
  });

  it("always sends the newest line, even if it alone is over the limit", () => {
    const pending = [line("short one", 9 * MINUTE), line("a b c d e f g h i j k l m", 8 * MINUTE)];
    const plan = planBatch(pending, NOW, LIMITS);
    expect(plan.send).toHaveLength(1);
    expect(plan.sendWords).toBe(13);
  });

  it("counts a line with an unreadable time as recent", () => {
    const odd = { ...line("some words here", 0), receivedAt: "not a time" };
    const oddBackfill = { ...line("some more words here", 0), spokenAt: "not a time", source: "backfill" as const };
    expect(planBatch([odd, oddBackfill], NOW, LIMITS).fresh).toEqual([odd, oddBackfill]);
  });

  it("copes with nothing pending", () => {
    expect(planBatch([], NOW, LIMITS)).toMatchObject({ stale: [], fresh: [], send: [], freshWords: 0 });
  });
});
