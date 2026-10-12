// Where the demo may write: only into the folder it is handed, and never into Overnight's real
// data folder. Everything else in the dashboard only reads, so this file is the whole of its
// safety on the writing side.
//
// The rules, in the order they are checked:
//   1. The folder must be named by its full path.
//   2. It must not be the real data folder (~/.overnight), nor inside it, nor a folder that holds
//      it. This is asked three times:
//        - of the path as written, before anything on disk is looked at. Names are compared
//          without regard to capitals, because on a Mac "/Users/x/.Overnight" is the same folder
//          as "/Users/x/.overnight";
//        - again with every link followed, so a link that leads there is refused too;
//        - and last of the disk itself, by the numbers it gives each folder (./folder-identity.ts).
//          A Mac has names for a folder that are not links and that no spelling rule finds:
//          /System/Volumes/Data/Users/x/.overnight, and /.vol/<device>/<file number>. Those are
//          the same folder by their numbers, and are refused by them. If the disk cannot say
//          which folder a path is, that is a refusal too.
//   3. To be filled (the seed): it must exist, be a folder, and be empty.
//      To be changed later (the invented night): it must carry the note the seed left in it.
//   4. Every folder made and every file written below it is reached one name at a time, and a
//      link on the way is refused, so nothing can be written "inside" the folder and land elsewhere.
//
// No message here names the folder that was given: a path holds the account's name.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { foldersTouch } from "./folder-identity.ts";

export class DemoFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoFolderError";
  }
}

/** The file the seed leaves at the top of a demo folder. Its first line says the data is invented. */
export const DEMO_MARKER_FILE = "DEMO-DATA.txt";
export const DEMO_MARKER_TEXT =
  "SYNTHETIC data: every title, pitch, quote and line in this folder is made up by the Overnight dashboard's demo. None of it is Bee data.\n" +
  "It is safe to delete the whole folder.\n";

const REAL_FOLDER_NAME = ".overnight";

export const NOT_A_FULL_PATH = "Refused: the demo needs the full path of the folder to write into.";
export const IS_THE_REAL_FOLDER =
  "Refused: that is Overnight's real data folder (~/.overnight), or a folder inside it or around it. The demo only ever writes into a new, empty folder of its own.";
export const CANNOT_TELL = "Refused: the demo could not find out which folder that is, and it only writes where it knows it is not Overnight's real data folder.";
export const NOT_THERE = "Refused: the demo only writes into a folder that is already there and empty, and that folder does not exist.";
export const NOT_A_FOLDER = "Refused: the demo only writes into a folder, and that is not one.";
export const NOT_EMPTY = "Refused: the demo only writes into an empty folder, and that one has something in it.";
export const NOT_A_DEMO_FOLDER = `Refused: that folder was not made by the demo (it has no ${DEMO_MARKER_FILE}), and the invented night only plays in a demo folder.`;
export const LEADS_OUTSIDE = "Refused: something in the demo folder is a link or is not what the demo put there, so writing to it could land outside the folder.";

/**
 * The real data folder, by every name the home folder has: what $HOME says (which is what core's
 * settings go by) and what the system says the user's home is. They differ only when a program
 * was started with another $HOME, and then both are refused.
 */
export function realDataFolders(): string[] {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    // A user with no entry in the system's list: $HOME is all there is.
  }
  return [...new Set(homes.filter((home) => home !== "" && path.isAbsolute(home)).map((home) => path.join(home, REAL_FOLDER_NAME)))];
}

/**
 * A path with its links followed, as far as it exists: the nearest folder that is there is
 * resolved, and the parts below it (not made yet) are kept as written. This finds links and
 * nothing else: the Mac's other names for a folder come out of it as they went in, which is why
 * the disk is asked as well (./folder-identity.ts).
 */
function nearestRealPath(folder: string): string {
  let existing = path.resolve(folder);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Not there after all, or not ours to look at: compare it as written.
  }
  return path.join(real, ...rest);
}

/** For comparing two paths as a Mac's disk does: capitals and the two ways of writing an accent do not matter. */
function folded(folder: string): string {
  return folder.normalize("NFC").toLowerCase();
}

function sameOrInside(folder: string, parent: string): boolean {
  const a = folded(folder);
  const b = folded(parent);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Is one of the two the other, or inside the other? */
function touches(a: string, b: string): boolean {
  return sameOrInside(a, b) || sameOrInside(b, a);
}

/**
 * Why the demo may not write into `dir`, or null when the real data folder is nowhere near it.
 * Only names and the disk's numbers for folders are compared: nothing inside any folder is opened
 * or listed.
 */
export function realFolderProblem(dir: string, realFolders: readonly string[] = realDataFolders()): string | null {
  if (typeof dir !== "string" || dir === "" || dir.includes("\0") || !path.isAbsolute(dir)) return NOT_A_FULL_PATH;
  const written = path.resolve(dir);
  // As written first: a plain match is refused before the disk is looked at at all.
  if (realFolders.some((real) => touches(written, path.resolve(real)))) return IS_THE_REAL_FOLDER;
  // Then with every link followed, on both sides.
  const followed = nearestRealPath(written);
  if (realFolders.some((real) => touches(followed, nearestRealPath(real)))) return IS_THE_REAL_FOLDER;
  // Last, by what the disk says each folder is, whatever it is called. The path with its links
  // followed is asked too: for a link to a file, only that one says which folder the file is in.
  try {
    const asked = followed === written ? [written] : [written, followed];
    if (realFolders.some((real) => asked.some((folder) => foldersTouch(folder, path.resolve(real))))) return IS_THE_REAL_FOLDER;
  } catch {
    // Not knowing which folder it is means refusing.
    return CANNOT_TELL;
  }
  return null;
}

/** The folder with its links followed, or a refusal if it is missing or not a folder. */
function realFolder(dir: string): string {
  const refused = realFolderProblem(dir);
  if (refused !== null) throw new DemoFolderError(refused);
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    throw new DemoFolderError(NOT_THERE);
  }
  let isFolder: boolean;
  try {
    isFolder = statSync(real).isDirectory();
  } catch {
    throw new DemoFolderError(NOT_THERE);
  }
  if (!isFolder) throw new DemoFolderError(NOT_A_FOLDER);
  // Asked once more of the very path that will be written to.
  const again = realFolderProblem(real);
  if (again !== null) throw new DemoFolderError(again);
  return real;
}

