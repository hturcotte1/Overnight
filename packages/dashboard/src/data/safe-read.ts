// Reading the files the dashboard shows: briefs, build notes, reports, screenshots and the two
// job logs. Some of them were written by a build agent, and a build job can still reach the
// folder a build is being made in, so a name can be swapped for something else at any moment.
// The same care as packages/builder/src/safe-read.ts, which reads the same kind of file:
//   - a named pipe would make a plain read wait for ever, and the whole page with it;
//   - a symbolic link would have us read, and show, some other file;
//   - a huge file would have us load it all.
// So: look first without following a link, open without following a link and without waiting,
// look again at what was actually opened, and read no more than a fixed number of bytes.
//
// Nothing here writes, and nothing here throws: whatever cannot be read safely is simply null.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const CHUNK_BYTES = 64 * 1024;
/** How every file is opened: for reading only, never through a link, never waiting for a pipe. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * For tests only: called after the first look at a file and before it is opened, the moment at
 * which something else can swap the file for a link or a pipe.
 */
export type BetweenLookAndOpen = () => void;

/**
 * Open a plain file and hand it to `use` with its size. Null for anything that is not a plain
 * file (a link, a pipe, a folder, nothing at all) and for anything that goes wrong on the way.
 */
function withPlainFile<T>(file: string, use: (fd: number, size: number) => T | null, betweenLookAndOpen?: BetweenLookAndOpen): T | null {
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  betweenLookAndOpen?.();
  let fd: number;
  try {
    fd = openSync(file, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    // The name may have been swapped between the look and the open: this is the file we hold.
    const info = fstatSync(fd);
    return info.isFile() ? use(fd, info.size) : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing more to do with it
    }
  }
}

/** Up to `wanted` bytes from `position` on. Fewer when the file ends first. */
function readBytes(fd: number, position: number, wanted: number): Buffer {
  const pieces: Buffer[] = [];
  let length = 0;
  while (length < wanted) {
    const piece = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, wanted - length));
    const read = readSync(fd, piece, 0, piece.length, position + length);
    if (read === 0) break;
    pieces.push(piece.subarray(0, read));
    length += read;
  }
  return Buffer.concat(pieces, length);
}

/**
 * Where a cut-off piece of UTF-8 really ends: a character of two to four bytes whose last bytes
 * fell behind the cut is left out whole, so the text never ends in a broken character.
 */
function wholeCharactersEnd(bytes: Buffer): number {
  // Walk back over at most three "more of the same character" bytes to the byte that starts it.
  let start = bytes.length - 1;
  while (start >= 0 && bytes.length - start <= 3 && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start -= 1;
  if (start < 0) return bytes.length;
  const lead = bytes[start] ?? 0;
  const needs = lead >= 0b1111_0000 ? 4 : lead >= 0b1110_0000 ? 3 : lead >= 0b1100_0000 ? 2 : 1;
  return bytes.length - start < needs ? start : bytes.length;
}

function limitOf(maxBytes: number): number {
  return Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
}

/**
 * The start of a plain file as text: at most `maxBytes` bytes of it, and whether there was more.
 * Null for a link, a pipe, a folder or a missing file. Never waits, never throws.
 */
export function readSmallFile(file: string, maxBytes: number, betweenLookAndOpen?: BetweenLookAndOpen): { text: string; cut: boolean } | null {
  const limit = limitOf(maxBytes);
  return withPlainFile(
    file,
    (fd) => {
      // One byte more than the limit says whether there was more, whatever size the first look gave
      // (a file can grow while it is read).
      const bytes = readBytes(fd, 0, limit + 1);
      if (bytes.length <= limit) return { text: bytes.toString("utf8"), cut: false };
      const kept = bytes.subarray(0, limit);
      return { text: kept.subarray(0, wholeCharactersEnd(kept)).toString("utf8"), cut: true };
    },
    betweenLookAndOpen,
  );
}

/**
 * The end of a plain file as text: its last `maxBytes` bytes. When that is not the whole file,
 * the first line is dropped, because it is almost certainly only the end of one. For the job
 * logs, which only ever grow at the end. Null when the file cannot be read safely.
 */
export function readTail(file: string, maxBytes: number, betweenLookAndOpen?: BetweenLookAndOpen): string | null {
  const limit = limitOf(maxBytes);
  return withPlainFile(
    file,
    (fd, size) => {
      const from = Math.max(0, size - limit);
      const text = readBytes(fd, from, limit).toString("utf8");
      if (from === 0) return text;
      const firstBreak = text.indexOf("\n");
      return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    },
    betweenLookAndOpen,
  );
}

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A whole PNG picture of at most `maxBytes` bytes. Null for a larger file, for one that does not
 * start as a PNG does, and for anything that is not a plain file. A picture is never cut short.
 */
export function readPng(file: string, maxBytes: number, betweenLookAndOpen?: BetweenLookAndOpen): Buffer | null {
  const limit = limitOf(maxBytes);
  return withPlainFile(
    file,
    (fd, size) => {
      if (size > limit) return null;
      const bytes = readBytes(fd, 0, limit + 1);
      if (bytes.length > limit || bytes.length < PNG_SIGNATURE.length) return null;
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? bytes : null;
    },
    betweenLookAndOpen,
  );
}

/**
 * Would `readPng` hand out this file? True for a plain file of at most `maxBytes` bytes that
 * starts as a PNG does. Only its first eight bytes are read. A page asks this before it shows a
 * picture, so that an empty file, or a text file under a picture's name, is no picture at all
 * rather than a broken one.
 */
export function isPng(file: string, maxBytes: number, betweenLookAndOpen?: BetweenLookAndOpen): boolean {
  const limit = limitOf(maxBytes);
  return (
    withPlainFile(
      file,
      (fd, size) => (size <= limit && readBytes(fd, 0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? true : null),
      betweenLookAndOpen,
    ) === true
  );
}

/** The files SQLite itself may open when it is handed a database: the database, and the three it keeps beside it. */
const SQLITE_OPENS = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Would SQLite wait for ever if it were handed this file? The database and the three lock files
 * are opened by SQLite, not by the careful reader above, and SQLite opens whatever stands under
 * the name. Under a named pipe it waits until someone writes into it (measured: the open waits
 * for a pipe in place of the file, the first question for one in place of its "-journal"), and
 * every page waits with it. So before SQLite is handed a file, this looks at it and at the three
 * names beside it: true when any of them is there and is not a plain file (a pipe, a folder, a
 * device; a link is followed, as SQLite would follow it). Looking never waits.
 */
export function sqliteWouldWait(file: string): boolean {
  return SQLITE_OPENS.some((ending) => {
    try {
      return !statSync(file + ending).isFile();
    } catch {
      // Not there, or not ours to look at: SQLite says which, and at once.
      return false;
    }
  });
}

/**
 * Is `parent/name` a real folder that sits in `parent` under that very name? False for a link
 * (even one that points at a folder), for a file, for nothing, and for a name that leads
 * anywhere else. A build job can swap the folder it works in for a link; what is behind such a
 * link is never read.
 */
export function isOwnFolder(parent: string, name: string): boolean {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  const folder = path.join(parent, name);
  try {
    if (!lstatSync(folder).isDirectory()) return false;
    return realpathSync(folder) === path.join(realpathSync(parent), name);
  } catch {
    return false;
  }
}
