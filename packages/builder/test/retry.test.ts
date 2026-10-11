// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// One more try for a build that was cut short. A build that was stopped (Overnight was told to
// stop) or found cut off afterwards (a crash, a restart) is built again by a later nightly run,
// once. The rule itself is core's (isBuildAwaitingRetry); these tests are about the night flow
// that follows it: who is on the night's list, in what order, and who is left alone.
import { isBuildAwaitingRetry, MAX_BUILD_STARTS } from "@overnight/core";
import type { Store } from "@overnight/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildOne, INTERRUPTED_REASON, runBuildNight, SKIPPED_NOTHING_APPROVED, SKIPPED_PAUSED, SKIPPED_STOPPED, STOPPED_REASON } from "../src/index.ts";
import type { BuildDeps, BuildJob, BuildOptions, BuildOutcome } from "../src/index.ts";
import { waitingOldestFirst } from "../src/night.ts";
import { approvedIdea, collectingLogger, fakeBackend, memoryStore, MINUTE, movableClock, T0, testConfig, testPaths } from "./helpers.ts";
import type { FakeBackend } from "./helpers.ts";

const DAY = 24 * 60 * MINUTE;
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

type Answer = "built" | "failed" | "stop";

/**
 * A night flow whose primary backend follows a script, one entry per build it is handed: build
 * the app, fail, or be cut off because Overnight is told to stop at that moment. No fallback
 * builder unless one is given, so a failure is a failure.
 */
function makeRig(script: Answer[], options: { config?: Record<string, string>; fallback?: FakeBackend } = {}) {
  const paths = testPaths();
  const store = memoryStore();
  stores.push(store);
  const config = testConfig(paths.root, options.config);
  const clock = movableClock(T0);
  const { logger, lines } = collectingLogger();
  let stop = new AbortController();
  const built = fakeBackend("kiro-crew", ["built"]);
  const failing = fakeBackend("kiro-crew", ["failed"]);
  let call = 0;
  const primary = fakeBackend("kiro-crew", [
    (job: BuildJob, buildOptions: BuildOptions): Promise<BuildOutcome> | BuildOutcome => {
      const answer = script[Math.min(call, script.length - 1)] ?? "built";
      call += 1;
      if (answer === "built") return built.build(job, buildOptions);
      if (answer === "failed") return failing.build(job, buildOptions);
      stop.abort();
      return { ok: false, backend: "kiro-crew", ms: 5, reason: "made-up reason from a backend on its way down", couldNotStart: false };
    },
  ]);
  const deps: BuildDeps = { store, config, paths, backends: { primary, fallback: options.fallback ?? null }, logger, now: clock.now, signal: stop.signal };
  return {
    store,
    clock,
    primary,
    lines,
    deps,
    /** The next night, at build time, with a stop signal that has not been used. */
    nextNight() {
      clock.advance(DAY);
      stop = new AbortController();
      deps.signal = stop.signal;
    },
    retryLines: () => lines.filter((line) => line.includes("trying a build again")),
  };
}

