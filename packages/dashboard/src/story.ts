// What the pages say about an idea, a night and the moment, worked out from one look.
// Everything here is pure: no file, no database and no clock. "Now" is always handed in.
//
// An idea's story is seven steps, always the same seven: Heard, Asked, Approved, Built, Checked,
// Published, Delivered. They come from the database alone, so they are right even when a log has
// been lost. The smaller ticks under them come from the two job logs and are simply absent when
// the logs are.
//
// Every sentence in this file is ours. The only words from elsewhere that pass through are an
// idea's own note and failure reason, which the other packages write in plain words and which
// never hold anything that was said.
import { budgetReachedText, describeNight, LATE_AFTER_MS, localDateKey, localDayBounds, parseHhMm, previousLocalTime } from "@overnight/core";
import type { ClockedJob, Config, IdeaEvent, IdeaState, NightWait } from "@overnight/core";
import { DELIVER_LEAD_MINUTES, INTERRUPTED_GRACE_MINUTES } from "./log-messages.ts";
import { backendLabel, clockTime, dateTime, duration, minusMinutes, plural } from "./render/format.ts";
import type { BuildFacts, BuildHold, BuildRun, Check, ChecksHold, DashIdea, DeliverFacts, DeliverRun, IdeaExtras, Night, NightOutlook, Running, RunCommand, Snapshot, StepKey, StepStatus, Story, StoryStep, TonightQueue } from "./types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// ---------- time ----------

function toMs(at: string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/** Minutes since local midnight, 0 to 1439. */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const piece = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return (piece("hour") % 24) * 60 + piece("minute");
}

function minutesOf(hhmm: string): number {
  const { hour, minute } = parseHhMm(hhmm);
  return hour * 60 + minute;
}

/** "06:30" as people say it: "6:30 AM". */
function clockOf(hhmm: string): string {
  const { hour, minute } = parseHhMm(hhmm);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** When the morning's checks start: half an hour before DELIVER_TIME, as HH:MM. */
function checksStart(config: Pick<Config, "deliverTime">): string {
  return minusMinutes(config.deliverTime, DELIVER_LEAD_MINUTES);
}

/**
 * Where "today" starts on the Today page: the latest DELIVER_TIME at or before now. At 1:00 AM
 * that is yesterday morning, so the page still shows the listening that led to tonight's build.
 */
export function overnightDayStart(now: Date, config: Pick<Config, "deliverTime" | "timeZone">): Date {
  return previousLocalTime(now, config.deliverTime, config.timeZone).at;
}

/**
 * Which night a moment belongs to. A night runs from local noon to local noon and is named by
 * the date of its morning: 11 PM on Oct 10 and 7 AM on Oct 11 are both the night "2026-10-11".
 */
export function nightKey(at: string | Date, timeZone: string): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return localDateKey(new Date(ms + 12 * HOUR_MS), timeZone);
}

// ---------- what stands in the night's way ----------

/** Where the full account of the night's state is. The pages only read the data folder; this also looks at the night jobs. */
const SEE_STATUS = "See: npx overnight status";

/** "Jan 5" for a day named like 2027-01-05, with the year when it is not the year of `beside`. */
function dayWords(day: string, beside: string): string {
  const at = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(day.slice(0, 4) === beside.slice(0, 4) ? {} : { year: "numeric" }) }).format(at);
}

/** A night job that will not start at its time by the settings: its slot is overdue, or its clock's record is dated ahead. */
type OffTheClock = { late: true; slotAt: string; waiting: NightWait | null } | { late: false; ahead: string };

/**
 * Is a night job off its clock, by the night clock's own reading of what it has stored (core,
 * describeNight: the one `overnight status` goes by)? A job that has never asked the clock on
 * this data folder has no record, and is taken to run at its time by the settings.
 */
function offTheClock(s: Snapshot, job: ClockedJob, config: Config): OffTheClock | null {
  const now = new Date(toMs(s.at) ?? 0);
  const view = describeNight({ job, now, config, ...s.nightClock[job], running: s.running[job] });
  if (view.recordAhead !== null) return { late: false, ahead: dayWords(view.recordAhead, view.slotDay) };
  // A slot is due from the moment its time comes until the job's next check starts it, a minute
  // later at most. That is every night, and not late: late is past core's two minutes.
  if (view.state === "due" && now.getTime() - Date.parse(view.slotAt) >= LATE_AFTER_MS) return { late: true, slotAt: view.slotAt, waiting: view.waiting };
  return null;
}

/**
 * What stands between the waiting ideas and the night's two runs, asked in the order
 * `overnight status` asks it (cli, commands/status.ts: "Tonight", then "Next build"). It goes by
 * what the data folder holds and nothing else, so it cannot say that the night jobs are not
 * installed. Being paused is not looked at here: each page asks that first.
 */
