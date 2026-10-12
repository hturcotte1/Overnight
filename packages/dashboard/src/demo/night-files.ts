// SYNTHETIC data: every word, number and picture written by this file is made up. None of it is Bee data.
//
// What a night's work leaves behind, as the demo writes it: lines in the two job logs, the files
// of a build, and the report and the two pictures of a morning. The seed uses these at invented
// times in the past; the invented night uses them at the pretend clock's time.
//
// Every write goes through ./folder.ts, into a folder that file has already let through.
import { createLogger } from "@overnight/core";
import type { Idea, LogFields, LogLevel } from "@overnight/core";
import { renderBrief } from "@overnight/builder";
import { HAND_RUN_NAMES, LOG_MESSAGES, matchLogMessage } from "../log-messages.ts";
import type { LogMessage, LogMessageKey } from "../log-messages.ts";
import { IDEA_ID } from "../types.ts";
import { DemoFolderError, folderInside, isFileInside, isFolderInside, LEADS_OUTSIDE, moveInside, plainFileOrMissing, writeInside } from "./folder.ts";
import { drawPng } from "./png.ts";
import type { PngRect, Rgb } from "./png.ts";

/** The folders of a data folder that the demo writes into, by the names core gives them (a test holds the two together). */
export const DEMO_FOLDERS = ["logs", "ideas", "workspaces", "built", "reports", "screenshots"] as const;

/** Make the demo's folders if they are missing, and refuse if one of them has become a link or a file. */
export function checkDemoFolders(root: string): void {
  for (const folder of DEMO_FOLDERS) folderInside(root, folder);
}

// ---------- the two job logs ----------

/** Which command a line "…: build starting" is from. */
export type HandRun = keyof typeof HAND_RUN_NAMES;

export interface DemoLogs {
  /**
   * One line the dashboard knows, written under the name its own program logs it by. `by` is
   * needed for the four lines that start with a command's name, and only for those.
   */
  line(key: LogMessageKey, at: Date, fields?: LogFields, by?: HandRun): void;
  /** A line the dashboard does not know. The real logs are full of them, and it must pass them by. */
  other(log: LogMessage["log"], at: Date, level: LogLevel, message: string, fields?: LogFields): void;
  /** The first line of each log: it says the file is invented. */
  mark(at: Date): void;
}

/** How loudly each line is logged by the program that really writes it. Anything not listed is "info". */
const LEVELS: Partial<Record<LogMessageKey, LogLevel>> = {
  signedOut: "error",
  signInUnknown: "warn",
  sandboxFailed: "error",
  fallback: "warn",
  ideaFailed: "warn",
  sealedPartly: "error",
  notSealed: "error",
  buildSlept: "warn",
  deliverSlept: "warn",
  notVerified: "warn",
  notSeenLive: "warn",
};

/** How the two lines that go on after their known start are finished (builder, probe.ts). */
export const TAILS: Partial<Record<LogMessageKey, string>> = {
  sandboxPassed:
    ": the Keychain, Bee, the transcript database, the folders in the home folder, the finished builds and other programs' command lines are out of reach of a job, and it cannot write where our programs are",
  sandboxFailed: ": nothing will be built with Kiro Crew",
};

export const LOG_MARK = "SYNTHETIC data: every line in this file is made up by the Overnight dashboard's demo. None of it is Bee data.";

/** The text a line is logged with: the known words, plus the tail or the command's name where the line has one. */
function messageFor(key: LogMessageKey, by: HandRun | undefined): string {
  const entry: LogMessage = LOG_MESSAGES[key];
  if (entry.match === "ends") {
    if (by === undefined) throw new Error(`The log line "${key}" starts with a command's name: say which command.`);
    return `${HAND_RUN_NAMES[by]}${entry.text}`;
  }
  if (by !== undefined) throw new Error(`The log line "${key}" does not start with a command's name.`);
  return entry.match === "starts" ? `${entry.text}${TAILS[key] ?? ""}` : entry.text;
}

/**
 * The demo's build.log and deliver.log under `root` (a folder ./folder.ts has let through).
 * Written with core's own logger, so the lines have exactly the shape of real ones.
 */
