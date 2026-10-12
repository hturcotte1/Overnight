// Everything this spike makes is synthetic: invented folders, files and one-line jobs in a scratch data folder. None of it is Bee data.
//
// Spike 11: do the builder's two sandbox profiles, as they ship, still let Kiro Crew and Kiro CLI
// do their work? And does the sandbox refuse them anything nobody knew they ask for?
//
// Why it matters: the profiles close other programs' socket files and the dashboard's port
// (Milestone 3). What Kiro Crew and Kiro CLI need at run time was never measured, so the rules
// are proved here, on a throwaway gateway, before they reach the gateway that builds every night.
//
// Usage, in this order (every value is needed; nothing has a default that could point at the real install):
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening node spikes/11-hardening-proof.ts check
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p1
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p2 --spend-credits
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts hold
//
//   check   No gateway, no Kiro program, no Kiro credits. Checks this script's own tools: that it
//           refuses the real folders and the real port, that the profiles and the copies it makes
//           of them load, that its extra lines change no decision, that the last step of p1, p2
//           and hold (below) gives the right answer, tried for real on harmless programs, that
//           the values a hold prints are read as the scratch folders by a shell and by the
//           builder's own code, and that a hold ends when it should, tried on stand-ins.
//   p1      No Kiro credits. Starts a throwaway Kiro Crew gateway inside the gateway profile and
//           runs: the nightly sandbox check (it must pass, and fail by name on a loosened copy);
//           one command job added, started, cancelled and removed by the builder's own code; one
//           `kiro-cli settings` question inside the Kiro CLI profile.
//   p2      About half a Kiro credit. One one-line `kiro-cli chat` inside the Kiro CLI profile,
//           and one one-line Kiro Crew agent job, each of which writes one file. Our own words only.
//   hold    No Kiro credits of its own. For the third step of the proof (P3): a rehearsal build
//           has to go through a throwaway gateway, and p1 and p2 stop theirs before they end.
//           hold gets a gateway answering exactly as p1 does (the same refusals, the same copy of
//           the profile with the same values, the same settings in the throwaway Kiro home, the
//           same test that macOS's log is read), prints the environment a rehearsal must be given
//           to use it (OVERNIGHT_DATA_DIR, KIRO_HOME, KIROCREW_HOME, KIROCREW_PORT), and waits.
//           It ends on Ctrl-C or a stop signal, or when the file it names as it starts appears
//           (<data folder>/hold.stop: `touch` it from any shell; no process number is needed).
//           It also ends by itself: after 100 minutes, when the hours of the night's build or
//           delivery begin, and when its gateway or its watcher is gone. However it ends, it
//           stops the gateway and everything the gateway started, and then does the same last
//           step as p1, over the whole time the gateway was up. Exit code 0 only if that passes
//           and the gateway did not end by itself. Not tried yet on a real gateway (Oct 12): its
//           start is p1's own code, its waiting is tried by `check`, and the whole mode was tried
//           on a copy whose "gateway" only answers on the port; but how much a whole build
//           writes into macOS's log is not known. If the log has grown past what can be read (a
//           gigabyte) or macOS has dropped its first lines by the end, the answer is "could not
//           tell": that says nothing against the sandbox, and the rehearsal's own result stands.
//
// Before p1, p2 or hold: daytime, and no build or delivery of the real Overnight going. This script
// keeps away from the usual hours of both, but it never looks into ~/.overnight, so it cannot see
// a late one: `npx overnight status` in the live copy says whether one is running.
//
// What it never does: it never uses ~/.overnight, ~/.kiro/crew or port 5476 (it refuses them,
// whatever spelling they are given in); it installs, loads and stops no background job, so there
// is no job name to get wrong; it publishes nothing; it does not use Bee itself (the nightly
// check, in p1, tries Bee from inside the sandbox, as it does every night); it changes no setting
// of Kiro CLI's or Kiro Crew's outside the throwaway home. (Inside it: Kiro Crew's one setting
// that lets a job run in our sandbox, and Kiro's two content-sharing switches, switched off
// before anything is sent from there.)
//
// What p1, p2 and hold do touch outside the two scratch folders, because a build does and the
// profiles know no other place for it (hold: the third only, and whatever the rehearsal's build does):
//   - Kiro CLI's own home. The Kiro CLI profile opens ~/.kiro and nothing else, so p1's settings
//     question and p2's one-line chat run there. The settings are only read. The chat can write
//     where a fallback build can: its saved session in ~/.kiro/sessions, and Kiro CLI's own
//     store in ~/Library/Application Support/kiro-cli.
//   - Kiro's sign-in. p2 asks Kiro "who am I" outside the sandbox, as every build does, which
//     renews a sign-in that has run out.
//   - Kiro Crew's shared folders. A gateway uses ~/.kiro/crew-auth-staging when it starts and
//     leaves a small folder for each run in ~/workplace/kirocrew-workspace. The real gateway uses
//     the same two. What is left there is safe to delete.
//
// What it leaves running: nothing. The gateway is this script's own child. A helper (the
// "watcher" below) ends whatever a gateway or a job started and left behind, when the script
// ends, when it is stopped with Ctrl-C (once: it ends what is running and removes its jobs;
// twice: at once), and when the script itself is killed. hold is no exception: its gateway is up
// only while the script waits, a crash of the script ends it through the same watcher, and a
// watcher that is gone ends the hold. (While hold waits, the first Ctrl-C is how it is ended:
// the gateway is stopped and the last step still runs. One more stops that step too.)
// The one case nothing covers, in p1 and p2 as in hold: the script AND its watcher killed outright
// in the same moment (`kill -9` on both). A gateway would then stay up on its port. Find it by
// that port (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), never by its name: the gateway that builds
// every night has the same name.
//
// THE LAST STEP of p1, p2 and hold reads what the sandbox decided out of macOS's log. Three things
// make its answer worth having:
//
//   1. It first proves the log was read. Before anything else and again after everything else,
//      inside each profile copy, this script makes one harmless connection the profile certainly
//      refuses: to a socket file of its own, with a name made up for this run, in the scratch
//      data folder (closed to every job). macOS writes a line for a program's first refused try
//      at a thing (measured: 6 programs, 6 lines; a try at a file that is not there leaves none,
//      which is why a listener is put behind it). Every one of these "canaries" must be in what
//      was read. If one is missing the step says "could not tell", which is a failure.
//
//   2. Only this run's own programs count. The copies of the profiles get a few lines that
//      report and refuse nothing: `(allow ... (with report) (with message "<a word made up for
//      this run>"))`. Each start of a program, each look at a system value (every program reads
//      some as it starts) and each use of a local port inside a copy then puts a line in the log
//      with the program's process number and this run's word. A second process, the watcher,
//      follows those lines as they are written and looks at the process table about 25 times a
//      second. It notes, with the time, every process that descends from this script, that is in
//      a process group one of them leads, or that the log just marked. A refusal counts as this
//      run's when its process number was noted at that moment (one second either way), when the
//      log marked that number within a second of it, or when this script started the program
//      itself. Refusals to every other program on this Mac are counted in one line and decide
//      nothing.
//      Limits. Not seen: a child that starts no program and asks macOS nothing these lines
//      report, when it is gone within a twentieth of a second or has cut itself loose from its
//      parent that fast. Wrongly counted: a process number macOS gives out again within a
//      second. Counted too, harmlessly: the few programs this script starts outside the sandbox
//      (the log has no sandbox lines for a program that is in none). Socket files refused to
//      programs that are not this run's but have a build tool's name are counted in a line of
//      their own, so that a miss of the first kind can be noticed.
//
//   3. One refusal is expected and does not fail the step: node asking for the system log's
//      socket file, /private/var/run/syslog. Measured by two people on Oct 11 (6 of 10 and 2 of
//      10 starts inside the Kiro CLI profile, none inside the gateway profile) and again by this
//      script's own check on Oct 12 (5 or 6 of 6 starts); a build works without it. It is not opened in
//      the profile, on purpose: a program outside the sandbox listens on it. The step prints it
//      as "expected" with its count. Any other socket file refused to one of this run's programs
//      is printed by its shape, and fails the step. So does that same socket refused to a program
//      other than node: nobody has measured that, and the line that prints it says so.
//
// The report lines sit right after "(allow default)", so every later rule of the shipped profile
// still has the last word: the decisions are the shipped file's. For the same reason a socket
// file the profile itself opens (in a job's own folders) is NOT reported: the profile's own rule
// answers for it, without a report. What shows is every refused socket file, local ports, and
// (gateway profile) the questions about other processes.
//
// After a hold, "this run's own programs" are the gateway and everything it started: the agent
// and the tools it ran. The rehearsal that used the gateway is another program in another shell.
// Its own kirocrew commands, its Kiro CLI builder and its morning checks run in sandboxes of
// their own, without this run's word, and are counted with the other programs on this Mac.
//
// It prints yes/no, counts, and what the sandbox decided as counts by program, kind of thing and
// the SHAPE of the target (the home folder as "~", numbers as "N"). Never a raw log line, never
// anything a program printed. Results go in docs/spikes.md.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger, DASHBOARD_PORT, dataPaths, ensureDataDirs, parseConfig } from "@overnight/core";
import type { DataPaths, Logger } from "@overnight/core";
import { abortableSleep, BUILD_JOB_PREFIX, createCrewClient, DEFAULT_GATEWAY_PORT, defaultCrewHome, defaultKiroHome, defaultKirocrewBinary, gatewayAnswers, gatewayPort, NEVER_DUE_CRON } from "../packages/builder/src/crew-client.ts";
import type { CrewClient } from "../packages/builder/src/crew-client.ts";
import { BUILD_SKILL_FILE, installedSkillFile, REPO_ROOT } from "../packages/builder/src/crew-files.ts";
import { findKiroBinary, KIRO_CLI_SANDBOX_PROFILE, kiroCliTmpDir, PRIVACY_SETTINGS, sandboxedKiroArgs, sandboxedSettingArgs } from "../packages/builder/src/kiro-cli.ts";
import { CREW_GATEWAY_SANDBOX_PROFILE, crewSettingsProblem, standaloneSandboxProbe } from "../packages/builder/src/kiro-crew.ts";
import { createKiroSignInRenewal } from "../packages/builder/src/kiro-signin.ts";
import { BUILT_TESTS, LIST_TESTS, listTestTargets, probeCommand, WRITE_TESTS, writeTestTargets } from "../packages/builder/src/probe.ts";
import { createCommandRunner } from "../packages/builder/src/run.ts";
import { realPath, realPathAllowMissing, sandboxDefines } from "../packages/builder/src/sandbox-values.ts";
import { buildTmpDir } from "../packages/builder/src/workspace.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const LOG_PROGRAM = "/usr/bin/log";
const HOME = realpathSync(homedir());
const REAL_DATA_DIR = path.join(HOME, ".overnight");
const REAL_KIRO_HOME = path.join(HOME, ".kiro");
/** Hours of the night this script keeps away from, as [from, to] in minutes after local midnight: the build, and the delivery. */
const QUIET_WINDOWS = [
  [45, 150],
  [375, 465],
] as const;

class Refused extends Error {}
class ProofFailed extends Error {}
class Interrupted extends Error {}

