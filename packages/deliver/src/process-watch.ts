// Finds, and stops, what a program left running after it ended.
//
// runCommand starts every program as the leader of its own process group and kills that group when
// the program ends. A program can still put itself, or something it starts, into another group or
// session, and the group kill then misses it. (Playwright does exactly that with its browser.)
// macOS cannot be asked "what did this program ever start", so this module watches from outside:
//
//   1. The family tree. While the program runs, the process table is read a few times a second.
//      Everything descended from the program, or sitting in a group that one of them leads, is
//      remembered, with its start time so that a reused process number is never mistaken for it.
//   2. A tag. The program is started with a random value in its environment (RUN_TAG_NAME), which
//      everything it starts inherits. macOS shows the environment of the user's own programs but
//      not of the ones that ship with the system, so the tag finds a stray `node`, not a stray
//      `/bin/sleep`.
//   3. Where it lives. A program started by a step usually still has its working folder inside
//      the step's folders, or is a program file from there. Those folders are made fresh for the
//      step, so nothing else has any business in them (`livesUnder`).
//   4. In run-command.ts: the output pipes. If they stay open after everything we know of is dead,
//      something we could not find still holds them.
//
// A program that hides on purpose (starts a helper, exits within a fraction of a second, drops the
// tag, changes its working folder and closes the pipes) gets past all four. So nothing here is
// what keeps the published app honest: the verifier takes each step's folders away afterwards (see
// verifier.ts). This module is what keeps ordinary leftovers from running on, and what turns an
// escape we can see into a failed verification.
//
// Only process numbers, start times, program paths and working folders are read. The tag scan
// makes `ps` print other programs' command lines and environments; those lines are searched for
// the tag and dropped, and nothing from them is ever stored, returned or logged.
import { execFile } from "node:child_process";

/** The environment variable that carries a run's tag. */
export const RUN_TAG_NAME = "OVERNIGHT_RUN_TAG";

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const PS_TIMEOUT_MS = 3_000;
const PS_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_POLL_MS = 250;
/** How long finish() keeps killing and looking before it gives up and says "unconfirmed". */
const SWEEP_LIMIT_MS = 3_000;

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
  /** When it started, as ps prints it (to the second). With the pid, this names one process. */
  started: string;
  /** The full path of the program file. */
  program: string;
}

export interface Leftovers {
  /** Programs still running (not merely finishing up) outside the ended program's own process group. All were killed. */
  escaped: number;
  /** The same, for programs the caller said to expect there (the browser's own processes). Killed too. */
  expected: number;
  /**
   * True when it could not be confirmed that everything is gone: something was still running
   * after being killed and waited for, the process table could not be read, or the program's
   * output pipes were still held open by something that could not be found.
   */
  unconfirmed: boolean;
}

export interface TrackOptions {
  /** Program files under these folders may live outside the group (Playwright's browser). They are killed, not counted as escaped. */
  expectUnder?: readonly string[];
  /**
   * Folders made fresh for this program (real paths). Whatever is found afterwards with its
   * working folder in one of them, or running a program file from one of them, is the program's.
   */
  livesUnder?: readonly string[];
}

export interface ProcessWatchOptions extends TrackOptions {
  pollMs?: number;
  /** For tests: stand-ins for the two `ps` calls and the `lsof` call. */
  readTable?: () => Promise<ProcessRow[] | null>;
  readTagged?: (tag: string) => Promise<Set<number> | null>;
  readWorkingUnder?: (folders: readonly string[]) => Promise<Set<number> | null>;
  /** For tests: stand-in for sending SIGKILL. A negative number means a whole process group. */
  kill?: (pidOrNegativeGroup: number) => void;
}