export function nightOutlook(s: Snapshot, config: Config): NightOutlook {
  const zone = config.timeZone;
  // The demo's folder holds rehearsal ideas as well (which is what makes the real commands refuse
  // it). Its night is played by the demo itself, so its pages show the night as a real one goes.
  const rehearsalFolder = s.rehearsalIdeas > 0 && !s.demoMark;
  const budget = s.buildCredits;
  const building = offTheClock(s, "build", config);
  const delivering = offTheClock(s, "deliver", config);

  let build: BuildHold | null = null;
  if (rehearsalFolder) {
    build = { why: "rehearsal", step: "Rehearsal folder: no nightly build", line: "is approved. No nightly build runs on a rehearsal folder", note: "Rehearsal folder: the nightly build does not run here. A rehearsal idea is built by hand, with rehearse run." };
  } else if (budget?.reached === true) {
    // The whole sentence is core's (build-budget.ts): the one the builder logs and `build-now` refuses with.
    const note = `Not tonight: ${budgetReachedText(budget, zone)}.`;
    build =
      budget.limit === 0
        ? { why: "credits", step: "Not tonight: the monthly credit limit is 0", line: "is approved. Nothing is built while the monthly credit limit is 0", note }
        : { why: "credits", step: "Not tonight: this month's build credits are used up", line: "is approved. This month's build credits are used up", note };
  } else if (building !== null && !building.late) {
    // Which night the next build is then depends on how the record stands. Status works that out; the page only says not to count on tonight.
    build = {
      why: "clock-ahead",
      step: "On hold: the build clock is dated ahead",
      line: `is approved. The build clock's record is dated ahead (${building.ahead}), so the next build may not be tonight's`,
      note: `On hold: the build clock's record is dated ahead (${building.ahead}), so the next build may not be tonight's. ${SEE_STATUS}`,
    };
  } else if (building !== null) {
    const slot = dateTime(building.slotAt, zone);
    build =
      building.waiting === "offline"
        ? { why: "late", step: "as soon as the Mac is online", line: "will be built as soon as the Mac is online", note: `Running late: the ${slot} build is waiting for the internet.` }
        : { why: "late", step: "Running late", line: "is approved. The build is running late", note: `Running late: the ${slot} build has not started yet.` };
  }

  let checks: ChecksHold | null = null;
  if (rehearsalFolder) {
    // `overnight deliver` refuses a rehearsal folder too. A rehearsal's own run checks its app right after building it.
    checks = { why: "rehearsal", step: null, line: "No morning run happens on a rehearsal folder" };
  } else if (delivering !== null && !delivering.late) {
    checks = { why: "clock-ahead", step: "On hold: the deliver clock is dated ahead", line: `The deliver clock's record is dated ahead (${delivering.ahead}), so the next checks may not be this morning's` };
  } else if (delivering !== null) {
    checks =
      delivering.waiting === "offline"
        ? { why: "late", step: "as soon as the Mac is online", line: "Checks start as soon as the Mac is online" }
        : delivering.waiting !== null
          ? { why: "late", step: "after the build", line: "Checks start after the build" }
          : { why: "late", step: "Running late", line: "The morning's checks are running late" };
  }
  return { build, checks };
}

// ---------- one idea's story ----------

const STEP_LABELS: Readonly<Record<StepKey, string>> = { heard: "Heard", asked: "Asked", approved: "Approved", built: "Built", checked: "Checked", published: "Published", delivered: "Delivered" };

const REHEARSAL = "Rehearsal";
/**
 * Where a rehearsal that was told not to publish says its app is (cli, rehearsal-stand-ins.ts;
 * test/story.test.ts compares the two). Nothing is there: its publisher was a stand-in that
 * pushed nothing and answered "live after 0 ms".
 */
export const STAND_IN_SITE = "https://rehearsal.invalid";
const CUT_OFF = "This build looks cut off. The next nightly build records it and tries once more.";
const CUT_SHORT = "Cut short. It will be built once more at the next nightly build.";
// The same two, where the nightly build will not be the one to do it.
const CUT_OFF_BY_HAND = "This build looks cut off. No nightly build runs on a rehearsal folder: it is built again by hand, with rehearse run.";
const CUT_SHORT_BY_HAND = "Cut short. No nightly build runs on a rehearsal folder: it is built once more by hand, with rehearse run.";
const CUT_SHORT_NO_CREDITS = "Cut short. It will be built once more when the month's build credits allow.";
const NOT_SEEN_YET = "Pushed. The page was not seen yet.";

/** Our own words for the part of the morning's check that an app did not pass (deliver, verifier.ts). */
const CHECK_STEP_WORDS: Readonly<Record<string, string>> = {
  setup: "setting up the sandbox",
  copy: "copying the build",
  install: "installing its packages",
  build: "building the app",
  dist: "looking at the built files",
  contract: "our page checks",
  "app-smoke": "the app's own test",
  unexpected: "an unexpected error",
};

