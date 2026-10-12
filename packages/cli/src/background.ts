// What `overnight status` and `overnight preflight` can say about the background jobs without
// asking macOS anything. For the listener, two plain facts: is one running on this data folder
// (it holds the lock), and has its background job been installed (its settings file is in place).
// For the night jobs (build, deliver, the Kiro Crew gateway): whether each has been installed;
// for build and deliver, whether macOS wakes them every minute or still by its calendar; for the
// gateway, whether it was installed to run inside Overnight's own sandbox. And for all four:
// which data folder each was installed for. The full picture from macOS, with the last exit code
// and log lines, is `scripts/install-agents.sh status`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ClockedJob, DataPaths } from "@overnight/core";
import { sameFolder } from "./folder-identity.ts";
import { listenLockFile, listenLockHeld } from "./single-instance.ts";
import { readSmallFile } from "./small-file.ts";

/** The background job's name in macOS. scripts/install-agents.sh and the template in launchd/ use the same one. */
export const JOB_LABEL = "com.overnight.listen";

/**
 * The jobs that make the night happen. Each has a template in launchd/ and is put in place by
 * scripts/install-agents.sh under these names:
 *   build    wakes every minute; builds at BUILD_TIME, by Overnight's own clock
 *   deliver  wakes every minute; delivers 30 minutes before DELIVER_TIME, by the same clock
 *   crew     keeps the Kiro Crew gateway running, which the "kiro-crew" builder needs
 */
export const NIGHT_JOB_LABELS = {
  build: "com.overnight.build",
  deliver: "com.overnight.deliver",
  crew: "com.overnight.crew",
} as const;
export type NightJob = keyof typeof NIGHT_JOB_LABELS;
export const NIGHT_JOBS = Object.keys(NIGHT_JOB_LABELS) as NightJob[];

/**
 * The command that puts ONE job in place. Always with the job's name: a bare
 * "scripts/install-agents.sh install" means every job, so it would also stop and restart a
 * listener that is running, in the middle of the day.
 */
export function installCommand(job: NightJob | "listen"): string {
  return `scripts/install-agents.sh install ${job}`;
}

/** The order to install night jobs in: the gateway first (the build needs it), the deliver job last. */
const INSTALL_ORDER: readonly NightJob[] = ["crew", "build", "deliver"];

/** One command for each job named, to be run one after the other, in the order that makes sense. */
export function installCommands(jobs: readonly NightJob[]): string {
  return INSTALL_ORDER.filter((job) => jobs.includes(job))
    .map(installCommand)
    .join("   then: ");
}

// How long before DELIVER_TIME the morning's testing and publishing starts (SPEC §7). The night
// clock in @overnight/core owns the number; scripts/install-agents.sh prints its times with the
// same one (a test checks it).
export { DELIVER_LEAD_MINUTES } from "@overnight/core";

/** macOS's own program that starts a command inside a sandbox profile. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The PATH the build and deliver jobs run with (see their templates in launchd/): macOS's own
 * folders first, so that `git` and the like are the system's, then node's folder and ~/.local/bin
 * (gh, kirocrew and kiro-cli live there). Preflight looks for `gh` the same way the jobs will.
 */
export function nightJobPath(home: string, nodeDir: string): string {
  return `/usr/bin:/bin:/usr/sbin:/sbin:${nodeDir}:${path.join(home, ".local", "bin")}`;
}

/** For each night job: is its settings file in ~/Library/LaunchAgents? */
export type NightJobsState = Record<NightJob, boolean>;

export interface ListenerState {
  /** Is an `overnight listen` running on this data folder right now? Null if we could not tell. */
  running: boolean | null;
  /** Is the background job's settings file in ~/Library/LaunchAgents? */
  jobInstalled: boolean;
}

