// `overnight status`: what Overnight has saved and decided so far, whether it is listening, and
// whether tonight's build and tomorrow morning's delivery are set to happen.
// It only reads, so it is safe to run at any time. It prints counts and times, never what was
// said. The one thing it asks outside the database is whether the Kiro Crew gateway on this Mac
// answers. Only --check talks to Bee, and only to ask "are we logged in?".
//
// scripts/install-agents.sh reads the --json form to learn when to schedule the night jobs
// (buildTime, deliverTime, timeZone) and how the Kiro Crew gateway is fenced in (buildSandbox).
// Those four names are a promise to that script.
import { errorSummary, formatLocal, IDEA_STATES, isBuildAwaitingRetry, localDayBounds, nextLocalTime, parseHhMm } from "@overnight/core";
import type { Config, DetectorOutcome, IdeaState, LoginState, Store } from "@overnight/core";
import type { ListenerState, NightJobsState } from "../background.ts";
import { DELIVER_LEAD_MINUTES, installCommand, installCommands, NIGHT_JOBS } from "../background.ts";
import { oneLine, plural, toJson } from "../output.ts";
import type { Write } from "../output.ts";

/** The parts of the Store this command reads. */
export type StatusStore = Pick<
  Store,
  | "isPaused"
  | "countUtterances"
  | "newestUtteranceReceivedAt"
  | "countDetectorRuns"
  | "countIdeasByState"
  | "countAsksBetween"
  | "conversationsAwaitingDetection"
  | "countBuildsStartedBetween"
  | "countBuildStarts"
  | "listIdeas"
>;

export interface StatusDeps {
  store: StatusStore;
  config: Pick<Config, "dataDir" | "timeZone" | "maxAsksPerDay" | "pausedByDefault" | "buildTime" | "deliverTime" | "maxBuildsPerNight" | "buildBackend" | "buildSandbox">;
  write: Write;
  now?: () => Date;
  /** Is a listener running, and is the background job installed? The command line passes the real check. Left out, status does not mention it. */
  listenerState?: () => ListenerState;
  /** Which of the night jobs (build, deliver, the Kiro Crew gateway) are installed? Left out, status does not mention them. */
  nightJobs?: () => NightJobsState;
  /**
   * Does the Kiro Crew gateway on this Mac answer? The command line passes the real check (one
   * request to this Mac itself, with a short time limit). Left out, status does not mention it.
   * If the check itself fails, status says it could not tell and still shows everything else.
   */
  gatewayAnswers?: () => Promise<boolean>;
}

export interface StatusOptions {
  json?: boolean;
  /** Given only for --check: asks Bee whether it is logged in. */
  beeLoginState?: () => Promise<LoginState>;
}

// A Record, so adding an outcome to the Store without naming it here fails the typecheck.
const OUTCOME_LABELS: Record<DetectorOutcome, string> = {
  idea: "idea",
  not_idea: "not an idea",
  skipped: "skipped",
  failed: "failed",
};
const OUTCOMES = Object.keys(OUTCOME_LABELS) as DetectorOutcome[];

export interface StatusReport {
  paused: boolean;
  /** Only when the caller can check it (the command line always can). */
  listener?: ListenerState;
  dataDir: string;
  timeZone: string;
  utterances: number;
  /** When the newest saved line reached this Mac (UTC). Null if nothing is saved yet. */
  newestUtteranceAt: string | null;
  /** Lines no detector run has covered yet. */
  awaitingDetection: { utterances: number; conversations: number };
  detectorRuns: Record<DetectorOutcome, number>;
  ideas: Partial<Record<IdeaState, number>>;
  asksToday: number;
  maxAsksPerDay: number;
  /** BUILD_TIME and DELIVER_TIME, as "HH:MM" on a 24-hour clock in `timeZone`. */
  buildTime: string;
  deliverTime: string;
  /** Which builder goes first each night. The other one is the fallback. */
  buildBackend: Config["buildBackend"];
  /** The BUILD_SANDBOX setting: "overnight" (the Kiro Crew gateway runs inside Overnight's own sandbox) or "crew". */
  buildSandbox: Config["buildSandbox"];
  /** Builds started in the local calendar day so far. The nightly limit counts the same day. */
  buildsToday: number;
  maxBuildsPerNight: number;
  /**
   * Ideas the next builds will take: approved ideas no build has picked up yet, and ideas whose
   * build was cut short (stopped, or interrupted by a crash or a restart) and gets its one second
   * try. `overnight queue --approved --json` lists only the first kind.
   */
  waitingToBuild: number;
  /** How many of `waitingToBuild` are that second kind. Nobody has been told about those yet. */
  waitingForSecondTry: number;
  /** The newest delivery, or null if nothing has been delivered yet. */
  lastDelivered: { ideaId: string; url: string | null; at: string } | null;
  /** When the build job next runs by the settings (UTC). Whether it runs at all depends on `nightJobs` and `paused`. */
  nextBuildAt: string;
  /** When the deliver job next runs by the settings (UTC): 30 minutes before DELIVER_TIME. */
  nextDeliverAt: string;
  /** How many of the waiting ideas that build takes: the nightly limit, less the builds already started that local day. */
  nextBuildTakes: number;
  /** Only when the caller can check it. */
  nightJobs?: NightJobsState;
  /** Does the Kiro Crew gateway on this Mac answer? Null if the check itself failed. Only when the caller can check it. */
  gatewayAnswers?: boolean | null;
  /** Only with --check. */
  beeLogin?: LoginState;
}

