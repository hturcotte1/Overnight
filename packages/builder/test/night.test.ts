// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The night flow on an in-memory store, temp folders and scripted backends.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config, DataPaths, Store } from "@overnight/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildOne, failInterruptedBuilds, INTERRUPTED_REASON, runBuildNight, SKIPPED_NOTHING_APPROVED, SKIPPED_PAUSED } from "../src/index.ts";
import type { BuildDeps } from "../src/index.ts";
import { approvedIdea, collectingLogger, fakeBackend, memoryStore, MINUTE, movableClock, T0, tempDir, testConfig, testPaths } from "./helpers.ts";
import type { Clock, FakeBackend } from "./helpers.ts";

interface Rig {
  store: Store;
  config: Config;
  paths: DataPaths;
  clock: Clock;
  primary: FakeBackend;
  fallback: FakeBackend;
  lines: string[];
  deps: BuildDeps;
}

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function makeRig(options: { primary?: FakeBackend; fallback?: FakeBackend | null; config?: Record<string, string> } = {}): Rig {
  const paths = testPaths();
  const store = memoryStore();
  stores.push(store);
  const config = testConfig(paths.root, options.config);
  const clock = movableClock(T0);
  const primary = options.primary ?? fakeBackend("kiro-crew", ["built"]);
  const fallback = options.fallback === undefined ? fakeBackend("kiro-cli", ["built"]) : options.fallback;
  const { logger, lines } = collectingLogger();
  const deps: BuildDeps = { store, config, paths, backends: { primary, fallback }, logger, now: clock.now };
  return { store, config, paths, clock, primary, fallback: fallback ?? fakeBackend("kiro-cli", ["built"]), lines, deps };
}

