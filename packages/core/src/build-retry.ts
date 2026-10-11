// When a build gets a second try.
// A build can end badly in two different ways. It can fail (the agent could not make the app),
// or it can be cut short through no fault of the idea: Overnight was told to stop, or the Mac
// restarted mid-build. A cut-short build is tried once more on a later night before the wearer
// is told it could not be finished. A build that failed is never retried by itself.
import type { Idea } from "./types.ts";

/** The reason recorded when Overnight ended a build because it was told to stop. */
export const BUILD_STOPPED_REASON = "the build was stopped";
/** The reason recorded when a build was found cut off afterwards (crash, kill, restart). */
export const BUILD_INTERRUPTED_REASON = "the build was interrupted";
/** How many times one idea's build may be started before a cut-short build counts as a failure. */
export const MAX_BUILD_STARTS = 2;

/**
 * True for a "build_failed" idea whose build was cut short, that nobody has been told about, and
 * that has not used up its starts. The night builder builds these again; the morning step stays
 * silent about them until then. `buildStarts` is `store.countBuildStarts(idea.id)`.
 */
export function isBuildAwaitingRetry(idea: Pick<Idea, "state" | "failureReason" | "failureNotifiedAt">, buildStarts: number): boolean {
  if (idea.state !== "build_failed" || idea.failureNotifiedAt !== null) return false;
  if (idea.failureReason !== BUILD_STOPPED_REASON && idea.failureReason !== BUILD_INTERRUPTED_REASON) return false;
  return buildStarts < MAX_BUILD_STARTS;
}
