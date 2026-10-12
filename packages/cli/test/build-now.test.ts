// All text in this file is made up for the tests. None of it is Bee data; nothing is built,
// published or sent to Bee.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failInterruptedBuilds, INTERRUPTED_REASON } from "@overnight/builder";
import { BUILD_INTERRUPTED_REASON, isBuildAwaitingRetry } from "@overnight/core";
import type { Idea, IdeaState, Store } from "@overnight/core";
import { BUILD_CUT_OFF_REASON, BUILD_NOW_BUILD_BUSY, BUILD_NOW_DELIVER_BUSY, BUILD_NOW_NOT_SEEN_LIVE, BUILD_NOW_PAUSED, buildNow } from "../src/commands/build-now.ts";
import type { BuildNowDeps } from "../src/commands/build-now.ts";
import { addIdea, at, capture, fixedNow, moveIdea, SAMPLE_IDEAS, testContext } from "./helpers.ts";
import { LAST_RESORT_LINE } from "../src/last-resort.ts";
import { sleptLine } from "../src/sleep-watch.ts";
import { aborted, collectingLogger, fakeBuild, fakeDeliver, fakeKeepAwake, fakeLastResort, fakeLocks, fakeSleepWatch, fakeStopSignals, never } from "./night-fakes.ts";
import type { BuildFakes, DeliverFakes, FakeBackend } from "./night-fakes.ts";

const LINK = "https://example.invalid/apps/whose-turn-to-pay/";

/** The path from "heard" to each state build-now can meet. */
const PATH_TO: Record<IdeaState, IdeaState[]> = {
  heard: [],
  asked: ["asked"],
  approved: ["asked", "approved"],
  rejected: ["asked", "rejected"],
  expired: ["asked", "expired"],
  building: ["asked", "approved", "building"],
  built: ["asked", "approved", "building", "built"],
  build_failed: ["asked", "approved", "building", "build_failed"],
  published: ["asked", "approved", "building", "built", "published"],
  publish_failed: ["asked", "approved", "building", "built", "publish_failed"],
  delivered: ["asked", "approved", "building", "built", "published", "delivered"],
};

function ideaIn(store: Store, state: IdeaState): Idea {
  return moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, at(-3600)), PATH_TO[state], at(-3000));
}

/** Fakes that do to the store what the real packages do, so the command can read the result back. */
function realistic(store: Store, order: string[]) {
  const build = fakeBuild({
    order,
    one: (ideaId, deps) => {
      store.transitionIdea(ideaId, "building", { slug: "whose-turn-to-pay", buildBackend: deps.backends.primary.name, buildStartedAt: at(0) }, at(0));
      store.transitionIdea(ideaId, "built", { builtAt: at(142) }, at(142));
      return { ok: true, backend: deps.backends.primary.name, ms: 142_000 };
    },
  });
  const deliver = fakeDeliver({
    order,
    one: (ideaId) => {
      store.transitionIdea(ideaId, "published", { publishedUrl: LINK, publishedAt: at(200) }, at(200));
      store.transitionIdea(ideaId, "delivered", { deliveredAt: at(210), morningTodoId: 4242 }, at(210));
      return { ok: true, url: LINK };
    },
  });
  return { build, deliver };
}

function setUp(options: { env?: Record<string, string>; state?: IdeaState; build?: BuildFakes; deliver?: DeliverFakes; held?: string[]; buildLimitMs?: number; deliverLimitMs?: number; now?: string; stopWaitMs?: number; keepAwake?: boolean } = {}) {
  const context = testContext(options.env);
  const order: string[] = [];
  const fakes = realistic(context.store, order);
  const build = options.build ?? fakes.build;
  const deliver = options.deliver ?? fakes.deliver;
  // Whichever fakes are used, every step lands in the one list.
  build.order = order;
  deliver.order = order;
  const locks = fakeLocks({ order, held: options.held });
  const out = capture();
  const err = capture();
  const buildLog = collectingLogger("build");
  const deliverLog = collectingLogger("deliver");
  const idea = ideaIn(context.store, options.state ?? "approved");
  // Made-up stop signals: no test listens to, or sends, a real one.
  const stop = fakeStopSignals({ waitMs: options.stopWaitMs });
  // The same for errors nobody caught: made up, and "ending the process" only notes the exit code.
  const lastResort = fakeLastResort();
  // And for the Mac having slept: no timer is set, a test says when.
  const sleep = fakeSleepWatch();
  // A made-up hold on the Mac's sleep, noted in the same list. Only the tests that ask for it get one.
  const awake = fakeKeepAwake(order);
  const deps: BuildNowDeps<FakeBackend> = {
    ...context,
    buildLogger: buildLog.logger,
    deliverLogger: deliverLog.logger,
    loadBuildFactories: build.load,
    loadDeliverFactories: deliver.load,
    takeLock: locks.takeLock,
    write: out.write,
    writeError: err.write,
    // The made-up clock: noon, 48 minutes after ideaIn() left a "building" idea in that state.
    now: fixedNow(options.now),
    watchStopSignals: stop.watch,
    watchLastResort: lastResort.watch,
    watchForSleep: sleep.watch,
    ...(options.keepAwake ? { keepAwake: awake.keepAwake } : {}),
    buildLimitMs: options.buildLimitMs,
    deliverLimitMs: options.deliverLimitMs,
  };
  return { context, order, build, deliver, locks, out, err, buildLog, deliverLog, idea, stop, lastResort, sleep, awake, deps, run: (id: string = idea.id) => buildNow(id, deps) };
}

