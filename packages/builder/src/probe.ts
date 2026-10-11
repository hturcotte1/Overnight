// The sandbox check, used only when BUILD_SANDBOX is "overnight" (the Kiro Crew gateway runs
// inside our own sandbox and Crew's own is off). Before the night's first Crew build, one
// zero-credit Kiro Crew "command" job tries, from where a build agent would run:
//   reading  1. the Keychain entry that holds the GitHub login,
//            2. Bee as the logged-in user, with a copy of the Bee program that a job CAN run,
//            3. the transcript database,
//            4. listing three folders in the home folder: Documents, Library (every other
//               program's own data) and .claude (Claude Code's session records),
//            5. the command line of another program: a stand-in we start ourselves, outside
//               the sandbox, for as long as the check runs;
//   writing  6. a new file in each place our own programs are run from, or started from, outside
//               the sandbox: the home folder, this repo, the folder node is in, the folder
//               Kiro Crew's program is in, and the folder macOS reads background jobs from.
// The job writes only byte counts, line counts and 0/1 marks into <data>/tmp/build-probe/. Every
// count must be 0 (or empty) and every mark 0. If anything is reachable, or the check cannot be
// completed within 3 minutes, no Crew build runs.
//
// What it does not try: listing the home folder itself. Kiro Crew will not start an agent unless
// it can open every folder above its own, so the names directly inside the home folder can be
// listed by a job (see section 3 of sandbox/crew-gateway.sb). What is behind those names cannot,
// and that is what 4 checks.
//
// The command line is our own fixed text with full paths: Crew refuses commands that use shell
// variables or command substitution, and the forms below are the ones the experiments ran.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DataPaths, Logger } from "@overnight/core";
import { NEVER_DUE_CRON, PROBE_JOB_NAME } from "./crew-client.ts";
import type { CrewClient } from "./crew-client.ts";
import { REPO_ROOT } from "./crew-files.ts";
import { readSmallText } from "./safe-read.ts";

export const PROBE_TIMEOUT_MS = 3 * 60_000;
export const SANDBOX_CHECK_FAILED = "the build sandbox check failed";
/** The command's own limit, and the job's (which must leave Crew a few seconds to clean up). */
const COMMAND_TIMEOUT_SECS = 90;
const JOB_TIMEOUT_SECS = 120;
/** The file each write test tries to make. It is removed at once if making it worked. */
export const WRITE_TEST_FILE = "overnight-sandbox-probe-write-test";

export const PROBE_FILES = { keychain: "keychain.txt", bee: "bee.txt", database: "database.txt", processes: "processes.txt", finished: "finished.txt" } as const;
/** The name the copy of the Bee program gets in the results folder, for as long as the check runs. */
export const BEE_COPY = "bee-copy";
/**
 * The stand-in for "another program": a harmless process of ours, outside the sandbox, with this
 * word on its command line. The job looks for it with `pgrep -f`. The pattern it is given spells
 * the last letter as "[y]", so the pattern does not match the job's own command line.
 */
export const DECOY_MARK = "overnight-sandbox-probe-decoy";
export const DECOY_PATTERN = "overnight-sandbox-probe-deco[y]";
/** How long the stand-in lives if nobody ends it: longer than the check can take. */
const DECOY_SECONDS = 240;
/** One result file per folder in the home folder that a job must not be able to list. */
export const LIST_TESTS = [
  { key: "documents", file: "list-documents.txt", folder: "Documents", said: "a job can list the Documents folder" },
  { key: "library", file: "list-library.txt", folder: "Library", said: "a job can list the Library folder (other programs' data)" },
  { key: "claude", file: "list-claude.txt", folder: ".claude", said: "a job can list Claude Code's session records" },
] as const;
export type ListTestKey = (typeof LIST_TESTS)[number]["key"];
/** One result file per place a job must not be able to write. */
export const WRITE_TESTS = [
  { key: "home", file: "write-home.txt", said: "a job can write in the home folder" },
  { key: "repo", file: "write-repo.txt", said: "a job can write in this repo" },
  { key: "node", file: "write-node.txt", said: "a job can write where node is installed" },
  { key: "kirocrew", file: "write-kirocrew.txt", said: "a job can write where Kiro Crew is installed" },
  { key: "launchAgents", file: "write-launch-agents.txt", said: "a job can write in the background-jobs folder" },
] as const;
export type WriteTestKey = (typeof WRITE_TESTS)[number]["key"];

