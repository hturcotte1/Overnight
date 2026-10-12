// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The tools of spikes/11-hardening-proof.ts, the script that proves the sandbox profiles on a
// throwaway Kiro Crew gateway: what it refuses to run on, the copies it makes of the profiles,
// how it turns macOS's log into counts, how its last step decides, and how a hold (its gateway
// that stays up for a rehearsal) says what to give the rehearsal and knows when to end. No
// gateway, no Kiro program and no sandbox is started here (the programs these tests start are a
// made-up stand-in for macOS's `log`, and a shell that a printed line is pasted into); the
// script's own zero-credit self-check (`node spikes/11-hardening-proof.ts check`) tries the same
// things on a real sandbox and the real log.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DASHBOARD_PORT } from "@overnight/core";
import { describe, expect, it } from "vitest";
import {
  countDecisions,
  dataDirProblem,
  HOLD_END_WORDS,
  HOLD_LIMIT_MS,
  holdEnd,
  holdEnvironment,
  holdEnvironmentLine,
  holdInstructions,
  holdStopFile,
  inQuietHours,
  judgeLog,
  kiroHomeProblem,
  logTimeMs,
  lookAtHold,
  newRunWord,
  nextInOrder,
  overlaps,
  parseDecision,
  parseWatch,
  portProblem,
  PROOF_ORDER,
  readDecisions,
  shellWord,
  SYSLOG_SOCKET,
  targetShape,
  twoFoldersProblem,
  waitForHoldEnd,
  withReportLines,
} from "../../../spikes/11-hardening-proof.ts";
import type { CanaryTry, Decision, Held, HoldEnd, HoldLook, LogFacts, Sighting, Watch } from "../../../spikes/11-hardening-proof.ts";
import { CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE } from "../src/index.ts";
import { DEFAULT_GATEWAY_PORT, defaultCrewHome, defaultKiroHome, gatewayPort } from "../src/crew-client.ts";
import { profileParams } from "../src/sandbox-values.ts";
import { tempDir } from "./helpers.ts";

/** A made-up home folder with a made-up "real" data folder and Kiro folder in it. */
function madeUpHome() {
  const home = path.join(tempDir("overnight-proof-test-"), "home");
  const realData = path.join(home, ".overnight");
  const realKiro = path.join(home, ".kiro");
  for (const dir of [realData, path.join(realKiro, "crew"), path.join(home, "elsewhere")]) mkdirSync(dir, { recursive: true });
  return { home, realData, realKiro };
}

