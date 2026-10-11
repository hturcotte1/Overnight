// All text in this file is made up for the tests. Nothing is built, nothing is published, and
// Bee is never reached: the builder and the deliver step are fakes, every data folder and every
// "home folder" is a scratch folder, and the real ~/.overnight is never looked at.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dataPaths, ensureDataDirs, parseConfig, silentLogger, Store } from "@overnight/core";
import type { BeeGateway } from "@overnight/core";
import { processIo, REHEARSE_USAGE, runCli } from "../src/cli.ts";
import type { CliIo } from "../src/cli.ts";
import type { DeliverRunDeps, DeliverSteps } from "../src/commands/deliver.ts";
import {
  isRehearsalIdea,
  MAX_REHEARSAL_PITCH_CHARS,
  MAX_REHEARSAL_TITLE_CHARS,
  REHEARSAL_APPROVED_NOTE,
  REHEARSAL_ASKED_NOTE,
  REHEARSAL_CONVERSATION_KEY,
  REHEARSAL_DELIVERED_NOTE,
  REHEARSAL_NOTE,
  rehearsalFolderRefusal,
} from "../src/commands/rehearse.ts";
import type { Context } from "../src/context.ts";
import { nearestRealPath, readEnvFileText, realDataFolders, REHEARSAL_WHY, rehearsalFolderProblem } from "../src/rehearsal-folder.ts";
import { createStandInBee, createStandInPublisher, REHEARSAL_BEE_LOG, rehearsalBeeLogFile, STAND_IN_ID, STAND_IN_SITE } from "../src/rehearsal-stand-ins.ts";
import { USAGE } from "../src/usage.ts";
import { addIdea, capture, moveIdea, SAMPLE_IDEAS } from "./helpers.ts";
import { LAST_RESORT_LINE } from "../src/last-resort.ts";
import { aborted, collectingLogger, fakeBuild, fakeLastResort, fakeLocks, fakeStopSignals } from "./night-fakes.ts";
import type { FakeBackend } from "./night-fakes.ts";

// The real Bee package, replaced for this whole file by one that counts. If the rehearsal path
// ever loads it, or makes a gateway with it, these numbers say so. A package is loaded once per
// test file, so `loaded` is never reset: it counts for the whole file, and the very last test
// shows that the count works by loading the package itself, for the first time.
const beePackage = vi.hoisted(() => ({ loaded: 0, gatewaysMade: 0 }));
vi.mock("@overnight/bee", () => {
  beePackage.loaded += 1;
  return {
    createBeeGateway: () => {
      beePackage.gatewaysMade += 1;
      throw new Error("the real Bee gateway was made during a test");
    },
  };
});

const TITLE = "Rehearsal Zebra Dice Roller";
const PITCH = "Roll one to six dice on a phone and show the total.";
const REAL_LOOKING_LINK = "https://example.invalid/apps/rehearsal-zebra-dice-roller/";

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight rehearse "));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

let counter = 0;
/** A made-up Mac: a home folder with a "real" data folder in it, and a scratch folder for rehearsals. */
function madeUpMac() {
  counter += 1;
  const root = path.join(scratch, `mac ${counter}`);
  const home = path.join(root, "home of someone");
  const realData = path.join(home, ".overnight");
  mkdirSync(realData, { recursive: true });
  return { root, home, realData, rehearsalData: path.join(root, "rehearsal data") };
}

// ---------- which folder a rehearsal may use ----------

