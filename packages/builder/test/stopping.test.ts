// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// What happens when Overnight itself is told to stop in the middle of a night. Here the stop
// arrives as `deps.signal` being aborted (what the command line does on a stop signal); a real
// SIGTERM to a real process is tried in stop-signal.test.ts.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOne, createKiroCliBackend, prepareWorkspace, runBuildNight, SKIPPED_STOPPED, STOPPED_REASON } from "../src/index.ts";
import type { BuildDeps, BuildOutcome } from "../src/index.ts";
import { abortableSleep, createCrewClient } from "../src/crew-client.ts";
import { approvedIdea, collectingLogger, fakeBackend, FakeCrew, leaveBuild, memoryStore, MINUTE, movableClock, recordingRunner, reply, tempDir, testConfig, testPaths } from "./helpers.ts";
import type { FakeBackend, RunCall } from "./helpers.ts";
import type { Store } from "@overnight/core";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function nightRig(primary: FakeBackend = fakeBackend("kiro-crew", ["built"]), fallback: FakeBackend = fakeBackend("kiro-cli", ["built"])) {
  const paths = testPaths();
  const store = memoryStore();
  stores.push(store);
  const clock = movableClock();
  const stop = new AbortController();
  const { logger, lines } = collectingLogger();
  const deps: BuildDeps = { store, config: testConfig(paths.root), paths, backends: { primary, fallback }, logger, now: clock.now, signal: stop.signal };
  return { store, deps, primary, fallback, stop, lines, clock };
}

/** What a real backend answers when it is cut off: whatever it says, the night flow records "stopped". */
const cutOff = (backend: string): BuildOutcome => ({ ok: false, backend, ms: 5, reason: "made-up reason from a backend on its way down", couldNotStart: false });

