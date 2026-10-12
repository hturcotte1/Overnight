// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The night flow on an in-memory store, temp folders and scripted backends.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { budgetReachedText, buildBudget, finishedBuildDir, HIGHEST_BUILD_CREDIT_LIMIT } from "@overnight/core";
import type { Config, DataPaths, Store } from "@overnight/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILD_SKILL_FILE, buildOne, createKiroCliBackend, createKiroCrewBackend, failInterruptedBuilds, INTERRUPTED_REASON, runBuildNight, SKIPPED_NOTHING_APPROVED, SKIPPED_PAUSED, STOPPED_REASON } from "../src/index.ts";
import type { BuildBackend, BuildDeps, BuildJob, BuildOutcome } from "../src/index.ts";
import { MOST_CREDITS_FOR_A_SHORT_TRY, MOST_CREDITS_PER_AGENT_MINUTE, mostBelievableCredits } from "../src/night.ts";
import { approvedIdea, clockedSleptWatch, collectingLogger, FakeCrew, fakeBackend, HOUR, leaveBuild, memoryStore, MINUTE, movableClock, recordingRunner, reply, SECOND, T0, tempDir, testConfig, testPaths } from "./helpers.ts";
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

describe("a finished build is moved out of the build jobs' reach", () => {
  /** What the app's page says: tells one build from another. */
  const page = (dir: string) => readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  /** A backend that builds an app whose page carries `mark`. */
  const builds = (name: BuildBackend["name"], mark: string, during: (job: BuildJob) => void = () => {}) =>
    fakeBackend(name, [
      (job) => {
        during(job);
        leaveBuild(job.workspace);
        writeFileSync(path.join(job.workspace, "dist", "index.html"), `<!doctype html><title>${mark}</title>`);
        return { ok: true, backend: name, ms: 1 };
      },
    ]);

  it("ends in built/<id>, with nothing left in workspaces/, as soon as the idea is recorded as built", async () => {
    const rig = makeRig({ primary: builds("kiro-crew", "made tonight") });
    const idea = approvedIdea(rig.store);
    expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });

    const sealed = path.join(rig.paths.built, idea.id);
    expect(page(sealed)).toContain("made tonight");
    expect(readdirSync(sealed).sort()).toEqual(["BUILD_STATUS.json", "brief.md", "dist"]);
    expect(readdirSync(rig.paths.workspaces)).toEqual([]);
    // That is where the morning looks first.
    expect(finishedBuildDir(rig.paths, idea.id)).toBe(sealed);
    expect(rig.store.getIdea(idea.id)?.state).toBe("built");
    expect(rig.lines.join("\n")).not.toContain("could not be moved");
  });

  it("is moved only after the idea is recorded as built: while the builder runs, the folder is the workspace", async () => {
    let seenWhileBuilding: string[] = [];
    const rig = makeRig({ primary: builds("kiro-crew", "made tonight", () => (seenWhileBuilding = readdirSync(rig.paths.built))) });
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    expect(seenWhileBuilding).toEqual([]);
    expect(rig.primary.jobs[0]?.workspace).toBe(path.join(rig.paths.workspaces, idea.id));
  });

  it("seals the build that build-now made, too", async () => {
    const rig = makeRig({ primary: builds("kiro-crew", "made by hand") });
    const idea = approvedIdea(rig.store);
    expect((await buildOne(idea.id, rig.deps)).ok).toBe(true);
    expect(page(path.join(rig.paths.built, idea.id))).toContain("made by hand");
    expect(existsSync(path.join(rig.paths.workspaces, idea.id))).toBe(false);
  });

  it("seals the other builder's result when the first one failed, and keeps the failed try's folder", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["failed"]), fallback: builds("kiro-cli", "made by the other builder") });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);

    expect(page(path.join(rig.paths.built, idea.id))).toContain("made by the other builder");
    // The first try's folder was moved aside in workspaces/, as before: it is not a finished build.
    const left = readdirSync(rig.paths.workspaces);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(new RegExp(`^${idea.id}\\.old-`));
    expect(readdirSync(rig.paths.built)).toEqual([idea.id]);
  });

  it("leaves a failed build in workspaces/: only a finished build is sealed", async () => {
    const rig = makeRig({ primary: fakeBackend("kiro-crew", ["failed"]), fallback: null });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).failed).toEqual([idea.id]);
    expect(readdirSync(rig.paths.built)).toEqual([]);
    expect(readdirSync(rig.paths.workspaces)).toEqual([idea.id]);
  });

  it("moves an older finished build of the same idea aside before the new build starts, and never deletes it", async () => {
    let sealedWhileBuilding: string[] | null = null;
    const rig = makeRig({ primary: builds("kiro-crew", "the new build", () => (sealedWhileBuilding = readdirSync(rig.paths.built))) });
    const idea = approvedIdea(rig.store);
    // A finished build already kept under this idea's id (left by an earlier life of this data folder).
    const older = path.join(rig.paths.built, idea.id);
    mkdirSync(path.join(older, "dist"), { recursive: true });
    writeFileSync(path.join(older, "dist", "index.html"), "<!doctype html><title>the older build</title>");

    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    // 20261010T070000Z: the build night's own clock.
    const aside = `${idea.id}.old-20261010T070000Z`;
    // Already out of the way while the builder ran: the morning could not have picked it up in between.
    expect(sealedWhileBuilding).toEqual([aside]);
    expect(readdirSync(rig.paths.built).sort()).toEqual([idea.id, aside]);
    expect(page(path.join(rig.paths.built, idea.id))).toContain("the new build");
    expect(page(path.join(rig.paths.built, aside))).toContain("the older build");
  });

  it("does not start a try when the older finished build cannot be moved aside", async () => {
    const rig = makeRig();
    const idea = approvedIdea(rig.store);
    const elsewhere = tempDir();
    symlinkSync(elsewhere, path.join(rig.paths.built, idea.id));

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: "" });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.fallback.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)).toMatchObject({
      state: "build_failed",
      failureReason: "Kiro Crew: the workspace folder could not be prepared. Kiro CLI: the workspace folder could not be prepared",
    });
    // No workspace was made, and nothing was written through the link.
    expect(readdirSync(rig.paths.workspaces)).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(path.join(rig.paths.built, idea.id)).isSymbolicLink()).toBe(true);
    const errors = rig.lines.filter((line) => line.includes("could not move an older finished build aside, so the build was not started"));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"level":"error"');
    expect(errors[0]).toContain("a link stands where the idea's finished build is kept");
  });

  it("leaves the idea built, with an error in the log, when the finished build cannot be moved", async () => {
    const elsewhere = tempDir();
    // Something puts a link where the finished build goes, after the try began.
    const rig = makeRig({ primary: builds("kiro-crew", "made tonight", (job) => symlinkSync(elsewhere, path.join(rig.paths.built, job.ideaId))) });
    const idea = approvedIdea(rig.store);

    expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null });
    // The app stays where it was built, and that is where the morning finds it.
    const workspace = path.join(rig.paths.workspaces, idea.id);
    expect(page(workspace)).toContain("made tonight");
    expect(finishedBuildDir(rig.paths, idea.id)).toBe(workspace);
    expect(readdirSync(elsewhere)).toEqual([]);
    const errors = rig.lines.filter((line) => line.includes("a finished build could not be moved out of the builders' reach; the morning uses it where it is"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"level":"error"');
    expect(errors[0]).toContain(`"ideaId":"${idea.id}"`);
  });

  it("makes the build's files anew: a file the builder kept open, and a hard link it left where jobs may write, do not lead to the sealed app", async () => {
    let keptOpen = -1;
    let keptLink = "";
    const rig = makeRig({
      primary: fakeBackend("kiro-crew", [
        (job) => {
          leaveBuild(job.workspace);
          const built = path.join(job.workspace, "dist", "index.html");
          writeFileSync(built, "<!doctype html><title>as built</title>");
          // What a build can keep: the page open for writing (in a program it leaves running),
          // and a second name for it in the build jobs' temporary folder.
          keptOpen = openSync(built, "r+");
          keptLink = path.join(rig.paths.buildTmp, "kept.html");
          mkdirSync(rig.paths.buildTmp, { recursive: true });
          linkSync(built, keptLink);
          return { ok: true, backend: "kiro-crew", ms: 1 };
        },
      ]),
    });
    const idea = approvedIdea(rig.store);
    try {
      expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
      writeSync(keptOpen, "CHANGED AFTER THE SEAL, THROUGH A FILE OPENED BEFORE IT", 0);
      appendFileSync(keptLink, "CHANGED AFTER THE SEAL, THROUGH THE HARD LINK");
    } finally {
      closeSync(keptOpen);
    }
    expect(page(path.join(rig.paths.built, idea.id))).toBe("<!doctype html><title>as built</title>");
    expect(readdirSync(rig.paths.built)).toEqual([idea.id]);
    const moved = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "finished build moved out of the builders' reach");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ level: "info", ideaId: idea.id, filesMadeAnew: 3 });
    expect(rig.lines.join("\n")).not.toContain("could not be made anew");
  });

  // macOS's "locked" mark on a file: it can be read, but nothing can be put in its place.
  it.skipIf(process.platform !== "darwin")("leaves the idea built, with an error in the log, when some of its files could not be made anew", async () => {
    const rig = makeRig({
      primary: builds("kiro-crew", "made tonight", (job) => {
        mkdirSync(path.join(job.workspace, "src"));
        writeFileSync(path.join(job.workspace, "src", "locked.js"), "made up: locked\n");
        expect(spawnSync("/usr/bin/chflags", ["uchg", path.join(job.workspace, "src", "locked.js")]).status).toBe(0);
      }),
    });
    const idea = approvedIdea(rig.store);
    const locked = path.join(rig.paths.built, idea.id, "src", "locked.js");
    try {
      expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });
      // Moved all the same: that is where the morning finds it.
      expect(finishedBuildDir(rig.paths, idea.id)).toBe(path.join(rig.paths.built, idea.id));
      expect(readFileSync(locked, "utf8")).toBe("made up: locked\n");
      const errors = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "a finished build was moved out of the builders' reach, but some of its files could not be made anew; its own build could still change those");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ level: "error", ideaId: idea.id, files: 1, filesMadeAnew: 3 });
      expect(rig.lines.join("\n")).not.toContain('"message":"finished build moved out of the builders\' reach"');
    } finally {
      spawnSync("/usr/bin/chflags", ["nouchg", locked]);
      spawnSync("/usr/bin/chflags", ["nouchg", path.join(rig.paths.workspaces, idea.id, "src", "locked.js")]);
    }
  });
});

