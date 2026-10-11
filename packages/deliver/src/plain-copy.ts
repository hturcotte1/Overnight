// Copy a folder that an AI agent (or code it wrote) produced, trusting nothing about it.
//
// Only plain files and folders are copied. A symbolic link, a hard link or anything else (a pipe,
// a device) makes the whole copy fail, because this code runs with the user's full rights: a link
// planted in dist would otherwise be followed and the file it points at would be published
// (shown in the M2 deliver experiment).
//
// A program that is still running may change the folder while it is being copied, and the classic
// trick is to swap a folder ABOVE a file for a link between two of our steps. Two defences:
//   - On macOS every folder is read "by its number" (/.vol/<disk>/<inode>, tried on Oct 10, 2026):
//     once a folder has been looked at and found to be a real folder, everything in it is reached
//     through that number, so no name above it is ever looked up again and a swap changes nothing.
//   - Where that is not available, each file is opened with "do not follow", compared with what
//     was listed, and its whole path is checked again after it was read.
// Callers still take a folder out of a sandbox's reach before copying it whenever they can.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export interface PlainCopyOptions {
  maxFiles: number;
  maxBytes: number;
  /** Entries with these names are left out, at any depth (for example node_modules). Upper and lower case count as the same. */
  skipNames?: readonly string[];
  /**
   * Entries with these names make the copy fail, at any depth (for example .git inside dist).
   * Upper and lower case count as the same, because on this Mac's disk ".GIT" IS ".git".
   */
  refuseNames?: readonly string[];
  /** Keep a file's "may be run" permission. Off for anything that gets published. */
  keepExecutable?: boolean;
  /** For tests: called with each entry's path inside the folder, just before it is looked at. */
  onEntry?: (relativePath: string) => void;
}

export type PlainCopyProblem = "missing" | "link" | "hard-link" | "special" | "refused-name" | "too-many-files" | "too-big" | "too-deep" | "changed" | "target-not-empty" | "unreadable";

export type PlainCopyResult = { ok: true; files: number; bytes: number } | { ok: false; problem: PlainCopyProblem; reason: string; files: number; bytes: number };

const MAX_DEPTH = 40;

/**
 * Names that may not appear anywhere in a dist folder that is going to be published. Each one
 * changes what git does with the files around it, so what got pushed would no longer be what was
 * tested: .gitignore drops files, .gitattributes rewrites them, .gitmodules and .git nest repos.
 */
export const DIST_REFUSE_NAMES = [".git", ".gitignore", ".gitattributes", ".gitmodules"] as const;

