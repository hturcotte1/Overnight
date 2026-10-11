// Synthetic test data: every process number, start time and program path in this file is made up.
// Nothing here starts a program or reads the real process table (run-command.test.ts does that).
import { describe, expect, it } from "vitest";
import { parseProcessTable, RUN_TAG_NAME, watchProcessTree } from "../src/process-watch.ts";
import type { ProcessRow } from "../src/process-watch.ts";

const T0 = "Sat Oct 10 06:30:00 2026";
const T1 = "Sat Oct 10 06:30:05 2026";
const ROOT = 5000;
const row = (pid: number, ppid: number, pgid: number, program = "/made-up/bin/tool", extra: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid, pgid, zombie: false, started: T0, program, ...extra });
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** A watch over a scripted process table. `kill` removes the process (or the whole group) from every later table. */
function rig(options: { expectUnder?: string[]; livesUnder?: string[]; unkillable?: number[] } = {}) {
  let table: ProcessRow[] | null = [];
  let tagged: Set<number> | null = new Set();
  let working: Set<number> | null = new Set();
  const askedFolders: Array<readonly string[]> = [];
  const killed: number[] = [];
  const watch = watchProcessTree(ROOT, "made-up-tag", {
    pollMs: 5,
    ...(options.expectUnder ? { expectUnder: options.expectUnder } : {}),
    ...(options.livesUnder ? { livesUnder: options.livesUnder } : {}),
    readTable: async () => (table === null ? null : table.map((entry) => ({ ...entry }))),
    readTagged: async () => tagged,
    readWorkingUnder: async (folders) => {
      askedFolders.push(folders);
      return working;
    },
    kill: (target) => {
      killed.push(target);
      if (table === null) return;
      table = table.filter((entry) => (options.unkillable ?? []).includes(entry.pid) || (target < 0 ? entry.pgid !== -target : entry.pid !== target));
    },
  });
  return {
    watch,
    killed,
    set: (rows: ProcessRow[] | null) => {
      table = rows;
    },
    tag: (pids: number[] | null) => {
      tagged = pids === null ? null : new Set(pids);
    },
    workingInside: (pids: number[] | null) => {
      working = pids === null ? null : new Set(pids);
    },
    askedFolders,
    pids: () => (table ?? []).map((entry) => entry.pid),
  };
}

/** finish() can be asked again: it simply looks once more. */
const watchAgain = (r: ReturnType<typeof rig>) => r.watch.finish();

describe("parseProcessTable", () => {
  it("reads numbers, state, start time and the program path, spaces and all", () => {
    const text = [
      " 5000  4999  5000 Ss   Sat Oct 10 06:30:00 2026     /made-up/bin/sandbox-exec",
      "    1     0     1 Ss   Fri Oct  9 08:00:00 2026     /sbin/launchd",
      " 5010  5000  5010 SNs  Sat Oct 10 06:30:05 2026     /made-up/Caches/browser shell/chrome-headless-shell",
      " 5011     1  5011 Z    Sat Oct 10 06:30:05 2026     (node)",
      "garbage that is not a row",
      "",
    ].join("\n");
    expect(parseProcessTable(text)).toEqual([
      { pid: 5000, ppid: 4999, pgid: 5000, zombie: false, started: T0, program: "/made-up/bin/sandbox-exec" },
      { pid: 1, ppid: 0, pgid: 1, zombie: false, started: "Fri Oct 9 08:00:00 2026", program: "/sbin/launchd" },
      { pid: 5010, ppid: 5000, pgid: 5010, zombie: false, started: T1, program: "/made-up/Caches/browser shell/chrome-headless-shell" },
      { pid: 5011, ppid: 1, pgid: 5011, zombie: true, started: T1, program: "(node)" },
    ]);
  });
});