describe("overnight build: the night flow", () => {
  it("does nothing while paused", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store);
    rig.store.setPaused(true, rig.clock.iso());

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_PAUSED });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "approved", slug: null, buildStartedAt: null });
    expect(readdirSync(rig.paths.workspaces)).toEqual([]);
  });

  it("while paused, still marks a build that was cut off as failed, and starts nothing", async () => {
    const rig = makeRig();
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    const waiting = approvedIdea(rig.store, { title: "Waiting" });
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T01:00:00.000Z" }, "2026-10-10T01:00:00.000Z");
    rig.store.setPaused(true, rig.clock.iso());

    // A paused Overnight must not leave an idea "building" for as long as the pause lasts: the
    // morning's deliver step (which runs while paused) can only tell the wearer about a failed one.
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [stuck.id], skipped: SKIPPED_PAUSED });
    expect(rig.store.getIdea(stuck.id)).toMatchObject({ state: "build_failed", failureReason: INTERRUPTED_REASON });
    // Nothing is built while paused.
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(waiting.id)).toMatchObject({ state: "approved", slug: null });
    expect(readdirSync(rig.paths.workspaces)).toEqual([]);

    // A week later, still paused: nothing more to do, and nothing breaks.
    rig.clock.advance(7 * 24 * 60 * MINUTE);
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_PAUSED });
  });

  it("while paused, leaves a build alone that is still inside its time limit", async () => {
    const rig = makeRig();
    const running = approvedIdea(rig.store, { title: "Still running" });
    // 59 minutes ago: the 45-minute limit plus 15 has not passed.
    rig.store.transitionIdea(running.id, "building", { slug: "still-running", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T06:01:00.000Z" }, "2026-10-10T06:01:00.000Z");
    rig.store.setPaused(true, rig.clock.iso());
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_PAUSED });
    expect(rig.store.getIdea(running.id)).toMatchObject({ state: "building", failureReason: null });
  });

  it("is paused on a fresh install, where nothing has been stored yet", async () => {
    const rig = makeRig({ config: { PAUSED: "true" } });
    approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).skipped).toBe(SKIPPED_PAUSED);
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("says so when nothing is approved", async () => {
    const rig = makeRig();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_NOTHING_APPROVED });
  });

  it("builds an approved idea: slug, workspace, brief, building, then built", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store, { title: "Coin Flipper" });
    rig.primary = fakeBackend("kiro-crew", [
      (job) => {
        // While the backend runs, the idea is "building".
        expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "building", buildBackend: "kiro-crew", buildStartedAt: T0, slug: "coin-flipper" });
        rig.clock.advance(3 * MINUTE);
        return fakeBackend("kiro-crew", ["built"]).build(job);
      },
    ]);
    rig.deps.backends.primary = rig.primary;

    expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });

    const workspace = path.join(rig.paths.workspaces, idea.id);
    expect(rig.primary.jobs).toEqual([{ ideaId: idea.id, workspace, briefPath: path.join(workspace, "brief.md"), timeoutMs: 45 * MINUTE }]);
    // The agent is handed one file.
    expect(rig.primary.seen[0]?.files).toEqual(["brief.md"]);
    expect(rig.primary.seen[0]?.brief).toContain("Title: Coin Flipper");
    expect(readFileSync(path.join(rig.paths.ideas, idea.id, "brief.md"), "utf8")).toBe(rig.primary.seen[0]?.brief);

    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({
      state: "built",
      slug: "coin-flipper",
      buildBackend: "kiro-crew",
      buildStartedAt: T0,
      builtAt: "2026-10-10T07:03:00.000Z",
      failureReason: null,
    });
    expect(rig.store.ideaEvents(idea.id).map((event) => `${event.fromState}>${event.toState}`).slice(-2)).toEqual(["approved>building", "building>built"]);
    expect(rig.fallback.jobs).toHaveLength(0);
  });

  it("gives the agent a brief without the quote", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store, { quote: "honestly we argue about who pays every single lunch" });
    await runBuildNight(rig.deps);
    const brief = rig.primary.seen[0]?.brief ?? "";
    expect(brief).toContain("Pitch: ");
    expect(brief).not.toContain(idea.quote);
    expect(brief).not.toContain("every single lunch");
  });

  it("builds in the order the ideas were approved, not the order they were heard", async () => {
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" } });
    const heardFirst = approvedIdea(rig.store, { title: "Heard first", heardAt: "2026-10-09T15:00:00.000Z", approvedAt: "2026-10-09T23:00:00.000Z" });
    const heardSecond = approvedIdea(rig.store, { title: "Heard second", heardAt: "2026-10-09T16:00:00.000Z", approvedAt: "2026-10-09T17:00:00.000Z" });
    const heardThird = approvedIdea(rig.store, { title: "Heard third", heardAt: "2026-10-09T18:00:00.000Z", approvedAt: "2026-10-09T19:00:00.000Z" });

    const result = await runBuildNight(rig.deps);
    expect(rig.primary.jobs.map((job) => job.ideaId)).toEqual([heardSecond.id, heardThird.id, heardFirst.id]);
    expect(result.built).toEqual([heardSecond.id, heardThird.id, heardFirst.id]);
  });

  it("builds at most MAX_BUILDS_PER_NIGHT and leaves the rest approved", async () => {
    const rig = makeRig();
    const a = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const b = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    const c = approvedIdea(rig.store, { title: "App C", approvedAt: "2026-10-09T19:00:00.000Z" });

    const result = await runBuildNight(rig.deps);
    expect(result.built).toEqual([a.id, b.id]);
    expect(result.skipped).toBe("1 approved idea waits for another night (limit 2 a night)");
    expect(rig.store.getIdea(c.id)).toMatchObject({ state: "approved", slug: null });

    // A second run the same night does not start a third build.
    rig.clock.advance(20 * MINUTE);
    const again = await runBuildNight(rig.deps);
    expect(again.built).toEqual([]);
    expect(again.skipped).toBe("1 approved idea waits for another night (limit 2 a night)");
    expect(rig.primary.jobs).toHaveLength(2);

    // The next night it is built.
    rig.clock.set("2026-10-11T07:00:00.000Z");
    expect((await runBuildNight(rig.deps)).built).toEqual([c.id]);
  });

  it("counts builds already started in the same local day, and not yesterday's", async () => {
    const rig = makeRig();
    const yesterday = approvedIdea(rig.store, { title: "Built yesterday", approvedAt: "2026-10-09T15:00:00.000Z" });
    const early = approvedIdea(rig.store, { title: "Built by hand", approvedAt: "2026-10-09T16:00:00.000Z" });
    const a = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const b = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });

    // 11:50 pm local on Oct 9: the day before tonight's window.
    rig.clock.set("2026-10-10T05:50:00.000Z");
    expect((await buildOne(yesterday.id, rig.deps)).ok).toBe(true);
    // 12:30 am local on Oct 10: inside tonight's window.
    rig.clock.set("2026-10-10T06:30:00.000Z");
    expect((await buildOne(early.id, rig.deps)).ok).toBe(true);

    rig.clock.set(T0);
    const result = await runBuildNight(rig.deps);
    expect(result.built).toEqual([a.id]);
    expect(rig.store.getIdea(b.id)?.state).toBe("approved");
  });

  it("builds nothing when the limit is 0", async () => {
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "0" } });
    approvedIdea(rig.store);
    const result = await runBuildNight(rig.deps);
    expect(result.built).toEqual([]);
    expect(result.skipped).toBe("1 approved idea waits for another night (limit 0 a night)");
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("tries the other backend once, in a fresh workspace, after a failure", async () => {
    const primary = fakeBackend("kiro-crew", [
      (job) => {
        // The first try leaves half a build behind, takes 40 minutes and reports a failure.
        writeFileSync(path.join(job.workspace, "half-built.txt"), "left by the first try");
        clock.advance(40 * MINUTE);
        return { ok: false, backend: "kiro-crew", ms: 10, reason: "the builder stopped before it finished", couldNotStart: false };
      },
    ]);
    const rig = makeRig({ primary });
    const clock = rig.clock;
    const idea = approvedIdea(rig.store);
    rig.fallback = fakeBackend("kiro-cli", [
      (job) => {
        // The clock for "interrupted" starts again with the second try.
        expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "building", buildBackend: "kiro-cli", buildStartedAt: "2026-10-10T07:40:00.000Z" });
        return fakeBackend("kiro-cli", ["built"]).build(job);
      },
    ]);
    rig.deps.backends.fallback = rig.fallback;

    const result = await runBuildNight(rig.deps);
    expect(result).toEqual({ built: [idea.id], failed: [], skipped: "" });
    expect(primary.jobs).toHaveLength(1);
    expect(rig.fallback.jobs).toHaveLength(1);
    // Same folder name, but empty again: the first try was moved aside, not deleted.
    expect(rig.fallback.jobs[0]?.workspace).toBe(primary.jobs[0]?.workspace);
    expect(rig.fallback.seen[0]?.files).toEqual(["brief.md"]);
    const aside = readdirSync(rig.paths.workspaces).filter((name) => name.startsWith(`${idea.id}.old-`));
    expect(aside).toHaveLength(1);
    expect(existsSync(path.join(rig.paths.workspaces, aside[0] ?? "", "half-built.txt"))).toBe(true);

    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", buildBackend: "kiro-cli", failureReason: null });
    // One build started, however many backends it took.
    expect(rig.store.ideaEvents(idea.id).filter((event) => event.toState === "building")).toHaveLength(1);
  });

  it("tries the other backend when the first one cannot start", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]) });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", buildBackend: "kiro-cli" });
  });

  it("renews Kiro's sign-in before every try on a builder, and hands it the stop signal", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["failed"]) });
    const order: string[] = [];
    const seenSignals: Array<AbortSignal | undefined> = [];
    rig.deps.renewSignIn = async (signal) => {
      seenSignals.push(signal);
      order.push(`sign-in before try ${rig.primary.jobs.length + rig.fallback.jobs.length + 1}`);
      return { ok: true, leftMs: 3_500_000, waitedMs: 0 };
    };
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    // Once before Kiro Crew's try and once before Kiro CLI's.
    expect(order).toEqual(["sign-in before try 1", "sign-in before try 2"]);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(rig.primary.jobs).toHaveLength(1);
    expect(rig.fallback.jobs).toHaveLength(1);
  });

  it("starts no build while Kiro is signed out, and says why in plain words", async () => {
    const rig = makeRig();
    rig.deps.renewSignIn = async () => ({ ok: false, reason: "Kiro is signed out on this Mac (to fix it, run: kiro-cli login)" });
    const idea = approvedIdea(rig.store);
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: "" });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.fallback.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)?.failureReason).toBe("Kiro Crew: Kiro is signed out on this Mac (to fix it, run: kiro-cli login). Kiro CLI: Kiro is signed out on this Mac (to fix it, run: kiro-cli login)");
  });

  it("goes on with the build when the sign-in step itself breaks", async () => {
    const rig = makeRig();
    rig.deps.renewSignIn = async () => {
      throw new Error("made-up crash");
    };
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    expect(rig.primary.jobs).toHaveLength(1);
    expect(rig.lines.some((line) => line.includes("the sign-in step threw"))).toBe(true);
  });

  it("marks the idea build_failed, with both reasons in plain words, when both backends fail", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]), fallback: fakeBackend("kiro-cli", ["failed"]) });
    const idea = approvedIdea(rig.store, { title: "Coin Flipper", quote: "we should just flip a coin for it every single time" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: "" });
    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({
      state: "build_failed",
      builtAt: null,
      buildBackend: "kiro-cli",
      failureReason: "Kiro Crew: the gateway is not running. Kiro CLI: the builder reported that the build failed",
    });
    expect(after?.failureReason).not.toContain("Coin Flipper");
    expect(after?.failureReason).not.toContain("flip a coin");
    expect(rig.store.ideaEvents(idea.id).at(-1)).toMatchObject({ fromState: "building", toState: "build_failed" });
    // The wearer has not been told yet: that is the deliver step's job.
    expect(after?.failureNotifiedAt).toBeNull();
  });

  it("marks the idea build_failed after one backend when there is no fallback", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-cli", ["failed"]), fallback: null });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).failed).toEqual([idea.id]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: "Kiro CLI: the builder reported that the build failed" });
  });

  it("goes on to the next idea when one fails, even if a backend throws", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["throws", "built"]), fallback: fakeBackend("kiro-cli", ["throws"]) });
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [second.id], failed: [first.id], skipped: "" });
    expect(rig.store.getIdea(first.id)).toMatchObject({
      state: "build_failed",
      failureReason: "Kiro Crew: the builder stopped on an unexpected error. Kiro CLI: the builder stopped on an unexpected error",
    });
    expect(rig.store.getIdea(second.id)?.state).toBe("built");
  });

  it("gives two ideas with the same title different slugs", async () => {
    const rig = makeRig();
    const one = approvedIdea(rig.store, { title: "Coin Flipper", approvedAt: "2026-10-09T17:00:00.000Z" });
    const two = approvedIdea(rig.store, { title: "Coin flipper!", approvedAt: "2026-10-09T18:00:00.000Z" });
    await runBuildNight(rig.deps);
    expect(rig.store.getIdea(one.id)?.slug).toBe("coin-flipper");
    expect(rig.store.getIdea(two.id)?.slug).toBe("coin-flipper-2");
  });

  it("marks a build that was cut off as failed, so the idea is never stuck, and gives it its one more try", async () => {
    const rig = makeRig();
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    const running = approvedIdea(rig.store, { title: "Still running" });
    // 61 minutes ago: past the 45-minute limit plus 15. And 59 minutes ago: not yet.
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");
    rig.store.transitionIdea(running.id, "building", { slug: "still-running", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T06:01:00.000Z" }, "2026-10-10T06:01:00.000Z");

    const result = await runBuildNight(rig.deps);
    // The cut-off build was recorded as failed with exactly this reason ...
    expect(rig.store.ideaEvents(stuck.id).map((event) => event.toState)).toEqual(["heard", "asked", "approved", "building", "build_failed", "building", "built"]);
    expect(rig.store.ideaEvents(stuck.id).find((event) => event.toState === "build_failed")).toMatchObject({ note: INTERRUPTED_REASON });
    expect(INTERRUPTED_REASON).toBe("the build was interrupted");
    // ... and, being cut short and not failed, was built again by the same run (see retry.test.ts).
    expect(result).toMatchObject({ built: [stuck.id], failed: [] });
    expect(rig.primary.jobs.map((job) => job.ideaId)).toEqual([stuck.id]);
    // The other one may still be running: it is left alone.
    expect(rig.store.getIdea(running.id)).toMatchObject({ state: "building", failureReason: null });

    // Two minutes later the second one is past the limit too. Both of tonight's starts are used
    // (each idea's first try counts), so it is failed now and waits for another night.
    rig.clock.advance(2 * MINUTE);
    const later = await runBuildNight(rig.deps);
    expect(later).toMatchObject({ built: [], failed: [running.id] });
    expect(rig.store.getIdea(running.id)).toMatchObject({ state: "build_failed", failureReason: INTERRUPTED_REASON });
    expect(rig.primary.jobs).toHaveLength(1);
  });

  it("stops before the next idea when Overnight is paused during the night", async () => {
    const rig = makeRig();
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    rig.primary = fakeBackend("kiro-crew", [
      (job) => {
        rig.store.setPaused(true, rig.clock.iso());
        return fakeBackend("kiro-crew", ["built"]).build(job);
      },
    ]);
    rig.deps.backends.primary = rig.primary;

    expect(await runBuildNight(rig.deps)).toEqual({ built: [first.id], failed: [], skipped: SKIPPED_PAUSED });
    expect(rig.store.getIdea(second.id)?.state).toBe("approved");
  });

  it("does not touch the workspace of an idea that moved on while an earlier one was building", async () => {
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" } });
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    const third = approvedIdea(rig.store, { title: "App C", approvedAt: "2026-10-09T19:00:00.000Z" });
    const secondWorkspace = path.join(rig.paths.workspaces, second.id);
    rig.primary = fakeBackend("kiro-crew", [
      (job) => {
        // While App A builds, something else (a second builder that got past the lock, say)
        // builds App B and finishes it.
        mkdirSync(path.join(secondWorkspace, "dist"), { recursive: true });
        writeFileSync(path.join(secondWorkspace, "dist", "index.html"), "<!doctype html><title>App B, finished</title>");
        rig.store.transitionIdea(second.id, "building", { slug: "app-b", buildBackend: "kiro-crew", buildStartedAt: rig.clock.iso() }, rig.clock.iso());
        rig.store.transitionIdea(second.id, "built", { builtAt: rig.clock.iso() }, rig.clock.iso());
        return fakeBackend("kiro-crew", ["built"]).build(job);
      },
      "built",
    ]);
    rig.deps.backends.primary = rig.primary;

    const result = await runBuildNight(rig.deps);
    // App B was not started again: its finished app is where the deliver step will look for it.
    expect(result).toEqual({ built: [first.id, third.id], failed: [], skipped: "" });
    expect(rig.primary.jobs.map((job) => job.ideaId)).toEqual([first.id, third.id]);
    expect(rig.store.getIdea(second.id)?.state).toBe("built");
    expect(readFileSync(path.join(secondWorkspace, "dist", "index.html"), "utf8")).toContain("App B, finished");
    expect(readdirSync(rig.paths.workspaces).filter((name) => name.includes(".old-"))).toEqual([]);
    expect(rig.lines.join("\n")).toContain("build not started: the idea is no longer waiting for one");
  });

  it("marks the idea failed when its workspace cannot be made", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store);
    // A file where the workspaces folder should be.
    rmSync(rig.paths.workspaces, { recursive: true });
    writeFileSync(rig.paths.workspaces, "in the way");

    expect((await runBuildNight(rig.deps)).failed).toEqual([idea.id]);
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)).toMatchObject({
      state: "build_failed",
      failureReason: "Kiro Crew: the workspace folder could not be prepared. Kiro CLI: the workspace folder could not be prepared",
    });
  });

  it("never logs a title, a pitch or a quote", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["failed"]), fallback: fakeBackend("kiro-cli", ["failed", "built"]) });
    approvedIdea(rig.store, { title: "Zebra Stripe Counter", pitch: "Counts the stripes on a photographed zebra.", quote: "how many stripes does that zebra actually have", approvedAt: "2026-10-09T17:00:00.000Z" });
    approvedIdea(rig.store, { title: "Walrus Weigher", pitch: "Guess the weight of a walrus.", quote: "that walrus must weigh a ton", approvedAt: "2026-10-09T18:00:00.000Z" });
    await runBuildNight(rig.deps);

    const log = rig.lines.join("\n");
    expect(rig.lines.length).toBeGreaterThan(4);
    for (const word of ["Zebra", "zebra", "stripes", "Walrus", "walrus", "weigh"]) expect(log, word).not.toContain(word);
    // What it does log: ids, backends, and our own reasons.
    expect(log).toContain('"message":"build failed"');
    expect(log).toContain('"backend":"kiro-cli"');
  });
});