describe("when Overnight is told to stop during the night", () => {
  it("hands every build the same stop signal, and it is not yet aborted", async () => {
    const rig = nightRig();
    approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    expect(rig.primary.signals).toHaveLength(1);
    expect(rig.primary.signals[0]).toBeInstanceOf(AbortSignal);
    expect(rig.primary.signals[0]?.aborted).toBe(false);
  });

  it("records the build in progress as stopped, and starts no further build", async () => {
    const rig = nightRig(
      fakeBackend("kiro-crew", [
        (_job, options) => {
          rig.stop.abort();
          // The backend sees the stop through the signal it was handed.
          expect(options.signal?.aborted).toBe(true);
          return cutOff("kiro-crew");
        },
      ]),
    );
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [first.id], skipped: SKIPPED_STOPPED });
    expect(SKIPPED_STOPPED).toBe("stopped");
    // Recorded at once, with exactly this reason, so the idea is not left "building".
    expect(rig.store.getIdea(first.id)).toMatchObject({ state: "build_failed", failureReason: "the build was stopped", builtAt: null });
    expect(STOPPED_REASON).toBe("the build was stopped");
    expect(rig.store.ideaEvents(first.id).at(-1)).toMatchObject({ fromState: "building", toState: "build_failed" });
    // The next idea was never started, and the cut-off one was not handed to the other backend.
    expect(rig.store.getIdea(second.id)).toMatchObject({ state: "approved", slug: null });
    expect(rig.primary.jobs).toHaveLength(1);
    expect(rig.fallback.jobs).toHaveLength(0);
  });

  it("keeps a build that had finished when the stop came, and starts no further one", async () => {
    const rig = nightRig(
      fakeBackend("kiro-crew", [
        (job) => {
          rig.stop.abort();
          return fakeBackend("kiro-crew", ["built"]).build(job);
        },
      ]),
    );
    const first = approvedIdea(rig.store, { title: "App A", approvedAt: "2026-10-09T17:00:00.000Z" });
    const second = approvedIdea(rig.store, { title: "App B", approvedAt: "2026-10-09T18:00:00.000Z" });

    expect(await runBuildNight(rig.deps)).toEqual({ built: [first.id], failed: [], skipped: SKIPPED_STOPPED });
    expect(rig.store.getIdea(first.id)?.state).toBe("built");
    expect(rig.store.getIdea(second.id)?.state).toBe("approved");
    expect(rig.primary.jobs).toHaveLength(1);
  });

  it("starts nothing when it is told to stop before the first build", async () => {
    const rig = nightRig();
    const idea = approvedIdea(rig.store);
    rig.stop.abort();
    expect(await runBuildNight(rig.deps)).toEqual({ built: [], failed: [], skipped: SKIPPED_STOPPED });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "approved", slug: null });
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("build-now: records a cut-off build as stopped, with the reason alone", async () => {
    const rig = nightRig(
      fakeBackend("kiro-crew", [
        () => {
          rig.stop.abort();
          return cutOff("kiro-crew");
        },
      ]),
    );
    const idea = approvedIdea(rig.store);

    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: false, backend: "kiro-crew", reason: STOPPED_REASON, couldNotStart: false });
    expect(rig.fallback.jobs).toHaveLength(0);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON });
    // It can be built again later: a stopped build is an ordinary failed one.
    const retry: BuildDeps = { ...rig.deps, signal: new AbortController().signal, backends: { primary: fakeBackend("kiro-crew", ["built"]), fallback: null } };
    expect((await buildOne(idea.id, retry)).ok).toBe(true);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null });
  });

  it("build-now: starts nothing when it is already stopping", async () => {
    const rig = nightRig();
    const idea = approvedIdea(rig.store);
    rig.stop.abort();
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: false, couldNotStart: true, reason: STOPPED_REASON });
    expect(rig.store.getIdea(idea.id)?.state).toBe("approved");
    expect(rig.primary.jobs).toHaveLength(0);
  });

  it("records the stop when it comes during the second try", async () => {
    const rig = nightRig(
      fakeBackend("kiro-crew", ["cannot-start"]),
      fakeBackend("kiro-cli", [
        () => {
          rig.stop.abort();
          return cutOff("kiro-cli");
        },
      ]),
    );
    const idea = approvedIdea(rig.store);
    expect(await buildOne(idea.id, rig.deps)).toMatchObject({ ok: false, backend: "kiro-cli", reason: STOPPED_REASON, couldNotStart: false });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: STOPPED_REASON, buildBackend: "kiro-cli" });
  });

  it("stops listening when the run is over", async () => {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM"), hup: process.listenerCount("SIGHUP") };
    const rig = nightRig(
      fakeBackend("kiro-crew", [
        (job) => {
          // While a build runs, somebody is listening: a stop signal must not just end the process.
          expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before.term);
          expect(process.listenerCount("SIGINT")).toBeGreaterThan(before.int);
          return fakeBackend("kiro-crew", ["built"]).build(job);
        },
      ]),
    );
    const idea = approvedIdea(rig.store);
    await runBuildNight(rig.deps);
    await buildOne(idea.id, rig.deps);
    expect({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM"), hup: process.listenerCount("SIGHUP") }).toEqual(before);
  });
});

