// All text in this file is made up for the tests. None of it is Bee data; nothing is published
// and no Bee to-do or fact is created.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliver, DELIVER_ALREADY_RUNNING, DELIVER_ONE_LIMIT_MS, deliverLimitMs, deliverSummary, disposeQuietly } from "../src/commands/deliver.ts";
import type { DeliverDeps } from "../src/commands/deliver.ts";
import type { NightRunMarks } from "../src/commands/night-tick.ts";
import { SLEPT_LINE } from "../src/sleep-watch.ts";
import { STOP_EXIT_CODES, STOP_SIGNAL_NAMES } from "../src/stop-signals.ts";
import { addIdea, at, capture, moveIdea, SAMPLE_IDEAS, testContext } from "./helpers.ts";
import { LAST_RESORT_LINE } from "../src/last-resort.ts";
import { aborted, collectingLogger, fakeDeliver, fakeKeepAwake, fakeLastResort, fakeLocks, fakeMarks, fakeSleepWatch, fakeStopSignals, never } from "./night-fakes.ts";
import type { DeliverFakes } from "./night-fakes.ts";

function setUp(options: { env?: Record<string, string>; fakes?: DeliverFakes; locks?: ReturnType<typeof fakeLocks>; limitMs?: number; stopWaitMs?: number; onRun?: NightRunMarks; keepAwake?: DeliverDeps["keepAwake"] } = {}) {
  const context = testContext(options.env);
  const out = capture();
  const err = capture();
  const log = collectingLogger("deliver");
  const fakes = options.fakes ?? fakeDeliver();
  const locks = options.locks ?? fakeLocks({ order: fakes.order });
  // Made-up stop signals: no test listens to, or sends, a real one.
  const stop = fakeStopSignals({ waitMs: options.stopWaitMs });
  // The same for errors nobody caught: made up, and "ending the process" only notes the exit code.
  const lastResort = fakeLastResort();
  // And for the Mac having slept: no timer is set, a test says when.
  const sleep = fakeSleepWatch();
  const deps: DeliverDeps = {
    ...context,
    logger: log.logger,
    loadFactories: fakes.load,
    takeLock: locks.takeLock,
    write: out.write,
    writeError: err.write,
    watchStopSignals: stop.watch,
    watchLastResort: lastResort.watch,
    watchForSleep: sleep.watch,
    limitMs: options.limitMs,
    ...(options.onRun === undefined ? {} : { onRun: options.onRun }),
    ...(options.keepAwake === undefined ? {} : { keepAwake: options.keepAwake }),
  };
  return { context, out, err, log, fakes, locks, stop, lastResort, sleep, deps, run: () => deliver(deps) };
}

