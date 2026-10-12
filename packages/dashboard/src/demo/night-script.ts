// SYNTHETIC data: every word and number written by this file is made up. None of it is Bee data.
//
// An invented night, one small step at a time: an approved idea is built by Kiro Crew, checked,
// published and delivered. `npm run dashboard:demo -- --play` runs the steps a few seconds apart
// so the page can be watched changing, and the live browser test runs them one by one.
//
// Nothing is built, checked, published or told: each step only writes what the real programs
// would have left behind at that point (a row, a log line, a file), at the time `clock()` gives.
// Each step opens the database, makes its one change and closes it again, so nothing is held open
// between steps. It only works in a folder the demo's seed filled (./folder.ts decides).
import path from "node:path";
import { isBuildAwaitingRetry, Store } from "@overnight/core";
import type { Config, Idea, IdeaState } from "@overnight/core";
import { isSlug, slugFor } from "@overnight/builder";
import { backendLabel } from "../render/format.ts";
import { IDEA_ID } from "../types.ts";
import { DemoFolderError, isFileInside, isFolderInside, NOT_A_DEMO_FOLDER, seededDemoFolder } from "./folder.ts";
import { accentFor, checkDemoFolders, demoBuildNotes, hasWorkspaceFile, openDemoLogs, passedChecks, reportFor, sealWorkspace, setWorkspaceAside, WORKSPACE_FILES, writeBriefs, writeBuildStatus, writeReport, writeScreenshots, writeWorkspaceFile } from "./night-files.ts";
import type { DemoLogs, Measured, WorkspaceFile } from "./night-files.ts";

/** The invented night's builder. The scene it carries on from is built with Kiro Crew too. */
const BUILDER = "kiro-crew";

/** The steps of a whole invented night, by name and in order. An idea that is already being built starts part-way down. */
export const DEMO_NIGHT_STEP_NAMES = [
  "build-started",
  "sign-in-ready",
  "sandbox-check-passed",
  "agent-started",
  "file-build-status",
  "file-package-json",
  "file-node-modules",
  "file-dist",
  "file-build-notes",
  "built",
  "deliver-starting",
  "verified",
  "pushed",
  "live-and-published",
  "told-and-delivered",
  "fact",
] as const;
export type DemoNightStepName = (typeof DEMO_NIGHT_STEP_NAMES)[number];

/** Which file each file step puts into the workspace. */
const FILE_STEPS: ReadonlyArray<[DemoNightStepName, WorkspaceFile]> = [
  ["file-build-status", WORKSPACE_FILES[0]],
  ["file-package-json", WORKSPACE_FILES[1]],
  ["file-node-modules", WORKSPACE_FILES[2]],
  ["file-dist", WORKSPACE_FILES[3]],
  ["file-build-notes", WORKSPACE_FILES[4]],
];

const NOT_AN_ID = "The invented night needs the id of one of the demo's ideas.";
const WRONG_START = "The invented night plays an idea that is approved, or one that is being built.";

/** What a step is handed: the demo folder, the open database, the two logs, the idea as it is now, and the time. */
interface Moment {
  root: string;
  store: Store;
  logs: DemoLogs;
  idea: Idea;
  at: Date;
}

interface Planned {
  name: DemoNightStepName;
  needs: IdeaState;
  change: (moment: Moment) => void;
}

/** What one step leaves for a later one: when the morning started, and what the check measured. Only in memory. */
interface Memory {
  deliverStartedAt?: Date;
  measured?: Measured;
}

/**
 * Where an idea's steps stand in the night as a whole. Left out, the idea is a night by itself:
 * its build opens a run of its own, and its morning is a run of its own from start to end.
 * `npm run dashboard:demo -- --play` plays two ideas as one night (./stage.ts): both are built by
 * one build run, and both are checked and delivered by one morning run.
 */
export interface DemoNightPlace {
  /** false: tonight's build run is already going (an earlier idea opened it), so "build-started" writes no second "build night started". */
  opensBuildRun?: boolean;
  /** This idea is the last one tonight's build run builds: its "built" step also writes the run's two closing lines, saying this many were built. */
  closesBuildRun?: number;
  /** false: the morning's run is already going, so this idea has no "deliver-starting" step of its own. */
  opensMorningRun?: boolean;
  /** How many apps the morning's run delivered when this idea's "fact" step ends it (left out: 1). null: the run goes on to another idea, so no end is written. */
  closesMorningRun?: number | null;
}

