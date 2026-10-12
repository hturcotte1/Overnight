// `overnight status`: what Overnight has saved and decided so far, whether it is listening, and
// whether tonight's build and tomorrow morning's delivery are set to happen.
// It only reads, so it is safe to run at any time. It prints counts and times, never what was
// said. The one thing it asks outside the database is whether the Kiro Crew gateway on this Mac
// answers. Only --check talks to Bee, and only to ask "are we logged in?".
//
// scripts/install-agents.sh reads the --json form to learn the night jobs' times (buildTime,
// deliverTime, timeZone), how the Kiro Crew gateway is fenced in (buildSandbox), and whether a
// job it has just started has asked the clock yet (nightClock.build.checkedAt and
// nightClock.deliver.checkedAt: a UTC time as toISOString() writes it, or null).
// Those six names are a promise to that script.
import {
  buildBudget,
  CLOCKED_JOBS,
  currentSlot,
  describeNight,
  errorSummary,
  formatLocal,
  IDEA_STATES,
  isBuildAwaitingRetry,
  LATE_AFTER_MS,
  localDayBounds,
  nextSlotAt,
  NIGHT_CHECK_FRESH_MS,
  NIGHT_TICK_SECONDS,
  readCheckedAt,
  readLastNightRun,
  readNightRun,
} from "@overnight/core";
import type { BuildBudget, ClockedJob, Config, DetectorOutcome, IdeaState, LoginState, NightClockConfig, NightRun, NightView, Store } from "@overnight/core";
import type { JobTrigger, ListenerState, NightJobsState } from "../background.ts";
import { installCommand, installCommands, NIGHT_JOBS } from "../background.ts";
import { oneLine, plural, toJson } from "../output.ts";
import type { Write } from "../output.ts";
import type { PowerSource } from "../power.ts";
import { nextStartAt, runNotStarting } from "./night-tick.ts";
import { isRehearsalIdea } from "./rehearse.ts";

// Moved to the night clock in @overnight/core. Still offered from here, where it used to live.
export { clockMinus } from "@overnight/core";

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
  | "getValue"
  | "buildCreditsBetween"
>;