describe("overnight deliver", () => {
  it("takes its own lock, makes the Bee gateway, runs the morning, then stops the gateway and lets go", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.locks.files).toEqual([path.join(t.context.paths.root, "deliver.lock")]);
    expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);

    const handed = t.fakes.runDeps[0];
    expect(handed?.store).toBe(t.context.store);
    expect(handed?.config).toBe(t.context.config);
    expect(handed?.paths).toBe(t.context.paths);
    expect(handed?.logger).toBe(t.log.logger);
    expect(handed?.bee).toBe(t.fakes.bee);
    // The gateway logs to the deliver log too.
    expect(t.fakes.beeOptions).toEqual([{ logger: t.log.logger }]);
  });

  it("prints one summary line, with ids and never titles", async () => {
    const fakes = fakeDeliver({ run: () => ({ delivered: ["idea_a"], failed: ["idea_b"], notified: ["idea_b", "idea_c"] }) });
    const t = setUp({ fakes });
    const idea = addIdea(t.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(t.context.store, idea, ["asked", "approved", "building", "built"], at(-500));
    // A failed publish is recorded on the idea. The command itself ran, so it exits 0.
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual(["This morning: 1 delivered (idea_a), 1 failed (idea_b), 2 told about a failure (idea_b, idea_c)."]);
    expect(t.err.lines).toEqual([]);
    expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight deliver finished", delivered: 1, failed: 1, notified: 2 });
    expect(t.out.text() + t.log.text()).not.toContain(SAMPLE_IDEAS.turns.title);
  });

  it("says so plainly when there was nothing to do, and when the morning was cut short", () => {
    expect(deliverSummary({ delivered: [], failed: [], notified: [] })).toBe("This morning: 0 delivered, 0 failed, 0 told about a failure.");
    expect(deliverSummary({ delivered: ["idea_a"], failed: [], notified: [], stopped: true })).toBe(
      "This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure. Stopped before the morning was done: the rest waits for the next run.",
    );
  });

  it("says when a page was pushed but not seen live: the link went out, and may not open for a few minutes", async () => {
    expect(deliverSummary({ delivered: ["idea_a", "idea_b"], failed: [], notified: [], notSeenLive: ["idea_a"] })).toBe(
      "This morning: 2 delivered (idea_a, idea_b), 0 failed, 0 told about a failure. 1 pushed but not seen live yet (idea_a): the link usually starts working a few minutes later.",
    );
    // Before the sentence about a morning that was cut short, and on one line whatever the ids hold.
    expect(deliverSummary({ delivered: [], failed: [], notified: [], notSeenLive: ["idea_a", "idea\nb"], stopped: true })).toBe(
      "This morning: 0 delivered, 0 failed, 0 told about a failure. 2 pushed but not seen live yet (idea_a, idea b): the link usually starts working a few minutes later. Stopped before the morning was done: the rest waits for the next run.",
    );
    expect(deliverSummary({ delivered: ["idea_a"], failed: [], notified: [], notSeenLive: [] })).toBe("This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure.");

    const t = setUp({ fakes: fakeDeliver({ run: () => ({ delivered: ["idea_a"], failed: [], notified: [], notSeenLive: ["idea_a"] }) }) });
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual(["This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure. 1 pushed but not seen live yet (idea_a): the link usually starts working a few minutes later."]);
    expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight deliver finished", delivered: 1, notSeenLive: 1 });
    // The count is in the log every morning, also when it is none.
    const usual = setUp();
    await usual.run();
    expect(usual.log.lines.at(-1)).toMatchObject({ message: "overnight deliver finished", notSeenLive: 0 });
  });

  it("leaves the pause switch to the deliver step: paused or not, the morning is handed over", async () => {
    // What a paused Overnight does with apps that are already built is @overnight/deliver's rule.
    const t = setUp({ env: { PAUSED: "true" } });
    expect(t.context.store.isPaused(t.context.config.pausedByDefault)).toBe(true);
    expect(await t.run()).toBe(0);
    expect(t.fakes.runDeps).toHaveLength(1);
    expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
  });

  it("exits 1 without loading anything when another deliver holds the lock", async () => {
    const t = setUp({ locks: fakeLocks({ held: ["deliver.lock"] }) });
    expect(await t.run()).toBe(1);
    expect(t.fakes.loads).toBe(0);
    expect(t.err.lines).toEqual([`Not started: ${DELIVER_ALREADY_RUNNING}.`]);
    expect(t.log.lines).toMatchObject([{ level: "error", message: DELIVER_ALREADY_RUNNING }]);
  });

  it("is not stopped by a build that is running: the two have separate locks", async () => {
    const t = setUp({ locks: fakeLocks({ held: ["build.lock"] }) });
    expect(await t.run()).toBe(0);
    expect(t.fakes.runDeps).toHaveLength(1);
  });

  it("exits 1 with a one-line reason when the lock file cannot be used", async () => {
    const t = setUp({ locks: fakeLocks({ broken: ["deliver.lock"] }) });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(["Overnight could not use its deliver lock. unable to open database file"]);
  });

  it("exits 1, says why, stops the gateway and lets go of the lock when the deliver step stops on an error", async () => {
    const fakes = fakeDeliver({
      run: () => {
        throw new Error("the made-up publisher fell over\n    at somewhere");
      },
    });
    const t = setUp({ fakes });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(['"overnight deliver" could not finish. the made-up publisher fell over']);
    expect(fakes.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
    expect(t.log.lines.at(-1)).toMatchObject({ level: "error", message: "overnight deliver stopped on an error" });
  });

  it("stops waiting for a morning that never ends, and tells the deliver step to stop", async () => {
    const t = setUp({ fakes: fakeDeliver({ run: () => never() }), limitMs: 20 });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(['"overnight deliver" could not finish. The morning\'s deliver was still going after 0 minutes, which is past its time limit.']);
    expect(t.fakes.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
    expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(true);
  });

  it("gives the morning an hour for each idea waiting to be published, and a quarter of an hour on top", () => {
    // One idea's limit has to sit above the deliver step's own limits added up (about 48 minutes),
    // so that it is never the one that fires first on a slow morning.
    expect(DELIVER_ONE_LIMIT_MS / 60_000).toBe(60);
    const { store } = testContext();
    const minutes = () => deliverLimitMs(store) / 60_000;
    expect(minutes()).toBe(75);
    const built = [SAMPLE_IDEAS.turns, SAMPLE_IDEAS.plants, SAMPLE_IDEAS.chores].map((sample, index) => moveIdea(store, addIdea(store, sample, at(-900 + index)), ["asked", "approved", "building", "built"], at(-800 + index)));
    expect(built).toHaveLength(3);
    expect(minutes()).toBe(195);
  });

  /** Give the command time to reach the deliver step, as a signal from macOS would find it. */
  const underWay = async (t: ReturnType<typeof setUp>) => {
    await expect.poll(() => t.fakes.runDeps.length).toBe(1);
  };

  it("hands the deliver step a signal that is not aborted, and takes its handlers off again afterwards", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.fakes.runDeps[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(false);
    expect(t.stop.handlers()).toBe(0);
  });

  it("on a stop signal: tells the deliver step, writes one log line, waits for it, stops the gateway, lets go of the lock, and exits with that signal's code", async () => {
    for (const name of STOP_SIGNAL_NAMES) {
      // A deliver step that keeps its promise: at a stop it comes back at once, with what it has.
      const fakes = fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: ["idea_a"], failed: [], notified: [] }) });
      const t = setUp({ fakes });
      const running = t.run();
      await underWay(t);
      expect(t.stop.handlers()).toBe(STOP_SIGNAL_NAMES.length);
      t.stop.send(name);
      expect(await running, name).toBe(STOP_EXIT_CODES[name]);
      expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(true);
      // Nothing is let go of before the deliver step has come back.
      expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
      expect(t.log.lines.filter((line) => line.message.includes("stop signal"))).toMatchObject([{ level: "warn", message: "overnight deliver: stop signal received: stopping what is running, then ending", signal: name }]);
      expect(t.out.lines).toEqual(["This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure."]);
      expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight deliver finished", stoppedBySignal: name });
      expect(t.stop.handlers()).toBe(0);
      expect(t.stop.exits).toEqual([]);
    }
  });

  it("ends at once on a second signal", async () => {
    const t = setUp({ fakes: fakeDeliver({ run: () => never() }), stopWaitMs: 30 });
    const running = t.run();
    await underWay(t);
    t.stop.send("SIGTERM");
    expect(t.stop.exits).toEqual([]);
    t.stop.send("SIGTERM");
    expect(t.stop.exits).toEqual([143]);
    // (In the test nothing really ends the process, so the command runs out its wait.)
    expect(await running).toBe(143);
  });

  it("stops waiting for a deliver step that does not come back after a stop signal, and still stops the gateway and lets go of the lock", async () => {
    const t = setUp({ fakes: fakeDeliver({ run: () => never() }), stopWaitMs: 30 });
    const running = t.run();
    await underWay(t);
    t.stop.send("SIGINT");
    expect(await running).toBe(130);
    expect(t.err.lines).toEqual(['"overnight deliver" was told to stop, and the deliver step had not stopped 20 seconds later. Ending anyway.']);
    expect(t.fakes.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
    expect(t.stop.handlers()).toBe(0);
  });

  it("starts nothing when the stop signal arrives while its packages are still loading", async () => {
    const t = setUp();
    const load = t.deps.loadFactories;
    t.deps.loadFactories = async () => {
      t.stop.send("SIGTERM");
      return load();
    };
    expect(await t.run()).toBe(143);
    expect(t.fakes.runDeps).toEqual([]);
    expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "release deliver.lock"]);
  });

  it("survives a gateway whose dispose throws, or that has none", () => {
    expect(() =>
      disposeQuietly({
        dispose: () => {
          throw new Error("made-up: already gone");
        },
      }),
    ).not.toThrow();
    expect(() => disposeQuietly({})).not.toThrow();
    expect(() => disposeQuietly(null)).not.toThrow();
  });
});

