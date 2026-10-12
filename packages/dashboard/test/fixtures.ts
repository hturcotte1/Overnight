// SYNTHETIC data: every title, pitch, quote, name, time and number in this file is made up. None of it is Bee data.
//
// Small builders for the page tests, so the views can be tried without the data package: an idea,
// its story, a snapshot, and one whole scene (1:02 AM, one app being built) that matches the
// design round's reference picture.
import { parseConfig } from "@overnight/core";
import type { Config, IdeaEvent, IdeaState } from "@overnight/core";
import type { BuildFacts, Chrome, DashIdea, DeliverFacts, IdeaExtras, Night, RenderContext, ReportView, Snapshot, StepKey, StepStatus, Story, StoryStep, TonightQueue } from "../src/types.ts";

export const TIME_ZONE = "America/Boise";
/** An invented account's home folder. No page may ever show it: only "~". */
export const HOME = "/Users/sam";

/** A time on an October 2026 day in America/Boise (six hours behind UTC that month), as the database stores it. */
export function boise(day: number, hour: number, minute = 0, second = 0): string {
  return new Date(Date.UTC(2026, 9, day, hour + 6, minute, second)).toISOString();
}

/** The scene's "now": Sunday, Oct 11, 1:02 AM. */
export const NOW = new Date(boise(11, 1, 2));
/** Where the scene's day began: Saturday, Oct 10, 7:00 AM (the latest DELIVER_TIME). */
export const DAY_START = boise(10, 7);

export function fakeConfig(env: Record<string, string> = {}): Config {
  return parseConfig({ OVERNIGHT_DATA_DIR: `${HOME}/.overnight`, PAUSED: "false", ...env });
}

export function fakeContext(over: Partial<RenderContext> = {}): RenderContext {
  return { now: NOW, config: fakeConfig(), home: HOME, filming: { on: false, showQuoteFor: new Set() }, ...over };
}

export function fakeChrome(over: Partial<Chrome> = {}): Chrome {
  return {
    current: "today",
    running: { listener: true, build: true, deliver: false },
    paused: false,
    filming: false,
    demo: true,
    problem: null,
    staleSince: null,
    nowMs: NOW.getTime(),
    timeZone: TIME_ZONE,
    pollMs: 2000,
    ...over,
  };
}

let nextId = 0;

/** An idea, approved at lunchtime on the scene's day unless told otherwise. */
export function fakeIdea(over: Partial<DashIdea> = {}): DashIdea {
  nextId += 1;
  return {
    id: `idea_20261010_${String(nextId).padStart(4, "0")}`,
    state: "approved",
    title: "Lunch Turns",
    pitch: "Take turns picking where to eat. Add names, tap once, and see whose turn it is.",
    quote: { shown: true, text: "we always argue about who picks lunch" },
    hidden: false,
    rehearsal: false,
    confidence: 0.9,
    createdAt: boise(10, 15, 8),
    updatedAt: boise(10, 15, 15),
    askedAt: boise(10, 15, 10),
    askExpiresAt: boise(10, 23),
    answeredAt: boise(10, 15, 15),
    note: null,
    slug: null,
    buildBackend: null,
    buildStartedAt: null,
    builtAt: null,
    publishedUrl: null,
    publishedAt: null,
    deliveredAt: null,
    failureReason: null,
    failureNotifiedAt: null,
    buildStarts: 0,
    awaitingRetry: false,
    hasMorningTodo: false,
    hasFact: false,
    ...over,
  };
}

const STEP_LABELS: Readonly<Record<StepKey, string>> = { heard: "Heard", asked: "Asked", approved: "Approved", built: "Built", checked: "Checked", published: "Published", delivered: "Delivered" };
const STEP_KEYS = Object.keys(STEP_LABELS) as StepKey[];

