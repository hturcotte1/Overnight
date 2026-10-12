// All text in this file is made up for the tests. None of it is Bee data.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closedRun, ConfigError, currentSlot, dataPaths, noteChecked, noticedRun, parseConfig, readCheckedAt, readLastNightRun, readNightRun, silentLogger, startedRun, writeNightRun } from "@overnight/core";
import type { BeeGateway, ClockedJob, LoginState } from "@overnight/core";
import { readListenerState } from "../src/background.ts";
import { processIo, runCli } from "../src/cli.ts";
import type { CliIo } from "../src/cli.ts";
import { BUILD_PAUSED_LINE } from "../src/commands/build.ts";
import { BUILD_NOW_PAUSED } from "../src/commands/build-now.ts";
import { PAUSED_LINE, RESUMED_LINE } from "../src/commands/pause.ts";
import { PREFLIGHT_READY, PREFLIGHT_TITLE } from "../src/commands/preflight.ts";
import type { PreflightProbes } from "../src/commands/preflight.ts";
import { ALREADY_RUNNING } from "../src/commands/listen.ts";
import type { ListenFactories } from "../src/commands/listen.ts";
import { PAUSED_QUEUE_NOTE } from "../src/commands/queue.ts";
import { openContext, repoRoot } from "../src/context.ts";
import type { Context } from "../src/context.ts";
import { watchLastResort } from "../src/last-resort.ts";
import { lockHeld, takeListenLock, takeLock } from "../src/single-instance.ts";
import { watchForSleep } from "../src/sleep-watch.ts";
import { watchStopSignals } from "../src/stop-signals.ts";
import { USAGE } from "../src/usage.ts";
import { realDeliverSteps } from "../src/wiring.ts";
import { addIdea, at, capture, fixedNow, moveIdea, NOON, SAMPLE_IDEAS, testContext } from "./helpers.ts";
import { aborted, collectingLogger, fakeBuild, fakeDeliver, fakeKeepAwake, fakeLastResort, fakeLocks, fakeSleepWatch, fakeStopSignals } from "./night-fakes.ts";

/**
 * A command line whose every outside part is a fake. `open`, the Bee check, the listener parts,
 * the builder, the deliver step, the locks, the look at the Kiro Crew gateway and preflight's
 * questions fail the test if a command reaches for them without the test having offered them.
 * The look at the real lock file and the real ~/Library/LaunchAgents is faked too, and stop
 * signals and errors nobody caught are made-up ones: no real one is listened to. Nothing really
 * holds the Mac awake, sets a timer to watch for its sleep, asks the internet or waits. A
 * rehearsal is refused unless the test allows it. `settings` are the test's own.
 */
function harness(overrides: Partial<CliIo> = {}, settings: Record<string, string> = {}) {
  const out = capture();
  const err = capture();
  const context = testContext(settings);
  // The command line closes the store when it is done. Keep it open so the test can look inside.
  const close = vi.spyOn(context.store, "close").mockImplementation(() => {});
  const awake = fakeKeepAwake();
  const sleepWatch = fakeSleepWatch();
  const io: Partial<CliIo> = {
    write: out.write,
    writeError: err.write,
    now: fixedNow(),
    open: () => context,
    beeLoginState: () => Promise.reject(new Error("this test did not expect a Bee call")),
    listenFactories: () => Promise.reject(new Error("this test did not expect the listener")),
    listenLogger: () => silentLogger,
    takeListenLock: () => {
      throw new Error("this test did not expect the listen lock to be taken");
    },
    listenerState: () => ({ running: false, jobInstalled: false }),
    nightJobsState: () => ({ build: false, deliver: false, crew: false }),
    buildFactories: () => Promise.reject(new Error("this test did not expect the builder")),
    deliverFactories: () => Promise.reject(new Error("this test did not expect the deliver step")),
    jobLogger: () => silentLogger,
    takeJobLock: () => {
      throw new Error("this test did not expect a build or deliver lock to be taken");
    },
    gatewayAnswers: () => Promise.reject(new Error("this test did not expect a look at the Kiro Crew gateway")),
    watchStopSignals: fakeStopSignals().watch,
    watchLastResort: fakeLastResort().watch,
    preflightProbes: () => Promise.reject(new Error("this test did not expect preflight's checks")),
    deliverSteps: () => Promise.reject(new Error("this test did not expect the deliver step on its own")),
    givenDataDir: () => undefined,
    rehearsalFolderProblem: () => "Not started: this test did not expect a rehearsal.",
    jobLockHeld: () => false,
    powerSource: async () => "mains",
    isOnline: () => Promise.reject(new Error("this test did not expect a look at the internet")),
    sleep: () => Promise.reject(new Error("this test did not expect to wait")),
    keepAwake: awake.keepAwake,
    watchForSleep: sleepWatch.watch,
    jobTriggers: () => ({ build: null, deliver: null }),
    jobsBelongHere: () => null,
    ...overrides,
  };
  return { out, err, context, close, awake, sleepWatch, run: (...argv: string[]) => runCli(argv, io) };
}

