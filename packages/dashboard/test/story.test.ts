// SYNTHETIC: every title, pitch, quote, time and number in this file is made up. None of it is Bee data.
//
// The story of an idea, of a night and of the moment, worked out from hand-made looks.
// The invented scene: America/Boise, the night of Oct 10 to Oct 11, 2026 (six hours behind UTC).
import { STAND_IN_SITE as CLI_STAND_IN_SITE } from "@overnight/cli";
import { BUILD_STOPPED_REASON, buildBudget, closedRun, currentSlot, noticedRun, parseConfig, startedRun, waitingRun } from "@overnight/core";
import type { BuildBudget, ClockedJob, Config, IdeaEvent, IdeaState, NightRun, NightWait } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { groupNights, heroIdea, lastNightOf, nightKey, nightOutlook, nowLine, overnightDayStart, pollMsFor, STAND_IN_SITE, storyOf, tonightQueue } from "../src/story.ts";
import type { BuildFacts, BuildRun, DashIdea, DeliverFacts, DeliverRun, IdeaExtras, NightOutlook, NightRecords, ReportView, Running, Snapshot, Story, WorkspaceMarks } from "../src/types.ts";

const CONFIG: Config = parseConfig({ OVERNIGHT_DATA_DIR: "/invented/data", TZ: "America/Boise", PAUSED: "false" });
const ZONE = CONFIG.timeZone;
const IDLE: Running = { listener: true, build: false, deliver: false };

/** A UTC time on Oct 10 or Oct 11, 2026, written as the clock in Boise shows it: local("10 12:41") is 12:41 PM on Oct 10. */
function local(dayAndTime: string, seconds = 0): string {
  const [day = "10", time = "00:00"] = dayAndTime.split(" ");
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(Date.UTC(2026, 9, Number(day), Number(hour) + 6, Number(minute), seconds)).toISOString();
}

const T = {
  heard: local("10 12:41"),
  asked: local("10 12:44"),
  approved: local("10 12:46"),
  building: local("11 01:00"),
  built: local("11 01:02", 40),
  failed: local("11 01:45"),
  checked: local("11 06:30", 7),
  published: local("11 06:31"),
  delivered: local("11 06:31", 5),
};

/** The states an idea passes through on its way to `state`, with the time of each step. */
const WAY_TO: Record<IdeaState, Array<[IdeaState, string]>> = {
  heard: [["heard", T.heard]],
  asked: [["heard", T.heard], ["asked", T.asked]],
  approved: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved]],
  rejected: [["heard", T.heard], ["asked", T.asked], ["rejected", T.approved]],
  expired: [["heard", T.heard], ["asked", T.asked], ["expired", local("10 23:00")]],
  building: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building]],
  built: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building], ["built", T.built]],
  build_failed: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building], ["build_failed", T.failed]],
  publish_failed: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building], ["built", T.built], ["publish_failed", T.published]],
  published: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building], ["built", T.built], ["published", T.published]],
  delivered: [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", T.building], ["built", T.built], ["published", T.published], ["delivered", T.delivered]],
};

let eventId = 0;
function eventsTo(ideaId: string, way: Array<[IdeaState, string]>): IdeaEvent[] {
  return way.map(([toState, at], index) => ({ id: (eventId += 1), ideaId, at, fromState: index === 0 ? null : (way[index - 1]?.[0] ?? null), toState, note: null }));
}

let ideaNumber = 0;
/** An invented idea in `state`, with the timeline that leads there. */
function scene(state: IdeaState, more: Partial<DashIdea> = {}, way: Array<[IdeaState, string]> = WAY_TO[state]): { idea: DashIdea; events: IdeaEvent[] } {
  ideaNumber += 1;
  const id = more.id ?? `idea_20261010_${String(ideaNumber).padStart(8, "0")}`;
  const at = (to: IdeaState): string | null => way.findLast(([name]) => name === to)?.[1] ?? null;
  const reached = (to: IdeaState): boolean => way.some(([name]) => name === to);
  const idea: DashIdea = {
    id,
    state,
    title: "Chore Wheel",
    pitch: "Spin a wheel to share out the week's chores.",
    quote: { shown: true, text: "an invented line about a wheel that picks who does the dishes" },
    hidden: false,
    confidence: 0.86,
    createdAt: T.heard,
    updatedAt: way.at(-1)?.[1] ?? T.heard,
    askedAt: at("asked"),
    askExpiresAt: reached("asked") ? local("10 23:00") : null,
    answeredAt: at("approved") ?? at("rejected"),
    note: null,
    slug: reached("building") ? "chore-wheel" : null,
    buildBackend: reached("building") ? "kiro-crew" : null,
    buildStartedAt: at("building"),
    builtAt: state === "build_failed" || state === "building" ? null : at("built"),
    publishedUrl: reached("published") ? "https://example.invalid/overnight-apps/chore-wheel/" : null,
    publishedAt: at("published"),
    deliveredAt: at("delivered"),
    failureReason: state === "build_failed" ? "Kiro Crew: the build ran past its time limit of 45 minutes" : state === "publish_failed" ? "The page did not pass Overnight's checks: it is wider than a phone." : null,
    failureNotifiedAt: null,
    rehearsal: false,
    buildStarts: way.filter(([name]) => name === "building").length,
    awaitingRetry: false,
    hasMorningTodo: reached("delivered"),
    hasFact: false,
    ...more,
  };
  return { idea, events: eventsTo(id, way) };
}

const BUILD_TICKS: BuildFacts = {
  startedAt: local("11 01:00", 1),
  by: "build",
  signIn: { at: local("11 01:00", 2), status: "ready", minutesLeft: 47 },
  sandboxCheck: { at: local("11 01:00", 9), ok: true, ms: 7100, reused: false },
  agentStarted: { at: local("11 01:00", 10), backend: "kiro-crew" },
  fellBack: null,
  finished: null,
  slept: null,
  sealed: null,
};
const BUILT_TICKS: BuildFacts = { ...BUILD_TICKS, finished: { at: T.built, ok: true, seconds: 160, credits: 4.59 } };
const DELIVER_TICKS: DeliverFacts = {
  firstAt: T.checked,
  checked: { at: T.checked, ok: true, ms: 6600, files: 3, bytes: 5602, step: null },
  pushed: { at: local("11 06:30", 20) },
  live: { at: local("11 06:30", 46), seen: true, liveAfterMs: 26000 },
  told: { at: T.delivered, what: "built" },
  fact: { at: local("11 06:31", 6) },
};
const REPORT: ReportView = { confirmedLive: true, failedStep: null, verifyMs: 6700, publishMs: 31000, liveAfterMs: 26000, distFiles: 3, distBytes: 5602, checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true } };

interface Told { now?: string; running?: Partial<Running>; paused?: boolean; build?: BuildFacts | null; deliver?: DeliverFacts | null; report?: ReportView | null; marks?: WorkspaceMarks | null; buildTimeoutMin?: number; outlook?: NightOutlook }

function tell(given: { idea: DashIdea; events: IdeaEvent[] }, told: Told = {}): Story {
  const extras: Pick<IdeaExtras, "report" | "marks"> | null = told.report === undefined && told.marks === undefined ? null : { report: told.report ?? null, marks: told.marks ?? null };
  return storyOf(given.idea, given.events, told.build ?? null, told.deliver ?? null, extras, {
    now: new Date(told.now ?? local("11 01:02")),
    running: { ...IDLE, ...told.running },
    paused: told.paused ?? false,
    nextBuildAt: local("11 01:00"),
    nextDeliverAt: local("11 06:30"),
    config: { timeZone: ZONE, buildTimeoutMin: told.buildTimeoutMin ?? 45 },
    ...(told.outlook === undefined ? {} : { outlook: told.outlook }),
  });
}

const statuses = (story: Story): string => story.steps.map((step) => step.status).join(" ");
const stepOf = (story: Story, key: string) => story.steps.find((step) => step.key === key);
const checkOf = (story: Story, key: string) => story.checks.find((check) => check.key === key);