describe("the Kiro CLI backend when Overnight is told to stop", () => {
  const settingsOff = (call: RunCall) => (call.args.includes("settings") ? reply("false (global)\n") : null);

  function cliRig() {
    const paths = testPaths();
    const kiroBinary = path.join(tempDir(), "kiro-cli");
    writeFileSync(kiroBinary, "stand-in");
    const job = (id: string) => {
      const prepared = prepareWorkspace({ paths, ideaId: id, brief: "b", now: new Date() });
      return { ideaId: id, workspace: prepared.workspace, briefPath: prepared.briefPath, timeoutMs: 45 * MINUTE };
    };
    return { paths, kiroBinary, job };
  }

  it("hands Kiro's run the stop signal, and calls a cut-off build stopped", async () => {
    const rig = cliRig();
    const stop = new AbortController();
    const runner = recordingRunner((call) => {
      const setting = settingsOff(call);
      if (setting) return setting;
      stop.abort();
      return reply("", { exitCode: null, error: "the program was stopped: this process is stopping" });
    });
    const backend = createKiroCliBackend({ paths: rig.paths, logger: collectingLogger().logger, kiroBinary: rig.kiroBinary, run: runner.run });
    expect(await backend.build(rig.job("idea_cut_off"), { signal: stop.signal })).toMatchObject({ ok: false, couldNotStart: false, reason: STOPPED_REASON });
    const chat = runner.calls.find((call) => call.args.includes("chat"));
    // No grace time: the agent and everything it started is killed at once.
    expect(chat?.options.signal).toBe(stop.signal);
    expect(chat?.options.stopGraceMs).toBeUndefined();
    expect(chat?.options.cleanup).toBeUndefined();
  });

  it("keeps a build that had finished when the stop came", async () => {
    const rig = cliRig();
    const stop = new AbortController();
    const runner = recordingRunner((call) => {
      const setting = settingsOff(call);
      if (setting) return setting;
      leaveBuild(call.options.cwd ?? "");
      stop.abort();
      return reply("", { exitCode: null, error: "the program was stopped: this process is stopping" });
    });
    const backend = createKiroCliBackend({ paths: rig.paths, logger: collectingLogger().logger, kiroBinary: rig.kiroBinary, run: runner.run });
    expect((await backend.build(rig.job("idea_finished"), { signal: stop.signal })).ok).toBe(true);
  });

  it("starts nothing, not even the settings check, when it is already stopping", async () => {
    const rig = cliRig();
    const stop = new AbortController();
    stop.abort();
    const runner = recordingRunner(() => reply());
    const backend = createKiroCliBackend({ paths: rig.paths, logger: collectingLogger().logger, kiroBinary: rig.kiroBinary, run: runner.run });
    expect(await backend.build(rig.job("idea_not_started"), { signal: stop.signal })).toMatchObject({ ok: false, reason: STOPPED_REASON });
    expect(runner.calls).toHaveLength(0);
  });

  it("does not send the brief when the stop comes during the settings check", async () => {
    const rig = cliRig();
    const stop = new AbortController();
    const runner = recordingRunner(() => {
      stop.abort();
      return reply("false (global)\n");
    });
    const backend = createKiroCliBackend({ paths: rig.paths, logger: collectingLogger().logger, kiroBinary: rig.kiroBinary, run: runner.run });
    expect(await backend.build(rig.job("idea_during_check"), { signal: stop.signal })).toMatchObject({ ok: false, reason: STOPPED_REASON });
    expect(runner.calls.some((call) => call.args.includes("chat"))).toBe(false);
  });
});

describe("waiting for a Kiro Crew job when Overnight is told to stop", () => {
  it("stops waiting at the moment of the stop, not at the next look", async () => {
    const clock = movableClock();
    const crew = new FakeCrew(clock);
    crew.runForMs = Number.POSITIVE_INFINITY;
    const stop = new AbortController();
    // The stop comes 20 seconds in, in the middle of a 60-second wait between looks.
    const sleep = async (ms: number): Promise<void> => {
      const left = 20_000 - (clock.ms() - Date.parse("2026-10-10T07:00:00.000Z"));
      if (left <= ms) {
        clock.advance(Math.max(0, left));
        stop.abort();
        return;
      }
      await crew.sleep(ms);
    };
    const client = createCrewClient({ binary: crew.binary, crewHome: crew.home, crewHomeIsExplicit: true, run: crew.run, logger: collectingLogger().logger, now: clock.now, sleep, pollMs: 60_000, tmpDir: tempDir() });
    const added = await client.addJob("overnight-build-idea_x", "made-up message", []);
    if (!added.ok) throw new Error("the stand-in refused the job");
    const triggered = await client.trigger(added.id);
    if (!triggered.ok) throw new Error("the stand-in refused the trigger");
    expect(await client.waitUntilFinished(added.id, triggered.triggeredAtMs, triggered.triggeredAtMs + 45 * MINUTE, stop.signal)).toEqual({ finished: false, stopped: true });
    expect(clock.ms() - triggered.triggeredAtMs).toBe(20_000);
  });

  it("the real sleep between looks ends as soon as the stop comes", async () => {
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 50);
    await abortableSleep(30_000, stop.signal);
    expect(Date.now() - started).toBeLessThan(2_000);

    // Already stopped: no waiting at all. And without a signal it is an ordinary sleep.
    const again = Date.now();
    await abortableSleep(30_000, stop.signal);
    expect(Date.now() - again).toBeLessThan(200);
    const plain = Date.now();
    await abortableSleep(30);
    expect(Date.now() - plain).toBeGreaterThanOrEqual(25);
  });
});