describe("where a rehearsal may run", () => {
  const problem = (mac: ReturnType<typeof madeUpMac>, given: string | undefined, envFileText: string | null = null) => rehearsalFolderProblem({ given, home: mac.home, envFileText });

  it("refuses, in one sentence that says why, when OVERNIGHT_DATA_DIR was not given to the command", () => {
    const mac = madeUpMac();
    for (const given of [undefined, "", "   "]) {
      const said = problem(mac, given);
      expect(said, JSON.stringify(given)).toBe(
        `Not started: a rehearsal only runs on a scratch data folder named on the command itself (OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse ...), because ${REHEARSAL_WHY}.`,
      );
    }
    expect(REHEARSAL_WHY).toBe("a test idea left in the real database would be picked up by the real nightly jobs");
    // A folder that depends on where the command is run from is no folder to rely on.
    expect(problem(mac, "some/relative/folder")).toContain("must be a full path");
    expect(problem(mac, "some/relative/folder")).toContain(REHEARSAL_WHY);
  });

  it("refuses the real data folder however it is written: plainly, with ~, with a slash, in other capitals, through a link, or a folder inside it", () => {
    const mac = madeUpMac();
    const link = path.join(mac.root, "a link to the real data");
    symlinkSync(mac.realData, link);
    const linkedHome = path.join(mac.root, "a link to the home folder");
    symlinkSync(mac.home, linkedHome);
    const refused = `Not started: OVERNIGHT_DATA_DIR points at the real data folder (${mac.realData}), and a rehearsal never runs there, because ${REHEARSAL_WHY}.`;
    for (const given of [
      mac.realData,
      `${mac.realData}/`,
      `  ${mac.realData}  `,
      "~/.overnight",
      path.join(mac.home, ".Overnight"),
      link,
      path.join(linkedHome, ".overnight"),
      path.join(mac.home, "somewhere", "..", ".overnight"),
      path.join(mac.realData, "rehearsal"),
      path.join(link, "deeper", "still"),
    ]) {
      expect(problem(mac, given), given).toBe(refused);
    }
    // One sentence: one line, one full stop at its end.
    expect(refused).not.toContain("\n");
    expect(refused.endsWith(".")).toBe(true);
  });

  it("refuses the folder the repo's .env names too: that is where the background jobs keep the real database", () => {
    const mac = madeUpMac();
    const elsewhere = path.join(mac.root, "the real data, elsewhere");
    const env = `# made up for this test\nOVERNIGHT_DATA_DIR=${elsewhere}\nMAX_ASKS_PER_DAY=3\n`;
    expect(realDataFolders(mac.home, env)).toEqual([mac.realData, elsewhere]);
    expect(problem(mac, elsewhere, env)).toBe(`Not started: OVERNIGHT_DATA_DIR points at the real data folder (${elsewhere}), and a rehearsal never runs there, because ${REHEARSAL_WHY}.`);
    expect(problem(mac, path.join(elsewhere, "inside"), env)).toContain("points at the real data folder");
    // The default folder stays refused: a job falls back to it the day .env loses that line.
    expect(problem(mac, mac.realData, env)).toContain("points at the real data folder");
    // A blank or relative value in .env names no folder; "~" in it is the home folder.
    expect(realDataFolders(mac.home, "OVERNIGHT_DATA_DIR=\n")).toEqual([mac.realData]);
    expect(realDataFolders(mac.home, "OVERNIGHT_DATA_DIR=relative/place\n")).toEqual([mac.realData]);
    expect(realDataFolders(mac.home, "OVERNIGHT_DATA_DIR=~/other-data\n")).toEqual([mac.realData, path.join(mac.home, "other-data")]);
    expect(realDataFolders(mac.home, "OVERNIGHT_DATA_DIR=~/.overnight\n")).toEqual([mac.realData]);
  });

  it("allows a scratch folder, there or not there yet, also one whose name only starts like the real one", () => {
    const mac = madeUpMac();
    expect(problem(mac, mac.rehearsalData)).toBeNull();
    mkdirSync(mac.rehearsalData);
    expect(problem(mac, mac.rehearsalData)).toBeNull();
    expect(problem(mac, path.join(mac.home, ".overnight-rehearsal"))).toBeNull();
    expect(problem(mac, path.join(mac.home, ".overnight2", "data"))).toBeNull();
    // The home folder itself is not the data folder: its database would be another file.
    expect(problem(mac, mac.home)).toBeNull();
  });

  it("follows links for as much of a path as exists, and keeps the rest as written", () => {
    const mac = madeUpMac();
    const link = path.join(mac.root, "link");
    symlinkSync(mac.home, link);
    const realHome = nearestRealPath(mac.home);
    expect(nearestRealPath(link)).toBe(realHome);
    expect(nearestRealPath(path.join(link, ".overnight"))).toBe(path.join(realHome, ".overnight"));
    expect(nearestRealPath(path.join(link, "not", "there", "yet"))).toBe(path.join(realHome, "not", "there", "yet"));
  });

  it("reads the repo's .env only to learn the real folder, and says so when it cannot", () => {
    const mac = madeUpMac();
    expect(readEnvFileText(mac.root)).toBeNull();
    writeFileSync(path.join(mac.root, ".env"), "OVERNIGHT_DATA_DIR=/made-up/place\n");
    expect(readEnvFileText(mac.root)).toBe("OVERNIGHT_DATA_DIR=/made-up/place\n");
    // A folder where the file should be: it is there, and it cannot be read.
    const odd = path.join(mac.root, "odd repo");
    mkdirSync(path.join(odd, ".env"), { recursive: true });
    expect(() => readEnvFileText(odd)).toThrow("the repo's .env file could not be read, so the real data folder is not known");
  });

  it("asks the question of the environment as the process was given it", () => {
    vi.stubEnv("OVERNIGHT_DATA_DIR", "/made-up/given/folder");
    expect(processIo.givenDataDir()).toBe("/made-up/given/folder");
    vi.stubEnv("OVERNIGHT_DATA_DIR", undefined as unknown as string);
    expect(processIo.givenDataDir()).toBeUndefined();
    // The real check on this Mac, asked only about folders that are nowhere near the real one.
    expect(processIo.rehearsalFolderProblem(undefined)).toContain(REHEARSAL_WHY);
    expect(processIo.rehearsalFolderProblem(path.join(scratch, "nowhere near"))).toBeNull();
  });
});

// ---------- the stand-ins ----------

