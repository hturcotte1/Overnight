// All text in this file is made up for the tests. None of it is Bee data, and no builder is run.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_INTERRUPTED_REASON } from "@overnight/core";
import { runBuildNight, SKIPPED_PAUSED } from "@overnight/builder";
import { build, BUILD_ALREADY_RUNNING, BUILD_PAUSED_LINE, BUILD_SKIPPED_PAUSED, buildNightLimitMs, buildNightLines, buildSummary, chooseBackends, formatDuration } from "../src/commands/build.ts";
import type { BuildDeps } from "../src/commands/build.ts";
import { DeadlinePassed, withDeadline } from "../src/deadline.ts";
import { LAST_RESORT_LINE } from "../src/last-resort.ts";
import { STOP_EXIT_CODES, STOP_OVERDUE, STOP_SIGNAL_NAMES, watchStopSignals } from "../src/stop-signals.ts";
import { addIdea, at, capture, moveIdea, SAMPLE_IDEAS, testContext } from "./helpers.ts";
import { aborted, collectingLogger, fakeBuild, fakeLastResort, fakeLocks, fakeStopSignals, never } from "./night-fakes.ts";
import type { BuildFakes, FakeBackend } from "./night-fakes.ts";

function setUp(options: { env?: Record<string, string>; fakes?: BuildFakes; locks?: ReturnType<typeof fakeLocks>; limitMs?: number; stopWaitMs?: number } = {}) {
  const context = testContext(options.env);
  const out = capture();
  const err = capture();
  const log = collectingLogger("build");
  const order: string[] = [];
  const fakes = options.fakes ?? fakeBuild({ order });
  const locks = options.locks ?? fakeLocks({ order: fakes.order });
  // Made-up stop signals: no test listens to, or sends, a real one.
  const stop = fakeStopSignals({ waitMs: options.stopWaitMs });
  // The same for errors nobody caught: made up, and "ending the process" only notes the exit code.
  const lastResort = fakeLastResort();
  const deps: BuildDeps<FakeBackend> = {
    ...context,
    logger: log.logger,
    loadFactories: fakes.load,
    takeLock: locks.takeLock,
    write: out.write,
    writeError: err.write,
    watchStopSignals: stop.watch,
    watchLastResort: lastResort.watch,
    limitMs: options.limitMs,
  };
  return { context, out, err, log, fakes, locks, stop, lastResort, deps, run: () => build(deps) };
}

/** A fake builder that keeps the builder's own promise about a pause: it starts nothing and says "paused". */
const pausedAware = (found: string[] = []) =>
  fakeBuild({ night: (deps) => (deps.store.isPaused(deps.config.pausedByDefault) ? { built: [], failed: found, skipped: SKIPPED_PAUSED } : { built: [], failed: [], skipped: "" }) });

