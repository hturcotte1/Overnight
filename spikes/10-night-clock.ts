// Everything this spike makes is synthetic: an empty scratch data folder, a made-up home folder inside it, and two throwaway background jobs. None of it is Bee data.
//
// Spike 10: does macOS really wake the build and deliver jobs every minute, and does Overnight's
// own clock then start the build once, at its minute?
//
// Why it matters: the night used to hang on macOS's calendar, which ran both jobs an hour late on
// Oct 11. Since Milestone 3 macOS only wakes the two jobs (every 60 seconds, and when they are
// loaded) and Overnight's own clock decides. How regularly macOS does that, and how soon after a
// sleep, is written down nowhere, so it is measured here before the real jobs are moved over.
//
// Usage:
//   node spikes/10-night-clock.ts check
//   OVERNIGHT_DATA_DIR=~/.overnight-night-clock-0 node spikes/10-night-clock.ts dry [--minutes 2] [--after 1]
//   OVERNIGHT_DATA_DIR=~/.overnight-night-clock node spikes/10-night-clock.ts run [--minutes 3] [--after 3]
//   OVERNIGHT_DATA_DIR=~/.overnight-night-clock-2 node spikes/10-night-clock.ts sitting [--minutes 5]
//   node spikes/10-night-clock.ts cleanup
// Each run needs a new or an empty scratch folder. `--zone <name>` sets the throwaway jobs' TZ
// (America/Boise unless given); the repo's own .env is not read for it.
//
//   check     Changes nothing: no job is loaded and no file is written. Checks this script's own
//             tools: that it refuses the four real job names and the real data folders, and that
//             the installer's filled-in settings files, with the throwaway changes made, are
//             valid and say what they should.
//   dry       Tries this script itself, and says nothing about macOS: no job is loaded. The
//             script stands in for launchd. It starts the tool exactly as the two throwaway
//             settings files say (the same program, words, folder, environment and log file),
//             once at the start and every 60 seconds, and then watches and judges as `run` does.
//   run       Loads the two throwaway jobs for a few minutes and watches. The build's time is
//             set `--minutes` ahead (3). Expected: a look at the clock by each job as soon as it
//             is loaded and about every minute after; that first look counts today's time as
//             handled; exactly one "Tonight's build: 0 built, 0 failed; nothing approved." at the
//             set minute, on time; then nothing more for `--after` minutes (3).
//   sitting   The same, with the Mac put to sleep across the build's time. It needs a person:
//             pull out the power plug and close the lid at once when this script says so, open
//             it again after the time it names, and put the plug back. (On mains power this Mac
//             does not sleep with the lid closed: the live listener holds it awake. On battery
//             with the lid open it falls asleep by itself after an idle minute, so the plug comes
//             out only at the moment the lid is closed.)
//             Expected: the build starts once, a minute or two after the Mac is awake again,
//             and is marked late.
//   cleanup   Takes the two throwaway jobs out of macOS's list, if a run that was killed left
//             them there. (They are never in ~/Library/LaunchAgents, so a logout removes them too.)
//
// What is real here: the build and deliver templates in launchd/, filled in by the installer's
// own render_plist; launchd; the `overnight` tool; an empty database.
// What is changed for the throwaway jobs, and nothing else:
//   - the job's name (com.overnight-spike.night-clock.build and .deliver);
//   - HOME is a made-up, empty folder inside the scratch data folder, so the logins kept in the
//     home folder are out of the jobs' reach;
//   - six settings are added to the job's environment: OVERNIGHT_DATA_DIR (the scratch folder),
//     TZ, BUILD_TIME, DELIVER_TIME, PAUSED=false and KIROCREW_PORT=9 (a port nothing listens on).
//
// What it never does: it never uses a real job name (com.overnight.listen, .crew, .build,
// .deliver) or a file in ~/Library/LaunchAgents: every launchctl call is checked for both first.
// It never uses a real data folder, however it is spelled. It runs no delivery: the deliver job's
// time is set twelve hours off, because a delivery would talk to Bee. It uses no Kiro credits:
// the database is empty, so the build finds nothing approved. It publishes nothing. `run` and
// `sitting` refuse to start near the night's real build and delivery.
//
// It needs the internet: the night clock starts a run only when https://api.github.com/ answers
// (one request with no login in it, made by the `overnight` tool itself, as on any night).
//
// It prints yes/no, times and counts. The home folder is shown as "~". Results go in docs/spikes.md.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { CLOCKED_JOBS, DELIVER_LEAD_MINUTES, LATE_AFTER_MS, NIGHT_TICK_SECONDS } from "@overnight/core";
import type { ClockedJob } from "@overnight/core";
import { installedJobFolders, JOB_LABEL, NIGHT_JOB_LABELS } from "../packages/cli/src/background.ts";
import { sameOrInsideFolder } from "../packages/cli/src/folder-identity.ts";
import { readEnvFileText, realDataFolders } from "../packages/cli/src/rehearsal-folder.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO, "scripts", "install-agents.sh");
const ENTRY = path.join(REPO, "packages", "cli", "src", "main.ts");
const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The four jobs that run every night. This script never loads, stops or reads one of them. */
export const REAL_LABELS: readonly string[] = [JOB_LABEL, ...Object.values(NIGHT_JOB_LABELS)];
/** The throwaway jobs' names. Not in the real jobs' family (com.overnight.<job>), so nothing of Overnight's looks for them. */
export const SPIKE_LABELS: Record<ClockedJob, string> = {
  build: "com.overnight-spike.night-clock.build",
  deliver: "com.overnight-spike.night-clock.deliver",
};
/** A port nothing listens on, so the real Kiro Crew gateway is never asked anything. */
const NO_GATEWAY_PORT = "9";
/** The throwaway jobs' time zone unless `--zone` names another: the one Overnight is shown in. */
const DEFAULT_ZONE = "America/Boise";
/** The one line a build prints when it ran and found nothing to build. */
export const NOTHING_APPROVED_LINE = "Tonight's build: 0 built, 0 failed; nothing approved.";
/** What the night clock writes in the job's log when a run starts, and when a first look takes today's time as handled (packages/cli/src/commands/night-tick.ts). */
export const STARTING_MESSAGE = "night clock: starting";
export const FIRST_CHECK_MESSAGE = "night clock: first check, so this slot counts as handled; the first run comes at the next one";
/** Hours of the night this script keeps away from, as [from, to] in minutes after local midnight: the build, and the delivery. */
const QUIET_WINDOWS = [
  [45, 150],
  [375, 465],
] as const;
/** How often the watch looks. */
const LOOK_EVERY_MS = 5_000;
/** A look that comes this much later than it should means this script was frozen: the Mac slept. */
const FROZEN_GAP_MS = 30_000;