class CopyStop extends Error {
  readonly problem: PlainCopyProblem;
  constructor(problem: PlainCopyProblem, reason: string) {
    super(reason);
    this.problem = problem;
  }
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`;
}

/**
 * The "by its number" address of a folder, or null where the system has no such thing (or the
 * number does not lead back to the same folder).
 */
function byNumber(folder: BigIntStats): string | null {
  const address = `/.vol/${folder.dev}/${folder.ino}`;
  try {
    const found = lstatSync(address, { bigint: true });
    return found.isDirectory() && found.dev === folder.dev && found.ino === folder.ino ? address : null;
  } catch {
    return null;
  }
}

/**
 * Copy `source` into `target` (which must be missing or empty). `what` names the folder in
 * failure reasons, for example "the app's folder" or "dist". Never throws.
 */
export function copyPlainTree(source: string, target: string, what: string, options: PlainCopyOptions): PlainCopyResult {
  const skip = new Set((options.skipNames ?? []).map((name) => name.toLowerCase()));
  const refuse = new Set((options.refuseNames ?? []).map((name) => name.toLowerCase()));
  let files = 0;
  let bytes = 0;
  const changed = () => new CopyStop("changed", `${what} changed while it was being copied.`);

  /** `pinned`: `from` was reached through its folder's number, so nothing above it can have been swapped. */
  const copyFile = (from: string, to: string, listed: BigIntStats, pinned: boolean) => {
    let fd: number;
    try {
      fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      // ELOOP here means the name became a link after it was listed.
      throw changed();
    }
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) throw changed();
      if (opened.nlink > 1n) throw new CopyStop("hard-link", `${what} contains a hard link, which is not allowed.`);
      files += 1;
      if (files > options.maxFiles) throw new CopyStop("too-many-files", `${what} has more than ${options.maxFiles} files.`);
      // Read through the open file, and never more than the budget left, whatever size was listed.
      const room = options.maxBytes - bytes;
      const chunks: Buffer[] = [];
      let read = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        read += count;
        if (read > room) throw new CopyStop("too-big", `${what} is larger than ${sizeText(options.maxBytes)}.`);
        chunks.push(buffer.subarray(0, count));
      }
      bytes += read;
      if (!pinned) {
        // If a folder above the file was swapped for a link, the file we opened is not the one at this path.
        const after = lstatSync(from, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || realpathSync(from) !== from) throw changed();
      }
      const mode = options.keepExecutable && (opened.mode & 0o100n) !== 0n ? 0o755 : 0o644;
      writeFileSync(to, Buffer.concat(chunks), { mode, flag: "wx" });
    } finally {
      closeSync(fd);
    }
  };

  /** `fromDir` is how the folder is reached: by its number when `pinned`, by its path otherwise. */
  const walk = (fromDir: string, toDir: string, relative: string, depth: number, pinned: boolean) => {
    if (depth > MAX_DEPTH) throw new CopyStop("too-deep", `${what} has folders nested more than ${MAX_DEPTH} deep.`);
    const names = readdirSync(fromDir).sort();
    for (const name of names) {
      const lower = name.toLowerCase();
      if (skip.has(lower)) continue;
      // The reason names the entry as WE spell it, never as the app does: reasons reach the wrist and the log.
      if (refuse.has(lower)) throw new CopyStop("refused-name", `${what} contains an entry named "${lower}", which is not allowed.`);
      // A name with a slash or a NUL cannot come out of a folder listing; anything odd stops the copy.
      if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw changed();
      const inside = relative === "" ? name : `${relative}/${name}`;
      options.onEntry?.(inside);
      const from = `${fromDir}/${name}`;
      const to = path.join(toDir, name);
      const stat = lstatSync(from, { bigint: true });
      if (stat.isSymbolicLink()) throw new CopyStop("link", `${what} contains a symbolic link, which is not allowed.`);
      if (stat.isDirectory()) {
        mkdirSync(to, { mode: 0o755 });
        if (pinned) {
          // From here on this folder is reached by the number of what we just looked at.
          const address = byNumber(stat);
          if (address === null) throw changed();
          walk(address, to, inside, depth + 1, true);
        } else {
          walk(from, to, inside, depth + 1, false);
        }
      } else if (stat.isFile()) {
        copyFile(from, to, stat, pinned);
      } else {
        throw new CopyStop("special", `${what} contains something that is not a plain file or folder.`);
      }
    }
  };

  try {
    let top: BigIntStats;
    try {
      top = lstatSync(source, { bigint: true });
    } catch {
      throw new CopyStop("missing", `${what} does not exist.`);
    }
    if (top.isSymbolicLink()) throw new CopyStop("link", `${what} is a symbolic link, which is not allowed.`);
    if (!top.isDirectory()) throw new CopyStop("special", `${what} is not a folder.`);
    mkdirSync(target, { recursive: true, mode: 0o755 });
    if (readdirSync(target).length > 0) throw new CopyStop("target-not-empty", "The folder to copy into is not empty.");
    const realTarget = realpathSync(target);
    const address = byNumber(top);
    if (address !== null) {
      walk(address, realTarget, "", 0, true);
    } else {
      // The folders ABOVE the source are ours (the data folder), so resolving them is safe; from
      // here down every path must already be its own real path.
      walk(realpathSync(source), realTarget, "", 0, false);
    }
    return { ok: true, files, bytes };
  } catch (error) {
    if (error instanceof CopyStop) return { ok: false, problem: error.problem, reason: error.message, files, bytes };
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, problem: "unreadable", reason: `${what} could not be copied${code ? ` (${code})` : ""}.`, files, bytes };
  }
}
