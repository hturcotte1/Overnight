// `overnight status`: what Overnight has saved and decided so far, and whether it is listening.
// It only reads, so it is safe to run at any time. It prints counts and times, never what was
// said. Only --check talks to Bee, and only to ask "are we logged in?".
import { errorSummary, formatLocal, IDEA_STATES, localDayBounds } from "@overnight/core";
import type { Config, DetectorOutcome, IdeaState, LoginState, Store } from "@overnight/core";
import type { ListenerState } from "../background.ts";
import { plural, toJson } from "../output.ts";
import type { Write } from "../output.ts";

/** The parts of the Store this command reads. */
export type StatusStore = Pick<
  Store,
  "isPaused" | "countUtterances" | "newestUtteranceReceivedAt" | "countDetectorRuns" | "countIdeasByState" | "countAsksBetween" | "conversationsAwaitingDetection"
>;

export interface StatusDeps {
  store: StatusStore;
  config: Pick<Config, "dataDir" | "timeZone" | "maxAsksPerDay" | "pausedByDefault">;
  write: Write;
  now?: () => Date;
  /** Is a listener running, and is the background job installed? The command line passes the real check. Left out, status does not mention it. */
  listenerState?: () => ListenerState;
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
  /** Only with --check. */
  beeLogin?: LoginState;
}

export function collectStatus(deps: Omit<StatusDeps, "write">): StatusReport {
  const { store, config } = deps;
  const today = localDayBounds(deps.now?.() ?? new Date(), config.timeZone);
  const awaiting = store.conversationsAwaitingDetection();
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
    ideas: store.countIdeasByState(),
    asksToday: store.countAsksBetween(today.start.toISOString(), today.end.toISOString()),
    maxAsksPerDay: config.maxAsksPerDay,
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
const JOB_INSTALL_COMMAND = "scripts/install-agents.sh install";

/** One plain line: is it listening, and is the background job in place? */
function listenerWords(state: ListenerState): string {
  if (state.running === null) {
    return `could not tell whether it is running (background job ${state.jobInstalled ? "installed" : "not installed"}). Check with: ${JOB_STATUS_COMMAND}`;
  }
  if (state.running) return state.jobInstalled ? "running (background job installed)" : "running, started by hand (background job not installed)";
  return state.jobInstalled
    ? `NOT running, although the background job is installed. See why with: ${JOB_STATUS_COMMAND}`
    : `not running (background job not installed). Start it with: ${JOB_INSTALL_COMMAND}`;
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
  );
  if (report.beeLogin !== undefined) rows.push(["Bee login", LOGIN_WORDS[report.beeLogin]]);

  const width = Math.max(...rows.map(([label]) => label.length));
  return ["Overnight status", ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];
}

export async function status(deps: StatusDeps, options: StatusOptions = {}): Promise<number> {
  const report = collectStatus(deps);
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