describe("the seven steps", () => {
  it("are always the same seven, in the same order", () => {
    for (const state of Object.keys(WAY_TO) as IdeaState[]) {
      const story = tell(scene(state));
      expect(story.steps.map((step) => step.key)).toEqual(["heard", "asked", "approved", "built", "checked", "published", "delivered"]);
      expect(story.ideaId).toMatch(/^idea_20261010_/);
    }
  });

  it("heard: the quote belongs to the first step, and the idea is about to be asked", () => {
    const given = scene("heard");
    const story = tell(given, { now: local("10 12:42") });
    expect(statuses(story)).toBe("done waiting todo todo todo todo todo");
    expect(stepOf(story, "heard")).toEqual({ key: "heard", label: "Heard", status: "done", at: T.heard, detail: null, said: given.idea.quote });
    // Every state starts with the same first step.
    for (const state of Object.keys(WAY_TO) as IdeaState[]) expect(stepOf(tell(scene(state)), "heard")).toMatchObject({ status: "done", at: T.heard, detail: null });
    expect(stepOf(story, "asked")).toMatchObject({ label: "Asked", at: null, detail: "About to ask", said: null });
    expect(story.steps.filter((step) => step.said !== null).map((step) => step.key)).toEqual(["heard"]);
    expect([story.checks, story.runningSince, story.runningLabel, story.hint]).toEqual([[], null, null, null]);
  });

  it("heard: says why the idea has not been asked, when the idea knows", () => {
    const story = tell(scene("heard", { note: "over today's ask limit" }));
    expect(stepOf(story, "asked")).toMatchObject({ status: "waiting", detail: "over today's ask limit" });
  });

  it("heard: a quote hidden for filming stays hidden", () => {
    const story = tell(scene("heard", { quote: { shown: false, why: "filming" } }));
    expect(stepOf(story, "heard")?.said).toEqual({ shown: false, why: "filming" });
  });

  it("asked: waiting for a tick in Bee", () => {
    const story = tell(scene("asked"), { now: local("10 12:45") });
    expect(statuses(story)).toBe("done done active todo todo todo todo");
    expect(stepOf(story, "asked")).toMatchObject({ at: T.asked, detail: "On the wrist" });
    expect(stepOf(story, "approved")).toMatchObject({ label: "Approved", at: null, detail: "Waiting for a tick in Bee" });
  });

  it("approved: will be built at the next build time", () => {
    const story = tell(scene("approved"), { now: local("10 15:00") });
    expect(statuses(story)).toBe("done done done todo todo todo todo");
    expect(stepOf(story, "approved")).toMatchObject({ at: T.approved, detail: "Ticked in Bee" });
    expect(stepOf(story, "built")).toMatchObject({ label: "Built", at: null, detail: "at 1:00 AM" });
    expect(story.hint).toBeNull();
  });

  it("approved while paused: says that nothing is built", () => {
    expect(stepOf(tell(scene("approved"), { paused: true }), "built")).toMatchObject({ status: "todo", detail: "Paused: nothing is built" });
  });

  it("rejected and expired: the story ends at the answer", () => {
    const rejected = tell(scene("rejected"));
    expect(statuses(rejected)).toBe("done done ended ended ended ended ended");
    expect(stepOf(rejected, "approved")).toMatchObject({ label: "Not approved", at: T.approved, detail: null });
    const expired = tell(scene("expired"));
    expect(statuses(expired)).toBe("done done ended ended ended ended ended");
    expect(stepOf(expired, "approved")).toMatchObject({ label: "No answer", at: local("10 23:00") });
    expect([rejected.hint, expired.hint]).toEqual([null, null]);
  });

  it("building: the builder's name and a clock that runs from when the build began", () => {
    const story = tell(scene("building"), { running: { build: true } });
    expect(statuses(story)).toBe("done done done active todo todo todo");
    expect(stepOf(story, "built")).toEqual({ key: "built", label: "Building", status: "active", at: T.building, detail: "Kiro Crew", said: null });
    expect(stepOf(story, "checked")).toMatchObject({ detail: "at 6:30 AM" });
    expect([story.runningSince, story.runningLabel]).toEqual([T.building, "building"]);
  });

  it("built: who built it and how long it took, from the timeline when there is no log", () => {
    const story = tell(scene("built"));
    expect(statuses(story)).toBe("done done done done todo todo todo");
    expect(stepOf(story, "built")).toMatchObject({ label: "Built", at: T.built, detail: "Kiro Crew · 2 min 40 s" });
    expect(stepOf(story, "checked")).toMatchObject({ detail: "at 6:30 AM" });
    expect([story.runningSince, story.runningLabel, story.hint]).toEqual([null, null, null]);
  });

  it("built: adds the credits when the log has them", () => {
    const story = tell(scene("built"), { build: { ...BUILT_TICKS, finished: { at: T.built, ok: true, seconds: 139, credits: 3.09 } } });
    expect(stepOf(story, "built")?.detail).toBe("Kiro Crew · 2 min 19 s · 3.09 Kiro credits");
  });

  it("build_failed: the reason, and how to try again", () => {
    const given = scene("build_failed");
    const story = tell(given, { now: local("11 08:00") });
    expect(statuses(story)).toBe("done done done failed todo todo todo");
    expect(stepOf(story, "built")).toMatchObject({ label: "Could not build", at: T.failed, detail: "Kiro Crew: the build ran past its time limit of 45 minutes" });
    expect(story.hint).toBe(`To try again, ask Claude Code to run: npx overnight build-now ${given.idea.id}`);
  });

  it("build_failed but due one more try: waiting, with no hint to run anything", () => {
    const story = tell(scene("build_failed", { failureReason: BUILD_STOPPED_REASON, awaitingRetry: true }));
    expect(statuses(story)).toBe("done done done waiting todo todo todo");
    expect(stepOf(story, "built")).toMatchObject({ label: "Not built yet", detail: "Cut short. It will be built once more at the next nightly build." });
    expect(story.hint).toBeNull();
  });

  it("publish_failed in the check: the check failed, with the reason and the hint", () => {
    const given = scene("publish_failed");
    const story = tell(given, { now: local("11 08:00"), report: { ...REPORT, confirmedLive: null, failedStep: "contract", liveAfterMs: null } });
    expect(statuses(story)).toBe("done done done done failed todo todo");
    expect(stepOf(story, "checked")).toMatchObject({ label: "Did not pass the checks", at: T.published, detail: "The page did not pass Overnight's checks: it is wider than a phone." });
    expect(story.hint).toBe(`To try again, ask Claude Code to run: npx overnight build-now ${given.idea.id}`);
  });

  it("publish_failed in the check, known from the log alone", () => {
    const story = tell(scene("publish_failed"), { deliver: { firstAt: T.checked, checked: { at: T.checked, ok: false, ms: 4100, files: null, bytes: null, step: "contract" }, pushed: null, live: null, told: null, fact: null } });
    expect(statuses(story)).toBe("done done done done failed todo todo");
    expect(checkOf(story, "checked")).toEqual({ key: "checked", label: "Did not pass the checks", status: "failed", detail: "stopped at: our page checks", since: null });
  });

  it("names the part of the check that failed in words of its own, or not at all", () => {
    const stoppedAt = (step: string | null): string | null | undefined =>
      checkOf(tell(scene("publish_failed"), { deliver: { firstAt: T.checked, checked: { at: T.checked, ok: false, ms: 4100, files: null, bytes: null, step }, pushed: null, live: null, told: null, fact: null } }), "checked")?.detail;
    expect(["setup", "copy", "install", "build", "dist", "contract", "app-smoke", "unexpected"].map(stoppedAt)).toEqual([
      "stopped at: setting up the sandbox",
      "stopped at: copying the build",
      "stopped at: installing its packages",
      "stopped at: building the app",
      "stopped at: looking at the built files",
      "stopped at: our page checks",
      "stopped at: the app's own test",
      "stopped at: an unexpected error",
    ]);
    // A step from a later version, a missing one, and words every object has by birth.
    expect(["a-later-step", null, "constructor", "valueof", "toString"].map(stoppedAt)).toEqual([null, null, null, null, null]);
  });

  it("publish_failed after a passed check: publishing failed", () => {
    const story = tell(scene("publish_failed", { failureReason: "GitHub refused the push." }), { report: { ...REPORT, confirmedLive: null, liveAfterMs: null } });
    expect(statuses(story)).toBe("done done done done done failed todo");
    expect(stepOf(story, "checked")).toMatchObject({ label: "Checked", detail: "6.7 s · 3 files" });
    expect(stepOf(story, "published")).toMatchObject({ label: "Not published", at: T.published, detail: "GitHub refused the push." });
    expect(story.hint).not.toBeNull();
  });

  it("publish_failed with nothing to say where: publishing failed", () => {
    expect(statuses(tell(scene("publish_failed")))).toBe("done done done done done failed todo");
  });

  it("published: live, and the last step under way while the deliver run goes on", () => {
    const story = tell(scene("published"), { now: local("11 06:31", 2), running: { deliver: true }, deliver: { ...DELIVER_TICKS, told: null, fact: null } });
    expect(statuses(story)).toBe("done done done done done done active");
    expect(stepOf(story, "checked")).toMatchObject({ at: T.checked, detail: "6.6 s · 3 files" });
    expect(stepOf(story, "published")).toMatchObject({ at: T.published, detail: "Live after 26 s" });
    expect(stepOf(story, "delivered")).toMatchObject({ label: "Delivered", detail: null });
    // A slow morning: published ten minutes ago, and the deliver run is still going.
    expect(statuses(tell(scene("published"), { now: local("11 06:41"), running: { deliver: true } }))).toBe("done done done done done done active");
  });

  it("published with no deliver run going: the last step waits for the next run", () => {
    const story = tell(scene("published"), { now: local("11 09:00") });
    expect(statuses(story)).toBe("done done done done done done waiting");
    expect(stepOf(story, "delivered")?.detail).toBe("Not finished yet. The next deliver run does that.");
  });

  it("published a moment ago: the last step is under way even when no deliver run can be seen", () => {
    // Published at 6:31:00. Telling the wrist follows within seconds.
    const at = (seconds: number): Story => tell(scene("published"), { now: local("11 06:31", seconds), running: { deliver: false } });
    expect(statuses(at(2))).toBe("done done done done done done active");
    expect(statuses(at(60))).toBe("done done done done done done active");
    expect(statuses(at(61))).toBe("done done done done done done waiting");
    expect(stepOf(tell(scene("published"), { now: local("11 06:31", 30), running: { deliver: null } }), "delivered")).toMatchObject({ status: "active", detail: null });
  });

  it("published but not seen live: says so, from the log or from the report", () => {
    const notSeen = "Pushed. The page was not seen yet.";
    const fromLog = tell(scene("published"), { deliver: { ...DELIVER_TICKS, live: { at: local("11 06:35"), seen: false, liveAfterMs: null }, told: null, fact: null } });
    expect(stepOf(fromLog, "published")).toMatchObject({ status: "done", detail: notSeen });
    expect(checkOf(fromLog, "live")).toMatchObject({ label: "The page was not seen live yet", status: "todo" });
    const fromReport = tell(scene("published"), { report: { ...REPORT, confirmedLive: false, liveAfterMs: null } });
    expect(stepOf(fromReport, "published")).toMatchObject({ status: "done", detail: notSeen });
  });

  it("delivered: all seven done, sent to the wrist", () => {
    const story = tell(scene("delivered"), { now: local("11 08:00"), build: BUILT_TICKS, deliver: DELIVER_TICKS, report: REPORT });
    expect(statuses(story)).toBe("done done done done done done done");
    expect(story.steps.map((step) => step.at)).toEqual([T.heard, T.asked, T.approved, T.built, T.checked, T.published, T.delivered]);
    expect(stepOf(story, "delivered")).toMatchObject({ label: "Delivered", detail: "Sent to the wrist" });
    expect(story.hint).toBeNull();
  });

  it("delivered with a Bee fact: Bee will remember it", () => {
    expect(stepOf(tell(scene("delivered", { hasFact: true })), "delivered")?.detail).toBe("Sent to the wrist · Bee will remember it");
  });

  it("with no log and no report at all, the seven steps still stand and there are no ticks", () => {
    for (const state of Object.keys(WAY_TO) as IdeaState[]) {
      const story = tell(scene(state));
      expect(story.steps).toHaveLength(7);
      expect(story.checks).toEqual([]);
    }
    const delivered = tell(scene("delivered"));
    expect(statuses(delivered)).toBe("done done done done done done done");
    expect(stepOf(delivered, "built")?.detail).toBe("Kiro Crew · 2 min 40 s");
    expect([stepOf(delivered, "checked")?.detail, stepOf(delivered, "published")?.detail]).toEqual([null, null]);
  });

  it("from the report alone: how the check went and whether the page was seen", () => {
    const story = tell(scene("delivered"), { report: REPORT });
    expect([stepOf(story, "checked")?.detail, stepOf(story, "published")?.detail]).toEqual(["6.7 s · 3 files", "Live after 26 s"]);
    expect(story.checks).toEqual([]);
  });

  it("a rehearsal idea never claims the wrist was asked or buzzed", () => {
    const given = scene("delivered", { rehearsal: true, hasFact: true, quote: { shown: false, why: "none" } });
    const story = tell(given, { deliver: DELIVER_TICKS });
    expect([stepOf(story, "heard")?.detail, stepOf(story, "asked")?.detail, stepOf(story, "approved")?.detail]).toEqual(["Rehearsal: made by hand, never heard", "Rehearsal", "Rehearsal"]);
    expect(stepOf(story, "delivered")?.detail).toBe("Rehearsal: nothing was sent to the wrist");
    expect([checkOf(story, "told")?.label, checkOf(story, "fact")?.label]).toEqual(["Rehearsal: nothing sent to the wrist", "Rehearsal: no Bee fact written"]);
    expect(JSON.stringify(story)).not.toMatch(/Sent to the wrist|On the wrist|Ticked in Bee|Bee will remember/);
    // And build-now refuses a folder with a rehearsal idea in it, so it is not offered.
    expect(tell(scene("build_failed", { rehearsal: true })).hint).toBeNull();
    expect(tell(scene("publish_failed", { rehearsal: true })).hint).toBeNull();
  });
});

describe("a rehearsal that was told not to publish", () => {
  // Its publisher was a stand-in: it pushed nothing, and answered with this address and "live after 0 ms".
  const standIn = { publishedUrl: `${STAND_IN_SITE}/practice-dice-roller/`, rehearsal: true };
  const itsReport: ReportView = { ...REPORT, publishMs: 0, liveAfterMs: 0 };

  it("is never said to be live", () => {
    for (const state of ["published", "delivered"] as const) {
      const story = tell(scene(state, standIn), { report: itsReport });
      expect(stepOf(story, "published")).toMatchObject({ status: "done", detail: "Rehearsal: a stand-in publisher, nothing was pushed" });
      expect(JSON.stringify(story)).not.toMatch(/Live/);
    }
  });

  it("is told apart by the address the cli's stand-in gives, and by nothing looser", () => {
    expect(STAND_IN_SITE).toBe(CLI_STAND_IN_SITE);
    // The demo's invented links end in example.invalid and are shown as live.
    const demo = tell(scene("delivered", { publishedUrl: "https://example.invalid/overnight-apps/packing-checklist/" }), { report: REPORT });
    expect(stepOf(demo, "published")?.detail).toBe("Live after 26 s");
    const lookAlike = tell(scene("delivered", { publishedUrl: "https://rehearsal.invalid.example.org/x/" }), { report: REPORT });
    expect(stepOf(lookAlike, "published")?.detail).toBe("Live after 26 s");
  });

  it("is said to be live when the rehearsal did publish", () => {
    const real = tell(scene("delivered", { rehearsal: true, publishedUrl: "https://example.invalid/overnight-apps/practice-dice-roller/" }), { report: { ...REPORT, liveAfterMs: 21148 } });
    expect(stepOf(real, "published")?.detail).toBe("Live after 21 s");
  });
});

describe("a build that looks cut off", () => {
  const given = (): { idea: DashIdea; events: IdeaEvent[] } => scene("building");
  // Started at 1:00 AM with a 45 minute limit: the builder itself calls it cut off after 2:00 AM.

  it("is still 'building' for as long as the time limit and its 15 minutes of grace allow", () => {
    const story = tell(given(), { now: local("11 02:00"), running: { build: false } });
    expect(stepOf(story, "built")).toMatchObject({ status: "active", label: "Building" });
    expect(story.runningSince).toBe(T.building);
  });

  it("is 'waiting' after that when no build program is running, and its clock stops", () => {
    const story = tell(given(), { now: local("11 02:00", 1), running: { build: false }, build: BUILD_TICKS });
    expect(statuses(story)).toBe("done done done waiting todo todo todo");
    expect(stepOf(story, "built")).toMatchObject({ label: "Building", at: T.building, detail: "This build looks cut off. The next nightly build records it and tries once more." });
    expect([story.runningSince, story.runningLabel]).toEqual([null, null]);
    // No tick claims that anything is still going.
    expect(story.checks.filter((check) => check.status === "active" || check.since !== null)).toEqual([]);
    expect(checkOf(story, "agent")).toMatchObject({ label: "Kiro Crew started", status: "done" });
  });

  it("is the same when nobody can tell whether a build program is running", () => {
    expect(stepOf(tell(given(), { now: local("11 03:00"), running: { build: null } }), "built")?.status).toBe("waiting");
  });

  it("is never called cut off while a build program is running", () => {
    const story = tell(given(), { now: local("11 05:00"), running: { build: true } });
    expect(stepOf(story, "built")?.status).toBe("active");
    expect(story.runningSince).toBe(T.building);
  });

  it("goes by the build time limit in the settings", () => {
    expect(stepOf(tell(given(), { now: local("11 01:30"), buildTimeoutMin: 10 }), "built")?.status).toBe("waiting");
    expect(stepOf(tell(given(), { now: local("11 01:30"), buildTimeoutMin: 20 }), "built")?.status).toBe("active");
  });

  it("counts from the second builder's start after a fallback, as the builder does", () => {
    const fellBack = scene("building", { buildStartedAt: local("11 01:40"), buildBackend: "kiro-cli" });
    expect(stepOf(tell(fellBack, { now: local("11 02:30") }), "built")).toMatchObject({ status: "active", detail: "Kiro CLI" });
    expect(stepOf(tell(fellBack, { now: local("11 02:41") }), "built")?.status).toBe("waiting");
  });
});

describe("built, while the morning's deliver run goes on", () => {
  it("before the check has passed: checking", () => {
    const story = tell(scene("built"), { now: local("11 06:30", 3), running: { deliver: true }, build: BUILT_TICKS });
    expect(statuses(story)).toBe("done done done done active todo todo");
    expect(stepOf(story, "checked")).toMatchObject({ label: "Checking", detail: null });
    expect(checkOf(story, "checked")).toBeUndefined();
  });

  it("after 'verified': checked, and publishing", () => {
    const story = tell(scene("built"), { now: local("11 06:30", 10), running: { deliver: true }, build: BUILT_TICKS, deliver: { ...DELIVER_TICKS, pushed: null, live: null, told: null, fact: null } });
    expect(statuses(story)).toBe("done done done done done active todo");
    expect(stepOf(story, "checked")).toMatchObject({ label: "Checked", at: T.checked, detail: "6.6 s · 3 files" });
    expect(stepOf(story, "published")).toMatchObject({ label: "Publishing" });
    expect(checkOf(story, "checked")).toEqual({ key: "checked", label: "Checked in the sandbox", status: "done", detail: "6.6 s · 3 files", since: null });
  });

  it("is not taken to be going on when nobody can tell", () => {
    const story = tell(scene("built"), { now: local("11 06:30", 3), running: { deliver: null }, build: BUILT_TICKS });
    expect(statuses(story)).toBe("done done done done todo todo todo");
    expect(stepOf(story, "checked")?.detail).toBe("at 6:30 AM");
    const published = tell(scene("published"), { now: local("11 09:00"), running: { deliver: null } });
    expect(statuses(published)).toBe("done done done done done done waiting");
  });

  it("with no deliver run to be seen, a check that passed is still shown, and nothing is said to be under way", () => {
    // The invented night of the demo holds no locks; and a real run can be cut off between the check and the push.
    const story = tell(scene("built"), { now: local("11 06:40"), running: { deliver: false }, deliver: { ...DELIVER_TICKS, pushed: null, live: null, told: null, fact: null } });
    expect(statuses(story)).toBe("done done done done done todo todo");
    expect(stepOf(story, "checked")).toMatchObject({ label: "Checked", at: T.checked, detail: "6.6 s · 3 files" });
    expect(stepOf(story, "published")).toMatchObject({ label: "Published", detail: null });
  });
});

