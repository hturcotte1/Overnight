// SYNTHETIC: every word in this test is made up. The "real data folder" in it is a pretend one, in a temporary folder.
//
// The invented night that `--play` and the live browser test run, one step at a time. Like the
// seed it writes, so it is held to the same rule: only in a folder the seed filled, never in the
// real data folder, and never through a link that leads out of the folder.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataPaths, finishedBuildDir, parseConfig, Store } from "@overnight/core";
import type { Config, Idea, IdeaState } from "@overnight/core";
import { reportPath } from "@overnight/deliver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_MARKER_FILE, DemoFolderError, IS_THE_REAL_FOLDER, LEADS_OUTSIDE, NOT_A_DEMO_FOLDER, NOT_A_FOLDER, NOT_THERE } from "../src/demo/folder.ts";
import { DEMO_FILES_MADE_ANEW } from "../src/demo/night-files.ts";
import type { DemoReport } from "../src/demo/night-files.ts";
import { DEMO_NIGHT_STEP_NAMES, demoNightSteps } from "../src/demo/night-script.ts";
import { PNG_SIGNATURE } from "../src/demo/png.ts";
import { seedDemoData } from "../src/demo/seed.ts";
import type { DemoIdeaKey } from "../src/demo/seed.ts";
import { matchLogMessage } from "../src/log-messages.ts";
import type { LogMessageKey } from "../src/log-messages.ts";

/** 1:02 AM in Boise on an invented night. */
const NOW = new Date("2026-10-18T07:02:00.000Z");
/** The pretend clock of a played night: two and a half seconds on at every look. */
const TICK_MS = 2500;
/** The invented lengths of a morning's check, and of the wait for the page to go live. Which set an idea gets goes by its id. */
const INVENTED_CHECKS = [6600, 5200, 7400];
const INVENTED_WAITS = [26_000, 21_000, 31_000];

const made: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "overnight-dashboard-night-")));
  made.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Demo {
  dir: string;
  config: Config;
  ids: Record<DemoIdeaKey, string>;
  /** A clock that starts at NOW and moves on by TICK_MS every time it is read. */
  clock: () => Date;
  /** The times the clock has given so far. */
  given: Date[];
}

function demo(options: { hostile?: boolean } = {}): Demo {
  const dir = path.join(scratch(), "data");
  mkdirSync(dir, { mode: 0o700 });
  const config = parseConfig({ OVERNIGHT_DATA_DIR: dir, PAUSED: "false" });
  const ids = seedDemoData(dir, { now: NOW, config, ...options }).ideaIds;
  const given: Date[] = [];
  const clock = (): Date => {
    const at = new Date(NOW.getTime() + (given.length + 1) * TICK_MS);
    given.push(at);
    return at;
  };
  return { dir, config, ids, clock, given };
}

function ideaNow(d: Demo, key: DemoIdeaKey): Idea {
  const store = new Store(path.join(d.dir, "overnight.db"));
  try {
    const idea = store.getIdea(d.ids[key]);
    if (idea === null) throw new Error("the idea is gone");
    return idea;
  } finally {
    store.close();
  }
}