describe("overnight deliver with the night clock's marks and a hold on the Mac's sleep", () => {
  const stoppable = () => fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: [], failed: [], notified: [], stopped: true }) });
  const underWay = async (t: ReturnType<typeof setUp>) => {
    await expect.poll(() => t.fakes.runDeps.length).toBe(1);
  };
  /** The same order list for the locks, the deliver step, the marks and the hold. */
  function clocked(options: Parameters<typeof setUp>[0] = {}) {
    const order: string[] = [];
    const fakes = options.fakes ?? fakeDeliver();
    fakes.order = order;
    const marks = fakeMarks(order);
    const awake = fakeKeepAwake(order);
    const t = setUp({ ...options, fakes, locks: options.locks ?? fakeLocks({ order }), onRun: marks.marks, keepAwake: awake.keepAwake });
    return { ...t, order, marks, awake };
  }

  it("marks the start once the Bee gateway is made and before any work, holds the Mac awake for the morning, and marks the end before the lock goes", async () => {
    const t = clocked();
    expect(await t.run()).toBe(0);
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "mark started", "keep awake", "runDeliver", "mark ended finished", "let sleep", "dispose bee", "release deliver.lock"]);
    expect(t.awake.loggers).toEqual([t.log.logger]);
    expect(t.awake.held()).toBe(0);
  });

  it("without them it runs as it always did: plain `overnight deliver` means now, and asks no clock", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
  });

  it("calls a morning finished whatever was delivered or failed, and cut short when the deliver step says it was stopped", async () => {
    const usual = clocked({ fakes: fakeDeliver({ run: () => ({ delivered: ["idea_a"], failed: ["idea_b"], notified: ["idea_b"] }) }) });
    expect(await usual.run()).toBe(0);
    expect(usual.marks.ended).toEqual(["finished"]);
    // The step came back early by itself, with no signal to this command: still not a finished morning.
    const stoppedInside = clocked({ fakes: fakeDeliver({ run: () => ({ delivered: [], failed: [], notified: [], stopped: true }) }) });
    expect(await stoppedInside.run()).toBe(0);
    expect(stoppedInside.marks.ended).toEqual(["cut-short"]);
  });

  it("marks nothing and holds nothing when the morning never begins: lock held, lock unusable, packages will not load, stopped while loading", async () => {
    const held = clocked({ locks: fakeLocks({ held: ["deliver.lock"] }) });
    expect(await held.run()).toBe(1);
    const broken = clocked({ locks: fakeLocks({ broken: ["deliver.lock"] }) });
    expect(await broken.run()).toBe(1);
    const noPackage = clocked();
    noPackage.deps.loadFactories = () => Promise.reject(new Error("Cannot find package '@overnight/deliver'"));
    expect(await noPackage.run()).toBe(1);
    const stopped = clocked();
    const load = stopped.deps.loadFactories;
    stopped.deps.loadFactories = async () => {
      stopped.stop.send("SIGTERM");
      return load();
    };
    expect(await stopped.run()).toBe(143);
    for (const t of [held, broken, noPackage, stopped]) {
      expect(t.marks.started()).toBe(0);
      expect(t.marks.ended).toEqual([]);
      expect(t.order).not.toContain("keep awake");
      expect(t.fakes.runDeps).toEqual([]);
      expect(t.sleep.watching()).toBe(0);
    }
  });

  it("delivers nothing when the start cannot be written down, and still stops the gateway and lets go of the lock", async () => {
    const t = clocked();
    t.deps.onRun = {
      started: () => {
        throw new Error("database is locked\n    at somewhere");
      },
      ended: (how) => void t.order.push(`mark ended ${how}`),
    };
    expect(await t.run()).toBe(1);
    expect(t.fakes.runDeps).toEqual([]);
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "dispose bee", "release deliver.lock"]);
    expect(t.err.lines).toEqual(['"overnight deliver" could not finish. database is locked']);
  });

  it("marks the morning cut short when it is stopped by a signal, throws, runs past its limit, or does not come back", async () => {
    const signalled = clocked({ fakes: stoppable() });
    const first = signalled.run();
    await underWay(signalled);
    signalled.stop.send("SIGTERM");
    expect(await first).toBe(143);
    const threw = clocked({
      fakes: fakeDeliver({
        run: () => {
          throw new Error("the made-up deliver step fell over");
        },
      }),
    });
    expect(await threw.run()).toBe(1);
    const tooLong = clocked({ fakes: fakeDeliver({ run: () => never() }), limitMs: 20 });
    expect(await tooLong.run()).toBe(1);
    const overdue = clocked({ fakes: fakeDeliver({ run: () => never() }), stopWaitMs: 30 });
    const last = overdue.run();
    await underWay(overdue);
    overdue.stop.send("SIGINT");
    expect(await last).toBe(130);
    for (const t of [signalled, threw, tooLong, overdue]) {
      expect(t.marks.ended).toEqual(["cut-short"]);
      expect(t.order.slice(-4)).toEqual(["mark ended cut-short", "let sleep", "dispose bee", "release deliver.lock"]);
      expect(t.awake.held()).toBe(0);
    }
  });

  it("still stops the gateway and lets go of the lock when a mark, or the hold itself, throws on the way out", async () => {
    const t = clocked();
    t.deps.onRun = {
      started: () => {},
      ended: () => {
        throw new Error("made-up: the end could not be written");
      },
    };
    t.deps.keepAwake = () => ({
      stop: () => {
        throw new Error("made-up: the hold would not let go");
      },
    });
    expect(await t.run()).toBe(0);
    expect(t.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
  });
});