describe("a build that was stopped is tried once more on a later night", () => {
  it("stopped once, then built the next night", async () => {
    const rig = makeRig(["stop", "built"]);
    const idea = approvedIdea(rig.store, { title: "Coin Flipper" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: SKIPPED_STOPPED });
    const stopped = rig.store.getIdea(idea.id);
    expect(stopped).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON, failureNotifiedAt: null });
    expect(rig.store.countBuildStarts(idea.id)).toBe(1);
    expect(stopped && isBuildAwaitingRetry(stopped, 1)).toBe(true);
    expect(rig.retryLines()).toHaveLength(0);

    rig.nextNight();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null, slug: "coin-flipper" });
    expect(rig.store.countBuildStarts(idea.id)).toBe(2);
    expect(rig.primary.jobs).toHaveLength(2);
    // The second try starts from an empty workspace; the first try's folder is kept beside it.
    expect(rig.primary.seen[1]?.files).toEqual(["brief.md"]);
    expect(rig.store.ideaEvents(idea.id).map((event) => event.toState)).toEqual(["heard", "asked", "approved", "building", "build_failed", "building", "built"]);

    // One line says why a failed idea was built again: ids, a count and our own reason only.
    expect(rig.retryLines()).toHaveLength(1);
    expect(JSON.parse(rig.retryLines()[0] ?? "{}")).toMatchObject({ level: "info", ideaId: idea.id, earlierStarts: 1, earlierReason: "the build was stopped" });
    expect(rig.lines.join("\n")).not.toContain("Coin Flipper");
  });

  it("stopped twice, then left alone", async () => {
    const rig = makeRig(["stop", "stop", "built"]);
    const idea = approvedIdea(rig.store);

    expect((await runBuildNight(rig.deps)).skipped).toBe(SKIPPED_STOPPED);
    rig.nextNight();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: SKIPPED_STOPPED });
    const twice = rig.store.getIdea(idea.id);
    expect(twice).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    expect(rig.store.countBuildStarts(idea.id)).toBe(MAX_BUILD_STARTS);
    expect(twice && isBuildAwaitingRetry(twice, rig.store.countBuildStarts(idea.id))).toBe(false);

    // The third night, and every night after: it is not on the list any more.
    for (let night = 0; night < 3; night += 1) {
      rig.nextNight();
      expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_NOTHING_APPROVED });
    }
    expect(rig.primary.jobs).toHaveLength(2);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    expect(rig.retryLines()).toHaveLength(1);
  });

  it("a build that failed is never tried again by the nightly run", async () => {
    const rig = makeRig(["failed", "built"]);
    const idea = approvedIdea(rig.store);

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: "" });
    const failed = rig.store.getIdea(idea.id);
    expect(failed).toMatchObject({ state: "build_failed", failureReason: "Kiro Crew: the builder reported that the build failed", failureNotifiedAt: null });
    expect(failed && isBuildAwaitingRetry(failed, 1)).toBe(false);

    for (let night = 0; night < 2; night += 1) {
      rig.nextNight();
      expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_NOTHING_APPROVED });
    }
    expect(rig.primary.jobs).toHaveLength(1);
    expect(rig.retryLines()).toHaveLength(0);
  });

  it("a build both builders failed is not tried again either, although the reason is long", async () => {
    const rig = makeRig(["failed"], { fallback: fakeBackend("kiro-cli", ["failed"]) });
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    expect(rig.store.getIdea(idea.id)?.failureReason).toContain("Kiro CLI: ");
    rig.nextNight();
    expect((await runBuildNight(rig.deps)).skipped).toBe(SKIPPED_NOTHING_APPROVED);
    expect(rig.primary.jobs).toHaveLength(1);
  });

  it("an idea the wearer was already told about is never tried again", async () => {
    const rig = makeRig(["stop", "built"]);
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    // The morning step has sent the "couldn't finish" note (say, by an older version, or by hand).
    rig.store.updateIdea(idea.id, { failureNotifiedAt: rig.clock.iso() }, rig.clock.iso());

    rig.nextNight();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_NOTHING_APPROVED });
    expect(rig.primary.jobs).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
  });

  it("is not tried again while Overnight is paused, and is when it is resumed", async () => {
    const rig = makeRig(["stop", "built"]);
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    rig.store.setPaused(true, rig.clock.iso());
    rig.nextNight();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_PAUSED });
    expect(rig.primary.jobs).toHaveLength(1);

    rig.store.setPaused(false, rig.clock.iso());
    rig.nextNight();
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
  });
});

describe("a build found cut off afterwards gets the same one more try", () => {
  it("is failed as interrupted and built again by the run that finds it", async () => {
    const rig = makeRig(["built"]);
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    // Started 61 minutes ago and never finished: past the 45-minute limit plus 15.
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");

    const result = await runBuildNight(rig.deps);
    // Built on its second try: it is not reported as failed as well.
    expect(result).toEqual({ built: [stuck.id], failed: [], skipped: "" });
    expect(rig.store.ideaEvents(stuck.id).map((event) => event.toState)).toEqual(["heard", "asked", "approved", "building", "build_failed", "building", "built"]);
    expect(rig.store.ideaEvents(stuck.id).find((event) => event.toState === "build_failed")?.note).toBe(INTERRUPTED_REASON);
    expect(JSON.parse(rig.retryLines()[0] ?? "{}")).toMatchObject({ ideaId: stuck.id, earlierStarts: 1, earlierReason: "the build was interrupted" });
  });

  it("cut off a second time, it stays failed and is left alone", async () => {
    const rig = makeRig(["built"]);
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-09T07:00:00.000Z" }, "2026-10-09T07:00:00.000Z");
    rig.store.transitionIdea(stuck.id, "build_failed", { failureReason: INTERRUPTED_REASON }, "2026-10-09T09:00:00.000Z");
    // Its second try, last night, was cut off too and is still marked "building".
    rig.store.transitionIdea(stuck.id, "building", { buildStartedAt: "2026-10-10T05:00:00.000Z", failureReason: null }, "2026-10-10T05:00:00.000Z");

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [stuck.id], skipped: SKIPPED_NOTHING_APPROVED });
    expect(rig.store.getIdea(stuck.id)).toMatchObject({ state: "build_failed", failureReason: INTERRUPTED_REASON });
    expect(rig.primary.jobs).toHaveLength(0);
    rig.nextNight();
    expect((await runBuildNight(rig.deps)).skipped).toBe(SKIPPED_NOTHING_APPROVED);
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("when the second try fails too, the idea is listed as failed once", async () => {
    const rig = makeRig(["failed"]);
    const stuck = approvedIdea(rig.store);
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [stuck.id], skipped: "" });
    expect(rig.store.getIdea(stuck.id)?.failureReason).toBe("Kiro Crew: the builder reported that the build failed");
  });
});