/** A line for the person watching, before something that takes a while. */
const note = (text: string): void => console.log(`  (${text})`);
const say = (label: string, value: unknown): void => console.log(`  ${label.padEnd(74)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
const tilde = (file: string): string => (file === HOME || file.startsWith(HOME + path.sep) ? `~${file.slice(HOME.length)}` : file);

/** Aborted by the first Ctrl-C (or stop signal): what is running is ended and removed, then the script ends. */
const stopNow = new AbortController();
function checkpoint(): void {
  if (stopNow.signal.aborted) throw new Interrupted();
}
const sleep = (ms: number): Promise<void> => abortableSleep(ms, stopNow.signal);

// ---------- what this script refuses ----------

/** The identity (device and file number) of a folder and of every folder above it. What does not exist is skipped. */
function identities(folder: string): Set<string> {
  const found = new Set<string>();
  for (let at = path.resolve(folder); ; at = path.dirname(at)) {
    try {
      const stats = statSync(at, { bigint: true });
      found.add(`${stats.dev}:${stats.ino}`);
    } catch {
      // not there
    }
    if (at === path.dirname(at)) return found;
  }
}

function identityOf(folder: string): string | null {
  try {
    const stats = statSync(folder, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

/**
 * Is `folder` the same folder as `real`, inside it, or above it? Compared by identity, so a link,
 * `/System/Volumes/Data/...` or `/.vol/...` spelling of the real folder is caught, and by spelling
 * as well, for a real folder that does not exist yet.
 */
export function overlaps(folder: string, real: string): boolean {
  const [a, b] = [path.resolve(folder), path.resolve(real)];
  const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);
  if (inside(a, b) || inside(b, a)) return true;
  const [mine, theirs] = [identityOf(a), identityOf(b)];
  return (theirs !== null && identities(a).has(theirs)) || (mine !== null && identities(b).has(mine));
}

/** Is this a folder of its own inside the home folder (and not the home folder itself)? */
function ownFolderInHome(folder: string, home: string): boolean {
  const real = realPathAllowMissing(folder) ?? path.resolve(folder);
  return real !== home && real.startsWith(home + path.sep);
}

/** Why a folder cannot be this run's scratch data folder, or null when it can. */
export function dataDirProblem(folder: string | undefined, realDataDir: string = REAL_DATA_DIR, home: string = HOME): string | null {
  if (folder === undefined || folder.trim() === "") return "OVERNIGHT_DATA_DIR is not set. Name a scratch folder of your own, for example ~/.overnight-hardening.";
  if (!path.isAbsolute(folder)) return "OVERNIGHT_DATA_DIR must be a full path.";
  if (overlaps(folder, realDataDir)) return "OVERNIGHT_DATA_DIR is the real data folder, or inside it, or above it. This script only works on a scratch folder.";
  // Kept to where real builds have run. Both profiles close the shared temporary folders but for
  // a job's own folders in the data folder, and Claude Code's scratch folders altogether. In a
  // data folder under /private/tmp harmless commands could read a brief and write in the
  // workspace and in the build's temporary folder (measured Oct 12), but no real build has run in
  // one, so a proof made there would be a proof of something nobody uses.
  if (!ownFolderInHome(folder, home)) return "OVERNIGHT_DATA_DIR must be a folder of its own inside the home folder: no real build has run in a data folder anywhere else.";
  return null;
}

/** Why a folder cannot be this run's throwaway Kiro home, or null when it can. */
export function kiroHomeProblem(folder: string | undefined, realKiroHome: string = REAL_KIRO_HOME, realDataDir: string = REAL_DATA_DIR, home: string = HOME): string | null {
  if (folder === undefined || folder.trim() === "") return "KIRO_HOME is not set. Name a throwaway folder, for example ~/.kiro-hardening.";
  if (!path.isAbsolute(folder)) return "KIRO_HOME must be a full path.";
  if (overlaps(folder, realKiroHome)) return "KIRO_HOME is Kiro's real folder, or inside it, or above it. Kiro Crew's real home is never used here.";
  if (overlaps(folder, realDataDir)) return "KIRO_HOME is Overnight's real data folder, or inside it, or above it. Name a throwaway folder, for example ~/.kiro-hardening.";
  if (!ownFolderInHome(folder, home)) return "KIRO_HOME must be a folder of its own inside the home folder: the sandbox closes the temporary folders.";
  return null;
}

/** Why these two cannot be used together, or null when they can. */
export function twoFoldersProblem(dataDir: string, kiroHome: string, repo: string = REPO_ROOT): string | null {
  if (overlaps(dataDir, kiroHome)) return "OVERNIGHT_DATA_DIR and KIRO_HOME must be two separate folders, neither inside the other: the sandbox closes the data folder to Kiro Crew.";
  if (overlaps(dataDir, repo) || overlaps(kiroHome, repo)) return "OVERNIGHT_DATA_DIR and KIRO_HOME must lie outside this repo: the sandbox closes the repo to every job.";
  return null;
}

/** Why a port cannot be the throwaway gateway's, or null when it can. */
export function portProblem(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{4,5}$/.test(raw.trim())) return "KIROCREW_PORT is not set to a port number. Use one nothing else listens on, for example 5478.";
  const port = Number(raw.trim());
  if (port === DEFAULT_GATEWAY_PORT) return `KIROCREW_PORT is ${DEFAULT_GATEWAY_PORT}, the port of the gateway that builds every night. Use another, for example 5478.`;
  if (port === DASHBOARD_PORT) return `KIROCREW_PORT is ${DASHBOARD_PORT}, the dashboard's port, which the sandbox refuses. Use another, for example 5478.`;
  if (port < 1024 || port > 65_535) return "KIROCREW_PORT must be between 1024 and 65535.";
  return null;
}

/** Is this moment inside the hours kept free for the night's build (00:45 to 02:30) or delivery (06:15 to 07:45)? */
export function inQuietHours(now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const minutes = Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
  return QUIET_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

/** Does anything accept a connection on this local port right now? One connection, closed at once, nothing sent. */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (taken: boolean): void => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ---------- the profiles and the copies made of them ----------

/** A word made up for one run. It goes into the profile copies and comes back in macOS's log. */
export function newRunWord(): string {
  return `overnight-proof-${randomBytes(8).toString("hex")}`;
}
const RUN_WORD = /^overnight-proof-[0-9a-f]{16}$/;

/**
 * Added right after "(allow default)". They allow what was allowed anyway, and say so in macOS's
 * log, with this run's word. The last three are there to mark this run's programs: every program
 * reads a system value or two as it starts.
 */
function reportLines(word: string): string[] {
  const report = `(with report) (with message "${word}")`;
  return [
    ";; Added by spikes/11-hardening-proof.ts, for the proof only: these lines report and refuse nothing.",
    `(allow network-outbound (remote unix-socket (path-regex #"^/")) ${report})`,
    `(allow network-outbound (remote ip "localhost:*") ${report})`,
    `(allow network-bind (local ip "localhost:*") ${report})`,
    `(allow sysctl-read ${report})`,
    `(allow process-exec* ${report})`,
    `(allow process-fork ${report})`,
  ];
}

/** The shipped profile's text with the report lines added. Throws when the text is not shaped like one of ours. */
export function withReportLines(profileText: string, word: string): string {
  if (!RUN_WORD.test(word)) throw new Error("The run's word is not one this script made, so the report lines were not added.");
  const marker = "(version 1)\n(allow default)\n";
  if (profileText.split(marker).length !== 2) throw new Error("The profile does not begin the way ours do, so the report lines were not added.");
  return profileText.replace(marker, `${marker}${reportLines(word).join("\n")}\n`);
}

interface Places {
  paths: DataPaths;
  /** <data>/sandbox: where this script keeps its copies of the profiles. Never under the name the installer uses for the gateway job's copy. */
  profiles: { gateway: string; gatewayLoosened: string; kiroCli: string };
  kiroHome: string;
  crewHome: string;
  port: number;
  nodeBin: string;
  /** This run's word (see newRunWord). */
  word: string;
}

/** The values the gateway profile is started with, worked out the way the builder works them out. */
function gatewayDefines(profileFile: string, places: Pick<Places, "paths" | "kiroHome" | "crewHome">): string[] {
  const node = realPath(process.execPath);
  const defines = sandboxDefines(profileFile, {
    HOME,
    DATA_DIR: realPath(places.paths.root),
    REPO: realPath(REPO_ROOT),
    NODE_DIR: node === null ? null : path.dirname(path.dirname(node)),
    NPM_CACHE: realPathAllowMissing(path.join(HOME, ".npm")),
    KIRO_HOME: realPathAllowMissing(places.kiroHome),
    CREW_HOME: realPathAllowMissing(places.crewHome),
  });
  if (defines === null) throw new ProofFailed("a folder the gateway profile needs is missing");
  return defines;
}

function kiroCliDefines(profileFile: string, places: Pick<Places, "paths">, workspace: string): string[] {
  const node = realPath(process.execPath);
  const defines = sandboxDefines(profileFile, {
    HOME,
    WORKSPACE: realPath(workspace),
    DATA_DIR: realPath(places.paths.root),
    REPO: realPath(REPO_ROOT),
    NODE_DIR: node === null ? null : path.dirname(path.dirname(node)),
    NPM_CACHE: realPathAllowMissing(path.join(HOME, ".npm")),
  });
  if (defines === null) throw new ProofFailed("a folder the Kiro CLI profile needs is missing");
  return defines;
}

/** Write the copies of the two shipped profiles into the scratch data folder. */
function writeProfileCopies(places: Places): void {
  const dir = path.dirname(places.profiles.gateway);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gateway = withReportLines(readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8"), places.word);
  writeFileSync(places.profiles.gateway, gateway, { mode: 0o600 });
  // The control: the same copy with ONE thing opened again, the list of finished builds in the
  // scratch data folder. Nothing real is opened by it.
  writeFileSync(places.profiles.gatewayLoosened, `${gateway}\n(allow file-read* (subpath (string-append (param "DATA_DIR") "/built")))\n`, { mode: 0o600 });
  writeFileSync(places.profiles.kiroCli, withReportLines(readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8"), places.word), { mode: 0o600 });
}

// ---------- what the sandbox decided, out of macOS's log ----------

export interface Decision {
  program: string;
  pid: number;
  verdict: "allow" | "deny";
  operation: string;
  /** What was asked for. Empty for the few kinds that name nothing (a fork). */
  target: string;
  /** How many times: 1, or the number macOS gives when it writes one line for several ("5 duplicate reports for ..."). */
  count: number;
  /** True for such a "duplicate reports" line. It is written some seconds after the tries it counts. */
  repeats: boolean;
  /** When, in milliseconds by this Mac's clock; null when the line had no time that could be read. */
  at: number | null;
  /** The line carries this run's word: the program ran inside one of this run's profile copies. */
  marked: boolean;
}

/** `log show` wants the Mac's own local time. */
function logTime(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** The time macOS's log gives a line ("2026-10-12 00:23:52.979854-0600"), in milliseconds, or null. */
export function logTimeMs(timestamp: string | undefined): number | null {
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,3})\d*)?([+-]\d\d):?(\d\d)$/.exec(timestamp ?? "");
  if (match === null) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0")}${match[4]}:${match[5]}`);
  return Number.isNaN(ms) ? null : ms;
}

const DECISION = /(?:(\d+) duplicate reports? for )?Sandbox: (.+?)\((\d+)\) (allow|deny)(?:\(\d+\))? ([a-z0-9*_-]+)(?: (.*))?$/;

/**
 * One message of macOS's log as a decision, or null: "Sandbox: nc(4242) deny(1) network-outbound
 * /a/b.sock". A rule's own message (this run's word) follows on a line of its own.
 */
export function parseDecision(message: string, more: { word?: string; timestamp?: string } = {}): Decision | null {
  const match = DECISION.exec(message.split("\n").find((line) => line.includes("Sandbox: ")) ?? "");
  if (match === null) return null;
  return {
    program: match[2] ?? "",
    pid: Number(match[3]),
    verdict: match[4] === "allow" ? "allow" : "deny",
    operation: match[5] ?? "",
    target: (match[6] ?? "").trim(),
    count: match[1] === undefined ? 1 : Math.max(1, Number(match[1])),
    repeats: match[1] !== undefined,
    at: logTimeMs(more.timestamp),
    marked: more.word !== undefined && more.word !== "" && message.includes(more.word),
  };
}

/** The sandbox's own lines, whichever program they are about. */
const SANDBOX_LINES = 'process == "kernel" AND sender == "Sandbox" AND eventMessage CONTAINS "Sandbox: "';

/**
 * Every sandbox decision macOS logged since `since`, for every program on this Mac, or null when
 * the log could not be read. Never printed as it is. An empty list is an answer too ("the log
 * holds nothing"), which is why the last step asks for its canaries before it believes one.
 */
export function readDecisions(since: Date, word: string, logProgram: string = LOG_PROGRAM): Decision[] | null {
  // Kept as bytes and read a line at a time. After a hold the log covers an hour or more with the
  // report lines in it, and as one text it could pass the longest text Node can hold (about half
  // a gigabyte), which would end this script instead of answering "could not tell".
  const result = spawnSync(logProgram, ["show", "--start", logTime(since), "--style", "ndjson", "--predicate", SANDBOX_LINES], { timeout: 120_000, maxBuffer: 1024 * 1024 * 1024 });
  const out: unknown = result.stdout;
  if (result.status !== 0 || !Buffer.isBuffer(out)) return null;
  const decisions: Decision[] = [];
  const [NEWLINE, BRACE] = [0x0a, 0x7b];
  for (let from = 0; from < out.length; ) {
    const newline = out.indexOf(NEWLINE, from);
    const to = newline === -1 ? out.length : newline;
    if (out[from] === BRACE) {
      try {
        const event = JSON.parse(out.toString("utf8", from, to)) as { eventMessage?: unknown; timestamp?: unknown };
        if (typeof event.eventMessage === "string") {
          const decision = parseDecision(event.eventMessage, { word, ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}) });
          if (decision !== null) decisions.push(decision);
        }
      } catch {
        // not a whole line of the log
      }
    }
    from = to + 1;
  }
  return decisions;
}

/** Programs a gateway, a build or this script's own checks start. No other program's name is ever printed. */
const OUR_PROGRAMS = /^(python[0-9.]*|Python|kirocrew|kiro-cli(-chat|-term)?|node|npm|npx|sh|bash|zsh|nc|ls|cat|touch|rm|wc|mkdir|sleep|security|pgrep|bee-copy|perl|git|esbuild|chrome-headless-shell|chrome_crashpad_handler|sandbox-exec|true|date|tar|curl)$/;
/** The kinds of decision whose targets are listed. A decision of any other kind is counted in one line per program. */
const WATCHED = /^(network-outbound|network-bind|network-inbound|sysctl-read|mach-lookup)$/;
/** The system log's socket file. A program outside the sandbox listens on it; node asks for it on many of its starts inside the Kiro CLI profile. */
export const SYSLOG_SOCKET = "/private/var/run/syslog";

/** A target as a shape: known folders by name, the home folder as "~", every number as "N". */
export function targetShape(target: string, places: { dataDir: string; kiroHome: string; crewHome: string; home?: string }): string {
  const port = /^(?:remote|local):\*:(\d+)$/.exec(target);
  if (port !== null) return Number(port[1]) >= 49_152 ? "a local port (a short-lived one)" : `local port ${port[1]}`;
  let shaped = target;
  for (const [folder, name] of [
    [places.crewHome, "<crew home>"],
    [places.kiroHome, "<kiro home>"],
    [places.dataDir, "<data>"],
    [places.home ?? HOME, "~"],
  ] as const) {
    shaped = shaped.split(folder).join(name);
  }
  return shaped
    .replace(/^\/private\/var\/folders\/[^/]+\/[^/]+\//, "<temp>/")
    .replace(/[0-9a-f]{8,}/gi, "H")
    .replace(/\d+/g, "N");
}

/** A program's name as it may be printed: one a build starts, or no name at all. */
function printedName(program: string): string {
  return OUR_PROGRAMS.test(program) ? program : "a program whose name is not on this script's list";
}

/** One decision as the line it is counted under. */
function decisionLine(decision: Decision, places: Parameters<typeof targetShape>[1]): string {
  const start = `${printedName(decision.program)}: ${decision.verdict} ${decision.operation}`;
  if (!WATCHED.test(decision.operation)) return `${start} (targets not listed)`;
  // Every program reads system values as it starts. Only the questions about other processes are of interest.
  if (decision.operation === "sysctl-read" && !decision.target.startsWith("kern.proc")) return `${start} (system values, not listed)`;
  return `${start} ${targetShape(decision.target, places)}`;
}

/** Counts by program, verdict, kind of thing and target shape. A program whose name is not one a build starts is counted without its name. */
export function countDecisions(decisions: Decision[], places: Parameters<typeof targetShape>[1]): Array<{ what: string; count: number }> {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    const what = decisionLine(decision, places);
    counts.set(what, (counts.get(what) ?? 0) + decision.count);
  }
  return [...counts.entries()].map(([what, count]) => ({ what, count })).sort((a, b) => a.what.localeCompare(b.what));
}