/** The folders our own unsandboxed programs are run from. `launchAgents` is worked out from `home`. */
export interface ProtectedDirs {
  home: string;
  repo: string;
  node: string;
  kirocrew: string;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export function probeDir(paths: DataPaths): string {
  return path.join(paths.root, "tmp", "build-probe");
}

/** The Bee program that ships in this repo's node_modules. */
export function defaultBeeBinary(): string {
  return path.join(REPO_ROOT, "node_modules", "@beeai", "cli", "dist", "platforms", "mac-arm64", "bee");
}

/** A path as one shell word, or null if it holds a character we will not put on a command line. */
function shellWord(file: string): string | null {
  if (!path.isAbsolute(file)) return null;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(file)) return file;
  return /^[A-Za-z0-9_@%+=:,./ -]+$/.test(file) ? `'${file}'` : null;
}

/** The folder each list test tries to list. */
export function listTestTargets(home: string): Record<ListTestKey, string> {
  return { documents: path.join(home, "Documents"), library: path.join(home, "Library"), claude: path.join(home, ".claude") };
}

/** Where each write test tries to make its file. */
export function writeTestTargets(dirs: ProtectedDirs): Record<WriteTestKey, string> {
  return {
    home: path.join(dirs.home, WRITE_TEST_FILE),
    repo: path.join(dirs.repo, WRITE_TEST_FILE),
    node: path.join(dirs.node, WRITE_TEST_FILE),
    kirocrew: path.join(dirs.kirocrew, WRITE_TEST_FILE),
    launchAgents: path.join(dirs.home, "Library", "LaunchAgents", WRITE_TEST_FILE),
  };
}

/**
 * The one command line the probe job runs, or null if a path cannot be written safely.
 * - Keychain: the secret is piped straight into `wc -c`; only the count is written.
 * - Bee: when blocked, `bee me` exits 1 and prints a short error (46 bytes in the experiments),
 *   so the count is taken only when it exits 0; otherwise 0 is written.
 * - Database: the file is only ever opened by `wc -c`. Unreadable leaves an empty file.
 * - Each list test: the number of names `ls -A` could list. A refused folder gives 0.
 * - Other programs: the number of processes `pgrep -f` finds with our stand-in's mark on their
 *   command line. Refused (or unable to ask at all) gives 0.
 * - Each write test: `touch` of a new file. 1 is written if that worked, 0 if it was refused,
 *   and the file is removed either way (it only ever exists when the sandbox is not there).
 */
export function probeCommand(targets: { dir: string; beeBinary: string; database: string; listTargets: Record<ListTestKey, string>; writeTargets: Record<WriteTestKey, string> }): string | null {
  const bee = shellWord(targets.beeBinary);
  const database = shellWord(targets.database);
  const out = (name: string) => shellWord(path.join(targets.dir, name));
  const [keychainOut, beeOut, databaseOut, processesOut, finishedOut] = [out(PROBE_FILES.keychain), out(PROBE_FILES.bee), out(PROBE_FILES.database), out(PROBE_FILES.processes), out(PROBE_FILES.finished)];
  if (bee === null || database === null || keychainOut === null || beeOut === null || databaseOut === null || processesOut === null || finishedOut === null) return null;
  const lists: string[] = [];
  for (const test of LIST_TESTS) {
    const target = shellWord(targets.listTargets[test.key]);
    const result = out(test.file);
    if (target === null || result === null) return null;
    lists.push(`/bin/ls -A ${target} 2>/dev/null | /usr/bin/wc -l > ${result}`);
  }
  const writes: string[] = [];
  for (const test of WRITE_TESTS) {
    const target = shellWord(targets.writeTargets[test.key]);
    const result = out(test.file);
    if (target === null || result === null) return null;
    writes.push(`/usr/bin/touch ${target} 2>/dev/null && echo 1 > ${result} || echo 0 > ${result}`, `/bin/rm -f ${target} 2>/dev/null`);
  }
  return [
    `/usr/bin/security find-generic-password -s gh:github.com -w 2>/dev/null | /usr/bin/wc -c > ${keychainOut}`,
    `${bee} me --json > /dev/null 2>&1 && ${bee} me --json 2>/dev/null | /usr/bin/wc -c > ${beeOut} || echo 0 > ${beeOut}`,
    `(/usr/bin/wc -c < ${database}) > ${databaseOut} 2>/dev/null`,
    ...lists,
    `/usr/bin/pgrep -f '${DECOY_PATTERN}' 2>/dev/null | /usr/bin/wc -l > ${processesOut}`,
    ...writes,
    `echo 1 > ${finishedOut}`,
  ].join("; ");
}