describe("watchProcessTree", () => {
  it("reports nothing when the program and its group are gone", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT), row(77, 1, 77, "/made-up/someone-elses")]);
    await tick();
    r.set([row(77, 1, 77, "/made-up/someone-elses")]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    expect(r.killed).toEqual([]);
  });

  it("follows the family tree into a new session and kills what stayed behind there", async () => {
    const r = rig();
    // 5001 is the program's child; it starts 5002, which leads a group of its own and starts 5003.
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT), row(5002, 5001, 5002), row(5003, 5002, 5002), row(77, 1, 77)]);
    await tick();
    // The program ended and its group was killed: the two in the other group live on, now children of launchd.
    r.set([row(5002, 1, 5002), row(5003, 5002, 5002), row(77, 1, 77)]);
    expect(await r.watch.finish()).toEqual({ escaped: 2, expected: 0, unconfirmed: false });
    expect(r.pids()).toEqual([77]);
  });

  it("recognises a late member of a group that one of the program's own leads", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT), row(5002, ROOT, 5002)]);
    await tick();
    // 5009 was never seen with a parent of ours, but sits in the group 5002 leads.
    r.set([row(5002, 1, 5002), row(5009, 1, 5002)]);
    expect((await r.watch.finish()).escaped).toBe(2);
    expect(r.pids()).toEqual([]);
  });

  it("finds a helper it never saw in the family tree by the tag", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT)]);
    await tick();
    r.set([row(6000, 1, 6000), row(77, 1, 77)]);
    r.tag([6000]);
    expect(await r.watch.finish()).toEqual({ escaped: 1, expected: 0, unconfirmed: false });
    expect(r.pids()).toEqual([77]);
  });

  it("finds a system program by its working folder, and a program file that runs from the step's own folders", async () => {
    const box = "/made-up/data/tmp/deliver/idea_1/run-1/build";
    const r = rig({ livesUnder: [box] });
    r.set([row(ROOT, 100, ROOT)]);
    await tick();
    // 6000: /bin/sleep with its working folder in the box (the scan says so). 6001: a program file inside the box.
    // 6002: a program in a folder whose name merely starts the same. 77: someone else's.
    r.set([row(6000, 1, 6000, "/bin/sleep"), row(6001, 1, 6001, `${box}/app/node_modules/.bin/made-up-daemon`), row(6002, 1, 6002, `${box}-other/tool`), row(77, 1, 77)]);
    r.workingInside([6000]);
    expect(await r.watch.finish()).toEqual({ escaped: 2, expected: 0, unconfirmed: false });
    expect(r.pids()).toEqual([6002, 77]);
    expect(r.askedFolders[0]).toEqual([box]);
  });

  it("a failed working-folder scan is not held against the run, and our own process is never taken for the program's", async () => {
    const r = rig({ livesUnder: ["/made-up/box"] });
    r.set([row(ROOT, 100, ROOT)]);
    await tick();
    r.set([row(process.pid, process.ppid, 4242)]);
    r.workingInside(null);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    r.workingInside([process.pid]);
    expect(await watchAgain(r)).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    expect(r.killed).toEqual([]);
  });

  it("counts programs from an expected folder apart", async () => {
    const r = rig({ expectUnder: ["/made-up/Caches/browsers"] });
    const browser = "/made-up/Caches/browsers/shell-1/chrome-headless-shell";
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT), row(5002, 5001, 5002, browser), row(5003, 5002, 5002, browser), row(5004, 5001, 5004, "/made-up/Caches/browsers-not/tool")]);
    await tick();
    // (5002 is exiting: it is listed by its short name in brackets, with no path, and is not counted.)
    r.set([row(5002, 1, 5002, "(chrome-headless-sh)"), row(5003, 5002, 5002, browser), row(5004, 1, 5004, "/made-up/Caches/browsers-not/tool")]);
    expect(await r.watch.finish()).toEqual({ escaped: 1, expected: 1, unconfirmed: false });
    expect(r.pids()).toEqual([]);
  });

  it("a process that is already on its way out is waited for, not counted as left running", async () => {
    const r = rig({ expectUnder: ["/made-up/Caches/browsers"] });
    const browser = "/made-up/Caches/browsers/shell-1/chrome-headless-shell";
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT), row(5002, 5001, 5002, browser)]);
    await tick();
    // 5005 was started by the browser a moment ago and is already exiting: no path, only a name in
    // brackets. 5006 is the same kind of row next to a stray tool that is very much alive.
    r.set([row(5002, 1, 5002, browser), row(5005, 5002, 5002, "(chrome-headless-sh)"), row(5004, 1, 5004, "/made-up/tool"), row(5006, 5004, 5004, "(tool)")]);
    r.tag([5004]);
    expect(await r.watch.finish()).toEqual({ escaped: 1, expected: 1, unconfirmed: false });
    expect(r.pids()).toEqual([]);
  });

  it("a whole browser that is seen for the first time while it shuts down is not held against a step", async () => {
    const r = rig({ expectUnder: ["/made-up/Caches/browsers"] });
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT)]);
    await tick();
    r.set([row(5002, 1, 5002, "(chrome-headless-sh)"), row(5003, 5002, 5002, "(chrome-headless-sh)")]);
    r.tag([5002]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    expect(r.pids()).toEqual([]);
  });

  it("but one that never finishes going is: nothing is read while something may still be there", async () => {
    const r = rig({ unkillable: [5002] });
    r.set([row(ROOT, 100, ROOT), row(5002, ROOT, 5002)]);
    await tick();
    r.set([row(5002, 1, 5002, "(tool)")]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: true });
  }, 15_000);

  it("never takes our own process, our parent or our process group for the program's", async () => {
    const r = rig();
    const ourGroup = 4242;
    // Seen in the instant before it moved into its own group, the program still shows OUR group.
    r.set([row(ROOT, process.pid, ourGroup), row(process.pid, process.ppid, ourGroup), row(process.ppid, 1, ourGroup), row(4300, process.pid, ourGroup)]);
    await tick();
    r.set([row(process.pid, process.ppid, ourGroup), row(process.ppid, 1, ourGroup), row(4300, process.pid, ourGroup)]);
    r.tag([process.pid, process.ppid]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    expect(r.killed).toEqual([]);
  });

  it("does not mistake a reused process number for the one it knew", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT), row(5002, ROOT, 5002)]);
    await tick();
    // 5002 ended; later an unrelated program was given the same number (a different start time).
    r.set([row(ROOT, 100, ROOT)]);
    await tick();
    r.set([row(5002, 1, 5002, "/made-up/someone-elses", { started: T1 }), row(5003, 5002, 5002, "/made-up/someone-elses", { started: T1 })]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
    expect(r.killed).toEqual([]);
  });

  it("ignores zombies: they are already dead", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT), row(5002, ROOT, 5002)]);
    await tick();
    r.set([row(5002, 1, 5002, "(tool)", { zombie: true })]);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
  });

  it("says unconfirmed when something will not die, and when the process table cannot be read", async () => {
    const stubborn = rig({ unkillable: [5002] });
    stubborn.set([row(ROOT, 100, ROOT), row(5002, ROOT, 5002)]);
    await tick();
    stubborn.set([row(5002, 1, 5002)]);
    expect(await stubborn.watch.finish()).toEqual({ escaped: 1, expected: 0, unconfirmed: true });

    const blind = rig();
    blind.set([row(ROOT, 100, ROOT)]);
    await tick();
    blind.set(null);
    expect(await blind.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: true });
  }, 15_000);

  it("a failed tag scan is not held against the run", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT)]);
    await tick();
    r.set([]);
    r.tag(null);
    expect(await r.watch.finish()).toEqual({ escaped: 0, expected: 0, unconfirmed: false });
  });

  it("killKnown kills everything known so far, at once, for shutdown", async () => {
    const r = rig();
    r.set([row(ROOT, 100, ROOT), row(5001, ROOT, ROOT), row(5002, 5001, 5002)]);
    await tick();
    r.watch.killKnown();
    expect(r.pids()).toEqual([]);
    expect(r.killed).toContain(-ROOT);
    expect(r.killed).toContain(-5002);
    await r.watch.finish();
  });

  it("the tag's name is the one runCommand puts in the environment", () => {
    expect(RUN_TAG_NAME).toBe("OVERNIGHT_RUN_TAG");
  });
});