// ---------- whose programs: the watcher ----------

/** A process number, and from when to when it was this run's. `to` is null while it was still running at the end. */
export interface Sighting {
  from: number;
  to: number | null;
}

/** What the watcher wrote down. */
export interface Watch {
  sightings: Map<number, Sighting[]>;
  /** How many times it looked at the process table. */
  samples: number;
  /** The longest time between two looks, in milliseconds. */
  longestGapMs: number;
  /** How many lines with this run's word it heard as macOS's log wrote them. */
  marksHeard: number;
  /** How many programs were still running when it was told to end, and were ended by it. */
  endedByWatcher: number;
  /** It ran to its end and said so. */
  finished: boolean;
}

/**
 * The watcher: a second process, plain JavaScript, started outside any sandbox. It follows macOS's
 * log for this run's word and looks at the process table every `pauseMs`. One line for each thing
 * it notes: "p <pid> <ms>" a process that is this run's, "x <pid> <ms>" gone (or another program
 * by now: macOS gives numbers out again), "h <ms>" the first line of this run it heard in the log.
 * When it is told to end (SIGTERM), or finds this script gone, it ends every process it still
 * holds and writes "s", "k" and "e" lines.
 */
const WATCHER_SOURCE = String.raw`
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const root = Number(process.argv[1]);
const out = process.argv[2];
const word = process.argv[3];
const pauseMs = Number(process.argv[4]);
const live = new Map();
const groups = new Set();
const heard = new Map();
let samples = 0;
let longestGap = 0;
let lastAt = 0;
let marks = 0;
let timer = null;
let ending = false;
const write = (text) => {
  try {
    appendFileSync(out, text);
  } catch {
    // the folder is gone: nobody is left to read this
  }
};

// With a time limit of its own: should this watcher ever be killed outright, the follower does not run on for ever.
const stream = spawn("/usr/bin/log", ["stream", "--timeout", "2h", "--style", "ndjson", "--predicate", 'process == "kernel" AND sender == "Sandbox" AND eventMessage CONTAINS "' + word + '"'], { stdio: ["ignore", "pipe", "ignore"] });
let buffer = "";
stream.on("error", () => {});
stream.stdout.setEncoding("utf8");
stream.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.startsWith("{")) continue;
    try {
      const message = String(JSON.parse(line).eventMessage);
      const match = /Sandbox: .+?\((\d+)\) (?:allow|deny)/.exec(message);
      if (match === null || !message.includes(word)) continue;
      marks += 1;
      if (marks === 1) write("h " + Date.now() + "\n");
      heard.set(Number(match[1]), Date.now());
    } catch {
      // not a whole line
    }
  }
  if (buffer.length > 4000000) buffer = "";
});

function table() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const rows = new Map();
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isInteger)) rows.set(parts[0], { ppid: parts[1], pgid: parts[2] });
  }
  return rows;
}

function sample() {
  const rows = table();
  const at = Date.now();
  if (rows === null) return;
  let text = "";
  for (const [pid, was] of live) {
    const now = rows.get(pid);
    // The same process still: it has the parent it had, or lost it (macOS then hands it to process 1) and kept its group.
    const same = now !== undefined && (now.ppid === was.ppid || (now.ppid === 1 && now.pgid === was.pgid));
    if (same) live.set(pid, now);
    else {
      live.delete(pid);
      text += "x " + pid + " " + at + "\n";
    }
  }
  const present = new Set();
  for (const row of rows.values()) present.add(row.pgid);
  for (const group of groups) if (!present.has(group)) groups.delete(group);
  for (const [pid, when] of heard) if (at - when > 2000) heard.delete(pid);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, row] of rows) {
      if (live.has(pid) || pid === root || pid === process.pid || row.ppid === process.pid) continue;
      if (!(row.ppid === root || live.has(row.ppid) || groups.has(row.pgid) || heard.has(pid))) continue;
      live.set(pid, row);
      if (row.pgid === pid) groups.add(pid);
      text += "p " + pid + " " + at + "\n";
      grew = true;
    }
  }
  for (const [pid, row] of live) if (row.pgid === pid) groups.add(pid);
  samples += 1;
  if (lastAt !== 0) longestGap = Math.max(longestGap, at - lastAt);
  lastAt = at;
  if (text !== "") write(text);
}

function finish() {
  if (ending) return;
  ending = true;
  if (timer !== null) clearTimeout(timer);
  // The pauses while what is left is being ended are not pauses in the watching.
  const gap = longestGap;
  const ended = new Set();
  for (let round = 0; round < 6; round += 1) {
    sample();
    if (live.size === 0) break;
    for (const pid of live.keys()) {
      try {
        process.kill(pid, "SIGKILL");
        ended.add(pid);
      } catch {
        // gone already
      }
    }
    spawnSync("/bin/sleep", ["0.2"]);
  }
  try {
    stream.kill("SIGKILL");
  } catch {
    // gone already
  }
  write("s " + samples + " " + gap + " " + marks + "\nk " + ended.size + "\ne " + Date.now() + "\n");
  process.exit(0);
}

process.on("SIGTERM", finish);
// Ctrl-C in a terminal reaches every program started from it. This one ends when the script says so, or is gone.
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
function tick() {
  if (process.ppid !== root) return finish();
  sample();
  timer = setTimeout(tick, pauseMs);
}
write("b " + Date.now() + "\n");
tick();
`;

/** What the watcher's file says. Lines that are not the watcher's are skipped. */
export function parseWatch(text: string): Watch {
  const watch: Watch = { sightings: new Map(), samples: 0, longestGapMs: 0, marksHeard: 0, endedByWatcher: 0, finished: false };
  for (const line of text.split("\n")) {
    const [kind, ...rest] = line.trim().split(" ");
    const numbers = rest.map(Number);
    if (numbers.some((n) => !Number.isFinite(n))) continue;
    const [first, second, third] = numbers;
    if (kind === "p" && first !== undefined && second !== undefined) {
      const list = watch.sightings.get(first) ?? [];
      list.push({ from: second, to: null });
      watch.sightings.set(first, list);
    } else if (kind === "x" && first !== undefined && second !== undefined) {
      const open = (watch.sightings.get(first) ?? []).filter((sighting) => sighting.to === null).at(-1);
      if (open !== undefined) open.to = second;
    } else if (kind === "s" && first !== undefined && second !== undefined && third !== undefined) {
      [watch.samples, watch.longestGapMs, watch.marksHeard] = [first, second, third];
    } else if (kind === "k" && first !== undefined) {
      watch.endedByWatcher = first;
    } else if (kind === "e") {
      watch.finished = true;
    }
  }
  return watch;
}

/** Between two looks at the process table. A look itself takes 10 to 15 ms (measured), so that is about 25 looks a second. */
const WATCHER_PAUSE_MS = 25;
let watcherChild: ChildProcess | null = null;
let watcherFile = "";

function startWatcher(places: Places): void {
  watcherFile = path.join(places.paths.logs, "hardening-proof-watcher.txt");
  writeFileSync(watcherFile, "", { mode: 0o600 });
  // Not in a group of its own: it must be able to tell that this script is gone, and it ignores Ctrl-C.
  watcherChild = spawn(process.execPath, ["-e", WATCHER_SOURCE, String(process.pid), watcherFile, places.word, String(WATCHER_PAUSE_MS)], { stdio: "ignore" });
}

/** Tell the watcher to end (it first ends whatever this run left running) and read what it wrote. Null when there is nothing to read. */
async function stopWatcher(): Promise<Watch | null> {
  const child = watcherChild;
  watcherChild = null;
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref())]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  try {
    return watcherFile === "" ? null : parseWatch(readFileSync(watcherFile, "utf8"));
  } catch {
    return null;
  }
}

// ---------- the last step: what was refused to this run's own programs ----------

/** One of this script's own test refusals: a connection, from inside a profile copy, to a socket file that is closed to it. */
export interface CanaryTry {
  label: string;
  pid: number | null;
  /** The socket file's full path: what macOS's log names. */
  target: string;
  at: number;
}

export interface LogFacts {
  /** Null: macOS's log could not be read. */
  decisions: Decision[] | null;
  canaries: CanaryTry[];
  /** The programs this script started inside a profile copy itself. */
  started: Array<{ pid: number } & Sighting>;
  /** Null: the watcher left nothing to read. */
  watch: Watch | null;
}

export interface LogJudgement {
  verdict: "pass" | "fail" | "could not tell";
  /** One plain sentence of our own. */
  why: string;
  canariesFound: number;
  /** This run's own decisions, the canaries left out. */
  ours: Decision[];
  /** How many times node was refused the system log's socket file. */
  expected: number;
  /** Socket files refused to this run's programs, other than the expected one. Any of these fails the step. */
  unexpected: Decision[];
  /** Decisions about other programs on this Mac. They decide nothing. */
  others: number;
  /** Of those: a socket file refused to a program that has a build tool's name. */
  othersLikeOurs: number;
}

/** How far a log line's time may be from the time a process was noted. */
const SLACK_MS = 1_000;
/** A "duplicate reports" line comes a few seconds after the tries it counts. */
const REPEATS_WITHIN_MS = 60_000;

const isSocketFileRefusal = (decision: Decision): boolean => decision.verdict === "deny" && decision.operation === "network-outbound" && decision.target.startsWith("/");
const total = (decisions: Decision[]): number => decisions.reduce((sum, decision) => sum + decision.count, 0);

/**
 * The last step's answer, from what was read and noted. Pure: the same facts always give the
 * same answer. "pass" needs every canary found and refused, the watcher's notes whole, and no
 * socket file refused to this run's programs but the expected one.
 */
export function judgeLog(facts: LogFacts): LogJudgement {
  const nothing = { canariesFound: 0, ours: [], expected: 0, unexpected: [], others: 0, othersLikeOurs: 0 };
  if (facts.decisions === null) return { verdict: "could not tell", why: "macOS's log could not be read, so nothing is known about what was refused", ...nothing };
  const decisions = [...facts.decisions].sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));

  // When each process number was this run's.
  const noted = new Map<number, Sighting[]>();
  const noteSighting = (pid: number, sighting: Sighting): void => {
    const list = noted.get(pid);
    if (list === undefined) noted.set(pid, [sighting]);
    else list.push(sighting);
  };
  for (const { pid, from, to } of facts.started) noteSighting(pid, { from, to });
  for (const [pid, sightings] of facts.watch?.sightings ?? []) for (const sighting of sightings) noteSighting(pid, sighting);
  for (const decision of decisions) if (decision.marked) noteSighting(decision.pid, decision.at === null ? { from: 0, to: null } : { from: decision.at, to: decision.at });
  const wasOurs = (pid: number, at: number | null): boolean => (noted.get(pid) ?? []).some((sighting) => at === null || (at >= sighting.from - SLACK_MS && at <= (sighting.to ?? Number.MAX_SAFE_INTEGER) + SLACK_MS));

  const canaryTargets = new Set(facts.canaries.map((canary) => canary.target));
  const isCanary = (decision: Decision): boolean => decision.operation === "network-outbound" && canaryTargets.has(decision.target);
  const ours: Decision[] = [];
  const others: Decision[] = [];
  const lastOurs = new Map<string, number | null>();
  for (const decision of decisions) {
    if (isCanary(decision)) continue;
    const key = `${decision.pid} ${decision.verdict} ${decision.operation} ${decision.target}`;
    const before = lastOurs.get(key);
    const repeatOfOurs = decision.repeats && before !== undefined && (before === null || decision.at === null || (decision.at >= before && decision.at - before <= REPEATS_WITHIN_MS));
    if (decision.marked || repeatOfOurs || wasOurs(decision.pid, decision.at)) {
      ours.push(decision);
      lastOurs.set(key, decision.at);
    } else others.push(decision);
  }

  const found = facts.canaries.map((canary) => decisions.find((decision) => isCanary(decision) && decision.target === canary.target && (canary.pid === null || decision.pid === canary.pid)));
  const canariesFound = found.filter((decision) => decision !== undefined).length;
  // The canary's own program must carry this run's word too: that is what tells this run's programs from others.
  const canariesMarked = facts.canaries.filter((canary) => canary.pid !== null && decisions.some((decision) => decision.marked && decision.pid === canary.pid && (decision.at === null || Math.abs(decision.at - canary.at) <= 10 * SLACK_MS))).length;

  const refusals = ours.filter(isSocketFileRefusal);
  const isExpected = (decision: Decision): boolean => decision.program === "node" && decision.target === SYSLOG_SOCKET;
  const unexpected = refusals.filter((decision) => !isExpected(decision));
  const counted = {
    canariesFound,
    ours,
    expected: total(refusals.filter(isExpected)),
    unexpected,
    others: total(others),
    othersLikeOurs: total(others.filter((decision) => isSocketFileRefusal(decision) && OUR_PROGRAMS.test(decision.program))),
  };
  const answer = (verdict: LogJudgement["verdict"], why: string): LogJudgement => ({ verdict, why, ...counted });

  // What is known for certain comes first; what could not be told, second.
  if (found.some((decision) => decision?.verdict === "allow")) return answer("fail", "a profile copy let this script's own test connection to a closed socket file through: its rule about socket files is not in force, so this step proves nothing about that rule");
  if (unexpected.length > 0) return answer("fail", `a socket file other than the expected one was refused to this run's own programs (${total(unexpected)} ${total(unexpected) === 1 ? "time" : "times"}; see the lines above)`);
  if (facts.canaries.length === 0) return answer("could not tell", "this script made none of its own test refusals, so nothing shows that the log was read");
  if (canariesFound < facts.canaries.length) return answer("could not tell", `only ${canariesFound} of this script's own ${facts.canaries.length} test refusals are in what was read of macOS's log, so the log does not cover the run`);
  if (canariesMarked < facts.canaries.length) return answer("could not tell", "macOS's log does not carry this run's word for this script's own test programs, so this run's programs cannot be told from others");
  if (facts.watch === null || !facts.watch.finished || facts.watch.samples === 0) return answer("could not tell", "the watcher that notes this run's programs did not run to its end");
  if (facts.watch.marksHeard === 0) return answer("could not tell", "the watcher heard nothing of this run in macOS's log, so a program that cut itself loose would have been missed");
  return answer("pass", "no socket file was refused to this run's own programs, other than the expected one");
}