describe("overnight build", () => {
  it("always hands over to the builder, also while paused: it is the builder that starts nothing then, and says so", async () => {
    const t = setUp({ env: { PAUSED: "true" }, fakes: pausedAware() });
    const idea = addIdea(t.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(t.context.store, idea, ["asked", "approved"], at(-500));

    expect(await t.run()).toBe(0);
    // The paused line, because the builder's answer says it was skipped for that reason.
    expect(t.out.lines).toEqual([BUILD_PAUSED_LINE]);
    expect(t.err.lines).toEqual([]);
    expect(t.fakes.loads).toBe(1);
    expect(t.fakes.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
    expect(t.context.store.getIdea(idea.id)?.state).toBe("approved");
    expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight build finished", built: 0, failed: 0, skipped: "paused" });
  });

  it("follows the stored pause switch, not only the setting", async () => {
    const t = setUp({ fakes: pausedAware() });
    t.context.store.setPaused(true, at(0));
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual([BUILD_PAUSED_LINE]);

    t.context.store.setPaused(false, at(1));
    expect(await t.run()).toBe(0);
    expect(t.out.lines.at(-1)).toBe("Tonight's build: 0 built, 0 failed.");
    expect(t.fakes.loads).toBe(2);
  });

  it("knows the builder's word for a pause, and prints the paused line only for it", async () => {
    expect(BUILD_SKIPPED_PAUSED).toBe(SKIPPED_PAUSED);
    // Not skipped for that reason: the ordinary summary, whatever the pause switch says by now.
    const t = setUp({ env: { PAUSED: "true" }, fakes: fakeBuild({ night: () => ({ built: [], failed: [], skipped: "nothing approved" }) }) });
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual(["Tonight's build: 0 built, 0 failed; nothing approved."]);
  });

  it("while paused, a build that was cut off earlier is still recorded as failed (with the real builder's night)", async () => {
    // The real runBuildNight from @overnight/builder, with stand-in backends that must never be asked to build.
    const asked: string[] = [];
    const backend = (name: "kiro-crew" | "kiro-cli") => ({ name, build: async () => (asked.push(name), { ok: false as const, backend: name, ms: 0, reason: "made up", couldNotStart: true }) });
    const context = testContext({ PAUSED: "true" });
    const out = capture();
    const log = collectingLogger("build");
    const store = context.store;
    const idea = addIdea(store, SAMPLE_IDEAS.turns, new Date(Date.now() - 5 * 3_600_000).toISOString());
    moveIdea(store, idea, ["asked", "approved"], new Date(Date.now() - 4 * 3_600_000).toISOString());
    // A build that began three hours ago and never ended: cut off (the limit is 45 minutes, and 15 more).
    const began = new Date(Date.now() - 3 * 3_600_000).toISOString();
    store.transitionIdea(idea.id, "building", { buildStartedAt: began, buildBackend: "kiro-crew" }, began);

    const code = await build({
      ...context,
      logger: log.logger,
      loadFactories: async () => ({
        createKiroCrewBackend: () => backend("kiro-crew"),
        createKiroCliBackend: () => backend("kiro-cli"),
        runBuildNight: (deps) => runBuildNight({ ...deps, backends: { primary: backend("kiro-crew"), fallback: backend("kiro-cli") } }),
        buildOne: () => {
          throw new Error("not used in this test");
        },
      }),
      takeLock: fakeLocks().takeLock,
      write: out.write,
      writeError: () => {},
      watchStopSignals: fakeStopSignals().watch,
      watchLastResort: fakeLastResort().watch,
    });

    expect(code).toBe(0);
    expect(asked).toEqual([]);
    // Before this was fixed, the command returned before calling the builder, and the idea stayed "building" for as long as the pause lasted.
    expect(store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: BUILD_INTERRUPTED_REASON });
    expect(out.lines).toEqual([BUILD_PAUSED_LINE, `1 build cut off in an earlier run is now recorded as failed (${idea.id}).`]);
  });

  it("takes its own lock in the data folder, runs the night, and lets go", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.locks.files).toEqual([path.join(t.context.paths.root, "build.lock")]);
    expect(t.fakes.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
    const handed = t.fakes.nightDeps[0];
    expect(handed?.store).toBe(t.context.store);
    expect(handed?.config).toBe(t.context.config);
    expect(handed?.paths).toBe(t.context.paths);
    expect(handed?.logger).toBe(t.log.logger);
  });

  it("puts the builder that BUILD_BACKEND names first, and the other one second", async () => {
    // The default: Kiro Crew first.
    const crewFirst = setUp();
    await crewFirst.run();
    expect(crewFirst.context.config.buildBackend).toBe("kiro-crew");
    expect(crewFirst.fakes.nightDeps[0]?.backends.primary.name).toBe("kiro-crew");
    expect(crewFirst.fakes.nightDeps[0]?.backends.fallback.name).toBe("kiro-cli");

    const cliFirst = setUp({ env: { BUILD_BACKEND: "kiro-cli" } });
    await cliFirst.run();
    expect(cliFirst.fakes.nightDeps[0]?.backends.primary.name).toBe("kiro-cli");
    expect(cliFirst.fakes.nightDeps[0]?.backends.fallback.name).toBe("kiro-crew");

    const started = cliFirst.log.lines.find((line) => line.message === "overnight build starting");
    // Nothing set: the Kiro Crew gateway is expected inside Overnight's own sandbox (SPEC §6).
    expect(started).toMatchObject({ primary: "kiro-cli", fallback: "kiro-crew", sandboxMode: "overnight" });
  });

  it("hands the sandbox mode from the settings to the Kiro Crew builder, and to that builder only", async () => {
    for (const sandboxMode of ["overnight", "crew"] as const) {
      const t = setUp({ env: { BUILD_SANDBOX: sandboxMode } });
      expect(t.context.config.buildSandbox).toBe(sandboxMode);
      await t.run();
      const { primary, fallback } = t.fakes.nightDeps[0]?.backends ?? {};
      expect(primary).toMatchObject({ name: "kiro-crew", sandboxMode });
      expect(fallback?.name).toBe("kiro-cli");
      expect(fallback?.sandboxMode).toBeUndefined();
      // Both builders log to the build log, and the log says which fence was meant to be up.
      expect(primary?.logger).toBe(t.log.logger);
      expect(fallback?.logger).toBe(t.log.logger);
      expect(t.log.lines.find((line) => line.message === "overnight build starting")).toMatchObject({ sandboxMode });
    }
  });

  it("prints one summary line, with ids and never titles", async () => {
    const fakes = fakeBuild({ night: () => ({ built: ["idea_20261009_aaaa1111"], failed: [], skipped: "" }) });
    const t = setUp({ fakes });
    const idea = addIdea(t.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(t.context.store, idea, ["asked", "approved"], at(-500));
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual(["Tonight's build: 1 built (idea_20261009_aaaa1111), 0 failed."]);
    expect(t.err.lines).toEqual([]);
    expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight build finished", built: 1, failed: 0 });
    expect(t.out.text() + t.log.text()).not.toContain(SAMPLE_IDEAS.turns.title);
  });

  it("exits 0 even when a build failed: the failure is on the idea, not in the exit code", async () => {
    const fakes = fakeBuild({ night: () => ({ built: ["idea_a"], failed: ["idea_b", "idea_c"], skipped: "" }) });
    const t = setUp({ fakes });
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual(["Tonight's build: 1 built (idea_a), 2 failed (idea_b, idea_c)."]);
  });

  it("exits 1 without loading anything when another build holds the lock", async () => {
    const t = setUp({ locks: fakeLocks({ held: ["build.lock"] }) });
    expect(await t.run()).toBe(1);
    expect(t.fakes.loads).toBe(0);
    expect(t.out.lines).toEqual([]);
    expect(t.err.lines).toEqual([`Not started: ${BUILD_ALREADY_RUNNING}.`]);
    expect(t.log.lines).toMatchObject([{ level: "error", message: BUILD_ALREADY_RUNNING }]);
  });

  it("exits 1 with a one-line reason when the lock file cannot be used", async () => {
    const t = setUp({ locks: fakeLocks({ broken: ["build.lock"] }) });
    expect(await t.run()).toBe(1);
    expect(t.fakes.loads).toBe(0);
    expect(t.err.lines).toEqual(["Overnight could not use its build lock. unable to open database file"]);
  });

  it("exits 1, says why and lets go of the lock when the builder cannot be loaded or stops on an error", async () => {
    const order: string[] = [];
    const cannotLoad = setUp({ locks: fakeLocks({ order }) });
    cannotLoad.deps.loadFactories = () => Promise.reject(new Error("Cannot find package '@overnight/builder'\n    at somewhere"));
    expect(await build(cannotLoad.deps)).toBe(1);
    expect(cannotLoad.err.lines).toEqual([`"overnight build" could not finish. Cannot find package '@overnight/builder'`]);
    expect(order).toEqual(["lock build.lock", "release build.lock"]);

    const broke = setUp({
      fakes: fakeBuild({
        night: () => {
          throw new Error("the made-up builder fell over");
        },
      }),
    });
    expect(await broke.run()).toBe(1);
    expect(broke.err.lines).toEqual(['"overnight build" could not finish. the made-up builder fell over']);
    expect(broke.fakes.order.at(-1)).toBe("release build.lock");
    expect(broke.log.lines.at(-1)).toMatchObject({ level: "error", message: "overnight build stopped on an error", reason: "the made-up builder fell over" });
  });

  it("stops waiting for a night that never ends, so the lock is not held for ever, and tells the builder to stop", async () => {
    const t = setUp({ fakes: fakeBuild({ night: () => never() }), limitMs: 20 });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(['"overnight build" could not finish. The night\'s build was still going after 0 minutes, which is past its time limit.']);
    expect(t.fakes.order.at(-1)).toBe("release build.lock");
    // Nobody is waiting for it any more: whatever it started should go too.
    expect(t.fakes.nightDeps[0]?.signal?.aborted).toBe(true);
  });
});

describe("overnight build and stop signals", () => {
  /** A builder that keeps its promise: at a stop it comes back at once, with what it has. */
  const stoppable = () => fakeBuild({ night: async (deps) => (await aborted(deps.signal), { built: ["idea_a"], failed: ["idea_b"], skipped: "stopped" }) });
  /** Give the command time to reach the builder, as a signal from macOS would find it. */
  const underWay = async (t: ReturnType<typeof setUp>) => {
    await expect.poll(() => t.fakes.nightDeps.length).toBe(1);
  };

  it("hands the builder a signal that is not aborted, and takes its handlers off again when the night is over", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    const signal = t.fakes.nightDeps[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(t.stop.handlers()).toBe(0);
    expect(t.stop.exits).toEqual([]);
  });

  it("on a stop signal: tells the builder, writes one log line, waits for it, lets go of the lock, and exits with that signal's code", async () => {
    for (const name of STOP_SIGNAL_NAMES) {
      const t = setUp({ fakes: stoppable() });
      const running = t.run();
      await underWay(t);
      expect(t.stop.handlers()).toBe(STOP_SIGNAL_NAMES.length);
      t.stop.send(name);
      expect(await running, name).toBe(STOP_EXIT_CODES[name]);
      expect(t.fakes.nightDeps[0]?.signal?.aborted).toBe(true);
      // The lock is released only after the builder has come back.
      expect(t.fakes.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
      expect(t.log.lines.filter((line) => line.message.includes("stop signal"))).toMatchObject([{ level: "warn", message: "overnight build: stop signal received: stopping what is running, then ending", signal: name }]);
      // What the builder did get done is still said, in its own words.
      expect(t.out.lines).toEqual(["Tonight's build: 1 built (idea_a), 1 failed (idea_b); stopped."]);
      expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight build finished", stoppedBySignal: name });
      expect(t.stop.handlers()).toBe(0);
      expect(t.stop.exits).toEqual([]);
    }
    expect(STOP_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
  });

  it("ends at once on a second signal", async () => {
    const t = setUp({ fakes: fakeBuild({ night: () => never() }), stopWaitMs: 30 });
    const running = t.run();
    await underWay(t);
    t.stop.send("SIGTERM");
    expect(t.stop.exits).toEqual([]);
    t.stop.send("SIGINT");
    expect(t.stop.exits).toEqual([130]);
    // (In the test nothing really ends the process, so the command runs out its wait.)
    expect(await running).toBe(143);
  });

  it("stops waiting for a builder that does not come back after a stop signal, and still lets go of the lock", async () => {
    const t = setUp({ fakes: fakeBuild({ night: () => never() }), stopWaitMs: 30 });
    const running = t.run();
    await underWay(t);
    t.stop.send("SIGTERM");
    expect(await running).toBe(143);
    expect(t.err.lines).toEqual(['"overnight build" was told to stop, and the builder had not stopped 20 seconds later. Ending anyway.']);
    expect(t.log.lines.at(-1)).toMatchObject({ level: "error", message: "overnight build: the builder did not stop in time after the stop signal; ending anyway" });
    expect(t.fakes.order.at(-1)).toBe("release build.lock");
    expect(t.stop.handlers()).toBe(0);
  });

  it("starts nothing when the stop signal arrives while the builder is still loading", async () => {
    const t = setUp();
    const load = t.deps.loadFactories;
    t.deps.loadFactories = async () => {
      t.stop.send("SIGTERM");
      return load();
    };
    expect(await t.run()).toBe(143);
    expect(t.fakes.nightDeps).toEqual([]);
    expect(t.fakes.order).toEqual(["lock build.lock", "load builder", "release build.lock"]);
  });

  it("keeps the code of the signal when the builder throws on its way out", async () => {
    const fakes = fakeBuild({
      night: async (deps) => {
        await aborted(deps.signal);
        throw new Error("the made-up builder fell over while stopping");
      },
    });
    const t = setUp({ fakes });
    const running = t.run();
    await underWay(t);
    t.stop.send("SIGINT");
    expect(await running).toBe(130);
    expect(t.fakes.order.at(-1)).toBe("release build.lock");
  });
});

describe("overnight build and an error nobody caught", () => {
  const stoppable = () => fakeBuild({ night: async (deps) => (await aborted(deps.signal), { built: [], failed: [], skipped: "stopped" }) });

  it("writes one error line without the error's message, tells the builder to stop, lets go of the lock and exits 1", async () => {
    for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
      const t = setUp({ fakes: stoppable() });
      const running = t.run();
      await expect.poll(() => t.fakes.nightDeps.length).toBe(1);
      expect(t.lastResort.handlers()).toBe(2);

      t.lastResort.send(kind, Object.assign(new TypeError("made-up secret: a title someone said"), { code: "ERR_MADE_UP" }));

      // At once, before anything else gets to run: the log line, the stop, the lock, the exit.
      expect(t.lastResort.exits, kind).toEqual([1]);
      expect(t.fakes.nightDeps[0]?.signal?.aborted).toBe(true);
      expect(t.fakes.order).toEqual(["lock build.lock", "load builder", "runBuildNight", "release build.lock"]);
      const errors = t.log.lines.filter((line) => line.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: `overnight build: ${LAST_RESORT_LINE}`, kind, error: "TypeError", code: "ERR_MADE_UP" });
      expect(String(errors[0]?.where)).toMatch(/build\.test\.ts:\d+:\d+$/);
      expect(t.err.lines).toEqual([`"overnight build" ended on an error nobody caught (${kind}). Its lock was released; the one line about it is in its log.`]);
      // No payload anywhere: not in the log, not on the screen.
      expect(t.log.text() + t.err.text() + t.out.text()).not.toContain("made-up secret");

      // (In the test nothing really ends the process, so the command runs on to its end.)
      await running;
      expect(t.lastResort.handlers()).toBe(0);
    }
  });

  it("takes its handlers off again after an ordinary night, and never fires by itself", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.lastResort.handlers()).toBe(0);
    expect(t.lastResort.exits).toEqual([]);
    expect(t.log.lines.filter((line) => line.level === "error")).toEqual([]);
  });
});