/** Where scripts/install-agents.sh puts a job's settings file. The listener's, unless another job is named. */
export function jobSettingsFile(home: string = homedir(), label: string = JOB_LABEL): string {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function readListenerState(paths: Pick<DataPaths, "root">, home: string = homedir()): ListenerState {
  return { running: listenLockHeld(listenLockFile(paths)), jobInstalled: existsSync(jobSettingsFile(home)) };
}

/** Which of the night jobs have been installed. Only looks for the files; asks macOS nothing. */
export function readNightJobsState(home: string = homedir()): NightJobsState {
  return {
    build: existsSync(jobSettingsFile(home, NIGHT_JOB_LABELS.build)),
    deliver: existsSync(jobSettingsFile(home, NIGHT_JOB_LABELS.deliver)),
    crew: existsSync(jobSettingsFile(home, NIGHT_JOB_LABELS.crew)),
  };
}

/** A settings file is a few kilobytes. This only keeps a runaway file out of memory. */
const MAX_SETTINGS_FILE_BYTES = 256 * 1024;

/**
 * How the installed Kiro Crew gateway job starts the gateway: "overnight" when its command begins
 * with sandbox-exec (the gateway runs inside Overnight's own sandbox), "crew" when it starts the
 * gateway directly. Null when the job is not installed or its settings file cannot be read.
 * Only reads the file scripts/install-agents.sh wrote; asks macOS nothing.
 */
export function readCrewJobSandbox(home: string = homedir()): "overnight" | "crew" | null {
  const text = readSmallFile(jobSettingsFile(home, NIGHT_JOB_LABELS.crew), MAX_SETTINGS_FILE_BYTES);
  if (text === null) return null;
  const first = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  if (first === undefined) return null;
  return first === SANDBOX_EXEC ? "overnight" : "crew";
}

/** What makes macOS start a night job: "timer" (every minute; Overnight's own clock decides) or "calendar" (once a day at a set hour, the old way). */
export type JobTrigger = "timer" | "calendar";

/** A settings file with its XML comments taken out, so a word inside a comment is never mistaken for a setting. */
function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * How the installed build or deliver job is started. Null when the job is not installed, its
 * settings file cannot be read, or the file names neither way. Only reads the file
 * scripts/install-agents.sh wrote; asks macOS nothing.
 */
export function readJobTrigger(job: ClockedJob, home: string = homedir()): JobTrigger | null {
  const text = readSmallFile(jobSettingsFile(home, NIGHT_JOB_LABELS[job]), MAX_SETTINGS_FILE_BYTES);
  if (text === null) return null;
  const settings = withoutComments(text);
  // A file that somehow names both is treated as the old way: reinstalling it is the fix either way.
  if (settings.includes("<key>StartCalendarInterval</key>")) return "calendar";
  return settings.includes("<key>StartInterval</key>") ? "timer" : null;
}

/** For both clocked jobs at once: what `overnight status` and `overnight preflight` ask. */
export function readJobTriggers(home: string = homedir()): Record<ClockedJob, JobTrigger | null> {
  return { build: readJobTrigger("build", home), deliver: readJobTrigger("deliver", home) };
}

/** The three ways the installer writes a character that XML reserves, turned back. "&amp;" last, so "&amp;lt;" stays "&lt;". */
function xmlUnescape(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * The data folder an installed job was installed for, read from where its settings file sends
 * what the job prints: <data folder>/logs/<job>.launchd.log. Null when the job is not installed,
 * the file cannot be read, or that path is not of that shape. The listener's, unless another
 * job's label is given.
 */
export function readJobDataDir(home: string = homedir(), label: string = JOB_LABEL): string | null {
  const text = readSmallFile(jobSettingsFile(home, label), MAX_SETTINGS_FILE_BYTES);
  if (text === null) return null;
  const written = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(withoutComments(text))?.[1];
  if (written === undefined) return null;
  const logFile = xmlUnescape(written);
  const logs = path.dirname(logFile);
  if (!path.isAbsolute(logFile) || path.basename(logs) !== "logs") return null;
  const dataDir = path.dirname(logs);
  // "/logs/x.log" would make the top of the disk a data folder. No installer writes that.
  return dataDir === path.dirname(dataDir) ? null : dataDir;
}

/** The data folders the installed background jobs (the listener and the three night jobs) were installed for, each once. */
export function installedJobFolders(home: string = homedir()): string[] {
  const folders = [JOB_LABEL, ...Object.values(NIGHT_JOB_LABELS)].map((label) => readJobDataDir(home, label)).filter((folder): folder is string => folder !== null);
  return [...new Set(folders)];
}

/**
 * Do the installed background jobs work on this data folder? True when one of them was installed
 * for it, false when all of them were installed for other folders, and null when that cannot be
 * told: no job is installed, or a folder could not be looked at. `overnight status` on a scratch
 * folder uses it, so as not to say "installed" about jobs that never touch that folder.
 */
export function jobsBelongHere(paths: Pick<DataPaths, "root">, home: string = homedir()): boolean | null {
  const folders = installedJobFolders(home);
  if (folders.length === 0) return null;
  try {
    return folders.some((folder) => sameFolder(folder, paths.root));
  } catch {
    return null;
  }
}
