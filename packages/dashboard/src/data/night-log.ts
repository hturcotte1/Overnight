// From log lines to the night's ticks. Pure: lines in, facts out.
//
// The seven main steps of an idea come from the database. The smaller ticks under them (sign-in
// fresh, sandbox check passed, building, checked, pushed, live, sent to the wrist) are only
// written down in build.log and deliver.log, by packages that do not know the dashboard exists.
// src/log-messages.ts holds the texts of the lines read here, and a test pins each of them to
// the file that logs it.
//
// The rules:
//   - Only lines logged under the name "build" count in build.log, and "deliver" in deliver.log.
//     (Preflight writes its own sandbox check into build.log under the name "preflight".)
//   - A message that is not in the table is ignored, so new log lines break nothing.
//   - A run opens at a run-start line and closes at the next run-end or run-start line.
//   - One build runs at a time, so a sign-in or sandbox line, which names no idea, belongs to the
//     idea whose "build started" came last and has not ended.
//   - From a line, only numbers, yes/no values, ids and a few fixed words are taken.
import { HAND_RUN_NAMES, LOG_MESSAGES, matchLogMessage, SKIPPED_VALUES } from "../log-messages.ts";
import { IDEA_ID } from "../types.ts";
import type { Backend, BuildFacts, BuildRun, DeliverFacts, DeliverRun, RunCommand } from "../types.ts";
import type { LogLine } from "./logs.ts";

type Fields = LogLine["fields"];

