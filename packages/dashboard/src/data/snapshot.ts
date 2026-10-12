// One look at everything a page needs: the database, the three locks and the ends of the two
// job logs. Nothing is kept open between looks, and nothing here writes or throws.
import path from "node:path";
import { nextLocalTime, previousLocalTime } from "@overnight/core";
import type { Config, DataPaths } from "@overnight/core";
import { DELIVER_LEAD_MINUTES } from "../log-messages.ts";
import { minusMinutes } from "../render/format.ts";
import type { DashIdea, DbProblem, FilmingPolicy, IdeaExtras, Snapshot } from "../types.ts";
import { readDatabase } from "./db.ts";
import { hasScreenshot, readBrief, readBuildNotes, readReport, workspaceMarks } from "./files.ts";
import { readRunning } from "./locks.ts";
import { readLogTail } from "./logs.ts";
import { readBuildLog, readDeliverLog } from "./night-log.ts";

/** What the database part of a look is when the database could not be read. */
function nothingRead(pausedByDefault: boolean): Pick<Snapshot, "demoMark" | "paused" | "linesHeard" | "lastHeardAt" | "asks" | "detector" | "heard" | "ideas" | "events" | "unreadableRows"> {
  return { demoMark: false, paused: pausedByDefault, linesHeard: 0, lastHeardAt: null, asks: 0, detector: { idea: 0, not_idea: 0, skipped: 0, failed: 0 }, heard: [], ideas: [], events: new Map(), unreadableRows: 0 };
}

/**
 * Read everything once. When the database cannot be read, `problem` says why and the rest is
 * empty; the locks and the logs are still looked at.
 */
export function collectSnapshot(d: { config: Config; paths: DataPaths; filming: FilmingPolicy; now: Date }): Snapshot {
  const { config, paths, now } = d;
  // "Since 7:00 AM": the day on the page starts at the latest DELIVER_TIME (story.ts, overnightDayStart).
  const dayStart = previousLocalTime(now, config.deliverTime, config.timeZone).at.toISOString();
  const read = readDatabase(paths.database, { dayStart, filming: d.filming, pausedByDefault: config.pausedByDefault });
  const build = readBuildLog(readLogTail(path.join(paths.logs, "build.log")));
  const deliver = readDeliverLog(readLogTail(path.join(paths.logs, "deliver.log")));
  return {
    at: now.toISOString(),
    problem: read.ok ? null : read.problem,
    staleSince: null,
    running: readRunning(paths.root),
    dayStart,
    ...(read.ok ? read.data : nothingRead(config.pausedByDefault)),
    build: build.byIdea,
    deliver: deliver.byIdea,
    buildRuns: build.runs,
    deliverRuns: deliver.runs,
    nextBuildAt: nextLocalTime(now, config.buildTime, config.timeZone).toISOString(),
    // The deliver job starts half an hour before DELIVER_TIME, to have the apps checked and published by then.
    nextDeliverAt: nextLocalTime(now, minusMinutes(config.deliverTime, DELIVER_LEAD_MINUTES), config.timeZone).toISOString(),
  };
}

/** A look is shared by every page asked for within this long. It is also what keeps the lock looks to one a second. */
const REUSE_MS = 1000;
/** After these the page shows the last good look, with a line saying so, and tries again. */
const PASSING_PROBLEMS: ReadonlySet<DbProblem> = new Set<DbProblem>(["busy", "unreadable"]);

/**
 * Looks on demand, at most once a second however many pages ask. When the database is busy or
 * cannot be read for a moment, the last good look comes back with `problem` and `staleSince`
 * set, so the page keeps showing what it knew. A database that is missing or empty is not a
 * passing problem: that look is given as it is.
 *
 * `reuseMs` and `ticks` are for tests: how long a look is reused, and the clock that is measured
 * by (a steady one, not `now`, which may be a pretend clock that stands still).
 */
export function createSnapshotSource(d: { config: Config; paths: DataPaths; filming: FilmingPolicy; now: () => Date; reuseMs?: number; ticks?: () => number }): { get(): Snapshot } {
  const reuseMs = d.reuseMs ?? REUSE_MS;
  const ticks = d.ticks ?? (() => performance.now());
  let last: { snapshot: Snapshot; takenAt: number } | null = null;
  let lastGood: Snapshot | null = null;
  return {
    get(): Snapshot {
      const at = ticks();
      if (last !== null && at - last.takenAt < reuseMs) return last.snapshot;
      const fresh = collectSnapshot({ config: d.config, paths: d.paths, filming: d.filming, now: d.now() });
      let snapshot = fresh;
      if (fresh.problem === null) lastGood = fresh;
      else if (lastGood !== null && PASSING_PROBLEMS.has(fresh.problem)) {
        // What was known, with what can still be seen without the database: the locks and the clock.
        snapshot = { ...lastGood, at: fresh.at, problem: fresh.problem, staleSince: lastGood.at, running: fresh.running, nextBuildAt: fresh.nextBuildAt, nextDeliverAt: fresh.nextDeliverAt };
      }
      last = { snapshot, takenAt: at };
      return snapshot;
    },
  };
}

/** An idea in one of these states has a report, and screenshots, that belong to the build it has now. */
const DELIVERY_STATES: ReadonlySet<string> = new Set(["publish_failed", "published", "delivered"]);
const SHOWN_STATES: ReadonlySet<string> = new Set(["published", "delivered"]);

/**
 * The files that go with one idea, for its own page. Read on demand, not with every look.
 *   - The report and the screenshots are left on disk from one try to the next, so they are only
 *     given for an idea whose state says they are about its present build.
 *   - The marks of a build in progress are only looked for while it is building.
 *   - While filming, the build agent's notes are not read at all: an agent wrote them.
 *   - An idea whose title is hidden has no brief to show (a brief holds the title and the pitch).
 */
export function collectIdeaExtras(paths: DataPaths, idea: DashIdea, home: string, filming: FilmingPolicy): IdeaExtras {
  const shown = SHOWN_STATES.has(idea.state);
  return {
    report: DELIVERY_STATES.has(idea.state) ? readReport(paths, idea.id) : null,
    brief: idea.hidden ? null : readBrief(paths, idea.id, home),
    notes: filming.on ? "filming" : readBuildNotes(paths, idea.id, home),
    shots: { phone: shown && hasScreenshot(paths, idea.id, "phone"), desktop: shown && hasScreenshot(paths, idea.id, "desktop") },
    marks: idea.state === "building" ? workspaceMarks(paths, idea.id) : null,
  };
}