describe("overnight build-now: buildOne", () => {
  it("builds an approved idea right away, whatever the nightly limit", async () => {
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "0" } });
    const idea = approvedIdea(rig.store);
    const outcome = await buildOne(idea.id, rig.deps);
    expect(outcome).toMatchObject({ ok: true, backend: "kiro-crew" });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", slug: "coin-flipper" });
  });

  it("builds a failed idea again, keeping its slug and clearing the old reason", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["failed", "built"]), fallback: null });
    const idea = approvedIdea(rig.store);
    const first = await buildOne(idea.id, rig.deps);
    expect(first).toMatchObject({ ok: false, backend: "kiro-crew", reason: "Kiro Crew: the builder reported that the build failed", couldNotStart: false });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", slug: "coin-flipper" });

    rig.clock.advance(10 * MINUTE);
    expect((await buildOne(idea.id, rig.deps)).ok).toBe(true);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", slug: "coin-flipper", failureReason: null, buildStartedAt: "2026-10-10T07:10:00.000Z" });
    // The failed try's folder was moved aside.
    expect(readdirSync(rig.paths.workspaces).filter((name) => name.includes(".old-"))).toHaveLength(1);
  });

  it("returns the fallback's result when the first backend fails", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]) });
    const idea = approvedIdea(rig.store);
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: true, backend: "kiro-cli" });
  });

  it("says couldNotStart only when neither backend could start", async () => {
    const neither = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]), fallback: fakeBackend("kiro-cli", ["cannot-start"]) });
    expect(await buildOne(approvedIdea(neither.store).id, neither.deps)).toMatchObject({ ok: false, couldNotStart: true });
    const one = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]), fallback: fakeBackend("kiro-cli", ["failed"]) });
    expect(await buildOne(approvedIdea(one.store).id, one.deps)).toMatchObject({ ok: false, couldNotStart: false, backend: "kiro-cli" });
  });

  it("refuses while paused", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store);
    rig.store.setPaused(true, rig.clock.iso());
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("paused") });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)?.state).toBe("approved");
  });

  it("refuses an idea that is not approved or build_failed, and an id it does not know", async () => {
    const rig = makeRig();
    const built = approvedIdea(rig.store);
    await buildOne(built.id, rig.deps);
    expect(await buildOne(built.id, rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining('this idea is "built"') });

    const heard = rig.store.createIdea({ title: "Only heard", pitch: "p", quote: "q", confidence: 0.9, conversationKey: rig.store.resolveConversation({ uuid: "conv-x" }, T0).key, detectorRunId: null }, T0);
    expect(await buildOne(heard.id, rig.deps)).toMatchObject({ ok: false, reason: expect.stringContaining('this idea is "heard"') });
    expect(rig.store.getIdea(heard.id)?.state).toBe("heard");

    expect(await buildOne("idea_nope", rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: "there is no idea with that id" });
    expect(rig.primary.jobs).toHaveLength(1);
  });
});

