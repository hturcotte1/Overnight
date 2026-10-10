// Ask: decide whether a heard idea goes to the wrist, and if so create the Bee to-do that asks.
// An idea we decide not to ask about stays "heard", with a plain-words note saying why.
import { errorSummary, localDayBounds, nextLocalTime } from "@overnight/core";
import type { Config, DetectorVerdict, Idea } from "@overnight/core";
import { gateVerdict, isNearDuplicate } from "@overnight/detector";
import { beeErrorKind } from "./context.ts";
import type { ListenerContext } from "./context.ts";
import { quietHoursEnd } from "./quiet-hours.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ASK_PREFIX = "💡 Build tonight? ";

/**
 * How the note of an idea heard in quiet hours starts. It is also how the first pass after quiet
 * hours finds the ideas still waiting to be asked, so that a restart in the night loses none.
 */
export const QUIET_HOURS_NOTE = "heard during quiet hours";

/**
 * The note left on an idea just before Bee is asked to create its to-do. Every outcome replaces
 * it, so an idea still carrying it when a new process starts was cut off mid-ask: its to-do may exist.
 */
export const ASKING_NOTE = "asking in Bee now";

const INTERRUPTED_NOTE = "asked in Bee, but the listener stopped before the reply came, so the answer cannot be tracked";

/** Quiet hours for an ask: true if either the moment of asking or the moment its alarm rings is inside them. */
function askFallsInQuietHours(now: Date, askLeadMs: number, config: Pick<Config, "askCutoff" | "deliverTime" | "timeZone">): boolean {
  return quietHoursEnd(now, config) !== null || quietHoursEnd(new Date(now.getTime() + askLeadMs), config) !== null;
}

export function askText(title: string): string {
  return ASK_PREFIX + title;
}

/**
 * When an unanswered ask expires: the next local cutoff. An ask made with less than `minWindowMs`
 * to go would expire before anyone could reasonably answer, so it runs to the cutoff after that.
 */
export function askExpiresAt(askedAt: Date, config: Pick<Config, "askCutoff" | "timeZone">, minWindowMs: number): Date {
  const first = nextLocalTime(askedAt, config.askCutoff, config.timeZone);
  return first.getTime() - askedAt.getTime() < minWindowMs ? nextLocalTime(first, config.askCutoff, config.timeZone) : first;
}

/** Why an idea is not asked about. `kind` is for logs; `note` is shown on the dashboard. */
export interface AskBlock {
  kind: "gate" | "no-title" | "duplicate" | "paused" | "daily-limit" | "quiet-hours";
  note: string;
}

/** An ask whose to-do exists in Bee (or may), but which the store does not hold yet. */
export interface UnsavedAsk {
  todoId: number | null;
  askedAt: string;
  askExpiresAt: string;
  note: string | null;
}

function dailyLimitNote(asksToday: number): string {
  if (asksToday === 0) return "asking is switched off (the daily limit is 0)";
  return `already asked ${asksToday} ${asksToday === 1 ? "time" : "times"} today`;
}

/**
 * The first reason not to ask, or null to go ahead. The order matters: the note should name the
 * most lasting reason, and quiet hours come last because they are the one reason that passes by
 * itself. Pass `verdict: null` on a later try, when the verdict already passed its gate.
 * `unsaved` holds asks that were made but could not be saved yet; they count as asked.
 */
export function findAskBlock(
  ctx: Pick<ListenerContext, "store" | "config" | "options">,
  idea: Idea,
  verdict: DetectorVerdict | null,
  now: Date,
  unsaved: ReadonlyMap<string, UnsavedAsk> = new Map(),
): AskBlock | null {
  const { store, config, options } = ctx;

  if (verdict !== null) {
    const gate = gateVerdict(verdict);
    if (!gate.pass) return { kind: "gate", note: gate.reason };
  }
  if (idea.title === "") return { kind: "no-title", note: "the detector gave no title" };

  // Only ideas that got as far as an ask count. Hearing the same thing twice is no reason to
  // stay silent; having already asked about it is.
  const since = new Date(now.getTime() - options.dedupeWindowDays * DAY_MS).toISOString();
  const askedTitles = store
    .listIdeas({ createdSince: since })
    .filter((other) => other.id !== idea.id && (other.state !== "heard" || unsaved.has(other.id)))
    .map((other) => other.title);
  if (isNearDuplicate(idea.title, askedTitles)) return { kind: "duplicate", note: "already asked about something like this recently" };

  if (store.isPaused(config.pausedByDefault)) return { kind: "paused", note: "paused: listening only" };

  const day = localDayBounds(now, config.timeZone);
  const [dayStart, dayEnd] = [day.start.toISOString(), day.end.toISOString()];
  const notSavedYet = [...unsaved.values()].filter((ask) => ask.askedAt >= dayStart && ask.askedAt < dayEnd).length;
  const asksToday = store.countAsksBetween(dayStart, dayEnd) + notSavedYet;
  if (asksToday >= config.maxAsksPerDay) return { kind: "daily-limit", note: dailyLimitNote(asksToday) };

  if (askFallsInQuietHours(now, options.askLeadMs, config)) return { kind: "quiet-hours", note: `${QUIET_HOURS_NOTE}; will ask after ${config.deliverTime}` };

  return null;
}