export interface StatusDeps {
  store: StatusStore;
  config: Pick<Config, "dataDir" | "timeZone" | "maxAsksPerDay" | "pausedByDefault" | "buildTime" | "deliverTime" | "maxBuildsPerNight" | "buildBackend" | "buildSandbox" | "maxBuildCreditsPerMonth">;
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
  /** Is the build, or the deliver, running on this data folder right now (is its lock held)? Null if that could not be told. Left out, status takes it as not known and the report has no `lockHeld`. */
  jobRunning?: (job: ClockedJob) => boolean | null;
  /** How macOS starts the build and the deliver job: every minute ("timer"), or still by its calendar. Left out, status does not mention the night clock. */
  jobTriggers?: () => Record<ClockedJob, JobTrigger | null>;
  /** Is this Mac on mains power or on battery? Asked beside `gatewayAnswers`. If the check itself fails, status says it could not tell. Left out, status does not mention it. */
  powerSource?: () => Promise<PowerSource>;
  /** Were the installed background jobs installed for this data folder? Null if that cannot be told. Left out, status takes them as this folder's. */
  jobsBelongHere?: () => boolean | null;
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

/** One job's night on the night clock, and how macOS starts the job. */
export type NightClockView = NightView & {
  /** Only when the caller can check it. Null: the job is not installed, or its settings file could not be read. */
  trigger?: JobTrigger | null;
  /** True when the job asked the clock in the last three minutes, or is running right now. A job that is neither has stopped waking, or the Mac has only just woken. */
  fresh: boolean;
  /**
   * When the clock next starts this job by itself (UTC): its first time after now that its record
   * does not already cover. Usually `nextSlotAt`. Later when the record is dated on that day or
   * after it: the job's time, TZ or the Mac's clock was moved (night-tick.ts, `nextStartAt`).
   */
  nextStartAt: string;
  /**
   * Does some process hold the job's lock right now: a run of this kind is going on this data
   * folder, however it was started? Null if the look itself failed (the lock file could not be
   * used). Only when the caller can check it.
   */
  lockHeld?: boolean | null;
  /** True when the job has tried for minutes to start the run that is due and the work never begins. The reason is in the job's log (night-tick.ts, `runNotStarting`). */
  notStarting: boolean;
  /**
   * True when the run that is due may be starting at this very moment: some process holds the
   * job's lock, and the record is as the job's own check leaves it when it hands over to the work
   * (`runMayBeStarting`). Either that check is about to write the start, or another run has the
   * lock and the due one waits for it. Nothing stored says which.
   */
  mayBeStarting: boolean;
};

/**
 * May the job's own check be starting the run that is due, at this moment?
 *
 * A check takes the job's lock, writes the slot's record open, started by nothing and waiting for
 * nothing, and hands over to the work (night-tick.ts, `runSlot`). The work writes the start once
 * the builder or the deliver step has loaded, a second or so later. In between the lock is held
 * and the record shows no start: the run is starting, and nothing is holding it up.
 *
 * A build-now, or a run by hand, that holds the lock while a due run waits for it looks the same
 * whenever the record already stands like that, which it does after a try that ended before the
 * work began. Nothing stored says who holds a lock. The job's heartbeat does not settle it either:
 * a record first noticed by the job's latest check is nearly always that check's own start, but a
 * try that failed at once and a run by hand begun within the same minute leave exactly that.
 * So this answers "may be", and `status` says both.
 *
 * False for any other record (another day's, or one that is waiting for something): the job's
 * own check never holds the lock over such a record for longer than an instant.
 * `lockHeld` is whether some process holds the job's lock right now (null: could not tell).
 */
function runMayBeStarting(input: { job: ClockedJob; now: Date; config: NightClockConfig; record: NightRun | null; lockHeld: boolean | null }): boolean {
  const { record } = input;
  if (input.lockHeld !== true || record === null) return false;
  if (record.startedAt !== null || record.closedAt !== null || record.waiting !== null) return false;
  return record.day === currentSlot(input.job, input.now, input.config).day;
}

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
  /**
   * When the build job next runs by the settings alone (UTC). Whether it runs at all depends on
   * `nightJobs` and `paused`, and when its clock really starts it next is `nightClock.build.nextStartAt`.
   */
  nextBuildAt: string;
  /** When the deliver job next runs by the settings alone (UTC): 30 minutes before DELIVER_TIME. */
  nextDeliverAt: string;
  /**
   * How many of the waiting ideas the next build takes: the nightly limit, less the builds already
   * started on the local day it runs in. The next build is the one the "Next build" row names, so
   * while a build is going, or is due and has not started, that day is today.
   */
  nextBuildTakes: number;
  /** Kiro credits counted against MAX_BUILD_CREDITS_PER_MONTH this calendar month (in `timeZone`), and whether the month's limit is reached. */
  buildCredits: BuildBudget;
  /** Ideas made by `overnight rehearse new`. A data folder that holds one is a rehearsal folder: the night's commands do not run on it. */
  rehearsalIdeas: number;
  /** Only when the caller can check it. */
  nightJobs?: NightJobsState;
  /** False when the installed background jobs were installed for another data folder. Null if that cannot be told. Only when the caller can check it. */
  jobsBelongHere?: boolean | null;
  /**
   * The night clock: how often macOS wakes the build and the deliver job (seconds), and where
   * each one's night stands. `checkedAt` is when the job last asked the clock (UTC, or null).
   */
  nightClock: { tickSeconds: number; build: NightClockView; deliver: NightClockView };
  /** Does the Kiro Crew gateway on this Mac answer? Null if the check itself failed. Only when the caller can check it. */
  gatewayAnswers?: boolean | null;
  /** Is this Mac on mains power or on battery? Only when the caller can check it. */
  power?: PowerSource;
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

export function collectStatus(deps: Omit<StatusDeps, "write" | "gatewayAnswers" | "powerSource">): StatusReport {
  const { store, config } = deps;
  const now = deps.now?.() ?? new Date();
  const triggers = deps.jobTriggers?.();
  const jobsHere = deps.jobsBelongHere?.();
  const clockOf = (job: ClockedJob): NightClockView => {
    const record = readNightRun(store, job);
    const checkedAt = readCheckedAt(store, job);
    const running = deps.jobRunning?.(job) ?? null;
    return {
      ...describeNight({ job, now, config, record, last: readLastNightRun(store, job), checkedAt, running }),
      ...(triggers === undefined ? {} : { trigger: triggers[job] }),
      // A job that is building or delivering does not ask the clock meanwhile: its lock says it is alive.
      fresh: running === true || (checkedAt !== null && now.getTime() - Date.parse(checkedAt) <= NIGHT_CHECK_FRESH_MS),
      nextStartAt: nextStartAt(job, now, config, record).toISOString(),
      ...(deps.jobRunning === undefined ? {} : { lockHeld: running }),
      notStarting: runNotStarting({ job, now, config, record, lockHeld: running }),
      mayBeStarting: runMayBeStarting({ job, now, config, record, lockHeld: running }),
    };
  };
  const nightClock = { tickSeconds: NIGHT_TICK_SECONDS, build: clockOf("build"), deliver: clockOf("deliver") };
  const today = localDayBounds(now, config.timeZone);
  const awaiting = store.conversationsAwaitingDetection();
  const ideas = store.countIdeasByState();
  // Core's rule (build-retry.ts), the same one the nightly builder and the morning step go by.
  const waitingForSecondTry = store.listIdeas({ states: ["build_failed"] }).filter((idea) => isBuildAwaitingRetry(idea, store.countBuildStarts(idea.id))).length;
  const waitingToBuild = (ideas.approved ?? 0) + waitingForSecondTry;
  const nextBuildAt = nextSlotAt("build", now, config);
  // The nightly limit counts the local day the build runs in, which is usually tomorrow's. That
  // build is the one the "Next build" row names. A build that is going, or that is due and has
  // not started, runs today. Otherwise it is the clock's own next start when the job goes by the
  // clock on this data folder, and the next time by the settings when it does not.
  const buildOnClock = goesByTheClock(jobsHere, nightClock.build.trigger);
  const buildDay = localDayBounds(runIsNow(nightClock.build, buildOnClock) ? now : buildOnClock ? new Date(nightClock.build.nextStartAt) : nextBuildAt, config.timeZone);
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
    nextDeliverAt: nextSlotAt("deliver", now, config).toISOString(),
    nextBuildTakes: Math.min(waitingToBuild, Math.max(0, config.maxBuildsPerNight - startedThatDay)),
    buildCredits: buildBudget(store, config, now),
    rehearsalIdeas: store.listIdeas().filter(isRehearsalIdea).length,
    ...(deps.nightJobs ? { nightJobs: deps.nightJobs() } : {}),
    ...(jobsHere === undefined ? {} : { jobsBelongHere: jobsHere }),
    nightClock,
  };
}

