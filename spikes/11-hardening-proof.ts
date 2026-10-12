// Everything this spike makes is synthetic: invented folders, files and one-line jobs in a scratch data folder. None of it is Bee data.
//
// Spike 11: do the builder's two sandbox profiles, as they ship, still let Kiro Crew and Kiro CLI
// do their work? And what do those two really connect to while they do it?
//
// Why it matters: the profiles close other programs' socket files and the dashboard's port
// (Milestone 3). What Kiro Crew and Kiro CLI need at run time was never measured, so the rules
// are proved here, on a throwaway gateway, before they reach the gateway that builds every night.
//
// Usage (every value is needed; nothing has a default that could point at the real install):
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening node spikes/11-hardening-proof.ts check
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p1
//   OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p2 --spend-credits
//
//   check   No gateway, no Kiro program, no Kiro credits. Checks this script's own tools: that it
//           refuses the real folders and the real port, that the profiles and the copies it makes
//           of them load, that its extra lines change no decision, and that it can read what the
//           sandbox decided out of macOS's log.
//   p1      No Kiro credits. Starts a throwaway Kiro Crew gateway inside the gateway profile and
//           runs: the nightly sandbox check (it must pass, and fail by name on a loosened copy);
//           one command job added, started, cancelled and removed by the builder's own code; one
//           `kiro-cli settings` question inside the Kiro CLI profile.
//   p2      About half a Kiro credit. One one-line `kiro-cli chat` inside the Kiro CLI profile,
//           and one one-line Kiro Crew agent job, each of which writes one file. Our own words only.
//
// What it never does: it never uses ~/.overnight, ~/.kiro/crew or port 5476 (it refuses them,
// whatever spelling they are given in); it installs, loads and stops no background job, so there
// is no job name to get wrong (the gateway is this script's own child and ends with it); it
// publishes nothing; it does not use Bee itself (the nightly check, in p1, tries Bee from inside
// the sandbox, as it does every night); it changes no setting of Kiro CLI's, and none of Kiro
// Crew's outside the throwaway home. p1 and p2 refuse to run near the night's build and delivery.
//
// The gateway runs inside a COPY of the shipped profile with a few lines added that report and
// refuse nothing: `(allow ... (with report))` puts each use of a socket file, a local port or the
// process table in macOS's log without changing what is allowed. Every later rule of the profile
// still has the last word, so the decisions are the shipped file's.
//
// It prints yes/no, counts, and what the sandbox decided as counts by program, kind of thing and
// the SHAPE of the target (the home folder as "~", numbers as "N"). Never a raw log line, never
// anything a program printed. Results go in docs/spikes.md.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger, DASHBOARD_PORT, dataPaths, ensureDataDirs, parseConfig } from "@overnight/core";
import type { DataPaths, Logger } from "@overnight/core";
import { abortableSleep, BUILD_JOB_PREFIX, createCrewClient, DEFAULT_GATEWAY_PORT, defaultKirocrewBinary, gatewayAnswers, NEVER_DUE_CRON } from "../packages/builder/src/crew-client.ts";
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