describe("the night's ticks", () => {
  it("while building: sign-in fresh, sandbox passed, the builder at work with a running clock, built to come", () => {
    const story = tell(scene("building"), { running: { build: true }, build: BUILD_TICKS });
    expect(story.checks).toEqual([
      { key: "sign-in", label: "Kiro sign-in fresh", status: "done", detail: "47 min left", since: null },
      { key: "sandbox", label: "Sandbox check passed", status: "done", detail: "7.1 s", since: null },
      { key: "agent", label: "Kiro Crew is building", status: "active", detail: null, since: local("11 01:00", 10) },
      { key: "built", label: "Built", status: "todo", detail: null, since: null },
    ]);
  });

  it("appear one by one as the log grows", () => {
    const building = scene("building");
    const keys = (build: BuildFacts): string[] => tell(building, { running: { build: true }, build }).checks.map((check) => `${check.key}:${check.status}`);
    expect(keys({ ...BUILD_TICKS, signIn: null, sandboxCheck: null, agentStarted: null })).toEqual(["built:todo"]);
    expect(keys({ ...BUILD_TICKS, sandboxCheck: null, agentStarted: null })).toEqual(["sign-in:done", "built:todo"]);
    expect(keys({ ...BUILD_TICKS, agentStarted: null })).toEqual(["sign-in:done", "sandbox:done", "built:todo"]);
  });

  it("show the five marks of a build in progress, between the builder and 'Built'", () => {
    const marks: WorkspaceMarks = { started: true, projectWritten: true, packagesInstalled: false, appBuilt: false, notesWritten: false };
    const story = tell(scene("building"), { running: { build: true }, build: BUILD_TICKS, marks });
    expect(story.checks.map((check) => [check.key, check.label, check.status])).toEqual([
      ["sign-in", "Kiro sign-in fresh", "done"],
      ["sandbox", "Sandbox check passed", "done"],
      ["agent", "Kiro Crew is building", "active"],
      ["mark-started", "Agent started", "done"],
      ["mark-project", "Project written", "done"],
      ["mark-packages", "Packages installed", "todo"],
      ["mark-app", "App built", "todo"],
      ["mark-notes", "Notes written", "todo"],
      ["built", "Built", "todo"],
    ]);
    const all: WorkspaceMarks = { started: true, projectWritten: true, packagesInstalled: true, appBuilt: true, notesWritten: true };
    expect(tell(scene("building"), { running: { build: true }, build: BUILD_TICKS, marks: all }).checks.filter((check) => check.key.startsWith("mark-")).map((check) => check.status)).toEqual(["done", "done", "done", "done", "done"]);
    // The marks are about a build in progress only.
    expect(tell(scene("built"), { build: BUILT_TICKS, marks: all }).checks.some((check) => check.key.startsWith("mark-"))).toBe(false);
  });

  it("for a delivered idea: every tick of the night and the morning, in order", () => {
    const story = tell(scene("delivered", { hasFact: true }), { now: local("11 08:00"), build: BUILT_TICKS, deliver: DELIVER_TICKS, report: REPORT });
    expect(story.checks).toEqual([
      { key: "sign-in", label: "Kiro sign-in fresh", status: "done", detail: "47 min left", since: null },
      { key: "sandbox", label: "Sandbox check passed", status: "done", detail: "7.1 s", since: null },
      { key: "agent", label: "Kiro Crew finished", status: "done", detail: null, since: null },
      { key: "built", label: "Built", status: "done", detail: "2 min 40 s · 4.59 Kiro credits", since: null },
      { key: "checked", label: "Checked in the sandbox", status: "done", detail: "6.6 s · 3 files", since: null },
      { key: "pushed", label: "Pushed", status: "done", detail: null, since: null },
      { key: "live", label: "Live after 26 s", status: "done", detail: null, since: null },
      { key: "told", label: "Sent to the wrist", status: "done", detail: null, since: null },
      { key: "fact", label: "Bee will remember it", status: "done", detail: null, since: null },
    ]);
  });

  it("say when the sandbox check was the one made earlier in the same run", () => {
    const story = tell(scene("building"), { running: { build: true }, build: { ...BUILD_TICKS, sandboxCheck: { at: local("11 01:00", 9), ok: true, ms: 7100, reused: true } } });
    expect(checkOf(story, "sandbox")).toMatchObject({ label: "Sandbox check passed", detail: "passed earlier tonight" });
  });

  it("say what went wrong before the build: signed out, sign-in being renewed or not checked, sandbox check failed", () => {
    const withSignIn = (status: "waiting" | "signed-out" | "unknown", state: IdeaState = "building") =>
      checkOf(tell(scene(state), { running: { build: state === "building" }, now: state === "building" ? local("11 01:02") : local("11 08:00"), build: { ...BUILD_TICKS, signIn: { at: local("11 01:00", 2), status, minutesLeft: null }, sandboxCheck: null, agentStarted: null } }), "sign-in");
    expect(withSignIn("waiting")).toMatchObject({ label: "Renewing Kiro's sign-in", status: "active" });
    expect(withSignIn("waiting", "build_failed")).toMatchObject({ status: "todo" });
    expect(withSignIn("signed-out", "build_failed")).toMatchObject({ label: "Kiro is signed out", status: "failed" });
    expect(withSignIn("unknown")).toMatchObject({ label: "Kiro sign-in could not be checked", status: "todo", detail: "building anyway" });

    const failedCheck = tell(scene("build_failed"), { now: local("11 08:00"), build: { ...BUILD_TICKS, sandboxCheck: { at: local("11 01:00", 9), ok: false, ms: 9000, reused: false }, agentStarted: null, finished: { at: T.failed, ok: false, seconds: 9, credits: null } } });
    expect(checkOf(failedCheck, "sandbox")).toMatchObject({ label: "Sandbox check failed", status: "failed", detail: null });
    expect(checkOf(failedCheck, "built")).toEqual({ key: "built", label: "Not built", status: "failed", detail: "after 9 s", since: null });
  });

  it("say when the second builder took over", () => {
    const fellBack: BuildFacts = { ...BUILT_TICKS, agentStarted: { at: local("11 01:20"), backend: "kiro-cli" }, fellBack: { at: local("11 01:19") } };
    const story = tell(scene("built", { buildBackend: "kiro-cli" }), { build: fellBack });
    expect(checkOf(story, "agent")).toMatchObject({ label: "Kiro CLI finished", detail: "second builder, after the first could not build it" });
    const failed = tell(scene("build_failed"), { now: local("11 08:00"), build: { ...fellBack, finished: { at: T.failed, ok: false, seconds: 2700, credits: null } } });
    expect(checkOf(failed, "agent")).toMatchObject({ label: "Kiro CLI did not finish", status: "failed" });
    expect(checkOf(failed, "built")).toMatchObject({ label: "Not built", status: "failed", detail: "after 45 min" });
  });

  it("say where the finished build was left, right after 'Built'", () => {
    const sealedAt = local("11 01:02", 41);
    const ticksWith = (sealed: BuildFacts["sealed"]) => tell(scene("delivered", { hasFact: true }), { now: local("11 08:00"), build: { ...BUILT_TICKS, sealed }, deliver: DELIVER_TICKS, report: REPORT });
    // Moved, and every file in it made anew: one more tick of the night, between the build and the morning's check.
    const moved = ticksWith({ at: sealedAt, ok: true, moved: true, files: null });
    expect(moved.checks.map((check) => check.key)).toEqual(["sign-in", "sandbox", "agent", "built", "sealed", "checked", "pushed", "live", "told", "fact"]);
    expect(checkOf(moved, "sealed")).toEqual({ key: "sealed", label: "Moved out of build jobs' reach", status: "done", detail: null, since: null });
    // Moved, but some of its files were not made anew, so a build job could still change them: not a green tick, and how many files.
    expect(checkOf(ticksWith({ at: sealedAt, ok: false, moved: true, files: 3 }), "sealed")).toEqual({ key: "sealed", label: "Not fully out of build jobs' reach", status: "failed", detail: "a build job could still change 3 files", since: null });
    expect(checkOf(ticksWith({ at: sealedAt, ok: false, moved: true, files: 1 }), "sealed")?.detail).toBe("a build job could still change 1 file");
    expect(checkOf(ticksWith({ at: sealedAt, ok: false, moved: true, files: null }), "sealed")?.detail).toBe("a build job could still change some of its files");
    // Not moved at all: the morning uses it where every build job can reach it.
    expect(checkOf(ticksWith({ at: sealedAt, ok: false, moved: false, files: null }), "sealed")).toEqual({ key: "sealed", label: "Still within build jobs' reach", status: "failed", detail: "it could not be moved", since: null });
    // A log with no line about it (a night from before finished builds were moved) says nothing either way.
    expect(checkOf(ticksWith(null), "sealed")).toBeUndefined();
    // It is a tick only: the seven steps are the database's, and stay as they were.
    expect(statuses(ticksWith({ at: sealedAt, ok: false, moved: false, files: null }))).toBe("done done done done done done done");
    // Shown as soon as the build is, before the morning.
    const built = tell(scene("built"), { build: { ...BUILT_TICKS, sealed: { at: sealedAt, ok: true, moved: true, files: null } } });
    expect(built.checks.map((check) => `${check.key}:${check.status}`)).toEqual(["sign-in:done", "sandbox:done", "agent:done", "built:done", "sealed:done"]);
  });

  it("say a build that was stopped was stopped, not that it failed, while it has one more try to come", () => {
    const stopped: BuildFacts = { ...BUILD_TICKS, finished: { at: T.failed, ok: false, seconds: 217, credits: null } };
    const cutShort = tell(scene("build_failed", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }), { now: local("11 08:00"), build: stopped });
    // Its step is "Not built yet", in the colour of waiting. The two ticks under it used to be red crosses.
    expect(stepOf(cutShort, "built")).toMatchObject({ label: "Not built yet", status: "waiting" });
    expect(checkOf(cutShort, "agent")).toEqual({ key: "agent", label: "Kiro Crew was stopped", status: "waiting", detail: null, since: null });
    expect(checkOf(cutShort, "built")).toEqual({ key: "built", label: "Not built yet", status: "waiting", detail: "after 3 min 37 s", since: null });
    expect(cutShort.checks.some((check) => check.status === "failed")).toBe(false);
    // The same log lines for a build that failed for good (its second start, or any other reason) stay a failure.
    const forGood = tell(scene("build_failed", { awaitingRetry: false, failureReason: BUILD_STOPPED_REASON, buildStarts: 2 }), { now: local("11 08:00"), build: stopped });
    expect(checkOf(forGood, "agent")).toMatchObject({ label: "Kiro Crew did not finish", status: "failed", detail: null });
    expect(checkOf(forGood, "built")).toMatchObject({ label: "Not built", status: "failed", detail: "after 3 min 37 s" });
    // Being built again, it is a build like any other: the retry's own ticks, none of them "waiting".
    const again = tell(scene("building", { awaitingRetry: false, buildStarts: 2 }), { running: { build: true }, build: BUILD_TICKS });
    expect(again.checks.map((check) => check.status)).toEqual(["done", "done", "active", "todo"]);
  });

  it("say the Mac went to sleep, and give no build time, for a build the Mac slept through", () => {
    // What the log reader hands over for such a build: when the sleep was noticed, and no seconds (they would be the night's hours).
    const slept: BuildFacts = { ...BUILD_TICKS, slept: { at: local("11 07:10") }, finished: { at: local("11 07:10", 5), ok: false, seconds: null, credits: null } };
    const way: Array<[IdeaState, string]> = [...WAY_TO.building, ["build_failed", local("11 07:10", 5)]];
    const first = tell(scene("build_failed", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }, way), { now: local("11 08:00"), build: slept });
    expect(checkOf(first, "agent")).toEqual({ key: "agent", label: "Kiro Crew was stopped", status: "waiting", detail: "the Mac went to sleep", since: null });
    expect(checkOf(first, "built")).toEqual({ key: "built", label: "Not built yet", status: "waiting", detail: null, since: null });
    expect(stepOf(first, "built")?.detail).toBe("Cut short. It will be built once more at the next nightly build.");
    expect(JSON.stringify(first)).not.toMatch(/6 h|370 min/);
    // On its second start that counts as failed: still stopped by the sleep, and said so.
    const second = tell(scene("build_failed", { awaitingRetry: false, failureReason: BUILD_STOPPED_REASON, buildStarts: 2 }, way), { now: local("11 08:00"), build: slept });
    expect(checkOf(second, "agent")).toEqual({ key: "agent", label: "Kiro Crew was stopped", status: "failed", detail: "the Mac went to sleep", since: null });
    expect(checkOf(second, "built")).toEqual({ key: "built", label: "Not built", status: "failed", detail: null, since: null });
    // With the second builder: both things are said.
    const fellBack = tell(scene("build_failed", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }, way), { now: local("11 08:00"), build: { ...slept, agentStarted: { at: local("11 01:20"), backend: "kiro-cli" }, fellBack: { at: local("11 01:19") } } });
    expect(checkOf(fellBack, "agent")).toMatchObject({ label: "Kiro CLI was stopped", detail: "the Mac went to sleep · second builder, after the first could not build it" });
    // A build that had finished all the same keeps its result, and still has no time made of sleep.
    const builtWay: Array<[IdeaState, string]> = [...WAY_TO.building, ["built", local("11 07:10", 5)]];
    const builtAnyway = tell(scene("built", {}, builtWay), { now: local("11 07:11"), build: { ...slept, finished: { at: local("11 07:10", 5), ok: true, seconds: null, credits: 3.2 } } });
    expect(checkOf(builtAnyway, "agent")).toMatchObject({ label: "Kiro Crew finished", status: "done" });
    expect(checkOf(builtAnyway, "built")).toMatchObject({ label: "Built", status: "done", detail: "3.2 Kiro credits" });
    expect(stepOf(builtAnyway, "built")?.detail).toBe("Kiro Crew · 3.2 Kiro credits");
  });

  it("say that the wrist was told an app could not be finished", () => {
    const story = tell(scene("build_failed", { failureNotifiedAt: local("11 06:31") }), { now: local("11 08:00"), deliver: { firstAt: local("11 06:31"), checked: null, pushed: null, live: null, told: { at: local("11 06:31"), what: "could-not-finish" }, fact: null } });
    expect(story.checks).toEqual([{ key: "told", label: "Told the wrist it could not be finished", status: "done", detail: null, since: null }]);
  });

  it("leave out the build ticks of an earlier try of the same idea", () => {
    // Built again on a later night: the log's ticks are from the first try, an hour before this build began.
    const way: Array<[IdeaState, string]> = [...WAY_TO.build_failed.slice(0, 3), ["building", local("10 01:00")], ["build_failed", local("10 01:30")], ["building", T.building]];
    const again = scene("building", {}, way);
    const old: BuildFacts = { ...BUILT_TICKS, startedAt: local("10 01:00", 1) };
    expect(tell(again, { running: { build: true }, build: old }).checks).toEqual([]);
    // The log line is written a moment after the timeline entry, and a moment before still counts.
    expect(tell(again, { running: { build: true }, build: { ...BUILD_TICKS, startedAt: local("11 00:59", 56) } }).checks.length).toBeGreaterThan(0);
    expect(tell(again, { running: { build: true }, build: { ...BUILD_TICKS, startedAt: local("11 00:59", 54) } }).checks).toEqual([]);
  });

  it("leave out the morning ticks of an earlier build of the same idea", () => {
    // Checked and refused yesterday morning; built again tonight and not yet checked.
    const yesterday: DeliverFacts = { firstAt: local("10 06:30"), checked: { at: local("10 06:30"), ok: false, ms: 900, files: null, bytes: null, step: "build" }, pushed: null, live: null, told: { at: local("10 06:31"), what: "could-not-finish" }, fact: null };
    const story = tell(scene("built"), { build: BUILT_TICKS, deliver: yesterday });
    expect(story.checks.map((check) => check.key)).toEqual(["sign-in", "sandbox", "agent", "built"]);
    expect(stepOf(story, "checked")).toMatchObject({ status: "todo", detail: "at 6:30 AM" });
  });

  it("leave out the morning ticks of an earlier build when the build after it failed", () => {
    // Built and refused at the check two nights ago, told, built again last night, and that build failed.
    const way: Array<[IdeaState, string]> = [
      ...WAY_TO.approved,
      ["building", local("10 01:00")], ["built", local("10 01:03")], ["publish_failed", local("10 06:30")],
      ["building", T.building], ["build_failed", T.failed],
    ];
    const earlier: DeliverFacts = { firstAt: local("10 06:30"), checked: { at: local("10 06:30"), ok: false, ms: 900, files: null, bytes: null, step: "build" }, pushed: null, live: null, told: { at: local("10 06:31"), what: "could-not-finish" }, fact: null };
    expect(tell(scene("build_failed", {}, way), { now: local("11 08:00"), deliver: earlier }).checks).toEqual([]);
    // Told this morning about last night's failure: that one counts, the old check still does not.
    const toldAgain: DeliverFacts = { ...earlier, told: { at: local("11 06:31"), what: "could-not-finish" } };
    expect(tell(scene("build_failed", {}, way), { now: local("11 08:00"), deliver: toldAgain }).checks.map((check) => check.key)).toEqual(["told"]);
  });

  it("show the marks of a build in progress even when the log says nothing about it", () => {
    const marks: WorkspaceMarks = { started: true, projectWritten: false, packagesInstalled: false, appBuilt: false, notesWritten: false };
    const story = tell(scene("building"), { running: { build: true }, marks });
    expect(story.checks.map((check) => `${check.key}:${check.status}`)).toEqual(["mark-started:done", "mark-project:todo", "mark-packages:todo", "mark-app:todo", "mark-notes:todo"]);
  });

  it("round a sign-in's minutes and never show a broken number", () => {
    const withMinutes = (minutesLeft: number | null) => checkOf(tell(scene("building"), { running: { build: true }, build: { ...BUILD_TICKS, signIn: { at: local("11 01:00", 2), status: "ready", minutesLeft } } }), "sign-in")?.detail;
    expect([withMinutes(46.6), withMinutes(0), withMinutes(null)]).toEqual(["47 min left", "0 min left", null]);
  });
});