export function openDemoLogs(root: string): DemoLogs {
  let stamp = new Date(0);
  const open = (name: string, log: LogMessage["log"]) => createLogger({ name, file: plainFileOrMissing(root, "logs", `${log}.log`), write: () => {}, now: () => stamp });
  const loggers = { build: open("build", "build"), deliver: open("deliver", "deliver") };
  return {
    line(key, at, fields = {}, by) {
      const entry: LogMessage = LOG_MESSAGES[key];
      const message = messageFor(key, by);
      // A line that would be read back as some other line would put a wrong tick on the page.
      if (matchLogMessage(entry.log, message) !== key) throw new Error(`The demo's log line "${key}" would not be read back as that line.`);
      stamp = at;
      loggers[entry.log][LEVELS[key] ?? "info"](message, fields);
    },
    other(log, at, level, message, fields = {}) {
      if (matchLogMessage(log, message) !== null) throw new Error("That line is one the dashboard knows: write it by its name.");
      stamp = at;
      loggers[log][level](message, fields);
    },
    mark(at) {
      stamp = at;
      // Under a name of its own: the dashboard reads only the lines logged as "build" and "deliver".
      for (const log of ["build", "deliver"] as const) open("demo", log).info(LOG_MARK);
    },
  };
}

// ---------- the files of a build ----------

/** The files a build makes, in the order they appear. The dashboard shows a mark for each. */
export const WORKSPACE_FILES = ["BUILD_STATUS.json", "package.json", "node_modules", "dist/index.html", "BUILD_NOTES.md"] as const;
export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];

const BUILD_STATUS = {
  building: { status: "building" },
  built: { status: "built", build_ok: true, smoke_test: "passed" },
  failed: { status: "failed", build_ok: false, smoke_test: "not_run" },
} as const;

/** The same page for every invented app. No word of an idea goes into it. */
const DEMO_APP_PAGE = [
  "<!doctype html>",
  "<!-- SYNTHETIC: made up by the Overnight dashboard's demo. No build agent wrote this. -->",
  '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo app</title></head>',
  "<body><h1>Demo app</h1><p>An invented app, for the Overnight dashboard's demo.</p></body></html>",
  "",
].join("\n");

/** An idea id becomes a folder name and a file name, so one that has not the shape of an id is refused. */
function checked(ideaId: string): string {
  if (!IDEA_ID.test(ideaId)) throw new DemoFolderError(LEADS_OUTSIDE);
  return ideaId;
}

/** A new, empty workspace with the brief in it, and a copy of the brief under ideas/, as the builder leaves them. The brief is the real one. */
export function writeBriefs(root: string, idea: Pick<Idea, "id" | "title" | "pitch">): void {
  const id = checked(idea.id);
  const brief = renderBrief({ id, title: idea.title, pitch: idea.pitch });
  writeInside(root, ["workspaces", id, "brief.md"], brief);
  writeInside(root, ["ideas", id, "brief.md"], brief);
}

/** Before a second try: the first try's folder is moved aside, never deleted (builder, workspace.ts). */
export function setWorkspaceAside(root: string, ideaId: string, at: Date): void {
  const id = checked(ideaId);
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  moveInside(root, ["workspaces", id], ["workspaces", `${id}.old-${stamp}`]);
}

export function hasWorkspaceFile(root: string, ideaId: string, file: WorkspaceFile): boolean {
  const id = checked(ideaId);
  if (file === "node_modules") return isFolderInside(root, "workspaces", id, "node_modules");
  return isFileInside(root, "workspaces", id, ...file.split("/"));
}