const say = (label: string, value: unknown): void => console.log(`  ${label.padEnd(74)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Why a folder cannot be this run's scratch data folder, or null when it can. */
export function dataDirProblem(folder: string | undefined, realDataDir: string = REAL_DATA_DIR, home: string = HOME): string | null {
  if (folder === undefined || folder.trim() === "") return "OVERNIGHT_DATA_DIR is not set. Name a scratch folder of your own, for example ~/.overnight-hardening.";
  if (!path.isAbsolute(folder)) return "OVERNIGHT_DATA_DIR must be a full path.";
  if (overlaps(folder, realDataDir)) return "OVERNIGHT_DATA_DIR is the real data folder, or inside it, or above it. This script only works on a scratch folder.";
  // Both profiles close the shared temporary folders and Claude Code's scratch folders, so a build could not even see its own workspace there.
  const real = realPathAllowMissing(folder) ?? path.resolve(folder);
  if (!(real === home || real.startsWith(home + path.sep)) || real === home) return "OVERNIGHT_DATA_DIR must be a folder of its own inside the home folder: the sandbox closes the temporary folders.";
  return null;
}

/** Why a folder cannot be this run's throwaway Kiro home, or null when it can. */
export function kiroHomeProblem(folder: string | undefined, realKiroHome: string = REAL_KIRO_HOME): string | null {
  if (folder === undefined || folder.trim() === "") return "KIRO_HOME is not set. Name a throwaway folder, for example ~/.kiro-hardening.";
  if (!path.isAbsolute(folder)) return "KIRO_HOME must be a full path.";
  if (overlaps(folder, realKiroHome)) return "KIRO_HOME is Kiro's real folder, or inside it, or above it. Kiro Crew's real home is never used here.";
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

// ---------- the profiles and the copies made of them ----------

/** Added right after "(allow default)". They allow what was allowed anyway, and say so in macOS's log. */
const REPORT_LINES = [
  ";; Added by spikes/11-hardening-proof.ts, for the proof only: these lines report and refuse nothing.",
  '(allow network-outbound (remote unix-socket (path-regex #"^/")) (with report))',
  '(allow network-outbound (remote ip "localhost:*") (with report))',
  '(allow network-bind (local ip "localhost:*") (with report))',
  '(allow sysctl-read (sysctl-name-prefix "kern.proc.") (with report))',
];

/** The shipped profile's text with the report lines added. Throws when the text is not shaped like one of ours. */
export function withReportLines(profileText: string): string {
  const marker = "(version 1)\n(allow default)\n";
  if (profileText.split(marker).length !== 2) throw new Error("The profile does not begin the way ours do, so the report lines were not added.");
  return profileText.replace(marker, `${marker}${REPORT_LINES.join("\n")}\n`);
}

interface Places {
  paths: DataPaths;
  /** <data>/sandbox: where the copies of the profiles are kept, as the installer keeps the gateway's. */
  profiles: { gateway: string; gatewayLoosened: string; kiroCli: string };
  kiroHome: string;
  crewHome: string;
  port: number;
  nodeBin: string;
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
  const gateway = readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8");
  writeFileSync(places.profiles.gateway, withReportLines(gateway), { mode: 0o600 });
  // The control: the same copy with ONE thing opened again, the list of finished builds in the
  // scratch data folder. Nothing real is opened by it.
  writeFileSync(places.profiles.gatewayLoosened, `${withReportLines(gateway)}\n(allow file-read* (subpath (string-append (param "DATA_DIR") "/built")))\n`, { mode: 0o600 });
  writeFileSync(places.profiles.kiroCli, withReportLines(readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8")), { mode: 0o600 });
}

// ---------- what the sandbox decided, out of macOS's log ----------

interface Decision {
  program: string;
  verdict: "allow" | "deny";
  operation: string;
  target: string;
}

/** `log show` wants the Mac's own local time. */
function logTime(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** One line of macOS's log as a decision, or null: "... Sandbox: nc(4242) deny(1) network-outbound /a/b.sock". */
export function parseDecision(line: string): Decision | null {
  const match = /Sandbox: (.+?)\(\d+\) (allow|deny)(?:\(\d+\))? ([a-z0-9*-]+) (.+)$/.exec(line);
  if (match === null) return null;
  return { program: match[1] ?? "", verdict: match[2] === "allow" ? "allow" : "deny", operation: match[3] ?? "", target: (match[4] ?? "").trim() };
}

/** Every sandbox decision macOS logged since `since`, for every program on this Mac. Never printed as it is. */
function readDecisions(since: Date): Decision[] | null {
  const result = spawnSync("/usr/bin/log", ["show", "--start", logTime(since), "--style", "compact", "--predicate", 'eventMessage BEGINSWITH "Sandbox: "'], { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\n").flatMap((line) => parseDecision(line) ?? []);
}

/** Programs a gateway, a build or this script's own checks start. Any other program's name is not printed. */
const OUR_PROGRAMS = /^(python[0-9.]*|Python|kirocrew|kiro-cli(-chat|-term)?|node|npm|npx|sh|bash|zsh|nc|ls|cat|touch|rm|wc|mkdir|sleep|security|pgrep|bee-copy|perl|git|esbuild|chrome-headless-shell|chrome_crashpad_handler|sandbox-exec|true|date|tar|curl)$/;
/** The kinds of decision the profiles' new rules are about. A refusal of anything else is counted in one line. */
const WATCHED = /^(network-outbound|network-bind|network-inbound|sysctl-read|mach-lookup)$/;

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

/** Counts by program, verdict, kind of thing and target shape. Programs that are not ours are one line with no name. */
export function countDecisions(decisions: Decision[], places: Parameters<typeof targetShape>[1]): Array<{ what: string; count: number }> {
  const counts = new Map<string, number>();
  const add = (what: string): void => void counts.set(what, (counts.get(what) ?? 0) + 1);
  for (const decision of decisions) {
    if (!OUR_PROGRAMS.test(decision.program)) add("another program on this Mac (not looked at)");
    else if (!WATCHED.test(decision.operation)) add(`${decision.program}: ${decision.verdict} ${decision.operation} (targets not listed)`);
    else add(`${decision.program}: ${decision.verdict} ${decision.operation} ${targetShape(decision.target, places)}`);
  }
  return [...counts.entries()].map(([what, count]) => ({ what, count })).sort((a, b) => a.what.localeCompare(b.what));
}

function printDecisions(since: Date, places: Places): Decision[] {
  // The log is written a moment after the fact.
  spawnSync("/bin/sleep", ["2"]);
  const decisions = readDecisions(since);
  if (decisions === null) {
    say("macOS's log", "could not be read (/usr/bin/log show failed)");
    return [];
  }
  for (const { what, count } of countDecisions(decisions, { dataDir: places.paths.root, kiroHome: places.kiroHome, crewHome: places.crewHome })) say(`  ${what}`, count);
  return decisions.filter((decision) => OUR_PROGRAMS.test(decision.program));
}

/** Refusals of a socket file by one of our programs: the thing the proof must not find. */
function socketRefusals(decisions: Decision[]): number {
  return decisions.filter((decision) => decision.verdict === "deny" && decision.operation === "network-outbound" && decision.target.startsWith("/")).length;
}

// ---------- small tools ----------

function expectStep(label: string, ok: boolean, detail: unknown = ok ? "yes" : "NO"): void {
  say(label, detail);
  if (!ok) throw new ProofFailed(label);
}

/** Run one harmless program inside a profile. Only its exit code is looked at. */
function inside(profileFile: string, defines: string[], cwd: string, tmpDir: string, command: string, args: string[]): number | null {
  return spawnSync(SANDBOX_EXEC, ["-f", profileFile, ...defines, command, ...args], { cwd, timeout: 20_000, stdio: "ignore", env: { HOME, PATH: "/usr/bin:/bin", TMPDIR: tmpDir } }).status;
}

/** A listener on a socket file, outside any sandbox, for as long as a check needs it. Reached by a short relative name: a full path can pass the 104 bytes a socket name may have. */
function listenOn(dir: string, name: string): ChildProcess {
  rmSync(path.join(dir, name), { force: true });
  return spawn("/usr/bin/nc", ["-lkU", name], { cwd: dir, stdio: "ignore" });
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
  expectStep("a throwaway Kiro home beside the real one is accepted", kiroHomeProblem(path.join(HOME, ".kiro-hardening")) === null);
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

  // "Did not work" is not always the sandbox: nothing listens on port 9, and maybe nothing on the
  // dashboard's. What is checked here is only that the copy answers as the shipped file does.
  console.log("\n3. The report lines change no decision (shipped profile and copy, side by side)");
  const since = new Date(Date.now() - 1000);
  // A listener in a folder a job may write (the build's temporary folder) and one where it may not (the data folder itself).
  const listeners = [listenOn(tmpDir, "proof-open.sock"), listenOn(places.paths.root, "proof-closed.sock")];
  await sleep(500);
  try {
    const sealed = path.join(places.paths.built, "hardening-proof-check", "index.html");
    const questions: Array<[string, string, string[], string]> = [
      ["read the brief in the workspace", "/bin/cat", [path.join(workspace, "brief.md")], workspace],
      ["read a finished build", "/bin/cat", [sealed], workspace],
      ["list the finished builds", "/bin/ls", [places.paths.built], workspace],
      ["make a file among the finished builds", "/usr/bin/touch", [path.join(places.paths.built, "planted.txt")], workspace],
      ["connect to a socket file in the build's temporary folder", "/usr/bin/nc", ["-U", "proof-open.sock"], tmpDir],
      ["connect to a socket file in a folder that is closed to it", "/usr/bin/nc", ["-U", "proof-closed.sock"], places.paths.root],
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
        const [a, b] = [inside(shipped, defines, cwd, tmpDir, command, args), inside(copy, defines, cwd, tmpDir, command, args)];
        expectStep(`${label}: ${question}`, a === b, a === b ? (a === 0 ? "worked in both" : "did not work in either") : `DIFFERENT: shipped ${a}, copy ${b}`);
      }
    }
    expectStep("nothing was left among the finished builds", !existsSync(path.join(places.paths.built, "planted.txt")));
  } finally {
    for (const listener of listeners) listener.kill("SIGKILL");
    rmSync(path.join(tmpDir, "proof-open.sock"), { force: true });
    rmSync(path.join(places.paths.root, "proof-closed.sock"), { force: true });
  }

  console.log("\n4. What the sandbox decided, read back out of macOS's log (counts by program, kind and target shape)");
  const ours = printDecisions(since, places);
  expectStep("the copy's report lines showed up in the log", ours.some((decision) => decision.verdict === "allow" && decision.operation === "network-outbound"));
  say("refusals of a socket file by our own programs (the closed one above, if the profile closes it)", socketRefusals(ours));
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
  rmSync(workspace, { recursive: true, force: true });
  rmSync(path.join(places.paths.built, "hardening-proof-check"), { recursive: true, force: true });
}

// ---------- the throwaway gateway ----------

let gatewayChild: ChildProcess | null = null;
function stopGateway(): void {
  const child = gatewayChild;
  gatewayChild = null;
  if (child?.pid === undefined) return;
  // Its whole group: the gateway starts helpers of its own.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      return;
    }
    spawnSync("/bin/sleep", [signal === "SIGTERM" ? "3" : "0"]);
  }
}
/** The gateway must never outlive this script: not at its end, and not when it is interrupted. */
function stopGatewayWithThisScript(): void {
  process.once("exit", stopGateway);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
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
  // setting, and cannot make them later from inside the sandbox (friction log F-052). This only reads.
  spawnSync(kiro, ["settings", "telemetry.enabled"], { cwd: places.kiroHome, timeout: 30_000, stdio: "ignore", env: { HOME, PATH: "/usr/bin:/bin", KIRO_HOME: places.kiroHome, NO_COLOR: "1" } });
  // Kiro Crew refuses to run a job inside a sandbox it did not make unless this is set. It is set
  // in the throwaway home only: KIROCREW_HOME was checked against the real one before this point.
  spawnSync(kirocrew, ["config", "set", "agent.sandbox_allow_unsandboxed_exec", "true"], { cwd: places.kiroHome, timeout: 60_000, stdio: "ignore", env: crewEnvironment(places) });
  // Read back from the throwaway home itself, the way the builder reads it before every build:
  // a kirocrew that had not gone by KIROCREW_HOME would leave nothing here, and the proof stops.
  expectStep("the throwaway Kiro Crew home is set to run inside our sandbox", crewSettingsProblem(places.crewHome, "overnight") === null);
  const skill = installedSkillFile(places.crewHome);
  mkdirSync(path.dirname(skill), { recursive: true, mode: 0o700 });
  copyFileSync(BUILD_SKILL_FILE, skill);
}

async function startGateway(places: Places, profileFile: string, kirocrew: string): Promise<void> {
  if (await gatewayAnswers(places.port)) throw new Refused(`Something already answers on port ${places.port}. This script only talks to a gateway it started itself: stop that one, or use another port.`);
  const log = openSync(path.join(places.paths.logs, "hardening-gateway.log"), "a", 0o600);
  // The same command line the installer writes for the gateway's background job.
  gatewayChild = spawn(SANDBOX_EXEC, ["-f", profileFile, ...gatewayDefines(profileFile, places), kirocrew, "gateway", "--no-open", "--no-tunnel"], {
    cwd: places.paths.workspaces,
    env: crewEnvironment(places),
    stdio: ["ignore", log, log],
    detached: true,
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await gatewayAnswers(places.port)) return;
    if (gatewayChild.exitCode !== null) break;
    await sleep(500);
  }
  throw new ProofFailed("the throwaway gateway did not answer within 90 seconds (what it printed is in <data>/logs/hardening-gateway.log)");
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

// ---------- P1: zero credits ----------

async function proofOne(places: Places, logger: Logger, tools: Tools): Promise<void> {
  const { kiro } = tools;
  const config = parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, BUILD_SANDBOX: "overnight", PAUSED: "true" });
  const since = new Date(Date.now() - 1000);
  const overrides = { crewHome: places.crewHome, kiroHome: places.kiroHome };

  console.log("\nP1.1 The throwaway gateway, inside the shipped profile (plus the report lines)");
  prepareThrowawayHome(places, tools);
  writeProfileCopies(places);
  await startGateway(places, places.profiles.gateway, tools.kirocrewReal);
  expectStep("the gateway answers", true);

  console.log("\nP1.2 The nightly sandbox check, through the builder's own code");
  const passed = await standaloneSandboxProbe({ config, paths: places.paths, logger }, { ...overrides, sandboxProfile: places.profiles.gateway });
  expectStep("it passes", passed.ok, passed.ok ? "yes" : passed.reason);

  console.log("\nP1.3 One command job: added, started, cancelled and removed by Overnight's own kirocrew commands");
  const crew = crewClient(places, places.profiles.gateway, tools, logger);
  const added = await crew.addJob(`${BUILD_JOB_PREFIX}hardening-proof-command`, "", ["--cron", NEVER_DUE_CRON, "--timezone", config.timeZone, "--command", "/bin/sleep 120", "--timeout", "150", "--timeout-secs", "180", "--no-persistent-session", "--minimal-context"]);
  expectStep("added", added.ok, added.ok ? "yes" : added.reason);
  if (!added.ok) return;
  let removed: boolean;
  try {
    const triggered = await crew.trigger(added.id);
    expectStep("started", triggered.ok, triggered.ok ? "yes" : triggered.reason);
    if (!triggered.ok) return;
    for (let waited = 0; waited < 30 && !isRunning(places, added.id); waited += 1) await sleep(1_000);
    expectStep("seen running", isRunning(places, added.id));
    expectStep("cancelled when asked", await crew.cancel(added.id));
    const ended = await crew.waitUntilFinished(added.id, triggered.triggeredAtMs, Date.now() + 30_000);
    expectStep("its run is over, and Kiro Crew's own record says cancelled", ended.finished && ended.status === "cancelled", ended.finished ? ended.status : "still running");
    expectStep("nothing of it is left running", !isRunning(places, added.id));
  } finally {
    // Always, and without hiding an earlier failure behind this one.
    removed = await crew.remove(added.id).catch(() => false);
    say("removed", removed ? "yes" : "NO");
  }
  if (!removed) throw new ProofFailed("the command job could not be removed");

  console.log("\nP1.4 Kiro CLI answers a settings question inside its own profile");
  const workspace = path.join(places.paths.workspaces, "hardening-proof-cli");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const tmpDir = kiroCliTmpDir(buildTmpDir(places.paths) ?? "") ?? "";
  const parts = { profile: places.profiles.kiroCli, defines: kiroCliDefines(places.profiles.kiroCli, places, workspace), kiroBinary: realPath(kiro) ?? kiro };
  const asked = await createCommandRunner()(SANDBOX_EXEC, sandboxedSettingArgs(parts, "telemetry.enabled"), { cwd: realPath(workspace) ?? workspace, env: { HOME, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${places.nodeBin}`, TMPDIR: tmpDir, NO_COLOR: "1" }, timeoutMs: 30_000 });
  // "true (global)" or "false (global)", exit code 0. Only the shape of the answer is looked at.
  expectStep("it answers true or false", asked.exitCode === 0 && /^(true|false)(\s+\(\w+\))?$/.test(asked.stdout.trim()), asked.error !== undefined ? "could not be started" : `exit code ${asked.exitCode}`);

  console.log("\nP1.5 The control: the same check against a gateway inside a loosened copy");
  stopGateway();
  await startGateway(places, places.profiles.gatewayLoosened, tools.kirocrewReal);
  const loose = await standaloneSandboxProbe({ config, paths: places.paths, logger }, { ...overrides, sandboxProfile: places.profiles.gatewayLoosened });
  expectStep("it fails, and names the one thing that was opened", !loose.ok && loose.reason === `the build sandbox check failed: ${BUILT_TESTS[0].said}`, loose.ok ? "it PASSED" : loose.reason);
  stopGateway();

  console.log("\nP1.6 What the sandbox decided during all of the above (counts by program, kind and target shape)");
  const ours = printDecisions(since, places);
  expectStep("no socket file was refused to one of our programs", socketRefusals(ours) === 0, socketRefusals(ours));
}