/** A number that is zero or more, or null. */
function amount(fields: Fields, name: string): number | null {
  const value = fields[name];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function yesNo(fields: Fields, name: string): boolean | null {
  const value = fields[name];
  return typeof value === "boolean" ? value : null;
}

/** The idea a line is about, if it names one in the shape of an idea id. */
function ideaIdOf(line: LogLine): string | null {
  const value = line.fields.ideaId;
  return typeof value === "string" && IDEA_ID.test(value) ? value : null;
}

/** Which command a line like "overnight build-now: build starting" came from: what stands before the known ending. */
function handCommand(message: string, ending: string): RunCommand {
  const name = message.slice(0, message.length - ending.length);
  if (name === HAND_RUN_NAMES["build-now"]) return "build-now";
  if (name === HAND_RUN_NAMES.rehearse) return "rehearse";
  return "unknown";
}

function addOnce(ids: string[], id: string): void {
  if (!ids.includes(id)) ids.push(id);
}

/**
 * build.log: the runs of the build command, oldest first, and for each idea the ticks of its
 * latest build. A tail that starts in the middle of a run gives a run whose command is "unknown"
 * until the line that ends it says which it was.
 */
export function readBuildLog(lines: readonly LogLine[]): { runs: BuildRun[]; byIdea: Map<string, BuildFacts> } {
  const runs: BuildRun[] = [];
  const byIdea = new Map<string, BuildFacts>();
  let open: BuildRun | null = null;
  /** The idea being built: the one whose "build started" came last and has not ended. */
  let current: string | null = null;

  /** The ideas whose ticks were started in the open run. Ticks from an earlier run are an earlier build's. */
  let startedHere = new Set<string>();

  const start = (command: RunCommand, at: string): BuildRun => {
    const run: BuildRun = { command, startedAt: at, finishedAt: null, waiting: null, taking: null, built: null, failed: null, paused: false, nothingApproved: false, sandboxCheck: null, ideaIds: [] };
    runs.push(run);
    open = run;
    current = null;
    startedHere = new Set();
    return run;
  };
  const runAt = (at: string): BuildRun => open ?? start("unknown", at);
  const newFacts = (id: string, at: string): BuildFacts => {
    const run = runAt(at);
    addOnce(run.ideaIds, id);
    startedHere.add(id);
    const facts: BuildFacts = { startedAt: at, by: run.command, signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: null };
    byIdea.set(id, facts);
    return facts;
  };
  /** The facts of the idea a line names (or, when it names none, of the idea being built). */
  const factsOf = (line: LogLine): BuildFacts | null => {
    const id = ideaIdOf(line) ?? current;
    if (id === null) return null;
    runAt(line.at);
    const known = byIdea.get(id);
    // No "build started" seen for it in this run: the part of the log we read began after that line.
    return known !== undefined && startedHere.has(id) ? known : newFacts(id, line.at);
  };
  const end = (command: RunCommand, line: LogLine): BuildRun | null => {
    const run = open;
    if (run === null) return null;
    if (run.command === "unknown") run.command = command;
    for (const id of run.ideaIds) {
      const facts = byIdea.get(id);
      if (facts !== undefined && facts.by === "unknown") facts.by = run.command;
    }
    run.finishedAt = line.at;
    open = null;
    current = null;
    return run;
  };
  const signIn = (line: LogLine, status: NonNullable<BuildFacts["signIn"]>["status"]): void => {
    if (current === null) return;
    const facts = byIdea.get(current);
    if (facts !== undefined) facts.signIn = { at: line.at, status, minutesLeft: status === "ready" ? amount(line.fields, "minutesLeft") : null };
  };
  const sandbox = (line: LogLine, ok: boolean): void => {
    const check = { at: line.at, ok, ms: amount(line.fields, "ms"), reused: false };
    runAt(line.at).sandboxCheck = check;
    const facts = current === null ? undefined : byIdea.get(current);
    if (facts !== undefined) facts.sandboxCheck = { ...check };
  };
  const agent = (line: LogLine, backend: Backend): void => {
    const facts = factsOf(line);
    if (facts === null) return;
    facts.agentStarted = { at: line.at, backend };
    // The sandbox is checked once per run. A later Kiro Crew build of the same run relies on that check.
    const earlier = open?.sandboxCheck ?? null;
    if (backend === "kiro-crew" && facts.sandboxCheck === null && earlier !== null) facts.sandboxCheck = { ...earlier, reused: true };
  };
  const finish = (line: LogLine, ok: boolean): void => {
    const facts = factsOf(line);
    if (facts === null) return;
    facts.finished = { at: line.at, ok, seconds: amount(line.fields, "seconds"), credits: ok ? amount(line.fields, "credits") : null };
    if (current === (ideaIdOf(line) ?? current)) current = null;
  };

  for (const line of lines) {
    if (line.name !== "build") continue;
    switch (matchLogMessage("build", line.message)) {
      case "buildRunStart":
        start("build", line.at);
        break;
      case "handRunStart": {
        const run = start(handCommand(line.message, LOG_MESSAGES.handRunStart.text), line.at);
        const id = ideaIdOf(line);
        if (id !== null) addOnce(run.ideaIds, id);
        break;
      }
      case "nightStart": {
        const run = runAt(line.at);
        const approved = amount(line.fields, "approved");
        const retries = amount(line.fields, "retries");
        run.waiting = approved === null && retries === null ? null : (approved ?? 0) + (retries ?? 0);
        run.taking = amount(line.fields, "building");
        break;
      }
      case "nightPaused":
        runAt(line.at).paused = true;
        break;
      case "nightEnd": {
        const run = runAt(line.at);
        run.built = amount(line.fields, "built") ?? run.built;
        run.failed = amount(line.fields, "failed") ?? run.failed;
        break;
      }
      case "ideaStart": {
        const id = ideaIdOf(line);
        if (id === null) break;
        newFacts(id, line.at);
        current = id;
        break;
      }
      case "signInReady":
        signIn(line, "ready");
        break;
      case "signInWaiting":
        signIn(line, "waiting");
        break;
      case "signedOut":
        signIn(line, "signed-out");
        break;
      case "signInUnknown":
        signIn(line, "unknown");
        break;
      case "sandboxPassed":
        sandbox(line, true);
        break;
      case "sandboxFailed":
        sandbox(line, false);
        break;
      case "crewStarted":
        agent(line, "kiro-crew");
        break;
      case "cliStarted":
        agent(line, "kiro-cli");
        break;
      case "fallback": {
        const facts = factsOf(line);
        if (facts !== null) facts.fellBack = { at: line.at };
        break;
      }
      case "ideaBuilt":
        finish(line, true);
        break;
      case "ideaFailed":
        finish(line, false);
        break;
      case "buildRunEnd": {
        const run = end("build", line);
        if (run === null) break;
        run.built = amount(line.fields, "built") ?? run.built;
        run.failed = amount(line.fields, "failed") ?? run.failed;
        // The only use of this text: is it one of the two fixed words?
        run.paused = run.paused || line.fields.skipped === SKIPPED_VALUES.paused;
        run.nothingApproved = line.fields.skipped === SKIPPED_VALUES.nothingApproved;
        break;
      }
      case "handRunEnd": {
        const run = end(handCommand(line.message, LOG_MESSAGES.handRunEnd.text), line);
        const ok = yesNo(line.fields, "ok");
        if (run === null || ok === null) break;
        run.built = ok ? 1 : 0;
        run.failed = ok ? 0 : 1;
        break;
      }
      default:
        // Not a line the dashboard knows, or one that belongs to the other log.
        break;
    }
  }
  return { runs, byIdea };
}

/** A failed check's step is passed on only as a short lower-case word; the pages show their own words for it. */
export const STEP_NAME = /^[a-z-]{1,20}$/;

/**
 * deliver.log: the runs of the deliver command, oldest first, and for each idea the ticks of its
 * latest delivery. A delivery always starts by checking the app, so a "verified" or "did not
 * pass" line starts an idea's ticks afresh.
 */
export function readDeliverLog(lines: readonly LogLine[]): { runs: DeliverRun[]; byIdea: Map<string, DeliverFacts> } {
  const runs: DeliverRun[] = [];
  const byIdea = new Map<string, DeliverFacts>();
  let open: DeliverRun | null = null;

  const start = (command: RunCommand, at: string): DeliverRun => {
    const run: DeliverRun = { command, startedAt: at, finishedAt: null, delivered: null, failed: null, notified: null, ideaIds: [] };
    runs.push(run);
    open = run;
    return run;
  };
  const runAt = (at: string): DeliverRun => open ?? start("unknown", at);
  const end = (command: RunCommand, line: LogLine): DeliverRun | null => {
    const run = open;
    if (run === null) return null;
    if (run.command === "unknown") run.command = command;
    run.finishedAt = line.at;
    open = null;
    return run;
  };
  /** The idea's ticks so far, or a new set. `afresh`: this line is the first step of a new delivery. */
  const factsOf = (line: LogLine, afresh = false): DeliverFacts | null => {
    const id = ideaIdOf(line);
    if (id === null) return null;
    addOnce(runAt(line.at).ideaIds, id);
    const known = byIdea.get(id);
    if (known !== undefined && !afresh) return known;
    const facts: DeliverFacts = { firstAt: line.at, checked: null, pushed: null, live: null, told: null, fact: null };
    byIdea.set(id, facts);
    return facts;
  };

  for (const line of lines) {
    if (line.name !== "deliver") continue;
    switch (matchLogMessage("deliver", line.message)) {
      case "deliverRunStart":
        // The nightly job. A run's command is one of the build commands' names, and "build" stands for the nightly one.
        start("build", line.at);
        break;
      case "handDeliverStart": {
        const run = start(handCommand(line.message, LOG_MESSAGES.handDeliverStart.text), line.at);
        const id = ideaIdOf(line);
        if (id !== null) addOnce(run.ideaIds, id);
        break;
      }
      case "verified": {
        const facts = factsOf(line, true);
        if (facts !== null) facts.checked = { at: line.at, ok: true, ms: amount(line.fields, "ms"), files: amount(line.fields, "files"), bytes: amount(line.fields, "bytes"), step: null };
        break;
      }
      case "notVerified": {
        const facts = factsOf(line, true);
        const step = line.fields.step;
        if (facts !== null) facts.checked = { at: line.at, ok: false, ms: amount(line.fields, "ms"), files: null, bytes: null, step: typeof step === "string" && STEP_NAME.test(step) ? step : null };
        break;
      }
      case "pushed": {
        const facts = factsOf(line);
        if (facts !== null) facts.pushed = { at: line.at };
        break;
      }
      case "live": {
        const facts = factsOf(line);
        if (facts !== null) facts.live = { at: line.at, seen: true, liveAfterMs: amount(line.fields, "liveAfterMs") };
        break;
      }
      case "notSeenLive": {
        const facts = factsOf(line);
        if (facts !== null) facts.live = { at: line.at, seen: false, liveAfterMs: null };
        break;
      }
      case "told": {
        const facts = factsOf(line);
        if (facts !== null) facts.told = { at: line.at, what: "built" };
        break;
      }
      case "toldFailure": {
        const facts = factsOf(line);
        if (facts !== null) facts.told = { at: line.at, what: "could-not-finish" };
        break;
      }
      case "fact": {
        const facts = factsOf(line);
        if (facts !== null) facts.fact = { at: line.at };
        break;
      }
      case "deliverRunEnd": {
        const run = end("build", line);
        if (run === null) break;
        run.delivered = amount(line.fields, "delivered");
        run.failed = amount(line.fields, "failed");
        run.notified = amount(line.fields, "notified");
        break;
      }
      case "handDeliverEnd": {
        const run = end(handCommand(line.message, LOG_MESSAGES.handDeliverEnd.text), line);
        const ok = yesNo(line.fields, "ok");
        if (run === null || ok === null) break;
        run.delivered = ok ? 1 : 0;
        run.failed = ok ? 0 : 1;
        break;
      }
      default:
        break;
    }
  }
  return { runs, byIdea };
}
