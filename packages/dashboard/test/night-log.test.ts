// SYNTHETIC: every id, number and path in these log lines is made up. None of it is Bee data.
//
// From log lines to the night's ticks. Every line is written by core's own logger with the
// texts in src/log-messages.ts (which another test pins to the packages that log them), then
// read back from the file the way the dashboard reads it.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "@overnight/core";
import type { Logger } from "@overnight/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogTail } from "../src/data/logs.ts";
import type { LogLine } from "../src/data/logs.ts";
import { readBuildLog, readDeliverLog } from "../src/data/night-log.ts";
import { HAND_RUN_NAMES, LOG_MESSAGES as M } from "../src/log-messages.ts";

const A = "idea_20261010_aaaa1111";
const B = "idea_20261010_bbbb2222";
/** 1:00 AM in America/Boise on Oct 11. */
const START = Date.parse("2026-10-11T07:00:00.000Z");
const SANDBOX_PASSED = `${M.sandboxPassed.text}: the Keychain, Bee and the rest are out of reach of a job`;
const SANDBOX_FAILED = `${M.sandboxFailed.text}: nothing will be built with Kiro Crew`;

let scratch: string;
let seconds: number;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard night-log "));
  seconds = 0;
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The time of the line written `n` seconds into the invented night. */
function t(n: number): string {
  return new Date(START + n * 1000).toISOString();
}

/** A logger like a night job's. Every line it writes is one second after the one before. */
function job(log: "build" | "deliver", name: string = log): Logger {
  return createLogger({ name, file: path.join(scratch, `${log}.log`), write: () => {}, now: () => new Date(START + seconds++ * 1000) });
}

function lines(log: "build" | "deliver"): LogLine[] {
  return readLogTail(path.join(scratch, `${log}.log`));
}

/** One whole Kiro Crew build of an idea, as the builder logs it. `check`: the sandbox check is logged (first Crew build of a run only). */
function crewBuild(logger: Logger, id: string, check: boolean, more: { credits?: number } = {}): void {
  logger.info(M.ideaStart.text, { ideaId: id, backend: "kiro-crew" });
  logger.info(M.signInReady.text, { minutesLeft: 47, waitedSeconds: 0 });
  if (check) logger.info(SANDBOX_PASSED, { ms: 7100 });
  logger.child({ backend: "kiro-crew" }).info(M.crewStarted.text, { ideaId: id, jobId: "job-1", timeoutSecs: 2700 });
  logger.info(M.ideaBuilt.text, { ideaId: id, backend: "kiro-crew", seconds: 160, credits: more.credits ?? 4.59 });
}