/**
 * Is a job woken every minute on this data folder, as far as can be told? Only then do the
 * clock's own words and its own next start apply: a job still on macOS's calendar, one that is
 * not installed, and one installed for another data folder never ask this folder's clock.
 */
function goesByTheClock(jobsBelongHere: boolean | null | undefined, trigger: JobTrigger | null | undefined): boolean {
  return jobsBelongHere !== false && trigger !== null && trigger !== "calendar";
}

/**
 * Is the run a job's "Next" row names one of right now: a run that is going, or one that is due
 * and has not started? These are the two cases `nextRunWords` puts before the job's next time.
 */
function runIsNow(view: NightClockView, onClock: boolean): boolean {
  return (view.state === "running" && view.lastRun !== null) || (view.state === "due" && onClock);
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

/** Said in place of "installed" when the background jobs were installed for some other data folder. */
const LISTENS_ELSEWHERE = "(the installed background job listens on another data folder)";

/** One plain line: is it listening, and is the background job in place? */
function listenerWords(state: ListenerState, jobsBelongHere: boolean | null | undefined): string {
  // The job is installed, but for another data folder: what runs here was not started by it.
  if (state.jobInstalled && jobsBelongHere === false) {
    if (state.running === null) return `could not tell whether one is running on this data folder ${LISTENS_ELSEWHERE}`;
    return state.running ? `running on this data folder, started by hand ${LISTENS_ELSEWHERE}` : `not running on this data folder ${LISTENS_ELSEWHERE}`;
  }
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
function nightJobsWords(state: NightJobsState, jobsBelongHere: boolean | null | undefined): string {
  const names: Record<keyof NightJobsState, string> = { build: "build", deliver: "deliver", crew: "Kiro Crew gateway" };
  const missing = NIGHT_JOBS.filter((job) => !state[job]);
  if (jobsBelongHere === false && missing.length < NIGHT_JOBS.length) return "installed for another data folder: none of them runs on this one";
  if (missing.length === 0) return "build, deliver and Kiro Crew gateway installed";
  const how = `Put ${missing.length === 1 ? "it" : "them"} in place with: ${installCommands(missing)}`;
  if (missing.length === NIGHT_JOBS.length) return `not installed. ${how}`;
  return `not installed: ${missing.map((job) => names[job]).join(", ")}. ${how}`;
}

/** A number of credits for people: one decimal, and none for a whole number ("412.3", "400"). Core's budget sentence shows them the same way. */
function creditsText(credits: number): string {
  return String(Math.round(credits * 10) / 10);
}

/** "Nov 1": a moment as its month and day in the given zone. */
function monthDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at);
}