describe("overnight deliver and a Mac that slept through part of the morning", () => {
  const stoppable = () => fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: ["idea_a"], failed: [], notified: [], stopped: true }) });
  const underWay = async (t: ReturnType<typeof setUp>) => {
    await expect.poll(() => t.fakes.runDeps.length).toBe(1);
  };

  it("watches from the start of the morning to its end, and never fires by itself", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.sleep.started()).toBe(1);
    expect(t.sleep.watching()).toBe(0);
    expect(t.log.text()).not.toContain("went to sleep");
  });

  it("tells the deliver step to stop as a stop signal would, says so once in the log, marks the morning cut short, and exits 0", async () => {
    const order: string[] = [];
    const marks = fakeMarks(order);
    const fakes = stoppable();
    fakes.order = order;
    const t = setUp({ fakes, locks: fakeLocks({ order }), onRun: marks.marks });
    const running = t.run();
    await underWay(t);
    expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(false);
    t.sleep.fire(95_000);
    expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(true);
    expect(await running).toBe(0);
    expect(t.log.lines.filter((line) => line.level === "warn")).toMatchObject([{ message: SLEPT_LINE, gapSeconds: 95 }]);
    expect(t.log.lines.at(-1)).toMatchObject({ message: "overnight deliver finished", delivered: 1, stoppedBySleep: true });
    expect(t.log.lines.at(-1)).not.toHaveProperty("stoppedBySignal");
    expect(order).toEqual(["lock deliver.lock", "load deliver", "create bee", "mark started", "runDeliver", "mark ended cut-short", "dispose bee", "release deliver.lock"]);
    expect(t.out.lines).toEqual(["This morning: 1 delivered (idea_a), 0 failed, 0 told about a failure. Stopped before the morning was done: the rest waits for the next run."]);
    expect(t.err.lines).toEqual([]);
    expect(t.stop.handlers()).toBe(0);
  });

  it("marks the morning cut short even if the deliver step comes back from it without saying it was stopped", async () => {
    const marks = fakeMarks();
    const t = setUp({ fakes: fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: [], failed: [], notified: [] }) }), onRun: marks.marks });
    const running = t.run();
    await underWay(t);
    t.sleep.fire();
    expect(await running).toBe(0);
    expect(marks.ended).toEqual(["cut-short"]);
  });

  it("starts nothing when the sleep is noticed while its packages are still loading: the slot stays due", async () => {
    const marks = fakeMarks();
    const t = setUp({ onRun: marks.marks });
    const load = t.deps.loadFactories;
    t.deps.loadFactories = async () => {
      t.sleep.fire();
      return load();
    };
    expect(await t.run()).toBe(0);
    expect(t.fakes.runDeps).toEqual([]);
    expect(marks.started()).toBe(0);
    expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "release deliver.lock"]);
  });

  it("stops waiting for a deliver step that does not come back after it, says so, and exits 1", async () => {
    const marks = fakeMarks();
    const t = setUp({ fakes: fakeDeliver({ run: () => never() }), stopWaitMs: 30, onRun: marks.marks });
    const running = t.run();
    await underWay(t);
    t.sleep.fire();
    expect(await running).toBe(1);
    expect(t.err.lines).toEqual(['"overnight deliver" was told to stop, and the deliver step had not stopped 20 seconds later. Ending anyway.']);
    expect(t.log.lines.at(-1)).toMatchObject({ level: "error", message: "overnight deliver: the deliver step did not stop in time after the Mac's sleep was noticed; ending anyway" });
    expect(marks.ended).toEqual(["cut-short"]);
    expect(t.fakes.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
  });
});

