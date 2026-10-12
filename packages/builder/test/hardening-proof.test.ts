// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The tools of spikes/11-hardening-proof.ts, the script that proves the sandbox profiles on a
// throwaway Kiro Crew gateway: what it refuses to run on, the copies it makes of the profiles,
// and how it turns macOS's log into counts. No gateway, no Kiro program and no sandbox is started
// here; the script's own zero-credit self-check (`node spikes/11-hardening-proof.ts check`) does
// the parts that need a real sandbox.
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { DASHBOARD_PORT } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { countDecisions, dataDirProblem, inQuietHours, kiroHomeProblem, overlaps, parseDecision, portProblem, targetShape, withReportLines } from "../../../spikes/11-hardening-proof.ts";
import { CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE } from "../src/index.ts";
import { DEFAULT_GATEWAY_PORT } from "../src/crew-client.ts";
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
    // The sandbox closes the temporary folders: a build there could not see its own workspace.
    expect(dataDirProblem("/private/tmp/overnight-proof", realData, home)).toMatch(/inside the home folder/);
    expect(dataDirProblem(path.join(path.dirname(home), "beside-home"), realData, home)).toMatch(/inside the home folder/);
    expect(dataDirProblem("relative/folder", realData, home)).toMatch(/full path/);
    for (const none of [undefined, "", "   "]) expect(dataDirProblem(none, realData, home)).toMatch(/OVERNIGHT_DATA_DIR is not set/);
  });

  it("refuses Kiro's real folder and Kiro Crew's real home in it, by any name", () => {
    const { home, realKiro } = madeUpHome();
    const link = path.join(home, "elsewhere", "kiro-link");
    symlinkSync(realKiro, link);
    for (const folder of [realKiro, path.join(realKiro, "crew"), path.join(realKiro, "crew", "run"), home, link, path.join(link, "crew")]) {
      expect(kiroHomeProblem(folder, realKiro), folder).toMatch(/Kiro's real folder/);
    }
    expect(kiroHomeProblem(path.join(home, ".kiro-hardening"), realKiro)).toBeNull();
    expect(kiroHomeProblem(undefined, realKiro)).toMatch(/KIRO_HOME is not set/);
    expect(kiroHomeProblem("kiro-here", realKiro)).toMatch(/full path/);
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

describe("the hardening proof script: its copies of the profiles", () => {
  for (const [label, file] of [
    ["gateway", CREW_GATEWAY_SANDBOX_PROFILE],
    ["Kiro CLI", KIRO_CLI_SANDBOX_PROFILE],
  ] as const) {
    it(`adds lines that only report to the ${label} profile, right after its first rule, and changes nothing else`, () => {
      const shipped = readFileSync(file, "utf8");
      const copy = withReportLines(shipped);
      const added = copy.split("\n").filter((line) => !shipped.split("\n").includes(line));
      // One comment and four rules; every rule allows, and reports.
      expect(added).toHaveLength(5);
      expect(added[0]).toMatch(/^;; .*report and refuse nothing/);
      for (const rule of added.slice(1)) expect(rule).toMatch(/^\(allow (network-outbound|network-bind|sysctl-read) .*\(with report\)\)$/);
      expect(copy.startsWith(shipped.slice(0, shipped.indexOf("(allow default)\n") + "(allow default)\n".length))).toBe(true);
      // Everything of the shipped file follows the added lines, byte for byte: its rules come later, so they still have the last word.
      const rest = shipped.slice(shipped.indexOf("(allow default)\n") + "(allow default)\n".length);
      expect(copy.endsWith(rest)).toBe(true);
      expect(copy.indexOf(added[4] ?? "x")).toBeLessThan(copy.indexOf(rest.trimStart().split("\n")[0] ?? "x"));
      // It asks for the same values, so it is started exactly as the shipped file is.
      expect(profileParams(copy)).toEqual(profileParams(shipped));
      expect(copy).not.toMatch(/^\(deny .*with report/m);
    });
  }

  it("refuses a file that does not begin the way our profiles do", () => {
    expect(() => withReportLines("(version 1)\n(deny default)\n")).toThrow(/does not begin the way ours do/);
    expect(() => withReportLines("")).toThrow();
  });
});

describe("the hardening proof script: what the sandbox decided, as counts", () => {
  const places = { dataDir: "/Users/someone/.overnight-hardening", kiroHome: "/Users/someone/.kiro-hardening", crewHome: "/Users/someone/.kiro-hardening/crew", home: "/Users/someone" };

  it("reads a line of macOS's log as a decision: program, allowed or refused, kind of thing, target", () => {
    expect(parseDecision("2026-10-11 17:25:01.123 Df kernel[0:f3a9d] (Sandbox) Sandbox: nc(4242) allow network-outbound /Users/someone/x/s.sock")).toEqual({ program: "nc", verdict: "allow", operation: "network-outbound", target: "/Users/someone/x/s.sock" });
    expect(parseDecision("2026-10-11 17:25:01.456 E  kernel[0:f3ab2] (Sandbox) Sandbox: python3.12(977) deny(1) network-outbound /private/var/run/made-up.sock")).toMatchObject({ program: "python3.12", verdict: "deny", operation: "network-outbound" });
    expect(parseDecision("... Sandbox: kiro-cli-chat(51) allow network-outbound remote:*:5478")).toMatchObject({ program: "kiro-cli-chat", target: "remote:*:5478" });
    expect(parseDecision("... Sandbox: Some App Helper (Renderer)(7) deny(1) mach-lookup com.made-up.service")).toMatchObject({ program: "Some App Helper (Renderer)", operation: "mach-lookup" });
    for (const other of ["", "Timestamp Ty Process[PID:TID]", "... (Sandbox) something else entirely", "Sandbox: nc(1) maybe network-outbound x"]) expect(parseDecision(other), other).toBeNull();
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

  it("counts by program, verdict, kind and shape, and never names a program that is not one a build starts", () => {
    const line = (program: string, verdict: string, operation: string, target: string) => parseDecision(`x Sandbox: ${program}(1) ${verdict} ${operation} ${target}`);
    const decisions = [
      line("python3.12", "allow", "network-outbound", "/Users/someone/.kiro-hardening/crew/mcp-gateway/gateway.sock"),
      line("python3.12", "allow", "network-outbound", "/Users/someone/.kiro-hardening/crew/mcp-gateway/gateway.sock"),
      line("python3.12", "allow", "sysctl-read", "kern.proc.pgrp.4401"),
      line("python3.12", "allow", "sysctl-read", "kern.proc.pgrp.4477"),
      line("node", "allow", "network-outbound", "remote:*:4188"),
      line("kiro-cli-chat", "deny(1)", "network-outbound", "/Users/someone/Library/made-up-agent/s.sock"),
      line("node", "deny(1)", "file-read-data", "/Users/someone/Documents/letter.txt"),
      line("Made Up Mail", "deny(1)", "file-read-data", "/Users/someone/Library/Mail/secret"),
      line("com.made-up.browser", "allow", "network-outbound", "remote:*:443"),
    ].flatMap((decision) => decision ?? []);
    expect(decisions).toHaveLength(9);
    const counted = countDecisions(decisions, places);
    expect(counted).toEqual([
      { what: "another program on this Mac (not looked at)", count: 2 },
      { what: "kiro-cli-chat: deny network-outbound ~/Library/made-up-agent/s.sock", count: 1 },
      { what: "node: allow network-outbound local port 4188", count: 1 },
      // A refusal the new rules are not about: counted, its target not listed.
      { what: "node: deny file-read-data (targets not listed)", count: 1 },
      { what: "python3.12: allow network-outbound <crew home>/mcp-gateway/gateway.sock", count: 2 },
      { what: "python3.12: allow sysctl-read kern.proc.pgrp.N", count: 2 },
    ]);
    const printed = JSON.stringify(counted);
    for (const never of ["someone", "Made Up Mail", "com.made-up.browser", "letter.txt", "secret"]) expect(printed, never).not.toContain(never);
  });
});