/** One run of this script: its test refusals so far, and the programs it started inside a profile copy itself. */
interface Run {
  since: Date;
  canaries: CanaryTry[];
  started: Array<{ pid: number } & Sighting>;
}
const thisRun: Run = { since: new Date(Date.now() - 1000), canaries: [], started: [] };

/**
 * Start one program with sandbox-exec, wait for it, and note its process number as this run's.
 * `args` is everything after "sandbox-exec": the profile, its values, the program, its arguments.
 */
function startInside(args: string[], options: { cwd: string; env: Record<string, string>; keepOutput?: boolean; timeoutMs?: number }): { status: number | null; pid: number | null; stdout: string } {
  const from = Date.now();
  const result = spawnSync(SANDBOX_EXEC, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 20_000, stdio: ["ignore", options.keepOutput === true ? "pipe" : "ignore", "ignore"], encoding: "utf8", env: options.env });
  const pid = typeof result.pid === "number" && result.pid > 0 ? result.pid : null;
  if (pid !== null) thisRun.started.push({ pid, from, to: Date.now() });
  return { status: result.status, pid, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

/** Run one harmless program inside a profile. Only its exit code is looked at (and, where asked for, a number it printed). */
function insideWith(profileFile: string, defines: string[], cwd: string, tmpDir: string, command: string, args: string[], options: { keepOutput?: boolean } = {}): { status: number | null; pid: number | null; stdout: string } {
  return startInside(["-f", profileFile, ...defines, command, ...args], { cwd, env: { HOME, PATH: "/usr/bin:/bin", TMPDIR: tmpDir }, ...options });
}
function inside(profileFile: string, defines: string[], cwd: string, tmpDir: string, command: string, args: string[]): number | null {
  return insideWith(profileFile, defines, cwd, tmpDir, command, args).status;
}

/** A listener on a socket file, outside any sandbox, for as long as a check needs it. Reached by a short relative name: a full path can pass the 104 bytes a socket name may have. */
function listenOn(dir: string, name: string): ChildProcess {
  rmSync(path.join(dir, name), { force: true });
  const listener = spawn("/usr/bin/nc", ["-lkU", name], { cwd: dir, stdio: "ignore" });
  // Until the file is there, a try at it is not a try at a socket file, and macOS logs nothing.
  for (let waited = 0; waited < 60 && !existsSync(path.join(dir, name)); waited += 1) spawnSync("/bin/sleep", ["0.05"]);
  return listener;
}

/**
 * One canary: from inside a profile copy, a connection to a socket file of this script's own in
 * the scratch data folder itself, which no job may reach. The profile certainly refuses it, and
 * macOS certainly logs it. The file's name holds part of this run's word, so no other line of
 * the log can be taken for it.
 */
function canary(places: Places, label: string, profileFile: string, defines: string[]): void {
  const name = `canary-${thisRun.canaries.length + 1}-${places.word.slice(-16)}.sock`;
  const listener = listenOn(places.paths.root, name);
  try {
    const at = Date.now();
    const tried = insideWith(profileFile, defines, places.paths.root, buildTmpDir(places.paths) ?? "", "/usr/bin/nc", ["-U", name]);
    thisRun.canaries.push({ label, pid: tried.pid, target: path.join(places.paths.root, name), at });
  } finally {
    listener.kill("SIGKILL");
    rmSync(path.join(places.paths.root, name), { force: true });
  }
}

/** The canaries of both profile copies, before or after everything else. */
function canaries(places: Places, when: "before" | "after"): void {
  const workspace = path.join(places.paths.workspaces, "hardening-proof-canary");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  canary(places, `${when}, gateway profile`, places.profiles.gateway, gatewayDefines(places.profiles.gateway, places));
  canary(places, `${when}, Kiro CLI profile`, places.profiles.kiroCli, kiroCliDefines(places.profiles.kiroCli, places, workspace));
}

/** End the watcher, then read macOS's log until this run's last canary is in it (the log is written a moment after the fact). */
async function gatherFacts(places: Places, logProgram: string = LOG_PROGRAM): Promise<LogFacts> {
  const watch = await stopWatcher();
  checkpoint();
  // The line that sums up repeated tries comes about four seconds after them.
  await sleep(5_000);
  let decisions: Decision[] | null = null;
  for (let tries = 0; tries < 8; tries += 1) {
    checkpoint();
    decisions = readDecisions(thisRun.since, places.word, logProgram);
    const read = decisions;
    if (read !== null && thisRun.canaries.every((made) => read.some((decision) => decision.target === made.target))) break;
    await sleep(2_500);
  }
  return { decisions, canaries: [...thisRun.canaries], started: [...thisRun.started], watch };
}

/**
 * Before a gateway is started or a credit is spent: can the last step do its work on this Mac
 * right now? The "before" canaries must already be in macOS's log, refused and carrying this
 * run's word, and the watcher must be running and have heard them. A run whose last step could
 * only say "could not tell" is stopped here, where it has cost nothing.
 */
async function proveLastStepCanWork(places: Places): Promise<void> {
  let why = "";
  for (let tries = 0; tries < 8; tries += 1) {
    await sleep(tries === 0 ? 1_500 : 2_500);
    checkpoint();
    const watching = watcherChild !== null && watcherChild.exitCode === null && watcherChild.signalCode === null;
    let heard = false;
    try {
      heard = /^h \d+$/m.test(readFileSync(watcherFile, "utf8"));
    } catch {
      // no file yet
    }
    // The watcher's own count comes when it ends; here it only has to be running and to have heard something.
    const judgement = judgeLog({ decisions: readDecisions(thisRun.since, places.word), canaries: [...thisRun.canaries], started: [...thisRun.started], watch: { sightings: new Map(), samples: 1, longestGapMs: 0, marksHeard: heard ? 1 : 0, endedByWatcher: 0, finished: watching } });
    why = judgement.why;
    if (judgement.verdict === "pass") return expectStep("before anything is started: macOS's log is read, and it shows this run's own programs", true);
    if (judgement.verdict === "fail") break;
  }
  say("before anything is started: macOS's log is read, and it shows this run's own programs", "NO");
  throw new ProofFailed(`${why} (found out before anything was started, so nothing was spent)`);
}

/** Print what the last step found. Counts, shapes and our own words only. */
function printJudgement(places: Places, facts: LogFacts, judgement: LogJudgement): void {
  for (const { what, count } of countDecisions(judgement.ours, { dataDir: places.paths.root, kiroHome: places.kiroHome, crewHome: places.crewHome })) say(`  ${what}`, count);
  say("macOS's log was read: this script's own test refusals found in it", `${judgement.canariesFound} of ${facts.canaries.length}`);
  say("the watcher: looks at the process table, longest pause, lines of this run heard", facts.watch === null ? "left nothing to read" : `${facts.watch.samples}, ${facts.watch.longestGapMs} ms, ${facts.watch.marksHeard}`);
  say("process numbers noted as this run's (by the watcher, by the log, by this script)", new Set([...(facts.watch?.sightings.keys() ?? []), ...facts.started.map((entry) => entry.pid), ...(facts.decisions ?? []).filter((decision) => decision.marked).map((decision) => decision.pid)]).size);
  say("decisions about other programs on this Mac in the same minutes (not looked at)", judgement.others);
  say("  of those: a socket file refused to a program with a build tool's name", judgement.othersLikeOurs);
  say(`expected: node refused the system log's socket file (${SYSLOG_SOCKET})`, judgement.expected);
  say("any other socket file refused to this run's own programs", total(judgement.unexpected));
  for (const decision of judgement.unexpected) {
    if (decision.target === SYSLOG_SOCKET) say("  note", `the system log's socket was refused to ${printedName(decision.program)}; only node was measured (it is harmless to node)`);
  }
}

/** The last step of p1, p2 and hold, up to its answer: the "after" canaries, the watcher ended, the log read, judged and printed. */
async function judgeRun(places: Places, reading = "reading macOS's log; about ten seconds"): Promise<LogJudgement> {
  note(reading);
  canaries(places, "after");
  const facts = await gatherFacts(places);
  const judgement = judgeLog(facts);
  printJudgement(places, facts, judgement);
  say("programs still running at the end, ended by the watcher", facts.watch?.endedByWatcher ?? "not known");
  say("the answer", judgement.verdict === "pass" ? "pass" : judgement.verdict === "fail" ? "FAIL" : "COULD NOT TELL");
  if (judgement.verdict === "pass") say("why", judgement.why);
  return judgement;
}

/** The last step of p1 and p2. Stops the proof unless the answer is "pass". */
async function lastStep(places: Places): Promise<void> {
  const judgement = await judgeRun(places);
  if (judgement.verdict !== "pass") throw new ProofFailed(judgement.why);
}

// ---------- small tools ----------

function expectStep(label: string, ok: boolean, detail: unknown = ok ? "yes" : "NO"): void {
  say(label, detail);
  if (!ok) throw new ProofFailed(label);
}

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------- check: this script's own tools, with no gateway and no Kiro ----------

async function selfCheck(places: Places): Promise<void> {
  console.log("\n1. What this script refuses");
  expectStep("the real data folder, by its own name", dataDirProblem(REAL_DATA_DIR) !== null);
  expectStep("a folder inside it, and the folder above it", dataDirProblem(path.join(REAL_DATA_DIR, "scratch")) !== null && dataDirProblem(HOME) !== null);
  expectStep("the same folder through another spelling", !existsSync("/System/Volumes/Data") || dataDirProblem(path.join("/System/Volumes/Data", REAL_DATA_DIR)) !== null);
  expectStep("a folder outside the home folder, a relative one, none at all", [dataDirProblem("/private/tmp/overnight-proof"), dataDirProblem("scratch"), dataDirProblem(undefined)].every((problem) => problem !== null));
  expectStep("this run's scratch data folder is accepted", dataDirProblem(places.paths.root) === null);
  expectStep("Kiro's real folder, Kiro Crew's real home, and the folder above them", [REAL_KIRO_HOME, path.join(REAL_KIRO_HOME, "crew"), HOME, undefined].every((folder) => kiroHomeProblem(folder) !== null));
  expectStep("a Kiro home inside the real data folder, or outside the home folder", [path.join(REAL_DATA_DIR, "kiro"), "/private/tmp/kiro-proof"].every((folder) => kiroHomeProblem(folder) !== null));
  expectStep("a throwaway Kiro home beside the real one is accepted", kiroHomeProblem(path.join(HOME, ".kiro-hardening")) === null);
  expectStep("a Kiro home inside the scratch data folder, or either of the two inside this repo", twoFoldersProblem(places.paths.root, path.join(places.paths.root, "kiro")) !== null && twoFoldersProblem(path.join(REPO_ROOT, "scratch"), path.join(HOME, ".kiro-hardening")) !== null && twoFoldersProblem(places.paths.root, path.join(HOME, ".kiro-hardening")) === null);
  expectStep("the live gateway's port, the dashboard's port, and no port", [String(DEFAULT_GATEWAY_PORT), String(DASHBOARD_PORT), "", undefined, "80"].every((port) => portProblem(port) !== null) && portProblem("5478") === null);
  expectStep("the hours of the night's build and delivery (1:00 am and 6:30 am in Boise)", inQuietHours(new Date("2026-10-12T07:00:00Z"), "America/Boise") && inQuietHours(new Date("2026-10-12T12:30:00Z"), "America/Boise") && !inQuietHours(new Date("2026-10-12T20:00:00Z"), "America/Boise"));

  console.log("\n2. The profiles, and the copies this script makes of them");
  writeProfileCopies(places);
  const workspace = path.join(places.paths.workspaces, "hardening-proof-check");
  const tmpDir = buildTmpDir(places.paths) ?? "";
  for (const dir of [workspace, path.join(places.paths.built, "hardening-proof-check")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(workspace, "brief.md"), "made up for the check\n");
  writeFileSync(path.join(places.paths.built, "hardening-proof-check", "index.html"), "made up for the check\n");
  const gateway = gatewayDefines(CREW_GATEWAY_SANDBOX_PROFILE, places);
  const kiroCli = kiroCliDefines(KIRO_CLI_SANDBOX_PROFILE, places, workspace);
  const loads = (profile: string, defines: string[]): boolean => inside(profile, defines, workspace, tmpDir, "/usr/bin/true", []) === 0;
  expectStep("the shipped gateway profile loads", loads(CREW_GATEWAY_SANDBOX_PROFILE, gateway));
  expectStep("the shipped Kiro CLI profile loads", loads(KIRO_CLI_SANDBOX_PROFILE, kiroCli));
  expectStep("the gateway copy with the report lines loads", loads(places.profiles.gateway, gateway));
  expectStep("the loosened gateway copy loads", loads(places.profiles.gatewayLoosened, gateway));
  expectStep("the Kiro CLI copy with the report lines loads", loads(places.profiles.kiroCli, kiroCli));

  // Before the watcher starts, so that nothing but the log could make it this run's: a program
  // in a sandbox that is not ours, refused a socket file. The last step must not count it.
  const strangerSocket = "proof-stranger.sock";
  const strangerListener = listenOn(places.paths.root, strangerSocket);
  const stranger = spawnSync(SANDBOX_EXEC, ["-p", '(version 1)(allow default)(deny network-outbound (remote unix-socket (path-regex #"^/")))', "/usr/bin/nc", "-U", strangerSocket], { cwd: places.paths.root, stdio: "ignore", timeout: 20_000 });
  strangerListener.kill("SIGKILL");
  rmSync(path.join(places.paths.root, strangerSocket), { force: true });
  // Long enough apart that "within a second" cannot make the stranger this run's.
  await sleep(2_500);
  checkpoint();

  startWatcher(places);
  canaries(places, "before");
  // As p1 and p2 do, before they start or spend anything.
  await proveLastStepCanWork(places);

  // "Did not work" is not always the sandbox: nothing listens on port 9, and maybe nothing on the
  // dashboard's. What is checked here is only that the copy answers as the shipped file does.
  console.log("\n3. The report lines change no decision (shipped profile and copy, side by side)");
  // A listener in a folder a job may write (the build's temporary folder) and one where it may not (the data folder itself).
  const closedSocket = "proof-closed.sock";
  const listeners = [listenOn(tmpDir, "proof-open.sock"), listenOn(places.paths.root, closedSocket)];
  let leftBehind: number | null;
  try {
    const sealed = path.join(places.paths.built, "hardening-proof-check", "index.html");
    const questions: Array<[string, string, string[], string]> = [
      ["read the brief in the workspace", "/bin/cat", [path.join(workspace, "brief.md")], workspace],
      ["read a finished build", "/bin/cat", [sealed], workspace],
      ["list the finished builds", "/bin/ls", [places.paths.built], workspace],
      ["make a file among the finished builds", "/usr/bin/touch", [path.join(places.paths.built, "planted.txt")], workspace],
      ["connect to a socket file in the build's temporary folder", "/usr/bin/nc", ["-U", "proof-open.sock"], tmpDir],
      ["connect to a socket file in a folder that is closed to it", "/usr/bin/nc", ["-U", closedSocket], places.paths.root],
      [`connect to the dashboard's port (${DASHBOARD_PORT})`, "/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", String(DASHBOARD_PORT)], workspace],
      // The same address written as an IPv6 one: a rule for "localhost" let this through (found Oct 11).
      ["connect to the dashboard's port by ::ffff:127.0.0.1", "/usr/bin/nc", ["-z", "-w", "1", "::ffff:127.0.0.1", String(DASHBOARD_PORT)], workspace],
      ["connect to a local port nothing listens on (9)", "/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", "9"], workspace],
    ];
    for (const [label, shipped, copy, defines] of [
      ["gateway", CREW_GATEWAY_SANDBOX_PROFILE, places.profiles.gateway, gateway],
      ["Kiro CLI", KIRO_CLI_SANDBOX_PROFILE, places.profiles.kiroCli, kiroCli],
    ] as const) {
      for (const [question, command, args, cwd] of questions) {
        checkpoint();
        const [a, b] = [inside(shipped, defines, cwd, tmpDir, command, args), inside(copy, defines, cwd, tmpDir, command, args)];
        expectStep(`${label}: ${question}`, a === b, a === b ? (a === 0 ? "worked in both" : "did not work in either") : `DIFFERENT: shipped ${a}, copy ${b}`);
      }
    }
    expectStep("nothing was left among the finished builds", !existsSync(path.join(places.paths.built, "planted.txt")));

    // For step 4. Node inside the Kiro CLI copy, six starts: the refusal that is expected.
    for (let start = 0; start < 6; start += 1) insideWith(places.profiles.kiroCli, kiroCli, workspace, tmpDir, path.join(places.nodeBin, "node"), ["-e", ""]);
    // And a program that cuts itself loose inside the gateway copy and stays (a sleep, in a session of its own, its parent gone).
    const loose = insideWith(places.profiles.gateway, gateway, workspace, tmpDir, "/usr/bin/perl", ["-e", 'use POSIX qw(setsid); my $k = fork(); exit 1 unless defined $k; if ($k == 0) { open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); setsid(); exec "/bin/sleep", "600"; exit 1 } print "$k\\n";'], { keepOutput: true });
    leftBehind = /^\d+$/.test(loose.stdout.trim()) ? Number(loose.stdout.trim()) : null;
    // The watcher looks about 25 times a second; give it a few looks at what was left behind.
    await sleep(600);
    checkpoint();
  } finally {
    for (const listener of listeners) listener.kill("SIGKILL");
    rmSync(path.join(tmpDir, "proof-open.sock"), { force: true });
    rmSync(path.join(places.paths.root, closedSocket), { force: true });
  }

  console.log("\n4. The last step of p1, p2 and hold, tried here on the harmless programs above (counts by program, kind and target shape)");
  expectStep("a program that cut itself loose inside the sandbox is running", leftBehind !== null && isRunningProcess(leftBehind));
  canaries(places, "after");
  const facts = await gatherFacts(places);
  const stillRunning = leftBehind !== null && isRunningProcess(leftBehind);
  if (stillRunning && leftBehind !== null) process.kill(leftBehind, "SIGKILL");
  const judgement = judgeLog(facts);
  printJudgement(places, facts, judgement);
  const closedTarget = path.join(places.paths.root, closedSocket);
  const strangerTarget = path.join(places.paths.root, strangerSocket);
  const decisions = facts.decisions ?? [];
  expectStep("(a) the log was read: every one of this script's test refusals is in it, and was refused", judgement.canariesFound === facts.canaries.length && facts.canaries.length === 4 && decisions.filter((decision) => facts.canaries.some((entry) => entry.target === decision.target)).every((decision) => decision.verdict === "deny"), `${judgement.canariesFound} of ${facts.canaries.length}`);
  expectStep("the watcher ran to its end, and heard this run in the log as it was written", facts.watch !== null && facts.watch.finished && facts.watch.samples > 0 && facts.watch.marksHeard > 0);
  expectStep("what was left running inside the sandbox was ended with the watcher", !stillRunning && (facts.watch?.endedByWatcher ?? 0) >= 1, stillRunning ? "NO: it was still running (ended now)" : `yes (${facts.watch?.endedByWatcher ?? 0})`);
  const strangerLines = decisions.filter((decision) => decision.target === strangerTarget && decision.pid === stranger.pid);
  expectStep("(b) another program's refused socket file is in the log, and is not counted as this run's", strangerLines.length > 0 && strangerLines.every((decision) => decision.verdict === "deny") && !judgement.ours.some((decision) => decision.target === strangerTarget) && judgement.othersLikeOurs >= 1, strangerLines.length > 0 ? "yes" : "NO: it is not in the log");
  const expectedOnly = judgement.ours.filter((decision) => decision.target === SYSLOG_SOCKET);
  expectStep("(c) node asking for the system log's socket is expected, with its count (of 6 starts)", expectedOnly.every((decision) => decision.program === "node") && judgement.expected === total(expectedOnly) && !judgement.unexpected.some((decision) => decision.target === SYSLOG_SOCKET), judgement.expected);
  expectStep("this run's own tries at a closed socket file are counted, and fail the step", judgement.verdict === "fail" && judgement.unexpected.length > 0 && judgement.unexpected.every((decision) => decision.target === closedTarget) && total(judgement.unexpected) === 4, `${judgement.verdict} (${total(judgement.unexpected)} of 4)`);
  const without = judgeLog({ ...facts, decisions: decisions.filter((decision) => decision.target !== closedTarget) });
  expectStep("with those four set aside, the same log passes", without.verdict === "pass", without.verdict === "pass" ? "pass" : `${without.verdict}: ${without.why}`);
  const noLog = judgeLog({ ...facts, decisions: readDecisions(thisRun.since, places.word, "/usr/bin/false") });
  expectStep("with macOS's log unreadable (the log program swapped for one that fails)", noLog.verdict === "could not tell", noLog.verdict);
  const emptyLog = judgeLog({ ...facts, decisions: readDecisions(thisRun.since, places.word, "/usr/bin/true") });
  expectStep("with a log that holds nothing (the log program swapped for one that prints nothing)", emptyLog.verdict === "could not tell", emptyLog.verdict);
  expectStep("a made-up log line is read as a decision, and shaped", targetShape(parseDecision(`x Sandbox: nc(4242) deny(1) network-outbound ${HOME}/Library/x-501/agent.3.sock`)?.target ?? "", { dataDir: "/d", kiroHome: "/k", crewHome: "/k/crew" }) === "~/Library/x-N/agent.N.sock");
  expectStep("a local port is named, a short-lived one is not", targetShape("remote:*:4321", { dataDir: "/d", kiroHome: "/k", crewHome: "/c" }) === "local port 4321" && targetShape("remote:*:61234", { dataDir: "/d", kiroHome: "/k", crewHome: "/c" }) === "a local port (a short-lived one)");

  console.log("\n5. The nightly check's command for this scratch folder");
  const command = probeCommand({
    dir: path.join(places.paths.root, "tmp", "build-probe"),
    beeBinary: path.join(places.paths.root, "tmp", "build-probe", "bee-copy"),
    database: places.paths.database,
    listTargets: listTestTargets(HOME),
    writeTargets: writeTestTargets({ home: HOME, repo: REPO_ROOT, node: places.nodeBin, kirocrew: path.dirname(realPath(defaultKirocrewBinary()) ?? defaultKirocrewBinary()) }),
    built: places.paths.built,
  });
  expectStep("it can be written for these folders", command !== null);
  say("things it tries (three reads, the lists, one look at another program, the writes)", 3 + LIST_TESTS.length + 1 + WRITE_TESTS.length + BUILT_TESTS.length);
  say("characters in the command", command?.length ?? 0);

  console.log("\n6. A hold: the values it prints, and that it ends when it should (tried on stand-ins: no gateway, no Kiro program)");
  await holdCheck(places, (program, args) => [inside(CREW_GATEWAY_SANDBOX_PROFILE, gateway, workspace, tmpDir, program, args), inside(KIRO_CLI_SANDBOX_PROFILE, kiroCli, workspace, tmpDir, program, args)]);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(path.join(places.paths.built, "hardening-proof-check"), { recursive: true, force: true });
}