describe("at most one step is under way", () => {
  it("in every state, with and without the logs, with every program running or none", () => {
    const tellings: Told[] = [
      {},
      { build: BUILT_TICKS, deliver: DELIVER_TICKS, report: REPORT },
      { running: { build: true, deliver: true }, build: BUILT_TICKS, deliver: DELIVER_TICKS, report: REPORT },
      { running: { build: null, deliver: null } },
      { now: local("11 09:00"), running: { build: true, deliver: true } },
    ];
    for (const state of Object.keys(WAY_TO) as IdeaState[]) {
      for (const told of tellings) {
        const story = tell(scene(state), told);
        expect(story.steps.filter((step) => step.status === "active").length).toBeLessThanOrEqual(1);
        expect(story.checks.filter((check) => check.status === "active").length).toBeLessThanOrEqual(1);
        // A clock only runs for a build that is under way.
        expect(story.runningSince !== null).toBe(state === "building" && stepOf(story, "built")?.status === "active");
      }
    }
  });
});

// ---------- the looks the rest of this file works on ----------

/** A night job that has never asked the clock on this data folder. */
const NO_RECORDS: NightRecords = { record: null, last: null, checkedAt: null };

function snapshot(given: Array<{ idea: DashIdea; events: IdeaEvent[] }>, more: Partial<Snapshot> = {}): Snapshot {
  const at = more.at ?? local("11 01:02");
  return {
    at,
    problem: null,
    staleSince: null,
    demoMark: false,
    paused: false,
    running: IDLE,
    dayStart: local("10 07:00"),
    linesHeard: 0,
    lastHeardAt: null,
    asks: 0,
    detector: { idea: 0, not_idea: 0, skipped: 0, failed: 0 },
    heard: [],
    ideas: given.map((entry) => entry.idea),
    events: new Map(given.map((entry) => [entry.idea.id, entry.events])),
    build: new Map(),
    deliver: new Map(),
    buildRuns: [],
    deliverRuns: [],
    nextBuildAt: local("12 01:00"),
    nextDeliverAt: local("11 06:30"),
    rehearsalIdeas: 0,
    buildCredits: null,
    nightClock: { build: NO_RECORDS, deliver: NO_RECORDS },
    unreadableRows: 0,
    ...more,
  };
}

describe("the idea the Today page leads with", () => {
  const titled = (state: IdeaState, title: string, more: Partial<DashIdea> = {}) => scene(state, { title, ...more });

  it("is nobody when there are no ideas", () => {
    expect(heroIdea(snapshot([]))).toBeNull();
  });

  it("is the idea being built, before anything else", () => {
    const all = [titled("delivered", "Delivered"), titled("asked", "Asked"), titled("approved", "Approved"), titled("built", "Built"), titled("building", "Building"), titled("published", "Published")];
    expect(heroIdea(snapshot(all))?.title).toBe("Building");
  });

  it("is then one that is built or published and on its way, the newest of them", () => {
    const all = [titled("delivered", "Delivered"), titled("approved", "Approved"), titled("built", "Built", { updatedAt: local("11 01:02") }), titled("published", "Published", { updatedAt: local("11 06:31") }), titled("asked", "Asked")];
    expect(heroIdea(snapshot(all))?.title).toBe("Published");
    expect(heroIdea(snapshot(all.filter((entry) => entry.idea.title !== "Published")))?.title).toBe("Built");
  });

  it("passes over a build that has sat built or published for more than a day: it is stuck, not on its way", () => {
    const at = local("11 15:00");
    const stuck = [titled("built", "Built days ago", { updatedAt: local("9 01:03") }), titled("published", "Published days ago", { updatedAt: local("9 06:31") })];
    const all = [...stuck, titled("approved", "Approved"), titled("asked", "Asked")];
    expect(heroIdea(snapshot(all, { at }))?.title).toBe("Approved");
    // Exactly 24 hours ago still counts as on its way; a minute more does not.
    const edge = [titled("built", "Built a day ago to the minute", { updatedAt: local("10 15:00") }), titled("approved", "Approved")];
    expect(heroIdea(snapshot(edge, { at }))?.title).toBe("Built a day ago to the minute");
    expect(heroIdea(snapshot(edge, { at: local("11 15:01") }))?.title).toBe("Approved");
    // With nothing else to lead, a stuck build is still an idea like any other: the newest one leads.
    expect(heroIdea(snapshot(stuck, { at }))?.title).toBe("Built days ago");
  });

  it("is then an idea that finished in the last hour, well or badly, so the end of its story is seen", () => {
    const at = local("11 06:40");
    const waiting = [titled("approved", "Approved"), titled("asked", "Asked")];
    const delivered = titled("delivered", "Delivered just now", { updatedAt: local("11 06:31") });
    const failed = titled("publish_failed", "Failed a moment later", { updatedAt: local("11 06:33") });
    expect(heroIdea(snapshot([...waiting, delivered], { at }))?.title).toBe("Delivered just now");
    expect(heroIdea(snapshot([...waiting, delivered, failed], { at }))?.title).toBe("Failed a moment later");
    expect(heroIdea(snapshot([...waiting, titled("build_failed", "Could not be built", { updatedAt: local("11 06:00") })], { at }))?.title).toBe("Could not be built");
    // Exactly an hour ago still counts; a minute more and the approved idea leads again.
    expect(heroIdea(snapshot([...waiting, delivered], { at: local("11 07:31") }))?.title).toBe("Delivered just now");
    expect(heroIdea(snapshot([...waiting, delivered], { at: local("11 07:32") }))?.title).toBe("Approved");
    // A build still on its way comes before one that has finished: the page follows the work that is going on.
    expect(heroIdea(snapshot([...waiting, delivered, titled("built", "Built, next to be checked", { updatedAt: local("11 01:03") })], { at }))?.title).toBe("Built, next to be checked");
    // An idea that was turned down or got no answer has not "finished": it never leads this way.
    expect(heroIdea(snapshot([...waiting, titled("rejected", "Rejected just now", { updatedAt: local("11 06:39") })], { at }))?.title).toBe("Approved");
  });

  it("is then the approved idea that has waited longest", () => {
    const all = [titled("asked", "Asked"), titled("approved", "Second", { answeredAt: local("10 15:15") }), titled("approved", "First", { answeredAt: local("10 12:46") }), titled("delivered", "Delivered", { updatedAt: local("10 06:31") })];
    expect(heroIdea(snapshot(all))?.title).toBe("First");
  });

  it("is then the newest ask", () => {
    const all = [titled("asked", "Older ask", { askedAt: local("10 12:44") }), titled("asked", "Newer ask", { askedAt: local("10 16:00") }), titled("delivered", "Delivered", { updatedAt: local("10 06:31") }), titled("heard", "Heard")];
    expect(heroIdea(snapshot(all))?.title).toBe("Newer ask");
  });

  it("is then an idea that finished, well or badly, in the last 24 hours: the newest", () => {
    const at = local("11 15:00");
    const all = [
      titled("delivered", "Delivered this morning", { updatedAt: local("11 06:31") }),
      titled("build_failed", "Failed later", { updatedAt: local("11 09:00") }),
      titled("heard", "Just heard", { createdAt: local("11 14:00") }),
      titled("rejected", "Rejected", { updatedAt: local("11 14:30") }),
    ];
    expect(heroIdea(snapshot(all, { at }))?.title).toBe("Failed later");
    expect(heroIdea(snapshot(all.slice(0, 1).concat(all.slice(2)), { at }))?.title).toBe("Delivered this morning");
  });

  it("is otherwise simply the newest idea", () => {
    const at = local("11 15:00");
    const all = [
      titled("delivered", "Delivered two days ago", { createdAt: local("9 10:00"), updatedAt: local("9 15:00") }),
      titled("rejected", "Rejected yesterday", { createdAt: local("10 10:00") }),
      titled("heard", "Heard today", { createdAt: local("11 14:00") }),
    ];
    expect(heroIdea(snapshot(all, { at }))?.title).toBe("Heard today");
    // Exactly 24 hours ago still counts as finished in the last 24 hours.
    const edge = [titled("publish_failed", "A day ago to the minute", { updatedAt: local("10 15:00"), createdAt: local("9 10:00") }), titled("heard", "Heard today", { createdAt: local("11 14:00") })];
    expect(heroIdea(snapshot(edge, { at }))?.title).toBe("A day ago to the minute");
    expect(heroIdea(snapshot(edge, { at: local("11 15:01") }))?.title).toBe("Heard today");
  });
});

describe("the sentence over the hero", () => {
  const lineFor = (state: IdeaState, more: Partial<DashIdea> = {}, look: Partial<Snapshot> = {}) => {
    const given = scene(state, more);
    return nowLine(snapshot([given], look), given.idea, CONFIG);
  };

  it("says 'Tonight' from the ask cutoff until the morning's checks, 'This morning' until noon, then 'Today'", () => {
    const over = (at: string): string => nowLine(snapshot([], { at }), null, CONFIG).over;
    expect([over(local("10 22:59")), over(local("10 23:00")), over(local("11 01:02")), over(local("11 06:29"))]).toEqual(["Today", "Tonight", "Tonight", "Tonight"]);
    expect([over(local("11 06:30")), over(local("11 07:00")), over(local("11 11:59"))]).toEqual(["This morning", "This morning", "This morning"]);
    expect([over(local("11 12:00")), over(local("11 18:00"))]).toEqual(["Today", "Today"]);
  });

  it("goes by the settings for those times", () => {
    const early: Config = { ...CONFIG, askCutoff: "21:00", deliverTime: "05:30" };
    const over = (at: string): string => nowLine(snapshot([], { at }), null, early).over;
    expect([over(local("10 20:59")), over(local("10 21:00")), over(local("11 04:59")), over(local("11 05:00")), over(local("11 12:00"))]).toEqual(["Today", "Tonight", "Tonight", "This morning", "Today"]);
  });

  it("names the builder at work", () => {
    expect(lineFor("building")).toEqual({ over: "Tonight", before: "Kiro Crew is building", title: "Chore Wheel", after: "" });
    expect(lineFor("building", { buildBackend: "kiro-cli" }).before).toBe("Kiro CLI is building");
    expect(lineFor("building", { buildBackend: null }).before).toBe("Overnight is building");
  });

  it("has a sentence for every state", () => {
    const said = (state: IdeaState, more: Partial<DashIdea> = {}, look: Partial<Snapshot> = {}): string => {
      const line = lineFor(state, more, look);
      return [line.before, line.title === null ? null : `“${line.title}”`, line.after].filter((part) => part !== null && part !== "").join(" ");
    };
    expect(said("heard")).toBe("Heard “Chore Wheel”");
    expect(said("asked")).toBe("Waiting for an answer about “Chore Wheel”");
    expect(said("approved")).toBe("“Chore Wheel” will be built at 1:00 AM");
    expect(said("approved", {}, { paused: true })).toBe("“Chore Wheel” is approved. Building is paused");
    expect(said("rejected")).toBe("“Chore Wheel” was not approved");
    expect(said("expired")).toBe("“Chore Wheel” got no answer");
    expect(said("built")).toBe("“Chore Wheel” is built. Checks start at 6:30 AM");
    expect(said("built", {}, { running: { ...IDLE, deliver: true } })).toBe("Checking “Chore Wheel” in the sandbox");
    // Once the log says this build passed its check, the morning's run is publishing it.
    const id = "idea_20261010_pub11sh1";
    const morning = (checked: DeliverFacts["checked"]): Partial<Snapshot> => ({ running: { ...IDLE, deliver: true }, deliver: new Map([[id, { firstAt: T.checked, checked, pushed: null, live: null, told: null, fact: null }]]) });
    const passedAt = (at: string): DeliverFacts["checked"] => ({ at, ok: true, ms: 6600, files: 3, bytes: 5602, step: null });
    expect(said("built", { id }, morning(passedAt(T.checked)))).toBe("Publishing “Chore Wheel”");
    // Exactly when the build was finished still counts; a check from before that was an earlier build's.
    expect(said("built", { id }, morning(passedAt(T.built)))).toBe("Publishing “Chore Wheel”");
    expect(said("built", { id }, morning(passedAt(local("10 06:30"))))).toBe("Checking “Chore Wheel” in the sandbox");
    // A check that did not pass, or that says nothing yet, is still a check under way.
    expect(said("built", { id }, morning({ at: T.checked, ok: false, ms: 900, files: null, bytes: null, step: "build" }))).toBe("Checking “Chore Wheel” in the sandbox");
    expect(said("built", { id }, morning(null))).toBe("Checking “Chore Wheel” in the sandbox");
    // Another idea's passed check says nothing about this one.
    expect(said("built", {}, morning(passedAt(T.checked)))).toBe("Checking “Chore Wheel” in the sandbox");
    // With no morning run going, a passed check in the log does not make the page say it is publishing.
    expect(said("built", { id }, { ...morning(passedAt(T.checked)), running: IDLE })).toBe("“Chore Wheel” is built. Checks start at 6:30 AM");
    expect(said("build_failed")).toBe("“Chore Wheel” could not be built");
    expect(said("build_failed", { awaitingRetry: true })).toBe("“Chore Wheel” was cut short and will be built once more");
    expect(said("publish_failed")).toBe("“Chore Wheel” was built but not published");
    expect(said("published")).toBe("“Chore Wheel” is live");
    expect(said("delivered")).toBe("“Chore Wheel” was delivered");
  });

  it("has something to say when there is no idea at all", () => {
    expect(nowLine(snapshot([]), null, CONFIG)).toEqual({ over: "Tonight", before: "Listening. No ideas yet", title: null, after: "" });
    expect(nowLine(snapshot([], { running: { listener: false, build: false, deliver: false } }), null, CONFIG).before).toBe("No ideas yet");
    expect(nowLine(snapshot([], { running: { listener: null, build: null, deliver: null } }), null, CONFIG).before).toBe("No ideas yet");
    expect(nowLine(snapshot([], { problem: "missing" }), null, CONFIG).before).toBe("Nothing saved yet");
    expect(nowLine(snapshot([], { problem: "empty" }), null, CONFIG).before).toBe("Nothing saved yet");
  });

  // Under the banner "Could not read the database" the headline used to say "No ideas yet", which nobody knew.
  it("does not say there are no ideas when the database was never read", () => {
    for (const problem of ["unreadable", "busy"] as const) {
      expect(nowLine(snapshot([], { problem }), null, CONFIG), problem).toEqual({ over: "Tonight", before: "Could not read the database", title: null, after: "" });
      expect(nowLine(snapshot([], { problem, running: { listener: false, build: false, deliver: false } }), null, CONFIG).before, problem).toBe("Could not read the database");
    }
    // It was read before, and there were no ideas then: that is what the page still shows, and the banner says since when.
    expect(nowLine(snapshot([], { problem: "busy", staleSince: local("11 01:01") }), null, CONFIG).before).toBe("Listening. No ideas yet");
    // An idea from the last good look is still the headline.
    const kept = scene("approved", { title: "Chore Wheel" });
    expect(nowLine(snapshot([kept], { problem: "unreadable", staleSince: local("11 01:01") }), kept.idea, CONFIG).title).toBe("Chore Wheel");
  });
});