function joined(parts: ReadonlyArray<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

function lastInto(events: readonly IdeaEvent[], state: IdeaState): string | null {
  return events.findLast((event) => event.toState === state)?.at ?? null;
}

/** Has a build that is still marked "building" run past its time limit and its grace, with no build program running? */
function looksCutOff(idea: DashIdea, startedAt: string | null, ctx: { now: Date; running: Running; config: Pick<Config, "buildTimeoutMin"> }): boolean {
  if (ctx.running.build === true) return false;
  // The builder's own rule counts from the latest try, which the idea records (builder, night.ts).
  const since = toMs(idea.buildStartedAt) ?? toMs(startedAt) ?? toMs(idea.updatedAt);
  return since !== null && ctx.now.getTime() - since > (ctx.config.buildTimeoutMin + INTERRUPTED_GRACE_MINUTES) * MINUTE_MS;
}

export function storyOf(
  idea: DashIdea,
  events: readonly IdeaEvent[],
  build: BuildFacts | null,
  deliver: DeliverFacts | null,
  extras: Pick<IdeaExtras, "report" | "marks"> | null,
  ctx: {
    now: Date;
    running: Running;
    paused: boolean;
    nextBuildAt: string;
    nextDeliverAt: string;
    config: Pick<Config, "timeZone" | "buildTimeoutMin">;
    /** What stands in the night's way (nightOutlook). Left out: nothing is known to, and the two runs are taken to start at their times. */
    outlook?: NightOutlook;
  },
): Story {
  const zone = ctx.config.timeZone;
  const report = extras?.report ?? null;
  const hold = ctx.outlook?.build ?? null;
  const checksHold = ctx.outlook?.checks ?? null;

  // ----- which log facts are about the build the idea has now -----
  const buildingAt = lastInto(events, "building");
  const tryStartMs = toMs(buildingAt);
  // The log line is written a moment after the database row; five seconds allow for that.
  const ticks = build !== null && tryStartMs !== null && (toMs(build.startedAt) ?? -Infinity) >= tryStartMs - 5000 ? build : null;
  // The morning's ticks count only from when this build was finished (or, for one that was not, from when it began).
  const builtMs = toMs(idea.builtAt) ?? toMs(lastInto(events, "built"));
  const sinceMs = builtMs !== null && (tryStartMs === null || builtMs >= tryStartMs) ? builtMs : tryStartMs;
  const fresh = <T extends { at: string }>(fact: T | null | undefined): T | null => (fact !== null && fact !== undefined && sinceMs !== null && (toMs(fact.at) ?? -Infinity) >= sinceMs ? fact : null);
  const checkedFact = fresh(deliver?.checked);
  const pushedFact = fresh(deliver?.pushed);
  const liveFact = fresh(deliver?.live);
  const toldFact = fresh(deliver?.told);
  const factFact = fresh(deliver?.fact);

  // ----- the words for finished steps -----
  const builder = backendLabel(idea.buildBackend);
  const builtSeconds = (): number | null => {
    if (ticks?.finished?.ok === true && ticks.finished.seconds !== null) return ticks.finished.seconds;
    const from = tryStartMs;
    const to = toMs(lastInto(events, "built")) ?? toMs(idea.builtAt);
    return from !== null && to !== null && to >= from ? Math.round((to - from) / 1000) : null;
  };
  const builtDetail = (): string | null => {
    const seconds = builtSeconds();
    const credits = ticks?.finished?.ok === true ? ticks.finished.credits : null;
    return joined([builder, seconds === null ? null : duration(seconds * 1000), credits === null ? null : plural(credits, "Kiro credit")]);
  };
  const checkedDetail = (): string | null => {
    if (checkedFact?.ok === true) return joined([checkedFact.ms === null ? null : duration(checkedFact.ms), checkedFact.files === null ? null : plural(checkedFact.files, "file")]);
    if (report === null) return null;
    return joined([report.verifyMs === null ? null : duration(report.verifyMs), report.distFiles === null ? null : plural(report.distFiles, "file")]);
  };
  const liveDetail = (): string | null => {
    if (idea.publishedUrl !== null && idea.publishedUrl.startsWith(`${STAND_IN_SITE}/`)) return "Rehearsal: a stand-in publisher, nothing was pushed";
    if (liveFact !== null) return liveFact.seen ? (liveFact.liveAfterMs === null ? "Live" : `Live after ${duration(liveFact.liveAfterMs)}`) : NOT_SEEN_YET;
    if (report?.confirmedLive === true) return report.liveAfterMs === null ? "Live" : `Live after ${duration(report.liveAfterMs)}`;
    return report?.confirmedLive === false ? NOT_SEEN_YET : null;
  };
  // Where the time of a step still to come would be: when its run starts, or what is in that run's way.
  const buildsAt = ctx.paused ? "Paused: nothing is built" : hold !== null ? hold.step : `at ${clockTime(ctx.nextBuildAt, zone)}`;
  const checksAt = checksHold !== null ? checksHold.step : `at ${clockTime(ctx.nextDeliverAt, zone)}`;

  // ----- the seven steps -----
  const step = (key: StepKey, status: StepStatus, more: { label?: string; at?: string | null; detail?: string | null } = {}): StoryStep => ({
    key,
    label: more.label ?? STEP_LABELS[key],
    status,
    at: more.at ?? null,
    detail: more.detail ?? null,
    // What was said belongs to the first step, whatever state the idea is in.
    said: key === "heard" ? idea.quote : null,
  });
  const heard = step("heard", "done", { at: events.find((event) => event.toState === "heard")?.at ?? idea.createdAt, detail: idea.rehearsal ? "Rehearsal: made by hand, never heard" : null });
  const asked = (): StoryStep => step("asked", "done", { at: lastInto(events, "asked") ?? idea.askedAt, detail: idea.rehearsal ? REHEARSAL : "On the wrist" });
  const approved = (): StoryStep => step("approved", "done", { at: lastInto(events, "approved") ?? idea.answeredAt, detail: idea.rehearsal ? REHEARSAL : "Ticked in Bee" });
  const built = (): StoryStep => step("built", "done", { at: lastInto(events, "built") ?? idea.builtAt, detail: builtDetail() });
  const checked = (): StoryStep => step("checked", "done", { at: checkedFact?.ok === true ? checkedFact.at : null, detail: checkedDetail() });
  const rest = (status: StepStatus, ...keys: StepKey[]): StoryStep[] => keys.map((key) => step(key, status));

  let steps: StoryStep[];
  let runningSince: string | null = null;
  let hint: string | null = null;
  // A rehearsal idea lives in a folder that build-now refuses, so the hint would not work for it. Nor for any other idea in such a folder.
  const tryAgain = idea.rehearsal || hold?.why === "rehearsal" ? null : `To try again, ask Claude Code to run: npx overnight build-now ${idea.id}`;

  switch (idea.state) {
    case "heard":
      steps = [heard, step("asked", "waiting", { detail: idea.note ?? "About to ask" }), ...rest("todo", "approved", "built", "checked", "published", "delivered")];
      break;
    case "asked":
      steps = [heard, asked(), step("approved", "active", { detail: "Waiting for a tick in Bee" }), ...rest("todo", "built", "checked", "published", "delivered")];
      break;
    case "rejected":
    case "expired": {
      const label = idea.state === "rejected" ? "Not approved" : "No answer";
      steps = [heard, asked(), step("approved", "ended", { label, at: lastInto(events, idea.state) ?? idea.answeredAt }), ...rest("ended", "built", "checked", "published", "delivered")];
      break;
    }
    case "approved":
      steps = [heard, asked(), approved(), step("built", "todo", { detail: buildsAt }), ...rest("todo", "checked", "published", "delivered")];
      break;
    case "building": {
      const cutOff = looksCutOff(idea, buildingAt, ctx);
      if (!cutOff) runningSince = buildingAt ?? idea.buildStartedAt;
      const building = cutOff
        ? step("built", "waiting", { label: "Building", at: buildingAt, detail: hold?.why === "rehearsal" ? CUT_OFF_BY_HAND : CUT_OFF })
        : step("built", "active", { label: "Building", at: buildingAt, detail: builder === "" ? null : builder });
      steps = [heard, asked(), approved(), building, step("checked", "todo", { detail: checksAt }), ...rest("todo", "published", "delivered")];
      break;
    }
    case "build_failed": {
      const failedAt = lastInto(events, "build_failed");
      const oneMore = hold?.why === "rehearsal" ? CUT_SHORT_BY_HAND : hold?.why === "credits" ? CUT_SHORT_NO_CREDITS : CUT_SHORT;
      const failed = idea.awaitingRetry ? step("built", "waiting", { label: "Not built yet", at: failedAt, detail: oneMore }) : step("built", "failed", { label: "Could not build", at: failedAt, detail: idea.failureReason });
      if (!idea.awaitingRetry) hint = tryAgain;
      steps = [heard, asked(), approved(), failed, ...rest("todo", "checked", "published", "delivered")];
      break;
    }
    case "built": {
      // "Under way" needs a deliver run that can be seen running. What the log says has happened
      // to this very build (its check passed) is shown either way.
      const delivering = ctx.running.deliver === true;
      const after: StoryStep[] =
        checkedFact?.ok === true
          ? [checked(), delivering ? step("published", "active", { label: "Publishing" }) : step("published", "todo")]
          : [delivering ? step("checked", "active", { label: "Checking" }) : step("checked", "todo", { detail: checksAt }), step("published", "todo")];
      steps = [heard, asked(), approved(), built(), ...after, step("delivered", "todo")];
      break;
    }
    case "publish_failed": {
      const failedAt = lastInto(events, "publish_failed");
      // The report names the part of the check that failed; the log says the same in its own way.
      const inTheCheck = (report !== null && report.failedStep !== null) || checkedFact?.ok === false;
      const after: StoryStep[] = inTheCheck
        ? [step("checked", "failed", { label: "Did not pass the checks", at: failedAt, detail: idea.failureReason }), step("published", "todo")]
        : [checked(), step("published", "failed", { label: "Not published", at: failedAt, detail: idea.failureReason })];
      hint = tryAgain;
      steps = [heard, asked(), approved(), built(), ...after, step("delivered", "todo")];
      break;
    }
    case "published": {
      const publishedStep = step("published", "done", { at: lastInto(events, "published") ?? idea.publishedAt, detail: liveDetail() });
      // The last step follows within seconds of the page going live. Only if it has not, and no
      // deliver run is going, is it left for the next run.
      const publishedMs = toMs(lastInto(events, "published") ?? idea.publishedAt);
      const justPublished = publishedMs !== null && ctx.now.getTime() - publishedMs <= MINUTE_MS;
      // On a rehearsal folder there is no deliver run to come, so none is promised.
      const unfinished = checksHold?.why === "rehearsal" ? "Not finished yet." : "Not finished yet. The next deliver run does that.";
      const last = ctx.running.deliver === true || justPublished ? step("delivered", "active") : step("delivered", "waiting", { detail: unfinished });
      steps = [heard, asked(), approved(), built(), checked(), publishedStep, last];
      break;
    }
    case "delivered": {
      const publishedStep = step("published", "done", { at: lastInto(events, "published") ?? idea.publishedAt, detail: liveDetail() });
      const detail = idea.rehearsal ? "Rehearsal: nothing was sent to the wrist" : joined(["Sent to the wrist", idea.hasFact ? "Bee will remember it" : null]);
      steps = [heard, asked(), approved(), built(), checked(), publishedStep, step("delivered", "done", { at: lastInto(events, "delivered") ?? idea.deliveredAt, detail })];
      break;
    }
  }

  // ----- the night's ticks -----
  const checks: Check[] = [];
  const tick = (key: string, label: string, status: Check["status"], detail: string | null = null, since: string | null = null): void => {
    checks.push({ key, label, status, detail, since });
  };
  const buildingNow = idea.state === "building" && runningSince !== null;

  if (ticks !== null) {
    const signIn = ticks.signIn;
    if (signIn !== null) {
      if (signIn.status === "ready") tick("sign-in", "Kiro sign-in fresh", "done", signIn.minutesLeft === null ? null : `${Math.round(signIn.minutesLeft)} min left`);
      else if (signIn.status === "waiting") tick("sign-in", "Renewing Kiro's sign-in", buildingNow ? "active" : "todo");
      else if (signIn.status === "signed-out") tick("sign-in", "Kiro is signed out", "failed");
      else tick("sign-in", "Kiro sign-in could not be checked", "todo", "building anyway");
    }
    const sandbox = ticks.sandboxCheck;
    if (sandbox !== null) {
      if (sandbox.ok) tick("sandbox", "Sandbox check passed", "done", sandbox.reused ? "passed earlier tonight" : sandbox.ms === null ? null : duration(sandbox.ms));
      else tick("sandbox", "Sandbox check failed", "failed", sandbox.reused ? "failed earlier tonight" : null);
    }
    const agent = ticks.agentStarted;
    const finished = ticks.finished;
    if (agent !== null) {
      const name = backendLabel(agent.backend);
      const secondTry = ticks.fellBack === null ? null : "second builder, after the first could not build it";
      if (finished !== null) tick("agent", finished.ok ? `${name} finished` : `${name} did not finish`, finished.ok ? "done" : "failed", secondTry);
      else if (buildingNow) tick("agent", `${name} is building`, "active", secondTry, agent.at);
      // No line says how it ended (the build was cut off, or the log's end is not there): that it started is all we know.
      else tick("agent", `${name} started`, "done", secondTry);
    }
  }
  // Which files the build has made so far. These come from the build folder, not from the log.
  const marks = extras?.marks ?? null;
  if (idea.state === "building" && marks !== null) {
    tick("mark-started", "Agent started", marks.started ? "done" : "todo");
    tick("mark-project", "Project written", marks.projectWritten ? "done" : "todo");
    tick("mark-packages", "Packages installed", marks.packagesInstalled ? "done" : "todo");
    tick("mark-app", "App built", marks.appBuilt ? "done" : "todo");
    tick("mark-notes", "Notes written", marks.notesWritten ? "done" : "todo");
  }
  if (ticks !== null) {
    const finished = ticks.finished;
    if (finished !== null) {
      if (finished.ok) tick("built", "Built", "done", joined([finished.seconds === null ? null : duration(finished.seconds * 1000), finished.credits === null ? null : plural(finished.credits, "Kiro credit")]));
      else tick("built", "Not built", "failed", finished.seconds === null ? null : `after ${duration(finished.seconds * 1000)}`);
    } else if (idea.state === "building") tick("built", "Built", "todo");
  }
  if (checkedFact !== null) {
    if (checkedFact.ok) tick("checked", "Checked in the sandbox", "done", checkedDetail());
    else {
      // A step we have no words for is not named at all.
      const where = checkedFact.step !== null && Object.hasOwn(CHECK_STEP_WORDS, checkedFact.step) ? CHECK_STEP_WORDS[checkedFact.step] : undefined;
      tick("checked", "Did not pass the checks", "failed", where === undefined ? null : `stopped at: ${where}`);
    }
  }
  if (pushedFact !== null) tick("pushed", "Pushed", "done");
  if (liveFact !== null) {
    if (liveFact.seen) tick("live", liveFact.liveAfterMs === null ? "Live" : `Live after ${duration(liveFact.liveAfterMs)}`, "done");
    else tick("live", "The page was not seen live yet", "todo");
  }
  if (toldFact !== null) {
    if (idea.rehearsal) tick("told", "Rehearsal: nothing sent to the wrist", "done");
    else tick("told", toldFact.what === "built" ? "Sent to the wrist" : "Told the wrist it could not be finished", "done");
  }
  if (factFact !== null) tick("fact", idea.rehearsal ? "Rehearsal: no Bee fact written" : "Bee will remember it", "done");

  return { ideaId: idea.id, steps, checks, runningSince, runningLabel: runningSince === null ? null : "building", hint };
}

// ---------- the idea the Today page leads with ----------

function newest<T>(items: readonly T[], at: (item: T) => string | null): T | null {
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const item of items) {
    const ms = toMs(at(item)) ?? -Infinity;
    if (best === null || ms > bestMs) {
      best = item;
      bestMs = ms;
    }
  }
  return best;
}