/**
 * The count in a result file: a number, 0 for an empty file when `emptyIsZero`, or null if it is
 * anything else. The job writes these files, so they are read as carefully as anything an agent
 * wrote: a link, a pipe or a large file is "anything else".
 */
function readCount(file: string, emptyIsZero: boolean): number | null {
  const raw = readSmallText(file, 64);
  if (raw === null) return null;
  const text = raw.trim();
  if (text === "") return emptyIsZero ? 0 : null;
  return /^\d{1,12}$/.test(text) ? Number(text) : null;
}

function couldNotRun(why: string): ProbeResult {
  return { ok: false, reason: `${SANDBOX_CHECK_FAILED}: it could not be run (${why})` };
}

/** Read the counts and marks the job left and decide. Exported for tests. */
export function judgeProbe(dir: string): ProbeResult {
  if (readCount(path.join(dir, PROBE_FILES.finished), false) !== 1) return couldNotRun("the check did not finish");
  const keychain = readCount(path.join(dir, PROBE_FILES.keychain), false);
  const bee = readCount(path.join(dir, PROBE_FILES.bee), false);
  const database = readCount(path.join(dir, PROBE_FILES.database), true);
  const lists = LIST_TESTS.map((test) => ({ said: test.said, count: readCount(path.join(dir, test.file), false) }));
  const processes = readCount(path.join(dir, PROBE_FILES.processes), false);
  const writes = WRITE_TESTS.map((test) => ({ said: test.said, mark: readCount(path.join(dir, test.file), false) }));
  if (keychain === null || bee === null || database === null || processes === null || lists.some((list) => list.count === null) || writes.some((write) => write.mark === null)) {
    return couldNotRun("its results could not be read");
  }
  const reachable = [
    ...(keychain > 0 ? ["the GitHub login in the Keychain can be reached"] : []),
    ...(bee > 0 ? ["the Bee login can be reached"] : []),
    ...(database > 0 ? ["the transcript database can be read"] : []),
    ...lists.filter((list) => list.count !== 0).map((list) => list.said),
    ...(processes > 0 ? ["a job can read the command lines of other programs"] : []),
    ...writes.filter((write) => write.mark !== 0).map((write) => write.said),
  ];
  return reachable.length === 0 ? { ok: true } : { ok: false, reason: `${SANDBOX_CHECK_FAILED}: ${reachable.join(", ")}` };
}

/** Starts the stand-in for "another program" and answers how to end it, or null when it could not be started. */
export type StartDecoy = () => { stop(): void } | null;

/**
 * The real one: one process of ours, outside the sandbox, that only sleeps and has DECOY_MARK on
 * its command line. It ends by itself after a few minutes if nobody ends it (say, because
 * Overnight itself was killed in the middle of a check).
 */