describe("the hardening proof script: what it refuses to run on", () => {
  it("refuses the real data folder, whatever it is called: itself, a folder in it, the folder above it, a link to it", () => {
    const { home, realData } = madeUpHome();
    const link = path.join(home, "elsewhere", "looks-harmless");
    symlinkSync(realData, link);
    const through = path.join(home, "elsewhere", "..", ".overnight");
    for (const folder of [realData, `${realData}/`, path.join(realData, "scratch"), path.join(realData, "not", "there", "yet"), home, path.dirname(home), link, path.join(link, "scratch"), through]) {
      expect(dataDirProblem(folder, realData, home), folder).toMatch(/the real data folder/);
    }
  });

  it("refuses the real data folder by its spelling alone when it does not exist yet", () => {
    const home = path.join(tempDir("overnight-proof-test-"), "home");
    mkdirSync(home);
    const realData = path.join(home, ".overnight");
    expect(dataDirProblem(realData, realData, home)).toMatch(/the real data folder/);
    expect(dataDirProblem(path.join(realData, "x"), realData, home)).toMatch(/the real data folder/);
  });

  it("takes a scratch folder of its own in the home folder, and nothing outside it", () => {
    const { home, realData } = madeUpHome();
    expect(dataDirProblem(path.join(home, ".overnight-hardening"), realData, home)).toBeNull();
    // A name that only begins like the real one is another folder.
    expect(dataDirProblem(path.join(home, ".overnight2"), realData, home)).toBeNull();
    // Kept to where real builds have run: no real build has run in a data folder outside the home folder.
    expect(dataDirProblem("/private/tmp/overnight-proof", realData, home)).toMatch(/inside the home folder/);
    expect(dataDirProblem(path.join(path.dirname(home), "beside-home"), realData, home)).toMatch(/inside the home folder/);
    expect(dataDirProblem("relative/folder", realData, home)).toMatch(/full path/);
    for (const none of [undefined, "", "   "]) expect(dataDirProblem(none, realData, home)).toMatch(/OVERNIGHT_DATA_DIR is not set/);
  });

  it("refuses Kiro's real folder and Kiro Crew's real home in it, by any name", () => {
    const { home, realData, realKiro } = madeUpHome();
    const link = path.join(home, "elsewhere", "kiro-link");
    symlinkSync(realKiro, link);
    for (const folder of [realKiro, path.join(realKiro, "crew"), path.join(realKiro, "crew", "run"), home, link, path.join(link, "crew")]) {
      expect(kiroHomeProblem(folder, realKiro, realData, home), folder).toMatch(/Kiro's real folder/);
    }
    expect(kiroHomeProblem(path.join(home, ".kiro-hardening"), realKiro, realData, home)).toBeNull();
    expect(kiroHomeProblem(undefined, realKiro, realData, home)).toMatch(/KIRO_HOME is not set/);
    expect(kiroHomeProblem("kiro-here", realKiro, realData, home)).toMatch(/full path/);
  });

  it("refuses a throwaway Kiro home inside Overnight's real data folder, or outside the home folder", () => {
    const { home, realData, realKiro } = madeUpHome();
    const link = path.join(home, "elsewhere", "data-link");
    symlinkSync(realData, link);
    for (const folder of [realData, path.join(realData, "kiro"), path.join(link, "kiro")]) expect(kiroHomeProblem(folder, realKiro, realData, home), folder).toMatch(/Overnight's real data folder/);
    for (const folder of ["/private/tmp/kiro-proof", path.join(path.dirname(home), "beside-home")]) expect(kiroHomeProblem(folder, realKiro, realData, home), folder).toMatch(/inside the home folder/);
  });

  it("refuses a Kiro home and a data folder that lie inside each other, or inside this repo", () => {
    const { home } = madeUpHome();
    const [data, kiro, repo] = [path.join(home, ".overnight-hardening"), path.join(home, ".kiro-hardening"), path.join(home, "repo")];
    expect(twoFoldersProblem(data, kiro, repo)).toBeNull();
    expect(twoFoldersProblem(data, path.join(data, "kiro"), repo)).toMatch(/two separate folders/);
    expect(twoFoldersProblem(path.join(kiro, "data"), kiro, repo)).toMatch(/two separate folders/);
    expect(twoFoldersProblem(data, data, repo)).toMatch(/two separate folders/);
    expect(twoFoldersProblem(path.join(repo, "scratch"), kiro, repo)).toMatch(/outside this repo/);
    expect(twoFoldersProblem(data, path.join(repo, "kiro"), repo)).toMatch(/outside this repo/);
  });

  it("says two folders overlap only when one is the other, in it, or above it", () => {
    const { home, realData, realKiro } = madeUpHome();
    expect(overlaps(realData, realData)).toBe(true);
    expect(overlaps(path.join(realData, "a", "b"), realData)).toBe(true);
    expect(overlaps(home, realData)).toBe(true);
    expect(overlaps(realKiro, realData)).toBe(false);
    expect(overlaps(path.join(home, "elsewhere"), realData)).toBe(false);
    expect(overlaps(path.join(home, "not-there"), path.join(home, "not-there-either"))).toBe(false);
  });

  it("refuses the port of the gateway that builds every night, the dashboard's port, and anything that is not a port", () => {
    expect(DEFAULT_GATEWAY_PORT).toBe(5476);
    expect(portProblem("5476")).toMatch(/the gateway that builds every night/);
    expect(portProblem(String(DASHBOARD_PORT))).toMatch(/the dashboard's port/);
    for (const bad of [undefined, "", "80", "999", "70000", "54 78", "5478; true", "abc"]) expect(portProblem(bad), String(bad)).not.toBeNull();
    expect(portProblem("5478")).toBeNull();
    expect(portProblem(" 5478 ")).toBeNull();
  });

  it("keeps away from the hours of the night's build and delivery, by the clock of the time zone it is given", () => {
    // Boise is six hours behind UTC in October.
    const at = (local: string) => new Date(`2026-10-12T${local}:00-06:00`);
    for (const quiet of ["00:45", "01:00", "02:29", "06:15", "06:30", "07:44"]) expect(inQuietHours(at(quiet), "America/Boise"), quiet).toBe(true);
    for (const free of ["00:44", "02:30", "06:14", "07:45", "12:00", "23:59", "00:00"]) expect(inQuietHours(at(free), "America/Boise"), free).toBe(false);
    // The same moment is not the same hour elsewhere.
    expect(inQuietHours(at("01:00"), "Europe/Paris")).toBe(false);
  });
});

/** A word of the shape the script makes for a run. */
const WORD = "overnight-proof-0123456789abcdef";

describe("the hardening proof script: its copies of the profiles", () => {
  it("makes a new word for every run, of one fixed shape", () => {
    const words = new Set([newRunWord(), newRunWord(), newRunWord()]);
    expect(words.size).toBe(3);
    for (const word of words) expect(word).toMatch(/^overnight-proof-[0-9a-f]{16}$/);
  });

  for (const [label, file] of [
    ["gateway", CREW_GATEWAY_SANDBOX_PROFILE],
    ["Kiro CLI", KIRO_CLI_SANDBOX_PROFILE],
  ] as const) {
    it(`adds lines that only report to the ${label} profile, right after its first rule, and changes nothing else`, () => {
      const shipped = readFileSync(file, "utf8");
      const copy = withReportLines(shipped, WORD);
      const added = copy.split("\n").filter((line) => !shipped.split("\n").includes(line));
      // One comment and six rules; every rule allows, reports, and carries this run's word.
      expect(added).toHaveLength(7);
      expect(added[0]).toMatch(/^;; .*report and refuse nothing/);
      for (const rule of added.slice(1)) expect(rule).toMatch(/^\(allow (network-outbound|network-bind|sysctl-read|process-exec\*|process-fork) (.* )?\(with report\) \(with message "overnight-proof-0123456789abcdef"\)\)$/);
      // What marks this run's programs: each program started, and the system values every program reads as it starts.
      for (const kind of ["sysctl-read", "process-exec*", "process-fork"]) expect(added.filter((rule) => rule.startsWith(`(allow ${kind} (with report)`))).toHaveLength(1);
      expect(copy.startsWith(shipped.slice(0, shipped.indexOf("(allow default)\n") + "(allow default)\n".length))).toBe(true);
      // Everything of the shipped file follows the added lines, byte for byte: its rules come later, so they still have the last word.
      const rest = shipped.slice(shipped.indexOf("(allow default)\n") + "(allow default)\n".length);
      expect(copy.endsWith(rest)).toBe(true);
      expect(copy.indexOf(added[6] ?? "x")).toBeLessThan(copy.indexOf(rest.trimStart().split("\n")[0] ?? "x"));
      // It asks for the same values, so it is started exactly as the shipped file is.
      expect(profileParams(copy)).toEqual(profileParams(shipped));
      expect(copy).not.toMatch(/^\(deny .*with report/m);
      expect(copy).not.toMatch(/^\(deny .*with message/m);
    });
  }

  it("refuses a file that does not begin the way our profiles do", () => {
    expect(() => withReportLines("(version 1)\n(deny default)\n", WORD)).toThrow(/does not begin the way ours do/);
    expect(() => withReportLines("", WORD)).toThrow();
  });

  it("refuses a word it did not make itself: nothing else may be written into a profile", () => {
    const shipped = readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8");
    for (const word of ["", "x", 'a")) (allow file-read* (subpath "/', "overnight-proof-0123456789ABCDEF", `${WORD}0`]) expect(() => withReportLines(shipped, word), word).toThrow(/not one this script made/);
  });
});

describe("the hardening proof script: what the sandbox decided, as counts", () => {
  const places = { dataDir: "/Users/someone/.overnight-hardening", kiroHome: "/Users/someone/.kiro-hardening", crewHome: "/Users/someone/.kiro-hardening/crew", home: "/Users/someone" };

  it("reads a line of macOS's log as a decision: program, process number, allowed or refused, kind of thing, target", () => {
    expect(parseDecision("2026-10-11 17:25:01.123 Df kernel[0:f3a9d] (Sandbox) Sandbox: nc(4242) allow network-outbound /Users/someone/x/s.sock")).toEqual({
      program: "nc",
      pid: 4242,
      verdict: "allow",
      operation: "network-outbound",
      target: "/Users/someone/x/s.sock",
      count: 1,
      repeats: false,
      at: null,
      marked: false,
    });
    expect(parseDecision("2026-10-11 17:25:01.456 E  kernel[0:f3ab2] (Sandbox) Sandbox: python3.12(977) deny(1) network-outbound /private/var/run/made-up.sock")).toMatchObject({ program: "python3.12", pid: 977, verdict: "deny", operation: "network-outbound" });
    expect(parseDecision("... Sandbox: kiro-cli-chat(51) allow network-outbound remote:*:5478")).toMatchObject({ program: "kiro-cli-chat", target: "remote:*:5478" });
    expect(parseDecision("... Sandbox: Some App Helper (Renderer)(7) deny(1) mach-lookup com.made-up.service")).toMatchObject({ program: "Some App Helper (Renderer)", pid: 7, operation: "mach-lookup" });
    // A kind that names nothing.
    expect(parseDecision("Sandbox: bash(31) allow process-fork")).toMatchObject({ program: "bash", pid: 31, operation: "process-fork", target: "" });
    for (const other of ["", "Timestamp Ty Process[PID:TID]", "... (Sandbox) something else entirely", "Sandbox: nc(1) maybe network-outbound x"]) expect(parseDecision(other), other).toBeNull();
  });

  it("reads the line macOS writes for repeated tries as that many, and knows it is such a line", () => {
    expect(parseDecision("5 duplicate reports for Sandbox: perl(613) deny(1) network-outbound /private/var/run/made-up.sock")).toMatchObject({ program: "perl", pid: 613, verdict: "deny", target: "/private/var/run/made-up.sock", count: 5, repeats: true });
    expect(parseDecision("x (Sandbox) 1 duplicate report for Sandbox: node(9) deny(1) network-outbound /private/var/run/syslog")).toMatchObject({ program: "node", pid: 9, count: 1, repeats: true });
  });

  it("knows a line that carries this run's word, which a rule's message puts on a line of its own, and reads its time", () => {
    const marked = parseDecision(`Sandbox: sandbox-exec(776) allow process-exec* /usr/bin/nc\n${WORD}`, { word: WORD, timestamp: "2026-10-12 00:23:52.979854-0600" });
    expect(marked).toMatchObject({ program: "sandbox-exec", pid: 776, operation: "process-exec*", target: "/usr/bin/nc", marked: true, at: Date.parse("2026-10-12T06:23:52.979Z") });
    // Another run's word, no word, and no word asked for.
    expect(parseDecision("Sandbox: nc(1) allow process-exec* /usr/bin/nc\novernight-proof-ffffffffffffffff", { word: WORD })?.marked).toBe(false);
    expect(parseDecision("Sandbox: nc(1) deny(1) network-outbound /x.sock", { word: WORD })?.marked).toBe(false);
    expect(parseDecision(`Sandbox: nc(1) allow process-exec* /usr/bin/nc\n${WORD}`)?.marked).toBe(false);
  });

  it("reads the log's own time, and says so when it cannot", () => {
    expect(logTimeMs("2026-10-12 00:23:52.979854-0600")).toBe(Date.parse("2026-10-12T00:23:52.979-06:00"));
    expect(logTimeMs("2026-01-05 13:00:00.5+0100")).toBe(Date.parse("2026-01-05T13:00:00.500+01:00"));
    expect(logTimeMs("2026-10-12 00:23:52-0600")).toBe(Date.parse("2026-10-12T00:23:52.000-06:00"));
    for (const bad of [undefined, "", "yesterday", "2026-10-12", "2026-10-12 00:23:52"]) expect(logTimeMs(bad), String(bad)).toBeNull();
  });

  it("shapes a target: known folders by name, the home folder as ~, numbers as N, and never the account's name", () => {
    expect(targetShape("/Users/someone/.kiro-hardening/crew/mcp-gateway/gateway.sock", places)).toBe("<crew home>/mcp-gateway/gateway.sock");
    expect(targetShape("/Users/someone/.kiro-hardening/sessions/4411.sock", places)).toBe("<kiro home>/sessions/N.sock");
    expect(targetShape("/Users/someone/.overnight-hardening/tmp/build/x.sock", places)).toBe("<data>/tmp/build/x.sock");
    expect(targetShape("/Users/someone/Library/Application Support/kiro-cli/agent-501.sock", places)).toBe("~/Library/Application Support/kiro-cli/agent-N.sock");
    expect(targetShape("/private/var/folders/ab/cdef0123_xyz/T/made-up.sock", places)).toBe("<temp>/T/made-up.sock");
    // A long run of letters a to f and digits is taken for a made-up id; other numbers become N one by one.
    expect(targetShape("/private/var/run/com.apple.launchd.AbCdEf0123/Listeners", places)).toBe("/private/var/run/com.apple.launchd.H/Listeners");
    expect(targetShape("/private/var/run/com.apple.launchd.Zq7Xw22Lm9K/Listeners", places)).toBe("/private/var/run/com.apple.launchd.ZqNXwNLmNK/Listeners");
    expect(targetShape("kern.proc.pgrp.86123", places)).toBe("kern.proc.pgrp.N");
    expect(targetShape("remote:*:4321", places)).toBe("local port 4321");
    expect(targetShape("local:*:4188", places)).toBe("local port 4188");
    expect(targetShape("remote:*:52044", places)).toBe("a local port (a short-lived one)");
    for (const target of ["/Users/someone/Documents/x.sock", "/Users/someone/.overnight-hardening/a", "/Users/someone/.kiro-hardening/crew/b"]) expect(targetShape(target, places), target).not.toContain("someone");
  });

  it("counts by program, verdict, kind and shape, and never prints a program's name that is not one a build starts", () => {
    const line = (program: string, verdict: string, operation: string, target: string) => parseDecision(`x Sandbox: ${program}(1) ${verdict} ${operation} ${target}`);
    const decisions = [
      line("python3.12", "allow", "network-outbound", "/Users/someone/.kiro-hardening/crew/mcp-gateway/gateway.sock"),
      line("python3.12", "allow", "network-outbound", "/Users/someone/.kiro-hardening/crew/mcp-gateway/gateway.sock"),
      line("python3.12", "allow", "sysctl-read", "kern.proc.pgrp.4401"),
      line("python3.12", "allow", "sysctl-read", "kern.proc.pgrp.4477"),
      // The system values every program reads as it starts: counted, not listed.
      line("python3.12", "allow", "sysctl-read", "hw.memsize"),
      line("python3.12", "allow", "sysctl-read", "kern.osproductversion"),
      line("node", "allow", "network-outbound", "remote:*:4188"),
      line("kiro-cli-chat", "deny(1)", "network-outbound", "/Users/someone/Library/made-up-agent/s.sock"),
      parseDecision("3 duplicate reports for Sandbox: kiro-cli-chat(1) deny(1) network-outbound /Users/someone/Library/made-up-agent/s.sock"),
      line("node", "deny(1)", "file-read-data", "/Users/someone/Documents/letter.txt"),
      line("Made Up Tool", "deny(1)", "network-outbound", "/Users/someone/Library/Mail/secret.sock"),
      line("com.made-up.helper", "allow", "process-exec*", "/Users/someone/bin/thing"),
    ].flatMap((decision) => decision ?? []);
    expect(decisions).toHaveLength(12);
    const counted = countDecisions(decisions, places);
    expect(counted).toEqual([
      // Its name is not on the list, so it is not printed. What it was refused still is, by shape.
      { what: "a program whose name is not on this script's list: allow process-exec* (targets not listed)", count: 1 },
      { what: "a program whose name is not on this script's list: deny network-outbound ~/Library/Mail/secret.sock", count: 1 },
      // One line and "3 duplicate reports": four tries.
      { what: "kiro-cli-chat: deny network-outbound ~/Library/made-up-agent/s.sock", count: 4 },
      { what: "node: allow network-outbound local port 4188", count: 1 },
      // A refusal the new rules are not about: counted, its target not listed.
      { what: "node: deny file-read-data (targets not listed)", count: 1 },
      { what: "python3.12: allow network-outbound <crew home>/mcp-gateway/gateway.sock", count: 2 },
      { what: "python3.12: allow sysctl-read (system values, not listed)", count: 2 },
      { what: "python3.12: allow sysctl-read kern.proc.pgrp.N", count: 2 },
    ]);
    const printed = JSON.stringify(counted);
    for (const never of ["someone", "Made Up Tool", "com.made-up.helper", "letter.txt", "hw.memsize"]) expect(printed, never).not.toContain(never);
  });
});

describe("the hardening proof script: the watcher's notes", () => {
  it("reads them: when each process number was this run's, how often it looked, what it heard and what it ended", () => {
    const watch = parseWatch(["b 1000", "p 501 1010", "p 502 1010", "x 501 1300", "p 501 5000", "x 9999 1400", "p 503 5200", "s 120 61 34", "k 2", "e 6000", ""].join("\n"));
    expect(watch.sightings).toEqual(
      new Map<number, Sighting[]>([
        // The same number twice: macOS gave it out again, to another program of this run.
        [501, [{ from: 1010, to: 1300 }, { from: 5000, to: null }]],
        [502, [{ from: 1010, to: null }]],
        [503, [{ from: 5200, to: null }]],
      ]),
    );
    expect(watch).toMatchObject({ samples: 120, longestGapMs: 61, marksHeard: 34, endedByWatcher: 2, finished: true });
  });

  it("knows a watcher that was cut off: no end line, and nothing made up from junk", () => {
    const cut = parseWatch("b 1000\np 501 1010\np 50");
    expect(cut.finished).toBe(false);
    expect(cut.samples).toBe(0);
    expect(cut.sightings).toEqual(new Map([[501, [{ from: 1010, to: null }]]]));
    for (const junk of ["", "hello", "p x y", "p 12", "x 12", "s 1 2", "q 1 2 3", "p 1e400 5"]) expect(parseWatch(junk), junk).toEqual({ sightings: new Map(), samples: 0, longestGapMs: 0, marksHeard: 0, endedByWatcher: 0, finished: false });
  });
});

// ---------- the last step ----------

/** 10:00 in the morning in Boise on a made-up day. Every time below is this many milliseconds plus a little. */
const T = Date.parse("2026-10-12T10:00:00.000-06:00");
/** A time the way macOS's log writes it. */
function stamp(ms: number): string {
  const local = new Date(ms - 6 * 3_600_000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 23)}000-0600`;
}
/** One line of macOS's log, read by the script's own reader. `after` is milliseconds after T. */
function logged(program: string, pid: number, verdict: "allow" | "deny", operation: string, target: string, after: number, options: { marked?: boolean; duplicates?: number; word?: string } = {}): Decision {
  const message = `${options.duplicates === undefined ? "" : `${options.duplicates} duplicate reports for `}Sandbox: ${program}(${pid}) ${verdict === "deny" ? "deny(1)" : "allow"} ${operation}${target === "" ? "" : ` ${target}`}${options.marked === true ? `\n${options.word ?? WORD}` : ""}`;
  const decision = parseDecision(message, { word: WORD, timestamp: stamp(T + after) });
  if (decision === null) throw new Error("the test made a line the script cannot read");
  return decision;
}
const refusedSocket = (program: string, pid: number, target: string, after: number, options: { duplicates?: number } = {}): Decision => logged(program, pid, "deny", "network-outbound", target, after, options);

const DATA = "/Users/someone/.overnight-hardening";
/** Four canaries, as the script makes them: both profiles, before and after everything else. */
const CANARIES: CanaryTry[] = [
  { label: "before, gateway profile", pid: 9001, target: `${DATA}/canary-1-0123456789abcdef.sock`, at: T + 100 },
  { label: "before, Kiro CLI profile", pid: 9002, target: `${DATA}/canary-2-0123456789abcdef.sock`, at: T + 300 },
  { label: "after, gateway profile", pid: 9003, target: `${DATA}/canary-3-0123456789abcdef.sock`, at: T + 60_100 },
  { label: "after, Kiro CLI profile", pid: 9004, target: `${DATA}/canary-4-0123456789abcdef.sock`, at: T + 60_300 },
];
/** What macOS logs for one canary: the program's start, marked with this run's word, and the refusal. */
const canaryLines = (canary: CanaryTry): Decision[] => [
  logged("sandbox-exec", canary.pid ?? 0, "allow", "process-exec*", "/usr/bin/nc", canary.at - T + 2, { marked: true }),
  refusedSocket("nc", canary.pid ?? 0, canary.target, canary.at - T + 9),
];
const ALL_CANARY_LINES = CANARIES.flatMap(canaryLines);
const started = (pid: number, from: number, to: number | null): { pid: number } & Sighting => ({ pid, from: T + from, to: to === null ? null : T + to });
function watched(sightings: Array<[number, number, number | null]> = [], more: Partial<Watch> = {}): Watch {
  const map = new Map<number, Sighting[]>();
  for (const [pid, from, to] of sightings) map.set(pid, [...(map.get(pid) ?? []), { from: T + from, to: to === null ? null : T + to }]);
  return { sightings: map, samples: 1_500, longestGapMs: 58, marksHeard: 240, endedByWatcher: 0, finished: true, ...more };
}
/** What the step took for this run's own, the canaries' own programs left out. */
const oursBesidesCanaries = (judgement: { ours: Decision[] }): Decision[] => judgement.ours.filter((decision) => !CANARIES.some((canary) => canary.pid === decision.pid));
/** A whole, healthy set of facts: the log read, every canary in it, the watcher finished. `more` are the other lines of the log. */
function facts(more: Decision[] = [], changes: Partial<LogFacts> = {}): LogFacts {
  return { decisions: [...ALL_CANARY_LINES, ...more], canaries: CANARIES, started: CANARIES.map((canary) => started(canary.pid ?? 0, canary.at - T, canary.at - T + 20)), watch: watched(), ...changes };
}

describe("the hardening proof script's last step: (a) it first proves that macOS's log was read", () => {
  it("passes a clean run: every canary found and refused, nothing else refused", () => {
    const judgement = judgeLog(facts());
    expect(judgement).toMatchObject({ verdict: "pass", canariesFound: 4, expected: 0, unexpected: [], others: 0, othersLikeOurs: 0 });
    expect(judgement.why).toBe("no socket file was refused to this run's own programs, other than the expected one");
  });

  it("says 'could not tell' when the log could not be read at all, where it used to pass", () => {
    const judgement = judgeLog(facts([], { decisions: null }));
    expect(judgement.verdict).toBe("could not tell");
    expect(judgement.why).toMatch(/macOS's log could not be read/);
    expect(judgement).toMatchObject({ canariesFound: 0, ours: [], unexpected: [] });
  });

  it("says 'could not tell' when the log was read and holds nothing, or holds other programs' lines only", () => {
    expect(judgeLog(facts([], { decisions: [] }))).toMatchObject({ verdict: "could not tell", canariesFound: 0 });
    const strangersOnly = judgeLog(facts([], { decisions: [refusedSocket("node", 700, SYSLOG_SOCKET, 500), logged("Made Up Mail", 701, "deny", "file-read-data", "/Users/someone/Library/x", 600)] }));
    expect(strangersOnly).toMatchObject({ verdict: "could not tell", canariesFound: 0, others: 2 });
    expect(strangersOnly.why).toMatch(/only 0 of this script's own 4 test refusals/);
  });

  it("says 'could not tell' when even one canary is missing: the first (the log does not reach back) or the last (it is not written yet)", () => {
    for (const missing of [0, 1, 2, 3]) {
      const without = CANARIES.filter((_, index) => index !== missing).flatMap(canaryLines);
      const judgement = judgeLog(facts([], { decisions: without }));
      expect(judgement, String(missing)).toMatchObject({ verdict: "could not tell", canariesFound: 3 });
      expect(judgement.why).toMatch(/only 3 of this script's own 4 test refusals are in what was read of macOS's log/);
    }
  });

  it("does not take another program's refusal of the same file, or a canary of another kind, for its canary", () => {
    const first = CANARIES[0];
    if (first === undefined) throw new Error("no canary");
    // The right file, refused to another process number: not this script's try.
    const impostor = [...CANARIES.slice(1).flatMap(canaryLines), logged("sandbox-exec", 9001, "allow", "process-exec*", "/usr/bin/nc", 102, { marked: true }), refusedSocket("nc", 4444, first.target, 109)];
    expect(judgeLog(facts([], { decisions: impostor }))).toMatchObject({ verdict: "could not tell", canariesFound: 3 });
    // The right file and number, but a file rule's refusal, not a connection's.
    const otherKind = [...CANARIES.slice(1).flatMap(canaryLines), logged("sandbox-exec", 9001, "allow", "process-exec*", "/usr/bin/nc", 102, { marked: true }), logged("nc", 9001, "deny", "file-read-data", first.target, 109)];
    expect(judgeLog(facts([], { decisions: otherKind }))).toMatchObject({ verdict: "could not tell", canariesFound: 3 });
  });

  it("says 'could not tell' when no canary was made", () => {
    const judgement = judgeLog(facts([], { canaries: [], decisions: [] }));
    expect(judgement.verdict).toBe("could not tell");
    expect(judgement.why).toMatch(/made none of its own test refusals/);
  });

  it("says 'could not tell' when the canaries' own programs do not carry this run's word, or carry another run's", () => {
    const unmarked = CANARIES.flatMap((canary) => [logged("sandbox-exec", canary.pid ?? 0, "allow", "process-exec*", "/usr/bin/nc", canary.at - T + 2), refusedSocket("nc", canary.pid ?? 0, canary.target, canary.at - T + 9)]);
    expect(judgeLog(facts([], { decisions: unmarked }))).toMatchObject({ verdict: "could not tell", canariesFound: 4 });
    const otherRun = CANARIES.flatMap((canary) => [logged("sandbox-exec", canary.pid ?? 0, "allow", "process-exec*", "/usr/bin/nc", canary.at - T + 2, { marked: true, word: "overnight-proof-ffffffffffffffff" }), refusedSocket("nc", canary.pid ?? 0, canary.target, canary.at - T + 9)]);
    const judgement = judgeLog(facts([], { decisions: otherRun }));
    expect(judgement.verdict).toBe("could not tell");
    expect(judgement.why).toMatch(/does not carry this run's word/);
  });

  it("does not take a marked line from another time for the canary's own: that number was another program's then", () => {
    // Each canary's number carries this run's word, but half a minute away from the canary itself.
    const elsewhen = CANARIES.flatMap((canary) => [logged("sandbox-exec", canary.pid ?? 0, "allow", "process-exec*", "/usr/bin/nc", canary.at - T + 30_000, { marked: true }), refusedSocket("nc", canary.pid ?? 0, canary.target, canary.at - T + 9)]);
    const judgement = judgeLog(facts([], { decisions: elsewhen }));
    expect(judgement).toMatchObject({ verdict: "could not tell", canariesFound: 4 });
    expect(judgement.why).toMatch(/does not carry this run's word/);
  });

  it("says 'could not tell' when the watcher left nothing, was cut off, never looked, or heard nothing of this run", () => {
    for (const watch of [null, watched([], { finished: false }), watched([], { samples: 0 })]) {
      const judgement = judgeLog(facts([], { watch }));
      expect(judgement.verdict).toBe("could not tell");
      expect(judgement.why).toMatch(/the watcher that notes this run's programs did not run to its end/);
    }
    const deaf = judgeLog(facts([], { watch: watched([], { marksHeard: 0 }) }));
    expect(deaf.verdict).toBe("could not tell");
    expect(deaf.why).toMatch(/heard nothing of this run/);
  });

  it("fails when a canary got through: the profile's rule about socket files is then not in force", () => {
    const last = CANARIES[3];
    if (last === undefined) throw new Error("no canary");
    const through = [...CANARIES.slice(0, 3).flatMap(canaryLines), logged("sandbox-exec", 9004, "allow", "process-exec*", "/usr/bin/nc", 60_302, { marked: true }), logged("nc", 9004, "allow", "network-outbound", last.target, 60_309, { marked: true })];
    const judgement = judgeLog(facts([], { decisions: through }));
    expect(judgement).toMatchObject({ verdict: "fail", canariesFound: 4 });
    expect(judgement.why).toMatch(/let this script's own test connection to a closed socket file through/);
  });

  it("puts what is certain before what could not be told: a refusal to one of this run's programs fails even with a canary missing", () => {
    const judgement = judgeLog(facts([refusedSocket("kiro-cli-chat", 600, "/Users/someone/Library/made-up/agent.sock", 5_000)], { decisions: [...CANARIES.slice(0, 3).flatMap(canaryLines), refusedSocket("kiro-cli-chat", 600, "/Users/someone/Library/made-up/agent.sock", 5_000)], watch: watched([[600, 4_000, 9_000]]) }));
    expect(judgement).toMatchObject({ verdict: "fail", canariesFound: 3 });
  });
});

describe("the hardening proof script's last step: (b) only this run's own programs count", () => {
  it("passes when other programs on the Mac were refused socket files in the same minutes, where it used to fail", () => {
    // The reviewer's case: an `nc` in somebody else's sandbox, refused twice. And what was seen on this Mac: 14 node and 6 browser refusals in five seconds.
    const others = [
      refusedSocket("nc", 3001, "/private/var/run/mDNSResponder", 2_000),
      refusedSocket("nc", 3002, "/private/var/run/mDNSResponder", 2_100),
      ...Array.from({ length: 14 }, (_, index) => refusedSocket("node", 3100 + index, SYSLOG_SOCKET, 3_000 + index * 300)),
      ...Array.from({ length: 6 }, (_, index) => refusedSocket("chrome-headless-shell", 3200 + index, SYSLOG_SOCKET, 3_050 + index * 700)),
      refusedSocket("Made Up Mail", 3300, "/Users/someone/Library/made-up/x.sock", 4_000),
    ];
    const judgement = judgeLog(facts(others));
    expect(judgement).toMatchObject({ verdict: "pass", expected: 0, unexpected: [], ours: expect.not.arrayContaining(others) });
    // Counted, in one number. Twenty-two of them went to a program with a build tool's name.
    expect(judgement.others).toBe(23);
    expect(judgement.othersLikeOurs).toBe(22);
  });

  it("counts a refusal to a program this script started itself, while it ran", () => {
    const refusal = refusedSocket("kiro-cli", 4100, "/Users/someone/Library/made-up/agent.sock", 10_050);
    const judgement = judgeLog(facts([refusal], { started: [...facts().started, started(4100, 10_000, 10_090)] }));
    expect(judgement).toMatchObject({ verdict: "fail", unexpected: [refusal], others: 0 });
    expect(judgement.why).toMatch(/a socket file other than the expected one was refused to this run's own programs \(1 time;/);
  });

  it("counts a refusal to a process the watcher noted, while it was noted", () => {
    const refusal = refusedSocket("python3.12", 4200, "/Users/someone/.made-up-tool/daemon.sock", 20_000);
    expect(judgeLog(facts([refusal], { watch: watched([[4200, 12_000, 31_000]]) }))).toMatchObject({ verdict: "fail", unexpected: [refusal] });
    // Still running at the end (the watcher ended it): noted from its first sighting on.
    expect(judgeLog(facts([refusal], { watch: watched([[4200, 12_000, null]]) }))).toMatchObject({ verdict: "fail", unexpected: [refusal] });
  });

  it("counts a refusal to a process the log itself marked with this run's word within a second, even when nothing else knew it", () => {
    // A program that lived a few milliseconds: started (marked), refused, gone before the watcher looked.
    const lines = [logged("sh", 4300, "allow", "process-exec*", "/usr/bin/git", 30_000, { marked: true }), logged("git", 4300, "allow", "sysctl-read", "hw.memsize", 30_003, { marked: true }), refusedSocket("git", 4300, "/Users/someone/.made-up-tool/cache.sock", 30_011)];
    const judgement = judgeLog(facts(lines));
    expect(judgement).toMatchObject({ verdict: "fail", others: 0 });
    expect(judgement.unexpected).toEqual([lines[2]]);
    expect(oursBesidesCanaries(judgement)).toEqual(lines);
  });

  it("does not count a refusal to the same process number at another time: macOS gives numbers out again", () => {
    // Number 4400 was this run's for half a second. Twenty seconds later, and two seconds before, it is somebody else's.
    const mine = { started: [...facts().started, started(4400, 10_000, 10_500)] };
    for (const after of [30_000, 8_000, 11_600]) {
      expect(judgeLog(facts([refusedSocket("node", 4400, "/Users/someone/Library/made-up/x.sock", after)], mine)), String(after)).toMatchObject({ verdict: "pass", others: 1, othersLikeOurs: 1 });
    }
    // Within a second either way it still counts: the watcher sees a process a moment after it starts.
    for (const after of [9_100, 10_250, 11_400]) expect(judgeLog(facts([refusedSocket("node", 4400, "/Users/someone/Library/made-up/x.sock", after)], mine)), String(after)).toMatchObject({ verdict: "fail" });
    // The same for the watcher's notes and for the log's marks.
    expect(judgeLog(facts([refusedSocket("node", 4401, "/Users/someone/Library/made-up/x.sock", 40_000)], { watch: watched([[4401, 5_000, 6_000]]) }))).toMatchObject({ verdict: "pass", others: 1 });
    expect(judgeLog(facts([logged("node", 4402, "allow", "sysctl-read", "hw.memsize", 5_000, { marked: true }), refusedSocket("node", 4402, "/Users/someone/Library/made-up/x.sock", 40_000)]))).toMatchObject({ verdict: "pass", others: 1 });
  });

  it("does not take another run's word for its own", () => {
    const lines = [logged("sh", 4500, "allow", "process-exec*", "/usr/bin/git", 30_000, { marked: true, word: "overnight-proof-ffffffffffffffff" }), refusedSocket("git", 4500, "/Users/someone/.made-up-tool/cache.sock", 30_011)];
    expect(judgeLog(facts(lines))).toMatchObject({ verdict: "pass", others: 2, othersLikeOurs: 1 });
  });

  it("counts the line macOS writes seconds later for repeated tries with the tries it repeats", () => {
    // Six tries by one process of ours: one line at once, and "5 duplicate reports" four seconds on, when the process is long gone.
    const first = refusedSocket("perl", 4600, "/Users/someone/.made-up-tool/a.sock", 10_010);
    const later = refusedSocket("perl", 4600, "/Users/someone/.made-up-tool/a.sock", 13_600, { duplicates: 5 });
    const judgement = judgeLog(facts([first, later], { started: [...facts().started, started(4600, 10_000, 10_040)] }));
    expect(judgement).toMatchObject({ verdict: "fail", unexpected: [first, later], others: 0 });
    expect(judgement.why).toMatch(/\(6 times;/);
    // The same late line about another program's tries stays another program's.
    expect(judgeLog(facts([refusedSocket("perl", 4601, "/Users/someone/.made-up-tool/a.sock", 13_600, { duplicates: 5 })]))).toMatchObject({ verdict: "pass", others: 5 });
  });
});

describe("the hardening proof script's last step: (c) one refusal is expected, every other one fails", () => {
  const withNode = { started: [...facts().started, started(5001, 10_000, 10_080), started(5002, 11_000, 11_080), started(5003, 12_000, 12_080)] };

  it("passes when node was refused the system log's socket file, and says how often", () => {
    const lines = [refusedSocket("node", 5001, SYSLOG_SOCKET, 10_030), refusedSocket("node", 5003, SYSLOG_SOCKET, 12_030), refusedSocket("node", 5003, SYSLOG_SOCKET, 15_800, { duplicates: 2 })];
    const judgement = judgeLog(facts(lines, withNode));
    expect(judgement).toMatchObject({ verdict: "pass", expected: 4, unexpected: [], others: 0 });
    expect(oursBesidesCanaries(judgement)).toEqual(lines);
    expect(SYSLOG_SOCKET).toBe("/private/var/run/syslog");
  });

  it("fails on any other socket file refused to one of this run's programs, and hands back what to print by shape", () => {
    const lines = [refusedSocket("node", 5001, SYSLOG_SOCKET, 10_030), refusedSocket("node", 5002, "/Users/someone/Library/Application Support/made-up-tool/agent-501.sock", 11_030), refusedSocket("node", 5003, "/private/var/run/made-up.sock", 12_030)];
    const judgement = judgeLog(facts(lines, withNode));
    expect(judgement).toMatchObject({ verdict: "fail", expected: 1 });
    expect(judgement.unexpected).toEqual(lines.slice(1));
    expect(judgement.why).toMatch(/\(2 times;/);
    const printed = countDecisions(judgement.unexpected, { dataDir: DATA, kiroHome: "/Users/someone/.kiro-hardening", crewHome: "/Users/someone/.kiro-hardening/crew", home: "/Users/someone" });
    expect(printed).toEqual([
      { what: "node: deny network-outbound /private/var/run/made-up.sock", count: 1 },
      { what: "node: deny network-outbound ~/Library/Application Support/made-up-tool/agent-N.sock", count: 1 },
    ]);
  });

  it("does not stretch the expected one: the same socket refused to another program, or node refused another file under that folder, fails", () => {
    expect(judgeLog(facts([refusedSocket("python3.12", 5001, SYSLOG_SOCKET, 10_030)], withNode))).toMatchObject({ verdict: "fail", expected: 0 });
    expect(judgeLog(facts([refusedSocket("node-helper", 5001, SYSLOG_SOCKET, 10_030)], withNode))).toMatchObject({ verdict: "fail", expected: 0 });
    expect(judgeLog(facts([refusedSocket("node", 5001, `${SYSLOG_SOCKET}.other`, 10_030)], withNode))).toMatchObject({ verdict: "fail", expected: 0 });
  });

  it("is only about socket files: a refused port, a refused file and an allowed socket file do not fail it", () => {
    const lines = [
      logged("nc", 5001, "deny", "network-outbound", "remote:*:4321", 10_030),
      logged("node", 5002, "deny", "file-read-data", "/Users/someone/Documents/letter.txt", 11_030),
      logged("node", 5002, "deny", "mach-lookup", "com.apple.coreservices.launchservicesd", 11_040),
      logged("python3.12", 5003, "allow", "network-outbound", "/Users/someone/Library/made-up/reported.sock", 12_030, { marked: true }),
    ];
    const judgement = judgeLog(facts(lines, withNode));
    expect(judgement).toMatchObject({ verdict: "pass", expected: 0, unexpected: [] });
    expect(oursBesidesCanaries(judgement)).toEqual(lines);
  });
});

describe("the hardening proof script: reading macOS's log through the real reader", () => {
  /** A made-up stand-in for /usr/bin/log: it writes down how it was called, prints what the test gives it, and ends as told. */
  function standIn(prints: string, exitCode = 0): { program: string; calledWith: () => string } {
    const dir = tempDir("overnight-proof-log-");
    const program = path.join(dir, "log");
    writeFileSync(path.join(dir, "prints.txt"), prints);
    writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/called.txt"\n/bin/cat "${dir}/prints.txt"\nexit ${exitCode}\n`);
    chmodSync(program, 0o755);
    return { program, calledWith: () => readFileSync(path.join(dir, "called.txt"), "utf8") };
  }
  const event = (message: string, after: number): string => JSON.stringify({ eventMessage: message, timestamp: stamp(T + after), processImagePath: "/kernel" });

  it("asks for the sandbox's own lines since the run began, one event to a line", () => {
    const log = standIn("");
    expect(readDecisions(new Date(2026, 9, 12, 10, 0, 7), WORD, log.program)).toEqual([]);
    expect(log.calledWith().split("\n").slice(0, 6)).toEqual(["show", "--start", "2026-10-12 10:00:07", "--style", "ndjson", "--predicate"]);
    expect(log.calledWith()).toContain('process == "kernel" AND sender == "Sandbox" AND eventMessage CONTAINS "Sandbox: "');
  });

  it("reads each event, skips what is not one, and never fails on a line it cannot read", () => {
    const log = standIn(
      [
        "Filtering the log data using a made-up header line",
        event(`Sandbox: sandbox-exec(9001) allow process-exec* /usr/bin/nc\n${WORD}`, 102),
        event(`Sandbox: nc(9001) deny(1) network-outbound ${DATA}/canary-1-0123456789abcdef.sock`, 109),
        event("5 duplicate reports for Sandbox: perl(613) deny(1) network-outbound /private/var/run/made-up.sock", 4_000),
        event("something the sandbox said that is not a decision", 4_100),
        '{"eventMessage": 12}',
        "{ not json",
        "",
      ].join("\n"),
    );
    const decisions = readDecisions(new Date(T), WORD, log.program);
    expect(decisions).toHaveLength(3);
    expect(decisions?.[0]).toMatchObject({ program: "sandbox-exec", pid: 9001, marked: true, at: T + 102 });
    expect(decisions?.[1]).toMatchObject({ program: "nc", pid: 9001, verdict: "deny", marked: false, at: T + 109 });
    expect(decisions?.[2]).toMatchObject({ program: "perl", count: 5, repeats: true });
  });

  it("answers null, not 'nothing was refused', when the log program fails or is not there: the last step then cannot tell", () => {
    // The reviewer's harness: the log program replaced by one that fails. The step used to pass.
    const failing = standIn(event(`Sandbox: nc(9001) deny(1) network-outbound ${DATA}/canary-1-0123456789abcdef.sock`, 109), 1);
    expect(readDecisions(new Date(T), WORD, failing.program)).toBeNull();
    expect(readDecisions(new Date(T), WORD, path.join(tempDir("overnight-proof-log-"), "no-such-program"))).toBeNull();
    expect(judgeLog(facts([], { decisions: readDecisions(new Date(T), WORD, failing.program) })).verdict).toBe("could not tell");
    // A log program that works and prints nothing gives an empty list, which the last step does not believe either.
    expect(judgeLog(facts([], { decisions: readDecisions(new Date(T), WORD, standIn("").program) })).verdict).toBe("could not tell");
  });

  it("reads the log as bytes, a line at a time: letters outside ASCII stay whole, and a last line with no line end is read", () => {
    // After a hold the log can be longer than the longest text Node can hold, so it is never made into one text.
    const text = [event(`Sandbox: nc(9001) deny(1) network-outbound ${DATA}/caf\u00e9 \u2014 \u65e5\u672c/made-up.sock`, 109), "", "\u00e9 not an event", event("Sandbox: node(5001) deny(1) network-outbound /private/var/run/syslog", 200)].join("\n");
    expect(text.endsWith("\n")).toBe(false);
    const decisions = readDecisions(new Date(T), WORD, standIn(text).program);
    expect(decisions).toHaveLength(2);
    expect(decisions?.[0]).toMatchObject({ program: "nc", pid: 9001, target: `${DATA}/caf\u00e9 \u2014 \u65e5\u672c/made-up.sock`, at: T + 109 });
    expect(decisions?.[1]).toMatchObject({ program: "node", pid: 5001, target: SYSLOG_SOCKET, at: T + 200 });
    // Line ends of the other kind, as a program on another system would write them, change nothing.
    expect(readDecisions(new Date(T), WORD, standIn(text.split("\n").join("\r\n")).program)).toHaveLength(2);
  });

  it("goes from the log's text to the answer: a whole run's lines pass, with a stranger's refusal in them", () => {
    const text = [
      ...CANARIES.flatMap((canary) => [event(`Sandbox: sandbox-exec(${canary.pid}) allow process-exec* /usr/bin/nc\n${WORD}`, canary.at - T + 2), event(`Sandbox: nc(${canary.pid}) deny(1) network-outbound ${canary.target}`, canary.at - T + 9)]),
      event("Sandbox: nc(3001) deny(1) network-outbound /private/var/run/mDNSResponder", 2_000),
      event(`Sandbox: node(5001) allow sysctl-read hw.memsize\n${WORD}`, 10_020),
      event(`Sandbox: node(5001) deny(1) network-outbound ${SYSLOG_SOCKET}`, 10_030),
    ].join("\n");
    const judgement = judgeLog(facts([], { decisions: readDecisions(new Date(T), WORD, standIn(text).program) }));
    expect(judgement).toMatchObject({ verdict: "pass", canariesFound: 4, expected: 1, others: 1, othersLikeOurs: 1 });
  });
});

// ---------- hold: the gateway that stays up while a rehearsal builds through it ----------

/** The script's own text: what it says at its top, and how its modes are put together. */
const SCRIPT = readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "spikes", "11-hardening-proof.ts"), "utf8");
/** The text of one of the script's functions, from its first line to the first line that is only "}". */
function functionText(firstLine: string): string {
  const from = SCRIPT.indexOf(firstLine);
  expect(from, firstLine).toBeGreaterThan(-1);
  return SCRIPT.slice(from, SCRIPT.indexOf("\n}\n", from));
}