describe("the night's list: approved ideas and second tries in one line", () => {
  it("is ordered by when each idea was approved, whichever kind it is", async () => {
    const rig = makeRig(["stop", "built"], { config: { MAX_BUILDS_PER_NIGHT: "5" } });
    const cutShort = approvedIdea(rig.store, { title: "Cut short", approvedAt: "2026-10-09T18:00:00.000Z" });
    await runBuildNight(rig.deps);
    expect(rig.store.getIdea(cutShort.id)?.state).toBe("build_failed");
    // Approved before and after it; and one whose build really failed, which is on no list.
    const older = approvedIdea(rig.store, { title: "Older", approvedAt: "2026-10-09T17:00:00.000Z" });
    const newer = approvedIdea(rig.store, { title: "Newer", approvedAt: "2026-10-09T19:00:00.000Z" });
    const failed = approvedIdea(rig.store, { title: "Failed", approvedAt: "2026-10-09T16:00:00.000Z" });
    rig.store.transitionIdea(failed.id, "building", { slug: "failed", buildStartedAt: rig.clock.iso() }, rig.clock.iso());
    rig.store.transitionIdea(failed.id, "build_failed", { failureReason: "Kiro Crew: the builder reported that the build failed" }, rig.clock.iso());

    expect(waitingOldestFirst(rig.store).map((idea) => idea.id)).toEqual([older.id, cutShort.id, newer.id]);
    rig.nextNight();
    expect((await runBuildNight(rig.deps)).built).toEqual([older.id, cutShort.id, newer.id]);
    expect(rig.primary.jobs.map((job) => job.ideaId)).toEqual([cutShort.id, older.id, cutShort.id, newer.id]);
  });

  it("a second try counts toward the nightly limit like any other start", async () => {
    const rig = makeRig(["stop", "built"]);
    const cutShort = approvedIdea(rig.store, { title: "Cut short", approvedAt: "2026-10-09T17:00:00.000Z" });
    await runBuildNight(rig.deps);
    const b = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    const c = approvedIdea(rig.store, { title: "App C", approvedAt: "2026-10-09T19:00:00.000Z" });

    // The same night (a second run): the first try used one of the two starts, so one is left,
    // and it goes to the oldest approval, which is the second try.
    rig.deps.signal = new AbortController().signal;
    rig.clock.advance(20 * MINUTE);
    const sameNight = await runBuildNight(rig.deps);
    expect(sameNight.built).toEqual([cutShort.id]);
    expect(sameNight.skipped).toBe("2 approved ideas wait for another night (limit 2 a night)");

    rig.nextNight();
    const next = await runBuildNight(rig.deps);
    expect(next.built).toEqual([b.id, c.id]);
    expect(next.skipped).toBe("");
  });

  it("an idea that stopped waiting before its turn came is not built", async () => {
    const rig = makeRig(["stop", "built"], { config: { MAX_BUILDS_PER_NIGHT: "5" } });
    const cutShort = approvedIdea(rig.store, { title: "Cut short", approvedAt: "2026-10-09T18:00:00.000Z" });
    await runBuildNight(rig.deps);
    const older = approvedIdea(rig.store, { title: "Older", approvedAt: "2026-10-09T17:00:00.000Z" });
    rig.nextNight();
    // While the older idea is being built, the wearer is told that the other could not be finished.
    const inner = rig.deps.backends.primary;
    rig.deps.backends.primary = fakeBackend("kiro-crew", [
      (job, buildOptions) => {
        if (job.ideaId === older.id) rig.store.updateIdea(cutShort.id, { failureNotifiedAt: rig.clock.iso() }, rig.clock.iso());
        return inner.build(job, buildOptions);
      },
    ]);

    const result = await runBuildNight(rig.deps);
    expect(result.built).toEqual([older.id]);
    expect(result.failed).toEqual([cutShort.id]);
    expect(rig.store.getIdea(cutShort.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    expect(rig.store.countBuildStarts(cutShort.id)).toBe(1);
    expect(rig.lines.join("\n")).toContain("build not started: the idea is no longer waiting for one");
  });
});

describe("build-now keeps its own rules", () => {
  it("builds a failed idea whatever the reason and however many starts it has had", async () => {
    const rig = makeRig(["stop", "stop", "built", "failed", "built"]);
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    rig.nextNight();
    await runBuildNight(rig.deps);
    expect(rig.store.countBuildStarts(idea.id)).toBe(2);

    // The nightly run has given up on it; a person asking for it by hand has not.
    rig.nextNight();
    expect((await buildOne(idea.id, rig.deps)).ok).toBe(true);
    expect(rig.store.getIdea(idea.id)?.state).toBe("built");
    expect(rig.store.countBuildStarts(idea.id)).toBe(3);

    // And one whose build really failed, which the nightly run never retries.
    const other = approvedIdea(rig.store, { title: "Other" });
    expect((await buildOne(other.id, rig.deps)).ok).toBe(false);
    expect((await buildOne(other.id, rig.deps)).ok).toBe(true);
  });

  it("keeps exporting the two reasons under their old names, with core's texts", () => {
    expect(STOPPED_REASON).toBe("the build was stopped");
    expect(INTERRUPTED_REASON).toBe("the build was interrupted");
  });
});