describe("the stand-ins for Bee and for the publisher", () => {
  it("write what would have been sent to a private file, and reach nothing", async () => {
    const mac = madeUpMac();
    mkdirSync(mac.rehearsalData);
    const file = rehearsalBeeLogFile(dataPaths(mac.rehearsalData));
    expect(file).toBe(path.join(mac.rehearsalData, REHEARSAL_BEE_LOG));
    expect(REHEARSAL_BEE_LOG).toBe("rehearsal-bee.log");
    const now = () => new Date("2026-10-10T20:00:00.000Z");
    const bee = createStandInBee({ file, now });

    expect(await bee.createTodo("☀️ Built overnight: Zebra dice → https://rehearsal.invalid/zebra-dice/", new Date("2026-10-11T13:00:00.000Z"))).toEqual({ id: STAND_IN_ID });
    expect(await bee.createFact('Overnight built "Zebra dice" on Oct 10: https://rehearsal.invalid/zebra-dice/')).toEqual({ id: STAND_IN_ID });
    expect(STAND_IN_ID).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      { at: "2026-10-10T20:00:00.000Z", wouldCreate: "todo", text: "☀️ Built overnight: Zebra dice → https://rehearsal.invalid/zebra-dice/", alarmAt: "2026-10-11T13:00:00.000Z" },
      { at: "2026-10-10T20:00:00.000Z", wouldCreate: "fact", text: 'Overnight built "Zebra dice" on Oct 10: https://rehearsal.invalid/zebra-dice/' },
    ]);

    // Reading answers as an empty, logged-in Bee would. There is nothing to listen to.
    expect(await bee.loginState()).toBe("logged-in");
    expect(await bee.todoStatus(7)).toBe("open");
    expect(await bee.changedSince(null)).toEqual({ nextCursor: null, conversationIds: [] });
    expect(await bee.transcriptSince(1, 0)).toBeNull();
    expect(() => bee.stream(() => {})).toThrow("A rehearsal has no Bee to listen to");
    expect(() => bee.dispose()).not.toThrow();

    const publisher = createStandInPublisher({ file, now });
    expect(await publisher.publish({ ideaId: "idea_x", slug: "zebra-dice", distDir: "/made-up/dist", marker: "m" })).toEqual({ ok: true, url: "https://rehearsal.invalid/zebra-dice/", liveAfterMs: 0 });
    expect(STAND_IN_SITE).toBe("https://rehearsal.invalid");
    expect(JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "")).toEqual({ at: "2026-10-10T20:00:00.000Z", wouldPublish: "zebra-dice" });
  });

  it("make a log that was open to others private again, and never write through a link", async () => {
    const mac = madeUpMac();
    mkdirSync(mac.rehearsalData);
    const file = path.join(mac.rehearsalData, REHEARSAL_BEE_LOG);
    writeFileSync(file, "", { mode: 0o644 });
    await createStandInBee({ file }).createFact("a made-up fact");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const target = path.join(mac.root, "some other file");
    writeFileSync(target, "untouched\n");
    const linked = path.join(mac.root, "linked log");
    symlinkSync(target, linked);
    await expect(createStandInBee({ file: linked }).createTodo("a made-up to-do", new Date())).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
  });
});

// ---------- the command, through the command line ----------

type DeliverCall = { ideaId: string; deps: DeliverRunDeps };

/**
 * The `overnight` command line on a made-up Mac, with a real database file in a scratch data
 * folder. The builder and the deliver step are fakes that move the idea the way the real ones
 * do. `deliverFactories` and `beeLoginState` are left as the REAL wiring on purpose: reaching for
 * either would load the (replaced) Bee package, and the counts above would show it.
 */