export interface ProcessWatch {
  /** Kill everything known right now, without waiting. For shutdown. Never throws. */
  killKnown(): void;
  /** Call once the program has ended and its own group has been killed. Never rejects. */
  finish(): Promise<Leftovers>;
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // LC_ALL=C keeps the start-time column in one fixed format whatever the user's language is.
      execFile(PS, args, { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, encoding: "utf8" }, (error, stdout) => {
        resolve(error ? null : stdout);
      });
    } catch {
      resolve(null);
    }
  });
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: (match[4] ?? "").startsWith("Z"),
      started: (match[5] ?? "").replace(/\s+/g, " "),
      program: (match[6] ?? "").trim(),
    });
  }
  return rows;
}

/** Every process on this Mac: numbers, state, start time and program path. Null if `ps` failed. */
export async function readProcessTable(): Promise<ProcessRow[] | null> {
  const text = await ps(["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,comm="]);
  return text === null ? null : parseProcessTable(text);
}

/** The pids of the processes whose environment carries this tag. Null if `ps` failed. */
export async function readTaggedPids(tag: string): Promise<Set<number> | null> {
  const text = await ps(["-axEww", "-o", "pid=,command="]);
  if (text === null) return null;
  const needle = `${RUN_TAG_NAME}=${tag}`;
  const pids = new Set<number>();
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
    if (Number.isInteger(pid) && pid > 1) pids.add(pid);
  }
  return pids;
}

function isUnder(file: string, folders: readonly string[]): boolean {
  return folders.some((folder) => file === folder || file.startsWith(folder.endsWith("/") ? folder : `${folder}/`));
}

/**
 * The pids of this user's processes whose working folder is inside one of `folders`. Null if
 * `lsof` failed. (lsof exits with 1 whenever it could not look into some process, which is
 * normal; what it printed is still good.)
 */
export function readPidsWorkingUnder(folders: readonly string[]): Promise<Set<number> | null> {
  return new Promise((resolve) => {
    if (folders.length === 0 || typeof process.getuid !== "function") {
      resolve(new Set());
      return;
    }
    try {
      execFile(LSOF, ["-a", "-u", String(process.getuid()), "-d", "cwd", "-Fpn"], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" }, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, encoding: "utf8" }, (error, stdout) => {
        if (error && (error.killed === true || typeof error.code !== "number")) {
          resolve(null);
          return;
        }
        // Lines are "p<pid>", then "f<descriptor>" and "n<path>" for that process.
        const pids = new Set<number>();
        let pid = 0;
        for (const line of stdout.split("\n")) {
          if (line.startsWith("p")) pid = Number(line.slice(1));
          else if (line.startsWith("n") && Number.isInteger(pid) && pid > 1 && isUnder(line.slice(1), folders)) pids.add(pid);
        }
        resolve(pids);
      });
    } catch {
      resolve(null);
    }
  });
}