class Refused extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const say = (label: string, value: unknown): void => console.log(`  ${label.padEnd(66)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
/** A path with the home folder written as "~": the account's name stays out of what is printed. */
const shown = (text: string): string => text.split(realHome()).join("~").split(homedir()).join("~");

function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

// ---------- what this script refuses ----------

/** Why a job name cannot be used here, or null when it can. Only this script's own throwaway names can. */
export function labelProblem(label: string): string | null {
  const lower = label.toLowerCase();
  if (REAL_LABELS.some((real) => real.toLowerCase() === lower)) return `"${label}" is one of the four real jobs. This script only ever touches its own throwaway jobs.`;
  if (lower.startsWith("com.overnight.")) return `"${label}" is in the real jobs' family of names (com.overnight.<job>). This script only ever touches its own throwaway jobs.`;
  if (!Object.values(SPIKE_LABELS).includes(label)) return `"${label}" is not one of this script's two throwaway jobs.`;
  return null;
}

/**
 * Why a launchctl call is not made, or null when it may be. Only three kinds of call are made at
 * all (is a job listed, load one, take one out), each word of the call is looked at, and a real
 * job's name or a file among the real settings files stops it.
 */
export function launchctlProblem(args: readonly string[], home: string = realHome()): string | null {
  const [action, ...rest] = args;
  if (action !== "print" && action !== "bootstrap" && action !== "bootout") return `launchctl ${action ?? ""} is not something this script does.`;
  const realSettings = path.join(home, "Library", "LaunchAgents");
  let named = 0;
  for (const word of rest) {
    if (/^gui\/\d+$/.test(word)) continue;
    // A job: gui/<user number>/<name>.
    const target = /^gui\/\d+\/(.+)$/.exec(word);
    if (target !== null) {
      const problem = labelProblem(target[1] ?? "");
      if (problem !== null) return problem;
      named += 1;
      continue;
    }
    // A settings file: its name is the job's name, and it is never one of the installed ones.
    if (path.isAbsolute(word) && word.endsWith(".plist")) {
      const problem = labelProblem(path.basename(word, ".plist"));
      if (problem !== null) return problem;
      const folder = path.dirname(path.resolve(word));
      if (folder === realSettings || folder.startsWith(realSettings + path.sep) || sameOrInsideQuietly(folder, realSettings)) return "That settings file is among the installed jobs' own (~/Library/LaunchAgents). This script never touches that folder.";
      named += 1;
      continue;
    }
    return `launchctl was about to be given "${word}", which this script does not know how to check.`;
  }
  return named === 0 ? "The launchctl call names no job." : null;
}

/** sameOrInsideFolder, with "could not tell" counted as yes: not knowing is a reason to refuse. */
function sameOrInsideQuietly(folder: string, parent: string): boolean {
  try {
    return sameOrInsideFolder(folder, parent);
  } catch {
    return true;
  }
}

export interface DataDirFacts {
  /** The home folder. The default real data folder is `.overnight` inside it. */
  home: string;
  /** This repo: a data folder inside it could end up committed. */
  repo: string;
  /** The text of the repo's .env file, or null when there is none: the folder it names is where jobs installed from this repo work. */
  envFileText: string | null;
  /** The data folders the installed background jobs name in their settings files. */
  jobFolders: readonly string[];
}

/**
 * Why a folder cannot be this run's scratch data folder, or null when it can. The real data
 * folders are refused however they are spelled (they are compared by what the disk says they
 * are), and so is anything inside or above one. The folder must be new or empty: the measurement
 * starts from an empty database.
 */
export function dataDirProblem(given: string | undefined, facts: DataDirFacts): string | null {
  const text = (given ?? "").trim();
  if (text === "") return "OVERNIGHT_DATA_DIR is not set. Name a new scratch folder of your own, for example ~/.overnight-night-clock.";
  const expanded = text === "~" || text.startsWith("~/") ? path.join(facts.home, text.slice(1)) : text;
  if (!path.isAbsolute(expanded)) return "OVERNIGHT_DATA_DIR must be a full path, or start with ~/.";
  const folder = path.resolve(expanded);
  const inUse = "OVERNIGHT_DATA_DIR must be a new or an empty folder: the measurement starts from an empty database.";
  try {
    // A file is no folder at all, wherever it lies. (A link is followed below, like any other spelling.)
    if (lstatSync(folder, { throwIfNoEntry: false })?.isFile() === true) return inUse;
    for (const real of realDataFolders(facts.home, facts.envFileText, facts.jobFolders)) {
      if (sameOrInsideFolder(folder, real)) return "OVERNIGHT_DATA_DIR is a real data folder, or inside one. This script only works on a scratch folder of its own.";
      if (sameOrInsideFolder(real, folder)) return "OVERNIGHT_DATA_DIR has a real data folder inside it. This script only works on a scratch folder of its own.";
    }
    if (sameOrInsideFolder(folder, facts.repo)) return "OVERNIGHT_DATA_DIR is inside the repo. Data never goes there: it could end up committed.";
  } catch {
    return "OVERNIGHT_DATA_DIR could not be looked at, so it is not known whether it is a real data folder. Name another.";
  }
  try {
    const there = lstatSync(folder, { throwIfNoEntry: false });
    if (there === undefined || (there.isDirectory() && readdirSync(folder).length === 0)) return null;
  } catch {
    // Not a folder this script can look into: not one it can start from either.
  }
  return inUse;
}