/** Which of the seven steps are done, active and so on for an idea in each state (a short form of the design's story rules). */
const STATUSES: Readonly<Record<IdeaState, readonly StepStatus[]>> = {
  heard: ["done", "waiting", "todo", "todo", "todo", "todo", "todo"],
  asked: ["done", "done", "active", "todo", "todo", "todo", "todo"],
  approved: ["done", "done", "done", "todo", "todo", "todo", "todo"],
  rejected: ["done", "done", "ended", "ended", "ended", "ended", "ended"],
  expired: ["done", "done", "ended", "ended", "ended", "ended", "ended"],
  building: ["done", "done", "done", "active", "todo", "todo", "todo"],
  built: ["done", "done", "done", "done", "todo", "todo", "todo"],
  build_failed: ["done", "done", "done", "failed", "todo", "todo", "todo"],
  published: ["done", "done", "done", "done", "done", "done", "active"],
  publish_failed: ["done", "done", "done", "done", "done", "failed", "todo"],
  delivered: ["done", "done", "done", "done", "done", "done", "done"],
};

/** A story for an idea, made from its state and its own times. Pass `steps` to change single steps by key. */
export function fakeStory(idea: DashIdea, over: Partial<Omit<Story, "steps">> & { steps?: Partial<Record<StepKey, Partial<StoryStep>>> } = {}): Story {
  const times: Record<StepKey, string | null> = {
    heard: idea.createdAt,
    asked: idea.askedAt,
    approved: idea.answeredAt,
    built: idea.builtAt ?? idea.buildStartedAt,
    checked: idea.publishedAt,
    published: idea.publishedAt,
    delivered: idea.deliveredAt,
  };
  const statuses = STATUSES[idea.state];
  const steps = STEP_KEYS.map((key, index): StoryStep => {
    let status: StepStatus = statuses[index] ?? "todo";
    if (key === "built" && idea.awaitingRetry) status = "waiting";
    const reached = status === "done" || status === "active" || status === "failed";
    const step: StoryStep = { key, label: STEP_LABELS[key], status, at: reached ? times[key] : null, detail: null, said: key === "heard" ? idea.quote : null };
    if (key === "built" && idea.state === "building") step.label = "Building";
    if (status === "failed") step.detail = idea.failureReason;
    return { ...step, ...over.steps?.[key] };
  });
  return { ideaId: idea.id, checks: [], runningSince: idea.state === "building" ? idea.buildStartedAt : null, runningLabel: idea.state === "building" ? "building" : null, hint: null, ...over, steps };
}

export function fakeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: NOW.toISOString(),
    problem: null,
    staleSince: null,
    demoMark: true,
    paused: false,
    running: { listener: true, build: false, deliver: false },
    dayStart: DAY_START,
    linesHeard: 0,
    lastHeardAt: null,
    asks: 0,
    detector: { idea: 0, not_idea: 0, skipped: 0, failed: 0 },
    heard: [],
    ideas: [],
    events: new Map(),
    build: new Map(),
    deliver: new Map(),
    buildRuns: [],
    deliverRuns: [],
    nextBuildAt: boise(12, 1),
    nextDeliverAt: boise(11, 6, 30),
    unreadableRows: 0,
    ...over,
  };
}

export function fakeExtras(over: Partial<IdeaExtras> = {}): IdeaExtras {
  return { report: null, brief: null, notes: null, shots: { phone: false, desktop: false }, marks: null, ...over };
}

export function fakeReport(over: Partial<ReportView> = {}): ReportView {
  return { confirmedLive: true, failedStep: null, verifyMs: 6600, publishMs: 31_000, liveAfterMs: 26_000, distFiles: 3, distBytes: 5602, checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true }, ...over };
}

/** The history of an idea that went straight through to `state`, one event a minute from when it was heard. */
export function fakeEvents(idea: DashIdea, path: readonly IdeaState[]): IdeaEvent[] {
  const start = Date.parse(idea.createdAt);
  return path.map((toState, index) => ({ id: index + 1, ideaId: idea.id, at: new Date(start + index * 60_000).toISOString(), fromState: index === 0 ? null : (path[index - 1] ?? null), toState, note: null }));
}

// ---------- The scene: 1:02 AM, Kiro Crew is building "Chore Wheel" ----------