function sendKill(pidOrNegativeGroup: number): void {
  try {
    process.kill(pidOrNegativeGroup, "SIGKILL");
  } catch {
    // Already gone, or not ours to signal.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start watching the program with process number `rootPid`, which must lead its own process group
 * and carry `tag` in its environment.
 */
export function watchProcessTree(rootPid: number, tag: string, options: ProcessWatchOptions = {}): ProcessWatch {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const readTable = options.readTable ?? readProcessTable;
  const readTagged = options.readTagged ?? readTaggedPids;
  const readWorkingUnder = options.readWorkingUnder ?? readPidsWorkingUnder;
  const kill = options.kill ?? sendKill;
  const expectUnder = options.expectUnder ?? [];
  const livesUnder = options.livesUnder ?? [];

  /**
   * Every living process we know to be the program's: when it started, and the program file it
   * was last seen running. (A process on its way out is listed as "(name)" with no path, so the
   * path has to be remembered from when it was still whole.)
   */
  const known = new Map<number, { started: string; program: string }>();
  /** Process groups led by one of those processes. The program's own group is the first. */
  const groups = new Set<number>([rootPid]);
  let finished = false;
  let timer: NodeJS.Timeout | undefined;

  /** Never us, our parent, or the system's first processes, whatever a snapshot seems to say. */
  const offLimits = (pid: number) => pid <= 1 || pid === process.pid || pid === process.ppid;

  /** `marked`: pids that the tag or the working-folder scan says are the program's, whatever the family tree shows. */
  const absorb = (rows: ProcessRow[], marked: Set<number> = new Set()) => {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    // Forget what has ended: a process number that comes back later belongs to something else.
    for (const [pid, seen] of known) {
      if (byPid.get(pid)?.started !== seen.started) known.delete(pid);
    }
    const livingGroups = new Set(rows.map((row) => row.pgid));
    for (const group of groups) {
      if (group !== rootPid && !livingGroups.has(group)) groups.delete(group);
    }
    // Follow parents to children until nothing new turns up in this snapshot.
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (offLimits(row.pid)) continue;
        const seen = known.get(row.pid);
        if (seen === undefined) {
          const parent = byPid.get(row.ppid);
          const childOfOurs = parent !== undefined && known.get(parent.pid)?.started === parent.started;
          if (row.pid !== rootPid && !childOfOurs && !groups.has(row.pgid) && !marked.has(row.pid) && !isUnder(row.program, livesUnder)) continue;
          known.set(row.pid, { started: row.started, program: row.program });
          grew = true;
        } else if (row.program.startsWith("/")) {
          seen.program = row.program;
        }
        // Only a group that one of ours leads counts: a child seen in the instant before it
        // moves into its own group still shows OUR group, which must never be taken for its.
        if (row.pgid === row.pid && !groups.has(row.pid)) {
          groups.add(row.pid);
          grew = true;
        }
      }
    }
  };

  const poll = async () => {
    if (finished) return;
    try {
      const rows = await readTable();
      if (finished) return;
      if (rows !== null) absorb(rows);
    } catch {
      // One bad reading is no reason to stop watching.
    }
    if (finished) return;
    timer = setTimeout(() => void poll(), pollMs);
    timer.unref();
  };
  void poll();

  const killKnown = () => {
    for (const pid of known.keys()) if (!offLimits(pid)) kill(pid);
    for (const group of groups) if (!offLimits(group)) kill(-group);
  };

  const finish = async (): Promise<Leftovers> => {
    finished = true;
    clearTimeout(timer);
    const leftovers: Leftovers = { escaped: 0, expected: 0, unconfirmed: false };
    const counted = new Set<string>();
    const deadline = Date.now() + SWEEP_LIMIT_MS;
    try {
      for (let round = 0; ; round += 1) {
        const rows = await readTable();
        if (rows === null) {
          leftovers.unconfirmed = true;
          break;
        }
        // The tag and the working folders come on top of the family tree; a scan that fails is
        // not held against the run.
        const [tagged, working] = await Promise.all([readTagged(tag), readWorkingUnder(livesUnder)]);
        absorb(rows, new Set([...(tagged ?? []), ...(working ?? [])]));
        const alive = rows.filter((row) => !row.zombie && !offLimits(row.pid) && known.get(row.pid)?.started === row.started);
        if (alive.length === 0) break;
        for (const row of alive) {
          const key = `${row.pid} ${row.started}`;
          // A process that is already on its way out is listed by a short name in brackets, with
          // no path. It is not "still running": it is waited for (and killed) like the rest, and
          // held against the run only if it never goes (see the time limit below).
          const ending = !row.program.startsWith("/");
          if (row.pgid !== rootPid && !ending && !counted.has(key)) {
            counted.add(key);
            const program = known.get(row.pid)?.program ?? row.program;
            if (isUnder(program, expectUnder)) leftovers.expected += 1;
            else leftovers.escaped += 1;
          }
        }
        killKnown();
        if (Date.now() >= deadline) {
          leftovers.unconfirmed = true;
          break;
        }
        await sleep(round === 0 ? 40 : 150);
      }
    } catch {
      leftovers.unconfirmed = true;
    }
    return leftovers;
  };

  return { killKnown, finish };
}