describe("tonight's queue", () => {
  const titled = (state: IdeaState, title: string, more: Partial<DashIdea> = {}, way?: Array<[IdeaState, string]>) => scene(state, { title, ...more }, way);
  const rows = (look: Snapshot, config: Config = CONFIG): string[] => tonightQueue(look, config).rows.map((row) => `${row.idea.title}: ${row.when}`);

  it("lists the idea being built, then approved ideas, the one approved longest ago first", () => {
    const all = [
      titled("approved", "Approved third", { answeredAt: local("10 18:00") }),
      titled("approved", "Approved first", { answeredAt: local("10 12:46") }),
      titled("building", "Being built"),
      titled("asked", "Only asked"),
      // Built and delivered the night before: not one of tonight's builds.
      titled("delivered", "Delivered", {}, [["heard", local("9 12:41")], ["asked", local("9 12:44")], ["approved", local("9 12:46")], ["building", local("10 01:00")], ["built", local("10 01:03")], ["published", local("10 06:31")], ["delivered", local("10 06:31", 5)]]),
      titled("approved", "Approved second", { answeredAt: local("10 15:15") }),
    ];
    // 1:02 AM: tonight's build is under way and has started one idea, so it has room for one more of its two.
    const queue = tonightQueue(snapshot(all), CONFIG);
    expect(queue).toMatchObject({ at: local("12 01:00"), paused: false, limit: 2 });
    expect(rows(snapshot(all))).toEqual(["Being built: building", "Approved first: tonight", "Approved second: later", "Approved third: later"]);
  });

  it("counts the limit for the run that is under way, and for the next nightly build once it is over", () => {
    const approved = [titled("approved", "One", { answeredAt: local("10 10:00") }), titled("approved", "Two", { answeredAt: local("10 11:00") }), titled("approved", "Three", { answeredAt: local("10 12:00") })];
    // 1:10 AM: tonight's run has built one idea already and nothing is being built this minute, but the build program is still running.
    const builtTonight = titled("built", "Built ten minutes ago");
    const at = local("11 01:10");
    expect(rows(snapshot([...approved, builtTonight], { at, running: { listener: true, build: true, deliver: false } }))).toEqual(["One: tonight", "Two: later", "Three: later"]);
    // The same look once the run has ended: the list is tomorrow night's, which has started nothing yet.
    expect(rows(snapshot([...approved, builtTonight], { at }))).toEqual(["One: tonight", "Two: tonight", "Three: later"]);
    // Two builds started tonight and one of them still going: the run is full.
    const second = titled("building", "Second build tonight", {}, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("11 01:04")]]);
    expect(rows(snapshot([...approved, builtTonight, second], { at }))).toEqual(["Second build tonight: building", "One: later", "Two: later", "Three: later"]);
  });

  it("gives a build that was cut short its place by when it was approved, not ahead of an older approval", () => {
    const all = [
      titled("approved", "Approved later", { answeredAt: local("10 18:00") }),
      titled("build_failed", "Cut short", { answeredAt: local("10 12:46"), awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }),
      titled("approved", "Approved earliest", { answeredAt: local("10 09:00") }),
      titled("build_failed", "Failed for good", { answeredAt: local("10 08:00") }),
    ];
    expect(rows(snapshot(all, { at: local("11 08:00") }))).toEqual(["Approved earliest: tonight", "Cut short: tonight", "Approved later: later"]);
  });

  it("keeps the order ideas were heard in for two approved at the same moment", () => {
    const same = local("10 12:46");
    const all = [
      titled("approved", "Heard second", { id: "idea_20261010_bbbbbbbb", createdAt: local("10 12:30"), answeredAt: same }),
      titled("approved", "Heard first", { id: "idea_20261010_cccccccc", createdAt: local("10 12:10"), answeredAt: same }),
      titled("approved", "Heard with the second, earlier id", { id: "idea_20261010_aaaaaaaa", createdAt: local("10 12:30"), answeredAt: same }),
    ];
    expect(rows(snapshot(all), { ...CONFIG, maxBuildsPerNight: 5 })).toEqual(["Heard first: tonight", "Heard with the second, earlier id: tonight", "Heard second: tonight"]);
  });

  it("takes the approval time from the timeline when the idea does not carry it", () => {
    // Approved at 12:46 by its timeline; its note was changed that evening, which is not when it was approved.
    const all = [
      titled("approved", "Approved in the afternoon", { answeredAt: local("10 15:00") }),
      titled("approved", "From the timeline", { answeredAt: null, updatedAt: local("10 20:00") }),
      titled("approved", "Carried", { answeredAt: local("10 12:45") }),
    ];
    expect(rows(snapshot(all), { ...CONFIG, maxBuildsPerNight: 3 })).toEqual(["Carried: tonight", "From the timeline: tonight", "Approved in the afternoon: tonight"]);
    expect(heroIdea(snapshot(all))?.title).toBe("Carried");
    expect(heroIdea(snapshot(all.slice(0, 2)))?.title).toBe("From the timeline");
  });

  it("counts builds already started in the day the next nightly build falls on", () => {
    const approved = [titled("approved", "One", { answeredAt: local("10 10:00") }), titled("approved", "Two", { answeredAt: local("10 11:00") }), titled("approved", "Three", { answeredAt: local("10 12:00") })];
    // 12:20 AM on Oct 11: a build was started by hand ten minutes ago, in the same local day as the 1:00 AM build.
    const byHand = titled("delivered", "Built by hand just now", {}, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("11 00:10")], ["built", local("11 00:12")], ["published", local("11 00:13")], ["delivered", local("11 00:13", 5)]]);
    const justAfterMidnight = { at: local("11 00:20"), nextBuildAt: local("11 01:00") };
    expect(rows(snapshot([...approved, byHand], justAfterMidnight))).toEqual(["One: tonight", "Two: later", "Three: later"]);
    // The same build an hour earlier, before midnight, is another day's.
    const yesterday = titled("delivered", "Built by hand before midnight", {}, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("10 23:10")], ["built", local("10 23:12")], ["published", local("10 23:13")], ["delivered", local("10 23:13", 5)]]);
    expect(rows(snapshot([...approved, yesterday], justAfterMidnight))).toEqual(["One: tonight", "Two: tonight", "Three: later"]);
  });

  // A build started by hand holds the same lock as the nightly run. While one ran, the list used to
  // count today's builds against tonight's limit, and every idea read "waits for another night".
  it("does not take a build started by hand in the daytime for tonight's run", () => {
    const lastNight: Array<[IdeaState, string]> = [["heard", local("9 12:41")], ["asked", local("9 12:44")], ["approved", local("9 12:46")], ["building", local("11 01:00")], ["built", local("11 01:03")], ["published", local("11 06:31")], ["delivered", local("11 06:31", 5)]];
    const builtLastNight = [titled("delivered", "Built last night", {}, lastNight), titled("delivered", "Built last night too", {}, lastNight.map(([state, at]) => [state, at === local("11 01:00") ? local("11 01:04") : at]))];
    const approved = [titled("approved", "One", { answeredAt: local("11 10:00") }), titled("approved", "Two", { answeredAt: local("11 11:00") }), titled("approved", "Three", { answeredAt: local("11 12:00") })];
    // 3:00 PM: `overnight build-now` is building one idea. Tonight's build is at 1:00 AM, in tomorrow's local day, and has started nothing.
    const byHand = titled("building", "By hand", {}, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("11 15:00")]]);
    const afternoon = { at: local("11 15:02"), nextBuildAt: local("12 01:00"), running: { listener: true, build: true, deliver: false } };
    expect(rows(snapshot([...builtLastNight, ...approved, byHand], afternoon))).toEqual(["By hand: building", "One: tonight", "Two: tonight", "Three: later"]);
    // The lock alone, with no idea marked as building this second: the same.
    expect(rows(snapshot([...builtLastNight, ...approved], afternoon))).toEqual(["One: tonight", "Two: tonight", "Three: later"]);
  });

  it("does not take a build started by hand in the small hours for tonight's run either, when the build log says whose run it is", () => {
    const approved = [titled("approved", "One", { answeredAt: local("10 10:00") }), titled("approved", "Two", { answeredAt: local("10 11:00") }), titled("approved", "Three", { answeredAt: local("10 12:00") })];
    const byHand = titled("building", "By hand", {}, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("11 09:00")]]);
    const run = (command: BuildRun["command"], finishedAt: string | null): BuildRun => ({ command, startedAt: local("11 09:00"), finishedAt, waiting: null, taking: null, built: null, failed: null, paused: false, nothingApproved: false, slept: false, sandboxCheck: null, ideaIds: [byHand.idea.id] });
    const morning = { at: local("11 09:02"), nextBuildAt: local("12 01:00"), running: { listener: true, build: true, deliver: false } };
    // 9:02 AM, after tonight's build time and before noon. The log's open run is `build-now`: the next nightly build has all its room.
    expect(rows(snapshot([...approved, byHand], { ...morning, buildRuns: [run("build-now", null)] }))).toEqual(["By hand: building", "One: tonight", "Two: tonight", "Three: later"]);
    expect(rows(snapshot([...approved, byHand], { ...morning, buildRuns: [run("rehearse", null)] }))).toEqual(["By hand: building", "One: tonight", "Two: tonight", "Three: later"]);
    // The nightly job's own run, still open (a late night): it has started one build today and has room for one more.
    expect(rows(snapshot([...approved, byHand], { ...morning, buildRuns: [run("build", null)] }))).toEqual(["By hand: building", "One: tonight", "Two: later", "Three: later"]);
    // A by-hand run that the log says has ended does not explain a build that is going now.
    expect(rows(snapshot([...approved, byHand], { ...morning, buildRuns: [run("build-now", local("11 09:01"))] }))).toEqual(["By hand: building", "One: tonight", "Two: later", "Three: later"]);
  });

  it("goes by the nightly limit in the settings, down to none", () => {
    const approved = [titled("approved", "One", { answeredAt: local("10 10:00") }), titled("approved", "Two", { answeredAt: local("10 11:00") })];
    expect(rows(snapshot(approved), { ...CONFIG, maxBuildsPerNight: 1 })).toEqual(["One: tonight", "Two: later"]);
    expect(rows(snapshot(approved), { ...CONFIG, maxBuildsPerNight: 0 })).toEqual(["One: later", "Two: later"]);
    expect(tonightQueue(snapshot(approved), { ...CONFIG, maxBuildsPerNight: 0 }).limit).toBe(0);
  });

  it("says when Overnight is paused, and is empty when nothing waits", () => {
    expect(tonightQueue(snapshot([titled("approved", "One")], { paused: true }), CONFIG)).toMatchObject({ paused: true, rows: [{ when: "tonight" }] });
    expect(tonightQueue(snapshot([titled("asked", "Asked"), titled("delivered", "Delivered")]), CONFIG).rows).toEqual([]);
  });
});

// ---------- what stands in the night's way ----------
//
// The pages used to promise "will be built at 1:00 AM" from the settings alone. The month's credit
// ceiling, a rehearsal folder and a run that is late all decide otherwise, and `overnight status`
// said so while the dashboard did not (found Oct 11). These go by the same stored facts as status.

/** The month's ledger held against a limit, by core's own rule. October 2026 in Boise. */
function budget(counted: number, limit: number, estimated = 0): BuildBudget {
  return buildBudget({ buildCreditsBetween: () => ({ credits: counted, estimated, tries: 2 }) }, { maxBuildCreditsPerMonth: limit, timeZone: ZONE }, new Date(local("11 08:00")));
}

/** The night clock's record of a job's slot, as the job's own checks leave it (core, night-clock.ts). */
const slotOf = (job: ClockedJob, at: string) => currentSlot(job, new Date(at), CONFIG);
/** Found due at `noticedAt` and not started: the Mac was asleep at its time, or it is waiting for `waiting`. */
const noticed = (job: ClockedJob, noticedAt: string, waiting: NightWait | null = null): NightRun => waitingRun(noticedRun(slotOf(job, noticedAt), new Date(noticedAt)), waiting);
/** Started at `startedAt`, and closed five minutes later unless it is still going. */
const ran = (job: ClockedJob, startedAt: string, still: "going" | "closed" = "closed"): NightRun => {
  const started = startedRun(noticedRun(slotOf(job, startedAt), new Date(startedAt)), new Date(startedAt));
  return still === "going" ? started : closedRun(started, "done", new Date(Date.parse(startedAt) + 5 * 60_000));
};
const clock = (build: NightRun | null, deliver: NightRun | null = null): Snapshot["nightClock"] => ({ build: { ...NO_RECORDS, record: build }, deliver: { ...NO_RECORDS, record: deliver } });