/** Is this moment inside the hours kept free for the night's real build (00:45 to 02:30) or delivery (06:15 to 07:45)? */
export function inQuietHours(now: Date, timeZone: string): boolean {
  const minutes = localMinutes(now, timeZone);
  return QUIET_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

// ---------- the clock settings of one run ----------

function localMinutes(at: Date, timeZone: string): number {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    throw new Refused(`"${timeZone}" is not a time zone this Mac knows. Use a name like America/Boise.`);
  }
  const parts = format.formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
}

function hhmm(at: Date, timeZone: string): string {
  const minutes = localMinutes(at, timeZone);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export interface ClockTimes {
  /** BUILD_TIME for the throwaway jobs, and the moment it stands for. */
  buildTime: string;
  buildAt: Date;
  /** DELIVER_TIME for the throwaway jobs: the delivery's own time (30 minutes before it) is twelve hours after the build's. */
  deliverTime: string;
}

/**
 * The build's time is the whole minute `minutesAhead` minutes after the minute it is now, so it
 * is between `minutesAhead - 1` and `minutesAhead` minutes away. The delivery's time is put
 * twelve hours from that: it never comes while this script runs.
 */
export function clockTimes(now: Date, timeZone: string, minutesAhead: number): ClockTimes {
  if (!Number.isInteger(minutesAhead) || minutesAhead < 2 || minutesAhead > 60) throw new Refused("--minutes must be a whole number from 2 to 60: the jobs' first look at the clock has to come before the build's time.");
  const buildAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + minutesAhead * 60_000);
  const deliverAt = new Date(buildAt.getTime() + 12 * 3_600_000 + DELIVER_LEAD_MINUTES * 60_000);
  return { buildTime: hhmm(buildAt, timeZone), buildAt, deliverTime: hhmm(deliverAt, timeZone) };
}

// ---------- the throwaway settings files ----------

export interface ThrowawayOptions {
  job: ClockedJob;
  dataDir: string;
  timeZone: string;
  buildTime: string;
  deliverTime: string;
}

function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The settings the throwaway jobs are given on top of what the template gives every job. */
export function addedSettings(options: Omit<ThrowawayOptions, "job">): Record<string, string> {
  return { OVERNIGHT_DATA_DIR: options.dataDir, TZ: options.timeZone, BUILD_TIME: options.buildTime, DELIVER_TIME: options.deliverTime, PAUSED: "false", KIROCREW_PORT: NO_GATEWAY_PORT };
}

/**
 * The installer's filled-in settings file for a job, turned into the throwaway one: the job's
 * name is swapped and the six settings are added to its environment. Nothing else is touched.
 * Throws when the text is not shaped the way the installer writes it.
 */
export function throwawaySettings(rendered: string, options: ThrowawayOptions): string {
  const realName = `<string>${NIGHT_JOB_LABELS[options.job]}</string>`;
  if (rendered.split(realName).length !== 2) throw new Error(`The filled-in ${options.job} settings do not name their job exactly once, so the name was not swapped.`);
  const homeEntry = /( *)<key>HOME<\/key>\s*<string>[^<]*<\/string>\n/g;
  const found = [...rendered.matchAll(homeEntry)];
  const [entry] = found;
  if (found.length !== 1 || entry === undefined) throw new Error(`The filled-in ${options.job} settings do not give HOME exactly once, so the settings were not added.`);
  const indent = entry[1] ?? "";
  const added = Object.entries(addedSettings(options))
    .map(([name, value]) => `${indent}<key>${name}</key>\n${indent}<string>${xmlEscape(value)}</string>\n`)
    .join("");
  return rendered.replace(realName, `<string>${SPIKE_LABELS[options.job]}</string>`).replace(entry[0], `${entry[0]}${added}`);
}

export interface ExpectedSettings extends ThrowawayOptions {
  node: string;
  home: string;
}

/** Why a throwaway settings file, read back as macOS reads it, is not what this script means to load. Null when it is. */
export function settingsProblem(settings: unknown, expected: ExpectedSettings): string | null {
  if (typeof settings !== "object" || settings === null) return "it is not a settings file";
  const file = settings as Record<string, unknown>;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (file.Label !== SPIKE_LABELS[expected.job] || labelProblem(String(file.Label)) !== null) return "its job name is not the throwaway one";
  if (!same(file.ProgramArguments, [expected.node, ENTRY, expected.job, "--if-due"])) return `it does not run "overnight ${expected.job} --if-due"`;
  if (file.StartInterval !== NIGHT_TICK_SECONDS) return `macOS would not wake it every ${NIGHT_TICK_SECONDS} seconds`;
  if (file.RunAtLoad !== true) return "macOS would not start it when it is loaded";
  if ("StartCalendarInterval" in file || "KeepAlive" in file) return "it is on macOS's calendar, or kept alive";
  const log = path.join(expected.dataDir, "logs", `${expected.job}.launchd.log`);
  if (file.StandardOutPath !== log || file.StandardErrorPath !== log) return "what it prints would not go to the scratch folder";
  const environment = file.EnvironmentVariables;
  if (typeof environment !== "object" || environment === null) return "it has no environment";
  const { PATH: jobPath, ...others } = environment as Record<string, unknown>;
  // The same names with the same values, in whatever order macOS hands them back.
  const wanted: Record<string, string> = { HOME: expected.home, ...addedSettings(expected) };
  const names = Object.keys(others).sort();
  if (!same(names, Object.keys(wanted).sort()) || !names.every((name) => others[name] === wanted[name])) return "its environment is not the made-up home and the six added settings";
  if (jobPath !== `${BARE_PATH}:${path.dirname(expected.node)}:${path.join(expected.home, ".local", "bin")}`) return "its PATH is not the night jobs' own";
  return null;
}

