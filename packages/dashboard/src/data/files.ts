// The files the idea page shows: the brief, the build agent's notes, the deliver step's report
// and the two screenshots. And, for a build in progress, which files exist so far.
//
// A path is only ever made from the data folder, an idea id that has the shape of one, and a
// fixed name. The build folder is the one place a build agent writes, so nothing is read from it
// unless it is a real folder under its own name (not a link somewhere else), and what is read is
// shown as plain text. Nothing here throws.
import { lstatSync } from "node:fs";
import path from "node:path";
import { finishedBuildDir } from "@overnight/core";
import type { DataPaths } from "@overnight/core";
import { z } from "zod";
import { homeTilde } from "../render/format.ts";
import { IDEA_ID } from "../types.ts";
import type { ReportView, WorkspaceMarks } from "../types.ts";
import { STEP_NAME } from "./night-log.ts";
import { isOwnFolder, isPng, readPng, readSmallFile } from "./safe-read.ts";

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
/** The verifier saves no screenshot larger than this (deliver, verifier.ts). */
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

/**
 * The folder an idea's build is in: the finished build if there is one (<data>/built/<id>),
 * otherwise the folder it is being made in (<data>/workspaces/<id>). Core decides which.
 * Null when the id has not the shape of one, or the folder is not a real folder under its own name.
 */
function buildFolder(paths: DataPaths, ideaId: string): string | null {
  if (!IDEA_ID.test(ideaId)) return null;
  try {
    const folder = finishedBuildDir(paths, ideaId);
    return isOwnFolder(path.dirname(folder), path.basename(folder)) ? folder : null;
  } catch {
    return null;
  }
}

/** The brief the build agent was given: our template plus the idea's title and pitch. */
export function readBrief(paths: DataPaths, ideaId: string, home: string): { text: string; cut: boolean } | null {
  if (!IDEA_ID.test(ideaId) || !isOwnFolder(paths.ideas, ideaId)) return null;
  const read = readSmallFile(path.join(paths.ideas, ideaId, "brief.md"), MAX_TEXT_BYTES);
  return read === null ? null : { text: homeTilde(read.text, home), cut: read.cut };
}

/** What the build agent wrote about its build. An agent's words: plain text, and never a reason to follow a link. */
export function readBuildNotes(paths: DataPaths, ideaId: string, home: string): { text: string; cut: boolean } | null {
  const folder = buildFolder(paths, ideaId);
  if (folder === null) return null;
  const read = readSmallFile(path.join(folder, "BUILD_NOTES.md"), MAX_TEXT_BYTES);
  // Looked at again afterwards: if the folder was swapped for a link while we read, what we read is not shown.
  if (read === null || buildFolder(paths, ideaId) !== folder) return null;
  return { text: homeTilde(read.text, home), cut: read.cut };
}

// ---------- the report ----------

const amount = z.number().nonnegative().nullable().catch(null);
const yesNo = z.boolean().nullable().catch(null);

/** The parts of a report the pages show: numbers and yes/no answers. Its title, pitch, note, link and file paths are not taken. */
const reportShape = z.object({
  ideaId: z.string(),
  confirmedLive: yesNo,
  checks: z
    .object({ failedStep: z.string().regex(STEP_NAME).nullable().catch(null), installOk: yesNo, buildOk: yesNo, contractOk: yesNo, appSmokeOk: yesNo })
    .catch({ failedStep: null, installOk: null, buildOk: null, contractOk: null, appSmokeOk: null }),
  timings: z.object({ verifyMs: amount, publishMs: amount, liveAfterMs: amount }).catch({ verifyMs: null, publishMs: null, liveAfterMs: null }),
  sizes: z.object({ distFiles: amount, distBytes: amount }).catch({ distFiles: null, distBytes: null }),
});

/** The deliver step's report for an idea (<data>/reports/<id>.json), or null if there is none that can be read. */
export function readReport(paths: DataPaths, ideaId: string): ReportView | null {
  if (!IDEA_ID.test(ideaId)) return null;
  const read = readSmallFile(path.join(paths.reports, `${ideaId}.json`), MAX_REPORT_BYTES);
  // Half a report is no report.
  if (read === null || read.cut) return null;
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return null;
  }
  const parsed = reportShape.safeParse(json);
  if (!parsed.success || parsed.data.ideaId !== ideaId) return null;
  const { confirmedLive, checks, timings, sizes } = parsed.data;
  return {
    confirmedLive,
    failedStep: checks.failedStep,
    verifyMs: timings.verifyMs,
    publishMs: timings.publishMs,
    liveAfterMs: timings.liveAfterMs,
    distFiles: sizes.distFiles,
    distBytes: sizes.distBytes,
    checks: { installOk: checks.installOk, buildOk: checks.buildOk, contractOk: checks.contractOk, appSmokeOk: checks.appSmokeOk },
  };
}

// ---------- the screenshots ----------

/** Where the verifier saves the two pictures: <id>.png for the phone, <id>-desktop.png for the desktop. */
function screenshotFile(paths: DataPaths, ideaId: string, which: "phone" | "desktop"): string | null {
  if (!IDEA_ID.test(ideaId)) return null;
  return path.join(paths.screenshots, which === "phone" ? `${ideaId}.png` : `${ideaId}-desktop.png`);
}

export function readScreenshot(paths: DataPaths, ideaId: string, which: "phone" | "desktop"): Buffer | null {
  const file = screenshotFile(paths, ideaId, which);
  return file === null ? null : readPng(file, MAX_SCREENSHOT_BYTES);
}

function isPlainFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isRealFolder(folder: string): boolean {
  try {
    return lstatSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is there a picture to show? The same answer `readScreenshot` will give when the page asks for
 * it: a plain file, not too large, that starts as a PNG does (its first eight bytes are read). A
 * file that is there but is no picture, an empty one for instance, shows as no picture rather
 * than as a broken one.
 */
export function hasScreenshot(paths: DataPaths, ideaId: string, which: "phone" | "desktop"): boolean {
  const file = screenshotFile(paths, ideaId, which);
  return file !== null && isPng(file, MAX_SCREENSHOT_BYTES);
}

// ---------- a build in progress ----------

/**
 * Which of the files a build makes are there so far. Only looks; nothing is opened. The status
 * file is written near the start of a build (the build skill's second step), which is why it
 * marks "started" and not "finished".
 */
export function workspaceMarks(paths: DataPaths, ideaId: string): WorkspaceMarks | null {
  const folder = buildFolder(paths, ideaId);
  if (folder === null) return null;
  return {
    started: isPlainFile(path.join(folder, "BUILD_STATUS.json")),
    projectWritten: isPlainFile(path.join(folder, "package.json")),
    packagesInstalled: isRealFolder(path.join(folder, "node_modules")),
    appBuilt: isRealFolder(path.join(folder, "dist")) && isPlainFile(path.join(folder, "dist", "index.html")),
    notesWritten: isPlainFile(path.join(folder, "BUILD_NOTES.md")),
  };
}