describe("what stands in the night's way", () => {
  const MORNING = local("11 08:00");
  const outlookOf = (more: Partial<Snapshot> = {}, config: Config = CONFIG): NightOutlook => nightOutlook(snapshot([], { at: MORNING, nextBuildAt: local("12 01:00"), nextDeliverAt: local("12 06:30"), ...more }), config);

  it("is nothing when the data folder holds no reason: the two runs start at their times", () => {
    expect(outlookOf()).toEqual({ build: null, checks: null });
    // Credits counted, and room left. Last night's two runs started and were closed.
    expect(outlookOf({ buildCredits: budget(399.9, 400), nightClock: clock(ran("build", local("11 01:00", 30)), ran("deliver", local("11 06:30", 30))) })).toEqual({ build: null, checks: null });
    // The ledger could not be read: nothing is claimed about it.
    expect(outlookOf({ buildCredits: null })).toEqual({ build: null, checks: null });
  });

  it("says the month's build credits are used up, in the builder's own sentence", () => {
    const used = outlookOf({ buildCredits: budget(10.38, 5, 4.09) });
    expect(used.build).toEqual({
      why: "credits",
      step: "Not tonight: this month's build credits are used up",
      line: "is approved. This month's build credits are used up",
      note: "Not tonight: this month's build credits are used up (10.4 of 5 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised.",
    });
    // The morning's run is not held by it: what is built is still checked and delivered.
    expect(used.checks).toBeNull();
    // Exactly at the limit is reached, as the builder counts it. One hundredth under is not.
    expect(outlookOf({ buildCredits: budget(5, 5) }).build?.why).toBe("credits");
    expect(outlookOf({ buildCredits: budget(4.99, 5) }).build).toBeNull();
  });

  it("says a limit of 0 is a setting, not a month that ran out", () => {
    expect(outlookOf({ buildCredits: budget(0, 0) }).build).toEqual({
      why: "credits",
      step: "Not tonight: the monthly credit limit is 0",
      line: "is approved. Nothing is built while the monthly credit limit is 0",
      note: "Not tonight: MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built: approved ideas wait until it is raised.",
    });
  });

  it("says a folder that holds a rehearsal idea gets no nightly build and no morning run", () => {
    const rehearsal = outlookOf({ rehearsalIdeas: 2 });
    expect(rehearsal.build).toEqual({
      why: "rehearsal",
      step: "Rehearsal folder: no nightly build",
      line: "is approved. No nightly build runs on a rehearsal folder",
      note: "Rehearsal folder: the nightly build does not run here. A rehearsal idea is built by hand, with rehearse run.",
    });
    expect(rehearsal.checks).toEqual({ why: "rehearsal", step: null, line: "No morning run happens on a rehearsal folder" });
    expect(outlookOf({ rehearsalIdeas: 1 }).build?.why).toBe("rehearsal");
  });

  it("shows the demo's night as a real one goes, although its folder holds rehearsal ideas", () => {
    expect(outlookOf({ rehearsalIdeas: 2, demoMark: true })).toEqual({ build: null, checks: null });
  });

  it("says a build is late once its time is two minutes past and it has not started", () => {
    // The Mac slept through 1:00 AM. The last thing its build job stored is the night before's run.
    const sleptThrough = clock(ran("build", local("10 01:00", 30)));
    expect(outlookOf({ nightClock: sleptThrough }).build).toEqual({
      why: "late",
      step: "Running late",
      line: "is approved. The build is running late",
      note: "Running late: the Oct 11, 1:00 AM build has not started yet.",
    });
    // The job has woken and found the slot due: the same, until it starts.
    expect(outlookOf({ nightClock: clock(noticed("build", local("11 07:59"))) }).build?.note).toBe("Running late: the Oct 11, 1:00 AM build has not started yet.");
    // Every night the slot is due for the minute until the job's next check. That is not late.
    const at = (when: string): NightOutlook => outlookOf({ at: when, nightClock: sleptThrough });
    expect(at(local("11 00:59")).build).toBeNull();
    expect(at(local("11 01:00", 59)).build).toBeNull();
    expect(at(local("11 01:01", 59)).build).toBeNull();
    expect(at(local("11 01:02")).build?.why).toBe("late");
    // Late in the evening it is still the Oct 11 build that has not run, and the page says which.
    expect(at(local("11 23:10")).build?.note).toBe("Running late: the Oct 11, 1:00 AM build has not started yet.");
  });

  it("says what a late build is waiting for when the night clock stored it", () => {
    expect(outlookOf({ nightClock: clock(noticed("build", local("11 07:55"), "offline")) }).build).toEqual({
      why: "late",
      step: "as soon as the Mac is online",
      line: "will be built as soon as the Mac is online",
      note: "Running late: the Oct 11, 1:00 AM build is waiting for the internet.",
    });
  });

  it("is not late once the run has started, whether it is still going or over", () => {
    expect(outlookOf({ nightClock: clock(ran("build", local("11 07:58"), "going")), running: { ...IDLE, build: true } }).build).toBeNull();
    expect(outlookOf({ nightClock: clock(ran("build", local("11 01:00", 30))) }).build).toBeNull();
    // Started and never closed, with no build program running: its process died. The job's next check closes it, and it is not started again.
    expect(outlookOf({ nightClock: clock(ran("build", local("11 01:00", 30), "going")), running: { ...IDLE, build: false } }).build).toBeNull();
  });

  it("does not count on tonight while the night clock's record is dated ahead, and points at status", () => {
    const ahead: NightRun = { ...ran("build", local("11 01:00", 30)), day: "2026-10-14" };
    expect(outlookOf({ nightClock: clock(ahead) }).build).toEqual({
      why: "clock-ahead",
      step: "On hold: the build clock is dated ahead",
      line: "is approved. The build clock's record is dated ahead (Oct 14), so the next build may not be tonight's",
      note: "On hold: the build clock's record is dated ahead (Oct 14), so the next build may not be tonight's. See: npx overnight status",
    });
    // Another year's date is given with its year.
    expect(outlookOf({ nightClock: clock({ ...ahead, day: "2027-01-05" }) }).build?.note).toContain("(Jan 5, 2027)");
    const deliverAhead: NightRun = { ...ran("deliver", local("11 06:30", 30)), day: "2026-10-14" };
    expect(outlookOf({ nightClock: clock(null, deliverAhead) }).checks).toEqual({ why: "clock-ahead", step: "On hold: the deliver clock is dated ahead", line: "The deliver clock's record is dated ahead (Oct 14), so the next checks may not be this morning's" });
  });

  it("asks in the order status does: a rehearsal folder, then the credits, then the clock", () => {
    const everything = { rehearsalIdeas: 1, buildCredits: budget(10, 5), nightClock: clock(noticed("build", local("11 07:55"), "offline")) };
    expect(outlookOf(everything).build?.why).toBe("rehearsal");
    expect(outlookOf({ ...everything, rehearsalIdeas: 0 }).build?.why).toBe("credits");
    expect(outlookOf({ ...everything, rehearsalIdeas: 0, buildCredits: budget(1, 5) }).build?.why).toBe("late");
  });

  it("says the same about a morning run that is late: what it waits for, or that it is late", () => {
    const checksOf = (deliver: NightRun | null, more: Partial<Snapshot> = {}) => outlookOf({ nightClock: clock(ran("build", local("11 01:00", 30)), deliver), ...more }).checks;
    expect(checksOf(ran("deliver", local("10 06:30", 30)))).toEqual({ why: "late", step: "Running late", line: "The morning's checks are running late" });
    expect(checksOf(noticed("deliver", local("11 07:55"), "offline"))).toEqual({ why: "late", step: "as soon as the Mac is online", line: "Checks start as soon as the Mac is online" });
    expect(checksOf(noticed("deliver", local("11 07:55"), "build-running"))).toEqual({ why: "late", step: "after the build", line: "Checks start after the build" });
    expect(checksOf(noticed("deliver", local("11 07:55"), "build-not-started"))).toEqual({ why: "late", step: "after the build", line: "Checks start after the build" });
    // On time, going, or over: nothing to say.
    expect(checksOf(ran("deliver", local("11 06:30", 30)))).toBeNull();
    expect(checksOf(ran("deliver", local("11 07:58"), "going"), { running: { ...IDLE, deliver: true } })).toBeNull();
    expect(outlookOf({ at: local("11 06:31"), nightClock: clock(null, ran("deliver", local("10 06:30", 30))) }).checks).toBeNull();
  });

  it("goes by the settings for a job's time", () => {
    const early: Config = { ...CONFIG, buildTime: "23:30" };
    // BUILD_TIME 11:30 PM: at 11:40 PM on Oct 10 that build is ten minutes late, and it is the Oct 10 build.
    const late = nightOutlook(snapshot([], { at: local("10 23:40"), nightClock: clock(ran("build", local("9 23:30", 30))) }), early);
    expect(late.build?.note).toBe("Running late: the Oct 10, 11:30 PM build has not started yet.");
  });

  describe("in an idea's story", () => {
    const credits = outlookOf({ buildCredits: budget(10.38, 5) });
    const rehearsal = outlookOf({ rehearsalIdeas: 1 });
    const offline = outlookOf({ nightClock: clock(noticed("build", local("11 07:55"), "offline"), noticed("deliver", local("11 07:55"), "build-not-started")) });

    it("goes where the Built step's time would be, for an approved idea", () => {
      const built = (outlook: NightOutlook, more: Told = {}) => stepOf(tell(scene("approved"), { now: MORNING, outlook, ...more }), "built");
      expect(built(credits)).toMatchObject({ status: "todo", at: null, detail: "Not tonight: this month's build credits are used up" });
      expect(built(rehearsal)).toMatchObject({ status: "todo", detail: "Rehearsal folder: no nightly build" });
      expect(built(offline)).toMatchObject({ status: "todo", detail: "as soon as the Mac is online" });
      expect(built({ build: null, checks: null })).toMatchObject({ status: "todo", detail: "at 1:00 AM" });
      // Paused is asked first, as status asks it.
      expect(built(credits, { paused: true })).toMatchObject({ detail: "Paused: nothing is built" });
    });

    it("does not promise a nightly build to one that was cut short, where none will take it", () => {
      const cutShort = (outlook?: NightOutlook) => stepOf(tell(scene("build_failed", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }), { now: MORNING, outlook }), "built")?.detail;
      expect(cutShort()).toBe("Cut short. It will be built once more at the next nightly build.");
      expect(cutShort(offline)).toBe("Cut short. It will be built once more at the next nightly build.");
      expect(cutShort(rehearsal)).toBe("Cut short. No nightly build runs on a rehearsal folder: it is built once more by hand, with rehearse run.");
      expect(cutShort(credits)).toBe("Cut short. It will be built once more when the month's build credits allow.");
      // A build that looks cut off, on a rehearsal folder.
      const cutOff = (outlook?: NightOutlook) => stepOf(tell(scene("building"), { now: local("11 03:00"), running: { build: false }, outlook }), "built")?.detail;
      expect(cutOff()).toBe("This build looks cut off. The next nightly build records it and tries once more.");
      expect(cutOff(rehearsal)).toBe("This build looks cut off. No nightly build runs on a rehearsal folder: it is built again by hand, with rehearse run.");
    });

    it("gives no build-now hint on a rehearsal folder, where build-now does not run", () => {
      expect(tell(scene("build_failed"), { outlook: rehearsal }).hint).toBeNull();
      expect(tell(scene("publish_failed"), { outlook: rehearsal }).hint).toBeNull();
      expect(tell(scene("build_failed"), { outlook: credits }).hint).toContain("npx overnight build-now");
    });

    it("goes where the Checked step's time would be, for a build that waits for the morning", () => {
      const checked = (state: IdeaState, outlook?: NightOutlook) => stepOf(tell(scene(state), { now: MORNING, running: { build: state === "building" }, outlook }), "checked");
      expect(checked("built")).toMatchObject({ status: "todo", detail: "at 6:30 AM" });
      expect(checked("built", offline)).toMatchObject({ status: "todo", detail: "after the build" });
      expect(checked("building", offline)).toMatchObject({ status: "todo", detail: "after the build" });
      // A rehearsal folder has no morning run, so no time is named at all.
      expect(checked("built", rehearsal)).toMatchObject({ status: "todo", detail: null });
      // The credits do not hold the morning.
      expect(checked("built", credits)).toMatchObject({ detail: "at 6:30 AM" });
      // An app that is out, with its last step still to do: no deliver run is promised where none runs.
      const lastStep = (outlook?: NightOutlook) => stepOf(tell(scene("published"), { now: MORNING, outlook }), "delivered")?.detail;
      expect(lastStep()).toBe("Not finished yet. The next deliver run does that.");
      expect(lastStep(offline)).toBe("Not finished yet. The next deliver run does that.");
      expect(lastStep(rehearsal)).toBe("Not finished yet.");
    });
  });

  describe("in the line over the hero", () => {
    const said = (state: IdeaState, look: Partial<Snapshot>, more: Partial<DashIdea> = {}): string => {
      const hero = scene(state, { title: "Chore Wheel", ...more });
      const line = nowLine(snapshot([hero], { at: MORNING, ...look }), hero.idea, CONFIG);
      return [line.before, `“${line.title}”`, line.after].filter((part) => part !== "").join(" ");
    };

    it("does not say an approved idea will be built at 1:00 AM when it will not", () => {
      expect(said("approved", {})).toBe("“Chore Wheel” will be built at 1:00 AM");
      expect(said("approved", { buildCredits: budget(10.38, 5) })).toBe("“Chore Wheel” is approved. This month's build credits are used up");
      expect(said("approved", { buildCredits: budget(0, 0) })).toBe("“Chore Wheel” is approved. Nothing is built while the monthly credit limit is 0");
      expect(said("approved", { rehearsalIdeas: 1 }, { rehearsal: true })).toBe("“Chore Wheel” is approved. No nightly build runs on a rehearsal folder");
      expect(said("approved", { nightClock: clock(noticed("build", local("11 07:55"), "offline")) })).toBe("“Chore Wheel” will be built as soon as the Mac is online");
      expect(said("approved", { nightClock: clock(ran("build", local("10 01:00", 30))) })).toBe("“Chore Wheel” is approved. The build is running late");
      // Paused is asked first.
      expect(said("approved", { paused: true, buildCredits: budget(10.38, 5) })).toBe("“Chore Wheel” is approved. Building is paused");
    });

    it("does not say checks start at 6:30 AM when the morning's run is late", () => {
      const built = clock(ran("build", local("11 01:00", 30)), noticed("deliver", local("11 07:55"), "offline"));
      expect(said("built", {})).toBe("“Chore Wheel” is built. Checks start at 6:30 AM");
      expect(said("built", { nightClock: built })).toBe("“Chore Wheel” is built. Checks start as soon as the Mac is online");
      expect(said("built", { nightClock: clock(null, ran("deliver", local("10 06:30", 30))) })).toBe("“Chore Wheel” is built. The morning's checks are running late");
      expect(said("built", { rehearsalIdeas: 1 })).toBe("“Chore Wheel” is built. No morning run happens on a rehearsal folder");
      // The line about the night says the same.
      const night = (look: Partial<Snapshot>): string | undefined => groupNights(snapshot([scene("built")], { at: MORNING, ...look }), CONFIG)[0]?.headline;
      expect(night({})).toBe("Built. Checks start at 6:30 AM.");
      expect(night({ nightClock: built })).toBe("Built. Checks start as soon as the Mac is online.");
    });
  });

  describe("in tonight's queue", () => {
    const approved = [scene("approved", { title: "One", answeredAt: local("10 10:00") }), scene("approved", { title: "Two", answeredAt: local("10 11:00") }), scene("approved", { title: "Three", answeredAt: local("10 12:00") })];
    const queueOf = (more: Partial<Snapshot>) => tonightQueue(snapshot(approved, { at: MORNING, ...more }), CONFIG);

    it("carries why the rows will not be built at the build's time", () => {
      expect(queueOf({}).hold).toBeNull();
      expect(queueOf({ buildCredits: budget(10.38, 5) }).hold?.why).toBe("credits");
      expect(queueOf({ rehearsalIdeas: 3 }).hold?.why).toBe("rehearsal");
      expect(queueOf({ nightClock: clock(noticed("build", local("11 07:55"), "offline")) }).hold?.why).toBe("late");
      // While paused, `paused` says it and nothing else is given.
      expect(queueOf({ paused: true, buildCredits: budget(10.38, 5) })).toMatchObject({ paused: true, hold: null });
    });

    it("counts a late build's room in the day it will run, which is today", () => {
      const rows = (more: Partial<Snapshot>): string[] => tonightQueue(snapshot([...approved, byHand], { at: MORNING, ...more }), CONFIG).rows.map((row) => `${row.idea.title}: ${row.when}`);
      // One build was started by hand at 12:10 AM today. The next nightly build is tomorrow's, with all its room.
      const byHand = scene("delivered", { title: "By hand" }, [["heard", T.heard], ["asked", T.asked], ["approved", T.approved], ["building", local("11 00:10")], ["built", local("11 00:12")], ["published", local("11 00:13")], ["delivered", local("11 00:13", 5)]]);
      expect(rows({})).toEqual(["One: tonight", "Two: tonight", "Three: later"]);
      // Last night's build is late and runs today: today's one start leaves it room for one.
      expect(rows({ nightClock: clock(ran("build", local("10 01:00", 30))) })).toEqual(["One: tonight", "Two: later", "Three: later"]);
    });
  });
});