export const startDecoy: StartDecoy = () => {
  let child: ChildProcess;
  try {
    child = spawn("/usr/bin/perl", ["-e", `sleep ${DECOY_SECONDS}`, DECOY_MARK], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  } catch {
    return null;
  }
  if (child.pid === undefined) return null;
  // A late "could not start" must not take the whole program down.
  child.once("error", () => {});
  // It must not keep our own program alive.
  child.unref();
  return { stop: () => void child.kill("SIGKILL") };
};

export interface ProbeDeps {
  crew: CrewClient;
  paths: DataPaths;
  beeBinary: string;
  protectedDirs: ProtectedDirs;
  timeZone: string;
  logger: Logger;
  now: () => Date;
  /** Aborted when Overnight is told to stop: the check ends at once and its job is removed. */
  signal?: AbortSignal;
  /** Starts the stand-in for "another program". Tests pass one that starts nothing. */
  startDecoy?: StartDecoy;
}

/**
 * One try. Every job it adds is noted in `added`, and the way to end its stand-in process in
 * `stopDecoy`, so the caller can clear both away whatever happens.
 */
async function attempt(deps: ProbeDeps, dir: string, startedMs: number, added: string[], stopDecoy: Array<() => void>): Promise<ProbeResult> {
  const { crew, paths, signal } = deps;
  const stopping = "Overnight was being stopped";
  /** Asked afresh each time: it can change while a command is awaited. */
  const stopped = (): boolean => signal?.aborted === true;
  // Without the Bee program the Bee line would "pass" for the wrong reason.
  if (!existsSync(deps.beeBinary)) return couldNotRun("the Bee program was not found");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A link here would have the results (and the chmod below) land somewhere else.
  if (!lstatSync(dir).isDirectory()) return couldNotRun("its results folder is not a plain folder");
  // mkdir's mode only applies to a folder it creates; an older one may be open to others.
  chmodSync(dir, 0o700);
  for (const name of [...Object.values(PROBE_FILES), ...LIST_TESTS.map((test) => test.file), ...WRITE_TESTS.map((test) => test.file)]) rmSync(path.join(dir, name), { force: true });
  // The sandbox lets a job run nothing in this repo, so the Bee program that is installed here
  // could not even be started from inside, and its line would pass without saying anything. The
  // check runs a copy in its own results folder instead, where a job may run programs: what it
  // shows is that even a Bee program a job can run does not get at the login. (On this disk the
  // copy is a clone: it takes no time and no room.) It is removed when the check is over.
  const beeCopy = path.join(dir, BEE_COPY);
  rmSync(beeCopy, { recursive: true, force: true });
  try {
    // EXCL: never written through something that appeared at this name in the meantime.
    copyFileSync(deps.beeBinary, beeCopy, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    chmodSync(beeCopy, 0o700);
  } catch {
    return couldNotRun("the Bee program could not be copied for the check");
  }
  const command = probeCommand({ dir, beeBinary: beeCopy, database: paths.database, listTargets: listTestTargets(deps.protectedDirs.home), writeTargets: writeTestTargets(deps.protectedDirs) });
  if (command === null) return couldNotRun("a folder name has a character that cannot be used in the check");
  // Without the stand-in the "other programs" line would pass for the wrong reason too.
  const decoy = (deps.startDecoy ?? startDecoy)();
  if (decoy === null) return couldNotRun("its stand-in for another program could not be started");
  stopDecoy.push(decoy.stop);

  const job = await crew.addJob(
    PROBE_JOB_NAME,
    "",
    ["--cron", NEVER_DUE_CRON, "--timezone", deps.timeZone, "--command", command, "--timeout", String(COMMAND_TIMEOUT_SECS), "--timeout-secs", String(JOB_TIMEOUT_SECS), "--no-persistent-session", "--minimal-context"],
    signal,
  );
  if (!job.ok) return couldNotRun(stopped() ? stopping : job.reason);
  added.push(job.id);
  if (stopped()) return couldNotRun(stopping);
  const triggered = await crew.trigger(job.id, signal);
  if (!triggered.ok) return couldNotRun(stopped() ? stopping : triggered.reason);
  const waited = await crew.waitUntilFinished(job.id, triggered.triggeredAtMs, startedMs + PROBE_TIMEOUT_MS, signal);
  if (!waited.finished) {
    // Not over: end it before its job is removed (removing alone would leave it running).
    await crew.cancel(job.id).catch(() => false);
    return couldNotRun(waited.stopped ? stopping : "it did not finish within 3 minutes");
  }
  return judgeProbe(dir);
}

/** Run the check once. Never throws: anything unexpected is a failed check. */
export async function runSandboxProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const { crew, paths, logger, now } = deps;
  const startedMs = now().getTime();
  const added: string[] = [];
  const stopDecoy: Array<() => void> = [];
  let result: ProbeResult;
  try {
    result = await attempt(deps, probeDir(paths), startedMs, added, stopDecoy);
  } catch {
    result = couldNotRun("an unexpected error");
  } finally {
    for (const stop of stopDecoy) stop();
    for (const id of added) await crew.remove(id, deps.signal === undefined ? {} : { signal: deps.signal }).catch(() => false);
    // The copy of the Bee program has done its work.
    try {
      rmSync(path.join(probeDir(paths), BEE_COPY), { recursive: true, force: true });
    } catch {
      // Left for the next check, which removes it before it copies.
    }
  }
  const ms = now().getTime() - startedMs;
  if (result.ok) logger.info("build sandbox check passed: the Keychain, Bee, the transcript database, the folders in the home folder and other programs' command lines are out of reach of a job, and it cannot write where our programs are", { ms });
  else logger.error("build sandbox check failed: nothing will be built with Kiro Crew", { reason: result.reason, ms });
  return result;
}
