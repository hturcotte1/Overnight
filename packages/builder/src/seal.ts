// Finished builds are kept where no build job can reach them: <data>/built/<ideaId>/.
//
// A workspace is where an agent works, so a build job can read and write there. With Kiro Crew
// that means every idea's workspace: one sandbox covers every job the gateway starts. A finished
// app left in workspaces/ could be changed by a later job before the morning publishes it. Both
// sandbox profiles close all of the data folder but three folders (workspaces, tmp/build and
// tmp/build-probe), so one rename takes a finished build out of every job's reach.
//
// Out of reach by NAME, that is. A rename moves the same files, and a build can have kept two
// other ways to them (shown for real, in both profiles, on Oct 11):
//   - a program it left running, with a file open from before the move, writes through that;
//   - a hard link it made in a folder jobs may write (tmp/build, another workspace) is a second
//     name for the same file, and any later job can write through it.
// So after the rename every plain file in the build is made anew: copied, and the copy put in
// the old one's place under the same name. The file the morning reads is then one no build ever
// had open and no other name leads to. What a build kept still works, on the old file, which
// nothing reads any more.
//
// Making the files anew walks the folder by its names, with this program's full rights. That is
// only safe because the folder is already in built/: no job can add, swap or remove a name
// there (tried for real: a program holding the folder open from before cannot either), so
// nothing can be put in the walk's way. It is never done to a folder jobs can still write.
//
// The night flow records the idea as built first and moves its folder second. A crash between
// the two leaves a built app in workspaces/, which the morning still finds: core's
// finishedBuildDir looks in built/ first and in workspaces/ when there is nothing there. A crash
// while the files are being made anew leaves a whole app as well, each file either the old one
// or its copy.
//
// Before an idea is built again, its older finished build is moved aside, so the morning can
// never pick up yesterday's app in place of today's.
//
// Nothing here deletes anything of a build's, and nothing here throws. A reason is our own
// words plus, at most, an error code: never a path.
import { chmodSync, constants, copyFileSync, lstatSync, readdirSync, renameSync, rmdirSync, rmSync, utimesSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
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
      /** sealWorkspace only: how many plain files of the build were made anew. */
      madeAnew?: number;
      /**
       * sealWorkspace only: how many files (and folders that could not be looked into) were NOT
       * made anew. 0 is a whole seal. The build that made them may still be able to change these.
       */
      notMadeAnew?: number;
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
 * How long making a build's files anew may take. It is done in one go, and while it runs this
 * program hears nothing, not even that it is being stopped. A build of 10,000 files and 590 MB
 * took 1.3 to 2.6 seconds (measured Oct 11). Files not reached in time are counted as not made anew.
 */
export const MAKE_ANEW_TIME_LIMIT_MS = 8_000;
/** A file larger than this is not copied (one such copy could take the whole time by itself). No app has one. */
export const MAKE_ANEW_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Installed packages are the bulk of a build, and the morning installs its own: they come last. */
const LAST_FOLDER = "node_modules";

export interface MadeAnew {
  madeAnew: number;
  notMadeAnew: number;
}

/**
 * Put a new copy of one plain file in its place, with the same permissions and times. False when
 * that could not be done; the file is then as the build left it.
 */
function makeFileAnew(file: string, before: Stats, copy: string): boolean {
  const permissions = before.mode & 0o7777;
  try {
    try {
      copyFileSync(file, copy, constants.COPYFILE_EXCL);
    } catch (error) {
      if (errorCode(error) !== "EACCES") throw error;
      // A file its build left unreadable. It is this user's all the same, and it must not be a
      // way to keep a file out of the seal: opened for reading, copied, and the copy closed again.
      chmodSync(file, permissions | 0o400);
      copyFileSync(file, copy, constants.COPYFILE_EXCL);
    }
    chmodSync(copy, permissions);
    utimesSync(copy, before.atime, before.mtime);
    renameSync(copy, file);
    return true;
  } catch {
    try {
      // Our own half-made copy, in our own folder: not a file of the build's.
      rmSync(copy, { force: true });
    } catch {
      // It stays in the scratch folder, under a name that is not used again.
    }
    return false;
  }
}

/**
 * Make every plain file below `dir` anew, in place: see the top of this file. `dir` MUST already
 * be out of every build job's reach. `scratchDir` is a folder of our own on the same disk, also
 * out of reach, that each copy is made in. Folders, links and anything else are left as they are:
 * a job cannot change what a name in built/ leads to. Never throws.
 */
export function makeFilesAnew(dir: string, scratchDir: string, options: { now?: () => number; timeLimitMs?: number; maxFileBytes?: number } = {}): MadeAnew {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeLimitMs ?? MAKE_ANEW_TIME_LIMIT_MS);
  const maxFileBytes = options.maxFileBytes ?? MAKE_ANEW_MAX_FILE_BYTES;
  const result: MadeAnew = { madeAnew: 0, notMadeAnew: 0 };
  let copies = 0;
  // Folders still to do. Those named node_modules wait until everything else is done.
  const first: string[] = [dir];
  const last: string[] = [];
  for (let folder = first.pop() ?? last.pop(); folder !== undefined; folder = first.pop() ?? last.pop()) {
    let entries: Dirent[];
    try {
      // A folder its build left closed to its own user: opened, or nothing in it could be replaced.
      const permissions = lstatSync(folder).mode & 0o7777;
      if ((permissions & 0o700) !== 0o700) chmodSync(folder, permissions | 0o700);
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      result.notMadeAnew += 1;
      continue;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) (entry.name === LAST_FOLDER ? last : first).push(file);
      if (!entry.isFile()) continue;
      // Out of time: the rest is only counted, which costs next to nothing.
      let before: Stats | null = null;
      try {
        if (now() < deadline) before = lstatSync(file);
      } catch {
        // Counted below.
      }
      copies += 1;
      const made = before !== null && before.isFile() && before.size <= maxFileBytes && makeFileAnew(file, before, path.join(scratchDir, `${process.pid}-${copies}`));
      if (made) result.madeAnew += 1;
      else result.notMadeAnew += 1;
    }
  }
  return result;
}

/**
 * One rename: workspaces/<id> -> built/<id> (an existing built/<id> is retired first). Then every
 * plain file in it is made anew, so that nothing its build kept open or linked leads to the
 * files the morning reads; `notMadeAnew` says how many could not be. Never throws.
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
  // Moved, and from here on the answer is "ok" whatever happens: the build is where the morning
  // looks for it. The copies are made in a folder of our own beside it. (No idea's folder can
  // have this name: an idea id has no dot in it.)
  const scratchDir = path.join(paths.built, `${ideaId}.sealing`);
  let made: MadeAnew;
  try {
    privateDir(scratchDir);
    made = makeFilesAnew(retired.dir, scratchDir);
  } catch {
    // The scratch folder could not be made: no file was made anew. How many there are is not
    // known without the walk, so the answer is "at least one".
    made = { madeAnew: 0, notMadeAnew: 1 };
  }
  try {
    rmdirSync(scratchDir);
  } catch {
    // Not empty (a copy that could not be removed) or never made: left for a person to look at.
  }
  return { ok: true, dir: retired.dir, movedAside: retired.movedAside, ...made };
}