/** When an idea was approved: the answer's time, or the timeline's, which always has it. */
function approvedAt(idea: DashIdea, events: readonly IdeaEvent[]): string {
  return idea.answeredAt ?? lastInto(events, "approved") ?? idea.updatedAt;
}

/** A build that is done counts as "on its way" to the morning for this long. One that has sat longer is stuck, and does not lead the page. */
const ON_ITS_WAY_MS = 24 * HOUR_MS;
/** An idea that has just finished, well or badly, keeps leading the page for this long, so the end of its story can be seen. */
const JUST_FINISHED_MS = HOUR_MS;

/**
 * The one idea whose story leads the Today page: the one being built; else one that was built or
 * published in the last 24 hours and is on its way; else one that finished, well or badly, in the
 * last hour; else the approved idea that has waited longest; else the newest ask; else one that
 * finished in the last 24 hours; else the newest idea of all.
 */
export function heroIdea(s: Snapshot): DashIdea | null {
  const inState = (...states: IdeaState[]): DashIdea[] => s.ideas.filter((idea) => states.includes(idea.state));
  const nowMs = toMs(s.at) ?? 0;
  const changedWithin = (ms: number) => (idea: DashIdea): boolean => (toMs(idea.updatedAt) ?? -Infinity) >= nowMs - ms;
  const building = newest(inState("building"), (idea) => idea.buildStartedAt ?? idea.updatedAt);
  if (building !== null) return building;
  const onItsWay = newest(inState("built", "published").filter(changedWithin(ON_ITS_WAY_MS)), (idea) => idea.updatedAt);
  if (onItsWay !== null) return onItsWay;
  const finished = inState("delivered", "build_failed", "publish_failed");
  const justFinished = newest(finished.filter(changedWithin(JUST_FINISHED_MS)), (idea) => idea.updatedAt);
  if (justFinished !== null) return justFinished;
  const approved = inState("approved");
  if (approved.length > 0) {
    // Oldest approval first; of two approved at the same moment, the one heard first.
    return [...approved].sort((a, b) => {
      const byApproval = (toMs(approvedAt(a, s.events.get(a.id) ?? [])) ?? 0) - (toMs(approvedAt(b, s.events.get(b.id) ?? [])) ?? 0);
      return byApproval !== 0 ? byApproval : (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0);
    })[0] ?? null;
  }
  const asked = newest(inState("asked"), (idea) => idea.askedAt ?? idea.updatedAt);
  if (asked !== null) return asked;
  const finishedToday = newest(finished.filter(changedWithin(24 * HOUR_MS)), (idea) => idea.updatedAt);
  if (finishedToday !== null) return finishedToday;
  return newest(s.ideas, (idea) => idea.createdAt);
}