describe("which night a moment belongs to", () => {
  it("runs from local noon to local noon and is named by its morning", () => {
    expect(nightKey(local("10 12:00"), ZONE)).toBe("2026-10-11");
    expect(nightKey(local("10 23:00"), ZONE)).toBe("2026-10-11");
    expect(nightKey(local("11 01:00"), ZONE)).toBe("2026-10-11");
    expect(nightKey(local("11 07:00"), ZONE)).toBe("2026-10-11");
    expect(nightKey(local("11 11:59"), ZONE)).toBe("2026-10-11");
    expect(nightKey(local("11 12:00"), ZONE)).toBe("2026-10-12");
    expect(nightKey(local("10 11:59"), ZONE)).toBe("2026-10-10");
  });

  it("takes a Date as well as a time written out", () => {
    expect(nightKey(new Date(local("11 01:00")), ZONE)).toBe("2026-10-11");
  });

  it("goes by the time zone it is given", () => {
    // 05:30 UTC on Oct 11 is 11:30 PM on Oct 10 in Boise and 2:30 PM on Oct 11 in Tokyo.
    expect(nightKey("2026-10-11T05:30:00.000Z", ZONE)).toBe("2026-10-11");
    expect(nightKey("2026-10-11T05:30:00.000Z", "Asia/Tokyo")).toBe("2026-10-12");
  });

  it("keeps to noon on the night the clocks go back (Nov 1, a 25-hour day)", () => {
    expect(nightKey("2026-10-31T17:59:00.000Z", ZONE)).toBe("2026-10-31"); // 11:59 AM on Oct 31
    expect(nightKey("2026-10-31T18:00:00.000Z", ZONE)).toBe("2026-11-01"); // noon on Oct 31
    expect(nightKey("2026-11-01T07:30:00.000Z", ZONE)).toBe("2026-11-01"); // the first 1:30 AM
    expect(nightKey("2026-11-01T08:30:00.000Z", ZONE)).toBe("2026-11-01"); // the second 1:30 AM
    expect(nightKey("2026-11-01T18:59:00.000Z", ZONE)).toBe("2026-11-01"); // 11:59 AM on Nov 1
    expect(nightKey("2026-11-01T19:00:00.000Z", ZONE)).toBe("2026-11-02"); // noon on Nov 1
  });

  it("keeps to noon on the night the clocks go forward (Mar 8, a 23-hour day)", () => {
    expect(nightKey("2026-03-07T18:59:00.000Z", ZONE)).toBe("2026-03-07"); // 11:59 AM on Mar 7
    expect(nightKey("2026-03-07T19:00:00.000Z", ZONE)).toBe("2026-03-08"); // noon on Mar 7
    expect(nightKey("2026-03-08T08:30:00.000Z", ZONE)).toBe("2026-03-08"); // 1:30 AM, before the change
    expect(nightKey("2026-03-08T17:59:00.000Z", ZONE)).toBe("2026-03-08"); // 11:59 AM on Mar 8
    expect(nightKey("2026-03-08T18:00:00.000Z", ZONE)).toBe("2026-03-09"); // noon on Mar 8
  });
});

describe("where the day on the Today page starts", () => {
  const start = (at: string, config: Pick<Config, "deliverTime" | "timeZone"> = CONFIG): string => overnightDayStart(new Date(at), config).toISOString();

  it("is the latest DELIVER_TIME at or before now, so 1:00 AM still belongs to yesterday", () => {
    expect(start(local("11 01:00"))).toBe(local("10 07:00"));
    expect(start(local("11 06:59"))).toBe(local("10 07:00"));
    expect(start(local("11 07:00"))).toBe(local("11 07:00"));
    expect(start(local("11 07:01"))).toBe(local("11 07:00"));
    expect(start(local("11 23:30"))).toBe(local("11 07:00"));
  });

  it("goes by the settings", () => {
    expect(start(local("11 06:59"), { deliverTime: "06:15", timeZone: ZONE })).toBe(local("11 06:15"));
    expect(start("2026-10-11T07:00:00.000Z", { deliverTime: "07:00", timeZone: "Asia/Tokyo" })).toBe("2026-10-10T22:00:00.000Z");
  });

  it("is right on the night the clocks go back: that day is 25 hours long", () => {
    expect(start("2026-11-01T07:30:00.000Z")).toBe("2026-10-31T13:00:00.000Z"); // the first 1:30 AM
    expect(start("2026-11-01T08:30:00.000Z")).toBe("2026-10-31T13:00:00.000Z"); // the second 1:30 AM
    expect(start("2026-11-01T13:59:00.000Z")).toBe("2026-10-31T13:00:00.000Z"); // 6:59 AM, 24 h 59 min later
    expect(start("2026-11-01T14:00:00.000Z")).toBe("2026-11-01T14:00:00.000Z"); // 7:00 AM
  });

  it("is right on the night the clocks go forward: that day is 23 hours long", () => {
    expect(start("2026-03-08T08:00:00.000Z")).toBe("2026-03-07T14:00:00.000Z"); // 1:00 AM
    expect(start("2026-03-08T12:59:00.000Z")).toBe("2026-03-07T14:00:00.000Z"); // 6:59 AM
    expect(start("2026-03-08T13:00:00.000Z")).toBe("2026-03-08T13:00:00.000Z"); // 7:00 AM
  });
});