describe("watching for stop signals", () => {
  it("aborts once, calls back once, and reports the first signal and its exit code", () => {
    const stop = fakeStopSignals();
    const seen: string[] = [];
    const watch = stop.watch({ onStop: (name) => void seen.push(name) });
    expect([watch.received(), watch.exitCode(), watch.signal.aborted]).toEqual([null, null, false]);
    stop.send("SIGHUP");
    expect([watch.received(), watch.exitCode(), watch.signal.aborted]).toEqual(["SIGHUP", 129, true]);
    expect(seen).toEqual(["SIGHUP"]);
    // The second one ends the process, with the second signal's own code, and is not "first" again.
    stop.send("SIGTERM");
    expect(stop.exits).toEqual([143]);
    expect(seen).toEqual(["SIGHUP"]);
    expect(watch.received()).toBe("SIGHUP");
    watch.close();
    watch.close();
    expect(stop.handlers()).toBe(0);
  });

  it("hands work through untouched when no signal comes, and survives a callback that throws", async () => {
    const stop = fakeStopSignals();
    const watch = stop.watch({
      onStop: () => {
        throw new Error("made-up: the log could not be written");
      },
    });
    expect(await watch.settle(Promise.resolve("done"))).toBe("done");
    expect(await watch.settle("not even a promise")).toBe("not even a promise");
    await expect(watch.settle(Promise.reject(new Error("made-up failure")))).rejects.toThrow("made-up failure");
    expect(() => stop.send("SIGINT")).not.toThrow();
    expect(watch.signal.aborted).toBe(true);
    watch.close();
  });

  it("gives up on work that has not settled a while after the signal, and not before", async () => {
    const stop = fakeStopSignals({ waitMs: 20 });
    const watch = stop.watch();
    const settled = watch.settle(never<string>());
    stop.send("SIGTERM");
    expect(await settled).toBe(STOP_OVERDUE);
    watch.close();

    // Work that does come back in time wins, signal or not.
    const second = fakeStopSignals({ waitMs: 5_000 });
    const patient = second.watch();
    second.send("SIGTERM");
    expect(await patient.settle(aborted(patient.signal).then(() => "came back"))).toBe("came back");
    patient.close();
  });

  it("can be aborted without a signal, which is not a stop signal", () => {
    const stop = fakeStopSignals();
    const watch = stop.watch();
    watch.abort();
    expect(watch.signal.aborted).toBe(true);
    expect([watch.received(), watch.exitCode()]).toEqual([null, null]);
    watch.close();
  });

  it("listens to this process and ends it for real unless a test says otherwise", () => {
    // Only looked at, never fired: the real watch puts one handler on each stop signal and takes it off again.
    const before = STOP_SIGNAL_NAMES.map((name) => process.listenerCount(name));
    const watch = watchStopSignals();
    expect(STOP_SIGNAL_NAMES.map((name) => process.listenerCount(name))).toEqual(before.map((count) => count + 1));
    watch.close();
    expect(STOP_SIGNAL_NAMES.map((name) => process.listenerCount(name))).toEqual(before);
  });
});