/** One plain line: what builds have used of the month's limit, and what follows once it is reached. */
function buildCreditsWords(budget: BuildBudget, timeZone: string): string {
  const estimate = creditsText(budget.estimated) === "0" ? "" : ` (${creditsText(budget.estimated)} of that is an estimate)`;
  // A limit of 0 is a choice, not a month that ran out: next month changes nothing.
  if (budget.limit === 0) return `${creditsText(budget.counted)} used this month${estimate}. MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built until it is raised`;
  const used = `${creditsText(budget.counted)} of ${creditsText(budget.limit)} used this month${estimate}`;
  if (!budget.reached) return used;
  return `${used}: nothing more is built until ${monthDay(new Date(budget.monthEnd), timeZone)}, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised`;
}

/** "Oct 12, 1:00 AM, on time", "Oct 12, 3:01 AM, 121 minutes late", "..., cut short". Null when the job has no run on record. */
function lastRunWords(view: NightClockView, timeZone: string): string | null {
  const last = view.lastRun;
  if (last === null) return null;
  const late = last.lateMinutes * 60_000 >= LATE_AFTER_MS ? `${plural(last.lateMinutes, "minute")} late` : "on time";
  // Not closed and not running: its process died, and the job's next check closes it as cut short.
  const ending = last.closedAs === "cut-short" ? ", cut short" : last.closedAs !== null ? "" : view.state === "running" ? ", still running" : ", cut short";
  return `${formatLocal(new Date(last.startedAt), timeZone)}, ${late}${ending}`;
}

/** Is this job woken every minute on this data folder, as far as the report can tell? Only then do the clock's own words apply. */
function onTheClock(report: StatusReport, job: ClockedJob): boolean {
  return goesByTheClock(report.jobsBelongHere, report.nightClock[job].trigger);
}

/** What a job's work is called when talking to a person. */
const WORK_WORDS: Record<ClockedJob, string> = { build: "build", deliver: "delivery" };