describe("nights", () => {
  const BUILD_RUN: BuildRun = { command: "build", startedAt: local("11 01:00"), finishedAt: local("11 01:03"), waiting: 1, taking: 1, built: 1, failed: 0, paused: false, nothingApproved: false, slept: false, sandboxCheck: { at: local("11 01:00", 9), ok: true, ms: 7100, reused: false }, ideaIds: [] };
  const DELIVER_RUN: DeliverRun = { command: "build", startedAt: local("11 06:30"), finishedAt: local("11 06:32"), delivered: 1, failed: 0, notified: 0, slept: false, ideaIds: [] };
  const titled = (state: IdeaState, title: string, more: Partial<DashIdea> = {}, way?: Array<[IdeaState, string]>) => scene(state, { title, ...more }, way);
  const headline = (given: Array<{ idea: DashIdea; events: IdeaEvent[] }>, look: Partial<Snapshot> = {}): string | undefined => groupNights(snapshot(given, look), CONFIG)[0]?.headline;

  it("puts an idea in the night it was built and delivered in, with what the log knows about it", () => {
    const delivered = titled("delivered", "Packing Checklist");
    const look = snapshot([delivered, titled("asked", "Only asked")], { at: local("11 08:00"), build: new Map([[delivered.idea.id, BUILT_TICKS]]), buildRuns: [BUILD_RUN], deliverRuns: [DELIVER_RUN] });
    expect(groupNights(look, CONFIG)).toEqual([
      {
        key: "2026-10-11",
        label: "Sat, Oct 10 to Sun, Oct 11",
        headline: "Worked: 1 app built and delivered.",
        ideas: [{ idea: delivered.idea, outcome: "delivered", buildSeconds: 160, credits: 4.59, by: "build", cutShort: false }],
        built: 1,
        failed: 0,
        cutShort: 0,
        delivered: 1,
        credits: 4.59,
        buildRun: BUILD_RUN,
        deliverRun: DELIVER_RUN,
      },
    ]);
  });

  it("gives no build time to the build a run was on when the Mac went to sleep, and keeps the times of what it built before", () => {
    // 1:00 AM: built in three minutes. 1:04 AM: the next build starts, the lid is closed, and the Mac wakes at 7:10 AM.
    const before = titled("built", "Built before the sleep", {}, [...WAY_TO.approved, ["building", local("11 01:00")], ["built", local("11 01:03")]]);
    const during = titled("build_failed", "Slept through", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON }, [...WAY_TO.approved, ["building", local("11 01:04")], ["build_failed", local("11 07:10")]]);
    const sleptRun: BuildRun = { ...BUILD_RUN, finishedAt: local("11 07:10", 2), built: 1, failed: 1, slept: true };
    const night = (look: Partial<Snapshot>) => groupNights(snapshot([before, during], { at: local("11 08:00"), ...look }), CONFIG)[0];
    const rows = (look: Partial<Snapshot>) => night(look)?.ideas.map((row) => [row.idea.title, row.buildSeconds, row.cutShort]);

    // The run's own line is enough, whatever the log still holds about the idea.
    expect(rows({ buildRuns: [sleptRun] })).toEqual([["Built before the sleep", 180, false], ["Slept through", null, true]]);
    expect(night({ buildRuns: [sleptRun] })).toMatchObject({ built: 1, failed: 0, cutShort: 1, buildRun: { slept: true } });
    // So is the idea's own tick, when the run's line has scrolled out of the part of the log that is read.
    const sleptTicks: BuildFacts = { ...BUILD_TICKS, startedAt: local("11 01:04", 1), slept: { at: local("11 07:10") }, finished: { at: local("11 07:10"), ok: false, seconds: null, credits: null } };
    expect(rows({ build: new Map([[during.idea.id, sleptTicks]]) })).toEqual([["Built before the sleep", 180, false], ["Slept through", null, true]]);
    // With neither, all there is to go by is the timeline, as before: six hours.
    expect(rows({})).toEqual([["Built before the sleep", 180, false], ["Slept through", 21_960, true]]);
    // A run that slept on another night says nothing about this one.
    const otherNight: BuildRun = { ...sleptRun, startedAt: local("10 01:00"), finishedAt: local("10 07:00") };
    expect(rows({ buildRuns: [otherNight] })?.[1]).toEqual(["Slept through", 21_960, true]);
    // Nor does one that began after this build did.
    const later: BuildRun = { ...sleptRun, startedAt: local("11 02:00") };
    expect(rows({ buildRuns: [later] })?.[1]).toEqual(["Slept through", 21_960, true]);
  });

  it("works from the timeline alone when there is no log", () => {
    const night = groupNights(snapshot([titled("delivered", "Packing Checklist")], { at: local("11 08:00") }), CONFIG)[0];
    expect(night).toMatchObject({ key: "2026-10-11", built: 1, delivered: 1, failed: 0, credits: null, buildRun: null, deliverRun: null });
    expect(night?.ideas[0]).toMatchObject({ outcome: "delivered", buildSeconds: 160, credits: null, by: null });
  });

  it("does not give a night the log's ticks of a build from another night", () => {
    const delivered = titled("delivered", "Packing Checklist");
    const otherNight: BuildFacts = { ...BUILT_TICKS, startedAt: local("9 01:00"), finished: { at: local("9 01:05"), ok: true, seconds: 999, credits: 9 } };
    const night = groupNights(snapshot([delivered], { build: new Map([[delivered.idea.id, otherNight]]) }), CONFIG)[0];
    expect(night?.ideas[0]).toMatchObject({ buildSeconds: 160, credits: null, by: null });
  });

  it("lists nights newest first, an idea in every night it was worked on, and the ideas of a night in the order they were built", () => {
    const retried = titled("delivered", "Tried twice", {}, [
      ["heard", local("8 12:00")], ["asked", local("8 12:01")], ["approved", local("8 12:02")],
      ["building", local("9 01:00")], ["build_failed", local("9 01:30")],
      ["building", local("10 01:10")], ["built", local("10 01:13")], ["published", local("10 06:31")], ["delivered", local("10 06:32")],
    ]);
    const first = titled("delivered", "Built first", {}, [["heard", local("8 12:00")], ["asked", local("8 12:01")], ["approved", local("8 12:02")], ["building", local("10 01:00")], ["built", local("10 01:05")], ["published", local("10 06:30")], ["delivered", local("10 06:31")]]);
    const tonight = titled("building", "Tonight's");
    const nights = groupNights(snapshot([tonight, retried, first]), CONFIG);
    expect(nights.map((night) => [night.key, night.label, night.ideas.map((row) => `${row.idea.title}: ${row.outcome}`)])).toEqual([
      ["2026-10-11", "Sat, Oct 10 to Sun, Oct 11", ["Tonight's: building"]],
      ["2026-10-10", "Fri, Oct 9 to Sat, Oct 10", ["Built first: delivered", "Tried twice: delivered"]],
      ["2026-10-09", "Thu, Oct 8 to Fri, Oct 9", ["Tried twice: build_failed"]],
    ]);
    expect(nights.map((night) => night.headline)).toEqual(["Building now.", "Worked: 2 apps built and delivered.", "Did not work."]);
    expect(nights.map((night) => [night.built, night.delivered, night.failed])).toEqual([[0, 0, 0], [2, 2, 0], [0, 0, 1]]);
    expect(nights[2]?.ideas[0]?.buildSeconds).toBe(1800);
  });

  it("names a night that crosses a month's end", () => {
    const way: Array<[IdeaState, string]> = [["heard", "2026-10-31T18:00:00.000Z"], ["asked", "2026-10-31T18:01:00.000Z"], ["approved", "2026-10-31T18:02:00.000Z"], ["building", "2026-11-01T07:00:00.000Z"], ["built", "2026-11-01T07:03:00.000Z"]];
    expect(groupNights(snapshot([titled("built", "Halloween", {}, way)]), CONFIG).map((night) => [night.key, night.label])).toEqual([["2026-11-01", "Sat, Oct 31 to Sun, Nov 1"]]);
  });

  it("keeps the last 14 nights", () => {
    const many = Array.from({ length: 20 }, (_, n) => {
      const day = Date.UTC(2026, 8, 1 + n, 7, 0, 0);
      const iso = (minutes: number): string => new Date(day + minutes * 60_000).toISOString();
      return titled("delivered", `Night ${n}`, {}, [["heard", iso(-600)], ["asked", iso(-590)], ["approved", iso(-580)], ["building", iso(0)], ["built", iso(3)], ["published", iso(330)], ["delivered", iso(331)]]);
    });
    const nights = groupNights(snapshot(many), CONFIG);
    expect(nights).toHaveLength(14);
    expect([nights[0]?.key, nights[13]?.key]).toEqual(["2026-09-20", "2026-09-07"]);
  });

  it("makes a night of a run that touched no idea", () => {
    const paused: BuildRun = { ...BUILD_RUN, waiting: null, taking: null, built: 0, paused: true, sandboxCheck: null };
    const nothing: BuildRun = { ...BUILD_RUN, startedAt: local("10 01:00"), finishedAt: local("10 01:00", 1), waiting: null, taking: null, built: 0, nothingApproved: true, sandboxCheck: null };
    const plain: BuildRun = { ...nothing, startedAt: local("9 01:00"), finishedAt: null, nothingApproved: false };
    const nights = groupNights(snapshot([], { buildRuns: [plain, nothing, paused], deliverRuns: [DELIVER_RUN] }), CONFIG);
    expect(nights.map((night) => [night.key, night.headline, night.ideas.length])).toEqual([
      ["2026-10-11", "Paused: nothing was built.", 0],
      ["2026-10-10", "Nothing was approved, so nothing was built.", 0],
      ["2026-10-09", "Nothing was built.", 0],
    ]);
    expect(nights[0]).toMatchObject({ buildRun: paused, deliverRun: DELIVER_RUN, built: 0, failed: 0, delivered: 0, credits: null });
  });

  it("shows the nightly job's run when a night also had runs by hand", () => {
    const byHand: BuildRun = { ...BUILD_RUN, command: "build-now", startedAt: local("11 03:00"), finishedAt: local("11 03:05") };
    const rehearsal: BuildRun = { ...BUILD_RUN, command: "rehearse", startedAt: local("10 15:00"), finishedAt: local("10 15:05") };
    const handDeliver: DeliverRun = { ...DELIVER_RUN, command: "build-now", startedAt: local("11 03:05") };
    const both = groupNights(snapshot([], { buildRuns: [rehearsal, BUILD_RUN, byHand], deliverRuns: [handDeliver, DELIVER_RUN] }), CONFIG)[0];
    expect([both?.buildRun, both?.deliverRun]).toEqual([BUILD_RUN, DELIVER_RUN]);
    const handOnly = groupNights(snapshot([], { buildRuns: [rehearsal, byHand], deliverRuns: [handDeliver] }), CONFIG)[0];
    expect([handOnly?.buildRun, handOnly?.deliverRun]).toEqual([byHand, handDeliver]);
  });

  it("adds up the credits it knows of", () => {
    const one = titled("delivered", "One");
    const two = titled("delivered", "Two");
    const three = titled("delivered", "Three");
    const ticks = (credits: number | null): BuildFacts => ({ ...BUILT_TICKS, finished: { at: T.built, ok: true, seconds: 100, credits } });
    const night = groupNights(snapshot([one, two, three], { build: new Map([[one.idea.id, ticks(0.1)], [two.idea.id, ticks(0.2)], [three.idea.id, ticks(null)]]) }), CONFIG)[0];
    expect(night?.credits).toBe(0.3);
  });

  describe("the headline", () => {
    it("Building now.", () => {
      expect(headline([titled("building", "A"), titled("delivered", "B")])).toBe("Building now.");
    });

    it("Built. Checks start at 6:30 AM.", () => {
      expect(headline([titled("built", "A")])).toBe("Built. Checks start at 6:30 AM.");
      expect(headline([titled("built", "A"), titled("build_failed", "B")])).toBe("Built. Checks start at 6:30 AM.");
      expect(headline([titled("published", "A")])).toBe("Built. Checks start at 6:30 AM.");
      // Still true the next morning, until the checks have run.
      expect(headline([titled("built", "A")], { at: local("11 06:00") })).toBe("Built. Checks start at 6:30 AM.");
      expect(headline([titled("built", "A")], { at: local("11 23:59") })).toBe("Built. Checks start at 6:30 AM.");
      expect(groupNights(snapshot([titled("built", "A")]), { ...CONFIG, deliverTime: "13:15" })[0]?.headline).toBe("Built. Checks start at 12:45 PM.");
    });

    // At 7:00 AM, with the morning's run at work, the line used to go on saying "Checks start at 6:30 AM".
    it("Built. The morning's checks are running now: while the morning's run is at work", () => {
      const morning = { at: local("11 06:31"), running: { listener: true, build: false, deliver: true } };
      expect(headline([titled("built", "A")], morning)).toBe("Built. The morning's checks are running now.");
      expect(headline([titled("delivered", "A"), titled("published", "B")], morning)).toBe("Built. The morning's checks are running now.");
      // Whether a deliver is running cannot be told: the usual line.
      expect(headline([titled("built", "A")], { ...morning, running: { listener: true, build: false, deliver: null } })).toBe("Built. Checks start at 6:30 AM.");
      // A deliver started by hand takes only its own idea: the app built last night still waits for the morning.
      const byHand: DeliverRun = { command: "build-now", startedAt: local("11 06:31"), finishedAt: null, delivered: null, failed: null, notified: null, slept: false, ideaIds: [] };
      expect(headline([titled("built", "A")], { ...morning, deliverRuns: [byHand] })).toBe("Built. Checks start at 6:30 AM.");
      expect(headline([titled("built", "A")], { ...morning, deliverRuns: [{ ...byHand, command: "build" }] })).toBe("Built. The morning's checks are running now.");
      // Nothing is promised for a night long past, whatever is running now.
      expect(headline([titled("built", "A")], { at: local("12 06:31"), running: morning.running })).toBe("Built, but not delivered.");
      // And a night whose apps are all delivered is not touched by it.
      expect(headline([titled("delivered", "A")], morning)).toBe("Worked: 1 app built and delivered.");
    });

    it("Built, but not delivered: for a night long past, no checks are promised", () => {
      expect(headline([titled("built", "A")], { at: local("12 00:00") })).toBe("Built, but not delivered.");
      expect(headline([titled("published", "A"), titled("build_failed", "B")], { at: local("14 09:00") })).toBe("Built, but not delivered.");
    });

    it("Worked: 1 app built and delivered.", () => {
      expect(headline([titled("delivered", "A")])).toBe("Worked: 1 app built and delivered.");
    });

    it("1 of 2 worked.", () => {
      expect(headline([titled("delivered", "A"), titled("build_failed", "B")])).toBe("1 of 2 worked.");
      expect(headline([titled("delivered", "A"), titled("publish_failed", "B"), titled("delivered", "C")])).toBe("2 of 3 worked.");
    });

    it("Did not work.", () => {
      expect(headline([titled("build_failed", "A")])).toBe("Did not work.");
      expect(headline([titled("publish_failed", "A"), titled("build_failed", "B")])).toBe("Did not work.");
    });

    // A build that was cut short and waits for its one more try used to count as a failure: after two
    // apps were delivered and none failed, the night read "2 of 3 worked."
    it("leaves a build that was cut short out of the count, and says it on its own", () => {
      const cutShort = (title: string) => titled("build_failed", title, { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON });
      expect(headline([titled("delivered", "A"), titled("delivered", "B"), cutShort("C")])).toBe("Worked: 2 apps built and delivered. 1 cut short, to be built once more.");
      expect(headline([titled("delivered", "A"), cutShort("B")])).toBe("Worked: 1 app built and delivered. 1 cut short, to be built once more.");
      expect(headline([titled("delivered", "A"), titled("build_failed", "B"), cutShort("C"), cutShort("D")])).toBe("1 of 2 worked. 2 cut short, to be built once more.");
      expect(headline([cutShort("A"), titled("build_failed", "B")])).toBe("Did not work. 1 cut short, to be built once more.");
      // While something is still to come that night, that comes first, as before.
      expect(headline([titled("building", "A"), cutShort("B")])).toBe("Building now.");
      expect(headline([titled("built", "A"), cutShort("B")])).toBe("Built. Checks start at 6:30 AM.");
    });

    it("counts a build that was cut short as cut short, not as failed, and marks its row", () => {
      const cutShort = titled("build_failed", "Cut short", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON });
      const night = groupNights(snapshot([titled("delivered", "Delivered"), cutShort, titled("build_failed", "Failed for good")]), CONFIG)[0];
      expect(night).toMatchObject({ built: 1, delivered: 1, failed: 1, cutShort: 1 });
      expect(night?.ideas.map((row) => `${row.idea.title}: ${row.cutShort}`).sort()).toEqual(["Cut short: true", "Delivered: false", "Failed for good: false"]);
      // A night with nothing cut short says none.
      expect(groupNights(snapshot([titled("delivered", "Delivered"), titled("build_failed", "Failed for good")]), CONFIG)[0]).toMatchObject({ failed: 1, cutShort: 0 });
    });

    it("Cut short. It will be built once more.", () => {
      expect(headline([titled("build_failed", "A", { awaitingRetry: true, failureReason: BUILD_STOPPED_REASON })])).toBe("Cut short. It will be built once more.");
    });

    it("does not say 'Building now.' for ever about a build that was cut off on a night long past", () => {
      // Left "building" on the night of Oct 9; found and marked failed by the next night's run.
      const cutOff = titled("build_failed", "Cut off", { awaitingRetry: true }, [["heard", local("8 12:00")], ["asked", local("8 12:01")], ["approved", local("8 12:02")], ["building", local("9 01:00")], ["build_failed", local("10 01:00")]]);
      const nights = groupNights(snapshot([cutOff]), CONFIG);
      expect(nights.map((night) => [night.key, night.ideas[0]?.outcome, night.headline])).toEqual([
        ["2026-10-10", "build_failed", "Cut short. It will be built once more."],
        ["2026-10-09", "building", "Cut short. It will be built once more."],
      ]);
      expect(nights.map((night) => [night.failed, night.cutShort, night.ideas[0]?.cutShort])).toEqual([[0, 1, true], [0, 1, true]]);
      const forGood = titled("build_failed", "Cut off twice", {}, [["heard", local("8 12:00")], ["asked", local("8 12:01")], ["approved", local("8 12:02")], ["building", local("9 01:00")], ["build_failed", local("10 01:00")]]);
      expect(groupNights(snapshot([forGood]), CONFIG).map((night) => night.headline)).toEqual(["Did not work.", "Did not work."]);
    });

    it("counts an app built before noon and delivered after it as one that worked", () => {
      const straddling = titled("delivered", "Built at 11:58", {}, [["heard", local("10 09:00")], ["asked", local("10 09:01")], ["approved", local("10 09:02")], ["building", local("10 11:55")], ["built", local("10 11:58")], ["published", local("10 12:01")], ["delivered", local("10 12:02")]]);
      const nights = groupNights(snapshot([straddling]), CONFIG);
      expect(nights.map((night) => [night.key, night.ideas[0]?.outcome, night.headline, night.built, night.delivered])).toEqual([
        ["2026-10-11", "delivered", "Worked: 1 app built and delivered.", 0, 1],
        ["2026-10-10", "built", "Worked: 1 app built and delivered.", 1, 1],
      ]);
    });
  });
});

describe("the night to mention on the Today page", () => {
  const nightsOf = (look: Snapshot) => groupNights(look, CONFIG);
  const nights = nightsOf(snapshot([scene("delivered", { title: "Packing Checklist" })]));

  it("is the one named by today's date: 'Tonight' until the morning's checks start, then 'Last night'", () => {
    const label = (at: string): string | undefined => lastNightOf(nights, new Date(at), CONFIG)?.label;
    expect(lastNightOf(nights, new Date(local("11 01:02")), CONFIG)?.night.key).toBe("2026-10-11");
    expect([label(local("11 00:10")), label(local("11 01:02")), label(local("11 06:29"))]).toEqual(["Tonight", "Tonight", "Tonight"]);
    expect([label(local("11 06:30")), label(local("11 07:00")), label(local("11 15:00")), label(local("11 23:59"))]).toEqual(["Last night", "Last night", "Last night", "Last night"]);
  });

  it("is nothing when no night bears today's date", () => {
    expect(lastNightOf(nights, new Date(local("10 22:00")), CONFIG)).toBeNull();
    expect(lastNightOf(nights, new Date(local("12 08:00")), CONFIG)).toBeNull();
    expect(lastNightOf([], new Date(local("11 08:00")), CONFIG)).toBeNull();
  });

  it("goes by the settings for when the checks start", () => {
    const late: Config = { ...CONFIG, deliverTime: "09:00" };
    expect(lastNightOf(nights, new Date(local("11 08:29")), late)?.label).toBe("Tonight");
    expect(lastNightOf(nights, new Date(local("11 08:30")), late)?.label).toBe("Last night");
  });
});

describe("how often the page asks again", () => {
  const quiet = snapshot([scene("delivered"), scene("approved")], { at: local("10 15:00"), nextBuildAt: local("11 01:00"), nextDeliverAt: local("11 06:30") });
  const now = new Date(local("10 15:00"));

  it("every 5 seconds when nothing is happening", () => {
    expect(pollMsFor(quiet, now)).toBe(5000);
    expect(pollMsFor({ ...quiet, running: { listener: null, build: null, deliver: null } }, now)).toBe(5000);
  });

  it("every 2 seconds while a build or a deliver run is going", () => {
    expect(pollMsFor({ ...quiet, running: { ...IDLE, build: true } }, now)).toBe(2000);
    expect(pollMsFor({ ...quiet, running: { ...IDLE, deliver: true } }, now)).toBe(2000);
  });

  it("every 2 seconds while an idea is marked as being built", () => {
    expect(pollMsFor(snapshot([scene("building")], { at: local("10 15:00") }), now)).toBe(2000);
  });

  it("every 2 seconds in the minute before a build or the morning's checks start", () => {
    expect(pollMsFor(quiet, new Date(local("11 00:58", 59)))).toBe(5000);
    expect(pollMsFor(quiet, new Date(local("11 00:59")))).toBe(2000);
    expect(pollMsFor(quiet, new Date(local("11 01:00")))).toBe(2000);
    expect(pollMsFor(quiet, new Date(local("11 01:00", 1)))).toBe(5000);
    expect(pollMsFor(quiet, new Date(local("11 06:29", 30)))).toBe(2000);
  });
});
