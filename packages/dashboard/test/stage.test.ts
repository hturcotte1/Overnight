// SYNTHETIC: every title, pitch, quote and line in these tests is made up by the demo's seed. None of it is Bee data.
//
// The demo's stage (src/demo/stage.ts): the throwaway folder `npm run dashboard:demo` shows, its
// pretend clock, the locks it holds so the page says "Listening", and the invented night.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Store } from "@overnight/core";
import type { Idea } from "@overnight/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRunning } from "../src/data/locks.ts";
import { DEMO_MARKER_FILE, DemoFolderError, IS_THE_REAL_FOLDER } from "../src/demo/folder.ts";
import { DEMO_NIGHT_STEP_NAMES } from "../src/demo/night-script.ts";
import { DEMO_FOLDER_PREFIX, MORNING_ORDER, openDemoStage, PLAY_ORDER, PLAY_PLAN, PLAY_STARTS_AFTER_MS, PLAY_STEP_EVERY_MS } from "../src/demo/stage.ts";
import type { DemoStage } from "../src/demo/stage.ts";
import { createSnapshotSource } from "../src/data/snapshot.ts";
import { groupNights, lastNightOf, storyOf, tonightQueue } from "../src/story.ts";
import { NOT_FILMING, removeScratch, scratch } from "./demo-server.ts";

const stages: DemoStage[] = [];
function open(o: Parameters<typeof openDemoStage>[0] = {}): { stage: DemoStage; under: string; dir: string } {
  const under = o.under ?? scratch();
  const stage = openDemoStage({ ...o, under });
  stages.push(stage);
  return { stage, under, dir: stage.config.dataDir };
}