describe("overnight build-now <ideaId>", () => {
  it("builds, then delivers, each under its own lock, and prints each step with the link last", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.order).toEqual([
      "lock build.lock",
      "load builder",
      `buildOne ${t.idea.id}`,
      "release build.lock",
      "lock deliver.lock",
      "load deliver",
      "create bee",
      `deliverOne ${t.idea.id}`,
      "dispose bee",
      "release deliver.lock",
    ]);
    expect(t.locks.files).toEqual([path.join(t.context.paths.root, "build.lock"), path.join(t.context.paths.root, "deliver.lock")]);
    expect(t.err.lines).toEqual([]);
    expect(t.out.lines).toEqual([
      `Idea ${t.idea.id}: Whose turn to pay`,
      "1. Build: starting with kiro-crew (kiro-cli if that fails). This can take up to 45 minutes each.",
      "  Built by kiro-crew in 2 min 22 s.",
      "2. Deliver: installing, building and testing a clean copy inside the sandbox, then publishing.",
      '  Done: the idea is now "delivered".',
      `Link: ${LINK}`,
    ]);
    expect(t.context.store.getIdea(t.idea.id)).toMatchObject({ state: "delivered", publishedUrl: LINK });
  });

  it("hands each step the store, the settings, the paths and its own log", async () => {
    // These two fakes leave the idea where it is: this test is about what they are handed.
    const t = setUp({ env: { BUILD_BACKEND: "kiro-cli", BUILD_SANDBOX: "overnight" }, build: fakeBuild(), deliver: fakeDeliver() });
    expect(await t.run()).toBe(0);

    const built = t.build.oneCalls[0];
    expect(built?.ideaId).toBe(t.idea.id);
    expect(built?.deps.store).toBe(t.context.store);
    expect(built?.deps.config).toBe(t.context.config);
    expect(built?.deps.paths).toBe(t.context.paths);
    expect(built?.deps.logger).toBe(t.buildLog.logger);
    // BUILD_BACKEND=kiro-cli: that builder first, Kiro Crew (told the sandbox mode from the settings) as the fallback.
    expect(built?.deps.backends.primary.name).toBe("kiro-cli");
    expect(built?.deps.backends.fallback).toMatchObject({ name: "kiro-crew", sandboxMode: "overnight" });
    expect(t.buildLog.lines[0]).toMatchObject({ message: "overnight build-now: build starting", primary: "kiro-cli", fallback: "kiro-crew", sandboxMode: "overnight" });
    expect(t.out.lines[1]).toBe("1. Build: starting with kiro-cli (kiro-crew if that fails). This can take up to 45 minutes each.");
  });

  it("gives the deliver step the Bee gateway and the deliver log", async () => {
    const t = setUp();
    await t.run();
    const delivered = t.deliver.oneCalls[0];
    expect(delivered?.ideaId).toBe(t.idea.id);
    expect(delivered?.deps.bee).toBe(t.deliver.bee);
    expect(delivered?.deps.logger).toBe(t.deliverLog.logger);
    expect(delivered?.deps.store).toBe(t.context.store);
    expect(t.deliver.beeOptions).toEqual([{ logger: t.deliverLog.logger }]);
  });

  it("writes ids, never the title, to the two logs", async () => {
    const t = setUp();
    await t.run();
    expect(t.buildLog.lines.map((line) => line.message)).toEqual(["overnight build-now: build starting", "overnight build-now: build finished"]);
    expect(t.buildLog.lines[1]).toMatchObject({ ideaId: t.idea.id, ok: true, backend: "kiro-crew", ms: 142_000 });
    expect(t.deliverLog.lines.map((line) => line.message)).toEqual(["overnight build-now: deliver starting", "overnight build-now: deliver finished"]);
    expect(t.buildLog.text() + t.deliverLog.text()).not.toContain("Whose turn to pay");
  });

  it("refuses while paused, names the command that turns Overnight on, and touches nothing", async () => {
    for (const paused of ["by the setting", "by the stored switch"] as const) {
      const t = setUp(paused === "by the setting" ? { env: { PAUSED: "true" } } : {});
      if (paused === "by the stored switch") t.context.store.setPaused(true, at(0));
      expect(await t.run(), paused).toBe(1);
      expect(t.err.lines).toEqual([BUILD_NOW_PAUSED]);
      expect(BUILD_NOW_PAUSED).toContain("npx overnight resume");
      expect(t.out.lines).toEqual([]);
      expect(t.order).toEqual([]);
      expect(t.context.store.getIdea(t.idea.id)?.state).toBe("approved");
    }
  });

  it("refuses an id no idea has, without loading or locking anything", async () => {
    const t = setUp();
    expect(await t.run("idea_20261009_nosuch00")).toBe(1);
    expect(t.err.lines).toEqual(['No idea has the id "idea_20261009_nosuch00". See the ids with: npx overnight ideas --all']);
    expect(t.out.lines).toEqual([]);
    expect(t.order).toEqual([]);
  });

  it("keeps an odd id on one short line when it repeats it", async () => {
    const t = setUp();
    expect(await t.run(`nope\u001b[2J\n${"x".repeat(200)}`)).toBe(1);
    expect(t.err.lines).toHaveLength(1);
    expect(t.err.lines[0]).not.toContain("\u001b");
    expect(t.err.lines[0]).not.toContain("\n");
    expect(t.err.lines[0]?.length).toBeLessThan(160);
  });

  it("never builds an idea that was not approved", async () => {
    const why: Partial<Record<IdeaState, string>> = {
      heard: "it was heard but never asked about",
      asked: "it is still waiting for an answer on the watch",
      rejected: "it was turned down",
      expired: "nobody answered in time",
    };
    for (const state of ["heard", "asked", "rejected", "expired"] as const) {
      const t = setUp({ state });
      expect(await t.run(), state).toBe(1);
      expect(t.err.lines, state).toEqual([`Not built: only an approved idea is ever built, and this one is "${state}" (${why[state]}).`]);
      expect(t.order, state).toEqual([]);
      expect(t.context.store.getIdea(t.idea.id)?.state).toBe(state);
    }
  });

  it("does not start a second build of an idea that is being built, and says when it could be tried again", async () => {
    // "building" since 11:12 (48 minutes before the made-up noon). With the 45-minute limit a build
    // counts as cut off only after 60 minutes: until then its Kiro Crew job may still be at work.
    const t = setUp({ state: "building" });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual([
      'Not started: this idea is marked as being built right now (state "building"). If that build was cut off, it is given up on at Oct 9, 12:12 PM (its time limit and 15 minutes after it began): run this command again after that.',
    ]);
    // Too young to be given up on: not even the lock is looked at.
    expect(t.order).toEqual([]);
    expect(t.context.store.getIdea(t.idea.id)?.state).toBe("building");
    expect(t.buildLog.lines).toEqual([]);

    // The limit follows BUILD_TIMEOUT_MIN, and the start of the latest try when one is recorded.
    const longer = setUp({ state: "building", env: { BUILD_TIMEOUT_MIN: "90" }, now: at(3600) });
    longer.context.store.updateIdea(longer.idea.id, { buildStartedAt: at(0) }, at(0));
    expect(await longer.run()).toBe(1);
    expect(longer.err.lines[0]).toContain("it is given up on at Oct 9, 1:45 PM");
    expect(longer.context.store.getIdea(longer.idea.id)?.state).toBe("building");
  });

  it("frees an idea left \"building\" by a build that was cut off, through the state machine, and builds it again", async () => {
    // 61 minutes after it began: past the 45-minute limit and the 15 minutes on top.
    const t = setUp({ state: "building", now: at(13 * 60 + 1) });
    const before = t.context.store.ideaEvents(t.idea.id).length;
    expect(await t.run()).toBe(0);
    // Recorded as a failed build first, like the nightly run does, then built the ordinary way.
    const states = t.context.store.ideaEvents(t.idea.id).slice(before).map((event) => `${event.fromState} -> ${event.toState}`);
    expect(states).toEqual(["building -> build_failed", "build_failed -> building", "building -> built", "built -> published", "published -> delivered"]);
    expect(t.buildLog.lines[0]).toMatchObject({ level: "warn", message: "overnight build-now: a build was found interrupted and marked failed", ideaId: t.idea.id });
    expect(t.out.lines.slice(0, 2)).toEqual([`Idea ${t.idea.id}: Whose turn to pay`, "  An earlier build of this idea was cut off. It is recorded as failed, and the build is tried again now."]);
    expect(t.out.lines.at(-1)).toBe(`Link: ${LINK}`);
    // The build lock is taken for the look (nobody else may be building), let go, and taken again to build.
    expect(t.order.slice(0, 5)).toEqual(["lock build.lock", "release build.lock", "lock build.lock", "load builder", `buildOne ${t.idea.id}`]);
    expect(BUILD_CUT_OFF_REASON).toBe("the build was interrupted");
  });

  it("frees nothing while a build is running on this data folder, however old the idea's build looks", async () => {
    // A Mac that slept through a build wakes with an old "building" idea and a build that is still alive.
    const t = setUp({ state: "building", now: at(5 * 3600), held: ["build.lock"] });
    expect(await t.run()).toBe(1);
    expect(t.context.store.getIdea(t.idea.id)?.state).toBe("building");
    // No time to wait for is named: it has passed. What is in the way is the build that is running.
    expect(t.err.lines).toEqual(['Not started: this idea is marked as being built right now (state "building"). A build is running on this data folder (the nightly build, or another build-now). Try again when it has finished.']);
    expect(t.buildLog.lines).toEqual([]);

    // The same when the lock cannot even be looked at.
    const broken = setUp({ state: "building", now: at(5 * 3600) });
    broken.deps.takeLock = () => {
      throw new Error("made-up: the lock file cannot be used");
    };
    expect(await broken.run()).toBe(1);
    expect(broken.context.store.getIdea(broken.idea.id)?.state).toBe("building");

    // And a build that finished in the moment before the lock was free is taken as finished.
    const justDone = setUp({ state: "building", now: at(5 * 3600), build: fakeBuild(), deliver: fakeDeliver() });
    const take = justDone.deps.takeLock;
    let first = true;
    justDone.deps.takeLock = (file) => {
      if (first) justDone.context.store.transitionIdea(justDone.idea.id, "built", { builtAt: at(0) }, at(0));
      first = false;
      return take(file);
    };
    expect(await justDone.run()).toBe(0);
    expect(justDone.context.store.ideaEvents(justDone.idea.id).map((event) => event.toState)).not.toContain("build_failed");
    expect(justDone.out.lines[1]).toBe('1. Build: skipped, it is already built (state "built").');
  });

  it("records why on an idea it frees, and leaves every other idea alone", async () => {
    // The builder turns this build away, so the idea stays where the clean-up put it.
    const t = setUp({ state: "building", now: at(2 * 3600), build: fakeBuild({ one: () => ({ ok: false, backend: "kiro-crew", ms: 0, reason: "made-up: turned away", couldNotStart: true }) }) });
    const other = moveIdea(t.context.store, addIdea(t.context.store, SAMPLE_IDEAS.plants, at(-7200)), ["asked", "approved", "building"], at(-7100));
    expect(await t.run()).toBe(1);
    expect(t.context.store.getIdea(t.idea.id)).toMatchObject({ state: "build_failed", failureReason: "the build was interrupted", note: "the build was interrupted" });
    // Only the idea named: the other old "building" one is the nightly run's to clean up.
    expect(t.context.store.getIdea(other.id)?.state).toBe("building");
  });

  it("agrees with the nightly build's own clean-up on when a build counts as cut off, to the millisecond, and on the reason recorded", async () => {
    // The real rule from @overnight/builder (nothing is built: it only reads and marks ideas).
    // "building" since 11:12; the limit is 45 + 15 minutes, so 12:12:00.000 is the last moment it is left alone.
    for (const [seconds, cutOff] of [[11 * 60, false], [12 * 60, false], [12 * 60 + 0.001, true], [3600, true]] as const) {
      const nightly = setUp({ state: "building" });
      const moved = failInterruptedBuilds({ store: nightly.context.store, config: nightly.context.config, logger: nightly.buildLog.logger }, new Date(at(seconds)));
      expect(moved, String(seconds)).toEqual(cutOff ? [nightly.idea.id] : []);

      const here = setUp({ state: "building", now: at(seconds), build: fakeBuild({ one: () => ({ ok: false, backend: "kiro-crew", ms: 0, reason: "made-up: turned away", couldNotStart: true }) }) });
      await here.run();
      expect(here.context.store.getIdea(here.idea.id)?.state, String(seconds)).toBe(cutOff ? "build_failed" : "building");
      if (cutOff) expect(here.context.store.getIdea(here.idea.id)?.failureReason).toBe(nightly.context.store.getIdea(nightly.idea.id)?.failureReason);
    }
    expect(BUILD_CUT_OFF_REASON).toBe(INTERRUPTED_REASON);
  });

  it("records a cut-off build with core's own reason, so core's rule gives it its second try", async () => {
    // The reason is core's constant, not a copy of its words: core's rule goes by the exact text.
    expect(BUILD_CUT_OFF_REASON).toBe(BUILD_INTERRUPTED_REASON);
    const t = setUp({ state: "building", now: at(2 * 3600), build: fakeBuild({ one: () => ({ ok: false, backend: "kiro-crew", ms: 0, reason: "made-up: turned away", couldNotStart: true }) }) });
    expect(await t.run()).toBe(1);
    const freed = t.context.store.getIdea(t.idea.id) as Idea;
    expect(freed).toMatchObject({ state: "build_failed", failureReason: BUILD_INTERRUPTED_REASON });
    // One start so far, nobody told: the nightly build takes it once more.
    expect(t.context.store.countBuildStarts(t.idea.id)).toBe(1);
    expect(isBuildAwaitingRetry(freed, t.context.store.countBuildStarts(t.idea.id))).toBe(true);
  });

  it("does not free anything while paused, or for an idea in any other state", async () => {
    const paused = setUp({ state: "building", now: at(2 * 3600) });
    paused.context.store.setPaused(true, at(0));
    expect(await paused.run()).toBe(1);
    expect(paused.err.lines).toEqual([BUILD_NOW_PAUSED]);
    expect(paused.context.store.getIdea(paused.idea.id)?.state).toBe("building");

    for (const state of ["asked", "approved", "built", "delivered"] as const) {
      const t = setUp({ state, now: at(24 * 3600), build: fakeBuild(), deliver: fakeDeliver() });
      await t.run();
      expect(t.context.store.ideaEvents(t.idea.id).map((event) => event.toState), state).not.toContain("build_failed");
    }
  });

  it("tries a failed build again", async () => {
    const t = setUp({ state: "build_failed" });
    expect(await t.run()).toBe(0);
    expect(t.order).toContain(`buildOne ${t.idea.id}`);
    expect(t.out.lines.at(-1)).toBe(`Link: ${LINK}`);
  });

  it("skips the build for an idea that is already built, and goes straight to delivering", async () => {
    for (const state of ["built", "publish_failed", "published"] as const) {
      const t = setUp({ state, deliver: fakeDeliver({ one: () => ({ ok: true, url: LINK }) }) });
      expect(await t.run(), state).toBe(0);
      expect(t.order, state).toEqual(["lock deliver.lock", "load deliver", "create bee", `deliverOne ${t.idea.id}`, "dispose bee", "release deliver.lock"]);
      expect(t.out.lines[1], state).toBe(`1. Build: skipped, it is already built (state "${state}").`);
      expect(t.build.loads, state).toBe(0);
    }
  });

  it("only prints the link again for an idea that is already delivered", async () => {
    const t = setUp({ state: "delivered" });
    t.context.store.updateIdea(t.idea.id, { publishedUrl: LINK }, at(1));
    expect(await t.run()).toBe(0);
    expect(t.out.lines).toEqual([`Already delivered: ${LINK}`]);
    expect(t.order).toEqual([]);
  });

  it("stops after a failed build: nothing is published, and the reason is shown on one line", async () => {
    const reason = "the app did not build:\nnpm run build failed three times";
    const t = setUp();
    // Like the real builder: the idea is moved to "building", then to "build_failed" with the reason.
    const build = fakeBuild({
      one: (ideaId) => {
        t.context.store.transitionIdea(ideaId, "building", { slug: "whose-turn-to-pay" }, at(0));
        t.context.store.transitionIdea(ideaId, "build_failed", { failureReason: reason }, at(60));
        return { ok: false, backend: "kiro-cli", ms: 60_000, reason, couldNotStart: false };
      },
    });
    build.order = t.order;
    t.deps.loadBuildFactories = build.load;
    expect(await t.run()).toBe(1);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "release build.lock"]);
    expect(t.deliver.loads).toBe(0);
    expect(t.err.lines).toEqual(["  The build failed: the app did not build: npm run build failed three times", "  Nothing was published. The reason is saved on the idea: npx overnight ideas --all"]);
    expect(t.out.lines.at(-1)).toBe("1. Build: starting with kiro-crew (kiro-cli if that fails). This can take up to 45 minutes each.");
  });

  it("says so when the builder turns the build away before it begins, and the idea is left as it was", async () => {
    const build = fakeBuild({ one: () => ({ ok: false, backend: "kiro-crew", ms: 0, reason: "the build stopped on an unexpected error", couldNotStart: true }) });
    const t = setUp({ build });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(["  The build did not start: the build stopped on an unexpected error", "  Nothing was built or published, and the idea is as it was."]);
    expect(t.context.store.getIdea(t.idea.id)?.state).toBe("approved");
    expect(t.deliver.loads).toBe(0);
  });

  it("exits 1 with the reason when the build passes but the app is not delivered", async () => {
    const t = setUp({ deliver: fakeDeliver({ one: () => ({ ok: false, reason: "the smoke test failed in the browser" }) }) });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual(["  Not delivered: the smoke test failed in the browser"]);
    expect(t.out.text()).not.toContain("Link:");
    expect(t.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
  });

  it("reads the link from the idea when the deliver step does not hand one back", async () => {
    const t = setUp({ state: "built" });
    t.deps.loadDeliverFactories = fakeDeliver({
      order: t.order,
      one: (ideaId) => {
        t.context.store.transitionIdea(ideaId, "published", { publishedUrl: LINK }, at(5));
        return { ok: true };
      },
    }).load;
    expect(await t.run()).toBe(0);
    expect(t.out.lines.slice(-2)).toEqual(['  Done: the idea is now "published".', `Link: ${LINK}`]);
  });

  it("does not build while another build is running", async () => {
    const t = setUp({ held: ["build.lock"] });
    expect(await t.run()).toBe(1);
    expect(t.err.lines).toEqual([BUILD_NOW_BUILD_BUSY]);
    expect(t.order).toEqual([]);
    expect(t.context.store.getIdea(t.idea.id)?.state).toBe("approved");
  });

  it("builds but does not deliver while another deliver is running, and says how to finish", async () => {
    const t = setUp({ held: ["deliver.lock"] });
    expect(await t.run()).toBe(1);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "release build.lock"]);
    expect(t.err.lines).toEqual([BUILD_NOW_DELIVER_BUSY]);
    // The idea is built and waiting: the same command again goes straight to delivering.
    expect(t.context.store.getIdea(t.idea.id)?.state).toBe("built");
  });

  it("lets go of each lock when a step throws or never ends", async () => {
    const threw = setUp({
      build: fakeBuild({
        one: () => {
          throw new Error("the made-up builder fell over\n    at somewhere");
        },
      }),
    });
    expect(await threw.run()).toBe(1);
    expect(threw.err.lines).toEqual(["  The build could not be run. the made-up builder fell over"]);
    expect(threw.order.at(-1)).toBe("release build.lock");
    expect(threw.buildLog.lines.at(-1)).toMatchObject({ level: "error", ideaId: threw.idea.id, reason: "the made-up builder fell over" });

    const hung = setUp({ build: fakeBuild({ one: () => never() }), buildLimitMs: 20 });
    expect(await hung.run()).toBe(1);
    expect(hung.err.lines).toEqual(["  The build could not be run. The build was still going after 0 minutes, which is past its time limit."]);
    expect(hung.order.at(-1)).toBe("release build.lock");

    const stuck = setUp({ state: "built", deliver: fakeDeliver({ one: () => never() }), deliverLimitMs: 20 });
    expect(await stuck.run()).toBe(1);
    expect(stuck.err.lines).toEqual(["  Checking and publishing could not be run. Checking and publishing was still going after 0 minutes, which is past its time limit."]);
    expect(stuck.order.slice(-2)).toEqual(["dispose bee", "release deliver.lock"]);
  });

  /** A builder and a deliver step that keep their promise: at a stop they come back at once. */
  const stoppableBuild = (store: Store) =>
    fakeBuild({
      one: async (ideaId, deps) => {
        store.transitionIdea(ideaId, "building", { slug: "whose-turn-to-pay", buildStartedAt: at(0) }, at(0));
        await aborted(deps.signal);
        // What the real builder records for a build it had to cut off.
        store.transitionIdea(ideaId, "build_failed", { failureReason: "the build was interrupted" }, at(5));
        return { ok: false, backend: "kiro-crew", ms: 5_000, reason: "the build was interrupted", couldNotStart: false };
      },
    });

  it("on a stop signal during the build: tells the builder, waits for it, lets go of the lock, delivers nothing, and exits with the signal's code", async () => {
    const t = setUp();
    const build = stoppableBuild(t.context.store);
    build.order = t.order;
    t.deps.loadBuildFactories = build.load;
    const running = t.run();
    await expect.poll(() => build.oneCalls.length).toBe(1);
    expect(build.oneCalls[0]?.deps.signal?.aborted).toBe(false);
    t.stop.send("SIGINT");
    expect(await running).toBe(130);
    expect(build.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "release build.lock"]);
    expect(t.deliver.loads).toBe(0);
    expect(t.err.lines).toEqual(["  Stopping: told to stop. Ending what is running first.", '  Stopped. The idea is now "build_failed".']);
    // One line, in the log of the step that was running.
    expect(t.buildLog.lines.filter((line) => line.message.includes("stop signal"))).toMatchObject([{ level: "warn", message: "overnight build-now: stop signal received: stopping what is running, then ending", ideaId: t.idea.id, signal: "SIGINT" }]);
    expect(t.deliverLog.lines).toEqual([]);
    expect(t.stop.handlers()).toBe(0);
    expect(t.out.text()).not.toContain("Link:");
  });

  it("on a stop signal during the deliver step: tells it, waits for it, stops the gateway, lets go of the lock, and exits with the signal's code", async () => {
    const deliver = fakeDeliver({ one: async (_ideaId, deps) => (await aborted(deps.signal), { ok: false, reason: "made-up: stopped half way" }) });
    const t = setUp({ state: "built", deliver });
    const running = t.run();
    await expect.poll(() => deliver.oneCalls.length).toBe(1);
    expect(deliver.oneCalls[0]?.deps.signal?.aborted).toBe(false);
    t.stop.send("SIGTERM");
    expect(await running).toBe(143);
    expect(deliver.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", `deliverOne ${t.idea.id}`, "dispose bee", "release deliver.lock"]);
    expect(t.err.lines).toEqual(["  Stopping: told to stop. Ending what is running first.", '  Stopped. The idea is now "built".']);
    expect(t.deliverLog.lines.filter((line) => line.message.includes("stop signal"))).toMatchObject([{ level: "warn", signal: "SIGTERM", ideaId: t.idea.id }]);
    expect(t.buildLog.lines).toEqual([]);
    expect(t.stop.handlers()).toBe(0);
  });

  it("uses one signal for both steps, and takes its handlers off again when it is done", async () => {
    const t = setUp({ build: fakeBuild(), deliver: fakeDeliver() });
    expect(await t.run()).toBe(0);
    const signal = t.build.oneCalls[0]?.deps.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(t.deliver.oneCalls[0]?.deps.signal).toBe(signal);
    expect(signal?.aborted).toBe(false);
    expect(t.stop.handlers()).toBe(0);
    // A command that stops before either step never watched at all.
    const refused = setUp({ state: "asked" });
    await refused.run();
    expect(refused.stop.handlers()).toBe(0);
  });

  it("ends at once on a second signal, and gives up on a step that does not come back after the first", async () => {
    const t = setUp({ build: fakeBuild({ one: () => never() }), stopWaitMs: 30 });
    const running = t.run();
    await expect.poll(() => t.build.oneCalls.length).toBe(1);
    t.stop.send("SIGTERM");
    expect(t.stop.exits).toEqual([]);
    t.stop.send("SIGINT");
    expect(t.stop.exits).toEqual([130]);
    // (In the test nothing really ends the process, so the command runs out its wait.)
    expect(await running).toBe(143);
    expect(t.order.at(-1)).toBe("release build.lock");
    expect(t.buildLog.lines.at(-1)).toMatchObject({ level: "error", message: "overnight build-now: the builder did not stop in time after the stop signal; ending anyway" });
    expect(t.deliver.loads).toBe(0);
  });

  it("tells a step to stop when it runs past its last-resort limit", async () => {
    const hung = setUp({ build: fakeBuild({ one: () => never() }), buildLimitMs: 20 });
    expect(await hung.run()).toBe(1);
    expect(hung.build.oneCalls[0]?.deps.signal?.aborted).toBe(true);
  });
});