describe("overnight build-now: an idea that is marked as being built", () => {
  it("fails a build that was cut off long ago, and then builds the idea", async () => {
    const rig = makeRig();
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    // 61 minutes ago: past the 45-minute limit plus 15.
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");

    expect(await buildOne(stuck.id, rig.deps)).toMatchObject({ ok: true, backend: "kiro-crew" });
    expect(rig.store.getIdea(stuck.id)).toMatchObject({ state: "built", slug: "stuck" });
    // Through the state machine: building -> build_failed (cut off) -> building -> built.
    expect(rig.store.ideaEvents(stuck.id).map((event) => event.toState).slice(-3)).toEqual(["build_failed", "building", "built"]);
  });

  it("refuses one that may really be running, and says when it can be tried again", async () => {
    const rig = makeRig();
    const running = approvedIdea(rig.store, { title: "Still running" });
    // 10 minutes ago. It counts as cut off at 06:50 + 45 + 15 minutes = 07:50 UTC, 1:50 am in Boise.
    rig.store.transitionIdea(running.id, "building", { slug: "still-running", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T06:50:00.000Z" }, "2026-10-10T06:50:00.000Z");

    const outcome = await buildOne(running.id, rig.deps);
    expect(outcome).toMatchObject({ ok: false, couldNotStart: true });
    expect(outcome.ok ? "" : outcome.reason).toBe("this idea is marked as being built right now; if that build was cut off, it can be built again after Oct 10, 1:50 AM");
    expect(rig.store.getIdea(running.id)?.state).toBe("building");
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("fails cut-off builds even while paused, without building", async () => {
    const rig = makeRig();
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");
    rig.store.setPaused(true, rig.clock.iso());
    expect(await buildOne(stuck.id, rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("paused") });
    expect(rig.store.getIdea(stuck.id)).toMatchObject({ state: "build_failed", failureReason: INTERRUPTED_REASON });
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("exports the check itself, for a command that wants to run it alone", () => {
    const rig = makeRig();
    const stuck = approvedIdea(rig.store, { title: "Stuck" });
    rig.store.transitionIdea(stuck.id, "building", { slug: "stuck", buildBackend: "kiro-crew", buildStartedAt: "2026-10-10T05:59:00.000Z" }, "2026-10-10T05:59:00.000Z");
    expect(failInterruptedBuilds(rig.deps, rig.clock.now())).toEqual([stuck.id]);
    expect(failInterruptedBuilds(rig.deps, rig.clock.now())).toEqual([]);
  });
});

describe("the workspaces folder", () => {
  it("is never followed when something has put a link in its place", async () => {
    const rig = makeRig({ fallback: null });
    const idea = approvedIdea(rig.store);
    const elsewhere = tempDir();
    rmSync(rig.paths.workspaces, { recursive: true });
    symlinkSync(elsewhere, rig.paths.workspaces);

    expect((await runBuildNight(rig.deps)).failed).toEqual([idea.id]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: "Kiro Crew: the workspace folder could not be prepared" });
    // Nothing was written through the link.
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(rig.primary.jobs).toHaveLength(0);
  });
});