function rehearsalCli(options: { settings?: Record<string, string>; given?: string | null; overrides?: Partial<CliIo>; publishFails?: boolean; buildHangs?: boolean } = {}) {
  const mac = madeUpMac();
  const dataDir = options.given === undefined || options.given === null ? mac.rehearsalData : options.given;
  const out = capture();
  const err = capture();
  const opened: Context[] = [];
  const open = vi.fn<() => Context>(() => {
    // The product default: a new data folder starts in quiet mode.
    const config = parseConfig({ OVERNIGHT_DATA_DIR: dataDir, ...options.settings });
    const paths = dataPaths(config.dataDir);
    ensureDataDirs(paths);
    const context = { config, paths, store: new Store(paths.database) };
    opened.push(context);
    return context;
  });
  const order: string[] = [];
  const build = fakeBuild({
    order,
    one: async (ideaId, deps) => {
      deps.store.transitionIdea(ideaId, "building", { slug: "rehearsal-zebra-dice-roller", buildBackend: deps.backends.primary.name, buildStartedAt: new Date().toISOString(), note: "building with a made-up builder" }, new Date().toISOString());
      if (options.buildHangs) {
        // A build that only ends when it is told to stop.
        await aborted(deps.signal);
        return { ok: false, backend: deps.backends.primary.name, ms: 1, reason: "made-up: stopped", couldNotStart: false };
      }
      deps.store.transitionIdea(ideaId, "built", { builtAt: new Date().toISOString(), note: "built with a made-up builder in 1 s" }, new Date().toISOString());
      return { ok: true, backend: deps.backends.primary.name, ms: 1_000 };
    },
  });
  const deliverCalls: DeliverCall[] = [];
  const steps: DeliverSteps = {
    runDeliver: async () => {
      throw new Error("a rehearsal delivers one idea, never a whole morning");
    },
    // Like the real step: publish (with the publisher it was handed, or "the real one"), then tell Bee.
    deliverOne: async (ideaId, deps) => {
      order.push(`deliverOne ${ideaId}`);
      deliverCalls.push({ ideaId, deps });
      const idea = deps.store.getIdea(ideaId);
      if (idea === null) return { ok: false, reason: "made-up: no such idea" };
      const published = deps.publish ? await deps.publish.publish({ ideaId, slug: idea.slug ?? "none", distDir: "/made-up/dist", marker: "made-up" }) : { ok: true as const, url: REAL_LOOKING_LINK, liveAfterMs: 5 };
      if (!published.ok || options.publishFails) return { ok: false, reason: "made-up: the publish failed" };
      const at = new Date().toISOString();
      deps.store.transitionIdea(ideaId, "published", { publishedUrl: published.url, publishedAt: at, note: "made-up: published" }, at);
      const todo = await deps.bee.createTodo(`Built overnight: ${idea.title} -> ${published.url}`, new Date("2026-10-11T13:00:00.000Z"));
      const fact = await deps.bee.createFact(`Overnight built "${idea.title}": ${published.url}`);
      deps.store.transitionIdea(ideaId, "delivered", { deliveredAt: at, morningTodoId: todo.id, factId: fact.id }, at);
      return { ok: true, url: published.url };
    },
  };
  const deliverSteps = vi.fn<CliIo["deliverSteps"]>(async () => (order.push("load deliver steps"), steps));
  const locks = fakeLocks({ order });
  const stop = fakeStopSignals();
  const lastResort = fakeLastResort();
  const logs = { build: collectingLogger("build"), deliver: collectingLogger("deliver") };
  const io: Partial<CliIo> = {
    write: out.write,
    writeError: err.write,
    open,
    givenDataDir: () => (options.given === null ? undefined : dataDir),
    rehearsalFolderProblem: (given) => rehearsalFolderProblem({ given, home: mac.home, envFileText: null }),
    buildFactories: build.load,
    deliverSteps,
    jobLogger: (_paths, name) => logs[name].logger,
    takeJobLock: locks.takeLock,
    watchStopSignals: stop.watch,
    watchLastResort: lastResort.watch,
    listenFactories: () => Promise.reject(new Error("this test did not expect the listener")),
    listenLogger: () => silentLogger,
    takeListenLock: () => {
      throw new Error("this test did not expect the listen lock to be taken");
    },
    ...options.overrides,
  };
  /** Look inside the scratch database after the command has closed it. */
  const look = <T>(read: (store: Store) => T): T => {
    const store = new Store(path.join(dataDir, "overnight.db"));
    try {
      return read(store);
    } finally {
      store.close();
    }
  };
  return { mac, dataDir, out, err, open, opened, order, build, deliverCalls, deliverSteps, stop, lastResort, logs, look, beeLog: path.join(dataDir, REHEARSAL_BEE_LOG), run: (...argv: string[]) => runCli(argv, io) };
}