afterEach(() => {
  for (const stage of stages.splice(0)) stage.close();
  removeScratch();
  vi.unstubAllEnvs();
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const boiseClock = (at: Date): string => new Intl.DateTimeFormat("en-US", { timeZone: "America/Boise", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at);
function stateOf(dir: string, ideaId: string): string | undefined {
  const store = new Store(path.join(dir, "overnight.db"));
  try {
    return store.getIdea(ideaId)?.state;
  } finally {
    store.close();
  }
}

function ideaOf(dir: string, ideaId: string): Idea {
  const store = new Store(path.join(dir, "overnight.db"));
  try {
    const idea = store.getIdea(ideaId);
    if (idea === null) throw new Error("the idea is gone");
    return idea;
  } finally {
    store.close();
  }
}

const BUILD_STEPS = DEMO_NIGHT_STEP_NAMES.slice(0, DEMO_NIGHT_STEP_NAMES.indexOf("built") + 1);
const MORNING_STEPS = DEMO_NIGHT_STEP_NAMES.slice(DEMO_NIGHT_STEP_NAMES.indexOf("built") + 1);
/**
 * The whole night, as [idea, step]: the build the scene opens on is finished (it is two files in),
 * the next idea is built, and then the morning takes the app built last first. Only the first app
 * of the morning has the step that starts the morning's run.
 */
const WHOLE_NIGHT: Array<[string, string]> = [
  ...BUILD_STEPS.slice(BUILD_STEPS.indexOf("file-node-modules")).map((step): [string, string] => ["choreWheel", step]),
  ...BUILD_STEPS.map((step): [string, string] => ["lunchTurns", step]),
  ...MORNING_STEPS.map((step): [string, string] => ["lunchTurns", step]),
  ...MORNING_STEPS.filter((step) => step !== "deliver-starting").map((step): [string, string] => ["choreWheel", step]),
];

describe("opening the demo's stage", () => {
  it("makes one new folder of its own, says in it that the data is invented, and fills it with the scene", () => {
    const { stage, under, dir } = open();
    expect(readdirSync(under)).toEqual([path.basename(dir)]);
    expect(path.basename(dir).startsWith(DEMO_FOLDER_PREFIX)).toBe(true);
    expect(path.dirname(dir)).toBe(under);
    expect(readFileSync(path.join(dir, DEMO_MARKER_FILE), "utf8").startsWith("SYNTHETIC data:")).toBe(true);
    expect(stage.paths.root).toBe(dir);
    expect(stage.paths.database).toBe(path.join(dir, "overnight.db"));
    expect(Object.keys(stage.ideaIds)).toHaveLength(13);
    expect(stateOf(dir, stage.ideaIds.choreWheel)).toBe("building");
    expect(stateOf(dir, stage.ideaIds.lunchTurns)).toBe("approved");
  });

  it("takes its settings from the defaults, never from the environment or .env", () => {
    vi.stubEnv("OVERNIGHT_DATA_DIR", "/invented/elsewhere");
    vi.stubEnv("MAX_ASKS_PER_DAY", "9");
    vi.stubEnv("TZ", "Asia/Tokyo");
    vi.stubEnv("PAUSED", "true");
    const { stage, dir } = open();
    expect(stage.config).toMatchObject({ dataDir: dir, maxAsksPerDay: 3, timeZone: "America/Boise", pausedByDefault: false, buildTime: "01:00", deliverTime: "07:00", maxBuildsPerNight: 2 });
  });

  it("starts a pretend clock at 1:02 AM that runs on beside the real one", () => {
    let real = Date.parse("2026-10-11T22:47:13.000Z");
    const { stage } = open({ realNow: () => real });
    expect(boiseClock(stage.now())).toBe("1:02:00 AM");
    // The next 1:02 AM, not one gone by.
    expect(stage.now().getTime() - real).toBeGreaterThan(0);
    expect(stage.now().getTime() - real).toBeLessThanOrEqual(24 * 3_600_000);
    real += 83_000;
    expect(boiseClock(stage.now())).toBe("1:03:23 AM");
  });

  it("holds the listener's and the build's locks, as the scene has it at 1:02 AM", () => {
    const { dir } = open();
    expect(readRunning(dir)).toEqual({ listener: true, build: true, deliver: false });
  });

  it("refuses a place inside the real data folder before making anything there", () => {
    const home = scratch();
    const real = path.join(home, ".overnight");
    mkdirSync(real);
    vi.stubEnv("HOME", home);
    for (const under of [real, path.join(real, "tmp")]) {
      let thrown: unknown;
      try {
        openDemoStage({ under });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DemoFolderError);
      expect((thrown as Error).message).toBe(IS_THE_REAL_FOLDER);
    }
    expect(readdirSync(real)).toEqual([]);
    // Beside the real folder is fine: the home folder holds it, a new folder in the home folder does not.
    const beside = openDemoStage({ under: home });
    stages.push(beside);
    expect(readdirSync(home).sort()).toEqual([".overnight", path.basename(beside.config.dataDir)].sort());
    expect(readdirSync(real)).toEqual([]);
  });

  // By these two names the place used to be let through: a stage was opened inside the real data
  // folder under the first, and under the second an empty folder was made there and removed again.
  it.runIf(process.platform === "darwin")("refuses a place inside the real data folder by the Mac's other names for it, and makes nothing there even for a moment", () => {
    const home = scratch();
    const real = path.join(home, ".overnight");
    mkdirSync(path.join(real, "tmp"), { recursive: true });
    vi.stubEnv("HOME", home);
    const numbers = statSync(real, { bigint: true });
    // A folder's time of last change moves when anything is made or removed in it.
    const changed = (): string => `${statSync(real, { bigint: true }).mtimeNs} ${statSync(path.join(real, "tmp"), { bigint: true }).mtimeNs}`;
    const before = changed();
    for (const under of [path.join("/System/Volumes/Data", real), path.join("/System/Volumes/Data", real, "tmp"), `/.vol/${numbers.dev}/${numbers.ino}`, `/.vol/${numbers.dev}/${numbers.ino}/tmp`]) {
      let thrown: unknown;
      try {
        stages.push(openDemoStage({ under }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, under).toBeInstanceOf(DemoFolderError);
      expect((thrown as Error).message, under).toBe(IS_THE_REAL_FOLDER);
      expect((thrown as Error).message).not.toContain(home);
    }
    expect(readdirSync(real)).toEqual(["tmp"]);
    expect(readdirSync(path.join(real, "tmp"))).toEqual([]);
    expect(changed()).toBe(before);
    // Beside the real folder, by the same kind of name, is fine.
    const beside = openDemoStage({ under: path.join("/System/Volumes/Data", home) });
    stages.push(beside);
    expect(readdirSync(home).sort()).toEqual([".overnight", path.basename(beside.config.dataDir)].sort());
    expect(changed()).toBe(before);
  });

  it("leaves nothing behind when the scene cannot be made", () => {
    const under = scratch();
    // A clock that gives no time: the seed refuses it, after the folder was made.
    expect(() => openDemoStage({ under, realNow: () => Number.NaN })).toThrow();
    expect(readdirSync(under)).toEqual([]);
  });
});

describe("the invented night", () => {
  it("goes in the order of a real night: both ideas are built, one after the other, and then the morning delivers both", () => {
    expect(PLAY_ORDER).toEqual(["choreWheel", "lunchTurns"]);
    expect(MORNING_ORDER).toEqual(["lunchTurns", "choreWheel"]);
    expect(PLAY_PLAN).toEqual([
      { idea: "choreWheel", program: "build" },
      { idea: "lunchTurns", program: "build" },
      { idea: "lunchTurns", program: "deliver" },
      { idea: "choreWheel", program: "deliver" },
    ]);
    let real = Date.parse("2026-10-11T22:00:00.000Z");
    const { stage, dir } = open({ realNow: () => real });
    expect(stage.lastStepIdea()).toBeNull();
    const told: Array<[string, string]> = [];
    const running: string[] = [];
    for (;;) {
      real += PLAY_STEP_EVERY_MS;
      const name = stage.nextStep();
      if (name === null) break;
      told.push([stage.lastStepIdea() ?? "nobody", name]);
      const now = readRunning(dir);
      expect(now.listener, name).toBe(true);
      running.push(now.build === true ? "build" : now.deliver === true ? "deliver" : "none");
      expect(now.build === true && now.deliver === true, name).toBe(false);
    }
    expect(told).toEqual(WHOLE_NIGHT);
    // The build program is "running" without a break until both ideas are built, and the morning's
    // program from its first step until the last app is delivered. After that nothing runs.
    const builds = WHOLE_NIGHT.filter(([, step]) => (BUILD_STEPS as readonly string[]).includes(step)).length;
    expect(running).toEqual([...Array.from({ length: builds }, () => "build"), ...Array.from({ length: WHOLE_NIGHT.length - builds - 1 }, () => "deliver"), "none"]);
    expect(stateOf(dir, stage.ideaIds.choreWheel)).toBe("delivered");
    expect(stateOf(dir, stage.ideaIds.lunchTurns)).toBe("delivered");
    // Over: nothing more happens, however often it is asked.
    expect(stage.nextStep()).toBeNull();
    expect(stage.nextStep()).toBeNull();
    expect(readRunning(dir)).toEqual({ listener: true, build: false, deliver: false });
  });

  // The night used to be played at 1:02 AM from end to end: an app was "sent to the wrist" at 1:02 AM, inside
  // the quiet hours the Settings page states, seconds after the headline had said "Checks start at 6:30 AM".
  it("skips the pretend clock to the morning: the checks at 6:30 AM, and nobody told before 7:00 AM", () => {
    let real = Date.parse("2026-10-11T22:00:00.000Z");
    const { stage, dir } = open({ realNow: () => real });
    const at: Record<string, string> = {};
    for (;;) {
      real += PLAY_STEP_EVERY_MS;
      const name = stage.nextStep();
      if (name === null) break;
      at[`${stage.lastStepIdea()} ${name}`] = boiseClock(stage.now());
    }
    // The night: both builds, a few seconds apart, from 1:02 AM on.
    expect(at["choreWheel file-node-modules"]).toBe("1:02:02 AM");
    expect(at["lunchTurns built"]).toBe("1:02:35 AM");
    // The morning: the checks start half an hour before DELIVER_TIME, and the clock runs on from there.
    expect(at["lunchTurns deliver-starting"]).toBe("6:30:00 AM");
    expect(at["lunchTurns live-and-published"]).toBe("6:30:07 AM");
    // DELIVER_TIME, when the quiet hours are over: the first app is "sent to the wrist". The clock is moved once, not for every app.
    expect(at["lunchTurns told-and-delivered"]).toBe("7:00:00 AM");
    expect(at["choreWheel verified"]).toBe("7:00:05 AM");
    expect(at["choreWheel told-and-delivered"]).toBe("7:00:12 AM");
    expect(boiseClock(stage.now())).toBe("7:00:17 AM");

    // What the database says, which is what the pages show.
    const clockOf = (iso: string | null): string => (iso === null ? "never" : boiseClock(new Date(iso)));
    const [chore, lunch] = [ideaOf(dir, stage.ideaIds.choreWheel), ideaOf(dir, stage.ideaIds.lunchTurns)];
    expect([clockOf(lunch.builtAt), clockOf(lunch.publishedAt), clockOf(lunch.deliveredAt)]).toEqual(["1:02:35 AM", "6:30:07 AM", "7:00:00 AM"]);
    expect([clockOf(chore.builtAt), clockOf(chore.publishedAt), clockOf(chore.deliveredAt)]).toEqual(["1:02:10 AM", "7:00:10 AM", "7:00:12 AM"]);
    // Nothing is delivered in the quiet hours (ASK_CUTOFF to DELIVER_TIME).
    for (const idea of [chore, lunch]) expect(Date.parse(idea.deliveredAt ?? "")).toBeGreaterThanOrEqual(Date.parse(lunch.deliveredAt ?? ""));
    expect(stage.config).toMatchObject({ askCutoff: "23:00", deliverTime: "07:00" });
  });

  // While the night played, the third idea in line used to flip between "waits for another night" and
  // "tonight" four times, the night's line ended on "2 of 3 worked", and the ticks read "Checked 2.5 s".
  it("never has the page contradict itself while it plays", () => {
    let real = Date.parse("2026-10-11T22:00:00.000Z");
    const { stage } = open({ realNow: () => real });
    const source = createSnapshotSource({ config: stage.config, paths: stage.paths, filming: NOT_FILMING, now: stage.now, reuseMs: 0 });
    const recipe: string[] = [];
    const headlines: string[] = [];
    const seen = (): void => {
      const look = source.get();
      const queue = tonightQueue(look, stage.config);
      const row = queue.rows.find((candidate) => candidate.idea.id === stage.ideaIds.recipeDoubler);
      const words = row === undefined ? "not listed" : row.when;
      if (recipe.at(-1) !== words) recipe.push(words);
      const night = lastNightOf(groupNights(look, stage.config), stage.now(), stage.config);
      const line = night === null ? "no night" : `${night.label}: ${night.night.headline}`;
      if (headlines.at(-1) !== line) headlines.push(line);
    };
    seen();
    for (;;) {
      real += PLAY_STEP_EVERY_MS;
      if (stage.nextStep() === null) break;
      seen();
    }
    // The build that was cut short waits while tonight's run builds its two, and is next night's from the morning on. It changes once.
    expect(recipe).toEqual(["later", "tonight"]);
    // Two apps delivered and none failed: the cut-short build is said on its own, not as a failure.
    expect(headlines).toEqual([
      "Tonight: Building now.",
      "Tonight: Built. Checks start at 6:30 AM.",
      "Tonight: Building now.",
      "Tonight: Built. Checks start at 6:30 AM.",
      "Last night: Built. The morning's checks are running now.",
      "Last night: Worked: 2 apps built and delivered. 1 cut short, to be built once more.",
    ]);

    // The night's ticks carry invented lengths of time, not the player's two and a half seconds.
    const look = source.get();
    const nights = groupNights(look, stage.config);
    expect(nights[0]).toMatchObject({ built: 2, delivered: 2, failed: 0, cutShort: 1 });
    expect(nights[0]?.buildRun).toMatchObject({ command: "build", built: 2, failed: 0 });
    expect(boiseClock(new Date(nights[0]?.buildRun?.finishedAt ?? 0))).toBe("1:02:35 AM");
    expect(nights[0]?.deliverRun).toMatchObject({ command: "build", delivered: 2, failed: 0 });
    expect([boiseClock(new Date(nights[0]?.deliverRun?.startedAt ?? 0)), boiseClock(new Date(nights[0]?.deliverRun?.finishedAt ?? 0))]).toEqual(["6:30:00 AM", "7:00:15 AM"]);
    for (const key of PLAY_ORDER) {
      const idea = look.ideas.find((candidate) => candidate.id === stage.ideaIds[key]);
      if (idea === undefined) throw new Error("the idea is not in the look");
      const story = storyOf(idea, look.events.get(idea.id) ?? [], look.build.get(idea.id) ?? null, look.deliver.get(idea.id) ?? null, null, { now: stage.now(), running: look.running, paused: look.paused, nextBuildAt: look.nextBuildAt, nextDeliverAt: look.nextDeliverAt, config: stage.config });
      const details = story.checks.map((check) => `${check.label} ${check.detail ?? ""}`.trim());
      expect(details.join(" | "), key).not.toContain("2.5 s");
      expect(details.find((detail) => detail.startsWith("Checked in the sandbox")), key).toMatch(/^Checked in the sandbox (6\.6|5\.2|7\.4) s · 3 files$/);
      expect(details.find((detail) => detail.startsWith("Live after")), key).toMatch(/^Live after (26|21|31) s$/);
    }
  });

  it("plays by itself, a step at a time, once", async () => {
    const { stage, dir } = open();
    let done = 0;
    await new Promise<void>((resolve) => {
      const options = { startsAfterMs: 1, everyMs: 1, onDone: () => { done += 1; resolve(); }, onProblem: () => resolve() };
      stage.play(options);
      // Asked twice: still one night.
      stage.play(options);
    });
    await pause(30);
    expect(done).toBe(1);
    expect(stateOf(dir, stage.ideaIds.choreWheel)).toBe("delivered");
    expect(stateOf(dir, stage.ideaIds.lunchTurns)).toBe("delivered");
  });

  it("waits three seconds before it starts and two and a half between steps, unless told otherwise", () => {
    expect(PLAY_STARTS_AFTER_MS).toBe(3000);
    expect(PLAY_STEP_EVERY_MS).toBe(2500);
    vi.useFakeTimers();
    try {
      const { stage, dir } = open();
      stage.play();
      vi.advanceTimersByTime(2999);
      expect(existsSync(path.join(dir, "workspaces", stage.ideaIds.choreWheel, "node_modules"))).toBe(false);
      vi.advanceTimersByTime(1);
      expect(existsSync(path.join(dir, "workspaces", stage.ideaIds.choreWheel, "node_modules"))).toBe(true);
      vi.advanceTimersByTime(2499);
      expect(existsSync(path.join(dir, "workspaces", stage.ideaIds.choreWheel, "dist", "index.html"))).toBe(false);
      vi.advanceTimersByTime(1);
      expect(existsSync(path.join(dir, "workspaces", stage.ideaIds.choreWheel, "dist", "index.html"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once when the stage is closed", async () => {
    const { stage, dir } = open();
    let done = false;
    let problem = false;
    stage.play({ startsAfterMs: 1, everyMs: 20, onDone: () => (done = true), onProblem: () => (problem = true) });
    await pause(50);
    stage.close();
    expect(existsSync(dir)).toBe(false);
    await pause(80);
    expect(done).toBe(false);
    expect(problem).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(stage.nextStep()).toBeNull();
  });

  it("stops, and says what kind of thing went wrong, when a step is refused", async () => {
    const { stage, dir } = open();
    // The seed's note is gone: the folder no longer counts as the demo's own, and the night will not write into it.
    rmSync(path.join(dir, DEMO_MARKER_FILE));
    const told: string[] = [];
    await new Promise<void>((resolve) => {
      const tell = (kind: string): void => {
        told.push(kind);
        resolve();
      };
      stage.play({ startsAfterMs: 1, everyMs: 1, onProblem: tell, onDone: () => tell("done") });
    });
    await pause(40);
    // Told once, and the night did not go on to try the next step.
    expect(told).toEqual(["DemoFolderError"]);
    expect(stateOf(dir, stage.ideaIds.choreWheel)).toBe("building");
  });
});

describe("closing the stage", () => {
  it("lets go of the locks and removes the folder, and can be asked twice", () => {
    const { stage, under, dir } = open();
    stage.nextStep();
    stage.close();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(under)).toEqual([]);
    stage.close();
    expect(readdirSync(under)).toEqual([]);
  });

  it("never removes a folder that does not carry the seed's note", () => {
    const { stage, under, dir } = open();
    rmSync(path.join(dir, DEMO_MARKER_FILE));
    stage.close();
    // Left where it is, with everything in it. (It is under the test's own scratch folder, which is removed afterwards.)
    expect(readdirSync(under)).toEqual([path.basename(dir)]);
    expect(existsSync(path.join(dir, "overnight.db"))).toBe(true);
    // The locks were let go all the same.
    expect(readRunning(dir)).toEqual({ listener: false, build: false, deliver: false });
  });
});
