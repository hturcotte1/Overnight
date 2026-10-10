// Notice: once a conversation has gone quiet, show its new lines to the detector and record what
// came back. Every outcome leaves a detector run behind, so the dashboard can show what was heard.
// The one exception is a detector that is not ready: then nothing is recorded and the lines wait.
import { errorSummary } from "@overnight/core";
import type { DetectorInput, DetectorResult, StoredUtterance } from "@overnight/core";
import type { Asker } from "./asking.ts";
import { planBatch } from "./batch.ts";
import type { ListenerContext } from "./context.ts";
import { tidyTitle } from "./text.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** While the detector is not ready, say so this often at most. */
const NOT_READY_LOG_EVERY_MS = 10 * MINUTE_MS;

export interface Detection {
  /**
   * One pass over every quiet conversation. `shouldStop` lets a shutdown end it between
   * conversations. `abandoned` turns true once the shutdown has stopped waiting for this pass:
   * from then on the pass changes nothing more, and whatever it was reading stays pending.
   */
  runPass(shouldStop?: () => boolean, abandoned?: () => boolean): Promise<void>;
}

type Tries = { count: number; lastReason: string; notBeforeMs: number };

const ids = (lines: StoredUtterance[]) => lines.map((line) => line.id);
const firstLine = (text: string) => (text.split("\n")[0] ?? "").slice(0, 200);