/** October 2026 in Boise, the month every test below runs in unless it says otherwise. */
const OCTOBER = { start: "2026-10-01T06:00:00.000Z", end: "2026-11-01T06:00:00.000Z" };
const NOVEMBER = { start: "2026-11-01T06:00:00.000Z", end: "2026-12-01T07:00:00.000Z" };
const counted = (store: Store, month = OCTOBER) => store.buildCreditsBetween(month.start, month.end);

/** A backend whose tries have a cost: each answer is spread over a built or a failed outcome. */
function costly(name: BuildBackend["name"], answers: Array<{ ok: boolean; credits?: number; agentMs?: number; reason?: string; couldNotStart?: boolean }>, clock?: Clock): FakeBackend {
  let call = 0;
  return fakeBackend(name, [
    (job): BuildOutcome => {
      const { ok, reason, couldNotStart, ...cost } = answers[Math.min(call, answers.length - 1)] ?? { ok: true };
      call += 1;
      // The agent's time passes on the night's own clock.
      if (clock !== undefined && cost.agentMs !== undefined) clock.advance(cost.agentMs);
      if (!ok) return { ok: false, backend: name, ms: 55, reason: reason ?? "the builder reported that the build failed", couldNotStart: couldNotStart ?? false, ...cost };
      leaveBuild(job.workspace);
      return { ok: true, backend: name, ms: 1234, ...cost };
    },
  ]);
}

