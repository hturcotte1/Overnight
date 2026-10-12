// What a build backend is, and what it answers. Both backends (Kiro Crew and Kiro CLI) get the
// same job: one workspace folder with one file in it, brief.md. Neither is handed the database,
// the overnight command line, or anything to publish with.
import { BUILD_INTERRUPTED_REASON, BUILD_STOPPED_REASON } from "@overnight/core";

export interface BuildJob {
  ideaId: string;
  /** Full path of the workspace folder. It holds brief.md and nothing else when the build starts. */
  workspace: string;
  /** Full path of brief.md inside the workspace. */
  briefPath: string;
  /** Our own time limit for this try. */
  timeoutMs: number;
}

export interface BuildOptions {
  /**
   * Aborted when Overnight itself is told to stop. The backend then stops waiting, ends what it
   * started (the Kiro Crew job is cancelled and removed, Kiro CLI's process group is killed) and
   * answers with the reason STOPPED_REASON, within a few seconds.
   */
  signal?: AbortSignal;
}

// What a try cost, for the month's ledger (core's build-budget.ts), is on both kinds of outcome:
// a build that failed, ran out of time or was stopped used credits too.
//   credits   Kiro credits the builder itself recorded for this try. Left out when it recorded none.
//   agentMs   How long the agent ran in this try. Left out when no agent was started: such a try
//             costs nothing and is not counted.
export type BuildOutcome =
  | { ok: true; backend: string; ms: number; credits?: number; agentMs?: number }
  | {
      ok: false;
      backend: string;
      ms: number;
      /** Why, in plain words. Our own text only: never a title, transcript text or raw tool output. */
      reason: string;
      /** True when the backend could not even begin (not installed, gateway down, sandbox check failed). */
      couldNotStart: boolean;
      credits?: number;
      agentMs?: number;
    };

export interface BuildBackend {
  readonly name: "kiro-crew" | "kiro-cli";
  /** Never throws: every failure comes back as { ok: false }. */
  build(job: BuildJob, options?: BuildOptions): Promise<BuildOutcome>;
}

export const MINUTE_MS = 60_000;
// The two reasons for a build that was cut short through no fault of the idea. The texts are
// core's (build-retry.ts): the rule for trying such a build once more reads them, and so does the
// morning step. The names here are the ones this package has always exported.
/** The reason for a build found cut off afterwards: its process crashed, was killed, or the Mac restarted. */
export const INTERRUPTED_REASON = BUILD_INTERRUPTED_REASON;
/** The reason for a build that Overnight ended itself because it was told to stop (a stop signal). */
export const STOPPED_REASON = BUILD_STOPPED_REASON;

/** "45 minutes", "1 minute": for failure reasons. */
export function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
