// Backfill: Bee's stream is at-most-once, so anything said while we were disconnected never
// arrives. After each reconnect, ask Bee which conversations changed and fetch the lines we lack.
import { beeErrorKind } from "./context.ts";
import type { ListenerContext } from "./context.ts";
import { isSimilarText, toIsoOrNull } from "./text.ts";

/** Where the store keeps Bee's "changed since" cursor. */
export const CURSOR_KEY = "bee_cursor";

/**
 * One backfill. Never throws. Returns true if there is nothing more to fetch for now, and false
 * if it failed part-way: then the old cursor is kept, so the next one starts from the same place.
 *
 * `gapSince` is when lines may first have gone missing (the stream ended, or we were not running).
 * Lines that arrived after that moment say nothing about what was missed before them, so they are
 * ignored when working out how far back to fetch. Null means no gap is known.
 *
 * `shouldStop` lets a shutdown end it after the Bee call in progress, with nothing more written;
 * that counts as not caught up, so the next start fetches the same again.
 */
export async function runBackfillOnce(ctx: ListenerContext, gapSince: Date | null = null, shouldStop: () => boolean = () => false): Promise<boolean> {
  const { store, bee, logger, options } = ctx;

  /** The moment to fetch a conversation's lines from: just before the newest line we can rely on. */
  function fetchFromMs(conversationKey: string): number {
    const fallback = ctx.now().getTime() - options.backfillDefaultLookbackMs;
    const last = store.lastSpokenAt(conversationKey);
    if (last === null) return fallback;
    if (gapSince === null) return Date.parse(last) - options.backfillOverlapMs;
    const beforeGap = store
      .utterancesNear(conversationKey, last, options.backfillDefaultLookbackMs)
      .filter((line) => Date.parse(line.receivedAt) < gapSince.getTime())
      .map((line) => Date.parse(line.spokenAt));
    return beforeGap.length === 0 ? fallback : Math.max(...beforeGap) - options.backfillOverlapMs;
  }

  try {
    const cursor = store.getValue(CURSOR_KEY);
    if (cursor === null) {
      // With no cursor Bee answers with about a day of history. Take only the starting point from it.
      const first = await bee.changedSince(null);
      if (shouldStop()) return false;
      if (first.nextCursor !== null) store.setValue(CURSOR_KEY, first.nextCursor, ctx.now().toISOString());
      logger.info("backfill: first run, saved a starting point only", { gotCursor: first.nextCursor !== null });
      // Whatever was said before this first run is left alone on purpose, so there is no gap to keep open.
      return true;
    }

    const changed = await bee.changedSince(cursor);
    if (shouldStop()) return false;
    const counts = { conversations: changed.conversationIds.length, added: 0, repeats: 0, unreadable: 0, gone: 0 };

    for (const beeId of changed.conversationIds) {
      const known = store.findConversationByBeeId(beeId) ?? store.resolveConversation({ beeId }, ctx.now().toISOString());
      const lines = await bee.transcriptSince(beeId, fetchFromMs(known.key));
      if (shouldStop()) return false;
      if (lines === null) {
        // Bee deletes short recordings. What the stream gave us is all there is, and we keep it.
        counts.gone += 1;
        continue;
      }

      // Look the row up again: a stream event may have merged it into another while we waited.
      const conversation = store.findConversationByBeeId(beeId) ?? known;
      const receivedAt = ctx.now().toISOString();
      for (const line of lines) {
        const spokenAt = toIsoOrNull(line.spokenAt);
        if (spokenAt === null) {
          counts.unreadable += 1;
          continue;
        }
        // Stored-transcript ids are a different id space from stream ids, so a line we already
        // have can only be recognised by when it was said and how it reads. Every conversation
        // is searched, not just this one: until Bee has told us both of a conversation's ids,
        // its stream lines sit under another row than the one backfill fills.
        const nearby = store.utterancesSpokenNear(spokenAt, options.backfillFuzzyWindowMs);
        if (nearby.some((stored) => isSimilarText(stored.text, line.text, options.backfillSimilarity))) {
          counts.repeats += 1;
          continue;
        }
        const saved = store.insertUtterance({ beeUtteranceId: line.beeUtteranceId, conversationKey: conversation.key, text: line.text, spokenAt, receivedAt, source: "backfill" });
        if (saved.inserted) counts.added += 1;
        else counts.repeats += 1;
      }
    }

    logger.info("backfill done", counts);
    // Only now is it safe to move on: every changed conversation has been looked at.
    if (changed.nextCursor !== null) store.setValue(CURSOR_KEY, changed.nextCursor, ctx.now().toISOString());
    else logger.warn("backfill: Bee gave no new cursor; keeping the old one");
    return true;
  } catch (error) {
    const kind = beeErrorKind(error);
    // Logged by kind alone. For anything that is not a BeeError only the error's type is added,
    // never its message: these replies hold whole transcripts, and a parse error can quote its input.
    logger.warn("backfill failed; keeping the old cursor", kind === "unexpected" ? { kind, errorName: error instanceof Error ? error.name : "unknown" } : { kind });
    return false;
  }
}