describe("the hardening proof script: the order of its modes", () => {
  it("runs check, p1, p2 and then hold, and each one names the next", () => {
    expect([...PROOF_ORDER]).toEqual(["check", "p1", "p2 --spend-credits", "hold"]);
    expect(nextInOrder("check")).toBe("p1");
    expect(nextInOrder("p1")).toBe("p2 --spend-credits");
    expect(nextInOrder("p2")).toBe("hold");
    expect(nextInOrder("hold")).toBeNull();
    for (const other of ["", "p3", "p2 --spend-credits", "HOLD"]) expect(nextInOrder(other), other).toBeNull();
  });

  it("lists them in that order at its top, each with every value it needs", () => {
    const usage = SCRIPT.slice(0, SCRIPT.indexOf("\nimport "))
      .split("\n")
      .filter((line) => /^\/\/ {3}OVERNIGHT_DATA_DIR=.* node spikes\/11-hardening-proof\.ts /.test(line));
    expect(usage.map((line) => line.split("node spikes/11-hardening-proof.ts ")[1])).toEqual([...PROOF_ORDER]);
    // Only the check runs without a Kiro home and a port of its own.
    for (const line of usage.slice(1)) expect(line).toMatch(/KIRO_HOME=~\/\.kiro-hardening KIROCREW_PORT=5478 /);
    // And the last lines of a run name the next mode through the same list.
    expect(SCRIPT).toContain("const next = nextInOrder(mode);");
    expect(SCRIPT).toContain('${PROOF_ORDER.join(" | ")}');
  });

  it("gets a hold's gateway up through the very steps p1 uses, and no others", () => {
    const up = "await throwawayGatewayUp(places, tools);";
    expect(SCRIPT.split(up)).toHaveLength(3);
    expect(functionText("async function proofOne(")).toContain(up);
    const hold = functionText("async function proofHold(");
    expect(hold).toContain(up);
    // Nothing of its own: no second way to start a gateway, to write a profile, or to change a setting.
    for (const own of ["startGateway(", "writeProfileCopies(", "prepareThrowawayHome(", "startWatcher(", "spawn(", "spawnSync("]) expect(hold, own).not.toContain(own);
    // In p1's order: the throwaway home and its settings, the profile copies, the watcher, the canaries and the proof that the log is read, and only then the gateway, inside the gateway copy.
    const steps = ["prepareThrowawayHome(places, tools);", "writeProfileCopies(places);", "startWatcher(places);", 'canaries(places, "before");', "await proveLastStepCanWork(places);", "await startGateway(places, places.profiles.gateway, tools.kirocrewReal);"];
    const body = functionText("async function throwawayGatewayUp(");
    const found = steps.map((step) => body.indexOf(step));
    expect(found.every((at) => at > -1)).toBe(true);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
    // It ends with the last step p1 ends with, and it spends nothing: it adds no job and sends Kiro no words.
    expect(hold).toContain("await judgeRun(places,");
    expect(functionText("async function lastStep(")).toContain("await judgeRun(places)");
    for (const spending of ["addJob(", "trigger(", "sandboxedKiroArgs(", "ONE_LINE("]) expect(hold, spending).not.toContain(spending);
  });

  it("refuses to start a hold wherever it refuses p1: both ask for a gateway, so both pass the same refusals", () => {
    const main = functionText("async function main(");
    expect(main).toContain('const gatewayNeeded = mode !== "check";');
    // Nothing in the refusals is about p1 alone.
    expect(main.slice(0, main.indexOf("mkdirSync(dataDir"))).not.toMatch(/mode === "p1"/);
    expect(main.indexOf("inQuietHours(new Date()")).toBeLessThan(main.indexOf("mkdirSync(dataDir"));
  });
});