// ---------- the throwaway gateway ----------

let gatewayChild: ChildProcess | null = null;
let gatewayNote: ({ pid: number } & Sighting) | null = null;
function stopGateway(): void {
  const child = gatewayChild;
  gatewayChild = null;
  if (child?.pid === undefined) return;
  // Its whole group: the gateway starts helpers of its own.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      break;
    }
    spawnSync("/bin/sleep", [signal === "SIGTERM" ? "3" : "0"]);
  }
  if (gatewayNote !== null) gatewayNote.to = Date.now();
  gatewayNote = null;
}

/**
 * Stop signals. The first one ends what is running the careful way: jobs are cancelled and
 * removed, the gateway is stopped, the watcher ends whatever is left. A second one stops at
 * once: the gateway is killed here, and the watcher, finding this script gone, ends the rest.
 * While a hold waits, one signal comes before those two: it ends the hold, which is how a hold
 * is meant to be ended, and the script goes on to stop the gateway and to its last step.
 */
let stopCode = 130;
/** Set while a hold waits. A stop signal then ends the hold, not the script: the gateway is stopped and the last step still runs. */
let holdWaiting: AbortController | null = null;
function listenForStopSignals(): void {
  // The gateway must never outlive this script, however it ends.
  process.once("exit", stopGateway);
  let signals = 0;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (holdWaiting !== null && !holdWaiting.signal.aborted) {
        console.error("\nEnding the hold: the gateway is stopped, then macOS's log is read. (Once more to stop before that is done.)");
        holdWaiting.abort();
        return;
      }
      signals += 1;
      stopCode = code;
      if (signals === 1) {
        console.error("\nStopping: ending what is running and removing this script's jobs. (Once more to stop at once.)");
        stopNow.abort();
        return;
      }
      stopGateway();
      process.exit(code);
    });
  }
}