describe("overnight (command line)", () => {
  it("prints the usage text and exits 0 for --help, -h and help", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["status", "--help"]]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(0);
      expect(h.out.text()).toBe(USAGE);
      expect(h.err.lines).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("exits 2 with the usage text for an unknown command, and opens nothing", async () => {
    for (const argv of [["dance"], ["constructor"], []]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(2);
      expect(h.out.lines).toEqual([]);
      expect(h.err.text()).toContain(USAGE);
      expect(open).not.toHaveBeenCalled();
    }
    const h = harness();
    await h.run("dance");
    expect(h.err.lines[0]).toBe('"dance" is not an Overnight command.');
  });

  it("exits 2 for a switch or extra word a command does not know", async () => {
    for (const argv of [["status", "--jsno"], ["pause", "--json"], ["ideas", "today"], ["queue", "--approved", "--json", "--all"]]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(2);
      expect(h.err.text()).toContain("does not understand");
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("reads the queue only when asked with both switches", async () => {
    for (const argv of [["queue"], ["queue", "--approved"], ["queue", "--json"]]) {
      const h = harness();
      expect(await h.run(...argv)).toBe(2);
      expect(h.out.lines).toEqual([]);
      expect(h.err.text()).toContain("overnight queue --approved --json");
    }

    const h = harness();
    const idea = addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(h.context.store, idea, ["asked", "approved"], at(-500));
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(JSON.parse(h.out.text())).toEqual([{ id: idea.id, ...SAMPLE_IDEAS.turns, approvedAt: at(-440) }]);
    expect(h.err.lines).toEqual([]);
  });

  it("hands the builder an empty queue while paused, with the reason on standard error only", async () => {
    const h = harness();
    const idea = addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(h.context.store, idea, ["asked", "approved"], at(-500));

    expect(await h.run("pause")).toBe(0);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(h.out.lines).toEqual([PAUSED_LINE, "[]"]);
    expect(h.err.lines).toEqual([PAUSED_QUEUE_NOTE]);

    expect(await h.run("resume")).toBe(0);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(JSON.parse(h.out.lines.at(-1) ?? "")).toEqual([{ id: idea.id, ...SAMPLE_IDEAS.turns, approvedAt: at(-440) }]);
    expect(h.err.lines).toEqual([PAUSED_QUEUE_NOTE]);
  });

  it("applies the nightly build limit from the settings to the queue", async () => {
    const h = harness();
    const approved = [SAMPLE_IDEAS.turns, SAMPLE_IDEAS.plants, SAMPLE_IDEAS.chores].map((sample, index) => {
      const idea = addIdea(h.context.store, sample, at(-900 + index));
      moveIdea(h.context.store, idea, ["asked", "approved"], at(-800 + index * 100));
      return idea;
    });
    // The test settings leave MAX_BUILDS_PER_NIGHT at its default of 2.
    expect(h.context.config.maxBuildsPerNight).toBe(2);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect((JSON.parse(h.out.text()) as Array<{ id: string }>).map((queued) => queued.id)).toEqual([approved[0]?.id, approved[1]?.id]);
  });

  it("runs pause and resume against the store, and closes it afterwards", async () => {
    const h = harness();
    expect(await h.run("pause")).toBe(0);
    expect(h.context.store.isPaused(false)).toBe(true);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(await h.run("resume")).toBe(0);
    expect(h.context.store.isPaused(true)).toBe(false);
    expect(h.out.lines).toEqual([PAUSED_LINE, RESUMED_LINE]);
  });

  it("runs status without touching Bee, and with --check asks only for the login state", async () => {
    const quiet = harness({ gatewayAnswers: async () => false });
    expect(await quiet.run("status")).toBe(0);
    expect(quiet.out.lines[0]).toBe("Overnight status");
    expect(quiet.out.text()).not.toContain("Bee login");
    expect(quiet.out.lines[2]).toBe("  Listener           not running (background job not installed). Start it with: scripts/install-agents.sh install listen");

    // The look at the listener is given this data folder's paths.
    const listenerState = vi.fn<CliIo["listenerState"]>(() => ({ running: true, jobInstalled: true }));
    const running = harness({ listenerState, gatewayAnswers: async () => true });
    expect(await running.run("status", "--json")).toBe(0);
    expect(listenerState).toHaveBeenCalledWith(running.context.paths);
    expect(JSON.parse(running.out.text())).toMatchObject({ listener: { running: true, jobInstalled: true }, newestUtteranceAt: null });

    const beeLoginState = vi.fn<() => Promise<LoginState>>(async () => "logged-out");
    const checked = harness({ beeLoginState, gatewayAnswers: async () => true });
    expect(await checked.run("status", "--check", "--json")).toBe(0);
    expect(beeLoginState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(checked.out.text())).toMatchObject({ paused: false, utterances: 0, beeLogin: "logged-out" });
  });

  it("runs ideas with its switches", async () => {
    const h = harness();
    addIdea(h.context.store, SAMPLE_IDEAS.chores, at(-20 * 3600));
    addIdea(h.context.store, SAMPLE_IDEAS.plants, at(-600));
    expect(await h.run("ideas")).toBe(0);
    expect(h.out.lines[0]).toBe("1 idea today:");
    expect(await h.run("ideas", "--all", "--json")).toBe(0);
    expect(JSON.parse(h.out.lines.at(-1) ?? "")).toHaveLength(2);
  });

  it("lists the night's commands in the usage text, with the switch the background jobs use and the one the installer uses", () => {
    for (const command of ["  build [--if-due]  ", "  deliver [--if-due]  ", "  build --from-now, deliver --from-now\n", "  build-now <ideaId>  ", "  queue --approved --json  "]) expect(USAGE).toContain(command);
    expect(USAGE).toContain("Start that job's clock from now: nothing missed before now is run. The\n                              installer uses it.");
    expect(USAGE).toContain("With --if-due it first asks Overnight's own clock whether it is time");
  });

  it("lists the rehearsal in the usage text: both forms, the stand-in for Bee, and the folder it refuses", () => {
    expect(USAGE).toContain('  rehearse new "<title>" "<pitch>"');
    expect(USAGE).toContain("  rehearse run <ideaId> [--no-publish]");
    expect(USAGE).toContain("Bee is\n                              always a stand-in here");
    expect(USAGE).toContain("rehearsal-bee.log");
    expect(USAGE).toContain("never run on the real data folder");
    expect(USAGE).toContain("OVERNIGHT_DATA_DIR");
    // The four commands that refuse a rehearsal folder in turn.
    expect(USAGE).toContain("listen, build, deliver and\n                              build-now in turn refuse a data folder that holds a rehearsal idea.");
  });

  it("lists preflight and the stop behaviour in the usage text", () => {
    expect(USAGE).toContain("  preflight  ");
    expect(USAGE).toContain("Thirteen checks of what tonight's run needs");
    expect(USAGE).toContain("whether they keep\n                              their own time");
    expect(USAGE).toContain("Exit code 0 only if");
    expect(USAGE).toContain("stop cleanly on Ctrl-C or a stop signal");
    expect(USAGE).toContain("Mac slept through part of a run");
    // A second try is promised only to a build that has one left.
    expect(USAGE).toContain("a build stopped on its first start gets\n                              one more try on a later night, and a delivery waits for the next run.");
    expect(USAGE).not.toContain("what was stopped is tried again");
  });

  it("shows the night's readiness in status: jobs, their clock, gateway, sandbox mode, power, and never loads the builder", async () => {
    // The harness's builder rejects if anything loads it.
    const gatewayAnswers = vi.fn<CliIo["gatewayAnswers"]>(async () => true);
    const powerSource = vi.fn<CliIo["powerSource"]>(async () => "battery");
    const jobLockHeld = vi.fn<CliIo["jobLockHeld"]>(() => false);
    const jobsBelongHere = vi.fn<CliIo["jobsBelongHere"]>(() => true);
    const night = { nightJobsState: () => ({ build: true, deliver: true, crew: true }), jobTriggers: () => ({ build: "timer" as const, deliver: "timer" as const }) };
    const h = harness({ gatewayAnswers, powerSource, jobLockHeld, jobsBelongHere, ...night, listenerState: () => ({ running: true, jobInstalled: true }) });
    // Both jobs asked the clock a minute before the harness's noon.
    for (const job of ["build", "deliver"] as const) noteChecked(h.context.store, job, new Date(at(-60)));
    expect(await h.run("status")).toBe(0);
    expect(gatewayAnswers).toHaveBeenCalledTimes(1);
    expect(powerSource).toHaveBeenCalledTimes(1);
    expect(h.out.lines.slice(-9)).toEqual([
      "  Next build         Oct 10, 1:00 AM (kiro-crew first)",
      "  Next deliver       Oct 10, 6:30 AM, for the link on the wrist at 07:00",
      "  Night jobs         build, deliver and Kiro Crew gateway installed",
      "  Night clock        build and deliver check the time every minute, in America/Boise",
      "  Kiro Crew gateway  answers",
      "  Build sandbox      overnight (the Kiro Crew gateway runs inside Overnight's own sandbox, proved by a probe each night)",
      "  Power              battery: Overnight keeps the Mac awake while the lid is open. With the lid closed nothing runs until it is opened",
      "  Tonight            nothing to build so far: no approved idea is waiting",
      "  Full check         npx overnight preflight",
    ]);
    // Whether each job is running is asked of its own lock in this data folder, and the jobs' folder of this one.
    expect(jobLockHeld.mock.calls.map(([file]) => file)).toEqual([path.join(h.context.paths.root, "build.lock"), path.join(h.context.paths.root, "deliver.lock")]);
    // On battery with no listener running on this data folder, nothing of Overnight's holds the Mac awake, and the row says so.
    const stopped = harness({ powerSource, ...night, listenerState: () => ({ running: false, jobInstalled: true }) });
    expect(await stopped.run("status")).toBe(0);
    expect(stopped.out.lines.find((line) => line.startsWith("  Power"))).toBe(
      "  Power              battery: the listener is not running, so nothing of Overnight's keeps the Mac awake between runs, and it may go to sleep. With the lid closed nothing runs until it is opened",
    );
    expect(jobsBelongHere).toHaveBeenCalledWith(h.context.paths);

    // What scripts/install-agents.sh reads.
    expect(await h.run("status", "--json")).toBe(0);
    expect(JSON.parse(h.out.lines.at(-1) ?? "")).toMatchObject({
      buildTime: "01:00",
      deliverTime: "07:00",
      timeZone: "America/Boise",
      buildSandbox: "overnight",
      nightJobs: { build: true, deliver: true, crew: true },
      gatewayAnswers: true,
      power: "battery",
      jobsBelongHere: true,
      nightClock: { tickSeconds: 60, build: { checkedAt: at(-60), trigger: "timer", fresh: true }, deliver: { checkedAt: at(-60), trigger: "timer", fresh: true } },
    });
  });

  it("takes the build sandbox mode from the settings: Overnight's own sandbox unless BUILD_SANDBOX says crew", async () => {
    for (const [settings, mode] of [[{}, "overnight"], [{ BUILD_SANDBOX: "" }, "overnight"], [{ BUILD_SANDBOX: "overnight" }, "overnight"], [{ BUILD_SANDBOX: "crew" }, "crew"]] as const) {
      const h = harness({ gatewayAnswers: async () => false }, settings);
      expect(await h.run("status", "--json")).toBe(0);
      expect(JSON.parse(h.out.text())).toMatchObject({ buildSandbox: mode });
    }
  });

  it("stops every command on a sandbox mode it does not know, like any other bad setting", async () => {
    // The settings are read once, when the data is opened. Nothing reads BUILD_SANDBOX anywhere else.
    const takeJobLock = vi.fn<CliIo["takeJobLock"]>();
    const open = () => {
      const config = parseConfig({ OVERNIGHT_DATA_DIR: "/tmp/overnight-cli-test", BUILD_SANDBOX: "strict" });
      throw new Error(`the settings were accepted: ${config.buildSandbox}`);
    };
    const h = harness({ open, takeJobLock });
    for (const argv of [["build"], ["build-now", "idea_a"], ["deliver"], ["status"], ["preflight"]]) {
      expect(await h.run(...argv)).toBe(2);
    }
    expect(h.err.lines.slice(0, 2)).toEqual([expect.stringContaining("Bad setting. BUILD_SANDBOX:"), "Settings live in the .env file at the top of the repo (see .env.example)."]);
    expect(h.err.lines).toHaveLength(10);
    // Nothing was locked, loaded or built.
    expect(takeJobLock).not.toHaveBeenCalled();
    expect(h.out.lines).toEqual([]);
  });

  it("does not read BUILD_SANDBOX from the environment of a command that is already running", async () => {
    // The settings object is the only source: changing the variable after the data was opened changes nothing.
    vi.stubEnv("BUILD_SANDBOX", "crew");
    try {
      const fakes = fakeBuild();
      const h = harness({ buildFactories: fakes.load, takeJobLock: fakeLocks().takeLock, gatewayAnswers: async () => false }, { BUILD_SANDBOX: "overnight" });
      expect(await h.run("build")).toBe(0);
      expect(fakes.nightDeps[0]?.backends.primary).toMatchObject({ name: "kiro-crew", sandboxMode: "overnight" });
      expect(await h.run("status", "--json")).toBe(0);
      expect(JSON.parse(h.out.lines.at(-1) ?? "")).toMatchObject({ buildSandbox: "overnight" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("has no code of its own that reads the BUILD_SANDBOX variable: the settings are the only reader", () => {
    const sourceDir = path.join(repoRoot(), "packages", "cli", "src");
    const files = readdirSync(sourceDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(15);
    expect(files).not.toContain("build-sandbox.ts");
    for (const name of files) {
      const text = readFileSync(path.join(sourceDir, name), "utf8");
      // In words for people it may be named. As a property of an environment it may not.
      expect(text, name).not.toMatch(/[.[]\s*["']?BUILD_SANDBOX\b(?!=)/);
    }
  });

  it("wires preflight: the store, the settings and the checks made for this data folder, and exits 0 only when all pass", async () => {
    const probes = (overrides: Partial<PreflightProbes> = {}): PreflightProbes => ({
      beeLoginState: async () => "logged-in",
      kiroSignedIn: async () => true,
      gatewayAnswers: async () => true,
      crewSettingsProblem: async () => null,
      installedSkill: async () => "same",
      sandboxProbe: async () => ({ ok: true }),
      buildRunning: () => false,
      ghLoggedIn: async () => true,
      pagesRepoReachable: async () => true,
      headlessShellPresent: async () => true,
      nightJobs: () => ({ build: true, deliver: true, crew: true }),
      crewJobSandbox: () => "overnight",
      nightJobTriggers: () => ({ build: "timer", deliver: "timer" }),
      nightJobRunning: () => false,
      gatewayProfileCopy: () => "same",
      ...overrides,
    });
    /** Both night jobs asked the clock a minute before the harness's noon. Only that clock makes these "moments ago". */
    const awake = (h: ReturnType<typeof harness>) => {
      for (const job of ["build", "deliver"] as const) noteChecked(h.context.store, job, new Date(at(-60)));
      return h;
    };
    const preflightProbes = vi.fn<CliIo["preflightProbes"]>(async () => probes());
    const ready = awake(harness({ preflightProbes }));
    expect(await ready.run("preflight")).toBe(0);
    expect(preflightProbes).toHaveBeenCalledWith({ config: ready.context.config, paths: ready.context.paths });
    expect(ready.out.lines[0]).toBe(PREFLIGHT_TITLE);
    expect(ready.out.lines.at(-1)).toBe(PREFLIGHT_READY);
    expect(ready.close).toHaveBeenCalledTimes(1);

    // Paused, by the stored switch: the first line is a cross and the exit code is 1.
    const paused = awake(harness({ preflightProbes: async () => probes() }));
    expect(await paused.run("pause")).toBe(0);
    expect(await paused.run("preflight")).toBe(1);
    expect(paused.out.lines[2]).toBe("  \u2717 Overnight is paused, so nothing is asked or built. Fix: npx overnight resume");

    // The clock it goes by is the command line's: by the real one, those heartbeats are long ago.
    const realClock = awake(harness({ preflightProbes: async () => probes(), now: () => new Date() }));
    expect(await realClock.run("preflight")).toBe(1);
    expect(realClock.out.text()).toContain("have not checked the time since");

    // It takes no switches and no words.
    expect(await harness().run("preflight", "--json")).toBe(2);
    expect(await harness().run("preflight", "now")).toBe(2);
  });

  it("hands build, deliver and build-now the watch for stop signals, and exits with the signal's code", async () => {
    const stop = fakeStopSignals();
    const build = fakeBuild({ night: async (deps) => (await aborted(deps.signal), { built: [], failed: [], skipped: "stopped" }) });
    const h = harness({ buildFactories: build.load, takeJobLock: fakeLocks().takeLock, watchStopSignals: stop.watch });
    const running = h.run("build");
    await expect.poll(() => build.nightDeps.length).toBe(1);
    stop.send("SIGTERM");
    expect(await running).toBe(143);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(stop.handlers()).toBe(0);

    const deliver = fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: [], failed: [], notified: [] }) });
    const morning = harness({ deliverFactories: deliver.load, takeJobLock: fakeLocks().takeLock, watchStopSignals: stop.watch });
    const delivering = morning.run("deliver");
    await expect.poll(() => deliver.runDeps.length).toBe(1);
    stop.send("SIGINT");
    expect(await delivering).toBe(130);

    const one = fakeBuild({ one: async (_ideaId, deps) => (await aborted(deps.signal), { ok: false, backend: "kiro-crew", ms: 1, reason: "the build was interrupted", couldNotStart: false }) });
    const now = harness({ buildFactories: one.load, takeJobLock: fakeLocks().takeLock, watchStopSignals: stop.watch });
    const idea = moveIdea(now.context.store, addIdea(now.context.store, SAMPLE_IDEAS.turns, at(-600)), ["asked", "approved"], at(-500));
    const building = now.run("build-now", idea.id);
    await expect.poll(() => one.oneCalls.length).toBe(1);
    stop.send("SIGHUP");
    expect(await building).toBe(129);
    expect(stop.handlers()).toBe(0);
  });

  it("wires build: the build log, the build lock, the builder and the settings", async () => {
    const fakes = fakeBuild({ night: () => ({ built: ["idea_a"], failed: [], skipped: "" }) });
    const locks = fakeLocks({ order: fakes.order });
    const jobLogger = vi.fn<CliIo["jobLogger"]>(() => silentLogger);
    const h = harness({ buildFactories: fakes.load, takeJobLock: locks.takeLock, jobLogger }, { BUILD_SANDBOX: "crew" });
    expect(await h.run("build")).toBe(0);
    expect(h.out.lines).toEqual(["Tonight's build: 1 built (idea_a), 0 failed."]);
    expect(jobLogger.mock.calls).toEqual([[h.context.paths, "build"]]);
    expect(locks.files).toEqual([path.join(h.context.paths.root, "build.lock")]);
    expect(fakes.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
    // BUILD_SANDBOX comes from the settings and is passed down to the Kiro Crew builder.
    expect(fakes.nightDeps[0]?.backends.primary).toMatchObject({ name: "kiro-crew", sandboxMode: "crew" });
    expect(h.close).toHaveBeenCalledTimes(1);
    // The night was held awake and watched for a sleep, and both were let go of.
    expect(h.awake.order).toEqual(["keep awake", "let sleep"]);
    expect(h.sleepWatch.started()).toBe(1);
    expect(h.sleepWatch.watching()).toBe(0);
  });

  it("plain build and plain deliver mean now: they run whatever the night clock's record says, and neither read nor write it", async () => {
    const build = fakeBuild();
    const deliver = fakeDeliver();
    const h = harness({ buildFactories: build.load, deliverFactories: deliver.load, takeJobLock: fakeLocks().takeLock });
    // Today's slot of each job is on record as run and closed. Run through the clock, nothing would start.
    const now = new Date(NOON);
    const closed = (job: ClockedJob) => closedRun(startedRun(noticedRun(currentSlot(job, now, h.context.config), now), now), "done", now);
    for (const job of ["build", "deliver"] as const) writeNightRun(h.context.store, job, closed(job), now);
    const setValue = vi.spyOn(h.context.store, "setValue");
    const getValue = vi.spyOn(h.context.store, "getValue");

    expect(await h.run("build")).toBe(0);
    expect(await h.run("deliver")).toBe(0);
    expect(build.nightDeps).toHaveLength(1);
    expect(deliver.runDeps).toHaveLength(1);
    expect(setValue).not.toHaveBeenCalled();
    expect(getValue.mock.calls.filter(([key]) => key.startsWith("night."))).toEqual([]);
    for (const job of ["build", "deliver"] as const) {
      expect(readNightRun(h.context.store, job)).toEqual(closed(job));
      expect(readCheckedAt(h.context.store, job)).toBeNull();
    }
  });

  it("builds nothing while paused, and exits 0: the builder is still called, and it is the one that says \"paused\"", async () => {
    const locks = fakeLocks();
    const fakes = fakeBuild({ night: (deps) => ({ built: [], failed: [], skipped: deps.store.isPaused(deps.config.pausedByDefault) ? "paused" : "" }) });
    const h = harness({ takeJobLock: locks.takeLock, buildFactories: fakes.load });
    expect(await h.run("pause")).toBe(0);
    expect(await h.run("build")).toBe(0);
    expect(h.out.lines).toEqual([PAUSED_LINE, BUILD_PAUSED_LINE]);
    expect(h.err.lines).toEqual([]);
    // Not skipped by the command line: a build cut off before the pause must still be recorded as failed.
    expect(fakes.nightDeps).toHaveLength(1);
  });

  it("wires deliver: the deliver log, the deliver lock, the Bee gateway and the deliver step", async () => {
    const fakes = fakeDeliver({ run: () => ({ delivered: ["idea_a"], failed: [], notified: [] }) });
    const locks = fakeLocks({ order: fakes.order });
    const jobLogger = vi.fn<CliIo["jobLogger"]>(() => silentLogger);
    const h = harness({ deliverFactories: fakes.load, takeJobLock: locks.takeLock, jobLogger });
    expect(await h.run("deliver")).toBe(0);
    expect(h.out.lines).toEqual(["This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure."]);
    expect(jobLogger.mock.calls).toEqual([[h.context.paths, "deliver"]]);
    expect(locks.files).toEqual([path.join(h.context.paths.root, "deliver.lock")]);
    expect(fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.awake.order).toEqual(["keep awake", "let sleep"]);
    expect(h.sleepWatch.started()).toBe(1);
    expect(h.sleepWatch.watching()).toBe(0);
  });

  it("exits 1 when a build or a deliver is already running", async () => {
    const h = harness({ takeJobLock: () => null });
    expect(await h.run("build")).toBe(1);
    expect(await h.run("deliver")).toBe(1);
    expect(h.out.lines).toEqual([]);
    expect(h.err.lines).toHaveLength(2);
    expect(h.err.lines[0]).toContain("another overnight build is already running");
    expect(h.err.lines[1]).toContain("another overnight deliver is already running");
  });

  it("wires build-now: one idea id, both steps, both locks, and logs kept off the screen", async () => {
    const order: string[] = [];
    const build = fakeBuild({ order });
    const deliver = fakeDeliver({ order, one: () => ({ ok: true, url: "https://example.invalid/apps/whose-turn-to-pay/" }) });
    const locks = fakeLocks({ order });
    const jobLogger = vi.fn<CliIo["jobLogger"]>(() => silentLogger);
    const h = harness({ buildFactories: build.load, deliverFactories: deliver.load, takeJobLock: locks.takeLock, jobLogger });
    const idea = moveIdea(h.context.store, addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600)), ["asked", "approved"], at(-500));

    expect(await h.run("build-now", idea.id)).toBe(0);
    expect(order).toEqual([
      "lock build.lock",
      "load builder",
      `buildOne ${idea.id}`,
      "release build.lock",
      "lock deliver.lock",
      "load deliver",
      "create bee",
      `deliverOne ${idea.id}`,
      "dispose bee",
      "release deliver.lock",
    ]);
    expect(jobLogger.mock.calls).toEqual([
      [h.context.paths, "build", { quiet: true }],
      [h.context.paths, "deliver", { quiet: true }],
    ]);
    expect(h.out.lines.at(-1)).toBe("Link: https://example.invalid/apps/whose-turn-to-pay/");
    expect(h.close).toHaveBeenCalledTimes(1);
    // One hold and one watch for the whole command.
    expect(h.awake.order).toEqual(["keep awake", "let sleep"]);
    expect(h.sleepWatch.started()).toBe(1);
    expect(h.sleepWatch.watching()).toBe(0);
  });

  it("refuses build-now while paused, before loading or locking anything", async () => {
    const h = harness();
    const idea = moveIdea(h.context.store, addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600)), ["asked", "approved"], at(-500));
    expect(await h.run("pause")).toBe(0);
    expect(await h.run("build-now", idea.id)).toBe(1);
    expect(h.err.lines).toEqual([BUILD_NOW_PAUSED]);
    expect(h.context.store.getIdea(idea.id)?.state).toBe("approved");
  });

  it("exits 2 for build-now without an id, or with more than one word after it", async () => {
    const open = vi.fn<() => Context>();
    const none = harness({ open });
    expect(await none.run("build-now")).toBe(2);
    expect(none.err.lines[0]).toBe('Which idea? Give its id: "overnight build-now <ideaId>". See the ids with: overnight ideas --all');
    expect(none.err.text()).toContain(USAGE);

    const two = harness({ open });
    expect(await two.run("build-now", "idea_a", "idea_b")).toBe(2);
    expect(two.err.lines[0]).toBe('"overnight build-now" does not understand: idea_b');

    // The night's other commands take no words and no switches.
    for (const argv of [["build", "idea_a"], ["build", "--json"], ["deliver", "--now"], ["build-now", "idea_a", "--force"]]) {
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(2);
      expect(h.err.text()).toContain("does not understand");
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("wires listen from the factories it is given", async () => {
    const started: string[] = [];
    const factories: ListenFactories = {
      createBee: () => ({}) as BeeGateway,
      createDetector: () => ({ detect: async () => ({ ok: false, reason: "fake", ms: 0, attempts: 0 }), ensureSetup: async () => {} }),
      createListener: (deps) => ({
        start: async () => {
          started.push(`handleSignals=${deps.options.handleSignals} keepAwake=${deps.options.keepAwake}`);
        },
      }),
    };
    const lock: string[] = [];
    const takeListenLock: CliIo["takeListenLock"] = (file) => {
      lock.push(`taken ${file}`);
      return () => void lock.push("released");
    };
    const h = harness({ listenFactories: async () => factories, takeListenLock });
    expect(await h.run("listen")).toBe(0);
    expect(started).toEqual(["handleSignals=true keepAwake=true"]);
    expect(lock).toEqual([`taken ${path.join(h.context.paths.root, "listen.lock")}`, "released"]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 without starting anything when another listener is already running", async () => {
    const createListener = vi.fn<ListenFactories["createListener"]>();
    const factories: ListenFactories = {
      createBee: () => ({}) as BeeGateway,
      createDetector: () => ({ detect: async () => ({ ok: false, reason: "fake", ms: 0, attempts: 0 }), ensureSetup: async () => {} }),
      createListener,
    };
    const logged: string[] = [];
    const logger = { ...silentLogger, error: (message: string) => void logged.push(message) };
    const h = harness({ listenFactories: async () => factories, takeListenLock: () => null, listenLogger: () => logger });
    expect(await h.run("listen")).toBe(1);
    expect(createListener).not.toHaveBeenCalled();
    expect(logged).toEqual([ALREADY_RUNNING]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 with a one-line reason when a command fails, and still closes the store", async () => {
    const h = harness({ listenFactories: () => Promise.reject(new Error("Cannot find package '@overnight/listener'\n    at somewhere")) });
    expect(await h.run("listen")).toBe(1);
    expect(h.err.lines).toEqual([`"overnight listen" failed. Cannot find package '@overnight/listener'`]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 2 and names the setting when a setting is bad", async () => {
    const h = harness({
      open: () => {
        throw new ConfigError("Bad setting. ASK_CUTOFF: must be a 24-hour time like 23:00");
      },
    });
    expect(await h.run("status")).toBe(2);
    expect(h.err.lines[0]).toBe("Bad setting. ASK_CUTOFF: must be a 24-hour time like 23:00");
    expect(h.out.lines).toEqual([]);
  });

  it("exits 1 when the data folder cannot be opened", async () => {
    const h = harness({
      open: () => {
        throw new Error("EACCES: permission denied, mkdir '/nope'");
      },
    });
    expect(await h.run("status")).toBe(1);
    expect(h.err.text()).toContain("could not open its data folder");
  });
});

describe("overnight build and deliver with --if-due and --from-now (command line)", () => {
  /** Boise, on the night of Oct 10: 1:00 am is 07:00Z and 6:30 am is 12:30Z. The harness's own clock reads noon on Oct 9. */
  const BUILD_TIME = "2026-10-10T07:00:00.000Z";
  const DELIVER_TIME = "2026-10-10T12:30:00.000Z";

  /** A command line on a made-up clock, with a job log kept in memory and made only when asked for. */
  function clocked(overrides: Partial<CliIo> = {}) {
    let clock = Date.parse(NOON);
    const logs = { build: collectingLogger("build"), deliver: collectingLogger("deliver") };
    const jobLogger = vi.fn<CliIo["jobLogger"]>((_paths, name) => logs[name].logger);
    const order: string[] = [];
    const locks = fakeLocks({ order });
    const online = { answer: true, asked: 0 };
    const waits: number[] = [];
    const h = harness({
      now: () => new Date(clock),
      jobLogger,
      takeJobLock: locks.takeLock,
      isOnline: async () => ((online.asked += 1), online.answer),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      ...overrides,
    });
    return { ...h, logs, jobLogger, order, locks, online, waits, at: (iso: string) => void (clock = Date.parse(iso)), later: (ms: number) => void (clock += ms) };
  }

  it("takes each switch on build and deliver only, and never both at once", async () => {
    const open = vi.fn<() => Context>();
    for (const command of ["build", "deliver"]) {
      const both = harness({ open });
      expect(await both.run(command, "--if-due", "--from-now")).toBe(2);
      expect(both.err.lines[0]).toBe("Use --if-due or --from-now, not both.");
      expect(both.err.text()).toContain(USAGE);
    }
    // No other command has a clock to ask or to start.
    for (const argv of [["status", "--if-due"], ["status", "--from-now"], ["build-now", "idea_a", "--if-due"], ["listen", "--if-due"], ["preflight", "--from-now"], ["queue", "--approved", "--json", "--if-due"], ["rehearse", "run", "idea_a", "--if-due"]]) {
      const h = harness({ open });
      expect(await h.run(...argv), argv.join(" ")).toBe(2);
      expect(h.err.lines[0], argv.join(" ")).toContain("does not understand: --");
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("--from-now starts that job's clock, prints when its first run is, and loads, logs and holds nothing", async () => {
    const t = clocked();
    expect(await t.run("build", "--from-now")).toBe(0);
    expect(await t.run("deliver", "--from-now")).toBe(0);
    expect(t.out.lines).toEqual(["The build clock starts from now: the next build is Oct 10, 1:00 AM (America/Boise).", "The deliver clock starts from now: the next deliver is Oct 10, 6:30 AM (America/Boise)."]);
    expect(t.err.lines).toEqual([]);
    expect(readNightRun(t.context.store, "build")).toMatchObject({ day: "2026-10-09", closedAs: "first-check", closedAt: NOON });
    expect(readNightRun(t.context.store, "deliver")).toMatchObject({ day: "2026-10-09", closedAs: "first-check", closedAt: NOON });
    // Each under its own job lock, let go again. No builder, no log file, no hold, no look at the internet.
    expect(t.order).toEqual(["lock build.lock", "release build.lock", "lock deliver.lock", "release deliver.lock"]);
    expect(t.jobLogger).not.toHaveBeenCalled();
    expect(t.awake.order).toEqual([]);
    expect(t.online.asked).toBe(0);
    expect(t.close).toHaveBeenCalledTimes(2);
  });

  it("--from-now refuses on the error stream, with exit code 1, while that job is running", async () => {
    // The installer sends standard output nowhere and shows the error stream: the reason must be there.
    const t = clocked({ takeJobLock: () => null });
    expect(await t.run("build", "--from-now")).toBe(1);
    expect(await t.run("deliver", "--from-now")).toBe(1);
    expect(t.out.lines).toEqual([]);
    expect(t.err.lines).toEqual([
      "A build is running right now on this data folder. Try again when it has finished. Nothing was changed.",
      "A deliver is running right now on this data folder. Try again when it has finished. Nothing was changed.",
    ]);
    expect(readNightRun(t.context.store, "build")).toBeNull();
  });

  it("--if-due with nothing due: one heartbeat, exit 0, and not a line, a lock or a log file", async () => {
    const t = clocked();
    await t.run("build", "--from-now");
    await t.run("deliver", "--from-now");
    t.out.lines.length = 0;
    t.order.length = 0;
    for (let minute = 1; minute <= 5; minute += 1) {
      t.later(60_000);
      expect(await t.run("build", "--if-due")).toBe(0);
      expect(await t.run("deliver", "--if-due")).toBe(0);
    }
    expect(t.out.lines).toEqual([]);
    expect(t.err.lines).toEqual([]);
    expect(t.order).toEqual([]);
    expect(t.jobLogger).not.toHaveBeenCalled();
    expect(t.online.asked).toBe(0);
    expect(t.waits).toEqual([]);
    // What scripts/install-agents.sh waits for after it starts a job: the time of its last check.
    expect(readCheckedAt(t.context.store, "build")).toBe(at(300));
    expect(await t.run("status", "--json")).toBe(0);
    expect(JSON.parse(t.out.lines.at(-1) ?? "")).toMatchObject({ nightClock: { tickSeconds: 60, build: { checkedAt: at(300), state: "done" }, deliver: { checkedAt: at(300), state: "done" } } });
  });

  it("build --if-due at the build's time: asks the internet, runs the night once under the one lock, holds the Mac awake, and writes the start and the end", async () => {
    const fakes = fakeBuild({ night: () => ({ built: ["idea_a"], failed: [], skipped: "" }) });
    const t = clocked({ buildFactories: fakes.load });
    fakes.order = t.order;
    await t.run("build", "--from-now");
    t.out.lines.length = 0;
    t.order.length = 0;
    t.at("2026-10-10T06:59:30.000Z");
    expect(await t.run("build", "--if-due")).toBe(0);
    expect(fakes.nightDeps).toEqual([]);

    t.at("2026-10-10T07:00:30.000Z");
    expect(await t.run("build", "--if-due")).toBe(0);
    expect(t.online.asked).toBe(1);
    expect(t.waits).toEqual([]);
    // The lock is taken once, by the check, and the build runs under that same one.
    expect(t.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
    expect(t.out.lines).toEqual(["Tonight's build: 1 built (idea_a), 0 failed."]);
    expect(t.awake.order).toEqual(["keep awake", "let sleep"]);
    // The job's log was made once, when there was something to log, and holds the clock's line and the build's own.
    expect(t.jobLogger.mock.calls).toEqual([[t.context.paths, "build"]]);
    expect(t.logs.build.lines.map((line) => line.message)).toEqual(["night clock: starting", "overnight build starting", "overnight build finished"]);
    expect(t.logs.build.lines[0]).toMatchObject({ level: "info", job: "build", slotDay: "2026-10-10", lateMinutes: 0 });
    expect(fakes.nightDeps[0]?.logger).toBe(t.logs.build.logger);
    const done = { day: "2026-10-10", slotAt: BUILD_TIME, noticedAt: "2026-10-10T07:00:30.000Z", startedAt: "2026-10-10T07:00:30.000Z", closedAt: "2026-10-10T07:00:30.000Z", closedAs: "done", waiting: null };
    expect(readNightRun(t.context.store, "build")).toEqual(done);
    expect(readLastNightRun(t.context.store, "build")).toEqual(done);

    // The minutes after it: nothing more.
    t.later(60_000);
    expect(await t.run("build", "--if-due")).toBe(0);
    expect(fakes.nightDeps).toHaveLength(1);
    expect(t.out.lines).toHaveLength(1);
  });

  it("build --if-due after a sleep waits a minute in place first, and without the internet waits for it", async () => {
    const fakes = fakeBuild();
    const t = clocked({ buildFactories: fakes.load });
    await t.run("build", "--from-now");
    // Awake again at 3:00 am, on a network with no way out.
    t.online.answer = false;
    t.at("2026-10-10T09:00:00.000Z");
    expect(await t.run("build", "--if-due")).toBe(0);
    expect(t.waits).toEqual([60_000]);
    expect(fakes.loads).toBe(0);
    expect(readNightRun(t.context.store, "build")).toMatchObject({ day: "2026-10-10", waiting: "offline", startedAt: null });
    expect(t.logs.build.lines.map((line) => line.message)).toEqual(["night clock: waiting for the internet"]);

    t.online.answer = true;
    t.later(60_000);
    expect(await t.run("build", "--if-due")).toBe(0);
    expect(fakes.nightDeps).toHaveLength(1);
    expect(t.logs.build.lines[1]).toMatchObject({ level: "warn", message: "night clock: starting", lateMinutes: 122 });
    expect(readNightRun(t.context.store, "build")).toMatchObject({ closedAs: "done", waiting: null });
  });

  it("build --if-due marks the night cut short when it is stopped, and exits with the signal's code", async () => {
    const stop = fakeStopSignals();
    const fakes = fakeBuild({ night: async (deps) => (await aborted(deps.signal), { built: [], failed: [], skipped: "stopped" }) });
    const t = clocked({ buildFactories: fakes.load, watchStopSignals: stop.watch });
    await t.run("build", "--from-now");
    t.at("2026-10-10T06:59:30.000Z");
    await t.run("build", "--if-due");
    t.at("2026-10-10T07:00:30.000Z");
    const running = t.run("build", "--if-due");
    await expect.poll(() => fakes.nightDeps.length).toBe(1);
    // While it runs, the record says so: started, not closed.
    expect(readNightRun(t.context.store, "build")).toMatchObject({ startedAt: "2026-10-10T07:00:30.000Z", closedAt: null });
    stop.send("SIGTERM");
    expect(await running).toBe(143);
    expect(readNightRun(t.context.store, "build")).toMatchObject({ closedAs: "cut-short" });
    expect(t.order.at(-1)).toBe("release build.lock");
  });

  it("deliver --if-due waits for a build that holds the build lock in this data folder, then runs the morning with the marks and the hold", async () => {
    const fakes = fakeDeliver({ run: () => ({ delivered: ["idea_a"], failed: [], notified: [] }) });
    const buildRunning = { now: true };
    const jobLockHeld = vi.fn<CliIo["jobLockHeld"]>(() => buildRunning.now);
    const t = clocked({ deliverFactories: fakes.load, jobLockHeld });
    fakes.order = t.order;
    await t.run("deliver", "--from-now");
    t.out.lines.length = 0;
    t.order.length = 0;
    t.at("2026-10-10T12:29:30.000Z");
    expect(await t.run("deliver", "--if-due")).toBe(0);
    expect(jobLockHeld).not.toHaveBeenCalled();

    t.at("2026-10-10T12:30:30.000Z");
    expect(await t.run("deliver", "--if-due")).toBe(0);
    expect(jobLockHeld.mock.calls.every(([file]) => file === path.join(t.context.paths.root, "build.lock"))).toBe(true);
    expect(fakes.loads).toBe(0);
    expect(readNightRun(t.context.store, "deliver")).toMatchObject({ day: "2026-10-10", slotAt: DELIVER_TIME, waiting: "build-running" });
    expect(t.logs.deliver.lines.map((line) => line.message)).toEqual(["night clock: waiting for the build to finish"]);

    buildRunning.now = false;
    t.later(60_000);
    t.order.length = 0;
    expect(await t.run("deliver", "--if-due")).toBe(0);
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
    expect(t.out.lines).toEqual(["This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure."]);
    expect(t.awake.order).toEqual(["keep awake", "let sleep"]);
    // Once for the check that had a wait to log, once for the one that ran. Never for the checks that found nothing due.
    expect(t.jobLogger.mock.calls).toEqual([
      [t.context.paths, "deliver"],
      [t.context.paths, "deliver"],
    ]);
    expect(readNightRun(t.context.store, "deliver")).toMatchObject({ startedAt: "2026-10-10T12:31:30.000Z", closedAs: "done", waiting: null });
  });

  it("--if-due leaves the slot due when the work cannot begin, and says nothing every minute when another process has the lock", async () => {
    // The builder will not load: said once per check, and tried again by the next one.
    const t = clocked({ buildFactories: () => Promise.reject(new Error("Cannot find package '@overnight/builder'")) });
    await t.run("build", "--from-now");
    t.at("2026-10-10T07:00:30.000Z");
    expect(await t.run("build", "--if-due")).toBe(1);
    expect(t.err.lines).toEqual([`"overnight build" could not finish. Cannot find package '@overnight/builder'`]);
    expect(readNightRun(t.context.store, "build")).toMatchObject({ day: "2026-10-10", startedAt: null, closedAt: null });

    // A build started by hand holds the lock: the check ends quietly, with exit code 0.
    const busy = clocked({ takeJobLock: fakeLocks({ held: ["build.lock"] }).takeLock });
    writeNightRun(busy.context.store, "build", closedRun(noticedRun(currentSlot("build", new Date(NOON), busy.context.config), new Date(NOON)), "first-check", new Date(NOON)), new Date(NOON));
    busy.at("2026-10-10T07:00:30.000Z");
    expect(await busy.run("build", "--if-due")).toBe(0);
    expect(busy.err.lines).toEqual([]);
    expect(busy.out.lines).toEqual([]);
    expect(busy.jobLogger).not.toHaveBeenCalled();
  });
});

describe("opening the data", () => {
  let scratch: string | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("finds the repo root from its own location", () => {
    expect(existsSync(path.join(repoRoot(), "SPEC.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot(), "packages", "cli", "src", "main.ts"))).toBe(true);
  });

  it("creates private data folders and the database where the settings say", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const dataDir = path.join(scratch, "data folder");
    vi.stubEnv("OVERNIGHT_DATA_DIR", dataDir);
    // An empty folder stands in for the repo, so no real .env is read.
    const context = openContext(scratch);
    try {
      expect(context.config.dataDir).toBe(dataDir);
      expect(context.paths.database).toBe(path.join(dataDir, "overnight.db"));
      expect(existsSync(context.paths.database)).toBe(true);
      expect(statSync(context.paths.logs).mode & 0o777).toBe(0o700);
      expect(context.store.countUtterances()).toBe(0);
    } finally {
      context.store.close();
    }
  });

  it("uses the real lock and the real look at the listener unless a test replaces them", () => {
    expect(processIo.takeListenLock).toBe(takeListenLock);
    expect(processIo.listenerState).toBe(readListenerState);
    expect(processIo.takeJobLock).toBe(takeLock);
    expect(processIo.watchStopSignals).toBe(watchStopSignals);
    expect(processIo.watchLastResort).toBe(watchLastResort);
    expect(processIo.watchForSleep).toBe(watchForSleep);
    expect(processIo.jobLockHeld).toBe(lockHeld);
    // A rehearsal's deliver step is @overnight/deliver alone, never the factories that make the Bee gateway.
    expect(processIo.deliverSteps).toBe(realDeliverSteps);
    // Nothing on the command line reads the environment for a setting any more.
    expect(processIo).not.toHaveProperty("env");
  });

  it("makes preflight's real checks from the other packages' own parts, without asking anything yet", async () => {
    // Only built here, never run: no Bee, Kiro, Kiro Crew or GitHub call is made by this test.
    const context = testContext();
    const probes = await processIo.preflightProbes({ config: context.config, paths: context.paths });
    for (const name of ["beeLoginState", "kiroSignedIn", "gatewayAnswers", "crewSettingsProblem", "installedSkill", "sandboxProbe", "buildRunning", "ghLoggedIn", "pagesRepoReachable", "headlessShellPresent", "nightJobs", "crewJobSandbox", "nightJobTriggers", "nightJobRunning", "gatewayProfileCopy"] as const) {
      expect(typeof probes[name], name).toBe("function");
    }
    context.store.close();
  });

  it("wires the sandbox line to the builder's own stand-alone probe, with this data folder's settings, paths and build log", async () => {
    // The builder package is replaced for this one test: nothing of Kiro Crew is asked or started.
    const seen: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock("@overnight/builder", () => ({
      defaultCrewHome: () => "/made-up/crew-home",
      crewSettingsProblem: () => null,
      installedSkillFile: () => "/made-up/SKILL.md",
      BUILD_SKILL_FILE: "/made-up/build-skill.md",
      CREW_GATEWAY_SANDBOX_PROFILE: "/made-up/crew-gateway.sb",
      runStandaloneSandboxProbe: async (deps: Record<string, unknown> & { logger: { info: (message: string) => void } }) => {
        seen.push(deps);
        deps.logger.info("a made-up probe line");
        return { ok: false, reason: "the build sandbox check failed: made up for the test" };
      },
    }));
    try {
      const wiring = await import("../src/wiring.ts");
      scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
      const config = parseConfig({ OVERNIGHT_DATA_DIR: path.join(scratch, "data folder") });
      const paths = dataPaths(config.dataDir);
      const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const probes = await wiring.realPreflightProbes({ config, paths });
      const signal = new AbortController().signal;
      let answer;
      try {
        answer = await probes.sandboxProbe(signal);
        // The probe's own lines never reach the screen: preflight prints one line of its own about it.
        expect(printed).not.toHaveBeenCalled();
      } finally {
        printed.mockRestore();
      }
      expect(answer).toEqual({ ok: false, reason: "the build sandbox check failed: made up for the test" });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ config, paths, signal });
      const logged = readFileSync(path.join(paths.logs, "build.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logged).toMatchObject([{ name: "preflight", message: "a made-up probe line" }]);
      // No build is running on a folder nobody has used: there is no build lock at all.
      expect(probes.buildRunning()).toBe(false);
      expect(probes.nightJobRunning("build")).toBe(false);
      expect(probes.nightJobRunning("deliver")).toBe(false);
    } finally {
      vi.doUnmock("@overnight/builder");
      vi.resetModules();
    }
  });

  it("writes the night's logs to logs/build.log and logs/deliver.log, and keeps a quiet one off the screen", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const paths = dataPaths(path.join(scratch, "data folder"));
    const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      processIo.jobLogger(paths, "build").info("a made-up build line", { built: 1 });
      const before = printed.mock.calls.length;
      processIo.jobLogger(paths, "deliver", { quiet: true }).info("a made-up deliver line", { delivered: 1 });
      // Quiet means nothing on the screen, terminal or not.
      expect(printed.mock.calls.length).toBe(before);
    } finally {
      printed.mockRestore();
    }
    const read = (name: string) => readFileSync(path.join(paths.logs, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(read("build.log")).toMatchObject([{ level: "info", name: "build", message: "a made-up build line", built: 1 }]);
    expect(read("deliver.log")).toMatchObject([{ level: "info", name: "deliver", message: "a made-up deliver line", delivered: 1 }]);
    expect(statSync(path.join(paths.logs, "build.log")).mode & 0o777).toBe(0o600);
  });

  it("writes the listener's log to logs/listen.log in the data folder", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const paths = dataPaths(path.join(scratch, "data folder"));
    // Whether the line is also shown on screen is the logger's own business (only when there is
    // a terminal). Either way, keep it out of the test output.
    const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      processIo.listenLogger(paths).info("a made-up log line", { count: 1 });
    } finally {
      printed.mockRestore();
    }
    const lines = readFileSync(path.join(paths.logs, "listen.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", name: "listener", message: "a made-up log line", count: 1 });
  });

  it("turns a bad setting into exit code 2 before anything is created", async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const dataDir = path.join(scratch, "data");
    vi.stubEnv("OVERNIGHT_DATA_DIR", dataDir);
    vi.stubEnv("MAX_ASKS_PER_DAY", "lots");
    const root = scratch;
    const err = capture();
    expect(await runCli(["status"], { write: () => {}, writeError: err.write, open: () => openContext(root) })).toBe(2);
    expect(err.lines[0]).toContain("MAX_ASKS_PER_DAY");
    expect(existsSync(dataDir)).toBe(false);
  });
});
