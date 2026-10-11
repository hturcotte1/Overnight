// One `overnight listen` per data folder. And one `overnight build`, and one `overnight deliver`.
//
// Two listeners on the same database would each notice the same idea and each ask about it, so
// the daily limit would be passed and the wrist would buzz twice. The usual way to get two is
// running `npx overnight listen` by hand while the background job is installed. Two builds would
// each start the same idea and pass the nightly limit; two delivers would publish and buzz twice.
// The usual way to get two of those is `npx overnight build-now` while the nightly job is running.
//
// Each lock is an open SQLite transaction on a small file of its own (<data folder>/listen.lock,
// build.lock, deliver.lock). The operating system holds it for the process and drops it the moment
// the process ends, however it ends, so it can never be left behind by a crash. Nothing is ever
// written to the file.
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DataPaths } from "@overnight/core";

/**
 * How long a starting listener waits for the lock before giving up. `overnight status` holds the
 * lock for an instant to see whether it is free; this wait is what stops that look from ever
 * turning a real start away.
 */
export const LOCK_WAIT_MS = 500;
/** How long `overnight status` waits: long enough to outlast another `status` taking the same look. */
const PEEK_WAIT_MS = 100;

/** Give this back when the listener stops. Safe to call more than once. */
export type ReleaseLock = () => void;

export function listenLockFile(paths: Pick<DataPaths, "root">): string {
  return path.join(paths.root, "listen.lock");
}

/** Held by `overnight build`, and by `overnight build-now` while it builds. */
export function buildLockFile(paths: Pick<DataPaths, "root">): string {
  return path.join(paths.root, "build.lock");
}

/** Held by `overnight deliver`, and by `overnight build-now` while it publishes and delivers. */
export function deliverLockFile(paths: Pick<DataPaths, "root">): string {
  return path.join(paths.root, "deliver.lock");
}

function heldBySomeoneElse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SQLITE_BUSY";
}

/**
 * Take the lock in `file`. Returns how to release it, or null if another process holds it.
 * Throws only if the lock file itself cannot be used (for example the folder is missing).
 */
export function takeLock(file: string, waitMs: number = LOCK_WAIT_MS): ReleaseLock | null {
  const isNew = !existsSync(file);
  const db = new Database(file, { timeout: waitMs });
  try {
    if (isNew) chmodSync(file, 0o600);
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (heldBySomeoneElse(error)) return null;
    throw error;
  }
  // The caller keeps this function for as long as it runs, and the function keeps `db`: the
  // lock lasts exactly as long as that, or until the process ends.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    db.close();
  };
}

/** The listener's name for the same thing: `overnight listen` takes its lock with this. */
export const takeListenLock = takeLock;

/**
 * Does some process hold the lock in `file` right now? True or false, or null if we could not
 * tell. Only looks: it never creates the lock file and gives the lock straight back. For the
 * listener's lock: is an `overnight listen` running on this data folder? For the build lock: is
 * a build?
 */
export function lockHeld(file: string): boolean | null {
  if (!existsSync(file)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { fileMustExist: true, timeout: PEEK_WAIT_MS });
    db.exec("BEGIN EXCLUSIVE");
    return false;
  } catch (error) {
    return heldBySomeoneElse(error) ? true : null;
  } finally {
    db?.close();
  }
}

/** The listener's name for the same thing: `overnight status` asks with this. */
export const listenLockHeld = lockHeld;