function crewEnvironment(places: Places): Record<string, string> {
  return {
    HOME,
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${places.nodeBin}:${path.join(HOME, ".local", "bin")}`,
    TMPDIR: buildTmpDir(places.paths) ?? "",
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    KIRO_HOME: places.kiroHome,
    KIROCREW_HOME: places.crewHome,
    KIROCREW_PORT: String(places.port),
  };
}

/**
 * The Kiro programs. `kirocrew` is the name the nightly build starts (a link in ~/.local/bin);
 * `kirocrewReal` is the program behind it, which is what the gateway's background job is given.
 */
interface Tools {
  kirocrew: string;
  kirocrewReal: string;
  kiro: string;
}

/** Get the throwaway Kiro home ready, outside any sandbox: the files a first run makes, the one Kiro Crew setting, the skill. */
function prepareThrowawayHome(places: Places, { kirocrewReal: kirocrew, kiro }: Tools): void {
  // The folders a job may fill but not make (the installer makes the same ones in the real Kiro home).
  for (const dir of [places.crewHome, path.join(places.kiroHome, "agents"), path.join(places.kiroHome, "sessions"), path.join(places.kiroHome, "settings")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Kiro CLI makes settings/cli.json and its lock file the first time it runs, even to read a
  // setting, and cannot make them later from inside the sandbox (friction log F-052).
  const setting = (args: string[]): string => {
    const result = spawnSync(kiro, ["settings", ...args], { cwd: places.kiroHome, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { HOME, PATH: "/usr/bin:/bin", KIRO_HOME: places.kiroHome, NO_COLOR: "1" } });
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
  };
  setting(["telemetry.enabled"]);
  // A new Kiro home has Kiro's two content-sharing switches at their default, which is on, and
  // asking for one that was never set is an error (friction log F-027). The builder sends nothing
  // to Kiro until both read "false", and neither does this script: they are switched off here,
  // in the throwaway home only (the command is the README's own), and read back. Only "false" or
  // not is looked at.
  for (const key of PRIVACY_SETTINGS) {
    if (!/^false(\s+\(\w+\))?$/.test(setting([key]))) setting([key, "false"]);
    expectStep(`the throwaway Kiro home has ${key} switched off`, /^false(\s+\(\w+\))?$/.test(setting([key])));
  }
  // Kiro Crew refuses to run a job inside a sandbox it did not make unless this is set. It is set
  // in the throwaway home only: KIROCREW_HOME was checked against the real one before this point.
  // (Not set again when an earlier run of this script already did.)
  if (crewSettingsProblem(places.crewHome, "overnight") !== null) spawnSync(kirocrew, ["config", "set", "agent.sandbox_allow_unsandboxed_exec", "true"], { cwd: places.kiroHome, timeout: 60_000, stdio: "ignore", env: crewEnvironment(places) });
  // Read back from the throwaway home itself, the way the builder reads it before every build:
  // a kirocrew that had not gone by KIROCREW_HOME would leave nothing here, and the proof stops.
  expectStep("the throwaway Kiro Crew home is set to run inside our sandbox", crewSettingsProblem(places.crewHome, "overnight") === null);
  const skill = installedSkillFile(places.crewHome);
  mkdirSync(path.dirname(skill), { recursive: true, mode: 0o700 });
  copyFileSync(BUILD_SKILL_FILE, skill);
}

async function startGateway(places: Places, profileFile: string, kirocrew: string): Promise<void> {
  checkpoint();
  if (await gatewayAnswers(places.port)) throw new Refused(`A Kiro Crew gateway already answers on port ${places.port}. This script only talks to a gateway it started itself: stop that one, or use another port.`);
  if (await portTaken(places.port)) throw new Refused(`Something is already listening on port ${places.port}. Use another port.`);
  const log = openSync(path.join(places.paths.logs, "hardening-gateway.log"), "a", 0o600);
  // The same command line the installer writes for the gateway's background job.
  const child = spawn(SANDBOX_EXEC, ["-f", profileFile, ...gatewayDefines(profileFile, places), kirocrew, "gateway", "--no-open", "--no-tunnel"], {
    cwd: places.paths.workspaces,
    env: crewEnvironment(places),
    stdio: ["ignore", log, log],
    detached: true,
  });
  closeSync(log);
  gatewayChild = child;
  if (child.pid !== undefined) {
    gatewayNote = { pid: child.pid, from: Date.now(), to: null };
    thisRun.started.push(gatewayNote);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    checkpoint();
    // Still running when it answers: the answer is this gateway's, not somebody else's.
    if (child.exitCode === null && child.signalCode === null && (await gatewayAnswers(places.port, stopNow.signal))) return;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(500);
  }
  checkpoint();
  throw new ProofFailed("the throwaway gateway did not answer within 90 seconds (what it printed is in <data>/logs/hardening-gateway.log; it is Kiro Crew's own output, so read it there and paste it nowhere)");
}

function crewClient(places: Places, profileFile: string, { kirocrew }: Tools, logger: Logger): CrewClient {
  return createCrewClient({
    binary: kirocrew,
    crewHome: places.crewHome,
    crewHomeIsExplicit: true,
    run: createCommandRunner(),
    logger,
    now: () => new Date(),
    sleep: abortableSleep,
    pollMs: 1_000,
    tmpDir: buildTmpDir(places.paths) ?? "",
    // Our own kirocrew commands run inside the same profile as the gateway, as the nightly build's do.
    sandbox: { exec: SANDBOX_EXEC, profile: profileFile, defines: gatewayDefines(profileFile, places) },
  });
}

function isRunning(places: Places, jobId: string): boolean {
  try {
    return readdirSync(path.join(places.crewHome, "cron-running")).some((name) => name.startsWith(`${jobId}.`));
  } catch {
    return false;
  }
}

/** One of Kiro's settings, asked inside the Kiro CLI copy. Only the shape of the answer is looked at. */
function askSetting(places: Places, workspace: string, kiro: string, key: string): { exitCode: number | null; answer: string } {
  const tmpDir = kiroCliTmpDir(buildTmpDir(places.paths) ?? "") ?? "";
  const parts = { profile: places.profiles.kiroCli, defines: kiroCliDefines(places.profiles.kiroCli, places, workspace), kiroBinary: realPath(kiro) ?? kiro };
  // The builder's own arguments and environment. Started here and not through the builder's
  // runner so that its process number is known: it can be gone before the watcher has looked once.
  const asked = startInside(sandboxedSettingArgs(parts, key), { cwd: realPath(workspace) ?? workspace, env: { HOME, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${places.nodeBin}`, TMPDIR: tmpDir, NO_COLOR: "1" }, keepOutput: true, timeoutMs: 30_000 });
  return { exitCode: asked.status, answer: asked.stdout.trim() };
}

/**
 * A throwaway gateway that answers. The first step of p1, and all of a hold's start: both call
 * this, so a hold's gateway is p1's gateway. In this order: the throwaway Kiro home is made ready
 * and its settings are read back; the copies of the profiles are written; the watcher starts;
 * the "before" canaries are made and must be in macOS's log; only then is the gateway started,
 * inside the gateway copy, with the values the installer gives the real one.
 */
async function throwawayGatewayUp(places: Places, tools: Tools): Promise<void> {
  prepareThrowawayHome(places, tools);
  writeProfileCopies(places);
  startWatcher(places);
  canaries(places, "before");
  await proveLastStepCanWork(places);
  note("starting the gateway; it has 90 seconds to answer");
  await startGateway(places, places.profiles.gateway, tools.kirocrewReal);
  expectStep("the gateway answers", true);
}

// ---------- P1: zero credits ----------

async function proofOne(places: Places, logger: Logger, tools: Tools): Promise<void> {
  const { kiro } = tools;
  const config = parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, BUILD_SANDBOX: "overnight", PAUSED: "true" });
  const overrides = { crewHome: places.crewHome, kiroHome: places.kiroHome };
  const deps = { config, paths: places.paths, logger, signal: stopNow.signal };

  console.log("\nP1.1 The throwaway gateway, inside the shipped profile (plus the report lines)");
  await throwawayGatewayUp(places, tools);

  console.log("\nP1.2 The nightly sandbox check, through the builder's own code");
  note("one job on the gateway, which tries fourteen things; usually under a minute");
  const passed = await standaloneSandboxProbe(deps, { ...overrides, sandboxProfile: places.profiles.gateway });
  checkpoint();
  expectStep("it passes", passed.ok, passed.ok ? "yes" : passed.reason);

  console.log("\nP1.3 One command job: added, started, cancelled and removed by Overnight's own kirocrew commands");
  const crew = crewClient(places, places.profiles.gateway, tools, logger);
  const added = await crew.addJob(`${BUILD_JOB_PREFIX}hardening-proof-command`, "", ["--cron", NEVER_DUE_CRON, "--timezone", config.timeZone, "--command", "/bin/sleep 120", "--timeout", "150", "--timeout-secs", "180", "--no-persistent-session", "--minimal-context"], stopNow.signal);
  checkpoint();
  expectStep("added", added.ok, added.ok ? "yes" : added.reason);
  if (!added.ok) return;
  let mayBeRunning = false;
  let removed: boolean;
  try {
    const triggered = await crew.trigger(added.id, stopNow.signal);
    mayBeRunning = true;
    checkpoint();
    expectStep("started", triggered.ok, triggered.ok ? "yes" : triggered.reason);
    if (!triggered.ok) return;
    for (let waited = 0; waited < 30 && !isRunning(places, added.id); waited += 1) {
      checkpoint();
      await sleep(1_000);
    }
    expectStep("seen running", isRunning(places, added.id));
    expectStep("cancelled when asked", await crew.cancel(added.id));
    const ended = await crew.waitUntilFinished(added.id, triggered.triggeredAtMs, Date.now() + 30_000, stopNow.signal);
    checkpoint();
    expectStep("its run is over, and Kiro Crew's own record says cancelled", ended.finished && ended.status === "cancelled", ended.finished ? ended.status : "still running");
    expectStep("nothing of it is left running", !isRunning(places, added.id));
    mayBeRunning = false;
  } finally {
    // Always, and without hiding an earlier failure behind this one. A run that may still be
    // going is cancelled first: removing a job does not end its run.
    if (mayBeRunning) await crew.cancel(added.id).catch(() => false);
    removed = await crew.remove(added.id, { quick: stopNow.signal.aborted }).catch(() => false);
    say("removed", removed ? "yes" : "NO");
  }
  if (!removed) throw new ProofFailed("the command job could not be removed");

  console.log("\nP1.4 Kiro CLI answers a settings question inside its own profile (Kiro CLI's real home: it is only read)");
  checkpoint();
  const workspace = path.join(places.paths.workspaces, "hardening-proof-cli");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const asked = askSetting(places, workspace, kiro, "telemetry.enabled");
  // "true (global)" or "false (global)", exit code 0.
  expectStep("it answers true or false", asked.exitCode === 0 && /^(true|false)(\s+\(\w+\))?$/.test(asked.answer), `exit code ${asked.exitCode}`);

  console.log("\nP1.5 The control: the same check against a gateway inside a loosened copy");
  stopGateway();
  note("starting the gateway again, inside the loosened copy");
  await startGateway(places, places.profiles.gatewayLoosened, tools.kirocrewReal);
  const loose = await standaloneSandboxProbe(deps, { ...overrides, sandboxProfile: places.profiles.gatewayLoosened });
  checkpoint();
  expectStep("it fails, and names the one thing that was opened", !loose.ok && loose.reason === `the build sandbox check failed: ${BUILT_TESTS[0].said}`, loose.ok ? "it PASSED" : loose.reason);
  stopGateway();

  console.log("\nP1.6 What the sandbox decided for this run's own programs during all of the above (counts by program, kind and target shape)");
  await lastStep(places);
}

// ---------- P2: about half a Kiro credit ----------

const ONE_LINE = (file: string): string => `Write the single word done into a new file at ${file} and then stop. Do nothing else.`;
const wroteDone = (file: string): boolean => existsSync(file) && /^\s*done\s*$/i.test(readFileSync(file, "utf8").slice(0, 100));