describe("overnight deliver and an error nobody caught", () => {
  it("writes one error line without the error's message, tells the deliver step to stop, stops the gateway, lets go of the lock and exits 1", async () => {
    for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
      const fakes = fakeDeliver({ run: async (deps) => (await aborted(deps.signal), { delivered: [], failed: [], notified: [], stopped: true }) });
      const t = setUp({ fakes });
      const running = t.run();
      await expect.poll(() => t.fakes.runDeps.length).toBe(1);
      expect(t.lastResort.handlers()).toBe(2);

      t.lastResort.send(kind, new Error("made-up secret: a link and a title"));

      expect(t.lastResort.exits, kind).toEqual([1]);
      expect(t.fakes.runDeps[0]?.signal?.aborted).toBe(true);
      // Before the process ends: the bee program is stopped and the lock is let go, in that order.
      expect(t.fakes.order).toEqual(["lock deliver.lock", "load deliver", "create bee", "runDeliver", "dispose bee", "release deliver.lock"]);
      const errors = t.log.lines.filter((line) => line.level === "error");
      expect(errors).toMatchObject([{ message: `overnight deliver: ${LAST_RESORT_LINE}`, kind, error: "Error" }]);
      expect(t.err.lines).toEqual([`"overnight deliver" ended on an error nobody caught (${kind}). Its lock was released; the one line about it is in its log.`]);
      expect(t.log.text() + t.err.text() + t.out.text()).not.toContain("made-up secret");

      await running;
      expect(t.lastResort.handlers()).toBe(0);
    }
  });

  it("lets go of the lock even when the error comes before the Bee gateway exists", async () => {
    const t = setUp();
    const load = t.deps.loadFactories;
    t.deps.loadFactories = async () => {
      t.lastResort.send("unhandledRejection", new Error("made-up"));
      return load();
    };
    await t.run();
    expect(t.lastResort.exits).toEqual([1]);
    expect(t.fakes.order.slice(0, 2)).toEqual(["lock deliver.lock", "release deliver.lock"]);
  });
});