/** The job's template, filled in by the installer's own function. Nothing is installed: the script is only loaded for that one function. */
function renderWithInstaller(job: ClockedJob, node: string, dataDir: string, home: string): string {
  const ran = spawnSync("/bin/bash", ["-c", 'source "$1"; shift; render_plist "$@"', "bash", INSTALLER, job, node, REPO, dataDir, home], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: BARE_PATH, HOME: home },
  });
  if (ran.status !== 0 || ran.stdout.trim() === "") throw new Error(`The installer could not fill in the ${job} template.`);
  return ran.stdout;
}

/** A settings file's text as macOS reads it, or null when macOS will not read it. Asked of plutil, through standard input: no file is written. */
function readSettings(text: string): unknown {
  const lint = spawnSync(PLUTIL, ["-lint", "-"], { input: text, encoding: "utf8", timeout: 15_000 });
  if (lint.status !== 0) return null;
  const converted = spawnSync(PLUTIL, ["-convert", "json", "-o", "-", "-"], { input: text, encoding: "utf8", timeout: 15_000 });
  if (converted.status !== 0) return null;
  try {
    return JSON.parse(converted.stdout) as unknown;
  } catch {
    return null;
  }
}

/** Both throwaway settings files, checked. Throws on the first one that is not what it should be. */
function prepareSettings(node: string, home: string, options: Omit<ThrowawayOptions, "job">): Record<ClockedJob, string> {
  const texts = {} as Record<ClockedJob, string>;
  for (const job of CLOCKED_JOBS) {
    const text = throwawaySettings(renderWithInstaller(job, node, options.dataDir, home), { ...options, job });
    const problem = settingsProblem(readSettings(text), { ...options, job, node, home });
    if (problem !== null) throw new Error(`The throwaway ${job} settings file is not right: ${problem}.`);
    texts[job] = text;
  }
  return texts;
}

// ---------- macOS's side ----------

const domain = (): string => `gui/${userInfo().uid}`;
const targetOf = (job: ClockedJob): string => `${domain()}/${SPIKE_LABELS[job]}`;