async function proofTwo(places: Places, logger: Logger, tools: Tools): Promise<void> {
  const { kiro } = tools;
  const run = createCommandRunner();

  // Everything that can stop the proof and costs nothing comes first.
  console.log("\nP2.0 Before anything is spent");
  prepareThrowawayHome(places, tools);
  writeProfileCopies(places);
  startWatcher(places);
  canaries(places, "before");
  await proveLastStepCanWork(places);
  note("asking Kiro who is signed in; a sign-in with under 10 minutes left is waited out and renewed, as before every build");
  const signIn = await createKiroSignInRenewal({ logger })(stopNow.signal);
  checkpoint();
  expectStep("Kiro is signed in (asked outside the sandbox)", signIn.ok, signIn.ok ? "yes" : signIn.reason);
  const workspace = path.join(places.paths.workspaces, "hardening-proof-cli");
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const real = realPath(workspace) ?? workspace;
  // The builder's own rule: nothing is sent until both content-sharing settings read "false".
  for (const key of PRIVACY_SETTINGS) {
    checkpoint();
    const setting = askSetting(places, workspace, kiro, key);
    expectStep(`Kiro's setting ${key} is off`, setting.exitCode === 0 && /^false(\s+\(\w+\))?$/.test(setting.answer));
  }
  const tmpDir = kiroCliTmpDir(buildTmpDir(places.paths) ?? "") ?? "";
  const env = { HOME, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${places.nodeBin}`, TMPDIR: tmpDir, NO_COLOR: "1" };
  const parts = { profile: places.profiles.kiroCli, defines: kiroCliDefines(places.profiles.kiroCli, places, workspace), kiroBinary: realPath(kiro) ?? kiro };
  console.log("\nP2.1 One one-line Kiro CLI chat inside the Kiro CLI profile (about 0.01 credit; it runs in Kiro CLI's real home, as every fallback build does)");
  note("the chat has 5 minutes");
  const started = Date.now();
  // Through the builder's own runner: it ends the chat, and everything the chat started, when this script is stopped or the time is up.
  const chat = await run(SANDBOX_EXEC, sandboxedKiroArgs({ ...parts, prompt: ONE_LINE(path.join(real, "proof.txt")) }), { cwd: real, env, timeoutMs: 5 * 60_000, signal: stopNow.signal });
  checkpoint();
  say("seconds", Math.round((Date.now() - started) / 1000));
  expectStep("Kiro CLI wrote the file", wroteDone(path.join(real, "proof.txt")), chat.timedOut ? "ran past 5 minutes" : `exit code ${chat.exitCode}`);

  console.log("\nP2.2 One one-line Kiro Crew agent job on the throwaway gateway (about 0.5 credit)");
  note("starting the gateway; it has 90 seconds to answer");
  await startGateway(places, places.profiles.gateway, tools.kirocrewReal);
  const config = parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, BUILD_SANDBOX: "overnight", PAUSED: "true" });
  const crew = crewClient(places, places.profiles.gateway, tools, logger);
  const agentSpace = path.join(places.paths.workspaces, "hardening-proof-agent");
  rmSync(agentSpace, { recursive: true, force: true });
  mkdirSync(agentSpace, { recursive: true, mode: 0o700 });
  const target = path.join(realPath(agentSpace) ?? agentSpace, "proof.txt");
  const added = await crew.addJob(`${BUILD_JOB_PREFIX}hardening-proof-agent`, ONE_LINE(target), ["--cron", NEVER_DUE_CRON, "--timezone", config.timeZone, "--approval-mode", "auto", "--no-persistent-session", "--timeout-secs", "300"], stopNow.signal);
  checkpoint();
  expectStep("added", added.ok, added.ok ? "yes" : added.reason);
  if (!added.ok) return;
  let mayBeRunning = false;
  let removed: boolean;
  try {
    const triggered = await crew.trigger(added.id, stopNow.signal);
    mayBeRunning = true;
    checkpoint();
    expectStep("started", triggered.ok, triggered.ok ? "yes" : triggered.reason);
    if (!triggered.ok) return;
    note("the agent has 6 minutes");
    const ended = await crew.waitUntilFinished(added.id, triggered.triggeredAtMs, triggered.triggeredAtMs + 6 * 60_000, stopNow.signal);
    mayBeRunning = !ended.finished;
    checkpoint();
    say("seconds", Math.round((Date.now() - triggered.triggeredAtMs) / 1000));
    expectStep("its run ended by itself", ended.finished, ended.finished ? ended.status : "still running after 6 minutes");
    expectStep("the agent wrote the file", wroteDone(target));
    say("Kiro credits Kiro Crew recorded for it", crew.creditsFor(added.id, [new Date(triggered.triggeredAtMs), new Date()]) ?? "none recorded");
  } finally {
    if (mayBeRunning) await crew.cancel(added.id).catch(() => false);
    removed = await crew.remove(added.id, { quick: stopNow.signal.aborted }).catch(() => false);
    say("removed", removed ? "yes" : "NO");
    stopGateway();
  }
  if (!removed) throw new ProofFailed("the agent job could not be removed");

  console.log("\nP2.3 What the sandbox decided for this run's own programs during both (counts by program, kind and target shape)");
  await lastStep(places);
}

// ---------- hold: a throwaway gateway that stays up while a rehearsal builds through it ----------

/**
 * The longest a hold stays up. The watcher follows macOS's log for two hours at most (its
 * `log stream --timeout 2h`), and the last step needs it listening to the end. A rehearsal's
 * build has 45 minutes unless BUILD_TIMEOUT_MIN says otherwise.
 */
export const HOLD_LIMIT_MS = 100 * 60_000;
/** Between two looks at the things that end a hold. */
const HOLD_LOOK_EVERY_MS = 500;

/**
 * The file whose appearing ends a hold. It sits in the scratch data folder itself, which both
 * profiles close to every job (the check tries it): a build cannot end the hold it runs in.
 */
export function holdStopFile(dataDir: string): string {
  return path.join(dataDir, "hold.stop");
}

/** What a rehearsal must be given to build through the held gateway, in the order it is printed. */
export function holdEnvironment(places: { dataDir: string; kiroHome: string; crewHome: string; port: number }): Array<[name: string, value: string]> {
  return [
    ["OVERNIGHT_DATA_DIR", places.dataDir],
    ["KIRO_HOME", places.kiroHome],
    ["KIROCREW_HOME", places.crewHome],
    ["KIROCREW_PORT", String(places.port)],
  ];
}

/**
 * A value as one word of a shell command line. A folder in the home folder is written with
 * "$HOME" inside double quotes, so it is a full path wherever the line is pasted and the
 * account's name is not printed. Not with "~": a shell leaves that as it is inside quotes and
 * after `env`, and the builder takes a Kiro folder that is not a full path for none at all, and
 * then uses the real one.
 */
export function shellWord(value: string, home: string = HOME): string {
  const plain = /^[A-Za-z0-9_.,:@%+/-]*$/;
  if (value.startsWith(home + path.sep) && /^[A-Za-z0-9_.,:@%+/ -]*$/.test(value.slice(home.length))) return `"$HOME${value.slice(home.length)}"`;
  if (value !== "" && plain.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The values as the start of one command line: NAME=value NAME=value ... */
export function holdEnvironmentLine(environment: ReadonlyArray<readonly [name: string, value: string]>, home: string = HOME): string {
  return environment.map(([name, value]) => `${name}=${shellWord(value, home)}`).join(" ");
}

/** A time of the night, in minutes after midnight, as "00:45". */
const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * What a hold prints once its gateway answers: the values for the rehearsal, how to end the hold,
 * and when it ends by itself. `environment` is holdEnvironmentLine's; `limitAt` is a time of day.
 */
export function holdInstructions(parts: { environment: string; stopFile: string; limitAt: string; home?: string }): string[] {
  return [
    "Give a rehearsal exactly these four values, on one line with its command, in another shell in this repo:",
    `  ${parts.environment}`,
    "For example:",
    `  ${parts.environment} npx overnight rehearse run <ideaId> --no-publish`,
    `Leave one out and a rehearsal goes to the real thing: without KIROCREW_PORT to the gateway that builds every night (port ${DEFAULT_GATEWAY_PORT}), without KIROCREW_HOME or KIRO_HOME to Kiro's real folders. (Without OVERNIGHT_DATA_DIR it does not start.)`,
    "To end the hold: Ctrl-C in this window, or a stop signal, or from any shell (no process number is needed):",
    `  touch ${shellWord(parts.stopFile, parts.home)}`,
    `It also ends by itself: at ${parts.limitAt} (${HOLD_LIMIT_MS / 60_000} minutes from now), when the hours of the night's build or delivery begin (${QUIET_WINDOWS.map(([from]) => hhmm(from)).join(" and ")}), and when the gateway or the watcher is gone.`,
    "However it ends, the gateway and everything it started are stopped, and then macOS's log is read for the whole time it was up.",
  ];
}

/** Why a hold ended. */
export type HoldEnd = "gateway-gone" | "watcher-gone" | "asked" | "stop-file" | "quiet-hours" | "time-limit";

export const HOLD_END_WORDS: Record<HoldEnd, string> = {
  "gateway-gone": "the gateway ended by itself",
  "watcher-gone": "the watcher was gone, and without it nothing notes this run's programs or ends what they leave behind",
  asked: "it was asked to end (Ctrl-C or a stop signal)",
  "stop-file": "the file hold.stop appeared",
  "quiet-hours": "the hours kept free for the night's build or delivery began",
  "time-limit": `it had been up for ${HOLD_LIMIT_MS / 60_000} minutes, which is as long as a hold stays up`,
};

/** One look at the things that end a hold. */
export interface HoldLook {
  gatewayRunning: boolean;
  watcherRunning: boolean;
  /** Ctrl-C or a stop signal came. */
  asked: boolean;
  /** The stop file is there. */
  stopFile: boolean;
  /** It is one of the hours kept free for the night's build or delivery. */
  quietHours: boolean;
  /** Since the gateway first answered. */
  upForMs: number;
}

/**
 * Why a hold ends at this look, or null while it goes on. What went wrong comes before what was
 * asked for: a gateway that ended by itself is not hidden by a stop file made a moment later.
 */
export function holdEnd(look: HoldLook, limitMs: number = HOLD_LIMIT_MS): HoldEnd | null {
  if (!look.gatewayRunning) return "gateway-gone";
  if (!look.watcherRunning) return "watcher-gone";
  if (look.asked) return "asked";
  if (look.stopFile) return "stop-file";
  if (look.quietHours) return "quiet-hours";
  if (look.upForMs >= limitMs) return "time-limit";
  return null;
}

/** Look, and look again after a pause, until something ends the hold. `pause` may end early (a stop signal cuts it short). */
export async function waitForHoldEnd(parts: { look: () => HoldLook; pause: (ms: number) => Promise<void>; limitMs?: number; everyMs?: number; stillUp?: (look: HoldLook) => void }): Promise<HoldEnd> {
  for (;;) {
    const look = parts.look();
    const end = holdEnd(look, parts.limitMs);
    if (end !== null) return end;
    parts.stillUp?.(look);
    await parts.pause(parts.everyMs ?? HOLD_LOOK_EVERY_MS);
  }
}

/** As much of a child process as a hold looks at. */
type Child = Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;
const childRunning = (child: Child | null): boolean => child !== null && child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/** Is anything there under this name? A link that points nowhere counts: something made it. */
function isThere(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Remove a file of this script's own. True when nothing is there afterwards. */
function removeFile(file: string): boolean {
  try {
    rmSync(file, { force: true });
  } catch {
    // a folder, or not ours to remove
  }
  return !isThere(file);
}

/** What a hold watches while it waits. */
export interface Held {
  stopFile: string;
  gateway: Child | null;
  watcher: Child | null;
  /** When the gateway first answered, in milliseconds. */
  sinceMs: number;
  timeZone: string;
}

/** One look at a hold: its two processes, the stop file and the clock. */
export function lookAtHold(held: Held, asked: boolean, nowMs: number = Date.now()): HoldLook {
  return {
    gatewayRunning: childRunning(held.gateway),
    watcherRunning: childRunning(held.watcher),
    asked,
    stopFile: isThere(held.stopFile),
    quietHours: inQuietHours(new Date(nowMs), held.timeZone),
    upForMs: nowMs - held.sinceMs,
  };
}

/**
 * Wait until something ends the hold. While this waits, the first stop signal ends the hold and
 * not the script (see listenForStopSignals). `nowMs` is the check's: it tries this at a made-up
 * time of day.
 */
async function waitHeld(held: Held, options: { limitMs?: number; nowMs?: () => number; stillUp?: (look: HoldLook) => void } = {}): Promise<HoldEnd> {
  const asked = new AbortController();
  const either = AbortSignal.any([asked.signal, stopNow.signal]);
  holdWaiting = asked;
  try {
    return await waitForHoldEnd({ look: () => lookAtHold(held, either.aborted, options.nowMs?.() ?? Date.now()), pause: (ms) => abortableSleep(ms, either), limitMs: options.limitMs, stillUp: options.stillUp });
  } finally {
    holdWaiting = null;
  }
}

const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

async function proofHold(places: Places, tools: Tools): Promise<void> {
  const stopFile = holdStopFile(places.paths.root);
  // One left by an earlier hold would end this one the moment it waits.
  const stale = isThere(stopFile);
  if (!removeFile(stopFile)) throw new Refused(`${tilde(stopFile)} is in the way and could not be removed. A hold ends when a file of that name appears, so it cannot start while one is there.`);

  console.log("\nH.1 The throwaway gateway, inside the shipped profile (plus the report lines), started as p1 starts it");
  if (stale) note("a hold.stop file left by an earlier hold was removed");
  await throwawayGatewayUp(places, tools);
  const held: Held = { stopFile, gateway: gatewayChild, watcher: watcherChild, sinceMs: Date.now(), timeZone: parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, PAUSED: "true" }).timeZone };

  console.log("\nH.2 The gateway is up, and stays up until the hold is ended");
  const environment = holdEnvironmentLine(holdEnvironment({ dataDir: places.paths.root, kiroHome: places.kiroHome, crewHome: places.crewHome, port: places.port }));
  for (const line of holdInstructions({ environment, stopFile, limitAt: clockTime(held.sinceMs + HOLD_LIMIT_MS) })) console.log(`  ${line}`);
  note(`waiting since ${clockTime(held.sinceMs)}; what the gateway prints goes to <data>/logs/hardening-gateway.log`);
  let tens = 0;
  const end = await waitHeld(held, {
    stillUp: (look) => {
      if (Math.floor(look.upForMs / 600_000) <= tens) return;
      tens = Math.floor(look.upForMs / 600_000);
      note(`up for ${tens * 10} minutes`);
    },
  });
  checkpoint();

  console.log(`\nH.3 The hold is over: ${HOLD_END_WORDS[end]}`);
  const upMs = Date.now() - held.sinceMs;
  say("the gateway was up for", upMs < 120_000 ? `${Math.round(upMs / 1000)} seconds` : `${Math.round(upMs / 60_000)} minutes`);
  say("it still answered at the end", childRunning(gatewayChild) && (await gatewayAnswers(places.port, stopNow.signal)) ? "yes" : "NO");
  checkpoint();
  stopGateway();
  removeFile(stopFile);

  console.log("\nH.4 What the sandbox decided for the gateway and everything it started, over the whole time it was up (counts by program, kind and target shape)");
  const judgement = await judgeRun(places, "reading macOS's log for the whole time; ten seconds after a short hold, a minute or two after a long one");
  // The watcher has ended by now, and with it whatever the gateway left behind.
  const taken = await portTaken(places.port);
  say(`nothing listens on port ${places.port} any more`, taken ? "NO" : "yes");
  if (judgement.verdict !== "pass") throw new ProofFailed(judgement.why);
  if (taken) throw new ProofFailed(`something still listens on port ${places.port} after the gateway was stopped`);
  if (end === "gateway-gone") throw new ProofFailed("the throwaway gateway ended by itself while it was held (what it printed is in <data>/logs/hardening-gateway.log; it is Kiro Crew's own output, so read it there and paste it nowhere)");
}

/**
 * The check's last step: a hold's own parts, tried for real on stand-ins (two `sleep`s for the
 * gateway and the watcher). No gateway and no Kiro program is started. `inBothSandboxes` runs
 * one harmless command inside each shipped profile and answers its two exit codes.
 */