describe("overnight build-now: a page not seen live, a hold on the Mac's sleep, and a Mac that slept", () => {
  /** A build that only ends when it is told to stop, and then records what the real builder records. */
  const stoppableBuild = (store: Store) =>
    fakeBuild({
      one: async (ideaId, deps) => {
        store.transitionIdea(ideaId, "building", { buildBackend: "kiro-crew", buildStartedAt: at(0) }, at(0));
        await aborted(deps.signal);
        store.transitionIdea(ideaId, "build_failed", { failureReason: "the build was stopped" }, at(5));
        return { ok: false, backend: "kiro-crew", ms: 5_000, reason: "the build was stopped", couldNotStart: false };
      },
    });

  it("says, after the link, when the page was pushed but not seen live before the wait for it ran out", async () => {
    const t = setUp();
    const deliver = fakeDeliver({
      order: t.order,
      one: (ideaId) => {
        t.context.store.transitionIdea(ideaId, "published", { publishedUrl: LINK, publishedAt: at(200) }, at(200));
        t.context.store.transitionIdea(ideaId, "delivered", { deliveredAt: at(210), morningTodoId: 4242 }, at(210));
        return { ok: true, url: LINK, notSeenLive: true };
      },
    });
    t.deps.loadDeliverFactories = deliver.load;
    expect(await t.run()).toBe(0);
    expect(t.out.lines.slice(-3)).toEqual(['  Done: the idea is now "delivered".', `Link: ${LINK}`, "The page was not seen live before Overnight stopped waiting for it. It usually appears a few minutes later."]);
    expect(BUILD_NOW_NOT_SEEN_LIVE).toBe("The page was not seen live before Overnight stopped waiting for it. It usually appears a few minutes later.");
    // The usual run says no such thing.
    const usual = setUp();
    await usual.run();
    expect(usual.out.lines.at(-1)).toBe(`Link: ${LINK}`);
  });

  it("holds the Mac awake once for the whole command, from before the first lock until after the last one is let go", async () => {
    const t = setUp({ keepAwake: true });
    expect(await t.run()).toBe(0);
    expect(t.order[0]).toBe("keep awake");
    expect(t.order.at(-1)).toBe("let sleep");
    expect(t.order.filter((step) => step === "keep awake")).toHaveLength(1);
    expect(t.order.slice(1, -1)).toEqual([
      "lock build.lock",
      "load builder",
      `buildOne ${t.idea.id}`,
      "release build.lock",
      "lock deliver.lock",
      "load deliver",
      "create bee",
      `deliverOne ${t.idea.id}`,
      "dispose bee",
      "release deliver.lock",
    ]);
    // Its one line goes to the log of the step the command begins with.
    expect(t.awake.loggers).toEqual([t.buildLog.logger]);
    const alreadyBuilt = setUp({ state: "built", keepAwake: true });
    await alreadyBuilt.run();
    expect(alreadyBuilt.awake.loggers).toEqual([alreadyBuilt.deliverLog.logger]);
  });

  it("lets go of the hold however the command ends, and never takes one for a command that does nothing", async () => {
    const failed = setUp({ keepAwake: true, build: fakeBuild({ one: () => ({ ok: false, reason: "made-up: no good" }) }) });
    expect(await failed.run()).toBe(1);
    const busy = setUp({ keepAwake: true, held: ["build.lock"] });
    expect(await busy.run()).toBe(1);
    const threw = setUp({
      keepAwake: true,
      build: fakeBuild({
        one: () => {
          throw new Error("the made-up builder fell over");
        },
      }),
    });
    expect(await threw.run()).toBe(1);
    const stopped = setUp({ keepAwake: true, build: fakeBuild({ one: () => never() }), stopWaitMs: 30 });
    const running = stopped.run();
    await expect.poll(() => stopped.build.oneCalls.length).toBe(1);
    stopped.stop.send("SIGTERM");
    expect(await running).toBe(143);
    for (const t of [failed, busy, threw, stopped]) {
      expect(t.order.filter((step) => step === "keep awake")).toHaveLength(1);
      expect(t.order.at(-1)).toBe("let sleep");
      expect(t.awake.held()).toBe(0);
      expect(t.sleep.watching()).toBe(0);
    }

    // Paused, an idea that was never approved, one already delivered: nothing runs, so nothing is held or watched.
    const paused = setUp({ keepAwake: true, env: { PAUSED: "true" } });
    await paused.run();
    const notApproved = setUp({ keepAwake: true, state: "asked" });
    await notApproved.run();
    const done = setUp({ keepAwake: true, state: "delivered" });
    await done.run();
    for (const t of [paused, notApproved, done]) {
      expect(t.order).toEqual([]);
      expect(t.sleep.started()).toBe(0);
    }
    // And a hold that will not let go does not get in the way of ending.
    const stuck = setUp();
    stuck.deps.keepAwake = () => ({
      stop: () => {
        throw new Error("made-up: the hold would not let go");
      },
    });
    expect(await stuck.run()).toBe(0);
  });

  it("when the Mac slept during the build: the builder is told to stop, nothing is delivered, and the same command carries on later", async () => {
    const t = setUp();
    const build = stoppableBuild(t.context.store);
    build.order = t.order;
    t.deps.loadBuildFactories = build.load;
    const running = t.run();
    await expect.poll(() => build.oneCalls.length).toBe(1);
    expect(build.oneCalls[0]?.deps.signal?.aborted).toBe(false);
    t.sleep.fire(1_800_000);
    expect(build.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    // Not delivered, so not 0. It was not a signal, so not a signal's code either.
    expect(await running).toBe(1);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "release build.lock"]);
    expect(t.deliver.loads).toBe(0);
    expect(t.err.lines).toEqual([
      "  Stopping: the Mac went to sleep during the run. Ending what is running first.",
      '  Stopped, because the Mac went to sleep during the run. The idea is now "build_failed". Run the same command again to carry on.',
    ]);
    expect(t.buildLog.lines.filter((line) => line.level === "warn")).toMatchObject([{ message: sleptLine("byHand"), ideaId: t.idea.id, gapSeconds: 1800 }]);
    expect(sleptLine("byHand")).toBe("the Mac went to sleep during the run; what was in progress was stopped. Running the same command again carries on from there");
    expect(t.deliverLog.lines).toEqual([]);
    expect(t.out.text()).not.toContain("Link:");
    expect(t.stop.handlers()).toBe(0);
    expect(t.stop.exits).toEqual([]);
    expect(t.sleep.watching()).toBe(0);
  });

  it("when the Mac slept during the deliver step: it is told to stop, the gateway is stopped, and the idea stays where it was", async () => {
    const deliver = fakeDeliver({ one: async (_ideaId, deps) => (await aborted(deps.signal), { ok: false, reason: "made-up: stopped half way", stopped: true }) });
    const t = setUp({ state: "built", deliver });
    const running = t.run();
    await expect.poll(() => deliver.oneCalls.length).toBe(1);
    t.sleep.fire();
    expect(await running).toBe(1);
    expect(deliver.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", `deliverOne ${t.idea.id}`, "dispose bee", "release deliver.lock"]);
    expect(t.err.lines).toEqual([
      "  Stopping: the Mac went to sleep during the run. Ending what is running first.",
      '  Stopped, because the Mac went to sleep during the run. The idea is now "built". Run the same command again to carry on.',
    ]);
    // The line is in the log of the step that was running.
    expect(t.deliverLog.lines.filter((line) => line.level === "warn")).toMatchObject([{ message: sleptLine("byHand"), ideaId: t.idea.id, gapSeconds: 7200 }]);
    expect(t.buildLog.lines).toEqual([]);
  });

  it("when the sleep is noticed while a step is still loading, starts nothing; and gives up on a step that does not come back after it", async () => {
    const loading = setUp();
    const load = loading.deps.loadBuildFactories;
    loading.deps.loadBuildFactories = async () => {
      loading.sleep.fire();
      return load();
    };
    expect(await loading.run()).toBe(1);
    expect(loading.build.oneCalls).toEqual([]);
    expect(loading.order).toEqual(["lock build.lock", "load builder", "release build.lock"]);
    expect(loading.err.lines.at(-1)).toBe('  Stopped, because the Mac went to sleep during the run. The idea is now "approved". Run the same command again to carry on.');

    const hung = setUp({ build: fakeBuild({ one: () => never() }), stopWaitMs: 30 });
    const running = hung.run();
    await expect.poll(() => hung.build.oneCalls.length).toBe(1);
    hung.sleep.fire();
    expect(await running).toBe(1);
    expect(hung.order.at(-1)).toBe("release build.lock");
    expect(hung.buildLog.lines.at(-1)).toMatchObject({ level: "error", message: "overnight build-now: the builder did not stop in time after it was told to stop; ending anyway" });
    expect(hung.deliver.loads).toBe(0);
  });

  // A sleep that outlasts a step's own last-resort limit: on waking, the sleep watch and the limit
  // come due in the same instant, and the step still needs its few seconds to stop.
  describe("when the sleep outlasted a step's last-resort limit", () => {
    const LIMIT_MS = 20;
    const longerThanTheLimit = () => new Promise((resolve) => setTimeout(resolve, LIMIT_MS + 60));

    it("waits for the builder, which gets to record where the build stood: no \"could not be run\", and the command carries on later", async () => {
      for (const order of ["the watch's timer first", "the limit's timer first"] as const) {
        const woke = { now: () => {} };
        const t = setUp({ buildLimitMs: LIMIT_MS });
        const build = fakeBuild({
          order: t.order,
          one: async (ideaId, deps) => {
            t.context.store.transitionIdea(ideaId, "building", { buildBackend: "kiro-crew", buildStartedAt: at(0) }, at(0));
            woke.now();
            await aborted(deps.signal);
            await longerThanTheLimit();
            // What the real builder writes once its Kiro Crew job is cancelled. It needs the database open.
            t.context.store.transitionIdea(ideaId, "build_failed", { failureReason: "the build was stopped" }, at(5));
            t.order.push("builder came back");
            return { ok: false, backend: "kiro-crew", ms: 5_000, reason: "the build was stopped", couldNotStart: false };
          },
        });
        t.deps.loadBuildFactories = build.load;
        woke.now = order === "the watch's timer first" ? () => t.sleep.fire() : () => t.sleep.sleepUnnoticed();
        expect(await t.run(), order).toBe(1);
        expect(t.order, order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "builder came back", "release build.lock"]);
        expect(t.err.lines, order).toEqual([
          "  Stopping: the Mac went to sleep during the run. Ending what is running first.",
          '  Stopped, because the Mac went to sleep during the run. The idea is now "build_failed". Run the same command again to carry on.',
        ]);
        expect(t.buildLog.text(), order).not.toContain("past its time limit");
        expect(t.buildLog.lines.filter((line) => line.level === "error"), order).toEqual([]);
        expect(t.deliver.loads, order).toBe(0);
      }
    });

    it("waits for the deliver step the same way, and the idea stays where it was", async () => {
      for (const order of ["the watch's timer first", "the limit's timer first"] as const) {
        const woke = { now: () => {} };
        const steps: string[] = [];
        const deliver = fakeDeliver({
          one: async (_ideaId, deps) => {
            woke.now();
            await aborted(deps.signal);
            await longerThanTheLimit();
            steps.push("deliver step came back");
            return { ok: false, reason: "made-up: stopped half way", stopped: true };
          },
        });
        const t = setUp({ state: "built", deliver, deliverLimitMs: LIMIT_MS });
        woke.now = order === "the watch's timer first" ? () => t.sleep.fire() : () => t.sleep.sleepUnnoticed();
        expect(await t.run(), order).toBe(1);
        expect(steps, order).toEqual(["deliver step came back"]);
        expect(t.order.slice(-2), order).toEqual(["dispose bee", "release deliver.lock"]);
        expect(t.err.lines, order).toEqual([
          "  Stopping: the Mac went to sleep during the run. Ending what is running first.",
          '  Stopped, because the Mac went to sleep during the run. The idea is now "built". Run the same command again to carry on.',
        ]);
        expect(t.deliverLog.text(), order).not.toContain("past its time limit");
      }
    });

    it("waits the same way when a step's limit passes while it is stopping after a stop signal: the signal's code, and no \"could not be run\"", async () => {
      const told = { now: () => {} };
      const t = setUp({ buildLimitMs: LIMIT_MS });
      const build = fakeBuild({
        order: t.order,
        one: async (ideaId, deps) => {
          t.context.store.transitionIdea(ideaId, "building", { buildBackend: "kiro-crew", buildStartedAt: at(0) }, at(0));
          told.now();
          await aborted(deps.signal);
          await longerThanTheLimit();
          t.context.store.transitionIdea(ideaId, "build_failed", { failureReason: "the build was stopped" }, at(5));
          t.order.push("builder came back");
          return { ok: false, backend: "kiro-crew", ms: 5_000, reason: "the build was stopped", couldNotStart: false };
        },
      });
      t.deps.loadBuildFactories = build.load;
      told.now = () => t.stop.send("SIGINT");
      expect(await t.run()).toBe(130);
      expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "builder came back", "release build.lock"]);
      expect(t.err.lines).toEqual(["  Stopping: told to stop. Ending what is running first.", '  Stopped. The idea is now "build_failed".']);
      expect(t.buildLog.text()).not.toContain("past its time limit");
    });

    it("a limit that passes with no sleep and no stop signal is still the last resort for each step", async () => {
      const hung = setUp({ build: fakeBuild({ one: () => never() }), buildLimitMs: LIMIT_MS });
      expect(await hung.run()).toBe(1);
      expect(hung.sleep.looks()).toBe(1);
      expect(hung.err.lines.at(-1)).toBe("  The build could not be run. The build was still going after 0 minutes, which is past its time limit.");
      const stuck = setUp({ state: "built", deliver: fakeDeliver({ one: () => never() }), deliverLimitMs: LIMIT_MS });
      expect(await stuck.run()).toBe(1);
      expect(stuck.sleep.looks()).toBe(1);
      expect(stuck.err.lines.at(-1)).toBe("  Checking and publishing could not be run. Checking and publishing was still going after 0 minutes, which is past its time limit.");
    });
  });
});