describe("what a night prints", () => {
  it("is the summary line, unless the builder says it was paused", () => {
    expect(buildNightLines({ built: ["idea_a"], failed: [], skipped: "" })).toEqual(["Tonight's build: 1 built (idea_a), 0 failed."]);
    expect(buildNightLines({ built: [], failed: [], skipped: "paused" })).toEqual([BUILD_PAUSED_LINE]);
    expect(buildNightLines({ built: [], failed: ["idea_a", "idea_b"], skipped: "paused" })).toEqual([BUILD_PAUSED_LINE, "2 builds cut off in an earlier run are now recorded as failed (idea_a, idea_b)."]);
    // Paused part-way through a night: "nothing was built" would not be true.
    expect(buildNightLines({ built: ["idea_a"], failed: [], skipped: "paused" })).toEqual(["Tonight's build: 1 built (idea_a), 0 failed; paused.", "Overnight was paused during the night: the rest waits until: npx overnight resume"]);
  });
});

describe("the build summary line", () => {
  it("adds the builder's own words for why nothing, or not everything, was built", () => {
    expect(buildSummary({ built: [], failed: [] })).toBe("Tonight's build: 0 built, 0 failed.");
    expect(buildSummary({ built: [], failed: [], skipped: null })).toBe("Tonight's build: 0 built, 0 failed.");
    expect(buildSummary({ built: [], failed: [], skipped: "" })).toBe("Tonight's build: 0 built, 0 failed.");
    expect(buildSummary({ built: [], failed: [], skipped: "nothing approved" })).toBe("Tonight's build: 0 built, 0 failed; nothing approved.");
    expect(buildSummary({ built: ["idea_a", "idea_b"], failed: [], skipped: "1 approved idea waits for another night (limit 2 a night)" })).toBe(
      "Tonight's build: 2 built (idea_a, idea_b), 0 failed; 1 approved idea waits for another night (limit 2 a night).",
    );
  });

  it("stays on one line whatever the builder hands back", () => {
    expect(buildSummary({ built: ["idea_a\nidea_x"], failed: [], skipped: "first\r\nsecond\u001b[2J" })).toBe("Tonight's build: 1 built (idea_a idea_x), 0 failed; first second [2J.");
  });
});