async function holdCheck(places: Places, inBothSandboxes: (command: string, args: string[]) => Array<number | null>): Promise<void> {
  const stopFile = holdStopFile(places.paths.root);
  expectStep("no stop file is in the way", removeFile(stopFile));

  // The line a hold prints, pasted into a shell as a person or an agent would paste it.
  const wanted = holdEnvironment({ dataDir: places.paths.root, kiroHome: places.kiroHome, crewHome: places.crewHome, port: places.port });
  const line = holdEnvironmentLine(wanted);
  const pasted = (shell: string, flags: string[]): Record<string, string> => {
    const result = spawnSync(shell, [...flags, "-c", `${line} /usr/bin/env`], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { HOME: homedir(), PATH: "/usr/bin:/bin" } });
    const got: Record<string, string> = {};
    for (const row of (typeof result.stdout === "string" ? result.stdout : "").split("\n")) if (row.includes("=")) got[row.slice(0, row.indexOf("="))] = row.slice(row.indexOf("=") + 1);
    return got;
  };
  const sameFolder = (a: string | undefined, b: string): boolean => a !== undefined && path.isAbsolute(a) && realPathAllowMissing(a) !== null && realPathAllowMissing(a) === realPathAllowMissing(b);
  const shells = [pasted("/bin/sh", []), pasted("/bin/zsh", ["-f"]), pasted("/bin/bash", ["--noprofile", "--norc"])];
  expectStep(
    "its four values, pasted into sh, zsh and bash: full paths and the port",
    shells.every((got) => wanted.every(([name, value]) => (name === "KIROCREW_PORT" ? got[name] === value : sameFolder(got[name], value)))),
  );
  // And read the way a rehearsal's builder reads them: the throwaway gateway, and nothing real.
  const read = shells.map((got) => ({ dataDir: parseConfig({ OVERNIGHT_DATA_DIR: got.OVERNIGHT_DATA_DIR, PAUSED: "true" }).dataDir, kiroHome: defaultKiroHome(got), crewHome: defaultCrewHome(got), port: gatewayPort(got) }));
  expectStep(
    "the builder's own code reads them as the scratch folders and this port",
    read.every((got) => sameFolder(got.dataDir, places.paths.root) && sameFolder(got.kiroHome, places.kiroHome) && sameFolder(got.crewHome, places.crewHome) && got.port === places.port && got.port !== DEFAULT_GATEWAY_PORT && !overlaps(got.dataDir, REAL_DATA_DIR) && !overlaps(got.kiroHome, REAL_KIRO_HOME) && !overlaps(got.crewHome, REAL_KIRO_HOME)),
  );
  const refused = inBothSandboxes("/usr/bin/touch", [stopFile]);
  expectStep("a job inside either sandbox cannot make the file that ends a hold", refused.length === 2 && refused.every((status) => status !== 0) && !isThere(stopFile));

  // The waiting itself, at a made-up time of day (noon in Boise): the check may be run at night.
  const timeZone = parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, PAUSED: "true" }).timeZone;
  const standIns: ChildProcess[] = [];
  const standIn = (): ChildProcess => {
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    standIns.push(child);
    return child;
  };
  const later = (command: string, argument: string): void => void standIns.push(spawn("/bin/sh", ["-c", command, argument], { stdio: "ignore" }));
  /** One wait on fresh stand-ins, from `startsAt` on the made-up clock. Answers why it ended and after how long. */
  const tryHold = async (during: (gateway: ChildProcess, watcher: ChildProcess) => void, options: { startsAt?: string; limitMs?: number } = {}): Promise<{ end: HoldEnd; ms: number }> => {
    checkpoint();
    const [gateway, watcher] = [standIn(), standIn()];
    const [began, madeUp] = [Date.now(), Date.parse(options.startsAt ?? "2026-10-12T12:00:00-06:00")];
    during(gateway, watcher);
    const end = await waitHeld({ stopFile, gateway, watcher, sinceMs: madeUp, timeZone }, { nowMs: () => madeUp + (Date.now() - began), limitMs: options.limitMs });
    for (const child of [gateway, watcher]) child.kill("SIGKILL");
    return { end, ms: Date.now() - began };
  };
  const shown = (tried: { end: HoldEnd; ms: number }): string => `${tried.end}, after ${(tried.ms / 1000).toFixed(1)} seconds`;
  try {
    const byFile = await tryHold(() => later('sleep 1; : > "$0"', stopFile));
    expectStep("it waits, and ends when another program makes the stop file", byFile.end === "stop-file" && byFile.ms >= 900 && byFile.ms < 5_000, shown(byFile));
    expectStep("the stop file can be removed again", removeFile(stopFile));
    const gatewayGone = await tryHold((gateway) => void setTimeout(() => gateway.kill("SIGKILL"), 400));
    expectStep("it ends when the gateway's stand-in is gone", gatewayGone.end === "gateway-gone" && gatewayGone.ms >= 300 && gatewayGone.ms < 5_000, shown(gatewayGone));
    const watcherGone = await tryHold((_, watcher) => void setTimeout(() => watcher.kill("SIGKILL"), 400));
    expectStep("it ends when the watcher's stand-in is gone", watcherGone.end === "watcher-gone" && watcherGone.ms >= 300 && watcherGone.ms < 5_000, shown(watcherGone));
    const timeUp = await tryHold(() => {}, { limitMs: 700 });
    expectStep("it ends when its time is up (here: 0.7 seconds)", timeUp.end === "time-limit" && timeUp.ms >= 700 && timeUp.ms < 5_000, shown(timeUp));
    const night = await tryHold(() => {}, { startsAt: "2026-10-12T00:44:59.200-06:00" });
    expectStep("it ends when the hours of the night's build begin (a made-up 00:45)", night.end === "quiet-hours" && night.ms >= 500 && night.ms < 5_000, shown(night));
    note("sending this script a stop signal, as Ctrl-C or `kill` would; the next line is what a hold then prints");
    const asked = await tryHold(() => later('sleep 0.5; kill -TERM "$0"', String(process.pid)));
    expectStep("a stop signal ends the hold, and the script goes on to its last step", asked.end === "asked" && asked.ms >= 400 && asked.ms < 5_000 && !stopNow.signal.aborted, shown(asked));
  } finally {
    for (const child of standIns) child.kill("SIGKILL");
    removeFile(stopFile);
  }
}

// ---------- start ----------

/** The modes, in the order they are run. Each one's last lines name the next. */
export const PROOF_ORDER = ["check", "p1", "p2 --spend-credits", "hold"] as const;

/** What is run after `mode` ("p2 --spend-credits" after "p1"), or null after the last. */
export function nextInOrder(mode: string): string | null {
  const at = PROOF_ORDER.findIndex((entry) => entry.split(" ")[0] === mode);
  return at === -1 ? null : (PROOF_ORDER[at + 1] ?? null);
}

/** The command for the next proof, with the folders this run was given. */
function nextCommand(places: Places, mode: string): string {
  return `OVERNIGHT_DATA_DIR=${tilde(places.paths.root)} KIRO_HOME=${tilde(places.kiroHome)} KIROCREW_PORT=${places.port} node spikes/11-hardening-proof.ts ${mode}`;
}

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "check";
  if (!PROOF_ORDER.some((entry) => entry.split(" ")[0] === mode)) throw new Refused(`Usage: node spikes/11-hardening-proof.ts ${PROOF_ORDER.join(" | ")}   (in that order; see the top of the file)`);
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) throw new Refused("This needs macOS and /usr/bin/sandbox-exec.");

  // Every refusal comes before anything is made or started.
  const dataProblem = dataDirProblem(process.env.OVERNIGHT_DATA_DIR);
  if (dataProblem !== null) throw new Refused(dataProblem);
  const gatewayNeeded = mode !== "check";
  // The check needs no Kiro home and no port: it only puts their names into the profiles' values.
  const kiroHome = process.env.KIRO_HOME ?? (gatewayNeeded ? undefined : path.join(HOME, ".kiro-hardening"));
  const kiroProblem = kiroHomeProblem(kiroHome);
  if (kiroProblem !== null || kiroHome === undefined) throw new Refused(kiroProblem ?? "KIRO_HOME is not set.");
  const dataDir = path.resolve(process.env.OVERNIGHT_DATA_DIR ?? "");
  const together = twoFoldersProblem(dataDir, kiroHome);
  if (together !== null) throw new Refused(together);
  const crewHome = path.join(kiroHome, "crew");
  if (process.env.KIROCREW_HOME !== undefined && path.resolve(process.env.KIROCREW_HOME) !== crewHome) throw new Refused("KIROCREW_HOME is set to something other than <KIRO_HOME>/crew. Leave it out: this script sets it.");
  const rawPort = process.env.KIROCREW_PORT ?? (gatewayNeeded ? undefined : "5478");
  const wrongPort = portProblem(rawPort);
  if (wrongPort !== null) throw new Refused(wrongPort);
  let tools: Tools | null = null;
  if (gatewayNeeded) {
    if (inQuietHours(new Date(), parseConfig({ OVERNIGHT_DATA_DIR: dataDir, PAUSED: "true" }).timeZone)) throw new Refused("It is too close to the night's build (1:00 am) or delivery (6:30 am). Run this in the daytime.");
    if (mode === "p2" && !process.argv.includes("--spend-credits")) throw new Refused("p2 uses about half a Kiro credit. Say so with: p2 --spend-credits");
    const kirocrewReal = realPath(defaultKirocrewBinary());
    const kiro = findKiroBinary();
    if (kirocrewReal === null || kiro === null) throw new Refused("kirocrew or kiro-cli was not found.");
    tools = { kirocrew: defaultKirocrewBinary(), kirocrewReal, kiro };
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const paths = dataPaths(realpathSync(dataDir));
  ensureDataDirs(paths);
  const sandboxDir = path.join(paths.root, "sandbox");
  const places: Places = {
    paths,
    profiles: { gateway: path.join(sandboxDir, "hardening-proof-gateway.sb"), gatewayLoosened: path.join(sandboxDir, "hardening-proof-gateway-loosened.sb"), kiroCli: path.join(sandboxDir, "hardening-proof-kiro-cli.sb") },
    kiroHome,
    crewHome,
    port: Number(rawPort),
    nodeBin: path.dirname(realpathSync(process.execPath)),
    word: newRunWord(),
  };
  // Lines with ids, states and our own reasons, in the scratch folder's own log. Nothing is printed from them.
  const logFile = path.join(paths.logs, "hardening-proof.log");
  const logger = createLogger({ name: "hardening-proof", minLevel: "info", write: (line) => appendFileSync(logFile, `${line}\n`, { mode: 0o600 }) });
  thisRun.since = new Date(Date.now() - 1000);
  listenForStopSignals();

  console.log(`Spike 11, ${mode}. Scratch data folder: ${tilde(paths.root)}`);
  if (tools === null) {
    await selfCheck(places);
    console.log("\nDone: check passed. No gateway was started, no Kiro program was run, no Kiro credits were used.");
    console.log(`Left behind: the scratch data folder ${tilde(paths.root)} (this script's copies of the profiles and its own log). Nothing is left running.`);
    console.log(`Next, in the daytime and with no build or delivery of the real Overnight going (no Kiro credits):\n  ${nextCommand(places, "p1")}`);
    return 0;
  }

  mkdirSync(kiroHome, { recursive: true, mode: 0o700 });
  // What our own kirocrew commands (packages/builder/src/crew-client.ts) read to find the gateway.
  Object.assign(process.env, { KIRO_HOME: kiroHome, KIROCREW_HOME: crewHome, KIROCREW_PORT: String(places.port) });
  try {
    if (mode === "p1") await proofOne(places, logger, tools);
    else if (mode === "p2") await proofTwo(places, logger, tools);
    else await proofHold(places, tools);
  } finally {
    stopGateway();
  }
  checkpoint();
  const spent: Record<string, string> = { p1: "Nothing was published, and no Kiro credits were used.", p2: "Nothing was published.", hold: "This script published nothing and used no Kiro credits itself; a build that went through the gateway used its own." };
  console.log(`\nDone: ${mode} passed. ${spent[mode] ?? ""}`);
  console.log(`Left behind: the scratch data folder ${tilde(paths.root)} and the throwaway Kiro home ${tilde(kiroHome)}; remove both by hand when the proofs are over. Nothing is left running.`);
  console.log(`Outside those two, what any build leaves: ${mode === "p2" ? "what the one-line chat saved in Kiro CLI's own folders, and " : ""}what a Kiro Crew gateway keeps in ~/.kiro/crew-auth-staging and ~/workplace/kirocrew-workspace${mode === "hold" ? ", and whatever the rehearsal left of its own" : ""}.`);
  const next = nextInOrder(mode);
  if (next === null) console.log("Next: write the counts above, and the rehearsal's own last lines, into docs/spikes.md.");
  else if (mode === "p1") console.log(`Next (about half a Kiro credit):\n  ${nextCommand(places, next)}`);
  else console.log(`Next: write the counts above into docs/spikes.md. Then, for the third step of the proof (a rehearsal build through a gateway that stays up; no Kiro credits of its own):\n  ${nextCommand(places, next)}`);
  return 0;
}

/** Whatever happened: the gateway is stopped, and the watcher ends what is left and then itself. */
async function windDown(): Promise<void> {
  stopGateway();
  await stopWatcher();
}

// Only when run as a program: the tests of this script's own tools import it.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().then(
    async (code) => {
      await windDown();
      process.exit(code);
    },
    async (error: unknown) => {
      await windDown();
      if (stopNow.signal.aborted) console.error("\nStopped before the end, as asked. What was running was ended; nothing was proved. It is safe to run again.");
      else if (error instanceof Refused) console.error(`Not started: ${error.message}`);
      else if (error instanceof ProofFailed) console.error(`\nSTOPPED at the first failure: ${error.message}\nThe gateway (if one was started) was stopped and nothing is left running. This script's own lines are in <data>/logs/hardening-proof.log. It is safe to run again.`);
      else console.error(`\nStopped on an unexpected error: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : "unknown"}`);
      process.exit(stopNow.signal.aborted ? stopCode : error instanceof Refused ? 2 : 1);
    },
  );
}