/** Is `minutes` inside the stretch of the day that runs from `from` up to, but not including, `to`? The stretch may pass midnight. */
function inStretch(minutes: number, from: number, to: number): boolean {
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * The one sentence over the hero. The page writes `before`, then the title in quotation marks,
 * then `after`, with a space between the parts that are there.
 * `over`: "Tonight" from ASK_CUTOFF until the morning's checks start, "This morning" from then
 * until local noon, otherwise "Today".
 */
export function nowLine(s: Snapshot, hero: DashIdea | null, config: Config): { over: "Tonight" | "This morning" | "Today"; before: string; title: string | null; after: string } {
  const now = new Date(toMs(s.at) ?? 0);
  const minutes = localMinutes(now, config.timeZone);
  const morningFrom = minutesOf(checksStart(config));
  const over = inStretch(minutes, minutesOf(config.askCutoff), morningFrom) ? "Tonight" : inStretch(minutes, morningFrom, 12 * 60) && morningFrom < 12 * 60 ? "This morning" : "Today";
  const say = (before: string, after: string): { over: typeof over; before: string; title: string | null; after: string } => ({ over, before, title: hero?.title ?? null, after });

  if (hero === null) {
    if (s.problem === "missing" || s.problem === "empty") return say("Nothing saved yet", "");
    // Nothing was ever read (no earlier good look to fall back on): "no ideas" would be a guess.
    if ((s.problem === "busy" || s.problem === "unreadable") && s.staleSince === null) return say("Could not read the database", "");
    return say(s.running.listener === true ? "Listening. No ideas yet" : "No ideas yet", "");
  }
  const outlook = nightOutlook(s, config);
  const checksWords = outlook.checks?.line ?? `Checks start at ${clockOf(checksStart(config))}`;
  switch (hero.state) {
    case "heard":
      return say("Heard", "");
    case "asked":
      return say("Waiting for an answer about", "");
    case "approved":
      return say("", s.paused ? "is approved. Building is paused" : outlook.build !== null ? outlook.build.line : `will be built at ${clockTime(s.nextBuildAt, config.timeZone)}`);
    case "rejected":
      return say("", "was not approved");
    case "expired":
      return say("", "got no answer");
    case "building":
      return say(`${backendLabel(hero.buildBackend) || "Overnight"} is building`, "");
    case "built": {
      if (s.running.deliver !== true) return say("", `is built. ${checksWords}`);
      // The morning's run is on it. Once the log says this very build passed its check, what is left is publishing
      // (the same reading as the story's steps: a check from before this build was finished is an earlier build's).
      const checked = s.deliver.get(hero.id)?.checked ?? null;
      const builtMs = toMs(hero.builtAt);
      const passed = checked !== null && checked.ok && builtMs !== null && (toMs(checked.at) ?? -Infinity) >= builtMs;
      return passed ? say("Publishing", "") : say("Checking", "in the sandbox");
    }
    case "build_failed":
      return say("", hero.awaitingRetry ? "was cut short and will be built once more" : "could not be built");
    case "publish_failed":
      return say("", "was built but not published");
    case "published":
      return say("", "is live");
    case "delivered":
      return say("", "was delivered");
  }
}

// ---------- tonight's queue ----------

/**
 * What the nightly build will take: ideas being built now, then every approved idea and every
 * build that was cut short and is due one more try, the one approved longest ago first (the
 * builder's own order). As many as the nightly limit still allows are "tonight"; the rest wait
 * for another night.
 *
 * The limit counts every build started in one local day, as the builder counts it. Which day:
 *   - While tonight's nightly run is under way, today: the run has room for the limit less what
 *     has already been started.
 *   - Otherwise the day the next nightly build falls on.
 * "Tonight's run is under way" is not simply "some build is going": a build started by hand in
 * the afternoon holds the same lock, and it must not make the list read as if tonight's limit
 * were used up. So a build that is going counts as tonight's run only in the hours after
 * tonight's build time (the same noon-to-noon night), and never when the build log says the run
 * that is open was started by hand.
 *   - A nightly build that is running late will run today, whenever it starts.
 *
 * `hold` says when the nightly build will not take the rows at all, or not at its time.
 */
export function tonightQueue(s: Snapshot, config: Config): TonightQueue {
  const eventsOf = (idea: DashIdea): readonly IdeaEvent[] => s.events.get(idea.id) ?? [];
  // Heard first, so that two ideas approved at the same moment keep the order they were heard in.
  const heardFirst = [...s.ideas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const waiting = heardFirst
    .filter((idea) => idea.state === "approved" || idea.awaitingRetry)
    .map((idea) => ({ idea, at: approvedAt(idea, eventsOf(idea)) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((entry) => entry.idea);

  const now = new Date(toMs(s.at) ?? 0);
  const going = s.running.build === true || s.ideas.some((idea) => idea.state === "building");
  // The latest nightly build time at or before now. It is tonight's if no noon lies between it and now.
  const lastBuildTime = previousLocalTime(now, config.buildTime, config.timeZone).at;
  const afterTonightsBuildTime = nightKey(lastBuildTime, config.timeZone) === nightKey(now, config.timeZone);
  const openRun = s.buildRuns.at(-1);
  const startedByHand = openRun !== undefined && openRun.finishedAt === null && (openRun.command === "build-now" || openRun.command === "rehearse");
  const underWay = going && afterTonightsBuildTime && !startedByHand;
  const hold = s.paused ? null : nightOutlook(s, config).build;
  const countedDay = underWay || hold?.why === "late" ? now : new Date(toMs(s.nextBuildAt) ?? now.getTime());
  const day = localDayBounds(countedDay, config.timeZone);
  let started = 0;
  for (const events of s.events.values()) {
    for (const event of events) {
      const ms = toMs(event.at);
      if (event.toState === "building" && ms !== null && ms >= day.start.getTime() && ms < day.end.getTime()) started += 1;
    }
  }
  const room = Math.max(0, config.maxBuildsPerNight - started);
  return {
    at: s.nextBuildAt,
    paused: s.paused,
    limit: config.maxBuildsPerNight,
    hold,
    rows: [
      ...heardFirst.filter((idea) => idea.state === "building").map((idea) => ({ idea, when: "building" as const })),
      ...waiting.map((idea, index) => ({ idea, when: index < room ? ("tonight" as const) : ("later" as const) })),
    ],
  };
}

// ---------- nights ----------

/** The states an idea passes through at night and in the morning. An event into one of them puts the idea in that night. */
const NIGHT_STATES: ReadonlySet<IdeaState> = new Set<IdeaState>(["building", "built", "build_failed", "published", "publish_failed", "delivered"]);
const MAX_NIGHTS = 14;

type NightRow = Night["ideas"][number];
/** What a night's work on one idea came to, seen from now. */
type Result = "running" | "pending" | "worked" | "retry" | "failed";

function resultOf(row: Pick<NightRow, "idea" | "outcome">): Result {
  const now = row.idea.state;
  switch (row.outcome) {
    case "delivered":
      return "worked";
    case "building":
      // Still marked as building on a night long past: it was cut off, and a later night recorded that.
      return now === "building" ? "running" : row.idea.awaitingRetry ? "retry" : "failed";
    case "built":
    case "published":
      // Where it went after that night, if it has moved on since.
      return now === "delivered" ? "worked" : now === "built" || now === "published" ? "pending" : "failed";
    case "build_failed":
      return now === "build_failed" && row.idea.awaitingRetry ? "retry" : "failed";
    default:
      return "failed";
  }
}

/**
 * A night in one line. `overYet`: false for the night that is still going, or whose morning is today.
 *
 * A build that was cut short and is waiting for its one more try has not failed: it is left out
 * of "N of M worked" and said on its own. (A Mac that sleeps through a build cuts it short, so on
 * real nights this is routine, not a failure.)
 */
function headlineOf(results: readonly Result[], buildRun: BuildRun | null, checksWords: string, overYet: boolean, morningUnderWay: boolean): string {
  if (results.includes("running")) return "Building now.";
  if (results.length === 0) {
    if (buildRun?.paused === true) return "Paused: nothing was built.";
    if (buildRun?.nothingApproved === true) return "Nothing was approved, so nothing was built.";
    return "Nothing was built.";
  }
  // Built and still waiting for the morning. On a night long past, no morning is coming for it by itself.
  // While the morning's run is at work on it, "checks start at 6:30 AM" would be about a time gone by.
  if (results.includes("pending")) return overYet ? "Built, but not delivered." : morningUnderWay ? "Built. The morning's checks are running now." : `Built. ${checksWords}.`;
  const cutShort = results.filter((result) => result === "retry").length;
  const settled = results.length - cutShort;
  if (settled === 0) return "Cut short. It will be built once more.";
  const worked = results.filter((result) => result === "worked").length;
  const verdict = worked === settled ? `Worked: ${plural(worked, "app")} built and delivered.` : worked > 0 ? `${worked} of ${settled} worked.` : "Did not work.";
  return cutShort === 0 ? verdict : `${verdict} ${cutShort} cut short, to be built once more.`;
}

/** "Sat, Oct 10 to Sun, Oct 11" for the night named "2026-10-11". */
function nightLabel(key: string): string {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return `${format.format(new Date(Date.UTC(year, month - 1, day - 1)))} to ${format.format(new Date(Date.UTC(year, month - 1, day)))}`;
}

/** Of a night's runs, the nightly job's if it ran, otherwise the last one started by hand. */
function mainRun<T extends { command: RunCommand }>(runs: readonly T[]): T | null {
  return runs.findLast((run) => run.command === "build") ?? runs.at(-1) ?? null;
}

/**
 * The last 14 nights on which something happened, newest first. An idea belongs to a night when
 * it was building, built, failed, published or delivered in it; what it came to that night is
 * the last of those. A run that touched no idea (paused, or nothing approved) is a night too.
 */
export function groupNights(s: Snapshot, config: Config): Night[] {
  const zone = config.timeZone;
  interface Gathered { rows: Map<string, { idea: DashIdea; outcome: IdeaState; firstMs: number; builtHere: boolean; buildingMs: number | null; endMs: number | null }>; buildRuns: BuildRun[]; deliverRuns: DeliverRun[] }
  const nights = new Map<string, Gathered>();
  const nightOf = (key: string): Gathered => {
    let night = nights.get(key);
    if (night === undefined) {
      night = { rows: new Map(), buildRuns: [], deliverRuns: [] };
      nights.set(key, night);
    }
    return night;
  };

  for (const idea of s.ideas) {
    for (const event of s.events.get(idea.id) ?? []) {
      const ms = toMs(event.at);
      if (ms === null || !NIGHT_STATES.has(event.toState)) continue;
      const rows = nightOf(nightKey(event.at, zone)).rows;
      const row = rows.get(idea.id) ?? { idea, outcome: event.toState, firstMs: ms, builtHere: false, buildingMs: null, endMs: null };
      row.outcome = event.toState;
      if (event.toState === "building") row.buildingMs = ms;
      else if (event.toState === "built" || event.toState === "build_failed") {
        row.endMs = ms;
        if (event.toState === "built") row.builtHere = true;
      }
      rows.set(idea.id, row);
    }
  }
  for (const run of s.buildRuns) if (toMs(run.startedAt) !== null) nightOf(nightKey(run.startedAt, zone)).buildRuns.push(run);
  for (const run of s.deliverRuns) if (toMs(run.startedAt) !== null) nightOf(nightKey(run.startedAt, zone)).deliverRuns.push(run);

  // When the morning's checks start, or what is in their way (the same words as the line over the hero).
  const checksWords = nightOutlook(s, config).checks?.line ?? `Checks start at ${clockOf(checksStart(config))}`;
  const today = localDateKey(new Date(toMs(s.at) ?? 0), zone);
  // The morning's run takes every app that is built. A deliver started by hand (build-now, a rehearsal) takes only its own.
  const openDeliver = s.deliverRuns.at(-1);
  const deliverByHand = openDeliver !== undefined && openDeliver.finishedAt === null && (openDeliver.command === "build-now" || openDeliver.command === "rehearse");
  const morningUnderWay = s.running.deliver === true && !deliverByHand;
  return [...nights.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, MAX_NIGHTS)
    .map(([key, night]): Night => {
      const gathered = [...night.rows.values()].sort((a, b) => a.firstMs - b.firstMs);
      const ideas = gathered.map((row): NightRow => {
        // The log's ticks are about an idea's latest build. They are this night's only if that build began in it.
        const ticks = s.build.get(row.idea.id);
        const mine = ticks !== undefined && toMs(ticks.startedAt) !== null && nightKey(ticks.startedAt, zone) === key ? ticks : null;
        const fromEvents = row.buildingMs !== null && row.endMs !== null && row.endMs >= row.buildingMs ? Math.round((row.endMs - row.buildingMs) / 1000) : null;
        return { idea: row.idea, outcome: row.outcome, buildSeconds: mine?.finished?.seconds ?? fromEvents, credits: mine?.finished?.credits ?? null, by: mine?.by ?? null, cutShort: resultOf(row) === "retry" };
      });
      const results = ideas.map(resultOf);
      const buildRun = mainRun(night.buildRuns);
      const known = ideas.map((row) => row.credits).filter((credits): credits is number => credits !== null);
      return {
        key,
        label: nightLabel(key),
        headline: headlineOf(results, buildRun, checksWords, key < today, morningUnderWay),
        ideas,
        built: gathered.filter((row) => row.builtHere).length,
        failed: results.filter((result) => result === "failed").length,
        cutShort: results.filter((result) => result === "retry").length,
        delivered: results.filter((result) => result === "worked").length,
        // Rounded as the ledger rounds, so adding small numbers leaves no stray digits.
        credits: known.length === 0 ? null : Math.round(known.reduce((sum, credits) => sum + credits, 0) * 1000) / 1000,
        buildRun,
        deliverRun: mainRun(night.deliverRuns),
      };
    });
}

/**
 * The night to mention on the Today page: the one named by today's date. Until the morning's
 * checks start it is still going ("Tonight"); after that it is "Last night".
 */
export function lastNightOf(nights: readonly Night[], now: Date, config: Config): { night: Night; label: "Last night" | "Tonight" } | null {
  const night = nights.find((candidate) => candidate.key === localDateKey(now, config.timeZone));
  if (night === undefined) return null;
  return { night, label: localMinutes(now, config.timeZone) < minutesOf(checksStart(config)) ? "Tonight" : "Last night" };
}

// ---------- how often the page asks again ----------

/**
 * Every 2 seconds while something is happening (a build, a deliver run, or one of them about to
 * start within the minute), every 5 seconds otherwise.
 */
export function pollMsFor(s: Snapshot, now: Date): 2000 | 5000 {
  if (s.running.build === true || s.running.deliver === true) return 2000;
  if (s.ideas.some((idea) => idea.state === "building")) return 2000;
  const soon = (at: string): boolean => {
    const ms = toMs(at);
    return ms !== null && ms - now.getTime() >= 0 && ms - now.getTime() <= MINUTE_MS;
  };
  return soon(s.nextBuildAt) || soon(s.nextDeliverAt) ? 2000 : 5000;
}