describe("what builds cost: one row in the month's ledger for each try that started an agent", () => {
  it("counts the builder's own figure when it gave one", async () => {
    const rig = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: 3.6, agentMs: 2 * MINUTE }]) });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    expect(counted(rig.store)).toEqual({ credits: 3.6, estimated: 0, tries: 1 });
    const line = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.message === "build try counted");
    expect(line).toMatchObject({ level: "info", ideaId: idea.id, backend: "kiro-crew", credits: 3.6, measured: true });
  });

  it("counts an estimate from how long the agent ran when the builder gave no figure: 2 credits a minute", async () => {
    const rig = makeRig({ primary: costly("kiro-cli", [{ ok: true, agentMs: 7 * MINUTE + 30 * SECOND }]), fallback: null });
    approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    expect(counted(rig.store)).toEqual({ credits: 15, estimated: 15, tries: 1 });
  });

  it("counts a try that failed, ran out of time or was stopped: it used credits too", async () => {
    const rig = makeRig({
      config: { MAX_BUILDS_PER_NIGHT: "5" },
      primary: costly("kiro-crew", [
        { ok: false, credits: 2.5, agentMs: 3 * MINUTE },
        { ok: false, agentMs: 45 * MINUTE, reason: "the build ran past its time limit of 45 minutes" },
        { ok: false, agentMs: 20 * SECOND, reason: STOPPED_REASON },
      ]),
      fallback: null,
    });
    approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    approvedIdea(rig.store, { title: "App C", approvedAt: "2026-10-09T19:00:00.000Z" });
    expect((await runBuildNight(rig.deps)).failed).toHaveLength(3);
    // 2.5 measured, then 90 and 0.7 estimated.
    expect(counted(rig.store)).toEqual({ credits: 93.2, estimated: 90.7, tries: 3 });
  });

  it("writes two rows when the other builder ran as well, each under its own builder's figure", async () => {
    const rig = makeRig({ primary: costly("kiro-crew", [{ ok: false, credits: 1.25, agentMs: 4 * MINUTE }]), fallback: costly("kiro-cli", [{ ok: true, agentMs: 90 * SECOND }]) });
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
    expect(counted(rig.store)).toEqual({ credits: 4.25, estimated: 3, tries: 2 });
    const tries = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "build try counted");
    expect(tries.map((entry) => [entry.backend, entry.credits, entry.measured])).toEqual([
      ["kiro-crew", 1.25, true],
      ["kiro-cli", 3, false],
    ]);
  });

  it("writes no row for a try that started no agent", async () => {
    // Neither builder could start; then a try whose workspace could not even be made; then a night stopped before it began.
    const neither = makeRig({ primary: fakeBackend("kiro-crew", ["cannot-start"]), fallback: fakeBackend("kiro-cli", ["cannot-start"]) });
    approvedIdea(neither.store);
    expect((await runBuildNight(neither.deps)).failed).toHaveLength(1);
    expect(counted(neither.store)).toEqual({ credits: 0, estimated: 0, tries: 0 });

    const noWorkspace = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: 3 }]) });
    approvedIdea(noWorkspace.store);
    rmSync(noWorkspace.paths.workspaces, { recursive: true });
    writeFileSync(noWorkspace.paths.workspaces, "in the way");
    expect((await runBuildNight(noWorkspace.deps)).failed).toHaveLength(1);
    expect(counted(noWorkspace.store).tries).toBe(0);

    const signedOut = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: 3 }]) });
    signedOut.deps.renewSignIn = async () => ({ ok: false, reason: "Kiro is signed out on this Mac (to fix it, run: kiro-cli login)" });
    approvedIdea(signedOut.store);
    await runBuildNight(signedOut.deps);
    expect(counted(signedOut.store).tries).toBe(0);
    expect([neither, noWorkspace, signedOut].flatMap((rig) => rig.lines).filter((line) => line.includes("build try counted"))).toEqual([]);
  });

  it("counts a try in the month it ended in", async () => {
    const rig = makeRig({ fallback: null });
    // 11:50 pm on Oct 31 in Boise; the agent runs for twenty minutes, into November.
    rig.clock.set("2026-11-01T05:50:00.000Z");
    rig.deps.backends.primary = costly("kiro-crew", [{ ok: true, credits: 4, agentMs: 20 * MINUTE }], rig.clock);
    approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toHaveLength(1);
    expect(counted(rig.store, OCTOBER).tries).toBe(0);
    expect(counted(rig.store, NOVEMBER)).toEqual({ credits: 4, estimated: 0, tries: 1 });
  });

  it("does not fail a build when the ledger cannot be written: the result stands and the error is logged", async () => {
    const rig = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: 3.6, agentMs: 2 * MINUTE }]) });
    const idea = approvedIdea(rig.store);
    const write = vi.spyOn(rig.store, "recordBuildCost").mockImplementation(() => {
      throw new Error("made-up ledger failure");
    });
    expect(await runBuildNight(rig.deps)).toEqual({ built: [idea.id], failed: [], skipped: "" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(rig.store.getIdea(idea.id)?.state).toBe("built");
    expect(rig.fallback.jobs).toHaveLength(0);
    const errors = rig.lines.filter((line) => line.includes("could not record what a build try cost; the build's result stands"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"level":"error"');
    expect(rig.lines.join("\n")).not.toContain("build try counted");
  });

  it("does not believe a figure no build could have used, and counts the estimate in its place", async () => {
    // The figure comes from a file a build job can write. The agent ran 3 minutes: at 10 credits
    // a minute, 30 is the most it is believed about. 100,000 is the figure that closed a month
    // for good when it was believed (the highest limit there is; found Oct 11).
    for (const figure of [-1, Number.NaN, Number.POSITIVE_INFINITY, HIGHEST_BUILD_CREDIT_LIMIT + 0.5, 1e306, HIGHEST_BUILD_CREDIT_LIMIT, 60_000, 400, 30.1]) {
      const rig = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: figure, agentMs: 3 * MINUTE }]) });
      const idea = approvedIdea(rig.store);
      expect((await runBuildNight(rig.deps)).built, String(figure)).toEqual([idea.id]);
      expect(counted(rig.store), String(figure)).toEqual({ credits: 6, estimated: 6, tries: 1 });
      const warned = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "a builder's own credit figure was not one a build could have used; counting an estimate instead");
      expect(warned, String(figure)).toHaveLength(1);
      // The line says what would have been believed. The figure itself, from a file a job can write, is not logged.
      expect(warned[0], String(figure)).toMatchObject({ level: "warn", ideaId: idea.id, backend: "kiro-crew", mostBelieved: 30 });
      expect(Object.keys(warned[0] ?? {}).sort(), String(figure)).toEqual(["at", "backend", "ideaId", "level", "message", "mostBelieved", "name"]);
    }

    // With no time to estimate from either, nothing is counted, and the log says so.
    const nothingToGoOn = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits: -1 }]) });
    approvedIdea(nothingToGoOn.store);
    expect((await runBuildNight(nothingToGoOn.deps)).built).toHaveLength(1);
    expect(counted(nothingToGoOn.store).tries).toBe(0);
    expect(nothingToGoOn.lines.filter((line) => line.includes("could not count what a build try cost"))).toHaveLength(1);
  });

  it("believes a figure up to 10 credits for each minute the agent ran, and up to 2 for a try of a few seconds", async () => {
    expect([MOST_CREDITS_PER_AGENT_MINUTE, MOST_CREDITS_FOR_A_SHORT_TRY]).toEqual([10, 2]);
    expect(mostBelievableCredits(3 * MINUTE)).toBe(30);
    expect(mostBelievableCredits(45 * MINUTE + 90 * SECOND)).toBe(465);
    // A short try, no time at all, and a time that is no time: the room a short try gets.
    for (const agentMs of [0, 3 * SECOND, 12 * SECOND, undefined, -5 * MINUTE, Number.NaN, Number.POSITIVE_INFINITY]) expect(mostBelievableCredits(agentMs), String(agentMs)).toBe(2);
    // Never more than the ledger takes, however long the time limit is set.
    expect(mostBelievableCredits(1e12)).toBe(HIGHEST_BUILD_CREDIT_LIMIT);

    const cases: Array<{ credits: number; agentMs: number; counted: { credits: number; estimated: number } }> = [
      // The real builds: 3.09 credits in 139 s, 4.59 in 160 s. Far inside.
      { credits: 3.09, agentMs: 139 * SECOND, counted: { credits: 3.09, estimated: 0 } },
      { credits: 4.59, agentMs: 160 * SECOND, counted: { credits: 4.59, estimated: 0 } },
      // Exactly ten a minute is believed; a tenth of a credit more is not.
      { credits: 30, agentMs: 3 * MINUTE, counted: { credits: 30, estimated: 0 } },
      { credits: 30.1, agentMs: 3 * MINUTE, counted: { credits: 6, estimated: 6 } },
      // A one-line agent job: half a credit in a few seconds.
      { credits: 0.51, agentMs: 6 * SECOND, counted: { credits: 0.51, estimated: 0 } },
      { credits: 2, agentMs: 6 * SECOND, counted: { credits: 2, estimated: 0 } },
      { credits: 2.1, agentMs: 6 * SECOND, counted: { credits: 0.2, estimated: 0.2 } },
      // Nothing used is a figure too.
      { credits: 0, agentMs: 3 * MINUTE, counted: { credits: 0, estimated: 0 } },
    ];
    for (const { credits, agentMs, counted: expected } of cases) {
      const rig = makeRig({ primary: costly("kiro-crew", [{ ok: true, credits, agentMs }]) });
      approvedIdea(rig.store);
      await runBuildNight(rig.deps);
      expect(counted(rig.store), `${credits} credits in ${agentMs} ms`).toEqual({ ...expected, tries: 1 });
    }
  });

  it("is not closed for the month by one figure: the next idea is still built, and so is the next night's", async () => {
    // What one line added to Kiro Crew's usage file did before: the first build's figure was
    // believed, the month (400) was "used up" by it, and nothing was built until the next month.
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" }, primary: costly("kiro-crew", [{ ok: true, credits: HIGHEST_BUILD_CREDIT_LIMIT, agentMs: 3 * MINUTE }]) });
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    expect(await runBuildNight(rig.deps)).toEqual({ built: [first.id, second.id], failed: [], skipped: "" });
    expect(counted(rig.store)).toEqual({ credits: 12, estimated: 12, tries: 2 });
    expect(buildBudget(rig.store, rig.config, rig.clock.now())).toMatchObject({ counted: 12, limit: 400, reached: false });

    // The worst a job can do to the count now: a full-length try (45 minutes and the 90 seconds
    // Kiro Crew is given to stop) with the highest figure that is believed for it. That is one
    // try's worth over the line, which raising the limit opens again.
    const worst = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" }, primary: costly("kiro-crew", [{ ok: true, credits: 465, agentMs: 45 * MINUTE + 90 * SECOND }]) });
    approvedIdea(worst.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const waiting = approvedIdea(worst.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    expect((await runBuildNight(worst.deps)).skipped).toBe("this month's build credits are used up (465 of 400 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
    const raised = { ...worst.deps, config: testConfig(worst.paths.root, { MAX_BUILD_CREDITS_PER_MONTH: "1000" }) };
    expect(buildBudget(worst.store, raised.config, worst.clock.now()).reached).toBe(false);
    expect(await buildOne(waiting.id, raised)).toMatchObject({ ok: true });
  });

  it("counts a build the Mac slept through for the time its agent worked, not as a full-length try, through the real Kiro CLI backend", async () => {
    // The whole way: the real Kiro CLI backend (its program runner is a stand-in), the night, the ledger.
    const rig = makeRig({ fallback: null });
    const stop = new AbortController();
    const mac = clockedSleptWatch(rig.clock);
    const kiroBinary = path.join(tempDir(), "kiro-cli");
    writeFileSync(kiroBinary, "stand-in: never run");
    const { run } = recordingRunner((call) => {
      if (call.args.includes("settings")) return reply("false (global)\n");
      // The agent has worked for two minutes when the lid is closed. The Mac sleeps six hours.
      // When it wakes, the command line's own sleep watch stops the run (here the test does).
      mac.awake(2 * MINUTE);
      mac.asleep(6 * HOUR);
      stop.abort();
      return reply("", { exitCode: null, error: "the program was stopped: this process is stopping" });
    });
    rig.deps.backends.primary = createKiroCliBackend({ paths: rig.paths, logger: rig.deps.logger, now: rig.clock.now, kiroBinary, run, sleptWatch: mac.start });
    rig.deps.signal = stop.signal;
    const idea = approvedIdea(rig.store);

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [idea.id], skipped: "stopped" });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    // 2 credits a minute for 2 minutes and one look of the watch (5 seconds). Before, the six
    // hours were taken for the agent's and cut down to the 45-minute limit: 90 credits, and five
    // tries like it used up the month.
    expect(counted(rig.store)).toEqual({ credits: 4.2, estimated: 4.2, tries: 1 });
    const tries = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "build try counted");
    expect(tries).toHaveLength(1);
    expect(tries[0]).toMatchObject({ backend: "kiro-cli", credits: 4.2, measured: false });
  });

  it("counts an estimate for a figure a job wrote into Kiro Crew's own usage file, through the real Kiro Crew backend", async () => {
    // The whole way: Kiro Crew's files in a made-up home, the backend that reads them, the night, the ledger.
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" }, fallback: null });
    const crew = new FakeCrew(rig.clock);
    crew.installSkill(readFileSync(BUILD_SKILL_FILE, "utf8"));
    crew.runForMs = 3 * MINUTE;
    crew.credits = 4.6;
    crew.onJobEnd = (job) => {
      const workspace = /in the folder (\S+),/.exec(job.message)?.[1] ?? "";
      leaveBuild(workspace, { at: rig.clock.now() });
      // What a job can do from inside the gateway: it reads its own id from Kiro Crew's job list
      // and adds lines to the usage file. One that takes credits away, one that adds 99,995.4.
      const usage = path.join(crew.home, "usage", "tokens");
      mkdirSync(usage, { recursive: true });
      const day = rig.clock.iso().slice(0, 10);
      for (const credits of [-4.6, 99_995.4]) appendFileSync(path.join(usage, `${day}.jsonl`), `${JSON.stringify({ slot: `cron:${job.id}:made-up`, credits })}\n`);
    };
    rig.deps.backends.primary = createKiroCrewBackend({ paths: rig.paths, logger: rig.deps.logger, sandboxMode: "crew", kirocrewBinary: crew.binary, crewHome: crew.home, run: crew.run, now: rig.clock.now, sleep: crew.sleep, timeZone: "America/Boise", postCancel: crew.postCancel });
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [first.id, second.id], failed: [], skipped: "" });
    // Each run: 4.6 real, the line that takes away left out, 99,995.4 added: 100,000 read, not
    // believed for an agent that ran 3 minutes, 6 counted as an estimate.
    expect(counted(rig.store)).toEqual({ credits: 12, estimated: 12, tries: 2 });
    expect(rig.lines.filter((line) => line.includes("was not one a build could have used; counting an estimate instead"))).toHaveLength(2);
  });
});

