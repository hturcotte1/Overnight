// Is this folder that folder, or inside it? Asked of the disk, not of the spelling.
//
// One folder can be written many ways: through a link, in other capitals, and on a Mac also as
// /System/Volumes/Data/Users/... or as /.vol/<device>/<file number>. Neither of those two is a
// link, so following links never finds them. Whatever the spelling, the disk gives a folder one
// pair of numbers (its device and its file number), so folders are compared by that pair.
//
// A folder that is not there yet has no numbers. It is placed by its anchor, the nearest folder
// above it that is there, and by the names still to be made below the anchor.
//
// This is the same reading as the cli's check of a rehearsal folder
// (packages/cli/src/folder-identity.ts; test/seed.test.ts holds the two to the same answers). It
// is written out again here because the demo may not load the cli. Two things differ on purpose:
// no error here names a path (a path holds the account's name), and something that is there but
// is not a folder is placed by the folder it sits in.
//
// Anything that cannot be looked at is an error here, never a "no": the callers use these answers
// to keep the demo off the real data folder, and for them not knowing means refusing.
import { statSync } from "node:fs";
import path from "node:path";

/** What the disk calls a folder. Kept as bigint: a file number does not always fit a JavaScript number. */
export interface FolderId {
  dev: bigint;
  ino: bigint;
}

/** What is at a path, links followed: its numbers, and whether it is a folder. Null when nothing is there. Throws for anything else. */
export type StatPath = (target: string) => (FolderId & { isFolder: boolean }) | null;

/** The disk could not say which folder a path is. The message never holds the path. */
export class FolderUnknownError extends Error {
  constructor(why: string) {
    super(`it is not known which folder that is (${why})`);
    this.name = "FolderUnknownError";
  }
}

export const statPath: StatPath = (target) => {
  try {
    const info = statSync(target, { bigint: true });
    return { dev: info.dev, ino: info.ino, isFolder: info.isDirectory() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new FolderUnknownError(typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? code : "no reason given");
  }
};

/** How many folders deep a path may be. No real path comes near it; it only stops a walk that would never end. */
const MAX_LEVELS = 128;

function sameId(a: FolderId, b: FolderId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Two names for something not made yet. A Mac's disk takes capitals, and the two ways of storing
 * an accent, as the same name, so they count as the same here. On a disk that tells them apart
 * this can only answer "the same" too often, which is the safe side.
 */
function sameName(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * Where a folder is: its anchor (the folder itself when it is there, else the nearest folder
 * above it that is), the anchor's numbers, and the names below the anchor that are not there yet.
 * A file on the way counts as not there: nothing can be made below it.
 */
export function locateFolder(folder: string, stat: StatPath = statPath): { anchor: string; anchorId: FolderId; rest: string[] } {
  let anchor = path.resolve(folder);
  const rest: string[] = [];
  for (;;) {
    const found = stat(anchor);
    if (found !== null && found.isFolder) return { anchor, anchorId: { dev: found.dev, ino: found.ino }, rest };
    const parent = path.dirname(anchor);
    if (parent === anchor) throw new FolderUnknownError("no folder on the way to it is there");
    rest.unshift(path.basename(anchor));
    anchor = parent;
  }
}

/**
 * The numbers of a folder that is there and of every folder above it, the folder's own first.
 * Each step up is asked of the disk as "<path>/..", because cutting the last name off the text
 * gives the wrong folder when that name is a link (or a /.vol number). Throws past 128 levels.
 */
export function folderAncestry(anchor: string, stat: StatPath = statPath): FolderId[] {
  const look = (folder: string): FolderId => {
    const found = stat(folder);
    if (found === null) throw new FolderUnknownError("a folder on the way up is not there");
    return { dev: found.dev, ino: found.ino };
  };
  let current = anchor;
  let id = look(current);
  const ids = [id];
  while (ids.length <= MAX_LEVELS) {
    current = `${current}/..`;
    const above = look(current);
    // The top folder is its own parent.
    if (sameId(above, id)) return ids;
    ids.push(above);
    id = above;
  }
  throw new FolderUnknownError("too many folders deep");
}

/** True when `folder` is `parent` or anywhere inside it, however either one is spelled. Neither has to be there yet. */
export function sameOrInsideFolder(folder: string, parent: string, stat: StatPath = statPath): boolean {
  const inner = locateFolder(folder, stat);
  const outer = locateFolder(parent, stat);
  // The parent is there: it is the folder's anchor, or one of the folders above that.
  if (outer.rest.length === 0) return folderAncestry(inner.anchor, stat).some((id) => sameId(id, outer.anchorId));
  // The parent is not there yet, so nothing is inside it but what is spelled through the same
  // anchor and the same names.
  return sameId(inner.anchorId, outer.anchorId) && outer.rest.every((name, index) => sameName(inner.rest[index] ?? "", name));
}

/** True when one of the two is the other, or inside the other. */
export function foldersTouch(a: string, b: string, stat: StatPath = statPath): boolean {
  return sameOrInsideFolder(a, b, stat) || sameOrInsideFolder(b, a, stat);
}
