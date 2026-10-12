// Is the listener running? Is a build, or the morning's deliver?
//
// Each of those programs holds a lock for as long as it runs: an open, exclusive SQLite
// transaction on a small file of its own in the data folder (packages/cli/src/single-instance.ts).
// The command line finds out by trying to take the lock for an instant. The dashboard must never
// do that: a look that held the lock at the wrong moment could turn a real start away, and a
// refused start is a night with no build.
//
// So this only looks. It opens the lock file read-only and asks one small question. SQLite
// answers "busy" when another process holds the file exclusively, and answers normally when
// nobody does. Nothing is created, nothing is changed, and no write lock is ever asked for
// (measured in spikes/12-sqlite-read-only.ts, also after a holder was killed).
import { lstatSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LOCK_FILE_NAMES } from "../log-messages.ts";
import type { Running } from "../types.ts";
import { sqliteWouldWait } from "./safe-read.ts";

function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

/** True only when we can see for ourselves that there is no such file. */
function isMissing(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * Does some process hold the lock in `file` right now? True or false, or null if we could not
 * tell. A lock file that is not there means nothing ever ran: false. Never waits, never throws.
 * Something that is not a plain file (a named pipe, say) is never opened: that is "cannot tell".
 */
export function peekLock(file: string): boolean | null {
  if (sqliteWouldWait(file)) return null;
  let db: Database.Database | null = null;
  try {
    // timeout 0: a held lock answers at once. The look never queues up behind anything.
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
    return false;
  } catch (error) {
    if (codeOf(error).startsWith("SQLITE_BUSY")) return true;
    return isMissing(file) ? false : null;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing more to do with it
    }
  }
}

/** Which of Overnight's three long-running programs are running on the data folder `root`. */
export function readRunning(root: string): Running {
  return {
    listener: peekLock(path.join(root, LOCK_FILE_NAMES.listener)),
    build: peekLock(path.join(root, LOCK_FILE_NAMES.build)),
    deliver: peekLock(path.join(root, LOCK_FILE_NAMES.deliver)),
  };
}