export function createDetection(ctx: ListenerContext, asker: Asker): Detection {
  const { store, detector, logger, options } = ctx;

  /**
   * Detector tries per batch, keyed by the id of the batch's oldest stored line (see batchKey).
   * In memory only: after a restart a batch simply gets fresh tries. Counting tries before the
   * call (not failures after it) caps what one batch can cost even if saving the result is the
   * part that keeps failing.
   */
  const tries = new Map<number, Tries>();

  // ---------- a detector that is not ready (not set up yet, Kiro signed out) ----------

  /** No detector call is made before this moment. One "not ready" answer speaks for every batch. */
  let notReadyUntilMs = 0;
  let saidNotReadyAtMs: number | null = null;
  /**
   * Lines that were in time but found the detector not ready. The too-old rule leaves them alone
   * from then on: they wait for the detector however long it takes. In memory only, so after a
   * restart the too-old rule applies to them again, as it does to anything left from before.
   */
  const kept = new Set<number>();

  function keepForLater(utteranceIds: number[], nowMs: number): void {
    for (const id of utteranceIds) kept.add(id);
    if (saidNotReadyAtMs !== null && Math.abs(nowMs - saidNotReadyAtMs) < NOT_READY_LOG_EVERY_MS) return;
    saidNotReadyAtMs = nowMs;
    logger.warn("the detector is not ready; lines are being kept", { linesWaiting: kept.size, tryAgainInMs: options.retryDelayMs });
  }

  const covered = (utteranceIds: number[]) => utteranceIds.forEach((id) => kept.delete(id));

  async function callDetector(input: DetectorInput): Promise<DetectorResult> {
    const started = performance.now();
    try {
      return await detector.detect(input);
    } catch (error) {
      // detect() promises never to throw. If it does anyway, it is one more failed run.
      return { ok: false, reason: `the detector threw: ${errorSummary(error)}`, ms: Math.round(performance.now() - started), attempts: 1 };
    }
  }

  /** The conversation's key now. A row known only by Bee's numeric id can be folded into another while we wait on the detector. */
  function keyNow(key: string, beeId: number | null): string {
    if (store.getConversation(key) !== null || beeId === null) return key;
    return store.findConversationByBeeId(beeId)?.key ?? key;
  }

  async function detectConversation(conversationKey: string, abandoned: () => boolean): Promise<void> {
    const pending = store.pendingUtterances(conversationKey);
    if (pending.length === 0) return;
    const startedAt = ctx.now();
    // A line may have arrived while an earlier conversation was with the detector: wait for quiet again.
    const newestReceivedMs = Math.max(...pending.map((line) => Date.parse(line.receivedAt)));
    if (startedAt.getTime() - newestReceivedMs < options.quietMs) return;

    const plan = planBatch(pending, startedAt.getTime(), options, kept);
    if (plan.stale.length > 0) {
      const runId = store.recordDetectorRun({ conversationKey, ranAt: startedAt.toISOString(), utteranceIds: ids(plan.stale), wordCount: plan.staleWords, outcome: "skipped", reason: "too old" });
      logger.info("detector run", { conversationKey, runId, outcome: "skipped", why: "too old", lines: plan.stale.length, words: plan.staleWords });
    }
    if (plan.fresh.length === 0) return;

    // The run covers every fresh line, including any left out of what the detector reads.
    const batch = { conversationKey, utteranceIds: ids(plan.fresh), wordCount: plan.freshWords };
    const sizes = { lines: plan.fresh.length, words: plan.freshWords };
    // The batch is known by its oldest stored line. A line spoken earlier can still join the
    // batch between tries (backfill, or the stream delivering out of order), but it is stored
    // later, so it cannot take this place and hand the batch a fresh set of tries.
    const batchKey = Math.min(...batch.utteranceIds);

    if (plan.freshWords < options.minWords) {
      const runId = store.recordDetectorRun({ ...batch, ranAt: startedAt.toISOString(), outcome: "skipped", reason: "too short" });
      covered(batch.utteranceIds);
      tries.delete(batchKey);
      logger.info("detector run", { conversationKey, runId, outcome: "skipped", why: "too short", ...sizes });
      return;
    }

    const giveUp = (reason: string, count: number, last?: DetectorResult) => {
      const runId = store.recordDetectorRun({ ...batch, ranAt: ctx.now().toISOString(), outcome: "failed", reason: `${reason} (gave up after ${count} tries)`, ms: last?.ms, attempts: last?.attempts });
      covered(batch.utteranceIds);
      tries.delete(batchKey);
      logger.error("detector run", { conversationKey, runId, outcome: "failed", tries: count, ...sizes });
    };

    const used = tries.get(batchKey);
    if (used !== undefined && used.count >= options.detectorMaxAttempts) {
      // Out of tries on an earlier pass, but recording that failed. Record it now; do not call again.
      giveUp(used.lastReason, used.count);
      return;
    }
    if (startedAt.getTime() < notReadyUntilMs) {
      // The detector said "not ready" a moment ago. Asking it again for each batch would get the same answer.
      keepForLater(batch.utteranceIds, startedAt.getTime());
      return;
    }
    // Too soon after the last failure: whatever went wrong deserves a moment to pass.
    if (used !== undefined && startedAt.getTime() < used.notBeforeMs) return;
    const attempt = (used?.count ?? 0) + 1;
    const notBeforeMs = startedAt.getTime() + options.retryDelayMs;
    tries.set(batchKey, { count: attempt, lastReason: "the detector's answer could not be saved", notBeforeMs });
    /** Take back the try counted just above, for a call that turned out not to be one. */
    const uncount = () => {
      if (used === undefined) tries.delete(batchKey);
      else tries.set(batchKey, used);
    };

    const beeId = store.getConversation(conversationKey)?.beeId ?? null;
    const titlesSince = new Date(startedAt.getTime() - options.dedupeWindowDays * DAY_MS).toISOString();
    const result = await callDetector({
      utterances: plan.send.map((line) => ({ text: line.text, spokenAt: line.spokenAt })),
      recentTitles: store.recentIdeaTitles(titlesSince),
    });

    if (abandoned()) {
      // The shutdown stopped waiting for us while the detector was thinking, and whoever runs us
      // may already have closed the store. Drop the answer: the lines stay pending for next time.
      uncount();
      return;
    }

    if (!result.ok && result.retryLater === true) {
      // Not a failed run: the detector could not even try. Nothing is recorded, no try is used up,
      // and the lines stay pending until it can.
      uncount();
      const nowMs = ctx.now().getTime();
      notReadyUntilMs = nowMs + options.retryDelayMs;
      keepForLater(batch.utteranceIds, nowMs);
      return;
    }

    batch.conversationKey = keyNow(conversationKey, beeId);

    if (!result.ok) {
      const reason = firstLine(result.reason);
      tries.set(batchKey, { count: attempt, lastReason: reason, notBeforeMs });
      if (attempt >= options.detectorMaxAttempts) {
        giveUp(reason, attempt, result);
        return;
      }
      // The lines stay pending, so a later pass tries again. The reason is saved with the run
      // but kept out of the log: it comes from the model's side and we cannot vouch for it.
      logger.warn("detector run failed; will try again", { conversationKey: batch.conversationKey, attempt, ms: result.ms, ...sizes });
      return;
    }

    const { verdict } = result;
    const finishedAt = ctx.now().toISOString();
    const outcome = verdict.is_idea ? "idea" : "not_idea";
    const runId = store.recordDetectorRun({ ...batch, ranAt: finishedAt, outcome, verdict, ms: result.ms, attempts: result.attempts });
    covered(batch.utteranceIds);
    tries.delete(batchKey);
    logger.info("detector run", { conversationKey: batch.conversationKey, runId, outcome, ...sizes, sentWords: plan.sendWords, ms: result.ms, attempts: result.attempts });
    if (!verdict.is_idea) return;

    const idea = store.createIdea(
      { title: tidyTitle(verdict.title), pitch: verdict.pitch, quote: verdict.quote, confidence: verdict.confidence, conversationKey: batch.conversationKey, detectorRunId: runId },
      finishedAt,
    );
    // The id only. The title is the model's wording of what someone said, and could hold a name.
    logger.info("idea heard", { ideaId: idea.id, runId, confidence: verdict.confidence });
    await asker.consider(idea, verdict);
  }

  return {
    async runPass(shouldStop = () => false, abandoned = () => false) {
      await asker.retryWaiting(() => shouldStop() || abandoned());
      const passStartedMs = ctx.now().getTime();
      // One conversation at a time: each ask changes what the next idea is allowed to do.
      for (const waiting of store.conversationsAwaitingDetection()) {
        if (shouldStop() || abandoned()) return;
        if (passStartedMs - Date.parse(waiting.lastReceivedAt) < options.quietMs) continue;
        try {
          await detectConversation(waiting.conversationKey, abandoned);
        } catch (error) {
          logger.error("detection failed for one conversation", { conversationKey: waiting.conversationKey, error: errorSummary(error) });
        }
      }
    },
  };
}