describe("overnight rehearse new", () => {
  it("adds one invented idea, already approved and dated yesterday, and prints its id and nothing else on standard output", async () => {
    const before = Date.now();
    const t = rehearsalCli();
    expect(await t.run("rehearse", "new", TITLE, PITCH)).toBe(0);
    expect(t.out.lines).toHaveLength(1);
    const id = t.out.lines[0] ?? "";
    expect(id).toMatch(/^idea_\d{8}_[0-9a-f]{8}$/);

    const idea = t.look((store) => store.getIdea(id));
    expect(idea).toMatchObject({ state: "approved", title: TITLE, pitch: PITCH, quote: "", conversationKey: REHEARSAL_CONVERSATION_KEY, todoId: null, note: REHEARSAL_APPROVED_NOTE });
    expect(isRehearsalIdea(idea ?? { conversationKey: "" })).toBe(true);
    // Yesterday: heard a day and ten minutes ago, approved a day ago.
    const day = 24 * 3_600_000;
    expect(Date.parse(idea?.createdAt ?? "")).toBeGreaterThanOrEqual(before - day - 600_000 - 1_000);
    expect(Date.parse(idea?.createdAt ?? "")).toBeLessThanOrEqual(Date.now() - day - 600_000);
    expect(Date.parse(idea?.answeredAt ?? "")).toBeLessThanOrEqual(Date.now() - day);
    expect(Date.parse(idea?.answeredAt ?? "") - Date.parse(idea?.createdAt ?? "")).toBe(600_000);
    // Every step of its short history says what it is.
    expect(t.look((store) => store.ideaEvents(id)).map((event) => [event.toState, event.note])).toEqual([
      ["heard", REHEARSAL_NOTE],
      ["asked", REHEARSAL_ASKED_NOTE],
      ["approved", REHEARSAL_APPROVED_NOTE],
    ]);
    for (const note of [REHEARSAL_NOTE, REHEARSAL_ASKED_NOTE, REHEARSAL_APPROVED_NOTE, REHEARSAL_DELIVERED_NOTE]) expect(note.startsWith("rehearsal: ")).toBe(true);
    // It counts against nobody's limits for today.
    const today = { start: new Date(Date.now() - 3_600_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() };
    expect(t.look((store) => store.countAsksBetween(today.start, today.end))).toBe(0);
    // What a person needs to know went to standard error.
    expect(t.err.lines.at(-1)).toBe(`Added a rehearsal idea, already approved. Build and deliver it with: npx overnight rehearse run ${id}`);
    // Nothing of Bee, nothing built, nothing delivered.
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
    expect(t.build.loads).toBe(0);
    expect(t.deliverSteps).not.toHaveBeenCalled();
  });

  it("switches a brand-new folder out of quiet mode, says so, and leaves a folder someone has paused or resumed alone", async () => {
    const t = rehearsalCli();
    expect(await t.run("rehearse", "new", TITLE, PITCH)).toBe(0);
    // The product default is quiet mode; nobody had chosen anything in this folder.
    expect(t.opened[0]?.config.pausedByDefault).toBe(true);
    expect(t.look((store) => [store.getValue("paused"), store.isPaused(true)])).toEqual(["false", false]);
    expect(t.err.lines[0]).toBe("This data folder had never been paused or resumed, so quiet mode was switched off in it: a build is refused in quiet mode.");

    // Paused on purpose afterwards: a second idea does not undo that, and says nothing about it.
    expect(await t.run("pause")).toBe(0);
    expect(await t.run("rehearse", "new", "Rehearsal Zebra Coin Flip", "Flip a coin and keep a tally.")).toBe(0);
    expect(t.look((store) => store.isPaused(false))).toBe(true);
    expect(t.err.lines.filter((line) => line.includes("quiet mode"))).toHaveLength(1);
    expect(t.look((store) => store.listIdeas()).map((idea) => idea.state)).toEqual(["approved", "approved"]);
  });

  it("refuses, before anything is opened or created, unless OVERNIGHT_DATA_DIR names a scratch folder", async () => {
    const notGiven = rehearsalCli({ given: null });
    expect(await notGiven.run("rehearse", "new", TITLE, PITCH)).toBe(2);
    expect(notGiven.err.lines).toEqual([`Not started: a rehearsal only runs on a scratch data folder named on the command itself (OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse ...), because ${REHEARSAL_WHY}.`]);
    expect(notGiven.open).not.toHaveBeenCalled();
    expect(notGiven.out.lines).toEqual([]);

    // The made-up Mac's own "real" data folder, named outright.
    const real = rehearsalCli();
    const onReal = rehearsalCli({ given: real.mac.realData, overrides: { rehearsalFolderProblem: (given) => rehearsalFolderProblem({ given, home: real.mac.home, envFileText: null }) } });
    for (const argv of [["rehearse", "new", TITLE, PITCH], ["rehearse", "run", "idea_20261010_aaaa1111"], ["rehearse", "run", "idea_20261010_aaaa1111", "--no-publish"]]) {
      expect(await onReal.run(...argv)).toBe(2);
    }
    expect(onReal.err.lines).toHaveLength(3);
    for (const line of onReal.err.lines) expect(line).toBe(`Not started: OVERNIGHT_DATA_DIR points at the real data folder (${real.mac.realData}), and a rehearsal never runs there, because ${REHEARSAL_WHY}.`);
    expect(onReal.open).not.toHaveBeenCalled();
    // Not even the database file was made.
    expect(existsSync(path.join(real.mac.realData, "overnight.db"))).toBe(false);
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
  });

  it("asks again about the folder that was really opened, and adds nothing when that one is the real one", async () => {
    // The environment names a scratch folder, but the settings (say, by a mistake in how they are read) open the real one.
    const t = rehearsalCli();
    const realOpen = vi.fn<() => Context>(() => {
      const config = parseConfig({ OVERNIGHT_DATA_DIR: t.mac.realData });
      const paths = dataPaths(config.dataDir);
      return { config, paths, store: new Store(":memory:") };
    });
    const asked: Array<string | undefined> = [];
    const mistaken = rehearsalCli({
      overrides: {
        open: realOpen,
        rehearsalFolderProblem: (given) => (asked.push(given), rehearsalFolderProblem({ given, home: t.mac.home, envFileText: null })),
      },
    });
    const store = vi.spyOn(Store.prototype, "createIdea");
    try {
      expect(await mistaken.run("rehearse", "new", TITLE, PITCH)).toBe(2);
      expect(await mistaken.run("rehearse", "run", "idea_20261010_aaaa1111")).toBe(2);
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    // First what the command was given, then the folder that was opened.
    expect(asked).toEqual([mistaken.dataDir, t.mac.realData, mistaken.dataDir, t.mac.realData]);
    expect(mistaken.err.lines).toHaveLength(2);
    expect(mistaken.err.lines[0]).toContain("points at the real data folder");
    expect(mistaken.out.lines).toEqual([]);
    expect(mistaken.build.loads).toBe(0);
  });

  it("refuses words it cannot use, and anything that is not one of its two forms", async () => {
    const t = rehearsalCli();
    expect(await t.run("rehearse", "new", "   ", PITCH)).toBe(2);
    expect(await t.run("rehearse", "new", TITLE, "\n")).toBe(2);
    expect(t.err.lines.slice(-2)).toEqual(Array(2).fill('A rehearsal idea needs a title and a pitch: overnight rehearse new "<title>" "<pitch>"'));
    expect(await t.run("rehearse", "new", "x".repeat(MAX_REHEARSAL_TITLE_CHARS + 1), PITCH)).toBe(2);
    expect(await t.run("rehearse", "new", TITLE, "x".repeat(MAX_REHEARSAL_PITCH_CHARS + 1))).toBe(2);
    expect(t.err.lines.at(-1)).toBe("Too long: a title has at most 80 characters and a pitch at most 400.");
    expect(t.look((store) => store.listIdeas())).toEqual([]);
    // A title is kept on one line.
    expect(await t.run("rehearse", "new", "Zebra\ndice\u001b[2J", PITCH)).toBe(0);
    expect(t.look((store) => store.listIdeas())[0]?.title).toBe("Zebra dice [2J");

    const usage = rehearsalCli();
    for (const argv of [["rehearse"], ["rehearse", "new"], ["rehearse", "new", TITLE], ["rehearse", "run"], ["rehearse", "run", "a", "b"], ["rehearse", "dance", "a"], ["rehearse", "new", TITLE, PITCH, "--no-publish"]]) {
      expect(await usage.run(...argv), argv.join(" ")).toBe(2);
      // The problem, a blank line, then the usage text.
      expect(usage.err.lines.slice(-3), argv.join(" ")).toEqual([REHEARSE_USAGE, "", USAGE]);
    }
    expect(await usage.run("rehearse", "run", "a", "--publish")).toBe(2);
    expect(await usage.run("rehearse", "new", TITLE, PITCH, "extra")).toBe(2);
    expect(usage.open).not.toHaveBeenCalled();
  });
});

describe("overnight rehearse run", () => {
  async function seeded(options: Parameters<typeof rehearsalCli>[0] = {}) {
    const t = rehearsalCli(options);
    expect(await t.run("rehearse", "new", TITLE, PITCH)).toBe(0);
    const id = t.out.lines[0] ?? "";
    t.out.lines.length = 0;
    t.err.lines.length = 0;
    return { ...t, id };
  }

  it("builds the idea, delivers it to a stand-in Bee, and never makes or even loads the real Bee gateway", async () => {
    const t = await seeded();
    expect(await t.run("rehearse", "run", t.id)).toBe(0);

    // The real builder's place was taken by a fake; the deliver step was loaded on its own.
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.id}`, "release build.lock", "lock deliver.lock", "load deliver steps", `deliverOne ${t.id}`, "release deliver.lock"]);
    // The assertion this file exists for: @overnight/bee was not loaded, and no gateway was made.
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });

    // What the deliver step was handed as Bee is the stand-in: all it did was write two lines.
    const bee = t.deliverCalls[0]?.deps.bee as BeeGateway;
    expect(await bee.loginState()).toBe("logged-in");
    const lines = readFileSync(t.beeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toMatchObject([
      { wouldCreate: "todo", text: `Built overnight: ${TITLE} -> ${REAL_LOOKING_LINK}`, alarmAt: "2026-10-11T13:00:00.000Z" },
      { wouldCreate: "fact", text: `Overnight built "${TITLE}": ${REAL_LOOKING_LINK}` },
    ]);
    expect(statSync(t.beeLog).mode & 0o777).toBe(0o600);
    // Without --no-publish the deliver step is handed no publisher: it uses its own, real one.
    expect(t.deliverCalls[0]?.deps.publish).toBeUndefined();

    const idea = t.look((store) => store.getIdea(t.id));
    expect(idea).toMatchObject({ state: "delivered", publishedUrl: REAL_LOOKING_LINK, morningTodoId: STAND_IN_ID, factId: STAND_IN_ID, note: REHEARSAL_DELIVERED_NOTE });
    expect(t.out.lines).toEqual([
      `Rehearsal: Bee is a stand-in. What it would have been told goes to ${t.beeLog}`,
      "Rehearsal: this run PUBLISHES the app for real, on the public apps page. (--no-publish skips that.)",
      `Idea ${t.id}: ${TITLE}`,
      "1. Build: starting with kiro-crew (kiro-cli if that fails). This can take up to 45 minutes each.",
      "  Built by kiro-crew in 1 second.",
      "2. Deliver: installing, building and testing a clean copy inside the sandbox, then publishing.",
      '  Done: the idea is now "delivered".',
      `Link: ${REAL_LOOKING_LINK}`,
      `Nothing was sent to Bee. What it would have been told is in ${t.beeLog}`,
    ]);
    expect(t.err.lines).toEqual([]);
    // The stop signals and the last resort are watched for the whole run, and let go of afterwards.
    expect([t.stop.handlers(), t.lastResort.handlers()]).toEqual([0, 0]);
  });

  it("says in both logs that it is a rehearsal, under its own name, and logs ids only", async () => {
    const t = await seeded();
    expect(await t.run("rehearse", "run", t.id, "--no-publish")).toBe(0);
    const started = "overnight rehearse: a rehearsal run is starting; Bee is a stand-in, so nothing in this run reaches the wearer";
    expect(t.logs.build.lines.map((line) => line.message)).toEqual([started, "overnight rehearse: build starting", "overnight rehearse: build finished"]);
    expect(t.logs.deliver.lines.map((line) => line.message)).toEqual([started, "overnight rehearse: deliver starting", "overnight rehearse: deliver finished", "overnight rehearse: the rehearsal run is over"]);
    expect(t.logs.build.lines[0]).toMatchObject({ ideaId: t.id, beeStandIn: true, publisherStandIn: true });
    expect(t.logs.deliver.lines.at(-1)).toMatchObject({ ideaId: t.id, exitCode: 0, state: "delivered" });
    expect(t.logs.build.text() + t.logs.deliver.text()).not.toContain(TITLE);
  });

  it("on an error nobody caught: one error line under its own name, the build told to stop, the lock let go, exit 1", async () => {
    const t = await seeded({ buildHangs: true });
    const running = t.run("rehearse", "run", t.id, "--no-publish");
    await expect.poll(() => t.build.oneCalls.length).toBe(1);
    expect(t.lastResort.handlers()).toBe(2);
    t.lastResort.send("uncaughtException", new Error(`made-up secret about ${TITLE}`));
    expect(t.lastResort.exits).toEqual([1]);
    expect(t.build.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.id}`, "release build.lock"]);
    expect(t.logs.build.lines.filter((line) => line.level === "error")).toMatchObject([{ message: `overnight rehearse: ${LAST_RESORT_LINE}`, kind: "uncaughtException", error: "Error" }]);
    expect(t.logs.build.text() + t.err.text()).not.toContain("made-up secret");
    await running;
    expect(t.lastResort.handlers()).toBe(0);
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
  });

  it("stops cleanly on a stop signal, like build-now: the build is told, the lock is let go, and the exit code is the signal's", async () => {
    const t = await seeded({ buildHangs: true });
    const running = t.run("rehearse", "run", t.id);
    await expect.poll(() => t.build.oneCalls.length).toBe(1);
    t.stop.send("SIGTERM");
    expect(await running).toBe(143);
    expect(t.order.at(-1)).toBe("release build.lock");
    expect(t.deliverSteps).not.toHaveBeenCalled();
    expect(t.logs.build.lines.filter((line) => line.level === "warn")).toMatchObject([{ message: "overnight rehearse: stop signal received: stopping what is running, then ending", signal: "SIGTERM" }]);
    expect(t.stop.handlers()).toBe(0);
  });

  it("with --no-publish hands the deliver step a stand-in publisher too, and says nothing was published", async () => {
    const t = await seeded();
    expect(await t.run("rehearse", "run", t.id, "--no-publish")).toBe(0);
    expect(typeof t.deliverCalls[0]?.deps.publish?.publish).toBe("function");
    const link = `${STAND_IN_SITE}/rehearsal-zebra-dice-roller/`;
    expect(t.look((store) => store.getIdea(t.id))).toMatchObject({ state: "delivered", publishedUrl: link, note: REHEARSAL_DELIVERED_NOTE });
    const lines = readFileSync(t.beeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toMatchObject([{ wouldPublish: "rehearsal-zebra-dice-roller" }, { wouldCreate: "todo", text: `Built overnight: ${TITLE} -> ${link}` }, { wouldCreate: "fact" }]);
    expect(t.out.lines[1]).toBe("Rehearsal: the publisher is a stand-in too (--no-publish). Nothing leaves this Mac but the build's own downloads.");
    expect(t.out.lines.slice(-3)).toEqual([`Link: ${link}`, `Nothing was sent to Bee. What it would have been told is in ${t.beeLog}`, "Nothing was published: any link above is a stand-in."]);
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
  });

  it("lets BUILD_BACKEND pick the builder, as for any build", async () => {
    const t = await seeded({ settings: { BUILD_BACKEND: "kiro-cli", BUILD_SANDBOX: "crew" } });
    expect(await t.run("rehearse", "run", t.id, "--no-publish")).toBe(0);
    const backends = t.build.oneCalls[0]?.deps.backends as { primary: FakeBackend; fallback: FakeBackend };
    expect([backends.primary.name, backends.fallback.name]).toEqual(["kiro-cli", "kiro-crew"]);
    expect(backends.fallback.sandboxMode).toBe("crew");
    expect(t.out.lines).toContain("1. Build: starting with kiro-cli (kiro-crew if that fails). This can take up to 45 minutes each.");
    expect(t.look((store) => store.getIdea(t.id)?.buildBackend)).toBe("kiro-cli");
  });

  it("only ever builds an idea a rehearsal made", async () => {
    const t = await seeded();
    // An idea of the ordinary kind, approved, in the same scratch database.
    const heard = t.look((store) => moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, new Date(Date.now() - 7_200_000).toISOString()), ["asked", "approved"], new Date(Date.now() - 7_000_000).toISOString()));
    expect(await t.run("rehearse", "run", heard.id)).toBe(1);
    expect(t.err.lines).toEqual(['Not started: that idea was not made by "overnight rehearse new", and a rehearsal only ever builds an invented idea.']);
    expect(await t.run("rehearse", "run", "idea_20261010_00000000")).toBe(1);
    expect(t.err.lines.at(-1)).toBe('No idea has the id "idea_20261010_00000000". Make one with: npx overnight rehearse new "<title>" "<pitch>"');
    expect(t.build.loads).toBe(0);
    expect(t.deliverSteps).not.toHaveBeenCalled();
    expect(t.look((store) => store.getIdea(heard.id)?.state)).toBe("approved");
    expect(existsSync(t.beeLog)).toBe(false);
  });

  it("is refused in quiet mode like any build, and keeps the idea's own note when the run does not go all the way", async () => {
    const paused = await seeded();
    expect(await paused.run("pause")).toBe(0);
    expect(await paused.run("rehearse", "run", paused.id)).toBe(1);
    expect(paused.err.lines.at(-1)).toContain("Overnight is paused");
    expect(paused.look((store) => store.getIdea(paused.id)?.state)).toBe("approved");

    const failing = await seeded({ publishFails: true });
    expect(await failing.run("rehearse", "run", failing.id)).toBe(1);
    expect(failing.err.lines).toEqual(["  Not delivered: made-up: the publish failed"]);
    // Built, not delivered: the note is the builder's, and nothing claims a delivery.
    expect(failing.look((store) => store.getIdea(failing.id))).toMatchObject({ state: "built", note: "built with a made-up builder in 1 s" });
    expect(failing.out.lines.at(-1)).toBe(`Nothing was sent to Bee. What it would have been told is in ${failing.beeLog}`);
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
  });
});