describe("the month's ceiling on build credits (MAX_BUILD_CREDITS_PER_MONTH)", () => {
  /** Put credits in the ledger as if an earlier build had used them. The idea they belong to is not one that waits for a build. */
  function used(rig: Rig, credits: number, at = "2026-10-05T07:10:00.000Z"): string {
    const heardAt = "2026-10-04T22:00:00.000Z";
    const earlier = rig.store.createIdea({ title: "Built earlier", pitch: "p", quote: "q", confidence: 0.9, conversationKey: rig.store.resolveConversation({ uuid: `conv-earlier-${at}` }, heardAt).key, detectorRunId: null }, heardAt);
    rig.store.recordBuildCost({ ideaId: earlier.id, at, backend: "kiro-crew", credits, measured: true });
    return earlier.id;
  }

  it("says where the month stands on the night's first log line", async () => {
    const rig = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "250" } });
    used(rig, 12.3);
    await runBuildNight(rig.deps);
    const started = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.message === "build night started");
    expect(started).toMatchObject({ approved: 0, retries: 0, limit: 2, building: 0, creditsThisMonth: 12.3, creditLimit: 250 });
  });

  it("builds nothing and moves no idea once the month's credits are used up, and says why in core's words", async () => {
    const rig = makeRig();
    used(rig, 412.3);
    const idea = approvedIdea(rig.store);
    const before = rig.store.getIdea(idea.id);

    const result = await runBuildNight(rig.deps);
    expect(result).toEqual({
      built: [],
      failed: [],
      skipped: "this month's build credits are used up (412.3 of 400 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised",
    });
    expect(result.skipped).toBe(budgetReachedText(buildBudget(rig.store, rig.config, rig.clock.now()), rig.config.timeZone));
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.fallback.jobs).toHaveLength(0);
    // Not a state change, not a slug, not a folder: the idea waits exactly as it was.
    expect(rig.store.getIdea(idea.id)).toEqual(before);
    expect(readdirSync(rig.paths.workspaces)).toEqual([]);
    expect(counted(rig.store).tries).toBe(1);
    const warned = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.message === "build night stopped early: the month's ceiling on build credits is reached");
    expect(warned).toMatchObject({ level: "warn", built: 0, failed: 0, creditsThisMonth: 412.3, creditLimit: 400 });
  });

  it("is reached at exactly the limit, and not one tenth of a credit before", async () => {
    const at = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "50" } });
    used(at, 50);
    approvedIdea(at.store);
    expect((await runBuildNight(at.deps)).built).toEqual([]);
    expect(at.primary.jobs).toHaveLength(0);

    const under = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "50" } });
    used(under, 49.9);
    const idea = approvedIdea(under.store);
    expect((await runBuildNight(under.deps)).built).toEqual([idea.id]);
  });

  it("is asked before each idea and never during one: the build that takes the month over the line finishes, the next one waits", async () => {
    const rig = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "5", MAX_BUILDS_PER_NIGHT: "5" }, primary: costly("kiro-crew", [{ ok: true, credits: 6.5, agentMs: 3 * MINUTE }]) });
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    const third = approvedIdea(rig.store, { title: "App C", approvedAt: "2026-10-09T19:00:00.000Z" });

    const result = await runBuildNight(rig.deps);
    expect(result.built).toEqual([first.id]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBe("this month's build credits are used up (6.5 of 5 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
    expect(rig.primary.jobs.map((job) => job.ideaId)).toEqual([first.id]);
    for (const waiting of [second, third]) expect(rig.store.getIdea(waiting.id)).toMatchObject({ state: "approved", slug: null });

    // The next month they are built.
    rig.clock.set("2026-11-01T08:00:00.000Z");
    expect((await runBuildNight(rig.deps)).built).toEqual([second.id]);
  });

  it("does not count last month's credits, or next month's", async () => {
    const rig = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "10" } });
    // The last moment of September in Boise, and the first of November.
    used(rig, 500, "2026-10-01T05:59:59.999Z");
    used(rig, 500, "2026-11-01T06:00:00.000Z");
    const idea = approvedIdea(rig.store);
    expect((await runBuildNight(rig.deps)).built).toEqual([idea.id]);
  });

  it("never builds when the limit is 0, and says that the setting is why", async () => {
    const rig = makeRig({ config: { MAX_BUILD_CREDITS_PER_MONTH: "0" } });
    const idea = approvedIdea(rig.store);
    const result = await runBuildNight(rig.deps);
    expect(result).toEqual({ built: [], failed: [], skipped: "MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built: approved ideas wait until it is raised" });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)?.state).toBe("approved");
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: result.skipped });
  });

  it("says nothing about the month when nothing is waiting, or when the night's own limit already stops it", async () => {
    const nothing = makeRig();
    used(nothing, 412.3);
    expect((await runBuildNight(nothing.deps)).skipped).toBe(SKIPPED_NOTHING_APPROVED);

    const full = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "0" } });
    used(full, 412.3);
    approvedIdea(full.store);
    expect((await runBuildNight(full.deps)).skipped).toBe("1 approved idea waits for another night (limit 0 a night)");
  });

  it("builds anyway when the ledger cannot be read, and logs the error: a fault in the ceiling must not cost a night", async () => {
    const rig = makeRig({ config: { MAX_BUILDS_PER_NIGHT: "5" } });
    used(rig, 412.3);
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });
    const read = vi.spyOn(rig.store, "buildCreditsBetween").mockImplementation(() => {
      throw new Error("made-up ledger failure");
    });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [first.id, second.id], failed: [], skipped: "" });
    // Once for the night's first line (which then serves the first idea), once before the second idea.
    expect(read).toHaveBeenCalledTimes(2);
    const errors = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).filter((entry) => entry.message === "could not read the build budget; building anyway");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ level: "error", error: "made-up ledger failure" });
    // The first line leaves the figure out and still names the limit.
    const started = rig.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.message === "build night started");
    expect(started).toMatchObject({ creditLimit: 400 });
    expect(started).not.toHaveProperty("creditsThisMonth");
  });

  it("build-now refuses with the same sentence, and starts nothing", async () => {
    const rig = makeRig();
    used(rig, 412.3);
    const idea = approvedIdea(rig.store);
    const outcome = await buildOne(idea.id, rig.deps);
    expect(outcome).toEqual({
      ok: false,
      backend: "kiro-crew",
      ms: 0,
      reason: "this month's build credits are used up (412.3 of 400 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised",
      couldNotStart: true,
    });
    expect(rig.primary.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "approved", slug: null });
    expect(rig.lines.join("\n")).toContain("build-now refused: the month's ceiling on build credits is reached");
  });

  it("build-now says paused before it says anything about the month, and builds when the ledger cannot be read", async () => {
    const paused = makeRig();
    used(paused, 412.3);
    const waiting = approvedIdea(paused.store);
    paused.store.setPaused(true, paused.clock.iso());
    expect(await buildOne(waiting.id, paused.deps)).toMatchObject({ ok: false, reason: expect.stringContaining("paused") });

    const rig = makeRig();
    used(rig, 412.3);
    const idea = approvedIdea(rig.store);
    vi.spyOn(rig.store, "buildCreditsBetween").mockImplementation(() => {
      throw new Error("made-up ledger failure");
    });
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: true, backend: "kiro-crew" });
    expect(rig.lines.join("\n")).toContain("could not read the build budget; building anyway");
  });
});