export interface Scene {
  s: Snapshot;
  hero: { idea: DashIdea; story: Story; extras: IdeaExtras };
  line: { over: "Tonight" | "This morning" | "Today"; before: string; title: string | null; after: string };
  lastNight: { night: Night; label: "Last night" | "Tonight" };
  queue: TonightQueue;
  stories: Map<string, Story>;
  thumbs: Set<string>;
  nights: Night[];
  c: RenderContext;
  chrome: Chrome;
  ideas: Record<"choreWheel" | "lunchTurns" | "packing" | "baleYield" | "readingLog" | "notPublished" | "cutShort" | "rejected" | "expired" | "heard" | "asked" | "built" | "published" | "rehearsal", DashIdea>;
}

export function scene(): Scene {
  const choreWheel = fakeIdea({
    id: "idea_20261010_ch0rewh1",
    state: "building",
    title: "Chore Wheel",
    pitch: "Spin a wheel to share out the week's chores. Add names and chores, spin, and see who does what.",
    quote: { shown: true, text: "it would be cool if a wheel just picked who does the dishes" },
    createdAt: boise(10, 12, 41),
    askedAt: boise(10, 12, 44),
    answeredAt: boise(10, 12, 46),
    updatedAt: boise(11, 1, 0, 48),
    slug: "chore-wheel",
    buildBackend: "kiro-crew",
    buildStartedAt: boise(11, 1, 0, 48),
    buildStarts: 1,
  });
  const lunchTurns = fakeIdea({ id: "idea_20261010_1unchtrn" });
  const packing = fakeIdea({
    id: "idea_20261009_aa11bb22",
    state: "delivered",
    title: "Packing Checklist",
    pitch: "A checklist for a weekend trip. Tick things off as they go in the bag.",
    quote: { shown: true, text: "I forget my charger every single time" },
    createdAt: boise(9, 11, 5),
    askedAt: boise(9, 11, 8),
    answeredAt: boise(9, 11, 20),
    updatedAt: boise(10, 7),
    slug: "packing-checklist",
    buildBackend: "kiro-crew",
    buildStartedAt: boise(10, 1, 0, 40),
    // Five seconds more than the build log's own number (160 s), as happens for real: the log's number is the one shown.
    builtAt: boise(10, 1, 3, 25),
    publishedUrl: "https://example.invalid/overnight-apps/packing-checklist/",
    publishedAt: boise(10, 6, 31),
    deliveredAt: boise(10, 7),
    buildStarts: 1,
    hasMorningTodo: true,
    hasFact: true,
  });
  const baleYield = fakeIdea({
    id: "idea_20261009_cc33dd44",
    state: "build_failed",
    title: "Bale Yield Calculator",
    pitch: "Work out bales per acre from field size and windrow count.",
    quote: { shown: true, text: "how many bales are we even getting off that field" },
    createdAt: boise(9, 14, 30),
    askedAt: boise(9, 14, 33),
    answeredAt: boise(9, 14, 50),
    updatedAt: boise(10, 7),
    slug: "bale-yield-calculator",
    buildBackend: "kiro-crew",
    buildStartedAt: boise(10, 1, 3, 30),
    failureReason: "the build ran past its time limit of 45 minutes",
    failureNotifiedAt: boise(10, 7),
    buildStarts: 2,
  });
  const readingLog = fakeIdea({
    id: "idea_20261008_ee55ff66",
    state: "delivered",
    title: "Reading Log",
    pitch: "Log the pages read each night and see the week add up.",
    quote: { shown: true, text: "did you read your twenty minutes" },
    createdAt: boise(8, 18, 2),
    askedAt: boise(8, 18, 5),
    answeredAt: boise(8, 18, 30),
    updatedAt: boise(9, 7),
    slug: "reading-log",
    buildBackend: "kiro-cli",
    buildStartedAt: boise(9, 1, 1),
    builtAt: boise(9, 1, 6, 10),
    publishedUrl: "https://example.invalid/overnight-apps/reading-log/",
    publishedAt: boise(9, 6, 32),
    deliveredAt: boise(9, 7),
    buildStarts: 1,
    hasMorningTodo: true,
  });
  const notPublished = fakeIdea({
    id: "idea_20261008_0077aa88",
    state: "publish_failed",
    title: "Tip Splitter",
    pitch: "Split a bill and a tip between friends.",
    quote: { shown: true, text: "can somebody just do the maths on the tip" },
    createdAt: boise(8, 12, 15),
    askedAt: boise(8, 12, 18),
    answeredAt: boise(8, 12, 19),
    updatedAt: boise(9, 6, 33),
    slug: "tip-splitter",
    buildBackend: "kiro-crew",
    buildStartedAt: boise(9, 1, 7),
    builtAt: boise(9, 1, 9, 30),
    failureReason: "the app did not pass its own test",
    failureNotifiedAt: boise(9, 7),
    buildStarts: 1,
  });
  const cutShort = fakeIdea({
    id: "idea_20261008_99bb00cc",
    state: "build_failed",
    title: "Seed Spacing Guide",
    pitch: "Pick a vegetable and see how far apart to plant it.",
    quote: { shown: true, text: "how far apart do the carrots go again" },
    createdAt: boise(8, 9, 40),
    askedAt: boise(8, 9, 43),
    answeredAt: boise(8, 10, 2),
    updatedAt: boise(9, 1, 12),
    slug: "seed-spacing-guide",
    buildBackend: "kiro-crew",
    buildStartedAt: boise(9, 1, 10),
    failureReason: "the build was stopped",
    buildStarts: 1,
    awaitingRetry: true,
  });
  const rejected = fakeIdea({ id: "idea_20261009_re7ec7ed", state: "rejected", title: "Sock Sorter", pitch: "Match odd socks from a photo.", createdAt: boise(9, 16, 0), askedAt: boise(9, 16, 3), answeredAt: boise(9, 16, 10), updatedAt: boise(9, 16, 10), note: "deleted in Bee" });
  const expired = fakeIdea({ id: "idea_20261009_e8p1red0", state: "expired", title: "Fence Post Counter", pitch: "Count posts for a length of fence.", createdAt: boise(9, 19, 0), askedAt: boise(9, 19, 3), answeredAt: null, updatedAt: boise(9, 23), note: "no answer by the cutoff" });
  const heard = fakeIdea({ id: "idea_20261010_heard001", state: "heard", title: "Recipe Scaler", pitch: "Scale a recipe up or down for the number of people eating.", createdAt: boise(10, 22, 50), askedAt: null, answeredAt: null, askExpiresAt: null, updatedAt: boise(10, 22, 50), note: "over the daily ask limit" });
  const asked = fakeIdea({ id: "idea_20261010_asked001", state: "asked", title: "Trail Snack Planner", pitch: "Plan snacks for a hike by hours and people.", createdAt: boise(10, 17, 20), askedAt: boise(10, 17, 23), answeredAt: null, updatedAt: boise(10, 17, 23) });
  const built = fakeIdea({ id: "idea_20261008_bu117000", state: "built", title: "Coin Flip Jar", pitch: "Flip a coin and keep the score.", createdAt: boise(8, 8, 0), askedAt: boise(8, 8, 3), answeredAt: boise(8, 8, 9), updatedAt: boise(9, 1, 20), buildBackend: "kiro-crew", buildStartedAt: boise(9, 1, 15), builtAt: boise(9, 1, 20), buildStarts: 1 });
  const published = fakeIdea({
    id: "idea_20261008_pub115ed",
    state: "published",
    title: "Water Reminder",
    pitch: "Count glasses of water through the day.",
    createdAt: boise(8, 7, 30),
    askedAt: boise(8, 7, 33),
    answeredAt: boise(8, 7, 40),
    updatedAt: boise(9, 6, 34),
    buildBackend: "kiro-crew",
    buildStartedAt: boise(9, 1, 21),
    builtAt: boise(9, 1, 24),
    publishedUrl: "https://example.invalid/overnight-apps/water-reminder/",
    publishedAt: boise(9, 6, 34),
    buildStarts: 1,
  });
  const rehearsal = fakeIdea({
    id: "idea_20261007_rehearse",
    state: "delivered",
    title: "Practice Dice Roller",
    pitch: "Roll one to six dice and see the total.",
    quote: { shown: false, why: "none" },
    rehearsal: true,
    createdAt: boise(7, 15, 0),
    askedAt: boise(7, 15, 0),
    answeredAt: boise(7, 15, 0),
    updatedAt: boise(7, 15, 6),
    buildBackend: "kiro-crew",
    buildStartedAt: boise(7, 15, 0, 30),
    builtAt: boise(7, 15, 2, 49),
    publishedUrl: "https://example.invalid/overnight-apps/practice-dice-roller/",
    publishedAt: boise(7, 15, 4),
    deliveredAt: boise(7, 15, 6),
    buildStarts: 1,
  });
  // Newest first, as the database look gives them.
  const ideas = [heard, asked, lunchTurns, choreWheel, expired, rejected, baleYield, packing, readingLog, notPublished, cutShort, built, published, rehearsal];

  const heroStory = fakeStory(choreWheel, {
    steps: {
      asked: { detail: "On the wrist: Build tonight?" },
      approved: { detail: "Ticked in Bee" },
      built: { at: boise(11, 1, 0), detail: "Kiro Crew, inside Overnight's sandbox" },
      checked: { detail: "at 6:30 AM" },
      delivered: { detail: "at 7:00 AM" },
    },
    checks: [
      { key: "sign-in", label: "Kiro sign-in fresh", status: "done", detail: "47 min left", since: null },
      { key: "sandbox", label: "Sandbox check passed", status: "done", detail: "7.1 s", since: null },
      { key: "agent", label: "Kiro Crew is building", status: "active", detail: null, since: boise(11, 1, 0, 48) },
      { key: "built", label: "Built", status: "todo", detail: null, since: null },
    ],
  });
  const stories = new Map<string, Story>(ideas.map((idea) => [idea.id, idea.id === choreWheel.id ? heroStory : fakeStory(idea)]));

  const packingFacts: BuildFacts = {
    startedAt: packing.buildStartedAt ?? "",
    by: "build",
    signIn: { at: boise(10, 1, 0, 5), status: "ready", minutesLeft: 52 },
    sandboxCheck: { at: boise(10, 1, 0, 30), ok: true, ms: 7100, reused: false },
    agentStarted: { at: boise(10, 1, 0, 40), backend: "kiro-crew" },
    fellBack: null,
    finished: { at: packing.builtAt ?? "", ok: true, seconds: 160, credits: 4.59 },
  };
  const packingDeliver: DeliverFacts = {
    firstAt: boise(10, 6, 30, 5),
    checked: { at: boise(10, 6, 30, 12), ok: true, ms: 6600, files: 3, bytes: 5602, step: null },
    pushed: { at: boise(10, 6, 30, 30) },
    live: { at: boise(10, 6, 31), seen: true, liveAfterMs: 26_000 },
    told: { at: boise(10, 6, 31, 5), what: "built" },
    fact: { at: boise(10, 6, 31, 6) },
  };

  const tonight: Night = {
    key: "2026-10-11",
    label: "Sat, Oct 10 to Sun, Oct 11",
    headline: "Building now.",
    ideas: [{ idea: choreWheel, outcome: "building", buildSeconds: null, credits: null, by: "build", cutShort: false }],
    built: 0,
    failed: 0,
    cutShort: 0,
    delivered: 0,
    credits: null,
    buildRun: { command: "build", startedAt: boise(11, 1, 0), finishedAt: null, waiting: 2, taking: 2, built: null, failed: null, paused: false, nothingApproved: false, sandboxCheck: { at: boise(11, 1, 0, 40), ok: true, ms: 7100, reused: false }, ideaIds: [choreWheel.id] },
    deliverRun: null,
  };
  const lastNightNight: Night = {
    key: "2026-10-10",
    label: "Fri, Oct 9 to Sat, Oct 10",
    headline: "1 of 2 worked.",
    ideas: [
      { idea: packing, outcome: "delivered", buildSeconds: 160, credits: 4.59, by: "build", cutShort: false },
      { idea: baleYield, outcome: "build_failed", buildSeconds: null, credits: null, by: "build", cutShort: false },
    ],
    built: 1,
    failed: 1,
    cutShort: 0,
    delivered: 1,
    credits: 4.59,
    buildRun: { command: "build", startedAt: boise(10, 1, 0), finishedAt: boise(10, 1, 48, 40), waiting: 2, taking: 2, built: 1, failed: 1, paused: false, nothingApproved: false, sandboxCheck: { at: boise(10, 1, 0, 30), ok: true, ms: 7100, reused: false }, ideaIds: [packing.id, baleYield.id] },
    deliverRun: { command: "build", startedAt: boise(10, 6, 30), finishedAt: boise(10, 6, 31, 10), delivered: 1, failed: 1, notified: 2, ideaIds: [packing.id, baleYield.id] },
  };
  const rehearsalNight: Night = {
    key: "2026-10-08",
    label: "Wed, Oct 7 to Thu, Oct 8",
    headline: "Worked: 1 app built and delivered.",
    ideas: [{ idea: rehearsal, outcome: "delivered", buildSeconds: 139, credits: 3.09, by: "rehearse", cutShort: false }],
    built: 1,
    failed: 0,
    cutShort: 0,
    delivered: 1,
    credits: 3.09,
    buildRun: { command: "rehearse", startedAt: boise(7, 15, 0, 20), finishedAt: boise(7, 15, 2, 50), waiting: null, taking: null, built: 1, failed: 0, paused: false, nothingApproved: false, sandboxCheck: null, ideaIds: [rehearsal.id] },
    deliverRun: null,
  };

  const s = fakeSnapshot({
    running: { listener: true, build: true, deliver: false },
    linesHeard: 214,
    lastHeardAt: boise(10, 22, 56),
    asks: 2,
    detector: { idea: 3, not_idea: 9, skipped: 2, failed: 0 },
    heard: [
      { id: "c6", firstAt: boise(10, 22, 40), lastAt: boise(10, 22, 52), lines: 9, bars: [5, 3, 6, 2, 4, 7, 1, 3], outcome: "not_idea", ideaId: null },
      { id: "c5", firstAt: boise(10, 19, 2), lastAt: boise(10, 19, 15), lines: 31, bars: [4, 7, 2, 5, 3, 6, 4, 2], outcome: "not_idea", ideaId: null },
      { id: "c4", firstAt: boise(10, 15, 1), lastAt: boise(10, 15, 8), lines: 12, bars: [6, 4], outcome: "idea", ideaId: lunchTurns.id },
    ],
    ideas,
    events: new Map([[choreWheel.id, fakeEvents(choreWheel, ["heard", "asked", "approved", "building"])]]),
    build: new Map([[packing.id, packingFacts]]),
    deliver: new Map([[packing.id, packingDeliver]]),
  });
  const queue: TonightQueue = { at: boise(11, 1, 0), paused: false, limit: 2, rows: [{ idea: choreWheel, when: "building" }, { idea: lunchTurns, when: "tonight" }] };
  return {
    s,
    hero: { idea: choreWheel, story: heroStory, extras: fakeExtras() },
    line: { over: "Tonight", before: "Kiro Crew is building", title: choreWheel.title, after: "" },
    lastNight: { night: tonight, label: "Tonight" },
    queue,
    stories,
    thumbs: new Set([packing.id, readingLog.id, rehearsal.id]),
    nights: [tonight, lastNightNight, rehearsalNight],
    c: fakeContext(),
    chrome: fakeChrome(),
    ideas: { choreWheel, lunchTurns, packing, baleYield, readingLog, notPublished, cutShort, rejected, expired, heard, asked, built, published, rehearsal },
  };
}

/** Texts that try to become markup, for the tests that no view lets one through. */
export const HOSTILE = {
  tag: "<xss-probe>Chore</xss-probe>",
  attribute: `" data-xss-probe="1`,
  image: "'><img src=x onerror=1>",
  closing: "</script><script>window.xssProbe=1</script>",
  backwards: "safe‮gnp.exe",
  longWord: "W".repeat(300),
  address: "javascript:alert(1)",
} as const;