// ---------- P2: about half a Kiro credit ----------

const ONE_LINE = (file: string): string => `Write the single word done into a new file at ${file} and then stop. Do nothing else.`;
const wroteDone = (file: string): boolean => existsSync(file) && /^\s*done\s*$/i.test(readFileSync(file, "utf8").slice(0, 100));

async function proofTwo(places: Places, logger: Logger, tools: Tools): Promise<void> {
  const { kiro } = tools;
  const since = new Date(Date.now() - 1000);
  const run = createCommandRunner();

  console.log("\nP2.1 One one-line Kiro CLI chat inside the Kiro CLI profile (about 0.01 credit)");
  writeProfileCopies(places);
  const signIn = await createKiroSignInRenewal({ logger })();
  expectStep("Kiro is signed in (asked outside the sandbox)", signIn.ok, signIn.ok ? "yes" : signIn.reason);
  const workspace = path.join(places.paths.workspaces, "hardening-proof-cli");
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const real = realPath(workspace) ?? workspace;
  const tmpDir = kiroCliTmpDir(buildTmpDir(places.paths) ?? "") ?? "";
  const env = { HOME, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${places.nodeBin}`, TMPDIR: tmpDir, NO_COLOR: "1" };
  const parts = { profile: places.profiles.kiroCli, defines: kiroCliDefines(places.profiles.kiroCli, places, workspace), kiroBinary: realPath(kiro) ?? kiro };
  // The builder's own rule: nothing is sent until both content-sharing settings read "false".
  for (const key of PRIVACY_SETTINGS) {
    const setting = await run(SANDBOX_EXEC, sandboxedSettingArgs(parts, key), { cwd: real, env, timeoutMs: 30_000 });
    expectStep(`Kiro's setting ${key} is off`, setting.exitCode === 0 && /^false(\s+\(\w+\))?$/.test(setting.stdout.trim()));
  }
  const started = Date.now();
  const chat = await run(SANDBOX_EXEC, sandboxedKiroArgs({ ...parts, prompt: ONE_LINE(path.join(real, "proof.txt")) }), { cwd: real, env, timeoutMs: 5 * 60_000 });
  say("seconds", Math.round((Date.now() - started) / 1000));
  expectStep("Kiro CLI wrote the file", wroteDone(path.join(real, "proof.txt")), chat.timedOut ? "ran past 5 minutes" : `exit code ${chat.exitCode}`);

  console.log("\nP2.2 One one-line Kiro Crew agent job on the throwaway gateway (about 0.5 credit)");
  prepareThrowawayHome(places, tools);
  await startGateway(places, places.profiles.gateway, tools.kirocrewReal);
  const config = parseConfig({ OVERNIGHT_DATA_DIR: places.paths.root, BUILD_SANDBOX: "overnight", PAUSED: "true" });
  const crew = crewClient(places, places.profiles.gateway, tools, logger);
  const agentSpace = path.join(places.paths.workspaces, "hardening-proof-agent");
  rmSync(agentSpace, { recursive: true, force: true });
  mkdirSync(agentSpace, { recursive: true, mode: 0o700 });
  const target = path.join(realPath(agentSpace) ?? agentSpace, "proof.txt");
  const added = await crew.addJob(`${BUILD_JOB_PREFIX}hardening-proof-agent`, ONE_LINE(target), ["--cron", NEVER_DUE_CRON, "--timezone", config.timeZone, "--approval-mode", "auto", "--no-persistent-session", "--timeout-secs", "300"]);
  expectStep("added", added.ok, added.ok ? "yes" : added.reason);
  if (!added.ok) return;
  let mayBeRunning = false;
  let removed: boolean;
  try {
    const triggered = await crew.trigger(added.id);
    expectStep("started", triggered.ok, triggered.ok ? "yes" : triggered.reason);
    if (!triggered.ok) return;
    mayBeRunning = true;
    const ended = await crew.waitUntilFinished(added.id, triggered.triggeredAtMs, triggered.triggeredAtMs + 6 * 60_000);
    mayBeRunning = !ended.finished;
    say("seconds", Math.round((Date.now() - triggered.triggeredAtMs) / 1000));
    expectStep("its run ended by itself", ended.finished, ended.finished ? ended.status : "still running after 6 minutes");
    expectStep("the agent wrote the file", wroteDone(target));
    say("Kiro credits Kiro Crew recorded for it", crew.creditsFor(added.id, [new Date(triggered.triggeredAtMs), new Date()]) ?? "none recorded");
  } finally {
    if (mayBeRunning) await crew.cancel(added.id).catch(() => false);
    removed = await crew.remove(added.id).catch(() => false);
    say("removed", removed ? "yes" : "NO");
    stopGateway();
  }
  if (!removed) throw new ProofFailed("the agent job could not be removed");

  console.log("\nP2.3 What the sandbox decided during both (counts by program, kind and target shape)");
  const ours = printDecisions(since, places);
  expectStep("no socket file was refused to one of our programs", socketRefusals(ours) === 0, socketRefusals(ours));
}