/** Every launchctl call this script makes goes through here, and is checked first. */
function launchctl(args: string[]): { ok: boolean; text: string } {
  const problem = launchctlProblem(args);
  if (problem !== null) throw new Refused(problem);
  const ran = spawnSync(LAUNCHCTL, args, { encoding: "utf8", timeout: 30_000 });
  return { ok: ran.status === 0, text: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
}

/** What loads the throwaway jobs, starts them and takes them out again: macOS's launchd, or this script standing in for it. */
interface Starter {
  /** In plain words, for what is printed. */
  name: string;
  isListed(job: ClockedJob): boolean;
  /** Hand over one settings file. False when it was not taken. */
  load(job: ClockedJob, file: string): boolean;
  /** Take both jobs out and wait until they are gone. Safe when they are not there. Returns the ones still listed. */
  remove(): ClockedJob[];
}

/** The real thing. Every call goes through `launchctl` above, which checks it first. */
const launchd: Starter = {
  name: "macOS (launchd)",
  isListed: (job) => launchctl(["print", targetOf(job)]).ok,
  load: (_job, file) => launchctl(["bootstrap", domain(), file]).ok,
  remove() {
    const left: ClockedJob[] = [];
    for (const job of CLOCKED_JOBS) {
      try {
        if (!this.isListed(job)) continue;
        launchctl(["bootout", targetOf(job)]);
        // macOS gives a job up to 60 seconds to stop (ExitTimeOut in its template). These two are idle.
        const until = Date.now() + 70_000;
        while (this.isListed(job) && Date.now() < until) spawnSync("/bin/sleep", ["0.25"]);
        if (this.isListed(job)) left.push(job);
      } catch {
        left.push(job);
      }
    }
    return left;
  },
};

/**
 * This script in launchd's place, for `dry`. It does with a settings file what launchd does with
 * the few entries our two templates use: start the program when the job is loaded (RunAtLoad)
 * and every StartInterval seconds, never a second copy while one is still going, in the folder
 * and with the environment the file gives, with what it prints added to the file's log. It
 * knows nothing else of launchd, and nothing it shows is a fact about macOS.
 */
function standIn(): Starter {
  const jobs = new Map<ClockedJob, { timer: NodeJS.Timeout; child: ChildProcess | null }>();
  return {
    name: "this script, standing in for macOS",
    isListed: (job) => jobs.has(job),
    load(job, file) {
      const settings = readSettings(readFileSync(file, "utf8")) as { ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string>; WorkingDirectory?: string; StandardOutPath?: string; StartInterval?: number; RunAtLoad?: boolean } | null;
      const [program, ...words] = settings?.ProgramArguments ?? [];
      const log = settings?.StandardOutPath;
      if (settings === null || program === undefined || log === undefined || typeof settings.StartInterval !== "number") return false;
      const entry: { timer: NodeJS.Timeout; child: ChildProcess | null } = { timer: setInterval(() => start(), settings.StartInterval * 1000), child: null };
      const start = (): void => {
        if (entry.child !== null) return;
        const out = openSync(log, "a", 0o600);
        try {
          const child = spawn(program, words, { cwd: settings.WorkingDirectory, env: settings.EnvironmentVariables ?? {}, stdio: ["ignore", out, out] });
          entry.child = child;
          const ended = (): void => {
            if (entry.child === child) entry.child = null;
          };
          child.once("exit", ended);
          child.once("error", ended);
        } finally {
          closeSync(out);
        }
      };
      jobs.set(job, entry);
      if (settings.RunAtLoad === true) start();
      return true;
    },
    remove() {
      for (const entry of jobs.values()) {
        clearInterval(entry.timer);
        entry.child?.kill("SIGTERM");
      }
      jobs.clear();
      return [];
    },
  };
}

// ---------- reading what happened ----------

interface Places {
  dataDir: string;
  /** The made-up home the throwaway jobs run with. */
  home: string;
  /** Where the two throwaway settings files are kept: inside the scratch folder, never among the installed ones. */
  settingsDir: string;
  node: string;
  environment: Record<string, string>;
}

interface ClockReport {
  checkedAt: string | null;
  state: string | null;
  lastRun: { startedAt: string; closedAt: string | null; closedAs: string | null; lateMinutes: number } | null;
}

/** What `overnight status --json` says about the two jobs' clocks on the scratch folder, asked with the jobs' own settings. Null when it would not say. */
function readClocks(places: Places): Record<ClockedJob, ClockReport> | null {
  const ran = spawnSync(places.node, [ENTRY, "status", "--json"], { encoding: "utf8", timeout: 30_000, env: places.environment });
  if (ran.status !== 0) return null;
  try {
    const clock = (JSON.parse(ran.stdout) as { nightClock?: Record<string, ClockReport> }).nightClock;
    const { build, deliver } = clock ?? {};
    return build === undefined || deliver === undefined ? null : { build, deliver };
  } catch {
    return null;
  }
}

function linesOf(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** The lines the night clock wrote in a job's own log with the given message, as the fields this script reads. */
function clockLines(places: Places, job: ClockedJob, message: string): { at: string; lateMinutes?: number; slotDay?: string }[] {
  const found: { at: string; lateMinutes?: number; slotDay?: string }[] = [];
  for (const line of linesOf(path.join(places.dataDir, "logs", `${job}.log`))) {
    try {
      const entry = JSON.parse(line) as { at?: unknown; message?: unknown; lateMinutes?: unknown; slotDay?: unknown };
      if (entry.message !== message || typeof entry.at !== "string") continue;
      found.push({ at: entry.at, ...(typeof entry.lateMinutes === "number" ? { lateMinutes: entry.lateMinutes } : {}), ...(typeof entry.slotDay === "string" ? { slotDay: entry.slotDay } : {}) });
    } catch {
      // Not one of the log's own lines.
    }
  }
  return found;
}

/** What a job printed outside its own log: the build's one summary line each run, and anything that went wrong. */
const printedBy = (places: Places, job: ClockedJob): string[] => linesOf(path.join(places.dataDir, "logs", `${job}.launchd.log`));

interface Watched {
  /** When each job's looks at the clock were written down (UTC), in order, each once. */
  looks: Record<ClockedJob, string[]>;
  /** When this script found itself frozen, which is what a sleeping Mac looks like from inside: from when to when. */
  frozen: { from: Date; to: Date }[];
  /** How many times `status` would not answer. */
  unanswered: number;
}

/** Look every few seconds until `done` says so. Every look reads only the scratch folder. */
async function watch(places: Places, done: (watched: Watched, now: Date) => boolean): Promise<Watched> {
  const watched: Watched = { looks: { build: [], deliver: [] }, frozen: [], unanswered: 0 };
  let last = Date.now();
  for (;;) {
    const now = Date.now();
    if (now - last > LOOK_EVERY_MS + FROZEN_GAP_MS) {
      watched.frozen.push({ from: new Date(last), to: new Date(now) });
      console.log(`  (this script was frozen for ${Math.round((now - last) / 1000)} seconds: the Mac slept)`);
    }
    last = now;
    const clocks = readClocks(places);
    if (clocks === null) watched.unanswered += 1;
    else {
      for (const job of CLOCKED_JOBS) {
        const at = clocks[job].checkedAt;
        if (at !== null && watched.looks[job].at(-1) !== at) {
          watched.looks[job].push(at);
          if (job === "build") console.log(`  the build job looked at the clock at ${clockTime(at)}`);
        }
      }
    }
    if (done(watched, new Date())) return watched;
    await sleep(LOOK_EVERY_MS);
  }
}

/** A UTC time as "12:03:07" on this Mac's own clock: what a person watching sees. */
function clockTime(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * A sitting's steps for the person at the Mac, one line each. The plug comes out because on mains
 * power this Mac stays awake with the lid closed (the live listener holds it awake), and only at
 * the moment of closing because on battery with the lid open it falls asleep after an idle minute.
 */
export function sittingSteps(buildAt: Date, clock: (at: Date) => string = clockTime): string[] {
  return [
    `1. Leave the power plug in. Wait until this window shows two lines saying "the build job looked at the clock".`,
    `2. Then pull out the power plug and close the lid at once, before ${clock(new Date(buildAt.getTime() - 30_000))}. (With the plug in, this Mac stays awake with the lid closed.)`,
    `3. Open the lid again any time after ${clock(new Date(buildAt.getTime() + 120_000))}, log in, and put the power plug back.`,
    "4. Leave it open for five minutes. This window then says what happened.",
  ];
}

/**
 * A sitting whose Mac was not asleep across the build's time: what most likely happened, in words
 * for the person who sat. `sleptAtAll`: this script found itself frozen at some other time.
 */
export function notAsleepReason(sleptAtAll: boolean): string {
  return sleptAtAll
    ? "the Mac slept, but not across the build's time (the lid was closed too late or opened too early), so this was an ordinary run"
    : "the Mac never slept, so this was an ordinary run. Most likely it was still on mains power: with the plug in, this Mac stays awake with the lid closed. Pull out the power plug, then close the lid at once";
}

/** The seconds between each look at the clock and the next. */
function gapsOf(looks: readonly string[]): number[] {
  return looks.slice(1).map((at, index) => Math.round((Date.parse(at) - Date.parse(looks[index] ?? at)) / 1000));
}

/**
 * One line of macOS's power log (`pmset -g log`) that says the Mac slept or woke, as its time,
 * its kind and the system's own few words for it. Null for every other line. Only letters,
 * digits and a little punctuation are kept, and no more than 90 characters of them.
 */
export function powerEvent(line: string): { at: Date; text: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (Sleep|Wake|DarkWake)\s+(.*)$/.exec(line);
  if (match === null) return null;
  const at = new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  if (Number.isNaN(at.getTime())) return null;
  // Up to where the battery's state begins: "Entering Sleep state due to 'Clamshell Sleep'".
  const words = (match[6] ?? "").split(/:TCPKeepAlive| Using (?:AC|Batt)/i)[0] ?? "";
  const kept = words
    .replace(/[^A-Za-z0-9 '[\]._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return { at, text: `${match[5]}: ${kept}` };
}

/** What macOS's own power log says about sleeping and waking in a stretch of time. Null when it cannot be read. */
function powerEvents(from: Date, to: Date): string[] | null {
  const ran = spawnSync("/usr/bin/pmset", ["-g", "log"], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024, env: { PATH: BARE_PATH } });
  if (ran.status !== 0) return null;
  const events: string[] = [];
  for (const line of ran.stdout.split("\n")) {
    const event = powerEvent(line);
    if (event !== null && event.at >= from && event.at <= to) events.push(`${clockTime(event.at)} ${event.text}`);
  }
  return events;
}

// ---------- the modes ----------

function realFacts(): DataDirFacts {
  const home = homedir();
  return { home, repo: REPO, envFileText: readEnvFileText(REPO), jobFolders: installedJobFolders(home) };
}

/** `check`: this script's own tools, with nothing loaded and nothing written. */
function selfCheck(): boolean {
  const results: boolean[] = [];
  const expect = (label: string, ok: boolean): void => {
    results.push(ok);
    say(label, ok ? "yes" : "NO");
  };
  console.log("\nThe job names this script refuses");
  for (const label of REAL_LABELS) {
    expect(`refuses ${label}`, labelProblem(label) !== null && launchctlProblem(["bootout", `gui/501/${label}`]) !== null && launchctlProblem(["print", `gui/501/${label}`]) !== null);
  }
  expect("refuses a settings file among the installed ones", launchctlProblem(["bootstrap", "gui/501", path.join(realHome(), "Library", "LaunchAgents", `${SPIKE_LABELS.build}.plist`)]) !== null);
  expect("refuses a call it does not make (kickstart, disable, remove)", ["kickstart", "disable", "remove", "unload"].every((action) => launchctlProblem([action, `gui/501/${SPIKE_LABELS.build}`]) !== null));
  expect("takes its own two throwaway names", CLOCKED_JOBS.every((job) => labelProblem(SPIKE_LABELS[job]) === null && launchctlProblem(["bootout", `gui/501/${SPIKE_LABELS[job]}`]) === null));

  console.log("\nThe data folders this script refuses");
  const facts = realFacts();
  const reals = realDataFolders(facts.home, facts.envFileText, facts.jobFolders);
  say("real data folders known (the default, the repo's .env, the installed jobs')", reals.length);
  expect("refuses every one of them, and a folder inside each", reals.every((real) => dataDirProblem(real, facts) !== null && dataDirProblem(path.join(real, "inside"), facts) !== null));
  expect("refuses the home folder, which has one inside it", dataDirProblem(facts.home, facts) !== null);
  expect("refuses a folder inside the repo", dataDirProblem(path.join(REPO, "data"), facts) !== null);
  expect("refuses no folder at all, and a relative one", dataDirProblem(undefined, facts) !== null && dataDirProblem("  ", facts) !== null && dataDirProblem("scratch/data", facts) !== null);
  const example = path.join(facts.home, ".overnight-night-clock-check-only");
  expect("takes a new folder of its own in the home folder", existsSync(example) || dataDirProblem(example, facts) === null);
  if (process.env.OVERNIGHT_DATA_DIR !== undefined) say("the OVERNIGHT_DATA_DIR given just now", dataDirProblem(process.env.OVERNIGHT_DATA_DIR, facts) ?? "can be used");

  console.log("\nThe throwaway settings files (made in memory: nothing is written or loaded)");
  const timeZone = zoneGiven();
  const times = clockTimes(new Date(), timeZone, 3);
  const home = path.join(example, "spike", "home");
  const options = { dataDir: example, timeZone, buildTime: times.buildTime, deliverTime: times.deliverTime };
  for (const job of CLOCKED_JOBS) {
    let problem: string | null;
    try {
      problem = settingsProblem(readSettings(throwawaySettings(renderWithInstaller(job, process.execPath, example, home), { ...options, job })), { ...options, job, node: process.execPath, home });
    } catch (error) {
      problem = error instanceof Error ? error.message : "it could not be made";
    }
    expect(`${job}: valid, wakes every ${NIGHT_TICK_SECONDS} seconds, runs "overnight ${job} --if-due", scratch folder only`, problem === null);
    if (problem !== null) say("  why not", shown(problem));
  }
  say("the build's time would be", `${times.buildTime} (${timeZone}), the delivery's own time twelve hours from it`);
  return results.every(Boolean);
}

interface RunOptions {
  minutesAhead: number;
  minutesAfter: number;
  sitting: boolean;
  /** launchd, or for `dry` this script in its place. */
  starter: Starter;
}

/** `run`, `sitting` and `dry`: load the two throwaway jobs, watch, take them out again. `likelyCause`: of a sitting whose Mac was not asleep at the build's time. */
async function measure(options: RunOptions): Promise<{ ok: boolean; likelyCause: string | null }> {
  const { starter } = options;
  if (process.platform !== "darwin") throw new Refused("launchd is macOS's. This script only runs on a Mac.");
  const facts = realFacts();
  const problem = dataDirProblem(process.env.OVERNIGHT_DATA_DIR, facts);
  if (problem !== null) throw new Refused(problem);
  const given = (process.env.OVERNIGHT_DATA_DIR ?? "").trim();
  const dataDir = path.resolve(given === "~" || given.startsWith("~/") ? path.join(facts.home, given.slice(1)) : given);
  const timeZone = zoneGiven();
  // The real night goes by the real jobs' own zone, which is the default one here.
  if (inQuietHours(new Date(), DEFAULT_ZONE) || inQuietHours(new Date(), timeZone)) throw new Refused("It is too close to the night's real build (1:00 am) or delivery (6:30 am). Run this in the daytime.");
  if (!existsSync(ENTRY) || !existsSync(INSTALLER)) throw new Refused("The command-line tool or the installer is missing from this repo.");

  const settingsDir = path.join(dataDir, "spike");
  const home = path.join(settingsDir, "home");
  const node = process.execPath;
  const times = clockTimes(new Date(), timeZone, options.minutesAhead);
  const added = { dataDir, timeZone, buildTime: times.buildTime, deliverTime: times.deliverTime };
  const places: Places = { dataDir, home, settingsDir, node, environment: { HOME: home, PATH: `${BARE_PATH}:${path.dirname(node)}`, ...addedSettings(added) } };
  // Everything that can refuse, before anything is made or loaded.
  const texts = prepareSettings(node, home, added);
  for (const job of CLOCKED_JOBS) {
    if (starter.isListed(job)) throw new Refused(`The throwaway ${job} job is still in macOS's list from an earlier run. Take it out first: node spikes/10-night-clock.ts cleanup`);
  }

  // macOS opens a job's log file before starting it and makes no folder for it.
  for (const folder of [dataDir, path.join(dataDir, "logs"), settingsDir, home]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const files = {} as Record<ClockedJob, string>;
  for (const job of CLOCKED_JOBS) {
    files[job] = path.join(settingsDir, `${SPIKE_LABELS[job]}.plist`);
    writeFileSync(files[job], texts[job], { mode: 0o600 });
  }

  console.log(`\nSpike 10: the night clock under ${starter === launchd ? "real launchd" : "a stand-in for launchd (this tries the script, not macOS)"}${options.sitting ? ", with the Mac asleep across the build's time" : ""}`);
  say("the jobs are started by", starter.name);
  say("scratch data folder", shown(dataDir));
  say("the build's time (BUILD_TIME)", `${times.buildTime} ${timeZone}, which is ${clockTime(times.buildAt)} on this Mac's clock`);
  say("the delivery's time is set twelve hours off: no delivery runs here", `DELIVER_TIME ${times.deliverTime}`);

  let removed = false;
  const takeOut = (): ClockedJob[] => {
    if (removed) return [];
    removed = true;
    return starter.remove();
  };
  // Ctrl-C, a closed window, a stop from outside: the jobs go before this script does.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      const left = takeOut();
      console.error(left.length === 0 ? "\nStopped. Both throwaway jobs were taken out of macOS's list." : `\nStopped, but macOS still lists: ${left.join(", ")}. Run: node spikes/10-night-clock.ts cleanup`);
      process.exit(130);
    });
  }

  const results: boolean[] = [];
  const expect = (label: string, ok: boolean, detail = ""): void => {
    results.push(ok);
    say(label, `${ok ? "yes" : "NO"}${detail === "" ? "" : `   ${detail}`}`);
  };
  let likelyCause: string | null = null;
  let left: ClockedJob[];
  try {
    const loadedAt = new Date();
    for (const job of CLOCKED_JOBS) {
      if (!starter.load(job, files[job])) throw new Error(`The throwaway ${job} job was not taken (for macOS: launchctl bootstrap failed, and you must be logged in at this Mac's screen).`);
    }
    console.log(`\nLoaded at ${clockTime(loadedAt)}. Watching until ${options.sitting ? "the build has run after the sleep" : `${options.minutesAfter} ${options.minutesAfter === 1 ? "minute" : "minutes"} after the build's time`}. Ctrl-C stops and cleans up.`);
    if (options.sitting) {
      console.log("\n  FOR THE PERSON AT THE MAC, one step at a time:");
      for (const step of sittingSteps(times.buildAt)) console.log(`    ${step}`);
      console.log("");
    }

    const startsSeen = (): number => clockLines(places, "build", STARTING_MESSAGE).length;
    const until = times.buildAt.getTime() + options.minutesAfter * 60_000;
    // A sitting ends five minutes after the build has run, or after forty minutes whatever happened.
    const giveUp = times.buildAt.getTime() + 40 * 60_000;
    let ranSeenAt: number | null = null;
    const watched = await watch(places, (_watched, now) => {
      if (!options.sitting) return now.getTime() >= until;
      if (ranSeenAt === null && startsSeen() > 0) ranSeenAt = now.getTime();
      return (ranSeenAt !== null && now.getTime() >= ranSeenAt + 5 * 60_000) || now.getTime() >= giveUp;
    });
    const endedAt = new Date();

    console.log(`\nWhat ${starter === launchd ? "macOS" : "the stand-in for macOS"} did`);
    for (const job of CLOCKED_JOBS) {
      const looks = watched.looks[job];
      const first = looks[0];
      expect(`${job}: looked at the clock when it was loaded`, first !== undefined && Date.parse(first) - loadedAt.getTime() < 30_000, first === undefined ? "" : `${Math.round((Date.parse(first) - loadedAt.getTime()) / 1000)} seconds after loading`);
      // While the Mac sleeps nobody looks: only the gaps while it was awake say how regular macOS is.
      const gaps = gapsOf(looks).filter((seconds) => seconds < 300);
      const detail = `${looks.length} looks; seconds between them while awake: ${gaps.join(", ") || "none"}`;
      const regular = gaps.length >= 2 && gaps.every((seconds) => seconds >= NIGHT_TICK_SECONDS - 15 && seconds <= NIGHT_TICK_SECONDS + 30);
      // After a sleep a look that finds a run due waits a minute in place, so the next one comes later: only measured then.
      if (options.sitting) say(`${job}: its looks at the clock`, detail);
      else expect(`${job}: looked again about every ${NIGHT_TICK_SECONDS} seconds`, regular, detail);
    }

    console.log("\nWhat Overnight's own clock did");
    for (const job of CLOCKED_JOBS) {
      const firstChecks = clockLines(places, job, FIRST_CHECK_MESSAGE);
      expect(`${job}: its first look took today's time as handled, once`, firstChecks.length === 1, `${firstChecks.length} such lines in its log`);
    }
    const starts = clockLines(places, "build", STARTING_MESSAGE);
    const printed = printedBy(places, "build");
    const summaries = printed.filter((line) => line === NOTHING_APPROVED_LINE).length;
    const [start] = starts;
    expect("the build started exactly once", starts.length === 1, `${starts.length} starts in its log`);
    expect(`it printed "${NOTHING_APPROVED_LINE}" exactly once, and nothing else`, summaries === 1 && printed.length === 1, `${summaries} such lines, ${printed.length - summaries} others`);
    const clocks = readClocks(places);
    const lastRun = clocks?.build.lastRun ?? null;
    if (start !== undefined) {
      const lateSeconds = Math.round((Date.parse(start.at) - times.buildAt.getTime()) / 1000);
      say("the build started", `${clockTime(start.at)}, ${lateSeconds} seconds after its time; the log says lateMinutes ${start.lateMinutes ?? "?"}`);
      if (options.sitting) {
        const slept = watched.frozen.find((gap) => gap.from.getTime() < times.buildAt.getTime() && gap.to.getTime() > times.buildAt.getTime());
        if (slept === undefined) likelyCause = notAsleepReason(watched.frozen.length > 0);
        expect("the Mac was asleep across the build's time", slept !== undefined, slept === undefined ? (likelyCause ?? "") : `this script was frozen ${clockTime(slept.from)} to ${clockTime(slept.to)}`);
        if (slept !== undefined) {
          const afterWake = Math.round((Date.parse(start.at) - slept.to.getTime()) / 1000);
          expect("the build started after the Mac was awake again, within three minutes", afterWake >= 0 && afterWake <= 180, `${afterWake} seconds after waking`);
          expect("it is marked late", (start.lateMinutes ?? 0) >= 1 && (lastRun?.lateMinutes ?? 0) >= 1, `status says lateMinutes ${lastRun?.lateMinutes ?? "?"}`);
        }
      } else {
        expect(`it started within ${NIGHT_TICK_SECONDS + 15} seconds of its time, and is not marked late`, lateSeconds >= 0 && lateSeconds <= NIGHT_TICK_SECONDS + 15 && start.lateMinutes === 0);
        expect("status --json says lastRun.lateMinutes 0, closed as done", lastRun !== null && lastRun.lateMinutes === 0 && lastRun.closedAs === "done", JSON.stringify(lastRun));
      }
      const quietFor = Math.round((endedAt.getTime() - Date.parse(start.at)) / 1000);
      expect("nothing started after that", starts.length === 1 && summaries <= 1, `watched for ${quietFor} more seconds`);
    }
    expect("the deliver job started no delivery and printed nothing", clockLines(places, "deliver", STARTING_MESSAGE).length === 0 && printedBy(places, "deliver").length === 0);
    expect("status answered every time it was asked", watched.unanswered === 0, `${watched.unanswered} times it did not`);
    say("a run counts as late after", `${LATE_AFTER_MS / 60_000} minutes`);

    if (options.sitting || watched.frozen.length > 0) {
      console.log("\nWhat macOS's own power log says for that time (pmset -g log)");
      const events = powerEvents(loadedAt, endedAt);
      if (events === null) say("power log", "could not be read");
      else if (events.length === 0) say("power log", "no sleep or wake in that time");
      else for (const event of events.slice(0, 40)) console.log(`    ${event}`);
    }
  } finally {
    left = takeOut();
  }
  console.log("\nCleaning up");
  expect(starter === launchd ? "both throwaway jobs are out of macOS's list again" : "both stand-in jobs are stopped", left.length === 0, left.length === 0 ? "" : `still listed: ${left.join(", ")}. Run: node spikes/10-night-clock.ts cleanup`);
  say("the scratch folder is left for a look; remove it when done", shown(dataDir));
  say("the build's own log", shown(path.join(dataDir, "logs", "build.log")));
  return { ok: results.every(Boolean), likelyCause };
}

/** The time zone named with `--zone`, or the default one. */
function zoneGiven(): string {
  const index = process.argv.indexOf("--zone");
  const zone = index === -1 ? DEFAULT_ZONE : (process.argv[index + 1] ?? "");
  // Asked once here, so a name this Mac does not know is refused before anything is made.
  localMinutes(new Date(), zone);
  return zone;
}

function numberAfter(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Refused(`${name} needs a whole number of minutes.`);
  return value;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode === "check") {
    const ok = selfCheck();
    console.log(ok ? "\nDone: every check passed. No job was loaded and no file was written." : "\nNOT RIGHT: see the lines marked NO. No job was loaded and no file was written.");
    return ok ? 0 : 1;
  }
  if (mode === "cleanup") {
    const left = launchd.remove();
    console.log(left.length === 0 ? "Neither throwaway job is in macOS's list." : `macOS still lists: ${left.join(", ")}. Log out and in again to remove them.`);
    return left.length === 0 ? 0 : 1;
  }
  if (mode === "run" || mode === "sitting" || mode === "dry") {
    const sitting = mode === "sitting";
    const dry = mode === "dry";
    const minutesAfter = numberAfter("--after", dry ? 1 : 3);
    if (minutesAfter < 1 || minutesAfter > 30) throw new Refused("--after must be from 1 to 30 minutes.");
    const { ok, likelyCause } = await measure({ minutesAhead: numberAfter("--minutes", sitting ? 5 : dry ? 2 : 3), minutesAfter, sitting, starter: dry ? standIn() : launchd });
    const never = `No Kiro credits were used, nothing was published, Bee was not used.${dry ? " No job was loaded: this tried the script itself and says nothing about macOS." : ""}`;
    // A sitting on mains power fails for a reason that has nothing to do with the night clock: say so in the last line too.
    const why = likelyCause === null ? "" : ` What happened: ${likelyCause}.`;
    console.log(ok ? `\nDone: everything was as expected. ${never}` : `\nNOT AS EXPECTED: see the lines marked NO.${why} ${never}`);
    return ok ? 0 : 1;
  }
  throw new Refused("Say what to do: check, dry, run, sitting or cleanup. The top of this file says what each one does.");
}

// Only when run as a program: the tests of this script's own tools import it.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Refused) console.error(`Not started: ${error.message}`);
      else console.error(`\nStopped on an unexpected error: ${error instanceof Error ? shown(error.message.split("\n")[0] ?? "") : "unknown"}`);
      process.exit(error instanceof Refused ? 2 : 1);
    },
  );
}