/** Put one of a build's files into the workspace. `notes` is the text of BUILD_NOTES.md, and only read for that file. */
export function writeWorkspaceFile(root: string, ideaId: string, file: WorkspaceFile, notes = ""): void {
  const id = checked(ideaId);
  const workspace = ["workspaces", id];
  // A build never works in a folder that is not there: the brief made it.
  if (!isFolderInside(root, ...workspace)) throw new DemoFolderError(LEADS_OUTSIDE);
  if (file === "BUILD_STATUS.json") writeBuildStatus(root, id, "building");
  else if (file === "package.json") writeInside(root, [...workspace, file], `${JSON.stringify({ name: "overnight-demo-app", private: true, version: "0.0.0", type: "module", description: "SYNTHETIC: made up by the Overnight dashboard's demo.", scripts: { build: "vite build" } }, null, 2)}\n`);
  else if (file === "node_modules") folderInside(root, ...workspace, "node_modules");
  else if (file === "dist/index.html") writeInside(root, [...workspace, "dist", "index.html"], DEMO_APP_PAGE);
  else writeInside(root, [...workspace, file], notes);
}

/** What the build agent says of its build, in the file both builders read. */
export function writeBuildStatus(root: string, ideaId: string, status: keyof typeof BUILD_STATUS): void {
  writeInside(root, ["workspaces", checked(ideaId), "BUILD_STATUS.json"], `${JSON.stringify(BUILD_STATUS[status])}\n`);
}

/** A finished build is moved out of the build jobs' reach with one rename: workspaces/<id> becomes built/<id>. */
export function sealWorkspace(root: string, ideaId: string): void {
  const id = checked(ideaId);
  moveInside(root, ["workspaces", id], ["built", id]);
}

/**
 * What the builder's line about that move says it made anew (its `filesMadeAnew`): every plain
 * file of the build, its installed packages included. Invented: a small app has about this many.
 * No page shows the number.
 */
export const DEMO_FILES_MADE_ANEW = 1412;

/** Build notes for an invented app. The first lines say nobody built anything. */
export function demoBuildNotes(title: string, body: readonly string[]): string {
  return [`# Build notes: ${title}`, "", "(Invented for the Overnight dashboard's demo. No build agent wrote this, and nothing was built.)", "", ...body, ""].join("\n");
}

// ---------- the two pictures of a morning ----------

const PAPER: Rgb = [246, 244, 238];
const INK: Rgb = [40, 44, 60];
const PENCIL: Rgb = [204, 202, 194];
const RULE: Rgb = [228, 226, 219];
const WHITE: Rgb = [255, 255, 255];
const SUN: Rgb = [245, 181, 38];

/** The drawn "screenshot" of an invented app: a bar on top, a short list with two ticks, a button. */
function appPicture(width: number, height: number, accent: Rgb): Buffer {
  // The app sits in a column in the middle, as a small web app does on a wide screen.
  const column = Math.min(width, 520);
  const left = Math.floor((width - column) / 2);
  const pad = 24;
  const rects: PngRect[] = [
    { x: 0, y: 0, w: width, h: 64, rgb: accent },
    { x: left + pad, y: 24, w: 132, h: 16, rgb: WHITE },
    { x: left + pad, y: 96, w: 208, h: 22, rgb: INK },
    { x: left + pad, y: 130, w: 150, h: 12, rgb: PENCIL },
  ];
  const widths = [220, 176, 248, 140, 196];
  widths.forEach((w, row) => {
    const y = 176 + row * 58;
    rects.push({ x: left + pad, y: y + 46, w: column - pad * 2, h: 1, rgb: RULE });
    // Two rows are ticked: a filled box. The others are open: the same box with a paper middle.
    rects.push({ x: left + pad, y, w: 24, h: 24, rgb: row < 2 ? accent : PENCIL });
    if (row >= 2) rects.push({ x: left + pad + 2, y: y + 2, w: 20, h: 20, rgb: PAPER });
    rects.push({ x: left + pad + 40, y: y + 5, w, h: 14, rgb: row < 2 ? PENCIL : INK });
  });
  rects.push({ x: left + pad, y: height - 88, w: column - pad * 2, h: 52, rgb: SUN });
  rects.push({ x: left + Math.floor(column / 2) - 46, y: height - 68, w: 92, h: 12, rgb: INK });
  return drawPng(width, height, PAPER, rects);
}

/** The colours the invented apps come in. */
export const ACCENTS: readonly Rgb[] = [
  [79, 110, 247],
  [22, 163, 122],
  [147, 92, 235],
  [224, 98, 64],
  [14, 142, 178],
];

