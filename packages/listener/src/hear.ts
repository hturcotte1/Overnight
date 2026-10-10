// Hear: take one event from Bee's stream and save what it tells us, at once.
import { errorSummary } from "@overnight/core";
import type { BeeEvent, Idea } from "@overnight/core";
import type { ListenerContext } from "./context.ts";
import { isSimilarText, toIsoOrNull } from "./text.ts";

/**
 * Returns the function the stream calls for each event. It never throws: one event that cannot
 * be handled is logged (by type, never by content) and the stream carries on.
 * `onAskDeleted` is called when Bee reports the deletion of a to-do that carries an open ask.
 */
export function createEventHandler(ctx: ListenerContext, onAskDeleted: (idea: Idea) => void): (event: BeeEvent) => void {
  const { store, logger, options } = ctx;

  return function handleEvent(event) {
    let type = "unknown";
    try {
      type = event.type;
      const at = ctx.now().toISOString();
      switch (event.type) {
        case "connected":
          // Nothing to save. The run loop is what acts on this (it starts the backfill).
          logger.debug("Bee stream says it is connected");
          return;
        case "utterance": {
          // Saved at once and never re-fetched: Bee deletes short recordings minutes later (spike 2).
          const conversation = store.resolveConversation({ uuid: event.conversationUuid }, at);
          const spokenAt = toIsoOrNull(event.spokenAt) ?? at;
          // The stream can deliver a line after a backfill has already fetched it. The two ids are
          // from different id spaces, so only the time and the wording can show it is the same line.
          const alreadyBackfilled = store
            .utterancesSpokenNear(spokenAt, options.backfillFuzzyWindowMs)
            .some((stored) => stored.source === "backfill" && isSimilarText(stored.text, event.text, options.backfillSimilarity));
          if (alreadyBackfilled) {
            logger.debug("line received", { conversationKey: conversation.key, beeUtteranceId: event.beeUtteranceId, saved: false, why: "already backfilled" });
            return;
          }
          const saved = store.insertUtterance({ beeUtteranceId: event.beeUtteranceId, conversationKey: conversation.key, text: event.text, spokenAt, receivedAt: at, source: "stream" });
          logger.debug("line received", { conversationKey: conversation.key, beeUtteranceId: event.beeUtteranceId, saved: saved.inserted });
          return;
        }
        case "conversation": {
          // A delete only sets a flag. Our saved lines, and any idea heard in them, stay.
          const conversation = store.resolveConversation(
            { beeId: event.beeId, uuid: event.uuid, state: event.state, startTime: event.startTime, endTime: event.endTime, deleted: event.kind === "delete" },
            at,
          );
          logger.debug("conversation event", { conversationKey: conversation.key, kind: event.kind, state: event.state });
          return;
        }
        case "todo-deleted": {
          // Bee makes to-dos of its own too. Only one that carries an open ask of ours matters.
          const idea = store.findIdeaByTodoId(event.todoId);
          if (idea?.state === "asked") onAskDeleted(idea);
          return;
        }
      }
    } catch (error) {
      logger.error("could not handle a Bee event", { type, error: errorSummary(error) });
    }
  };
}