describe("the hardening proof script: what a hold tells the rehearsal", () => {
  const home = "/Users/someone";
  const places = { dataDir: `${home}/.overnight-hardening`, kiroHome: `${home}/.kiro-hardening`, crewHome: `${home}/.kiro-hardening/crew`, port: 5478 };
  /** A line pasted into a shell whose home folder is `home`: what the command after it is then given. */
  function pasted(line: string, shellHome: string): Record<string, string> {
    const result = spawnSync("/bin/sh", ["-c", `${line} /usr/bin/env`], { encoding: "utf8", env: { HOME: shellHome, PATH: "/usr/bin:/bin" } });
    expect(result.status).toBe(0);
    return Object.fromEntries(
      result.stdout
        .split("\n")
        .filter((row) => row.includes("="))
        .map((row) => [row.slice(0, row.indexOf("=")), row.slice(row.indexOf("=") + 1)]),
    );
  }

  it("names the four values a rehearsal needs, in one order", () => {
    expect(holdEnvironment(places)).toEqual([
      ["OVERNIGHT_DATA_DIR", "/Users/someone/.overnight-hardening"],
      ["KIRO_HOME", "/Users/someone/.kiro-hardening"],
      ["KIROCREW_HOME", "/Users/someone/.kiro-hardening/crew"],
      ["KIROCREW_PORT", "5478"],
    ]);
  });

  it("prints them as the start of one command line, with the home folder as $HOME and never as ~ or by the account's name", () => {
    const line = holdEnvironmentLine(holdEnvironment(places), home);
    expect(line).toBe('OVERNIGHT_DATA_DIR="$HOME/.overnight-hardening" KIRO_HOME="$HOME/.kiro-hardening" KIROCREW_HOME="$HOME/.kiro-hardening/crew" KIROCREW_PORT=5478');
    expect(line).not.toContain("~");
    expect(line).not.toContain("someone");
  });

  it("gives a shell that is handed the line the full paths and the port, also with a space in a folder's name", () => {
    const madeUp = path.join(tempDir("overnight-proof-test-"), "a home");
    const own = { dataDir: path.join(madeUp, ".overnight-hardening"), kiroHome: path.join(madeUp, ".kiro hardening"), crewHome: path.join(madeUp, ".kiro hardening", "crew"), port: 5999 };
    const line = holdEnvironmentLine(holdEnvironment(own), madeUp);
    expect(line).toContain('KIRO_HOME="$HOME/.kiro hardening"');
    const got = pasted(line, madeUp);
    expect(got).toMatchObject({ OVERNIGHT_DATA_DIR: own.dataDir, KIRO_HOME: own.kiroHome, KIROCREW_HOME: own.crewHome, KIROCREW_PORT: "5999" });
    // Read the way a rehearsal's builder reads them, they are the throwaway folders and port.
    expect(defaultKiroHome(got)).toBe(own.kiroHome);
    expect(defaultCrewHome(got)).toBe(own.crewHome);
    expect(gatewayPort(got)).toBe(5999);
  });

  it("is written with $HOME because of what the builder does with a folder that is not a full path: it uses the real one", () => {
    // What "~" becomes where a shell does not open it up: inside quotes, after `env`, in a tool that sets values itself.
    const literal = { KIRO_HOME: "~/.kiro-hardening", KIROCREW_HOME: "~/.kiro-hardening/crew", KIROCREW_PORT: "5478" };
    expect(defaultKiroHome(literal)).toBe(path.join(homedir(), ".kiro"));
    expect(defaultCrewHome(literal)).toBe(path.join(homedir(), ".kiro", "crew"));
    // And a rehearsal without the port would talk to the gateway that builds every night.
    expect(gatewayPort({})).toBe(DEFAULT_GATEWAY_PORT);
    expect(gatewayPort(literal)).toBe(5478);
  });

  it("writes any value as one word of a command line that a shell reads back unchanged", () => {
    expect(shellWord("/Users/someone/.overnight-hardening/hold.stop", home)).toBe('"$HOME/.overnight-hardening/hold.stop"');
    expect(shellWord("5478", home)).toBe("5478");
    expect(shellWord("/private/tmp/x-1/y.z", home)).toBe("/private/tmp/x-1/y.z");
    expect(shellWord("/Users/someone-else/x", home)).toBe("/Users/someone-else/x");
    expect(shellWord("/tmp/it's here", home)).toBe("'/tmp/it'\\''s here'");
    expect(shellWord("", home)).toBe("''");
    // Anything a shell would act on is put in single quotes, where it acts on nothing.
    const madeUp = path.join(tempDir("overnight-proof-test-"), "home");
    for (const value of ["plain", `${madeUp}/in/home`, `${madeUp}/with space/x`, `${madeUp}/with$dollar`, `${madeUp}/with"quote`, `${madeUp}/back\`tick\``, `${madeUp}/semi;colon && true`, "/else where/$(true)/it's", "a=b", "*", "~/x", ""]) {
      const word = shellWord(value, madeUp);
      const back = spawnSync("/bin/sh", ["-c", `printf %s ${word}`], { encoding: "utf8", env: { HOME: madeUp, PATH: "/usr/bin:/bin" }, cwd: madeUp.replace(/home$/, "") });
      expect(back.stdout, value).toBe(value);
    }
  });

  it("puts the stop file in the data folder itself, which both sandboxes close to every job", () => {
    expect(holdStopFile("/Users/someone/.overnight-hardening")).toBe("/Users/someone/.overnight-hardening/hold.stop");
    // Not in a folder a job may write: its workspace, the build's temporary folder, the finished builds.
    expect(path.dirname(holdStopFile(places.dataDir))).toBe(places.dataDir);
    for (const [label, file] of [
      ["gateway", CREW_GATEWAY_SANDBOX_PROFILE],
      ["Kiro CLI", KIRO_CLI_SANDBOX_PROFILE],
    ] as const) {
      expect(readFileSync(file, "utf8"), label).toMatch(/\(deny file-read\* file-write\* process-exec\*\n(?: {2}[^\n]*\n)* {2}\(subpath data-dir\)\)/);
    }
  });

  it("says, once the gateway answers, what to give a rehearsal, how to end the hold, and when it ends by itself", () => {
    const environment = holdEnvironmentLine(holdEnvironment(places), home);
    const lines = holdInstructions({ environment, stopFile: holdStopFile(places.dataDir), limitAt: "16:40:12", home });
    const text = lines.join("\n");
    // The four values on a line of their own, to copy, and once more in front of the command they go with.
    expect(lines).toContain(`  ${environment}`);
    expect(lines).toContain(`  ${environment} npx overnight rehearse run <ideaId> --no-publish`);
    // What happens without them: the real gateway, or Kiro's real folders.
    expect(text).toContain("without KIROCREW_PORT to the gateway that builds every night (port 5476)");
    expect(text).toContain("without KIROCREW_HOME or KIRO_HOME to Kiro's real folders");
    // Three ways to end it, one of which needs no process number.
    expect(text).toContain("Ctrl-C in this window, or a stop signal, or from any shell (no process number is needed):");
    expect(lines).toContain('  touch "$HOME/.overnight-hardening/hold.stop"');
    // And the ends nobody asks for.
    expect(text).toContain("at 16:40:12 (100 minutes from now)");
    expect(text).toContain("when the hours of the night's build or delivery begin (00:45 and 06:15)");
    expect(text).toContain("when the gateway or the watcher is gone");
    expect(text).toContain("the gateway and everything it started are stopped, and then macOS's log is read for the whole time it was up");
    expect(text).not.toContain("someone");
  });
});

