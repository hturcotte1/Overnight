// Every shape the dashboard's parts hand to each other.
// The parts (data, story, pages, server, demo) are written against this file and never against
// each other, so a change here is a change to all of them: tell the integrator first.
//
// Nothing here holds a line Bee heard. The only words from a conversation that can reach a page
// are an idea's short quote, and that travels as `Said`, which says when it is being hidden.
import type { BuildBudget, ClockedJob, Config, Idea, IdeaEvent, IdeaState, NightRun } from "@overnight/core";
import type { SafeHtml } from "./render/html.ts";

/** What an idea id looks like. No path or address is ever built from an id that does not match. */
export const IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

// ---------- Filming ----------

/** `--filming` hides what was said. `showQuoteFor` holds the ids let through with `--show-quote`. */
export interface FilmingPolicy { on: boolean; showQuoteFor: ReadonlySet<string> }

/** An idea's quote, or why there is none to show: hidden while filming, or the idea never had one. */
export type Said = { shown: true; text: string } | { shown: false; why: "filming" | "none" };

// ---------- What the database look gives ----------

/** An idea as the pages see it. The quote is a `Said`; the ids of Bee's to-dos and facts stay behind. */
export interface DashIdea extends Omit<Idea, "quote" | "conversationKey" | "detectorRunId" | "todoId" | "morningTodoId" | "factId"> {
  quote: Said;
  /** True when filming replaced the title and the pitch (an idea nobody has approved). */
  hidden: boolean;
  /** Made by `overnight rehearse`, not heard. */
  rehearsal: boolean;
  /** How many times a build of it has started. */
  buildStarts: number;
  /** Its build was cut short and gets one more try (core's isBuildAwaitingRetry). */
  awaitingRetry: boolean;
  hasMorningTodo: boolean;
  hasFact: boolean;
}

/** What the detector made of a conversation. "listening" means some of its lines are not checked yet. */
export type HeardOutcome = "idea" | "not_idea" | "too_short" | "too_old" | "skipped" | "failed" | "listening";

/** One conversation on the Heard lane, as counts and times only. `bars` are 1 to 7, for its newest 8 lines. */
export interface HeardGroup { id: string; firstAt: string; lastAt: string; lines: number; bars: number[]; outcome: HeardOutcome; ideaId: string | null }

/** Is each program running on this data folder right now? null: could not tell. */
export interface Running { listener: boolean | null; build: boolean | null; deliver: boolean | null }

// ---------- What the two job logs give ----------

export type Backend = "kiro-crew" | "kiro-cli";
/** Which command started a run. */
export type RunCommand = "build" | "build-now" | "rehearse" | "unknown";

/** The night's ticks for one idea's latest build, read from build.log. */
export interface BuildFacts {
  startedAt: string;
  by: RunCommand;
  signIn: { at: string; status: "ready" | "waiting" | "signed-out" | "unknown"; minutesLeft: number | null } | null;
  /** `reused`: the check ran earlier in the same run, for another idea. */
  sandboxCheck: { at: string; ok: boolean; ms: number | null; reused: boolean } | null;
  agentStarted: { at: string; backend: Backend } | null;
  /** The first builder failed and the other one was tried. */
  fellBack: { at: string } | null;
  finished: { at: string; ok: boolean; seconds: number | null; credits: number | null } | null;
}

/** The morning's ticks for one idea, read from deliver.log. */
export interface DeliverFacts {
  firstAt: string;
  checked: { at: string; ok: boolean; ms: number | null; files: number | null; bytes: number | null; step: string | null } | null;
  pushed: { at: string } | null;
  live: { at: string; seen: boolean; liveAfterMs: number | null } | null;
  told: { at: string; what: "built" | "could-not-finish" } | null;
  fact: { at: string } | null;
}

/** One run of the build command, from its first log line to its last. */
export interface BuildRun {
  command: RunCommand;
  startedAt: string;
  finishedAt: string | null;
  waiting: number | null;
  taking: number | null;
  built: number | null;
  failed: number | null;
  paused: boolean;
  nothingApproved: boolean;
  sandboxCheck: BuildFacts["sandboxCheck"];
  ideaIds: string[];
}