describe("overnight build-now and an error nobody caught", () => {
  it("during the build: one error line in the build log, the builder told to stop, the build lock let go, exit 1", async () => {
    const build = fakeBuild({ one: async (_id, deps) => (await aborted(deps.signal), { ok: false, backend: "kiro-crew", ms: 5, reason: "the build was stopped", couldNotStart: false }) });
    const t = setUp({ build });
    const running = t.run();
    await expect.poll(() => t.build.oneCalls.length).toBe(1);
    expect(t.lastResort.handlers()).toBe(2);

    t.lastResort.send("uncaughtException", new Error("made-up secret: a pitch"));

    expect(t.lastResort.exits).toEqual([1]);
    expect(t.build.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    expect(t.order).toEqual(["lock build.lock", "load builder", `buildOne ${t.idea.id}`, "release build.lock"]);
    expect(t.buildLog.lines.filter((line) => line.level === "error")).toMatchObject([{ message: `overnight build-now: ${LAST_RESORT_LINE}`, kind: "uncaughtException", error: "Error" }]);
    expect(t.deliverLog.lines).toEqual([]);
    expect(t.buildLog.text() + t.err.text() + t.out.text()).not.toContain("made-up secret");
    await running;
    expect(t.lastResort.handlers()).toBe(0);
  });

  it("during the deliver step: the line goes to the deliver log, the bee program is stopped and the deliver lock let go, exit 1", async () => {
    const order: string[] = [];
    const deliver = fakeDeliver({ order, one: async (_id, deps) => (await aborted(deps.signal), { ok: false, reason: "made-up: stopped", stopped: true }) });
    const t = setUp({ state: "built", deliver });
    const running = t.run();
    await expect.poll(() => t.deliver.oneCalls.length).toBe(1);

    t.lastResort.send("unhandledRejection", new Error("made-up secret: a link"));

    expect(t.lastResort.exits).toEqual([1]);
    expect(t.deliver.oneCalls[0]?.deps.signal?.aborted).toBe(true);
    // The build lock was never taken (the idea was built already), so only the deliver step's things are let go.
    expect(t.order).toEqual(["lock deliver.lock", "load deliver", "create bee", `deliverOne ${t.idea.id}`, "dispose bee", "release deliver.lock"]);
    expect(t.deliverLog.lines.filter((line) => line.level === "error")).toMatchObject([{ message: `overnight build-now: ${LAST_RESORT_LINE}`, kind: "unhandledRejection" }]);
    expect(t.buildLog.lines.filter((line) => line.level === "error")).toEqual([]);
    await running;
    expect(t.lastResort.handlers()).toBe(0);
  });

  it("holds nothing between the two steps and after the last one, and takes its handlers off when it is done", async () => {
    const t = setUp();
    expect(await t.run()).toBe(0);
    expect(t.lastResort.handlers()).toBe(0);
    expect(t.lastResort.exits).toEqual([]);
    // Each lock was released by its own step, once.
    expect(t.order.filter((step) => step.startsWith("release"))).toEqual(["release build.lock", "release deliver.lock"]);
  });
});