/** The lines of a log that the dashboard knows, as the names in its table (a line it does not know is null). */
function logKeys(dir: string, log: "build" | "deliver", from = 0): Array<LogMessageKey | null> {
  return logRows(dir, log)
    .slice(from)
    .map((row) => matchLogMessage(log, row.message));
}
function logRows(dir: string, log: "build" | "deliver"): Array<Record<string, unknown> & { at: string; message: string }> {
  return readFileSync(path.join(dir, "logs", `${log}.log`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown> & { at: string; message: string });
}

/** How many lines the two logs hold between them, wherever a test has moved them to (a log that is not there counts as empty). */
function linesLogged(dir: string): number {
  let lines = 0;
  for (const log of ["build", "deliver"] as const) {
    try {
      lines += logRows(dir, log).length;
    } catch {
      // moved away by the test
    }
  }
  return lines;
}

/** Everything under a folder, with a fingerprint of every file: equal before and after means nothing was changed. */
function fingerprint(dir: string, prefix = ""): string[] {
  const rows: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const info = lstatSync(full);
    if (info.isDirectory()) rows.push(`${prefix}${name}/`, ...fingerprint(full, `${prefix}${name}/`));
    else if (info.isFile()) rows.push(`${prefix}${name} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    else rows.push(`${prefix}${name} (not a plain file)`);
  }
  return rows;
}

function failure(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return "nothing was thrown";
}
function refusal(attempt: () => unknown): string {
  const error = failure(attempt);
  return error instanceof DemoFolderError ? error.message : `not a refusal: ${String(error)}`;
}

describe("demoNightSteps, for an approved idea", () => {
  it("runs a whole night in order and ends delivered", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    expect(steps.map((step) => step.name)).toEqual([...DEMO_NIGHT_STEP_NAMES]);
    // Making the list changes nothing and does not look at the clock.
    expect(ideaNow(d, "lunchTurns").state).toBe("approved");
    expect(d.given).toEqual([]);

    const states: IdeaState[] = [];
    for (const step of steps) {
      step.run();
      states.push(ideaNow(d, "lunchTurns").state);
    }
    expect(states).toEqual(["building", "building", "building", "building", "building", "building", "building", "building", "building", "built", "built", "built", "built", "published", "delivered", "delivered"]);
    expect(d.given).toHaveLength(steps.length);

    const idea = ideaNow(d, "lunchTurns");
    expect(idea).toMatchObject({ state: "delivered", slug: "lunch-turns", buildBackend: "kiro-crew", publishedUrl: "https://example.invalid/overnight-apps/lunch-turns/", failureReason: null, note: "built with Kiro Crew in 23 s" });
    expect(idea.morningTodoId).not.toBeNull();
    expect(idea.factId).not.toBeNull();
    // Each change carries the time the clock gave at its own step.
    expect([idea.buildStartedAt, idea.builtAt, idea.publishedAt, idea.deliveredAt, idea.updatedAt]).toEqual([d.given[0], d.given[9], d.given[13], d.given[14], d.given[15]].map((at) => at?.toISOString()));
  });

  it("writes the lines the night's ticks are read from, each at its own step, after the lines the seed left", () => {
    const d = demo();
    const [buildBefore, deliverBefore] = [logRows(d.dir, "build").length, logRows(d.dir, "deliver").length];
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    const added: Array<Array<LogMessageKey | null>> = [];
    for (const step of steps) {
      const before = [logRows(d.dir, "build").length, logRows(d.dir, "deliver").length] as const;
      step.run();
      added.push([...logKeys(d.dir, "build", before[0]), ...logKeys(d.dir, "deliver", before[1])]);
    }
    expect(added).toEqual([
      ["nightStart", "ideaStart"],
      ["signInReady"],
      ["sandboxPassed"],
      ["crewStarted"],
      [],
      [],
      [],
      [],
      [],
      // Built, and at once moved out of the build jobs' reach: the builder's two lines, one after the other.
      ["ideaBuilt", "sealed"],
      ["deliverRunStart"],
      ["verified"],
      ["pushed"],
      ["live"],
      ["told"],
      ["fact", "deliverRunEnd"],
    ]);
    const build = logRows(d.dir, "build").slice(buildBefore);
    const deliver = logRows(d.dir, "deliver").slice(deliverBefore);
    expect(build.map((row) => row.at)).toEqual([0, 0, 1, 2, 3, 9, 9].map((step) => d.given[step]?.toISOString()));
    expect(deliver.map((row) => row.at)).toEqual([10, 11, 12, 13, 14, 15, 15].map((step) => d.given[step]?.toISOString()));
    const id = d.ids.lunchTurns;
    // What the page shows from each line: how many wait, how long a step took, how big the app is.
    expect(build[0]).toMatchObject({ approved: 1, retries: 1, limit: d.config.maxBuildsPerNight, building: 1 });
    expect(build[1]).toMatchObject({ ideaId: id, backend: "kiro-crew" });
    expect(build[3]).toMatchObject({ ms: 7100 });
    expect(build[4]).toMatchObject({ ideaId: id });
    // The build's own length is the one time that is the player's: the page showed its clock running.
    expect(build[5]).toMatchObject({ ideaId: id, backend: "kiro-crew", seconds: 23, credits: 3.87 });
    // The line the builder writes once the finished build is where no build job can reach it.
    expect(build[6]).toMatchObject({ level: "info", message: "finished build moved out of the builders' reach", ideaId: id, filesMadeAnew: DEMO_FILES_MADE_ANEW });
    expect(deliver[1]).toMatchObject({ ideaId: id, files: 3, bytes: 5871 });
    expect(deliver[2]).toMatchObject({ ideaId: id });
    expect(deliver[3]).toMatchObject({ ideaId: id });
    // How long the check took and how long the page took to go live are invented, not the two and a half
    // seconds between two steps: the page used to say "Checked 2.5 s", "Live after 2.5 s", "Sandbox check passed 2.5 s".
    expect(INVENTED_CHECKS).toContain(deliver[1]?.ms);
    expect(INVENTED_WAITS).toContain(deliver[3]?.liveAfterMs);
    for (const ms of [build[3]?.ms, deliver[1]?.ms, deliver[3]?.liveAfterMs]) expect(ms).not.toBe(TICK_MS);
    expect(deliver[4]).toMatchObject({ ideaId: id });
    expect(deliver[5]).toMatchObject({ ideaId: id });
    expect(deliver[6]).toMatchObject({ delivered: 1, failed: 0, notified: 0 });
  });

  it("puts the build's five files into the workspace one by one, then moves the finished build out of the build jobs' reach", () => {
    const d = demo();
    const paths = dataPaths(d.dir);
    const id = d.ids.lunchTurns;
    const steps = demoNightSteps(d.dir, id, d.config, d.clock);
    const workspace = path.join(paths.workspaces, id);
    const seen: string[][] = [];
    for (const step of steps.slice(0, 9)) {
      step.run();
      seen.push(existsSync(workspace) ? readdirSync(workspace).sort() : []);
    }
    expect(seen).toEqual([
      ["brief.md"],
      ["brief.md"],
      ["brief.md"],
      ["brief.md"],
      ["BUILD_STATUS.json", "brief.md"],
      ["BUILD_STATUS.json", "brief.md", "package.json"],
      ["BUILD_STATUS.json", "brief.md", "node_modules", "package.json"],
      ["BUILD_STATUS.json", "brief.md", "dist", "node_modules", "package.json"],
      ["BUILD_NOTES.md", "BUILD_STATUS.json", "brief.md", "dist", "node_modules", "package.json"],
    ]);
    expect(readdirSync(path.join(workspace, "dist"))).toEqual(["index.html"]);
    expect(JSON.parse(readFileSync(path.join(workspace, "BUILD_STATUS.json"), "utf8"))).toEqual({ status: "building" });
    expect(readFileSync(path.join(workspace, "BUILD_NOTES.md"), "utf8")).toMatch(/^# Build notes: Lunch Turns\n\n\(Invented for the Overnight dashboard's demo\. No build agent wrote this, and nothing was built\.\)\n/);
    expect(existsSync(path.join(paths.ideas, id, "brief.md"))).toBe(true);
    expect(finishedBuildDir(paths, id)).toBe(workspace);

    steps[9]?.run();
    expect(existsSync(workspace)).toBe(false);
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.built, id));
    expect(readdirSync(path.join(paths.built, id)).sort()).toEqual(["BUILD_NOTES.md", "BUILD_STATUS.json", "brief.md", "dist", "node_modules", "package.json"]);
    expect(JSON.parse(readFileSync(path.join(paths.built, id, "BUILD_STATUS.json"), "utf8"))).toMatchObject({ status: "built" });
  });

  it("saves two pictures when the app is checked, and the report when it is published, kept up as the morning goes on", () => {
    const d = demo();
    const paths = dataPaths(d.dir);
    const id = d.ids.lunchTurns;
    const steps = demoNightSteps(d.dir, id, d.config, d.clock);
    const shots = [path.join(paths.screenshots, `${id}.png`), path.join(paths.screenshots, `${id}-desktop.png`)];
    for (const step of steps.slice(0, 11)) step.run();
    expect(shots.map((file) => existsSync(file))).toEqual([false, false]);
    steps[11]?.run();
    for (const file of shots) expect(readFileSync(file).subarray(0, 8).equals(PNG_SIGNATURE), file).toBe(true);

    const report = (): DemoReport => JSON.parse(readFileSync(reportPath(paths, id), "utf8")) as DemoReport;
    steps[12]?.run();
    expect(existsSync(reportPath(paths, id))).toBe(false);
    steps[13]?.run();
    expect(report()).toMatchObject({
      ideaId: id,
      title: "Lunch Turns",
      state: "published",
      ok: true,
      url: "https://example.invalid/overnight-apps/lunch-turns/",
      confirmedLive: true,
      sizes: { distFiles: 3, distBytes: 5871 },
      checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true },
      screenshots: { phone: shots[0], desktop: shots[1] },
      deliveredAt: null,
      factId: null,
    });
    // The report's times are the invented ones the log lines carry, and the wait for the page is part of the publishing.
    const timings = report().timings;
    expect(INVENTED_CHECKS).toContain(timings.verifyMs);
    expect(INVENTED_WAITS).toContain(timings.liveAfterMs);
    expect(timings.publishMs).toBe((timings.liveAfterMs ?? 0) + 3400);
    expect(logRows(d.dir, "deliver").at(-1)).toMatchObject({ liveAfterMs: timings.liveAfterMs });
    steps[14]?.run();
    expect(report()).toMatchObject({ state: "delivered", deliveredAt: d.given[14]?.toISOString(), factId: null });
    steps[15]?.run();
    expect(report()).toMatchObject({ state: "delivered", factId: ideaNow(d, "lunchTurns").factId, updatedAt: d.given[15]?.toISOString() });
  });

  it("starts in a new, empty workspace: anything an earlier try left there is moved aside, never built on and never deleted", () => {
    const d = demo();
    const id = d.ids.lunchTurns;
    const workspaces = dataPaths(d.dir).workspaces;
    mkdirSync(path.join(workspaces, id));
    writeFileSync(path.join(workspaces, id, "BUILD_STATUS.json"), "left over");
    demoNightSteps(d.dir, id, d.config, d.clock)[0]?.run();
    expect(readdirSync(path.join(workspaces, id))).toEqual(["brief.md"]);
    const aside = readdirSync(workspaces).filter((name) => name.startsWith(`${id}.old-`));
    expect(aside).toEqual([`${id}.old-20261018T070202Z`]);
    expect(readFileSync(path.join(workspaces, aside[0] ?? "", "BUILD_STATUS.json"), "utf8")).toBe("left over");
  });

  it("makes one change you can see at every step, and holds no database open between steps", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    let before = fingerprint(d.dir);
    for (const step of steps) {
      step.run();
      const after = fingerprint(d.dir);
      expect(after, step.name).not.toEqual(before);
      // A database that was closed leaves no write-ahead file behind. One held open would.
      expect(readdirSync(d.dir).filter((name) => /-(wal|shm|journal)$/.test(name)), step.name).toEqual([]);
      before = after;
    }
  });

  it("leaves every other idea exactly as it was", () => {
    const d = demo();
    const others = (): string => {
      const store = new Store(path.join(d.dir, "overnight.db"));
      try {
        return JSON.stringify(store.listIdeas().filter((idea) => idea.id !== d.ids.lunchTurns));
      } finally {
        store.close();
      }
    };
    const before = others();
    for (const step of demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock)) step.run();
    expect(others()).toBe(before);
  });
});

describe("demoNightSteps, for the idea that is already being built", () => {
  it("carries on from the first file the build does not have yet, and ends delivered", () => {
    const d = demo();
    const id = d.ids.choreWheel;
    const steps = demoNightSteps(d.dir, id, d.config, d.clock);
    // The seed left it 72 seconds in, with the agent started and the project written.
    expect(steps.map((step) => step.name)).toEqual(DEMO_NIGHT_STEP_NAMES.slice(6));
    const before = logRows(d.dir, "build").length;
    for (const step of steps) step.run();
    const idea = ideaNow(d, "choreWheel");
    // Built 3 steps on from a build that began 72 seconds before the clock started.
    expect(idea).toMatchObject({ state: "delivered", note: "built with Kiro Crew in 82 s", publishedUrl: "https://example.invalid/overnight-apps/chore-wheel/" });
    expect(logKeys(d.dir, "build", before)).toEqual(["ideaBuilt", "sealed"]);
    expect(logRows(d.dir, "build").at(-2)).toMatchObject({ ideaId: id, seconds: 82 });
    expect(logRows(d.dir, "build").at(-1)).toMatchObject({ ideaId: id, filesMadeAnew: DEMO_FILES_MADE_ANEW });
    expect(finishedBuildDir(dataPaths(d.dir), id)).toBe(path.join(dataPaths(d.dir).built, id));
  });

  it("plays one idea after another, as a night does", () => {
    const d = demo();
    for (const key of ["choreWheel", "lunchTurns"] as const) for (const step of demoNightSteps(d.dir, d.ids[key], d.config, d.clock)) step.run();
    expect(ideaNow(d, "choreWheel").state).toBe("delivered");
    expect(ideaNow(d, "lunchTurns").state).toBe("delivered");
    // Two different to-dos and two different facts, as Bee would have given them.
    expect(ideaNow(d, "choreWheel").morningTodoId).not.toBe(ideaNow(d, "lunchTurns").morningTodoId);
    expect(ideaNow(d, "choreWheel").factId).not.toBe(ideaNow(d, "lunchTurns").factId);
  });
});

describe("demoNightSteps, for two ideas played as one night", () => {
  // What `npm run dashboard:demo -- --play` plays (src/demo/stage.ts): one build run builds both, one morning run delivers both.
  const CHORE = { opensBuildRun: false, opensMorningRun: false, closesMorningRun: 2 } as const;
  const LUNCH = { opensBuildRun: false, closesBuildRun: 2, opensMorningRun: true, closesMorningRun: null } as const;

  it("an idea that joins a build run already going writes no second start of the night", () => {
    const d = demo();
    const before = logRows(d.dir, "build").length;
    demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock, LUNCH)[0]?.run();
    expect(logKeys(d.dir, "build", before)).toEqual(["ideaStart"]);
  });

  it("the last idea of the build run ends the run: what was built, and what waits for another night", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock, LUNCH);
    const before = logRows(d.dir, "build").length;
    for (const step of steps.slice(0, 10)) step.run();
    expect(logKeys(d.dir, "build", before).slice(-4)).toEqual(["ideaBuilt", "sealed", "nightEnd", "buildRunEnd"]);
    const [nightEnd, runEnd] = logRows(d.dir, "build").slice(-2);
    // Still waiting in the scene: the build that was cut short (Chore Wheel is being built, and is not waiting).
    expect(nightEnd).toMatchObject({ built: 2, failed: 0, leftForAnotherNight: 1 });
    expect(runEnd).toMatchObject({ built: 2, failed: 0, skipped: `1 approved idea waits for another night (limit ${d.config.maxBuildsPerNight} a night)` });
    expect([nightEnd?.at, runEnd?.at]).toEqual([d.given[9]?.toISOString(), d.given[9]?.toISOString()]);
    // An idea that is not the run's last leaves the run open.
    const other = demo();
    const otherBefore = logRows(other.dir, "build").length;
    for (const step of demoNightSteps(other.dir, other.ids.choreWheel, other.config, other.clock, CHORE).slice(0, 4)) step.run();
    expect(logKeys(other.dir, "build", otherBefore)).toEqual(["ideaBuilt", "sealed"]);
  });

  it("an idea that joins a morning already going has no start of its own, and only the last one ends the morning's run", () => {
    const d = demo();
    const lunch = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock, LUNCH);
    const chore = demoNightSteps(d.dir, d.ids.choreWheel, d.config, d.clock, CHORE);
    expect(lunch.map((step) => step.name)).toEqual([...DEMO_NIGHT_STEP_NAMES]);
    expect(chore.map((step) => step.name)).toEqual(DEMO_NIGHT_STEP_NAMES.slice(6).filter((name) => name !== "deliver-starting"));
    const before = logRows(d.dir, "deliver").length;
    // Both are built, then the morning takes them one after the other.
    for (const step of chore.slice(0, 4)) step.run();
    for (const step of lunch.slice(0, 10)) step.run();
    for (const step of lunch.slice(10)) step.run();
    for (const step of chore.slice(4)) step.run();
    expect(logKeys(d.dir, "deliver", before)).toEqual(["deliverRunStart", "verified", "pushed", "live", "told", "fact", "verified", "pushed", "live", "told", "fact", "deliverRunEnd"]);
    expect(logRows(d.dir, "deliver").at(-1)).toMatchObject({ delivered: 2, failed: 0, notified: 0 });
    expect(ideaNow(d, "choreWheel").state).toBe("delivered");
    expect(ideaNow(d, "lunchTurns").state).toBe("delivered");
  });

  it("left to itself, an idea is still a night of its own", () => {
    const d = demo();
    const [buildBefore, deliverBefore] = [logRows(d.dir, "build").length, logRows(d.dir, "deliver").length];
    for (const step of demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock)) step.run();
    expect(logKeys(d.dir, "build", buildBefore)).toEqual(["nightStart", "ideaStart", "signInReady", "sandboxPassed", "crewStarted", "ideaBuilt", "sealed"]);
    expect(logKeys(d.dir, "deliver", deliverBefore)).toEqual(["deliverRunStart", "verified", "pushed", "live", "told", "fact", "deliverRunEnd"]);
    expect(logRows(d.dir, "deliver").at(-1)).toMatchObject({ delivered: 1 });
  });
});

describe("demoNightSteps says no", () => {
  it("to a step run out of turn, or twice, and changes nothing", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    const before = fingerprint(d.dir);
    for (const early of [1, 4, 9, 15]) expect(String(failure(() => steps[early]?.run())), `step ${early}`).toContain("run in order, each one once");
    expect(fingerprint(d.dir)).toEqual(before);
    expect(d.given).toEqual([]);

    steps[0]?.run();
    const afterOne = fingerprint(d.dir);
    expect(String(failure(() => steps[0]?.run()))).toContain('"build-started" is not the next one');
    expect(String(failure(() => steps[2]?.run()))).toContain('"sandbox-check-passed" is not the next one');
    expect(fingerprint(d.dir)).toEqual(afterOne);
    steps[1]?.run();
    expect(ideaNow(d, "lunchTurns").state).toBe("building");
  });

  it("to carrying on when something else has moved the idea in between", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    steps[0]?.run();
    const store = new Store(path.join(d.dir, "overnight.db"));
    store.transitionIdea(d.ids.lunchTurns, "build_failed", { failureReason: "an invented reason" }, NOW.toISOString());
    store.close();
    const before = fingerprint(d.dir);
    expect(String(failure(() => steps[1]?.run()))).toContain('comes when the idea is "building", and it is "build_failed"');
    expect(fingerprint(d.dir)).toEqual(before);
  });

  it("to an idea that is neither approved nor being built, to an id nobody has, and to an id that is not one", () => {
    const d = demo();
    const before = fingerprint(d.dir);
    for (const key of ["packingChecklist", "baleYieldCalculator", "recipeDoubler", "plantWateringDays", "carpoolTextAlerts", "practiceTallyCounter", "practiceDiceRoller"] as const) {
      expect(String(failure(() => demoNightSteps(d.dir, d.ids[key], d.config, d.clock))), key).toContain("plays an idea that is approved, or one that is being built");
    }
    for (const id of ["idea_20261018_00000000", "../../etc", "", "a/b", " ", "x".repeat(81)]) {
      expect(String(failure(() => demoNightSteps(d.dir, id, d.config, d.clock))), id).toContain("needs the id of one of the demo's ideas");
    }
    // Something that is not text never reaches the database, even if it would read as a real id.
    for (const id of [undefined, 7, { toString: () => d.ids.lunchTurns }, [d.ids.lunchTurns]]) {
      expect(String(failure(() => demoNightSteps(d.dir, id as unknown as string, d.config, d.clock)))).toContain("needs the id of one of the demo's ideas");
    }
    expect(fingerprint(d.dir)).toEqual(before);
  });

  it("to a clock that gives no real time", () => {
    const d = demo();
    const before = fingerprint(d.dir);
    for (const broken of [() => new Date(Number.NaN), () => "2026-10-18T07:02:00.000Z" as unknown as Date, () => undefined as unknown as Date]) {
      expect(failure(() => demoNightSteps(d.dir, d.ids.lunchTurns, d.config, broken)[0]?.run())).toBeInstanceOf(TypeError);
    }
    expect(fingerprint(d.dir)).toEqual(before);
  });
});

describe("where the invented night may write", () => {
  it("only in a folder the seed filled: an empty folder, a missing one, and a real Overnight database are all refused untouched", () => {
    const d = demo();
    const empty = path.join(scratch(), "empty");
    mkdirSync(empty);
    expect(refusal(() => demoNightSteps(empty, d.ids.lunchTurns, d.config, d.clock))).toBe(NOT_A_DEMO_FOLDER);
    expect(readdirSync(empty)).toEqual([]);
    expect(refusal(() => demoNightSteps(path.join(empty, "missing"), d.ids.lunchTurns, d.config, d.clock))).toBe(NOT_THERE);
    writeFileSync(path.join(empty, "a-file"), "");
    expect(refusal(() => demoNightSteps(path.join(empty, "a-file"), d.ids.lunchTurns, d.config, d.clock))).toBe(NOT_A_FOLDER);

    // A data folder made by the real Store, with an approved idea in it, but not by the demo. It is not even opened.
    const other = path.join(scratch(), "not-a-demo");
    mkdirSync(other);
    const store = new Store(path.join(other, "overnight.db"));
    const idea = store.createIdea({ title: "An invented idea", pitch: "An invented pitch.", quote: "", confidence: 1, conversationKey: "invented", detectorRunId: null }, NOW.toISOString());
    store.transitionIdea(idea.id, "asked", {}, NOW.toISOString());
    store.transitionIdea(idea.id, "approved", {}, NOW.toISOString());
    store.close();
    const before = fingerprint(other);
    expect(refusal(() => demoNightSteps(other, idea.id, d.config, d.clock))).toBe(NOT_A_DEMO_FOLDER);
    expect(fingerprint(other)).toEqual(before);

    // The same folder with the demo's note copied in: the database itself does not say "demo", so it is still refused.
    copyFileSync(path.join(d.dir, DEMO_MARKER_FILE), path.join(other, DEMO_MARKER_FILE));
    expect(refusal(() => demoNightSteps(other, idea.id, d.config, d.clock))).toBe(NOT_A_DEMO_FOLDER);
    const untouched = new Store(path.join(other, "overnight.db"));
    expect(untouched.getIdea(idea.id)?.state).toBe("approved");
    untouched.close();

    // A note that is not the seed's own, a folder under the note's name, and a note with no database beside it.
    for (const spoil of [(dir: string) => writeFileSync(path.join(dir, DEMO_MARKER_FILE), "SYNTHETIC? Trust me.\n"), (dir: string) => (rmSync(path.join(dir, DEMO_MARKER_FILE)), mkdirSync(path.join(dir, DEMO_MARKER_FILE))), (dir: string) => rmSync(path.join(dir, "overnight.db"))]) {
      const spoiled = demo();
      spoil(spoiled.dir);
      const asItWas = fingerprint(spoiled.dir);
      expect(refusal(() => demoNightSteps(spoiled.dir, spoiled.ids.lunchTurns, spoiled.config, spoiled.clock))).toBe(NOT_A_DEMO_FOLDER);
      // Nothing was opened or made: no new database, no helper files beside one.
      expect(fingerprint(spoiled.dir)).toEqual(asItWas);
    }
  });

  it("never in the real data folder, even if a whole demo folder was moved there, and not through a link to it", () => {
    const d = demo();
    const home = path.join(scratch(), "home");
    mkdirSync(home);
    // A seeded folder becomes the pretend real data folder, note and all.
    renameSync(d.dir, path.join(home, ".overnight"));
    vi.stubEnv("HOME", home);
    const real = path.join(home, ".overnight");
    const link = path.join(scratch(), "link");
    symlinkSync(real, link);
    const before = fingerprint(real);
    for (const dir of [real, link, path.join(home, ".OVERNIGHT")]) expect(refusal(() => demoNightSteps(dir, d.ids.lunchTurns, d.config, d.clock)), dir).toBe(IS_THE_REAL_FOLDER);
    expect(fingerprint(real)).toEqual(before);
  });

  it("stops if the folder stops being a demo folder half-way through the night", () => {
    const d = demo();
    const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
    steps[0]?.run();
    rmSync(path.join(d.dir, DEMO_MARKER_FILE));
    const before = fingerprint(d.dir);
    expect(refusal(() => steps[1]?.run())).toBe(NOT_A_DEMO_FOLDER);
    expect(fingerprint(d.dir)).toEqual(before);
  });

  it("does not write through a link planted inside the demo folder", () => {
    // Each case swaps one thing the next step writes to for a link that leads out of the folder.
    const cases: Array<{ runFirst: number; plant: (dir: string, id: string, outside: string) => void }> = [
      { runFirst: 4, plant: (dir, id, outside) => (renameSync(path.join(dir, "workspaces", id), path.join(dir, "workspaces", "moved")), symlinkSync(outside, path.join(dir, "workspaces", id))) },
      { runFirst: 5, plant: (dir, id, outside) => symlinkSync(path.join(outside, "package.json"), path.join(dir, "workspaces", id, "package.json")) },
      { runFirst: 7, plant: (dir, id, outside) => symlinkSync(outside, path.join(dir, "workspaces", id, "dist")) },
      { runFirst: 9, plant: (dir, _id, outside) => (renameSync(path.join(dir, "built"), path.join(dir, "built-moved")), symlinkSync(outside, path.join(dir, "built"))) },
      { runFirst: 1, plant: (dir, _id, outside) => (renameSync(path.join(dir, "logs", "build.log"), path.join(outside, "build.log")), symlinkSync(path.join(outside, "build.log"), path.join(dir, "logs", "build.log"))) },
      { runFirst: 10, plant: (dir, _id, outside) => (renameSync(path.join(dir, "logs"), path.join(dir, "logs-moved")), symlinkSync(outside, path.join(dir, "logs"))) },
      { runFirst: 11, plant: (dir, _id, outside) => (renameSync(path.join(dir, "screenshots"), path.join(dir, "screenshots-moved")), symlinkSync(outside, path.join(dir, "screenshots"))) },
      { runFirst: 13, plant: (dir, _id, outside) => (renameSync(path.join(dir, "reports"), path.join(dir, "reports-moved")), symlinkSync(outside, path.join(dir, "reports"))) },
      { runFirst: 14, plant: (dir, _id, outside) => (renameSync(path.join(dir, "reports"), path.join(dir, "reports-moved")), symlinkSync(outside, path.join(dir, "reports"))) },
      { runFirst: 0, plant: (dir, id, outside) => symlinkSync(outside, path.join(dir, "ideas", id)) },
      // Not a link, but something already standing where the finished build is to go: it is not built over.
      { runFirst: 9, plant: (dir, id, outside) => (mkdirSync(path.join(dir, "built", id)), writeFileSync(path.join(outside, "untouched"), "")) },
    ];
    for (const { runFirst, plant } of cases) {
      const d = demo();
      const steps = demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock);
      for (const step of steps.slice(0, runFirst)) step.run();
      const outside = path.join(scratch(), "outside");
      mkdirSync(outside);
      plant(d.dir, d.ids.lunchTurns, outside);
      const before = fingerprint(outside);
      const [ideaBefore, linesBefore] = [ideaNow(d, "lunchTurns"), linesLogged(d.dir)];
      expect(refusal(() => steps[runFirst]?.run()), `step ${steps[runFirst]?.name}`).toBe(LEADS_OUTSIDE);
      expect(fingerprint(outside), `step ${steps[runFirst]?.name}`).toEqual(before);
      // And the step is refused whole: the idea has not moved on, and no line was logged for it.
      expect(ideaNow(d, "lunchTurns"), `step ${steps[runFirst]?.name}`).toEqual(ideaBefore);
      expect(linesLogged(d.dir), `step ${steps[runFirst]?.name}`).toBe(linesBefore);
    }
  });

  it("writes nothing where the settings point, only in the folder it was handed", () => {
    const d = demo();
    const settingsFolder = path.join(scratch(), "where-the-settings-point");
    mkdirSync(settingsFolder);
    const config = parseConfig({ OVERNIGHT_DATA_DIR: settingsFolder, PAUSED: "false" });
    const parent = path.dirname(d.dir);
    for (const step of demoNightSteps(d.dir, d.ids.lunchTurns, config, d.clock)) step.run();
    expect(readdirSync(settingsFolder)).toEqual([]);
    expect(readdirSync(parent)).toEqual(["data"]);
    expect(ideaNow(d, "lunchTurns").state).toBe("delivered");
  });
});

describe("demoNightSteps on hostile data", () => {
  it("still plays, gives the app a plain folder name and a link that can never be real, and keeps the hostile title out of both", () => {
    const d = demo({ hostile: true });
    for (const step of demoNightSteps(d.dir, d.ids.lunchTurns, d.config, d.clock)) step.run();
    const idea = ideaNow(d, "lunchTurns");
    expect(idea.state).toBe("delivered");
    expect(idea.title).toContain("<xss-probe>");
    expect(idea.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(idea.publishedUrl).toBe(`https://example.invalid/overnight-apps/${idea.slug}/`);
    // The invented app's page is the same for every idea: no word of the title is put into HTML by hand.
    expect(readFileSync(path.join(dataPaths(d.dir).built, idea.id, "dist", "index.html"), "utf8")).not.toContain("xss-probe");

    // The idea that was already being built carries a hostile folder name from the seed. The link is made from a plain one.
    expect(ideaNow(d, "choreWheel").slug).toContain("<xss-probe>");
    for (const step of demoNightSteps(d.dir, d.ids.choreWheel, d.config, d.clock)) step.run();
    expect(ideaNow(d, "choreWheel").publishedUrl).toMatch(/^https:\/\/example\.invalid\/overnight-apps\/[a-z0-9]+(-[a-z0-9]+)*\/$/);
  });
});
