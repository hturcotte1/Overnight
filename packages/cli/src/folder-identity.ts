// Is this folder that folder, or inside it? Asked of the disk, not of the spelling.
//
// One folder can be written many ways: through a link, in other capitals, and on a Mac also as
// /System/Volumes/Data/Users/... or as /.vol/<device>/<file number>. Whatever the spelling, the
// disk gives a folder one pair of numbers (its device and its file number), so folders are
// compared by that pair.
//
// A folder that is not there yet has no numbers. It is placed by its anchor, the nearest folder
// above it that is there, and by the names still to be made below the anchor.
//
// Anything that cannot be looked at is an error here, never a "no": the callers use these answers
// to keep a rehearsal off the real data folder, and for them not knowing means refusing.
import { statSync } from "node:fs";
import path from "node:path";

/** What the disk calls a folder. Kept as bigint: a file number does not always fit a JavaScript number. */
export interface FolderId {
  dev: bigint;
  ino: bigint;
}

/** A folder's numbers, links followed. Null when nothing is there (ENOENT, ENOTDIR). Throws for anything else. */
export type StatFolder = (folder: string) => FolderId | null;

export const statFolder: StatFolder = (folder) => {
  try {
    const info = statSync(folder, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`"${folder}" could not be looked at (${code ?? "no reason given"}), so it is not known which folder that is`, { cause: error });
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
 */
export function locateFolder(folder: string, stat: StatFolder = statFolder): { anchor: string; anchorId: FolderId; rest: string[] } {
  let anchor = path.resolve(folder);
  const rest: string[] = [];
  for (;;) {
    const anchorId = stat(anchor);
    if (anchorId !== null) return { anchor, anchorId, rest };
    const parent = path.dirname(anchor);
    if (parent === anchor) throw new Error(`no folder on the way to "${folder}" is there, so it is not known which folder that is`);
    rest.unshift(path.basename(anchor));
    anchor = parent;
  }
}

/**
 * The numbers of a folder that is there and of every folder above it, the folder's own first.
 * Each step up is asked of the disk as "<path>/..", because cutting the last name off the text
 * gives the wrong folder when that name is a link. Throws past 128 levels.
 */
export function folderAncestry(anchor: string, stat: StatFolder = statFolder): FolderId[] {
  const look = (folder: string): FolderId => {
    const id = stat(folder);
    if (id === null) throw new Error(`"${folder}" is not there, so it is not known which folder that is`);
    return id;
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
  throw new Error(`"${anchor}" is more than ${MAX_LEVELS} folders deep, so it is not known which folder that is`);
}

/** True when `folder` is `parent` or anywhere inside it, however either one is spelled. Neither has to be there yet. */
export function sameOrInsideFolder(folder: string, parent: string, stat: StatFolder = statFolder): boolean {
  const inner = locateFolder(folder, stat);
  const outer = locateFolder(parent, stat);
  // The parent is there: it is the folder's anchor, or one of the folders above that.
  if (outer.rest.length === 0) return folderAncestry(inner.anchor, stat).some((id) => sameId(id, outer.anchorId));
  // The parent is not there yet, so nothing is inside it but what is spelled through the same
  // anchor and the same names.
  return sameId(inner.anchorId, outer.anchorId) && outer.rest.every((name, index) => sameName(inner.rest[index] ?? "", name));
}

/** True when the two paths are one folder. Neither has to be there yet. */
export function sameFolder(a: string, b: string, stat: StatFolder = statFolder): boolean {
  const first = locateFolder(a, stat);
  const second = locateFolder(b, stat);
  return sameId(first.anchorId, second.anchorId) && first.rest.length === second.rest.length && first.rest.every((name, index) => sameName(name, second.rest[index] ?? ""));
}