/** A colour for an app nobody picked one for: always the same one for the same id. */
export function accentFor(ideaId: string): Rgb {
  let sum = 0;
  for (const letter of ideaId) sum = (sum + (letter.codePointAt(0) ?? 0)) % 9973;
  return ACCENTS[sum % ACCENTS.length] ?? [79, 110, 247];
}

/**
 * The two pictures the morning check saves: screenshots/<id>.png at phone size and
 * <id>-desktop.png at desktop size (deliver, verifier.ts). Drawn, not taken. Returns where they are.
 */
export function writeScreenshots(root: string, ideaId: string, accent: Rgb): { phone: string; desktop: string } {
  const id = checked(ideaId);
  return {
    phone: writeInside(root, ["screenshots", `${id}.png`], appPicture(390, 844, accent)),
    desktop: writeInside(root, ["screenshots", `${id}-desktop.png`], appPicture(1280, 800, accent)),
  };
}

// ---------- the report of a morning ----------

/** The deliver step's report, field for field (deliver, report.ts). A test holds the two shapes together. */
export interface DemoReport {
  ideaId: string;
  slug: string | null;
  title: string;
  pitch: string;
  backend: string | null;
  state: string;
  ok: boolean;
  url: string | null;
  confirmedLive: boolean | null;
  failureReason: string | null;
  note: string | null;
  checks: Record<string, boolean | number | string>;
  timings: { verifyMs: number | null; publishMs: number | null; liveAfterMs: number | null };
  sizes: { sourceFiles: number | null; sourceBytes: number | null; distFiles: number | null; distBytes: number | null };
  screenshots: { phone: string | null; desktop: string | null };
  morningTodoId: number | null;
  factId: number | null;
  startedAt: string;
  publishedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

/** What a morning check measured. The rest of a report is the idea as the database has it. */
export interface Measured {
  checks: DemoReport["checks"];
  timings: DemoReport["timings"];
  confirmedLive: boolean | null;
  screenshots: DemoReport["screenshots"];
  startedAt: string;
}

/** The checks of an app that passed, as the verifier lists them. */
export function passedChecks(sizes: { sourceFiles: number; sourceBytes: number; distFiles: number; distBytes: number; totalMs: number }): DemoReport["checks"] {
  return {
    sourceFiles: sizes.sourceFiles,
    sourceBytes: sizes.sourceBytes,
    appSmokePresent: true,
    installUsedRegistry: false,
    installOk: true,
    buildOk: true,
    distHasIndex: true,
    distFiles: sizes.distFiles,
    distBytes: sizes.distBytes,
    distNamesThisMac: false,
    contractOk: true,
    screenshotsSaved: true,
    appSmokeOk: true,
    totalMs: sizes.totalMs,
  };
}

function countOrNull(value: boolean | number | string | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The report the deliver step would write for this idea now (its saveReport, deliver.ts). */
export function reportFor(idea: Idea, measured: Measured, at: Date): DemoReport {
  return {
    ideaId: idea.id,
    slug: idea.slug,
    title: idea.title,
    pitch: idea.pitch,
    backend: idea.buildBackend,
    state: idea.state,
    ok: idea.state === "published" || idea.state === "delivered",
    url: idea.publishedUrl,
    confirmedLive: measured.confirmedLive,
    failureReason: idea.failureReason,
    note: idea.note,
    checks: measured.checks,
    timings: measured.timings,
    sizes: {
      sourceFiles: countOrNull(measured.checks.sourceFiles),
      sourceBytes: countOrNull(measured.checks.sourceBytes),
      distFiles: countOrNull(measured.checks.distFiles),
      distBytes: countOrNull(measured.checks.distBytes),
    },
    screenshots: measured.screenshots,
    morningTodoId: idea.morningTodoId,
    factId: idea.factId,
    startedAt: measured.startedAt,
    publishedAt: idea.publishedAt,
    deliveredAt: idea.deliveredAt,
    updatedAt: at.toISOString(),
  };
}

export function writeReport(root: string, report: DemoReport): void {
  writeInside(root, ["reports", `${checked(report.ideaId)}.json`], `${JSON.stringify(report, null, 2)}\n`);
}