/**
 * For the seed: the folder to fill, with its links followed. Throws a DemoFolderError unless it
 * is an existing, empty folder that has nothing to do with the real data folder.
 */
export function emptyDemoFolder(dir: string): string {
  const real = realFolder(dir);
  let names: string[];
  try {
    names = readdirSync(real);
  } catch {
    throw new DemoFolderError(NOT_A_FOLDER);
  }
  if (names.length > 0) throw new DemoFolderError(NOT_EMPTY);
  return real;
}

/**
 * For the invented night: a folder the seed filled, with its links followed. Throws a
 * DemoFolderError for the real data folder, and for any folder that does not carry the seed's note.
 */
export function seededDemoFolder(dir: string): string {
  const real = realFolder(dir);
  const marker = path.join(real, DEMO_MARKER_FILE);
  let text: string | null = null;
  try {
    if (lstatSync(marker).isFile()) text = readFileSync(marker, "utf8");
  } catch {
    // No note, or it cannot be read: not a demo folder.
  }
  if (text !== DEMO_MARKER_TEXT) throw new DemoFolderError(NOT_A_DEMO_FOLDER);
  return real;
}

/** A name that stays inside the folder it is joined to. */
function isPlainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * The folder `root/parts...`, made if it is missing (private to the user). `root` is a folder
 * whose links are already followed. Each name on the way down must be a real folder: a link, or
 * anything else, is refused before a single step is taken through it.
 */
export function folderInside(root: string, ...parts: string[]): string {
  let dir = root;
  for (const name of parts) {
    if (!isPlainName(name)) throw new DemoFolderError(LEADS_OUTSIDE);
    dir = path.join(dir, name);
    let info: ReturnType<typeof lstatSync> | null = null;
    try {
      info = lstatSync(dir);
    } catch {
      // Not there yet: made just below.
    }
    if (info === null) mkdirSync(dir, { mode: 0o700 });
    else if (!info.isDirectory()) throw new DemoFolderError(LEADS_OUTSIDE);
  }
  return dir;
}

/** Is `root/parts...` there, as a real folder, with only real folders on the way to it? Makes nothing. */
export function isFolderInside(root: string, ...parts: string[]): boolean {
  let dir = root;
  for (const name of parts) {
    if (!isPlainName(name)) return false;
    dir = path.join(dir, name);
    try {
      if (!lstatSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Is `root/parts...` there as a plain file, with only real folders on the way to it? */
export function isFileInside(root: string, ...parts: string[]): boolean {
  const name = parts.at(-1);
  if (name === undefined || !isPlainName(name) || !isFolderInside(root, ...parts.slice(0, -1))) return false;
  try {
    return lstatSync(path.join(root, ...parts)).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuses unless `root/parts...` is a plain file or not there at all. For the files other code
 * writes for us (the database, the two logs): looked at just before they are opened.
 */
export function plainFileOrMissing(root: string, ...parts: string[]): string {
  const name = parts.at(-1);
  if (name === undefined || !isPlainName(name)) throw new DemoFolderError(LEADS_OUTSIDE);
  const file = path.join(folderInside(root, ...parts.slice(0, -1)), name);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(file);
  } catch {
    return file;
  }
  if (!info.isFile()) throw new DemoFolderError(LEADS_OUTSIDE);
  return file;
}

/**
 * Write the file `root/parts...` whole (private to the user), making its folders if needed. The
 * file is opened without following a link, so a link planted under its name is refused, not
 * written through.
 */
export function writeInside(root: string, parts: readonly string[], data: string | Buffer): string {
  const name = parts.at(-1);
  if (name === undefined || !isPlainName(name)) throw new DemoFolderError(LEADS_OUTSIDE);
  const file = path.join(folderInside(root, ...parts.slice(0, -1)), name);
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new DemoFolderError(LEADS_OUTSIDE);
  }
  try {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } finally {
    closeSync(fd);
  }
  return file;
}

/**
 * Move the folder `root/from...` to `root/to...` with one rename, as the builder moves a finished
 * build. Both ends are checked the same way as a write; a folder already at the far end is refused.
 */
export function moveInside(root: string, from: readonly string[], to: readonly string[]): void {
  const name = to.at(-1);
  if (name === undefined || !isPlainName(name) || !isFolderInside(root, ...from)) throw new DemoFolderError(LEADS_OUTSIDE);
  const target = path.join(folderInside(root, ...to.slice(0, -1)), name);
  // lstat, not "exists": a link that points nowhere is still something in the way.
  let inTheWay = true;
  try {
    lstatSync(target);
  } catch {
    inTheWay = false;
  }
  if (inTheWay) throw new DemoFolderError(LEADS_OUTSIDE);
  renameSync(path.join(root, ...from), target);
}