describe("a data folder that holds a rehearsal idea", () => {
  it("is refused by the commands that talk to the real Bee: listen, deliver and build-now", async () => {
    const t = rehearsalCli();
    expect(await t.run("rehearse", "new", TITLE, PITCH)).toBe(0);
    const id = t.out.lines[0] ?? "";
    for (const argv of [["listen"], ["deliver"], ["build-now", id]]) {
      t.err.lines.length = 0;
      expect(await t.run(...argv), argv[0]).toBe(1);
      expect(t.err.lines).toEqual([
        `Not started: this data folder holds a rehearsal idea (made by "overnight rehearse new"), and "overnight ${argv[0]}" talks to the real Bee, so it does not run here. Use "npx overnight rehearse run <ideaId>" for those, or a data folder with no rehearsal in it.`,
      ]);
    }
    // Nothing was loaded, locked or made for any of the three.
    expect(t.order).toEqual([]);
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
    expect(t.look((store) => store.getIdea(id)?.state)).toBe("approved");
    // The commands that only read, or that never reach Bee, still run there.
    expect(await t.run("ideas", "--all")).toBe(0);
    expect(t.out.lines.at(-1)).toContain(`[rehearsal] ${TITLE}`);
  });

  it("is told from an ordinary one by the ideas in it, and counts them", () => {
    const store = new Store(":memory:");
    expect(rehearsalFolderRefusal(store, "deliver")).toBeNull();
    moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, new Date().toISOString()), ["asked", "approved"], new Date().toISOString());
    expect(rehearsalFolderRefusal(store, "deliver")).toBeNull();
    for (const title of ["One", "Two"]) store.createIdea({ title, pitch: "p", quote: "", confidence: 1, conversationKey: REHEARSAL_CONVERSATION_KEY, detectorRunId: null }, new Date().toISOString());
    expect(rehearsalFolderRefusal(store, "deliver")).toContain("this data folder holds 2 rehearsal ideas");
    store.close();
  });
});

// Keep this one LAST in the file (see the note at the top about `loaded`).
describe("the counts these tests rely on", () => {
  it("do notice the ordinary deliver wiring loading the Bee package and making a gateway, which no test above did", async () => {
    // Nothing above loaded the Bee package or made a gateway: not one rehearsal, refused or run.
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });
    // The rehearsal's own road, on the real wiring: @overnight/deliver, and still no Bee.
    const steps = await processIo.deliverSteps();
    expect(typeof steps.deliverOne).toBe("function");
    expect(typeof steps.runDeliver).toBe("function");
    expect(beePackage).toEqual({ loaded: 0, gatewaysMade: 0 });

    // The road `overnight deliver` and `overnight build-now` take. A rehearsal must never take it.
    const factories = await processIo.deliverFactories();
    expect(beePackage.loaded).toBe(1);
    expect(() => factories.createBee({ logger: silentLogger })).toThrow("the real Bee gateway was made during a test");
    expect(beePackage.gatewaysMade).toBe(1);
  });
});
