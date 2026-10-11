// Getting rid of throwaway folders that code we do not trust has written in.
//
// Two rules:
//   - Move first, delete second. A sandboxed program may only write the folders its sandbox was
//     started with, by name. Renaming the folder ABOVE them takes those names away for good: the
//     program cannot write under the new name and cannot recreate the old one, because it may not
//     create the folder above. Only then do we walk and delete, with nobody able to change the
//     tree under us.
//   - Never throw. A build can lock its own folders (chmod 000); a leftover that cannot be deleted
//     must not stop a delivery. It stays under a ".gone-" name until a later clean-up gets it.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/** Folders moved aside for deletion get this prefix, so a later run can recognise and remove them. */
export const GONE_PREFIX = ".gone-";

const MAX_WALK_ENTRIES = 500_000;

/**
 * Give ourselves back the right to list and delete every folder in a tree. Links are never
 * followed. Call this only on a tree that has been moved aside (see above). Never throws.
 */
export function makeRemovable(dir: string): void {
  const stack = [dir];
  let seen = 0;
  while (stack.length > 0 && seen < MAX_WALK_ENTRIES) {
    const current = stack.pop() as string;
    seen += 1;
    try {
      if (!lstatSync(current).isDirectory()) continue;
      chmodSync(current, 0o700);
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    } catch {
      // Gone, or not ours to change: the delete below reports what is left.
    }
  }
}

/** Delete a tree. True when nothing is left of it. Never throws. */
export function removeTree(dir: string): boolean {
  for (const attempt of [1, 2]) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      // Most likely a folder the build left unlistable: unlock the tree and try once more.
      if (attempt === 1) makeRemovable(dir);
    }
  }
  try {
    lstatSync(dir);
    return false;
  } catch {
    return true;
  }
}

/**
 * Rename `dir` to a fresh ".gone-" name next to it. Returns the new path, or null when there was
 * nothing to move. Throws only when the folder exists and could not be renamed.
 */
export function moveAside(dir: string): string | null {
  try {
    lstatSync(dir);
  } catch {
    return null;
  }
  const target = path.join(path.dirname(dir), `${GONE_PREFIX}${path.basename(dir)}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
  renameSync(dir, target);
  return target;
}

/** Move a throwaway folder aside and delete it. True when nothing is left of it. Never throws. */
export function discardTree(dir: string): boolean {
  let moved: string | null;
  try {
    moved = moveAside(dir);
  } catch {
    // Could not be renamed (its parent is not ours to change?): try to delete it where it is.
    return removeTree(dir);
  }
  return moved === null ? true : removeTree(moved);
}

/** Delete what earlier clean-ups had to leave behind in `parent` (anything with the ".gone-" prefix). Never throws. */
export function sweepGone(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(GONE_PREFIX)) removeTree(path.join(parent, name));
  }
}