describe("build.log", () => {
  it("reads a Kiro Crew night with two ideas; the second relies on the first one's sandbox check", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, { primary: "kiro-crew", fallback: "kiro-cli", sandboxMode: "overnight", dataDir: "/Users/sam/.overnight" }); // 0
    logger.info(M.nightStart.text, { approved: 2, retries: 1, alreadyStartedToday: 0, limit: 5, building: 2 }); // 1
    crewBuild(logger, A, true); // 2 to 6
    crewBuild(logger, B, false, { credits: 3.09 }); // 7 to 10
    logger.info(M.nightEnd.text, { built: 2, failed: 0, leftForAnotherNight: 1 }); // 11
    logger.info(M.buildRunEnd.text, { built: 2, failed: 0, skipped: "1 approved idea waits for another night (limit 2 a night)" }); // 12

    const { runs, byIdea } = readBuildLog(lines("build"));
    expect(runs).toEqual([
      { command: "build", startedAt: t(0), finishedAt: t(12), waiting: 3, taking: 2, built: 2, failed: 0, paused: false, nothingApproved: false, sandboxCheck: { at: t(4), ok: true, ms: 7100, reused: false }, ideaIds: [A, B] },
    ]);
    expect(byIdea.get(A)).toEqual({
      startedAt: t(2),
      by: "build",
      signIn: { at: t(3), status: "ready", minutesLeft: 47 },
      sandboxCheck: { at: t(4), ok: true, ms: 7100, reused: false },
      agentStarted: { at: t(5), backend: "kiro-crew" },
      fellBack: null,
      finished: { at: t(6), ok: true, seconds: 160, credits: 4.59 },
    });
    expect(byIdea.get(B)).toEqual({
      startedAt: t(7),
      by: "build",
      signIn: { at: t(8), status: "ready", minutesLeft: 47 },
      sandboxCheck: { at: t(4), ok: true, ms: 7100, reused: true },
      agentStarted: { at: t(9), backend: "kiro-crew" },
      fellBack: null,
      finished: { at: t(10), ok: true, seconds: 160, credits: 3.09 },
    });
  });

  it("does not hand the Kiro Crew sandbox check on to an idea the Kiro CLI builds", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    crewBuild(logger, A, true);
    logger.info(M.ideaStart.text, { ideaId: B, backend: "kiro-cli" });
    logger.info(M.cliStarted.text, { ideaId: B });
    const { byIdea } = readBuildLog(lines("build"));
    expect(byIdea.get(A)?.sandboxCheck).toMatchObject({ ok: true, reused: false });
    expect(byIdea.get(B)).toMatchObject({ sandboxCheck: null, agentStarted: { backend: "kiro-cli" } });
  });

  it("gives a sign-in or sandbox line to no idea once the build it belonged to has ended", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    crewBuild(logger, A, true); // 1 to 5
    logger.info(M.signedOut.text, {}); // 6
    logger.error(SANDBOX_FAILED, { ms: 5 }); // 7
    const { byIdea, runs } = readBuildLog(lines("build"));
    expect(byIdea.get(A)).toMatchObject({ signIn: { status: "ready" }, sandboxCheck: { ok: true }, finished: { ok: true } });
    // The run still knows its latest check.
    expect(runs[0]?.sandboxCheck).toMatchObject({ at: t(7), ok: false });
  });

  it("knows a paused night from its own line, before the run has said it ended", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.nightPaused.text, { failed: 0 });
    expect(readBuildLog(lines("build")).runs).toMatchObject([{ paused: true, finishedAt: null }]);
  });

  it("shows a build in progress as far as it has got", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.nightStart.text, { approved: 1, retries: 0, limit: 2, building: 1 });
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    let read = readBuildLog(lines("build"));
    expect(read.byIdea.get(A)).toEqual({ startedAt: t(2), by: "build", signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: null });
    expect(read.runs[0]).toMatchObject({ finishedAt: null, built: null, failed: null, ideaIds: [A] });

    logger.info(M.signInReady.text, { minutesLeft: null });
    logger.info(SANDBOX_PASSED, { ms: 6400 });
    logger.info(M.crewStarted.text, { ideaId: A });
    read = readBuildLog(lines("build"));
    expect(read.byIdea.get(A)).toMatchObject({ signIn: { status: "ready", minutesLeft: null }, sandboxCheck: { ok: true, ms: 6400, reused: false }, agentStarted: { at: t(5), backend: "kiro-crew" }, finished: null });
  });

  it("reads a fallback: the first builder failed, the other one built it", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 1
    logger.info(M.signInReady.text, { minutesLeft: 30 }); // 2
    logger.info(SANDBOX_PASSED, { ms: 7000 }); // 3
    logger.info(M.crewStarted.text, { ideaId: A }); // 4
    logger.warn(M.fallback.text, { ideaId: A, backend: "kiro-crew", couldNotStart: false, reason: "REASON-NOT-KEPT", next: "kiro-cli" }); // 5
    logger.info(M.signInReady.text, { minutesLeft: 12 }); // 6
    logger.child({ backend: "kiro-cli" }).info(M.cliStarted.text, { ideaId: A, timeoutMin: 45 }); // 7
    logger.info(M.ideaBuilt.text, { ideaId: A, backend: "kiro-cli", seconds: 400, credits: 0.5 }); // 8
    logger.info(M.buildRunEnd.text, { built: 1, failed: 0 });

    const facts = readBuildLog(lines("build")).byIdea.get(A);
    expect(facts).toEqual({
      startedAt: t(1),
      by: "build",
      signIn: { at: t(6), status: "ready", minutesLeft: 12 },
      sandboxCheck: { at: t(3), ok: true, ms: 7000, reused: false },
      agentStarted: { at: t(7), backend: "kiro-cli" },
      fellBack: { at: t(5) },
      finished: { at: t(8), ok: true, seconds: 400, credits: 0.5 },
    });
    expect(JSON.stringify(facts)).not.toContain("REASON-NOT-KEPT");
  });

  it("reads a sign-in that had to be waited for, and what came of it", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    logger.info(M.signInWaiting.text, { waitSeconds: 95 }); // 2
    expect(readBuildLog(lines("build")).byIdea.get(A)?.signIn).toEqual({ at: t(2), status: "waiting", minutesLeft: null });
    logger.info(M.signInReady.text, { minutesLeft: 59, waitedSeconds: 95 }); // 3
    expect(readBuildLog(lines("build")).byIdea.get(A)?.signIn).toEqual({ at: t(3), status: "ready", minutesLeft: 59 });
  });

  it("reads Kiro being signed out, and a sign-in that could not be checked", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    logger.error(M.signedOut.text, {}); // 2
    logger.warn(M.ideaFailed.text, { ideaId: A, backend: "kiro-crew", seconds: 1, reason: "REASON-NOT-KEPT" }); // 3
    logger.info(M.ideaStart.text, { ideaId: B, backend: "kiro-crew" });
    logger.warn(M.signInUnknown.text, {}); // 5
    logger.info(M.buildRunEnd.text, { built: 0, failed: 1 });

    const { byIdea, runs } = readBuildLog(lines("build"));
    expect(byIdea.get(A)).toMatchObject({ signIn: { at: t(2), status: "signed-out", minutesLeft: null }, agentStarted: null, finished: { at: t(3), ok: false, seconds: 1, credits: null } });
    expect(byIdea.get(B)?.signIn).toEqual({ at: t(5), status: "unknown", minutesLeft: null });
    expect(runs[0]).toMatchObject({ built: 0, failed: 1 });
  });

  it("reads a failed sandbox check, for the idea and for the run", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    logger.info(M.signInReady.text, { minutesLeft: 40 });
    logger.error(SANDBOX_FAILED, { reason: "REASON-NOT-KEPT", ms: 9000 }); // 3
    logger.warn(M.ideaFailed.text, { ideaId: A, backend: "kiro-crew", seconds: 9, reason: "REASON-NOT-KEPT" });
    logger.info(M.buildRunEnd.text, { built: 0, failed: 1 });

    const { byIdea, runs } = readBuildLog(lines("build"));
    const check = { at: t(3), ok: false, ms: 9000, reused: false };
    expect(byIdea.get(A)?.sandboxCheck).toEqual(check);
    expect(runs[0]?.sandboxCheck).toEqual(check);
    expect(JSON.stringify([runs, [...byIdea]])).not.toContain("REASON-NOT-KEPT");
  });

  it("ignores what preflight writes into the same file under its own name", () => {
    const preflight = job("build", "preflight");
    preflight.info(SANDBOX_PASSED, { ms: 1 });
    preflight.info(M.buildRunStart.text, {});
    preflight.info(M.ideaStart.text, { ideaId: B, backend: "kiro-crew" });
    const logger = job("build");
    logger.info(M.buildRunStart.text, {}); // 3
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    preflight.info(SANDBOX_FAILED, { ms: 2 });
    logger.info(M.buildRunEnd.text, { built: 0, failed: 0 });

    const { runs, byIdea } = readBuildLog(lines("build"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ startedAt: t(3), sandboxCheck: null, ideaIds: [A] });
    expect(byIdea.get(A)?.sandboxCheck).toBeNull();
    expect(byIdea.has(B)).toBe(false);
  });

  it("ignores lines it does not know, and lines that belong in the other log", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info("a line from a later version of the builder", { ideaId: A, seconds: 5 });
    logger.info(M.verified.text, { ideaId: A, files: 3, bytes: 100, ms: 5 });
    logger.info(M.deliverRunStart.text, {});
    logger.info("kiro crew job ended", { ideaId: A, built: true, credits: 9 });
    logger.info(M.buildRunEnd.text, { built: 0, failed: 0, skipped: "nothing approved" });
    const { runs, byIdea } = readBuildLog(lines("build"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: "build", ideaIds: [], nothingApproved: true, paused: false });
    expect(byIdea.size).toBe(0);
  });

  it("reads a night that was skipped because Overnight is paused", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.nightPaused.text, { failed: 0 });
    logger.info(M.buildRunEnd.text, { built: 0, failed: 0, skipped: "paused" });
    expect(readBuildLog(lines("build")).runs).toEqual([
      { command: "build", startedAt: t(0), finishedAt: t(2), waiting: null, taking: null, built: 0, failed: 0, paused: true, nothingApproved: false, sandboxCheck: null, ideaIds: [] },
    ]);
  });

  it("reads why nothing was built only as one of two fixed words", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.buildRunEnd.text, { built: 0, failed: 0, skipped: "nothing approved" });
    logger.info(M.buildRunStart.text, {});
    logger.info(M.buildRunEnd.text, { built: 1, failed: 0, skipped: "2 approved ideas wait for another night (limit 2 a night)" });
    logger.info(M.buildRunStart.text, {});
    logger.info(M.buildRunEnd.text, { built: 0, failed: 0, skipped: "paused" });
    expect(readBuildLog(lines("build")).runs.map((run) => [run.paused, run.nothingApproved])).toEqual([
      [false, true],
      [false, false],
      [true, false],
    ]);
  });

  it("tells a build-now run and a rehearsal run from the nightly one", () => {
    const logger = job("build");
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handRunStart.text}`, { ideaId: A, primary: "kiro-crew", fallback: "kiro-cli", sandboxMode: "overnight" }); // 0
    crewBuild(logger, A, true); // 1 to 5
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handRunEnd.text}`, { ideaId: A, ok: true, backend: "kiro-crew", ms: 160000 }); // 6
    logger.info(`${HAND_RUN_NAMES.rehearse}${M.handRunStart.text}`, { ideaId: B }); // 7
    logger.info(M.ideaStart.text, { ideaId: B, backend: "kiro-cli" }); // 8
    logger.info(M.cliStarted.text, { ideaId: B }); // 9
    logger.warn(M.ideaFailed.text, { ideaId: B, backend: "kiro-cli", seconds: 30 }); // 10
    logger.info(`${HAND_RUN_NAMES.rehearse}${M.handRunEnd.text}`, { ideaId: B, ok: false, backend: "kiro-cli", ms: 30000 }); // 11
    logger.info(`overnight some-later-command${M.handRunStart.text}`, { ideaId: A }); // 12

    const { runs, byIdea } = readBuildLog(lines("build"));
    expect(runs.map((run) => [run.command, run.startedAt, run.finishedAt, run.built, run.failed, run.ideaIds])).toEqual([
      ["build-now", t(0), t(6), 1, 0, [A]],
      ["rehearse", t(7), t(11), 0, 1, [B]],
      ["unknown", t(12), null, null, null, [A]],
    ]);
    expect(byIdea.get(A)?.by).toBe("build-now");
    expect(byIdea.get(B)).toMatchObject({ by: "rehearse", agentStarted: { backend: "kiro-cli" }, sandboxCheck: null, finished: { ok: false, seconds: 30, credits: null } });
  });

  it("does not take one idea being built for a run by hand ending, nor the other way round", () => {
    const logger = job("build");
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handRunStart.text}`, { ideaId: A });
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    logger.info(M.ideaBuilt.text, { ideaId: A, backend: "kiro-crew", seconds: 100, credits: 2 });
    // The idea is built; the run has not said it is over.
    const middle = readBuildLog(lines("build"));
    expect(middle.runs[0]?.finishedAt).toBeNull();
    expect(middle.byIdea.get(A)?.finished?.ok).toBe(true);
  });

  it("keeps a run open that never said it ended, and starts the next one all the same", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {}); // 0
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 1
    logger.info(SANDBOX_PASSED, { ms: 7000 }); // 2
    // The Mac was restarted here. The next night:
    logger.info(M.buildRunStart.text, {}); // 3
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 4
    logger.info(M.signInReady.text, { minutesLeft: 50 }); // 5
    logger.info(M.crewStarted.text, { ideaId: A }); // 6

    const { runs, byIdea } = readBuildLog(lines("build"));
    expect(runs.map((run) => [run.startedAt, run.finishedAt, run.ideaIds])).toEqual([
      [t(0), null, [A]],
      [t(3), null, [A]],
    ]);
    // The ticks are the latest build's, and the earlier run's sandbox check is not handed on to it.
    expect(byIdea.get(A)).toEqual({ startedAt: t(4), by: "build", signIn: { at: t(5), status: "ready", minutesLeft: 50 }, sandboxCheck: null, agentStarted: { at: t(6), backend: "kiro-crew" }, fellBack: null, finished: null });
  });

  it("keeps only the latest build of an idea that was built twice", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {});
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" });
    logger.info(M.signInReady.text, { minutesLeft: 10 });
    logger.warn(M.ideaFailed.text, { ideaId: A, backend: "kiro-crew", seconds: 5 });
    logger.info(M.buildRunEnd.text, { built: 0, failed: 1 });
    logger.info(M.buildRunStart.text, {}); // 5
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 6
    expect(readBuildLog(lines("build")).byIdea.get(A)).toEqual({ startedAt: t(6), by: "build", signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: null });
  });

  it("reads the end of a log that starts in the middle of a run", () => {
    const logger = job("build");
    logger.info(M.buildRunStart.text, {}); // 0
    logger.info(M.nightStart.text, { approved: 2, retries: 0, limit: 2, building: 2 }); // 1
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 2
    logger.info(M.signInReady.text, { minutesLeft: 47 }); // 3
    logger.info(SANDBOX_PASSED, { ms: 7100 }); // 4
    logger.info(M.crewStarted.text, { ideaId: A }); // 5
    logger.info(M.ideaBuilt.text, { ideaId: A, backend: "kiro-crew", seconds: 160, credits: 4.59 }); // 6
    logger.info(M.ideaStart.text, { ideaId: B, backend: "kiro-crew" }); // 7
    logger.info(M.crewStarted.text, { ideaId: B }); // 8
    logger.info(M.ideaBuilt.text, { ideaId: B, backend: "kiro-crew", seconds: 90, credits: 2 }); // 9
    logger.info(M.buildRunEnd.text, { built: 2, failed: 0 }); // 10

    // Only from "kiro crew build started" for A on: the start of the run has scrolled away.
    const all = lines("build");
    const { runs, byIdea } = readBuildLog(all.slice(5));
    expect(runs).toEqual([
      { command: "build", startedAt: t(5), finishedAt: t(10), waiting: null, taking: null, built: 2, failed: 0, paused: false, nothingApproved: false, sandboxCheck: null, ideaIds: [A, B] },
    ]);
    expect(byIdea.get(A)).toEqual({ startedAt: t(5), by: "build", signIn: null, sandboxCheck: null, agentStarted: { at: t(5), backend: "kiro-crew" }, fellBack: null, finished: { at: t(6), ok: true, seconds: 160, credits: 4.59 } });
    expect(byIdea.get(B)).toMatchObject({ startedAt: t(7), by: "build", finished: { ok: true, seconds: 90 } });

    // Only the very last line: there is no run to end.
    expect(readBuildLog(all.slice(10))).toEqual({ runs: [], byIdea: new Map() });
    // Still going, and the start was never seen: nobody can say which command it is.
    const open = readBuildLog(all.slice(5, 9));
    expect(open.runs.map((run) => [run.command, run.finishedAt])).toEqual([["unknown", null]]);
    expect(open.byIdea.get(B)?.by).toBe("unknown");
  });

  it("reads a real file with a partial first line, junk, a line of a megabyte and fields of the wrong kind in it", () => {
    const file = path.join(scratch, "build.log");
    const logger = job("build");
    logger.info(M.buildRunStart.text, { dataDir: "/Users/sam/.overnight" }); // 0
    logger.info(M.ideaStart.text, { ideaId: A, backend: "kiro-crew" }); // 1
    const good = readFileSync(file, "utf8");
    writeFileSync(file, `ld started","ideaId":"${B}"}\n${good}`);
    appendFileSync(file, "this line is not JSON\n");
    appendFileSync(file, `${JSON.stringify({ at: t(50), level: "info", name: "build", message: M.ideaStart.text, ideaId: B, filler: "x".repeat(1024 * 1024) })}\n`);
    appendFileSync(file, `${JSON.stringify({ at: t(51), level: "info", name: "build", message: M.signInReady.text, minutesLeft: "plenty" })}\n`);
    appendFileSync(file, `${JSON.stringify({ at: t(52), level: "info", name: "build", message: SANDBOX_PASSED, ms: -4 })}\n`);
    appendFileSync(file, `${JSON.stringify({ at: t(53), level: "info", name: "build", message: M.ideaBuilt.text, ideaId: A, seconds: "160", credits: { amount: 4 } })}\n`);
    appendFileSync(file, `${JSON.stringify({ at: t(54), level: "info", name: "build", message: M.ideaStart.text, ideaId: "../../not-an-id", backend: "kiro-crew" })}\n`);
    appendFileSync(file, `${JSON.stringify({ at: t(55), level: "info", name: "build", message: M.buildRunEnd.text, built: "two", failed: 1.5 })}\n`);

    const { runs, byIdea } = readBuildLog(readLogTail(file, 4 * 1024 * 1024));
    expect([...byIdea.keys()]).toEqual([A]);
    expect(byIdea.get(A)).toEqual({
      startedAt: t(1),
      by: "build",
      signIn: { at: t(51), status: "ready", minutesLeft: null },
      sandboxCheck: { at: t(52), ok: true, ms: null, reused: false },
      agentStarted: null,
      fellBack: null,
      finished: { at: t(53), ok: true, seconds: null, credits: null },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ startedAt: t(0), finishedAt: t(55), built: null, failed: 1.5, ideaIds: [A] });
    expect(JSON.stringify([runs, [...byIdea]])).not.toContain("/Users/sam");
  });
});