/** How long a build took, in seconds: from when it was started to the step that ends it. Nothing when the clock stood still or ran back. */
function secondsSince(startedAt: string | null, at: Date): number {
  const ms = startedAt === null ? 0 : at.getTime() - Date.parse(startedAt);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/**
 * The lengths of time the invented night's lines carry. Invented, like everything else here: the
 * steps are played a few seconds apart, and "checked in 2.5 s, live after 2.5 s" would only be
 * the player's own rhythm. Two apps get two different sets, always the same for the same idea.
 */
const SANDBOX_CHECK_MS = 7100;
const MORNINGS: ReadonlyArray<{ verifyMs: number; liveAfterMs: number }> = [
  { verifyMs: 6600, liveAfterMs: 26_000 },
  { verifyMs: 5200, liveAfterMs: 21_000 },
  { verifyMs: 7400, liveAfterMs: 31_000 },
];
/** Between the push and the first look at the live page. */
const PUSH_MS = 3400;

function morningOf(ideaId: string): { verifyMs: number; liveAfterMs: number } {
  let sum = 0;
  for (const letter of ideaId) sum = (sum + (letter.codePointAt(0) ?? 0)) % 9973;
  return MORNINGS[sum % MORNINGS.length] ?? { verifyMs: 6600, liveAfterMs: 26_000 };
}

/** The folder name the app is published under: the one it already has if that is a plain one, else made from the title. */
function slugOf(idea: Idea, store: Store): string {
  if (idea.slug !== null && isSlug(idea.slug)) return idea.slug;
  return slugFor(idea.title, (taken) => store.findIdeaBySlug(taken) !== null);
}

const INVENTED_NOTES = [
  "Must-have features:",
  "1. The one main thing the app is for, on one screen.",
  '2. "Try an example" fills in something to look at.',
  "",
  "What I built: one screen in plain TypeScript with Vite. Nothing leaves the phone.",
  "Checks: npm run build passed. tests/smoke.spec.ts passed.",
];

/** The invented size of the invented app. */
const APP = { sourceFiles: 10, sourceBytes: 9_388, files: 3, bytes: 5_871, credits: 3.87 } as const;

/**
 * The steps of one invented night for one of the demo's ideas, in order. For an approved idea:
 * the build starts; Kiro's sign-in is fresh; the sandbox check passes; the agent starts; five
 * files appear one by one; the idea is built; the morning run starts; the app is checked and two
 * pictures are saved; it is pushed; it is seen live and recorded as published, with its report;
 * the wearer is "told" and the idea is delivered; Bee is "given" the fact. An idea that is already
 * being built (the scene's "Chore Wheel") carries on from the first file it does not have yet.
 *
 * `place` says where the idea stands when several are played as one night (see DemoNightPlace).
 *
 * `dir` must be a folder the demo's seed filled; anything else is refused with a DemoFolderError,
 * the real data folder first of all. A step that is run out of turn throws and changes nothing.
 */
export function demoNightSteps(dir: string, ideaId: string, config: Config, clock: () => Date, place: DemoNightPlace = {}): Array<{ name: string; run(): void }> {
  if (typeof ideaId !== "string" || !IDEA_ID.test(ideaId)) throw new Error(NOT_AN_ID);
  const memory: Memory = {};
  const morning = morningOf(ideaId);

  /** Open the demo folder for one change, and close it again whatever happens. */
  const inFolder = <T>(change: (root: string, store: Store) => T): T => {
    const root = seededDemoFolder(dir);
    // The seed made the database. A folder without one is not the seed's, whatever note it carries.
    if (!isFileInside(root, "overnight.db")) throw new DemoFolderError(NOT_A_DEMO_FOLDER);
    const store = new Store(path.join(root, "overnight.db"));
    try {
      if (store.getValue("dashboard_demo") !== "true") throw new DemoFolderError(NOT_A_DEMO_FOLDER);
      return change(root, store);
    } finally {
      store.close();
    }
  };

  /** One step, not yet in its place: its name, the state the idea must be in for it, and its one change. */
  const step = (name: DemoNightStepName, needs: IdeaState, change: (moment: Moment) => void): Planned => ({ name, needs, change });

  const saveReport = ({ root, store }: Moment, at: Date): void => {
    const idea = store.getIdea(ideaId);
    if (idea !== null && memory.measured !== undefined) writeReport(root, reportFor(idea, memory.measured, at));
  };

  const buildStarted = step("build-started", "approved", ({ root, store, logs, idea, at }) => {
    const waiting = store.listIdeas({ states: ["approved"] }).length;
    const retries = store.listIdeas({ states: ["build_failed"] }).filter((failed) => isBuildAwaitingRetry(failed, store.countBuildStarts(failed.id))).length;
    // A new build never starts on top of an older try's files.
    if (isFolderInside(root, "workspaces", idea.id)) setWorkspaceAside(root, idea.id, at);
    writeBriefs(root, idea);
    store.transitionIdea(idea.id, "building", { slug: slugOf(idea, store), buildBackend: BUILDER, buildStartedAt: at.toISOString(), builtAt: null, failureReason: null, note: `building with ${backendLabel(BUILDER)}` }, at.toISOString());
    if (place.opensBuildRun !== false) logs.line("nightStart", at, { approved: waiting, retries, alreadyStartedToday: 0, limit: config.maxBuildsPerNight, building: 1 });
    logs.line("ideaStart", at, { ideaId: idea.id, backend: BUILDER });
  });
  const beforeTheAgent = [
    buildStarted,
    step("sign-in-ready", "building", ({ logs, at }) => logs.line("signInReady", at, { minutesLeft: 44, waitedSeconds: 0 })),
    step("sandbox-check-passed", "building", ({ logs, at }) => logs.line("sandboxPassed", at, { ms: SANDBOX_CHECK_MS })),
    step("agent-started", "building", ({ logs, idea, at }) => logs.line("crewStarted", at, { ideaId: idea.id, jobId: "demo-job-play", timeoutSecs: config.buildTimeoutMin * 60 })),
  ];
  const fileStep = ([name, file]: [DemoNightStepName, WorkspaceFile]) =>
    step(name, "building", ({ root, idea }) => {
      // An idea that was "building" before the demo touched it may have no workspace yet.
      if (!isFolderInside(root, "workspaces", idea.id)) writeBriefs(root, idea);
      writeWorkspaceFile(root, idea.id, file, demoBuildNotes(idea.title, INVENTED_NOTES));
    });
  const afterTheFiles = [
    step("built", "building", ({ root, store, logs, idea, at }) => {
      // The one length of time that is the player's own: the page showed this build's clock running, and must not be contradicted.
      const seconds = secondsSince(idea.buildStartedAt, at);
      if (!isFolderInside(root, "workspaces", idea.id)) writeBriefs(root, idea);
      writeBuildStatus(root, idea.id, "built");
      // The finished build is moved out of the build jobs' reach. (The builder records "built" first and moves second;
      // here the move comes first, because it is the part that can be refused.)
      sealWorkspace(root, idea.id);
      store.transitionIdea(idea.id, "built", { builtAt: at.toISOString(), buildBackend: BUILDER, failureReason: null, note: `built with ${backendLabel(BUILDER)} in ${seconds} s` }, at.toISOString());
      logs.line("ideaBuilt", at, { ideaId: idea.id, backend: BUILDER, seconds, credits: APP.credits });
      if (place.closesBuildRun !== undefined) {
        // The run's last two lines (builder, night.ts and cli, commands/build.ts): what it built, and what it left for another night.
        const left = store.listIdeas({ states: ["approved"] }).length + store.listIdeas({ states: ["build_failed"] }).filter((failed) => isBuildAwaitingRetry(failed, store.countBuildStarts(failed.id))).length;
        logs.line("nightEnd", at, { built: place.closesBuildRun, failed: 0, leftForAnotherNight: left });
        logs.line("buildRunEnd", at, { built: place.closesBuildRun, failed: 0, ...(left === 0 ? {} : { skipped: `${left} approved ${left === 1 ? "idea waits" : "ideas wait"} for another night (limit ${config.maxBuildsPerNight} a night)` }) });
      }
    }),
    step("deliver-starting", "built", ({ root, logs, at }) => {
      memory.deliverStartedAt = at;
      logs.line("deliverRunStart", at, { dataDir: root, timeZone: config.timeZone, deliverTime: config.deliverTime });
    }),
    step("verified", "built", ({ root, logs, idea, at }) => {
      const verifyMs = morning.verifyMs;
      memory.measured = {
        checks: passedChecks({ sourceFiles: APP.sourceFiles, sourceBytes: APP.sourceBytes, distFiles: APP.files, distBytes: APP.bytes, totalMs: verifyMs }),
        timings: { verifyMs, publishMs: null, liveAfterMs: null },
        confirmedLive: null,
        screenshots: writeScreenshots(root, idea.id, accentFor(idea.id)),
        startedAt: (memory.deliverStartedAt ?? at).toISOString(),
      };
      logs.line("verified", at, { ideaId: idea.id, files: APP.files, bytes: APP.bytes, ms: verifyMs, usedRegistry: false });
    }),
    step("pushed", "built", ({ logs, idea, at }) => logs.line("pushed", at, { ideaId: idea.id, files: APP.files, bytes: APP.bytes })),
    step("live-and-published", "built", (moment) => {
      const { store, logs, idea, at } = moment;
      const liveAfterMs = morning.liveAfterMs;
      const checked = memory.measured ?? { checks: {}, timings: { verifyMs: null, publishMs: null, liveAfterMs: null }, confirmedLive: null, screenshots: { phone: null, desktop: null }, startedAt: at.toISOString() };
      memory.measured = { ...checked, timings: { verifyMs: checked.timings.verifyMs, publishMs: PUSH_MS + liveAfterMs, liveAfterMs }, confirmedLive: true };
      // Like every link in the demo, one that can never be a real site.
      store.transitionIdea(idea.id, "published", { publishedUrl: `https://example.invalid/overnight-apps/${slugOf(idea, store)}/`, publishedAt: at.toISOString(), failureReason: null }, at.toISOString());
      saveReport(moment, at);
      logs.line("live", at, { ideaId: idea.id, liveAfterMs, looks: 1 });
    }),
    step("told-and-delivered", "published", (moment) => {
      const { store, logs, idea, at } = moment;
      const todoId = 42_100 + store.listIdeas({ states: ["delivered"] }).length;
      store.transitionIdea(idea.id, "delivered", { deliveredAt: at.toISOString(), morningTodoId: todoId, note: idea.note }, at.toISOString());
      saveReport(moment, at);
      logs.line("told", at, { ideaId: idea.id, todoId });
    }),
    step("fact", "delivered", (moment) => {
      const { store, logs, idea, at } = moment;
      const factId = 43_100 + store.listIdeas({ states: ["delivered"] }).length;
      store.updateIdea(idea.id, { factId }, at.toISOString());
      saveReport(moment, at);
      logs.line("fact", at, { ideaId: idea.id, factId });
      if (place.closesMorningRun !== null) logs.line("deliverRunEnd", at, { delivered: place.closesMorningRun ?? 1, failed: 0, notified: 0 });
    }),
    // An idea that joins a morning already under way has no start of its own.
  ].filter((planned) => planned.name !== "deliver-starting" || place.opensMorningRun !== false);

  // Looked at once, now: which idea this is, and how far along it already is.
  const planned = inFolder((root, store): Planned[] => {
    const idea = store.getIdea(ideaId);
    if (idea === null) throw new Error(NOT_AN_ID);
    if (idea.state === "approved") return [...beforeTheAgent, ...FILE_STEPS.map(fileStep), ...afterTheFiles];
    if (idea.state === "building") return [...FILE_STEPS.filter(([, file]) => !hasWorkspaceFile(root, idea.id, file)).map(fileStep), ...afterTheFiles];
    throw new Error(WRONG_START);
  });

  /** How many of the steps have run. A step runs only when it is the next one. */
  let done = 0;
  return planned.map(({ name, needs, change }, place) => ({
    name,
    run() {
      if (place !== done) throw new Error(`The invented night's steps run in order, each one once: "${name}" is not the next one.`);
      const at = clock();
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError("The invented night needs a clock that gives a real time.");
      inFolder((root, store) => {
        const idea = store.getIdea(ideaId);
        if (idea === null) throw new Error(NOT_AN_ID);
        // Something other than these steps has moved the idea on: stop, rather than write over it.
        if (idea.state !== needs) throw new Error(`The invented night's step "${name}" comes when the idea is "${needs}", and it is "${idea.state}".`);
        // Before anything is changed: every folder a step writes into must still be a real folder, and the two logs plain files.
        checkDemoFolders(root);
        change({ root, store, logs: openDemoLogs(root), idea, at });
      });
      done += 1;
    },
  }));
}