export interface Asker {
  /** Ask about a newly heard idea, or leave it "heard" with a note. Never throws. */
  consider(idea: Idea, verdict: DetectorVerdict): Promise<void>;
  /**
   * Pick up what earlier passes left waiting: asks that could not be saved, to-dos Bee refused to
   * create, and ideas heard in quiet hours once those are over. Never throws. Once `shouldStop`
   * says so, no further to-do is started: a shutdown must not leave one half-recorded.
   */
  retryWaiting(shouldStop?: () => boolean): Promise<void>;
}

export function createAsker(ctx: ListenerContext): Asker {
  const { store, bee, config, logger, options } = ctx;
  /** Ideas whose to-do Bee refused to create: tries used so far, and when the next one may happen. In memory only. */
  const triesUsed = new Map<string, { count: number; notBeforeMs: number }>();
  /** Asks made in Bee that the store could not take. Only the save is tried again, never the to-do. In memory only. */
  const unsaved = new Map<string, UnsavedAsk>();
  /** Ideas whose to-do this process is creating right now. In memory only. */
  const inFlight = new Set<string>();
  /** Whether this process has dealt with the asks an earlier one was cut off in the middle of. */
  let settledInterrupted = false;

  const setNote = (ideaId: string, note: string) => store.setIdeaNote(ideaId, note, ctx.now().toISOString());

  /** For a note that only explains: failing to write it must not undo what was just decided. */
  function explain(ideaId: string, note: string): void {
    try {
      setNote(ideaId, note);
    } catch (error) {
      logger.warn("could not save an idea's note", { ideaId, error: errorSummary(error) });
    }
  }

  /**
   * Record that the idea was asked about. From the moment this is called the to-do exists (or
   * may), so whatever happens here, no second one is ever made for this idea.
   */
  function saveAsk(ideaId: string, todoId: number | null, note: string | null): void {
    const askedAt = ctx.now();
    const ask: UnsavedAsk = { todoId, askedAt: askedAt.toISOString(), askExpiresAt: askExpiresAt(askedAt, config, options.minAskWindowMs).toISOString(), note };
    try {
      store.transitionIdea(ideaId, "asked", ask, ask.askedAt);
    } catch (error) {
      // Keep it in memory: it still counts toward today's limit, and later passes try the save again.
      unsaved.set(ideaId, ask);
      logger.error("created the ask to-do but could not save it; will try to save it again", { ideaId, todoId, error: errorSummary(error) });
      explain(ideaId, "asked in Bee, but the ask could not be saved yet, so its answer is not tracked");
      return;
    }
    if (todoId !== null) logger.info("asked on the wrist", { ideaId, todoId, expiresAt: ask.askExpiresAt });
  }

  function saveUnsaved(): void {
    for (const [ideaId, ask] of [...unsaved]) {
      try {
        const idea = store.getIdea(ideaId);
        if (idea === null || idea.state !== "heard") {
          unsaved.delete(ideaId);
          continue;
        }
        // Dated when the to-do was made, so it counts toward the right day's limit.
        store.transitionIdea(ideaId, "asked", ask, ask.askedAt);
        unsaved.delete(ideaId);
        logger.info("saved an ask that could not be saved before", { ideaId, todoId: ask.todoId });
      } catch (error) {
        // The store is still in trouble (and each failed write can block for seconds): leave the rest.
        logger.debug("still could not save an ask", { ideaId, error: errorSummary(error) });
        return;
      }
    }
  }

  async function attempt(idea: Idea, verdict: DetectorVerdict | null): Promise<void> {
    // Its to-do already exists and only the save is outstanding. Whatever its note still says.
    if (unsaved.has(idea.id)) return;
    const startedAt = ctx.now();
    const block = findAskBlock(ctx, idea, verdict, startedAt, unsaved);
    if (block !== null) {
      triesUsed.delete(idea.id);
      setNote(idea.id, block.note);
      logger.info("idea heard but not asked", { ideaId: idea.id, why: block.kind });
      return;
    }

    const tries = (triesUsed.get(idea.id)?.count ?? 0) + 1;
    // A durable mark first: if we are stopped before Bee replies, the next start must know a
    // to-do may exist. Without the mark nothing is asked; the try is not counted and comes round again.
    try {
      setNote(idea.id, ASKING_NOTE);
    } catch (error) {
      triesUsed.set(idea.id, { count: tries - 1, notBeforeMs: ctx.now().getTime() + options.retryDelayMs });
      logger.warn("could not mark the idea as being asked, so did not ask; will try again", { ideaId: idea.id, error: errorSummary(error) });
      return;
    }
    let todoId: number;
    inFlight.add(idea.id);
    try {
      todoId = (await bee.createTodo(askText(idea.title), new Date(startedAt.getTime() + options.askLeadMs))).id;
    } catch (error) {
      inFlight.delete(idea.id);
      const kind = beeErrorKind(error);
      if (kind === "logged-out") {
        // Bee refused, so nothing was created, and it is no fault of the idea: the try is not counted.
        triesUsed.set(idea.id, { count: tries - 1, notBeforeMs: ctx.now().getTime() + options.loginRecheckMs });
        logger.warn("could not create the ask to-do: Bee is logged out", { ideaId: idea.id });
        ctx.onLoggedOut();
        explain(idea.id, "Bee is logged out; will ask once it is logged in again");
        return;
      }
      if (kind === "failed") {
        // Bee refused and nothing was created, so it is safe to try again.
        const willRetry = tries < options.askMaxAttempts;
        if (willRetry) triesUsed.set(idea.id, { count: tries, notBeforeMs: ctx.now().getTime() + options.retryDelayMs });
        else triesUsed.delete(idea.id);
        logger.warn("could not create the ask to-do", { ideaId: idea.id, kind, attempt: tries, willRetry });
        explain(idea.id, `could not create the Bee to-do: ${kind}`);
        return;
      }
      // Any other failure (no reply in time, a reply we could not read, something unexpected)
      // leaves open whether Bee made the to-do. Trying again could put a second alarm on the
      // wrist, so this counts as the ask: it uses up one of today's and runs out at the cutoff.
      triesUsed.delete(idea.id);
      logger.warn("the ask to-do may exist, but Bee's reply was lost; not asking again", { ideaId: idea.id, kind });
      saveAsk(idea.id, null, `asked in Bee, but its reply was lost (${kind}), so the answer cannot be tracked`);
      return;
    }

    inFlight.delete(idea.id);
    triesUsed.delete(idea.id);
    saveAsk(idea.id, todoId, null);
  }

  /**
   * Once per process: an idea still marked as being asked was cut off by a stop while Bee was
   * creating its to-do. The to-do may exist, so it counts as the ask and is never asked again.
   */
  function settleInterrupted(): void {
    if (settledInterrupted) return;
    const cutOff = store.listIdeas({ states: ["heard"] }).filter((idea) => idea.note === ASKING_NOTE && !inFlight.has(idea.id) && !unsaved.has(idea.id));
    settledInterrupted = true;
    for (const idea of cutOff) {
      logger.warn("an ask was cut off by a stop before Bee replied; not asking again", { ideaId: idea.id });
      saveAsk(idea.id, null, INTERRUPTED_NOTE);
    }
  }

  /** A later try for an idea that is still only heard. The verdict passed its gate the first time; everything else is decided afresh. */
  async function tryAgain(idea: Idea): Promise<void> {
    if (ctx.now().getTime() - Date.parse(idea.createdAt) >= options.askMaxAgeMs) {
      triesUsed.delete(idea.id);
      setNote(idea.id, `waited more than ${Math.round(options.askMaxAgeMs / HOUR_MS)} hours to be asked, so it was not asked`);
      logger.info("idea heard but not asked", { ideaId: idea.id, why: "waited-too-long" });
      return;
    }
    await attempt(idea, null);
  }

  /** A failure in here is logged and dropped: one idea must not stop the pass it is part of. */
  async function safely(ideaId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      triesUsed.delete(ideaId);
      logger.error("could not decide whether to ask", { ideaId, error: errorSummary(error) });
    }
  }

  async function retryRefused(shouldStop: () => boolean): Promise<void> {
    for (const [ideaId, used] of [...triesUsed]) {
      if (shouldStop()) return;
      if (ctx.now().getTime() < used.notBeforeMs) continue;
      await safely(ideaId, async () => {
        const idea = store.getIdea(ideaId);
        if (idea === null || idea.state !== "heard") {
          triesUsed.delete(ideaId);
          return;
        }
        await tryAgain(idea);
      });
    }
  }

  /** Ideas heard in quiet hours are found by their note, which every later decision replaces. */
  async function askAfterQuietHours(shouldStop: () => boolean): Promise<void> {
    if (askFallsInQuietHours(ctx.now(), options.askLeadMs, config)) return;
    // An idea that has been tried since is in other hands now, even if its note could not be changed.
    const waiting = store
      .listIdeas({ states: ["heard"] })
      .filter((idea) => idea.note?.startsWith(QUIET_HOURS_NOTE) === true && !triesUsed.has(idea.id) && !unsaved.has(idea.id));
    for (const idea of waiting) {
      if (shouldStop()) return;
      await safely(idea.id, () => tryAgain(idea));
    }
  }

  return {
    consider: (idea, verdict) => safely(idea.id, () => attempt(idea, verdict)),
    async retryWaiting(shouldStop = () => false) {
      try {
        // Saving needs nothing from Bee, so it goes ahead even during a shutdown.
        saveUnsaved();
        settleInterrupted();
        await retryRefused(shouldStop);
        await askAfterQuietHours(shouldStop);
      } catch (error) {
        logger.error("could not go through the asks left waiting", { error: errorSummary(error) });
      }
    },
  };
}
