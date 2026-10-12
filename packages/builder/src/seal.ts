// Finished builds are kept where no build job can reach them: <data>/built/<ideaId>/.
//
// A workspace is where an agent works, so a build job can read and write there. With Kiro Crew
// that means every idea's workspace: one sandbox covers every job the gateway starts. A finished
// app left in workspaces/ could be changed by a later job before the morning publishes it. Both
// sandbox profiles close all of the data folder but three folders (workspaces, tmp/build and
// tmp/build-probe), so one rename takes a finished build out of every job's reach.
//
// The night flow records the idea as built first and moves its folder second. A crash between
// the two leaves a built app in workspaces/, which the morning still finds: core's
// finishedBuildDir looks in built/ first and in workspaces/ when there is nothing there.
//
// Before an idea is built again, its older finished build is moved aside, so the morning can
// never pick up yesterday's app in place of today's.
//
// Nothing here deletes anything, and nothing here throws. A reason is our own words plus, at
// most, an error code: never a path.
import { lstatSync, renameSync } from "node:fs";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { asideName, isSafeIdeaId, privateDir } from "./workspace.ts";

export type SealResult =
  | {
      ok: true;
      /** <data>/built/<ideaId>: where the finished build is now (sealWorkspace), or would go (retireSealed). */
      dir: string;
      /** Where an older finished build of the same idea went, or null if there was none. */
      movedAside: string | null;
    }
  | { ok: false; reason: string };

/** Where an idea's finished build is kept: <data>/built/<ideaId>. The id is not checked here. */
export function sealedDir(paths: Pick<DataPaths, "built">, ideaId: string): string {
  return path.join(paths.built, ideaId);
}

const refused = (reason: string): SealResult => ({ ok: false, reason });
const BAD_ID = "the idea id cannot be used as a folder name";

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

/** What is at a path. A link is never followed. Throws when the path cannot be looked at. */
function kindOf(file: string): "nothing" | "folder" | "link" | "other" {
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "nothing";
    throw error;
  }
  return stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "folder" : "other";
}

/**
 * Before an idea is built again: move an older sealed build aside (built/<id>.old-<stamp>).
 * Never deletes, never throws.
 */
export function retireSealed(options: { paths: DataPaths; ideaId: string; now: Date }): SealResult {
  const { paths, ideaId, now } = options;
  if (!isSafeIdeaId(ideaId)) return refused(BAD_ID);
  try {
    // A link where built/ should be is refused: everything "sealed" would land wherever it points.
    privateDir(paths.built);
  } catch {
    return refused("the folder for finished builds could not be made ready");
  }
  const dir = sealedDir(paths, ideaId);
  try {
    const kind = kindOf(dir);
    if (kind === "nothing") return { ok: true, dir, movedAside: null };
    // No build job can write in built/, so we did not put a link here and neither did a build.
    // Whoever did, it is left for a person to look at.
    if (kind === "link") return refused("a link stands where the idea's finished build is kept");
    const movedAside = asideName(dir, now);
    renameSync(dir, movedAside);
    return { ok: true, dir, movedAside };
  } catch (error) {
    return refused(`the older finished build could not be moved aside (${errorCode(error)})`);
  }
}

/**
 * One rename: workspaces/<id> -> built/<id> (an existing built/<id> is retired first). Never throws.
 */
export function sealWorkspace(options: { paths: DataPaths; ideaId: string; now: Date }): SealResult {
  const { paths, ideaId } = options;
  if (!isSafeIdeaId(ideaId)) return refused(BAD_ID);
  const from = path.join(paths.workspaces, ideaId);
  try {
    // Both must be real folders. A Kiro Crew job can write anywhere below workspaces/, so it can
    // put a link where a workspace was: moving that link into built/ would seal nothing.
    if (kindOf(paths.workspaces) !== "folder") return refused("the workspaces folder is not a plain folder");
    const kind = kindOf(from);
    if (kind === "nothing") return refused("the workspace folder is missing");
    if (kind !== "folder") return refused("the workspace is not a plain folder (a link stands in its place?)");
  } catch (error) {
    return refused(`the workspace could not be looked at (${errorCode(error)})`);
  }
  // Checked before anything is moved aside: a workspace that cannot be sealed must not cost the
  // idea the finished build it already has.
  const retired = retireSealed(options);
  if (!retired.ok) return retired;
  try {
    renameSync(from, retired.dir);
  } catch (error) {
    return refused(`the workspace could not be moved (${errorCode(error)})`);
  }
  return { ok: true, dir: retired.dir, movedAside: retired.movedAside };
}