/** "Oct 14, 3:00 PM", with the year when it is not the year of `beside` (a record dated far ahead). */
export function whenWords(at: Date, timeZone: string, beside: Date): string {
  const year = (moment: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(moment);
  if (year(at) === year(beside)) return formatLocal(at, timeZone);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/** What a due run is waiting for, when a reason is stored. */
const WAITING_WORDS: Record<NonNullable<NightView["waiting"]>, string> = {
  offline: "waiting for the internet",
  "build-running": "waiting for the build to finish first",
  "build-not-started": "waiting for the build to finish first",
};

/**
 * Why a run that is due has not started, for the front of its row. What is true right now comes
 * first (some process holds the job's lock: the job's own check, starting this very run, or
 * another run that this one waits for), then the reason the job itself stored, then what the
 * record shows (tried, and the work never began). With none of those, the run starts at one of
 * the job's next checks, unless status could not even look at the job's lock.
 */
function dueWords(job: ClockedJob, view: NightClockView): string {
  const heldUp = `waiting for the ${WORK_WORDS[job]} that is going on this data folder right now (a build-now, or one started by hand)`;
  // The second or so between the job's check handing over and the work writing its start. Or a
  // run by hand after a try that got nowhere. Both are said, because nothing can tell them apart.
  if (view.mayBeStarting) return `starting now, or ${heldUp}`;
  if (view.lockHeld === true) return heldUp;
  if (view.waiting !== null) return WAITING_WORDS[view.waiting];
  if (view.notStarting && view.fresh) return `the ${job} job is awake and tries every minute, but the ${WORK_WORDS[job]} does not start (the reason is in logs/${job}.log)`;
  // The look at the job's lock failed: its file cannot be used. The job takes that same lock
  // before it starts anything, so "in a minute or two" would promise more than is known.
  if (view.lockHeld === null) return `could not tell whether a ${WORK_WORDS[job]} is going on this data folder right now (${job}.lock in the data folder could not be used, and the ${job} job needs it to start)`;
  return "as soon as the Mac has been awake for a minute or two";
}

/**
 * The clock's own next start, for people. It is only ever not the job's next time when the record
 * is dated ahead, and such a record can be far ahead: then the year is said too.
 */
function clockStartWords(view: NightClockView, timeZone: string): string {
  const at = new Date(view.nextStartAt);
  return view.recordAhead === null ? formatLocal(at, timeZone) : whenWords(at, timeZone, new Date(view.slotAt));
}

/**
 * When the job next runs. Usually its next time. But a run that is going is said to be going, and
 * a run that is due and has not started is said to be due, with what holds it up. For a job that
 * goes by Overnight's clock on this data folder the time is the clock's own next start, which is
 * not always the next time by the settings (see `nextStartAt` in night-tick.ts).
 */
function nextRunWords(job: ClockedJob, report: StatusReport): string {
  const view = report.nightClock[job];
  if (view.state === "running" && view.lastRun !== null) return `running now, since ${formatLocal(new Date(view.lastRun.startedAt), report.timeZone)}`;
  const first = job === "build" ? ` (${report.buildBackend} first)` : "";
  const onClock = onTheClock(report, job);
  if (view.state === "due" && onClock) return `${dueWords(job, view)}: the ${formatLocal(new Date(view.slotAt), report.timeZone)} ${job} has not run yet${first}`;
  const at = onClock ? clockStartWords(view, report.timeZone) : formatLocal(new Date(job === "build" ? report.nextBuildAt : report.nextDeliverAt), report.timeZone);
  return job === "build" ? `${at}${first}` : `${at}, for the link on the wrist at ${report.deliverTime}`;
}

/** "the build job", "the build and deliver jobs". */
function jobsNamed(jobs: readonly ClockedJob[]): string {
  return jobs.length === 1 ? `the ${jobs[0]} job` : `the ${jobs.join(" and ")} jobs`;
}

/** "Jan 5" for a slot day like 2027-01-05, with the year when it is not the year of `beside`. */
export function dayWords(day: string, beside: string): string {
  const at = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(day.slice(0, 4) === beside.slice(0, 4) ? {} : { year: "numeric" }) }).format(at);
}

/**
 * What it means that a job's record is dated after the day its clock has come to: the clock
 * starts nothing until that day is past, so the next run is not the next time by the settings.
 * One sentence, the same in `status` and `preflight`, to go after "the" or "The". `day` is the
 * record's day (YYYY-MM-DD).
 */