// ---------- start ----------

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "check";
  if (!["check", "p1", "p2"].includes(mode)) throw new Refused("Usage: node spikes/11-hardening-proof.ts check | p1 | p2 --spend-credits   (see the top of the file)");
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) throw new Refused("This needs macOS and /usr/bin/sandbox-exec.");

  const dataProblem = dataDirProblem(process.env.OVERNIGHT_DATA_DIR);
  if (dataProblem !== null) throw new Refused(dataProblem);
  const gatewayNeeded = mode !== "check";
  // The check needs no Kiro home and no port: it only puts their names into the profiles' values.
  const kiroHome = process.env.KIRO_HOME ?? (gatewayNeeded ? undefined : path.join(HOME, ".kiro-hardening"));
  const kiroProblem = kiroHomeProblem(kiroHome);
  if (kiroProblem !== null || kiroHome === undefined) throw new Refused(kiroProblem ?? "KIRO_HOME is not set.");
  const crewHome = path.join(kiroHome, "crew");
  if (process.env.KIROCREW_HOME !== undefined && path.resolve(process.env.KIROCREW_HOME) !== crewHome) throw new Refused("KIROCREW_HOME is set to something other than <KIRO_HOME>/crew. Leave it out: this script sets it.");
  const rawPort = process.env.KIROCREW_PORT ?? (gatewayNeeded ? undefined : "5478");
  const wrongPort = portProblem(rawPort);
  if (wrongPort !== null) throw new Refused(wrongPort);

  const dataDir = path.resolve(process.env.OVERNIGHT_DATA_DIR ?? "");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const paths = dataPaths(realpathSync(dataDir));
  ensureDataDirs(paths);
  const places: Places = {
    paths,
    profiles: { gateway: path.join(paths.root, "sandbox", "crew-gateway.sb"), gatewayLoosened: path.join(paths.root, "sandbox", "crew-gateway-loosened.sb"), kiroCli: path.join(paths.root, "sandbox", "kiro-cli-build.sb") },
    kiroHome,
    crewHome,
    port: Number(rawPort),
    nodeBin: path.dirname(realpathSync(process.execPath)),
  };
  // Lines with ids, states and our own reasons, in the scratch folder's own log. Nothing is printed from them.
  const logFile = path.join(paths.logs, "hardening-proof.log");
  const logger = createLogger({ name: "hardening-proof", minLevel: "info", write: (line) => appendFileSync(logFile, `${line}\n`, { mode: 0o600 }) });

  console.log(`Spike 11, ${mode}. Scratch data folder: ${paths.root.replace(HOME, "~")}`);
  if (mode === "check") {
    await selfCheck(places);
    console.log("\nDone: no gateway was started, no Kiro program was run, no Kiro credits were used.");
    return 0;
  }

  const config = parseConfig({ OVERNIGHT_DATA_DIR: paths.root, PAUSED: "true" });
  if (inQuietHours(new Date(), config.timeZone)) throw new Refused("It is too close to the night's build (1:00 am) or delivery (6:30 am). Run this in the daytime.");
  if (mode === "p2" && !process.argv.includes("--spend-credits")) throw new Refused("p2 uses about half a Kiro credit. Say so with: p2 --spend-credits");
  const kirocrewReal = realPath(defaultKirocrewBinary());
  const kiro = findKiroBinary();
  if (kirocrewReal === null || kiro === null) throw new Refused("kirocrew or kiro-cli was not found.");
  const tools: Tools = { kirocrew: defaultKirocrewBinary(), kirocrewReal, kiro };
  mkdirSync(kiroHome, { recursive: true, mode: 0o700 });
  stopGatewayWithThisScript();
  // What our own kirocrew commands (packages/builder/src/crew-client.ts) read to find the gateway.
  Object.assign(process.env, { KIRO_HOME: kiroHome, KIROCREW_HOME: crewHome, KIROCREW_PORT: String(places.port) });
  try {
    if (mode === "p1") await proofOne(places, logger, tools);
    else await proofTwo(places, logger, tools);
  } finally {
    stopGateway();
  }
  console.log(`\nDone: ${mode} passed. Nothing was published, and nothing outside the scratch folders was changed.`);
  return 0;
}

// Only when run as a program: the tests of this script's own tools import it.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      stopGateway();
      if (error instanceof Refused) console.error(`Not started: ${error.message}`);
      else if (error instanceof ProofFailed) console.error(`\nSTOPPED at the first failure: ${error.message}`);
      else console.error(`\nStopped on an unexpected error: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : "unknown"}`);
      process.exit(error instanceof Refused ? 2 : 1);
    },
  );
}
