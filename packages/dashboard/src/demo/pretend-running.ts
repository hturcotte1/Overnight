// For the demo only: make a demo folder look as if Overnight's programs were running on it.
//
// The dashboard tells "Listening" from "Not listening", and a build that is running from one that
// was cut off, by looking at three lock files (listen.lock, build.lock, deliver.lock). Nothing
// runs on a demo folder, so without this the demo's page says "Not listening" over a scene in
// which a build is under way. This holds the locks the way the real programs do (cli,
// single-instance.ts): an open transaction on a small file of its own, which the operating system
// drops the moment this process ends, however it ends. Nothing is written into the files.
//
// A lock held on the REAL data folder would keep the real listener from starting. So this only
// ever works in a folder the demo's seed filled, and ./folder.ts refuses the real one first.
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { LOCK_FILE_NAMES } from "../log-messages.ts";
import { plainFileOrMissing, seededDemoFolder } from "./folder.ts";

export type DemoProgram = keyof typeof LOCK_FILE_NAMES;

/**
 * Hold the locks of `programs` in the demo folder `dir` until the function this returns is called
 * (or the process ends). Throws a DemoFolderError for any folder the seed did not fill, and an
 * Error if one of the locks is already held; in both cases nothing is left held.
 */
export function pretendRunning(dir: string, programs: readonly DemoProgram[]): () => void {
  const root = seededDemoFolder(dir);
  const held: Database.Database[] = [];
  const letGo = (): void => {
    for (const db of held.splice(0)) db.close();
  };
  try {
    for (const program of new Set(programs)) {
      if (!Object.hasOwn(LOCK_FILE_NAMES, program)) throw new Error("The demo can pretend that the listener, the build or the deliver job is running, and nothing else.");
      const file = plainFileOrMissing(root, LOCK_FILE_NAMES[program]);
      const isNew = !existsSync(file);
      const db = new Database(file, { timeout: 0 });
      held.push(db);
      if (isNew) chmodSync(file, 0o600);
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
    }
  } catch (error) {
    letGo();
    throw error;
  }
  return letGo;
}
