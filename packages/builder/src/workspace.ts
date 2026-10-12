// The one folder a build agent works in: <data>/workspaces/<ideaId>/, holding only brief.md at
// the start. An earlier try's folder is moved aside, never deleted, so nothing an agent built is
// lost and a new build never starts on top of old files.
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataPaths } from "@overnight/core";

export interface PreparedWorkspace {
  /** Full real path of the empty workspace (symbolic links resolved, as the sandbox needs). */
  workspace: string;
  /** Full path of brief.md inside it. */
  briefPath: string;
  /** Where the folder of an earlier try went, or null if there was none. */
  movedAside: string | null;
}

/** Ids are our own ("idea_20261010_ab12cd34"). Checked anyway, because they become folder names. */
export function isSafeIdeaId(ideaId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(ideaId);
}

/** "20261010T163607Z": sorts by time and is safe in a folder name. */
function compactStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A free name to move an older folder to: "<dir>.old-<time>", with "-2", "-3" and so on added
 * for as long as that name is taken. Nothing is ever moved on top of something else.
 */
export function asideName(dir: string, now: Date): string {
  const base = `${dir}.old-${compactStamp(now)}`;
  let name = base;
  for (let n = 2; exists(name); n += 1) name = `${base}-${n}`;
  return name;
}

/** Make a folder (and the ones above it) if it is missing, private to the user. Throws when it is not a plain folder. */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A link where the folder should be would send everything written "inside" it, and the
  // chmod below, to wherever the link points. Whoever put it there, it is not our folder.
  if (!lstatSync(dir).isDirectory()) throw new Error(`${path.basename(dir)} is not a plain folder.`);
  // mkdir's mode only applies to folders it creates; an older one may be open to others.
  chmodSync(dir, 0o700);
}

/**
 * Make an empty, private workspace for one idea and put the brief in it. A copy of the brief is
 * kept at <data>/ideas/<ideaId>/brief.md for the dashboard. Throws if the folders cannot be made.
 */
export function prepareWorkspace(options: { paths: DataPaths; ideaId: string; brief: string; now: Date }): PreparedWorkspace {
  const { paths, ideaId, brief, now } = options;
  if (!isSafeIdeaId(ideaId)) throw new Error("The idea id cannot be used as a folder name.");

  privateDir(paths.workspaces);
  const dir = path.join(paths.workspaces, ideaId);
  let movedAside: string | null = null;
  if (exists(dir)) {
    movedAside = asideName(dir, now);
    renameSync(dir, movedAside);
  }
  // Not recursive: if the folder is somehow there again, fail instead of building on top of it.
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);

  const workspace = realpathSync(dir);
  const briefPath = path.join(workspace, "brief.md");
  writeFileSync(briefPath, brief, { mode: 0o600, flag: "wx" });

  const ideaDir = path.join(paths.ideas, ideaId);
  privateDir(ideaDir);
  writeFileSync(path.join(ideaDir, "brief.md"), brief, { mode: 0o600 });
  return { workspace, briefPath, movedAside };
}

/**
 * The build jobs' own temporary folder (<data>/tmp/build), made if it is missing and private to
 * the user. Its real path, or null when it is not a plain folder (a link there would have every
 * temporary file land somewhere else).
 */
export function buildTmpDir(paths: DataPaths): string | null {
  try {
    mkdirSync(paths.buildTmp, { recursive: true, mode: 0o700 });
    if (!lstatSync(paths.buildTmp).isDirectory()) return null;
    chmodSync(paths.buildTmp, 0o700);
    return realpathSync(paths.buildTmp);
  } catch {
    return null;
  }
}