/** One run of the deliver command. */
export interface DeliverRun { command: RunCommand; startedAt: string; finishedAt: string | null; delivered: number | null; failed: number | null; notified: number | null; ideaIds: string[] }

// ---------- What decides whether, and when, the night's work happens ----------

/**
 * What the night clock has stored about one night job (core, night-clock.ts): the record of its
 * latest slot, its last run that started and was closed, and when it last asked the clock. All
 * null for a job that has never asked the clock on this data folder.
 */
export interface NightRecords { record: NightRun | null; last: NightRun | null; checkedAt: string | null }

// ---------- One look at everything ----------

/** Why the database could not be read. "missing" and "empty" mean nothing has been saved yet. */
export type DbProblem = "missing" | "empty" | "busy" | "unreadable";

/** Everything one page render needs, read in one look. */
export interface Snapshot {
  at: string;
  problem: DbProblem | null;
  /** Set when this is an older look, shown because the newest one failed. */
  staleSince: string | null;
  /** The database says its data is invented (the demo seed's mark). */
  demoMark: boolean;
  paused: boolean;
  running: Running;
  /** The latest DELIVER_TIME at or before now: where "since 7:00 AM" counts from. */
  dayStart: string;
  linesHeard: number;
  lastHeardAt: string | null;
  asks: number;
  detector: Record<"idea" | "not_idea" | "skipped" | "failed", number>;
  heard: HeardGroup[];
  ideas: DashIdea[];
  events: ReadonlyMap<string, IdeaEvent[]>;
  build: ReadonlyMap<string, BuildFacts>;
  deliver: ReadonlyMap<string, DeliverFacts>;
  buildRuns: BuildRun[];
  deliverRuns: DeliverRun[];
  nextBuildAt: string;
  nextDeliverAt: string;
  /**
   * Ideas made by `overnight rehearse new`, counted over the whole database (not only the ideas
   * shown). A data folder that holds one is a rehearsal folder: the nightly build and the
   * morning's run refuse to start on it.
   */
  rehearsalIdeas: number;
  /**
   * Where this month's building stands against MAX_BUILD_CREDITS_PER_MONTH: core's own reckoning
   * (buildBudget) over the ledger of what builds cost. Null when the database could not be read.
   */
  buildCredits: BuildBudget | null;
  /** The night clock's stored values for the build and the deliver job. */
  nightClock: Record<ClockedJob, NightRecords>;
  /** Rows that did not fit their shape and were left out. */
  unreadableRows: number;
}

// ---------- What the files give (idea page only) ----------

/** The deliver step's report, numbers and yes/no only. */
export interface ReportView {
  confirmedLive: boolean | null;
  failedStep: string | null;
  verifyMs: number | null;
  publishMs: number | null;
  liveAfterMs: number | null;
  distFiles: number | null;
  distBytes: number | null;
  checks: Record<"installOk" | "buildOk" | "contractOk" | "appSmokeOk", boolean | null>;
}

/** Which files a build in progress has made so far. */
export interface WorkspaceMarks { started: boolean; projectWritten: boolean; packagesInstalled: boolean; appBuilt: boolean; notesWritten: boolean }

export interface IdeaExtras {
  report: ReportView | null;
  brief: { text: string; cut: boolean } | null;
  /** "filming": an agent wrote them, so they are not sent while filming. */
  notes: { text: string; cut: boolean } | "filming" | null;
  shots: { phone: boolean; desktop: boolean };
  marks: WorkspaceMarks | null;
}

// ---------- The story of one idea ----------

export type StepKey = "heard" | "asked" | "approved" | "built" | "checked" | "published" | "delivered";
export type StepStatus = "done" | "active" | "todo" | "failed" | "waiting" | "ended";
export interface StoryStep { key: StepKey; label: string; status: StepStatus; at: string | null; detail: string | null; said: Said | null }
/** One of the night's ticks. `since` starts a running clock. */
export interface Check { key: string; label: string; status: "done" | "active" | "todo" | "failed"; detail: string | null; since: string | null }
export interface Story { ideaId: string; steps: StoryStep[]; checks: Check[]; runningSince: string | null; runningLabel: string | null; hint: string | null }

