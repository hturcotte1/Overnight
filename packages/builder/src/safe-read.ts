// Reading a file that a build agent, or a job inside the Kiro Crew gateway, may have written:
// BUILD_STATUS.json, the probe's result files, and Kiro Crew's own records and settings (a job
// can write those too). Such a file can be swapped for something else at any moment, so it is
// never read with a plain "look, then read":
//   - a named pipe would make a plain read wait for ever, and the whole program with it (timers
//     do not fire while a blocking read is stuck, so no time limit could rescue it);
//   - a symbolic link would have us read some other file;
//   - a huge file would have us load it all.
// So: look first without following a link, open without following a link and without waiting,
// look again at what was actually opened, and read at most a fixed number of bytes from it.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type SmallFile =
  | { ok: true; text: string; size: number; mtimeMs: number }
  | {
      ok: false;
      /** "missing": no such file. "not-a-file": a link, a pipe, a folder ... "too-large": over the limit. */
      why: "missing" | "not-a-file" | "too-large" | "unreadable";
    };

const CHUNK_BYTES = 64 * 1024;

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

function refusal(error: unknown): SmallFile {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, why: "missing" };
  // ELOOP: the name is a symbolic link (O_NOFOLLOW). The others: not something that can be read as a file.
  if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO" || code === "EOPNOTSUPP") return { ok: false, why: "not-a-file" };
  return { ok: false, why: "unreadable" };
}

/**
 * The text of a plain file of at most `maxBytes` bytes, with the size and modification time of
 * the file that was actually opened. Never waits, never follows a link at the file's own name,
 * never throws.
 *
 * `betweenLookAndOpen` is for tests only: it is called after the first look and before the open,
 * the moment at which something else can swap the file.
 */
export function readSmallFile(file: string, maxBytes: number, betweenLookAndOpen?: () => void): SmallFile {
  try {
    if (!lstatSync(file).isFile()) return { ok: false, why: "not-a-file" };
  } catch (error) {
    return refusal(error);
  }
  betweenLookAndOpen?.();
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return refusal(error);
  }
  try {
    // The file may have been swapped between the look and the open: this is the one we hold.
    const info = fstatSync(fd);
    if (!info.isFile()) return { ok: false, why: "not-a-file" };
    if (info.size > maxBytes) return { ok: false, why: "too-large" };
    // Read to the end in pieces, giving up as soon as there is more than the limit: a file can
    // grow after the look (Kiro Crew appends to its records while we read them).
    const pieces: Buffer[] = [];
    let length = 0;
    for (;;) {
      const piece = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1 - length));
      const read = readSync(fd, piece, 0, piece.length, null);
      if (read === 0) break;
      pieces.push(piece.subarray(0, read));
      length += read;
      if (length > maxBytes) return { ok: false, why: "too-large" };
    }
    return { ok: true, text: Buffer.concat(pieces, length).toString("utf8"), size: length, mtimeMs: info.mtimeMs };
  } catch (error) {
    return refusal(error);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing more to do with it
    }
  }
}

/** The text, or null for anything that is not a plain file within the limit. */
export function readSmallText(file: string, maxBytes: number): string | null {
  const result = readSmallFile(file, maxBytes);
  return result.ok ? result.text : null;
}
