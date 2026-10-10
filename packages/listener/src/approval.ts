// Approve: find out what happened to each ask by reading its Bee to-do. Ticking a to-do in the
// Bee app sends no stream event (spike 3), so this polls. Ticked = approved, deleted = rejected,
// still open at the cutoff = expired, and anything unclear = ask again later.
import { errorSummary } from "@overnight/core";
import type { Idea, TodoStatus } from "@overnight/core";
import { beeErrorKind } from "./context.ts";
import type { ListenerContext } from "./context.ts";

/** "unknown" and "logged-out" mean Bee could not tell us; the idea is left exactly as it was. */
export type AnswerCheck = "approved" | "rejected" | "expired" | "waiting" | "settled" | "unknown" | "logged-out";

export interface Approvals {
  /**
   * Check one ask now. Used by the pass, and by the stream when Bee reports a deleted to-do.
   * `abandoned` turns true once a shutdown has stopped waiting for this work: an answer that
   * comes back from Bee after that is dropped ("unknown"), and read again after the next start.
   */
  check(idea: Idea, abandoned?: () => boolean): Promise<AnswerCheck>;
  /** Check every open ask once. `shouldStop` ends the pass between two asks. */
  runPass(shouldStop?: () => boolean, abandoned?: () => boolean): Promise<void>;
}

export function createApprovals(ctx: ListenerContext): Approvals {
  const { store, bee, logger } = ctx;

  async function check(idea: Idea, abandoned: () => boolean = () => false): Promise<AnswerCheck> {
    // An ask with no to-do cannot be answered; all it can do is run out.
    let status: TodoStatus = "open";
    if (idea.todoId !== null) {
      try {
        status = await bee.todoStatus(idea.todoId);
      } catch (error) {
        // A failed check says nothing about the answer. Never read it as a "no".
        const kind = beeErrorKind(error);
        if (kind !== "logged-out") logger.warn("could not check an ask; will try again", { ideaId: idea.id, todoId: idea.todoId, kind });
        return kind === "logged-out" ? "logged-out" : "unknown";
      }
      // Whoever runs us may have closed the store while Bee was answering. The to-do keeps its answer.
      if (abandoned()) return "unknown";
    }

    // Another check may have settled this ask while we waited on Bee.
    const current = store.getIdea(idea.id);
    if (current === null || current.state !== "asked") return "settled";

    const now = ctx.now();
    const at = now.toISOString();
    if (status === "completed") {
      store.transitionIdea(idea.id, "approved", { answeredAt: at, note: "ticked in Bee" }, at);
      logger.info("ask approved", { ideaId: idea.id, todoId: idea.todoId });
      return "approved";
    }
    if (status === "deleted") {
      store.transitionIdea(idea.id, "rejected", { answeredAt: at, note: "deleted in Bee" }, at);
      logger.info("ask rejected", { ideaId: idea.id, todoId: idea.todoId });
      return "rejected";
    }
    // The to-do was read before looking at the clock, so a tick made just before the cutoff counts.
    if (current.askExpiresAt !== null && now.getTime() >= Date.parse(current.askExpiresAt)) {
      store.transitionIdea(idea.id, "expired", { note: "no answer by the cutoff" }, at);
      logger.info("ask expired", { ideaId: idea.id, todoId: idea.todoId });
      return "expired";
    }
    return "waiting";
  }

  return {
    check,
    async runPass(shouldStop = () => false, abandoned = () => false) {
      for (const idea of store.listIdeas({ states: ["asked"] })) {
        if (shouldStop() || abandoned()) return;
        let result: AnswerCheck;
        try {
          result = await check(idea, abandoned);
        } catch (error) {
          // Most likely the store. One ask's trouble must not hide the answers to the others.
          logger.error("could not record the answer to an ask", { ideaId: idea.id, error: errorSummary(error) });
          continue;
        }
        if (result === "logged-out") {
          logger.error("Bee is logged out, so answers cannot be read. Asks stay open until it is logged in again. To log in, run: node spikes/00-bee-login.ts");
          // Said once here. The run loop takes over: it holds the passes back and keeps checking the login.
          ctx.onLoggedOut();
          return;
        }
      }
    },
  };
}