/** One night, noon to noon, named by its morning. */
export interface Night {
  key: string;
  label: string;
  headline: string;
  /**
   * `outcome`: the last state the idea came to in this night. `cutShort`: that night's build was cut
   * short (or cut off) and its one more try is still to come, so it has not failed.
   */
  ideas: Array<{ idea: DashIdea; outcome: IdeaState; buildSeconds: number | null; credits: number | null; by: RunCommand | null; cutShort: boolean }>;
  built: number;
  /** Failed for good. A build that was cut short and waits for its one more try is counted in `cutShort`, not here. */
  failed: number;
  cutShort: number;
  delivered: number;
  credits: number | null;
  buildRun: BuildRun | null;
  deliverRun: DeliverRun | null;
}

/**
 * Why the nightly build will not simply take the waiting ideas at BUILD_TIME, as far as the data
 * folder alone can tell (whether the night jobs are installed is not in it). The reasons, and
 * their order, are the ones `overnight status` gives under "Tonight" and "Next build":
 *   rehearsal    the data folder holds a rehearsal idea, so the nightly build refuses to run on it
 *   credits      MAX_BUILD_CREDITS_PER_MONTH is reached (or is 0)
 *   clock-ahead  the night clock's record is dated after today, so its next run is not simply the next one by the settings
 *   late         the build's time has passed and it has not started (the Mac was asleep, or is offline)
 * Being paused comes before all of them and is not one of them: `paused` says it.
 *
 * `step` goes where the Built step's time would be ("at 1:00 AM"), `line` after the title in the
 * line over the hero, `note` on the Tonight's build lane.
 */
export interface BuildHold { why: "rehearsal" | "credits" | "clock-ahead" | "late"; step: string; line: string; note: string }

/**
 * The same for the morning's run, which checks, publishes and delivers what the night built.
 * `step` goes where the Checked step's time would be ("at 6:30 AM"); null leaves it empty.
 * `line` is a whole clause in place of "Checks start at 6:30 AM".
 */
export interface ChecksHold { why: "rehearsal" | "clock-ahead" | "late"; step: string | null; line: string }

/** What stands between the waiting ideas and the night's two runs. Null: nothing the data folder knows of. */
export interface NightOutlook { build: BuildHold | null; checks: ChecksHold | null }

/** `hold`: why the rows will not be built at `at`, when Overnight is not paused and something else is in the way. */
export interface TonightQueue { at: string; paused: boolean; limit: number; hold: BuildHold | null; rows: Array<{ idea: DashIdea; when: "building" | "tonight" | "later" }> }

// ---------- Pages ----------

export interface RenderContext { now: Date; config: Config; home: string; filming: FilmingPolicy }

/** What the shell around every page shows. */
export interface Chrome {
  current: "today" | "ideas" | "nights" | "settings" | "none";
  running: Running;
  paused: boolean;
  filming: boolean;
  demo: boolean;
  problem: DbProblem | null;
  staleSince: string | null;
  nowMs: number;
  timeZone: string;
  pollMs: 2000 | 5000;
}

export interface View { title: string; main: SafeHtml }

// ---------- Server ----------

export type AssetName = "app.css" | "app.js" | "icon.svg";
export type PageRoute = { kind: "today" } | { kind: "ideas" } | { kind: "idea"; id: string } | { kind: "nights" } | { kind: "settings" };
export type Route = PageRoute | { kind: "asset"; name: AssetName } | { kind: "shot"; id: string; which: "phone" | "desktop" };

/** What the web server is handed. It knows nothing else about Overnight. */
export interface Site {
  /** May throw; the server then answers 500 with problem("error"). */
  page(route: PageRoute): { status: 200 | 404; html: SafeHtml; etag: string };
  /** A whole page with no data in it. */
  problem(kind: "needs-key" | "not-found" | "error"): SafeHtml;
  shot(ideaId: string, which: "phone" | "desktop"): Buffer | null;
}
