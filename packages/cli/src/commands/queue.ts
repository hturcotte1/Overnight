// `overnight queue --approved --json`: what the nightly builder reads (SPEC §6).
// The output is a contract with that job: a JSON array and nothing else on standard output.
//
// Two promises are kept here, by code, so they do not depend on the nightly job's prompt:
//   - While Overnight is paused, the queue is empty (SPEC §3: "nothing is asked or built").
//   - At most MAX_BUILDS_PER_NIGHT ideas are handed over, the longest-approved first. The rest
//     stay approved and come up on a later night.
import type { Config, Idea, Store } from "@overnight/core";
import { toJson } from "../output.ts";
import type { Write } from "../output.ts";

type QueueStore = Pick<Store, "listIdeas" | "ideaEvents" | "isPaused">;

export interface QueueDeps {
  store: QueueStore;
  config: Pick<Config, "pausedByDefault" | "maxBuildsPerNight">;
  write: Write;
  /** For the one note meant for a person ("paused"). Never standard output: that stays pure JSON. */
  writeError?: Write;
}

export interface QueuedIdea {
  id: string;
  title: string;
  pitch: string;
  /** The short verbatim quote. The only transcript text a brief may contain. */
  quote: string;
  approvedAt: string;
}

export const PAUSED_QUEUE_NOTE = "Overnight is paused: nothing is queued for building.";

/** When the approval was recorded. Falls back to the timeline, which always has the entry. */
function approvedAt(idea: Idea, store: Pick<Store, "ideaEvents">): string {
  if (idea.answeredAt !== null) return idea.answeredAt;
  const approval = store.ideaEvents(idea.id).findLast((event) => event.toState === "approved");
  return approval?.at ?? idea.updatedAt;
}

/**
 * Every approved idea that is still waiting, the one approved longest ago at the front. Two
 * approved at the same moment stay in the order they were heard (the store's own order).
 */
export function approvedQueue(store: Pick<Store, "listIdeas" | "ideaEvents">): QueuedIdea[] {
  const waiting = store.listIdeas({ states: ["approved"] }).map((idea) => ({
    id: idea.id,
    title: idea.title,
    pitch: idea.pitch,
    quote: idea.quote,
    approvedAt: approvedAt(idea, store),
  }));
  // Every stored time is a UTC ISO string of the same shape, so text order is time order.
  return waiting.sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : a.approvedAt > b.approvedAt ? 1 : 0));
}

/** What tonight's build may take: nothing while paused, otherwise the front of the queue up to the nightly limit. */
export function tonightsQueue(store: QueueStore, config: QueueDeps["config"]): { paused: boolean; ideas: QueuedIdea[] } {
  if (store.isPaused(config.pausedByDefault)) return { paused: true, ideas: [] };
  return { paused: false, ideas: approvedQueue(store).slice(0, config.maxBuildsPerNight) };
}

export function queue(deps: QueueDeps): number {
  const { paused, ideas } = tonightsQueue(deps.store, deps.config);
  if (paused) deps.writeError?.(PAUSED_QUEUE_NOTE);
  deps.write(toJson(ideas));
  return 0;
}