describe("choosing the builders", () => {
  it("makes each builder once and orders them by the setting", () => {
    const fakes = fakeBuild();
    const { paths } = testContext();
    const log = collectingLogger();
    const chosen = chooseBackends(fakes.factories, { config: { buildBackend: "kiro-cli", buildSandbox: "crew" }, paths, logger: log.logger });
    expect([chosen.primaryName, chosen.fallbackName]).toEqual(["kiro-cli", "kiro-crew"]);
    expect([chosen.backends.primary.name, chosen.backends.fallback.name]).toEqual(["kiro-cli", "kiro-crew"]);
    expect(chosen.backends.fallback.sandboxMode).toBe("crew");
  });
});

describe("time limits and durations", () => {
  it("gives a night every build on both builders, and half an hour on top", () => {
    const minutes = (ms: number) => ms / 60_000;
    // The defaults: 2 builds x 2 builders x (45 + 15) minutes, + 30. Over before the 06:30 deliver.
    expect(minutes(buildNightLimitMs({ maxBuildsPerNight: 2, buildTimeoutMin: 45 }))).toBe(270);
    expect(minutes(buildNightLimitMs({ maxBuildsPerNight: 1, buildTimeoutMin: 10 }))).toBe(80);
    // A limit of no builds still leaves time to find that out.
    expect(minutes(buildNightLimitMs({ maxBuildsPerNight: 0, buildTimeoutMin: 45 }))).toBe(150);
  });

  it("passes a result or an error through when the work finishes in time", async () => {
    expect(await withDeadline(Promise.resolve("done"), 1000, "The work")).toBe("done");
    expect(await withDeadline("not even a promise", 1000, "The work")).toBe("not even a promise");
    await expect(withDeadline(Promise.reject(new Error("made-up failure")), 1000, "The work")).rejects.toThrow("made-up failure");
  });

  it("gives up with a plain message when it does not", async () => {
    const error = await withDeadline(never<string>(), 10, "The work").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeadlinePassed);
    expect((error as DeadlinePassed).message).toBe("The work was still going after 0 minutes, which is past its time limit.");
    expect(new DeadlinePassed("The build", 105 * 60_000).message).toBe("The build was still going after 105 minutes, which is past its time limit.");
  });

  it("writes a duration the way a person would say it", () => {
    expect(formatDuration(0)).toBe("0 seconds");
    expect(formatDuration(1_400)).toBe("1 second");
    expect(formatDuration(52_000)).toBe("52 seconds");
    expect(formatDuration(142_000)).toBe("2 min 22 s");
    expect(formatDuration(3_840_000)).toBe("1 h 4 min");
  });
});