export function recordAheadWords(job: ClockedJob, day: string, view: Pick<NightClockView, "slotDay" | "slotAt" | "nextStartAt">, timeZone: string): string {
  const setting = job === "build" ? "BUILD_TIME" : "DELIVER_TIME";
  const next = whenWords(new Date(view.nextStartAt), timeZone, new Date(view.slotAt));
  return `${job} clock already has ${dayWords(day, view.slotDay)} on record, so the next ${job} is ${next} (${setting}, TZ or the Mac's clock was moved).`;
}

/** Said when two things are wrong with the night clock at once: each sentence ends in a command, so a full stop will not do. */
const ALSO = "   Also: ";

/**
 * One plain line: do the build and the deliver job go by Overnight's own clock, and are they
 * awake? Null (the row is left out) when neither is installed, when they were installed for
 * another data folder, or when the caller could not look.
 */
export function nightClockWords(report: StatusReport): string | null {
  if (report.nightJobs === undefined || report.jobsBelongHere === false) return null;
  const state = report.nightJobs;
  const jobs = CLOCKED_JOBS.filter((job) => state[job] && report.nightClock[job].trigger !== undefined);
  if (jobs.length === 0) return null;

  const problems: string[] = [];
  const onCalendar = jobs.filter((job) => report.nightClock[job].trigger === "calendar");
  if (onCalendar.length > 0) {
    const many = onCalendar.length > 1;
    problems.push(`${jobsNamed(onCalendar)} ${many ? "are" : "is"} still on macOS's calendar, which ran an hour late on Oct 11. Move ${many ? "them" : "it"} to Overnight's own clock with: ${installCommands(onCalendar)}`);
  }
  for (const job of jobs) {
    const view = report.nightClock[job];
    if (view.trigger === "calendar") continue;
    if (view.trigger === null) {
      problems.push(`the ${job} job's settings file could not be read. See why with: ${JOB_STATUS_COMMAND} ${job}`);
    } else if (view.recordAhead !== null) {
      problems.push(`the ${recordAheadWords(job, view.recordAhead, view, report.timeZone)} Start its clock from now with: ${installCommand(job)}`);
    } else if (!view.fresh) {
      problems.push(
        view.checkedAt === null
          ? `the ${job} job has never checked the time. If the Mac has been awake for a few minutes since it was installed, see why with: ${JOB_STATUS_COMMAND} ${job}`
          : `the ${job} job last checked the time ${formatLocal(new Date(view.checkedAt), report.timeZone)}. If the Mac has been awake for a few minutes since, see why with: ${JOB_STATUS_COMMAND} ${job}`,
      );
    } else if (view.notStarting) {
      problems.push(`the ${job} job checks the time, but the ${WORK_WORDS[job]} that is due does not start. See the last lines of its logs with: ${JOB_STATUS_COMMAND} ${job}`);
    }
  }
  if (problems.length > 0) return problems.join(ALSO);
  return jobs.length === 1 ? `${jobsNamed(jobs)} checks the time every minute, in ${report.timeZone}` : `${jobs.join(" and ")} check the time every minute, in ${report.timeZone}`;
}

const LID_CLOSED = "With the lid closed nothing runs until it is opened";

/**
 * One plain line: mains or battery, and on battery whether anything of Overnight's is keeping the
 * Mac awake. That is the listener's doing (a build or a delivery only holds it for as long as it
 * runs), so the sentence goes by whether a listener is running on this data folder. It says
 * "Overnight keeps the Mac awake" only when one is.
 */