describe("deliver.log", () => {
  /** One whole delivery of an idea, as the deliver step logs it. */
  function delivery(logger: Logger, id: string): void {
    const about = logger.child({ ideaId: id });
    about.info(M.verified.text, { files: 3, bytes: 5602, ms: 6600, usedRegistry: false });
    about.info(M.pushed.text, { files: 3, bytes: 5602 });
    about.info(M.live.text, { liveAfterMs: 26000, looks: 4 });
    logger.info(M.told.text, { ideaId: id, todoId: 77 });
    logger.info(M.fact.text, { ideaId: id, factId: 78 });
  }

  it("reads a morning with one app delivered and one that did not pass its check", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, { dataDir: "/Users/sam/.overnight", timeZone: "America/Boise", deliverTime: "07:00" }); // 0
    delivery(logger, A); // 1 to 5
    logger.child({ ideaId: B }).warn(M.notVerified.text, { step: "contract", ms: 4100 }); // 6
    logger.info(M.toldFailure.text, { ideaId: B, todoId: 79, state: "publish_failed" }); // 7
    logger.info(M.deliverRunEnd.text, { delivered: 1, failed: 2, notified: 3 }); // 8

    const { runs, byIdea } = readDeliverLog(lines("deliver"));
    expect(runs).toEqual([{ command: "build", startedAt: t(0), finishedAt: t(8), delivered: 1, failed: 2, notified: 3, ideaIds: [A, B] }]);
    expect(byIdea.get(A)).toEqual({
      firstAt: t(1),
      checked: { at: t(1), ok: true, ms: 6600, files: 3, bytes: 5602, step: null },
      pushed: { at: t(2) },
      live: { at: t(3), seen: true, liveAfterMs: 26000 },
      told: { at: t(4), what: "built" },
      fact: { at: t(5) },
    });
    expect(byIdea.get(B)).toEqual({
      firstAt: t(6),
      checked: { at: t(6), ok: false, ms: 4100, files: null, bytes: null, step: "contract" },
      pushed: null,
      live: null,
      told: { at: t(7), what: "could-not-finish" },
      fact: null,
    });
    expect(JSON.stringify([runs, [...byIdea]])).not.toMatch(/\/Users\/sam|77|78|79/);
  });

  it("reads a page that was pushed but not seen live before the wait ran out", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, {});
    const about = logger.child({ ideaId: A });
    about.info(M.verified.text, { files: 3, bytes: 100, ms: 5000 });
    about.info(M.pushed.text, {});
    about.warn(M.notSeenLive.text, { waitedMs: 300000, limitMs: 300000 }); // 3
    expect(readDeliverLog(lines("deliver")).byIdea.get(A)).toMatchObject({ pushed: { at: t(2) }, live: { at: t(3), seen: false, liveAfterMs: null }, told: null });
  });

  it("passes on a failed check's step only as a short lower-case word", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, {});
    for (const [id, step] of [[A, "<b>bold</b>"], [B, "app-smoke"]] as const) logger.child({ ideaId: id }).warn(M.notVerified.text, { step, ms: 10 });
    const { byIdea } = readDeliverLog(lines("deliver"));
    expect(byIdea.get(A)?.checked?.step).toBeNull();
    expect(byIdea.get(B)?.checked?.step).toBe("app-smoke");
  });

  it("starts an idea's ticks afresh when it is checked again", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, {});
    logger.child({ ideaId: A }).warn(M.notVerified.text, { step: "build", ms: 900 }); // 1
    logger.info(M.toldFailure.text, { ideaId: A }); // 2
    logger.info(M.deliverRunEnd.text, { delivered: 0, failed: 1, notified: 1 });
    // Built again by hand, and delivered:
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handDeliverStart.text}`, { ideaId: A }); // 4
    logger.child({ ideaId: A }).info(M.verified.text, { files: 4, bytes: 900, ms: 5000 }); // 5
    logger.child({ ideaId: A }).info(M.pushed.text, {}); // 6

    const { runs, byIdea } = readDeliverLog(lines("deliver"));
    expect(byIdea.get(A)).toEqual({ firstAt: t(5), checked: { at: t(5), ok: true, ms: 5000, files: 4, bytes: 900, step: null }, pushed: { at: t(6) }, live: null, told: null, fact: null });
    expect(runs.map((run) => [run.command, run.finishedAt, run.ideaIds])).toEqual([
      ["build", t(3), [A]],
      ["build-now", null, [A]],
    ]);
  });

  it("keeps a run open that never said it ended, and starts the next one all the same", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, {}); // 0
    logger.child({ ideaId: A }).info(M.verified.text, { files: 3, bytes: 100, ms: 5000 }); // 1
    // Cut off here. Later, by hand:
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handDeliverStart.text}`, { ideaId: B }); // 2
    logger.child({ ideaId: B }).info(M.verified.text, { files: 2, bytes: 50, ms: 4000 }); // 3
    logger.info(M.deliverRunStart.text, {}); // 4
    expect(readDeliverLog(lines("deliver")).runs.map((run) => [run.command, run.startedAt, run.finishedAt, run.ideaIds])).toEqual([
      ["build", t(0), null, [A]],
      ["build-now", t(2), null, [B]],
      ["build", t(4), null, []],
    ]);
  });

  it("keeps the ticks of a delivery that was finished by a later run", () => {
    const logger = job("deliver");
    logger.info(M.deliverRunStart.text, {});
    const about = logger.child({ ideaId: A });
    about.info(M.verified.text, { files: 3, bytes: 100, ms: 5000 }); // 1
    about.info(M.pushed.text, {});
    about.info(M.live.text, { liveAfterMs: 21000 });
    logger.info(M.deliverRunEnd.text, { delivered: 0, failed: 0, notified: 0 });
    // Stopped before telling. The next run only tells:
    logger.info(M.deliverRunStart.text, {}); // 5
    logger.info(M.told.text, { ideaId: A }); // 6
    logger.info(M.deliverRunEnd.text, { delivered: 1, failed: 0, notified: 0 });

    const { runs, byIdea } = readDeliverLog(lines("deliver"));
    expect(byIdea.get(A)).toMatchObject({ firstAt: t(1), checked: { ok: true }, live: { liveAfterMs: 21000 }, told: { at: t(6), what: "built" } });
    expect(runs.map((run) => run.ideaIds)).toEqual([[A], [A]]);
  });

  it("tells a build-now run and a rehearsal run from the nightly one", () => {
    const logger = job("deliver");
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handDeliverStart.text}`, { ideaId: A }); // 0
    delivery(logger, A); // 1 to 5
    logger.info(`${HAND_RUN_NAMES["build-now"]}${M.handDeliverEnd.text}`, { ideaId: A, ok: true }); // 6
    logger.info(`${HAND_RUN_NAMES.rehearse}${M.handDeliverStart.text}`, { ideaId: B }); // 7
    logger.child({ ideaId: B }).warn(M.notVerified.text, { step: "install", ms: 100 });
    logger.info(`${HAND_RUN_NAMES.rehearse}${M.handDeliverEnd.text}`, { ideaId: B, ok: false }); // 9
    logger.info(`${HAND_RUN_NAMES.rehearse}: the rehearsal run is over`, { ideaId: B, exitCode: 1, state: "publish_failed" });

    expect(readDeliverLog(lines("deliver")).runs).toEqual([
      { command: "build-now", startedAt: t(0), finishedAt: t(6), delivered: 1, failed: 0, notified: null, ideaIds: [A] },
      { command: "rehearse", startedAt: t(7), finishedAt: t(9), delivered: 0, failed: 1, notified: null, ideaIds: [B] },
    ]);
  });

  it("reads the end of a log that starts in the middle of a run, and ignores other names and unknown lines", () => {
    const other = job("deliver", "preflight");
    other.info(M.verified.text, { ideaId: B, files: 1, bytes: 1, ms: 1 });
    const logger = job("deliver");
    logger.child({ ideaId: A }).info(M.pushed.text, {}); // 1
    logger.info("deliver run finished", { delivered: 1, failed: 0, notified: 0 });
    logger.info(M.ideaStart.text, { ideaId: B });
    logger.info(M.told.text, { ideaId: "not/an/id" });
    logger.info(M.deliverRunEnd.text, { delivered: 1, failed: 0, notified: 0 }); // 5

    const { runs, byIdea } = readDeliverLog(lines("deliver"));
    expect([...byIdea.keys()]).toEqual([A]);
    expect(byIdea.get(A)).toEqual({ firstAt: t(1), checked: null, pushed: { at: t(1) }, live: null, told: null, fact: null });
    expect(runs).toEqual([{ command: "build", startedAt: t(1), finishedAt: t(5), delivered: 1, failed: 0, notified: 0, ideaIds: [A] }]);
  });

  it("has nothing to say about a log with nothing in it", () => {
    expect(readDeliverLog([])).toEqual({ runs: [], byIdea: new Map() });
    expect(readBuildLog([])).toEqual({ runs: [], byIdea: new Map() });
  });
});
