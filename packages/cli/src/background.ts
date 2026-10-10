// What `overnight status` can say about the listener without asking macOS anything.
// Two plain facts: is a listener running on this data folder (it holds the lock), and has the
// background job been installed (its settings file is in place). The full picture from macOS,
// with the last exit code and log lines, is `scripts/install-agents.sh status`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { listenLockFile, listenLockHeld } from "./single-instance.ts";

/** The background job's name in macOS. scripts/install-agents.sh and the template in launchd/ use the same one. */
export const JOB_LABEL = "com.overnight.listen";

export interface ListenerState {
  /** Is an `overnight listen` running on this data folder right now? Null if we could not tell. */
  running: boolean | null;
  /** Is the background job's settings file in ~/Library/LaunchAgents? */
  jobInstalled: boolean;
}

/** Where scripts/install-agents.sh puts the job's settings file. */
export function jobSettingsFile(home: string = homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${JOB_LABEL}.plist`);
}

export function readListenerState(paths: Pick<DataPaths, "root">, home: string = homedir()): ListenerState {
  return { running: listenLockHeld(listenLockFile(paths)), jobInstalled: existsSync(jobSettingsFile(home)) };
}