/** The idea delivered most recently, by the time its morning to-do was created. */
function lastDelivered(store: Pick<Store, "listIdeas">): StatusReport["lastDelivered"] {
  let newest: StatusReport["lastDelivered"] = null;
  for (const idea of store.listIdeas({ states: ["delivered"] })) {
    const at = idea.deliveredAt ?? idea.publishedAt ?? idea.updatedAt;
    // Every stored time is a UTC ISO string of the same shape, so text order is time order.
    if (newest === null || at >= newest.at) newest = { ideaId: idea.id, url: idea.publishedUrl, at };
  }
  return newest;
}

/** A time of day, some minutes earlier, as "HH:MM". It wraps around midnight: 00:10 less 30 minutes is 23:40. */
export function clockMinus(hhmm: string, minutes: number): string {
  const { hour, minute } = parseHhMm(hhmm);
  const total = (((hour * 60 + minute - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function collectStatus(deps: Omit<StatusDeps, "write" | "gatewayAnswers">): StatusReport {
  const { store, config } = deps;
  const now = deps.now?.() ?? new Date();
  const today = localDayBounds(now, config.timeZone);
  const awaiting = store.conversationsAwaitingDetection();
  const ideas = store.countIdeasByState();
  // Core's rule (build-retry.ts), the same one the nightly builder and the morning step go by.
  const waitingForSecondTry = store.listIdeas({ states: ["build_failed"] }).filter((idea) => isBuildAwaitingRetry(idea, store.countBuildStarts(idea.id))).length;
  const waitingToBuild = (ideas.approved ?? 0) + waitingForSecondTry;
  const nextBuildAt = nextLocalTime(now, config.buildTime, config.timeZone);
  // The nightly limit counts the local day the build runs in, which is usually tomorrow's.
  const buildDay = localDayBounds(nextBuildAt, config.timeZone);
  const startedThatDay = store.countBuildsStartedBetween(buildDay.start.toISOString(), buildDay.end.toISOString());
  return {
    paused: store.isPaused(config.pausedByDefault),
    ...(deps.listenerState ? { listener: deps.listenerState() } : {}),
    dataDir: config.dataDir,
    timeZone: config.timeZone,
    utterances: store.countUtterances(),
    newestUtteranceAt: store.newestUtteranceReceivedAt(),
    awaitingDetection: {
      utterances: awaiting.reduce((sum, conversation) => sum + conversation.pendingCount, 0),
      conversations: awaiting.length,
    },
    detectorRuns: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, store.countDetectorRuns(outcome)])) as Record<DetectorOutcome, number>,
    ideas,
    asksToday: store.countAsksBetween(today.start.toISOString(), today.end.toISOString()),
    maxAsksPerDay: config.maxAsksPerDay,
    buildTime: config.buildTime,
    deliverTime: config.deliverTime,
    buildBackend: config.buildBackend,
    buildSandbox: config.buildSandbox,
    buildsToday: store.countBuildsStartedBetween(today.start.toISOString(), today.end.toISOString()),
    maxBuildsPerNight: config.maxBuildsPerNight,
    waitingToBuild,
    waitingForSecondTry,
    lastDelivered: lastDelivered(store),
    nextBuildAt: nextBuildAt.toISOString(),
    nextDeliverAt: nextLocalTime(now, clockMinus(config.deliverTime, DELIVER_LEAD_MINUTES), config.timeZone).toISOString(),
    nextBuildTakes: Math.min(waitingToBuild, Math.max(0, config.maxBuildsPerNight - startedThatDay)),
    ...(deps.nightJobs ? { nightJobs: deps.nightJobs() } : {}),
  };
}

/** "3 (heard 1, asked 2)", or just "0". */
function withBreakdown(parts: Array<[label: string, count: number]>): string {
  const total = parts.reduce((sum, [, count]) => sum + count, 0);
  const shown = parts.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  return shown.length === 0 ? String(total) : `${total} (${shown.join(", ")})`;
}

const LOGIN_WORDS: Record<LoginState, string> = {
  "logged-in": "logged in",
  "logged-out": "logged out. Bee needs a new login before Overnight can hear anything.",
  unknown: "could not tell (Bee did not answer)",
};

const JOB_STATUS_COMMAND = "scripts/install-agents.sh status";
/** Everything tonight's run needs, each with its fix. It changes nothing. */
export const PREFLIGHT_COMMAND = "npx overnight preflight";

/** One plain line: is it listening, and is the background job in place? */
function listenerWords(state: ListenerState): string {
  if (state.running === null) {
    return `could not tell whether it is running (background job ${state.jobInstalled ? "installed" : "not installed"}). Check with: ${JOB_STATUS_COMMAND}`;
  }
  if (state.running) return state.jobInstalled ? "running (background job installed)" : "running, started by hand (background job not installed)";
  return state.jobInstalled
    ? `NOT running, although the background job is installed. See why with: ${JOB_STATUS_COMMAND}`
    : `not running (background job not installed). Start it with: ${installCommand("listen")}`;
}

/**
 * One plain line: which night jobs are in place, and the command for each one that is not. Each
 * command names its job: a bare "install" would also restart the listener.
 */
function nightJobsWords(state: NightJobsState): string {
  const names: Record<keyof NightJobsState, string> = { build: "build", deliver: "deliver", crew: "Kiro Crew gateway" };
  const missing = NIGHT_JOBS.filter((job) => !state[job]);
  if (missing.length === 0) return "build, deliver and Kiro Crew gateway installed";
  const how = `Put ${missing.length === 1 ? "it" : "them"} in place with: ${installCommands(missing)}`;
  if (missing.length === NIGHT_JOBS.length) return `not installed. ${how}`;
  return `not installed: ${missing.map((job) => names[job]).join(", ")}. ${how}`;
}

const SANDBOX_WORDS: Record<Config["buildSandbox"], string> = {
  crew: "crew (Kiro Crew's own sandbox, at its strict level: it leaves the GitHub login, the Bee login and the transcripts within a build job's reach)",
  overnight: "overnight (the Kiro Crew gateway runs inside Overnight's own sandbox, proved by a probe each night)",
};

const GATEWAY_WORDS = {
  yes: "answers",
  no: `does NOT answer. See why with: ${JOB_STATUS_COMMAND} crew`,
  unknown: "could not tell whether it answers",
} as const;

/**
 * One plain line: will anything be built tonight, and is anything in the way? Says only what the
 * report holds. The full check, with a fix for each thing, is `overnight preflight`.
 */
export function tonightWords(report: StatusReport): string {
  if (report.paused) return "nothing will be built: Overnight is paused";
  if (report.nightJobs !== undefined && !report.nightJobs.build) return `nothing will be built: the build job is not installed. Put it in place with: ${installCommand("build")}`;
  if (report.waitingToBuild === 0) return "nothing to build so far: no approved idea is waiting";
  // An idea on its second try was approved like any other, so "approved idea" covers it. Which
  // of the waiting ideas a short night takes is the builder's choice, so only the count is said.
  const secondTries = report.waitingForSecondTry > 0 ? ` (counting ${plural(report.waitingForSecondTry, "second try", "second tries")} after a build that was cut off)` : "";
  if (report.nextBuildTakes === 0) {
    return `nothing more will be built that day: its limit of ${report.maxBuildsPerNight} is used up. ${plural(report.waitingToBuild, "approved idea waits", "approved ideas wait")} for the night after${secondTries}`;
  }
  const later = report.waitingToBuild - report.nextBuildTakes;
  const plan = `${plural(report.nextBuildTakes, "approved idea")} will be built at the next build${later > 0 ? `, ${later} more ${later === 1 ? "waits" : "wait"} for another night` : ""}${secondTries}`;
  const problems: string[] = [];
  if (report.gatewayAnswers === false) {
    problems.push(report.buildBackend === "kiro-crew" ? "the Kiro Crew gateway does not answer, so the fallback builder (Kiro CLI) would do the building" : "the Kiro Crew gateway does not answer, so there is no fallback builder");
  }
  if (report.nightJobs !== undefined && !report.nightJobs.deliver) problems.push("the deliver job is not installed, so nothing would be published in the morning");
  return problems.length === 0 ? plan : `${plan}. But ${problems.join(", and ")}`;
}

/** "2 approved ideas", or, with a cut-off build among them: "3 ideas: 2 approved, 1 whose build was cut off and will be tried once more". */
function waitingWords(report: Pick<StatusReport, "waitingToBuild" | "waitingForSecondTry">): string {
  const again = report.waitingForSecondTry;
  if (again === 0) return plural(report.waitingToBuild, "approved idea");
  const cutOff = "whose build was cut off and will be tried once more";
  const neverBuilt = report.waitingToBuild - again;
  if (neverBuilt === 0) return `${plural(again, "idea")} ${cutOff}`;
  return `${plural(report.waitingToBuild, "idea")}: ${neverBuilt} approved, ${again} ${cutOff}`;
}

// Quiet mode is how Overnight starts. Each line names the one command that changes the mode, so
// nobody has to guess, and going live is always a deliberate step.
export const PAUSED_MODE = "paused (quiet mode): listening and saving, not asking or building. Turn asking on with: npx overnight resume";
export const LIVE_MODE = "live: asks about new ideas and builds approved ones. Back to quiet mode with: npx overnight pause";

export function formatStatus(report: StatusReport): string[] {
  const rows: Array<[label: string, value: string]> = [["Mode", report.paused ? PAUSED_MODE : LIVE_MODE]];
  if (report.listener !== undefined) rows.push(["Listener", listenerWords(report.listener)]);
  rows.push(["Data folder", report.dataDir], ["Time zone", report.timeZone], ["Utterances saved", String(report.utterances)]);
  if (report.newestUtteranceAt !== null) rows.push(["Newest utterance", `arrived ${formatLocal(new Date(report.newestUtteranceAt), report.timeZone)}`]);
  if (report.awaitingDetection.utterances > 0) {
    rows.push(["Waiting for detector", `${plural(report.awaitingDetection.utterances, "line")} in ${plural(report.awaitingDetection.conversations, "conversation")}`]);
  }
  rows.push(
    ["Detector runs", withBreakdown(OUTCOMES.map((outcome) => [OUTCOME_LABELS[outcome], report.detectorRuns[outcome]]))],
    ["Ideas", withBreakdown(IDEA_STATES.map((state) => [state, report.ideas[state] ?? 0]))],
    ["Asks today", `${report.asksToday} of ${report.maxAsksPerDay}`],
    ["Builds today", `${report.buildsToday} of ${report.maxBuildsPerNight}`],
    ["Waiting to build", waitingWords(report)],
  );
  if (report.lastDelivered !== null) {
    const link = report.lastDelivered.url === null ? "(no link recorded)" : oneLine(report.lastDelivered.url);
    rows.push(["Last delivered", `${formatLocal(new Date(report.lastDelivered.at), report.timeZone)}  ${link}`]);
  }
  // The night ahead: when, with what, and whether anything is in the way. Times are local.
  rows.push(
    ["Next build", `${formatLocal(new Date(report.nextBuildAt), report.timeZone)} (${report.buildBackend} first)`],
    ["Next deliver", `${formatLocal(new Date(report.nextDeliverAt), report.timeZone)}, for the link on the wrist at ${report.deliverTime}`],
  );
  if (report.nightJobs !== undefined) rows.push(["Night jobs", nightJobsWords(report.nightJobs)]);
  if (report.gatewayAnswers !== undefined) rows.push(["Kiro Crew gateway", report.gatewayAnswers === null ? GATEWAY_WORDS.unknown : report.gatewayAnswers ? GATEWAY_WORDS.yes : GATEWAY_WORDS.no]);
  rows.push(["Build sandbox", SANDBOX_WORDS[report.buildSandbox]], ["Tonight", tonightWords(report)]);
  if (report.beeLogin !== undefined) rows.push(["Bee login", LOGIN_WORDS[report.beeLogin]]);
  rows.push(["Full check", PREFLIGHT_COMMAND]);

  const width = Math.max(...rows.map(([label]) => label.length));
  return ["Overnight status", ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];
}

export async function status(deps: StatusDeps, options: StatusOptions = {}): Promise<number> {
  const report = collectStatus(deps);
  if (deps.gatewayAnswers) {
    try {
      report.gatewayAnswers = await deps.gatewayAnswers();
    } catch {
      // Status is for looking, at any time. One check that fails must not hide the rest.
      report.gatewayAnswers = null;
    }
  }
  let checkFailure: string | null = null;
  if (options.beeLoginState) {
    try {
      report.beeLogin = await options.beeLoginState();
    } catch (error) {
      // The check is a nice-to-have: a Bee hiccup must not hide everything else status knows.
      report.beeLogin = "unknown";
      checkFailure = errorSummary(error);
    }
  }
  if (options.json) {
    deps.write(toJson(report));
    return 0;
  }
  for (const line of formatStatus(report)) deps.write(line);
  if (checkFailure !== null) deps.write(`  (Bee check failed: ${checkFailure})`);
  return 0;
}