function powerWords(power: PowerSource, listener: ListenerState | undefined): string {
  if (power === "mains") return "mains power";
  if (power === "unknown") return "could not tell";
  if (listener?.running === true) return `battery: Overnight keeps the Mac awake while the lid is open. ${LID_CLOSED}`;
  if (listener?.running === false) return `battery: the listener is not running, so nothing of Overnight's keeps the Mac awake between runs, and it may go to sleep. ${LID_CLOSED}`;
  return `battery: a running listener keeps the Mac awake while the lid is open, but whether one is running could not be told. ${LID_CLOSED}`;
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
  if (report.rehearsalIdeas > 0) {
    return `nothing will be built: this data folder holds ${report.rehearsalIdeas === 1 ? "a rehearsal idea" : `${report.rehearsalIdeas} rehearsal ideas`}, and the night's commands do not run here`;
  }
  if (report.jobsBelongHere === false) return "nothing is built on this data folder by the night jobs: they are installed for another one";
  if (report.nightJobs !== undefined && !report.nightJobs.build) return `nothing will be built: the build job is not installed. Put it in place with: ${installCommand("build")}`;
  if (report.waitingToBuild === 0) return "nothing to build so far: no approved idea is waiting";
  if (report.buildCredits.reached) {
    return report.buildCredits.limit === 0 ? "nothing will be built: MAX_BUILD_CREDITS_PER_MONTH in .env is 0 (see Build credits)" : "nothing will be built: this month's build credits are used up (see Build credits)";
  }
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
  if (report.listener !== undefined) rows.push(["Listener", listenerWords(report.listener, report.jobsBelongHere)]);
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
    ["Build credits", buildCreditsWords(report.buildCredits, report.timeZone)],
    ["Waiting to build", waitingWords(report)],
  );
  if (report.lastDelivered !== null) {
    const link = report.lastDelivered.url === null ? "(no link recorded)" : oneLine(report.lastDelivered.url);
    rows.push(["Last delivered", `${formatLocal(new Date(report.lastDelivered.at), report.timeZone)}  ${link}`]);
  }
  // The last night, as the night clock has it: when each job last started, and how that went.
  const lastBuild = lastRunWords(report.nightClock.build, report.timeZone);
  if (lastBuild !== null) rows.push(["Last build", lastBuild]);
  const lastDeliver = lastRunWords(report.nightClock.deliver, report.timeZone);
  if (lastDeliver !== null) rows.push(["Last deliver", lastDeliver]);
  // The night ahead: when, with what, and whether anything is in the way. Times are local.
  rows.push(["Next build", nextRunWords("build", report)], ["Next deliver", nextRunWords("deliver", report)]);
  if (report.nightJobs !== undefined) rows.push(["Night jobs", nightJobsWords(report.nightJobs, report.jobsBelongHere)]);
  const nightClock = nightClockWords(report);
  if (nightClock !== null) rows.push(["Night clock", nightClock]);
  if (report.gatewayAnswers !== undefined) rows.push(["Kiro Crew gateway", report.gatewayAnswers === null ? GATEWAY_WORDS.unknown : report.gatewayAnswers ? GATEWAY_WORDS.yes : GATEWAY_WORDS.no]);
  rows.push(["Build sandbox", SANDBOX_WORDS[report.buildSandbox]]);
  if (report.power !== undefined) rows.push(["Power", powerWords(report.power, report.listener)]);
  rows.push(["Tonight", tonightWords(report)]);
  if (report.beeLogin !== undefined) rows.push(["Bee login", LOGIN_WORDS[report.beeLogin]]);
  rows.push(["Full check", PREFLIGHT_COMMAND]);

  const width = Math.max(...rows.map(([label]) => label.length));
  return ["Overnight status", ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];
}

export async function status(deps: StatusDeps, options: StatusOptions = {}): Promise<number> {
  const report = collectStatus(deps);
  // The two questions asked outside the database, side by side. Status is for looking, at any
  // time: a check that fails must not hide the rest.
  const [gateway, power] = await Promise.all([
    deps.gatewayAnswers === undefined ? undefined : deps.gatewayAnswers().catch(() => null),
    deps.powerSource === undefined ? undefined : deps.powerSource().catch((): PowerSource => "unknown"),
  ]);
  if (gateway !== undefined) report.gatewayAnswers = gateway;
  if (power !== undefined) report.power = power;
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