describe("the hardening proof script: when a hold ends", () => {
  /** A hold with nothing to end it. */
  const quiet: HoldLook = { gatewayRunning: true, watcherRunning: true, asked: false, stopFile: false, quietHours: false, upForMs: 5 * 60_000 };

  it("goes on while its gateway and its watcher run and nothing asks it to end", () => {
    expect(holdEnd(quiet)).toBeNull();
    expect(holdEnd({ ...quiet, upForMs: 0 })).toBeNull();
    expect(holdEnd({ ...quiet, upForMs: HOLD_LIMIT_MS - 1 })).toBeNull();
  });

  it("ends on a stop signal, on the stop file, when its gateway or its watcher is gone, at night, and when its time is up", () => {
    expect(holdEnd({ ...quiet, asked: true })).toBe("asked");
    expect(holdEnd({ ...quiet, stopFile: true })).toBe("stop-file");
    expect(holdEnd({ ...quiet, gatewayRunning: false })).toBe("gateway-gone");
    expect(holdEnd({ ...quiet, watcherRunning: false })).toBe("watcher-gone");
    expect(holdEnd({ ...quiet, quietHours: true })).toBe("quiet-hours");
    expect(holdEnd({ ...quiet, upForMs: HOLD_LIMIT_MS })).toBe("time-limit");
    expect(holdEnd({ ...quiet, upForMs: 3_000 }, 3_000)).toBe("time-limit");
    expect(holdEnd({ ...quiet, upForMs: 2_999 }, 3_000)).toBeNull();
  });

  it("puts what went wrong before what was asked for: a gateway that ended by itself is not hidden by a stop file or a signal", () => {
    const everything: HoldLook = { gatewayRunning: false, watcherRunning: false, asked: true, stopFile: true, quietHours: true, upForMs: HOLD_LIMIT_MS * 2 };
    const order: HoldEnd[] = ["gateway-gone", "watcher-gone", "asked", "stop-file", "quiet-hours", "time-limit"];
    const mend: Array<Partial<HoldLook>> = [{ gatewayRunning: true }, { watcherRunning: true }, { asked: false }, { stopFile: false }, { quietHours: false }, { upForMs: 0 }];
    let look = everything;
    for (const [index, expected] of order.entries()) {
      expect(holdEnd(look), expected).toBe(expected);
      look = { ...look, ...mend[index] };
    }
    expect(holdEnd(look)).toBeNull();
  });

  it("has a plain sentence for every way a hold ends", () => {
    const ends: HoldEnd[] = ["gateway-gone", "watcher-gone", "asked", "stop-file", "quiet-hours", "time-limit"];
    expect(Object.keys(HOLD_END_WORDS).sort()).toEqual([...ends].sort());
    for (const end of ends) expect(HOLD_END_WORDS[end], end).toMatch(/^[a-z][^\n]{10,120}[a-z)]$/);
    expect(HOLD_END_WORDS["time-limit"]).toContain("100 minutes");
    expect(HOLD_END_WORDS["stop-file"]).toContain("hold.stop");
  });

  it("stays up no longer than the watcher listens to macOS's log, with time to spare for the start and the last step", () => {
    expect(HOLD_LIMIT_MS).toBe(100 * 60_000);
    // The watcher's follower of the log ends by itself after two hours.
    expect(SCRIPT).toContain('["stream", "--timeout", "2h",');
    expect(2 * 3_600_000 - HOLD_LIMIT_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("looks, pauses and looks again until something ends it, and says after each look that it is still up", async () => {
    const looks: HoldLook[] = [quiet, { ...quiet, upForMs: 6 * 60_000 }, { ...quiet, upForMs: 7 * 60_000 }, { ...quiet, upForMs: 8 * 60_000, stopFile: true }, { ...quiet, gatewayRunning: false }];
    const pauses: number[] = [];
    const stillUp: number[] = [];
    let looked = 0;
    const end = await waitForHoldEnd({
      look: () => looks[looked++] ?? { ...quiet, gatewayRunning: false },
      pause: async (ms) => void pauses.push(ms),
      stillUp: (look) => stillUp.push(look.upForMs),
    });
    expect(end).toBe("stop-file");
    // Four looks, a pause after each of the first three, and it never looked again once it knew.
    expect(looked).toBe(4);
    expect(pauses).toEqual([500, 500, 500]);
    expect(stillUp).toEqual([5 * 60_000, 6 * 60_000, 7 * 60_000]);
  });

  it("ends at the first look when there is already a reason, without a pause", async () => {
    const pauses: number[] = [];
    expect(await waitForHoldEnd({ look: () => ({ ...quiet, asked: true }), pause: async (ms) => void pauses.push(ms) })).toBe("asked");
    expect(pauses).toEqual([]);
  });

  it("keeps to the time limit and the pause it is given, and ends when a pause is cut short by a signal", async () => {
    let now = 0;
    const end = await waitForHoldEnd({ look: () => ({ ...quiet, upForMs: now }), pause: async (ms) => void (now += ms), limitMs: 1_000, everyMs: 300 });
    expect(end).toBe("time-limit");
    expect(now).toBe(1_200);
    // A stop signal cuts the pause short; the very next look sees it.
    let asked = false;
    let looked = 0;
    const bySignal = await waitForHoldEnd({ look: () => ((looked += 1), { ...quiet, asked }), pause: async () => void (asked = true) });
    expect(bySignal).toBe("asked");
    expect(looked).toBe(2);
  });
});

describe("the hardening proof script: one look at a hold", () => {
  const running = { pid: 4242, exitCode: null, signalCode: null };
  /** Noon in Boise on a made-up day, and one o'clock that night. */
  const [NOON, NIGHT] = [Date.parse("2026-10-12T12:00:00-06:00"), Date.parse("2026-10-13T01:00:00-06:00")];
  function held(more: Partial<Held> = {}): Held {
    return { stopFile: holdStopFile(tempDir("overnight-proof-test-")), gateway: running, watcher: running, sinceMs: NOON - 90_000, timeZone: "America/Boise", ...more };
  }

  it("sees a hold that goes on: both processes running, no stop file, daytime, and for how long it has been up", () => {
    expect(lookAtHold(held(), false, NOON)).toEqual({ gatewayRunning: true, watcherRunning: true, asked: false, stopFile: false, quietHours: false, upForMs: 90_000 });
    expect(holdEnd(lookAtHold(held(), false, NOON))).toBeNull();
  });

  it("sees a process that has ended, was killed, never started, or was never there", () => {
    for (const gone of [{ pid: 4242, exitCode: 0, signalCode: null }, { pid: 4242, exitCode: 1, signalCode: null }, { pid: 4242, exitCode: null, signalCode: "SIGKILL" as const }, { pid: undefined, exitCode: null, signalCode: null }, null]) {
      expect(lookAtHold(held({ gateway: gone }), false, NOON), JSON.stringify(gone)).toMatchObject({ gatewayRunning: false, watcherRunning: true });
      expect(lookAtHold(held({ watcher: gone }), false, NOON), JSON.stringify(gone)).toMatchObject({ gatewayRunning: true, watcherRunning: false });
    }
    expect(holdEnd(lookAtHold(held({ gateway: null }), false, NOON))).toBe("gateway-gone");
    expect(holdEnd(lookAtHold(held({ watcher: null }), false, NOON))).toBe("watcher-gone");
  });

  it("sees the stop file as soon as anything has that name: a file, an empty one, a link that points nowhere", () => {
    const withFile = held();
    writeFileSync(withFile.stopFile, "");
    expect(lookAtHold(withFile, false, NOON).stopFile).toBe(true);
    expect(holdEnd(lookAtHold(withFile, false, NOON))).toBe("stop-file");
    const withLink = held();
    symlinkSync(path.join(path.dirname(withLink.stopFile), "nowhere"), withLink.stopFile);
    expect(lookAtHold(withLink, false, NOON).stopFile).toBe(true);
    // A file of another name beside it is not it, and neither is a missing data folder.
    const other = held();
    writeFileSync(`${other.stopFile}.txt`, "");
    expect(lookAtHold(other, false, NOON).stopFile).toBe(false);
    expect(lookAtHold(held({ stopFile: path.join(path.dirname(other.stopFile), "not-there", "hold.stop") }), false, NOON).stopFile).toBe(false);
  });

  it("passes on that it was asked to end, and tells the night's hours by the clock of the time zone it is given", () => {
    expect(lookAtHold(held(), true, NOON).asked).toBe(true);
    expect(holdEnd(lookAtHold(held(), true, NOON))).toBe("asked");
    expect(lookAtHold(held(), false, NIGHT)).toMatchObject({ quietHours: true, upForMs: 13 * 3_600_000 + 90_000 });
    expect(holdEnd(lookAtHold(held({ sinceMs: NIGHT - 60_000 }), false, NIGHT))).toBe("quiet-hours");
    // The minute before the build's hours begin, and the minute they begin.
    expect(lookAtHold(held(), false, Date.parse("2026-10-13T00:44:59-06:00")).quietHours).toBe(false);
    expect(lookAtHold(held(), false, Date.parse("2026-10-13T00:45:00-06:00")).quietHours).toBe(true);
    // One o'clock at night in Boise is the morning in Paris.
    expect(lookAtHold(held({ timeZone: "Europe/Paris" }), false, NIGHT).quietHours).toBe(false);
  });

  it("uses the clock of this Mac when it is given none", () => {
    const before = Date.now();
    const look = lookAtHold(held({ sinceMs: before - 1_000 }), false);
    expect(look.upForMs).toBeGreaterThanOrEqual(1_000);
    expect(look.upForMs).toBeLessThan(60_000);
  });
});
