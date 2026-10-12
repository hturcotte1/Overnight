// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The Kiro CLI backend with a recording runner: what command line, environment and sandbox
// values it would use. Kiro is never started. (The shipped sandbox profiles are run for real,
// around harmless commands on temp folders, in sandbox-profiles.test.ts.)
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { BUILD_SKILL_FILE, createKiroCliBackend, KIRO_CLI_SANDBOX_PROFILE, KIRO_OUTPUT_FILE, prepareWorkspace, renderBrief, STOPPED_REASON } from "../src/index.ts";
import type { BuildBackend, BuildJob, CommandResult, KiroCliBackendOptions } from "../src/index.ts";
import { emptyFolder, KIRO_CLI_TMP, PRIVACY_SETTINGS, SHARING_NOT_OFF, SHARING_UNKNOWN } from "../src/kiro-cli.ts";
import { profileParams } from "../src/sandbox-values.ts";
import { STOPPED_WHILE_RUNNING } from "../src/run.ts";
import { collectingLogger, leaveBuild, MINUTE, movableClock, recordingRunner, reply, SECOND, tempDir, testPaths } from "./helpers.ts";
import type { RunCall } from "./helpers.ts";

const ID = "idea_20261010_ab12cd34";
const SKILL = readFileSync(BUILD_SKILL_FILE, "utf8");
/** What Kiro prints for a setting that is off. */
const OFF = "false (global)\n";

interface Rig {
  paths: DataPaths;
  backend: BuildBackend;
  job: BuildJob;
  /** Every program run: the two settings questions, then the build. */
  calls: RunCall[];
  /** The build itself: the `kiro-cli chat` runs. */
  chats(): RunCall[];
  /** The questions about Kiro's settings. */
  settings(): RunCall[];
  lines: string[];
  kiroBinary: string;
  nodeBinDir: string;
  home: string;
  repo: string;
}

/**
 * `kiro` stands in for what Kiro does when it is asked to build: by default it builds the app.
 * `setting` stands in for what it answers when asked for a setting: by default "false (global)".
 */
function makeRig(
  kiro: (call: RunCall) => CommandResult | Promise<CommandResult> = (call) => (leaveBuild(call.options.cwd ?? ""), reply("OVERNIGHT_BUILD_RESULT: built\n")),
  options: Partial<KiroCliBackendOptions> = {},
  setting: (key: string, call: RunCall) => CommandResult | Promise<CommandResult> = () => reply(OFF),
): Rig {
  const paths = testPaths();
  const tools = tempDir();
  const kiroBinary = path.join(tools, "kiro-cli");
  const nodeBinDir = path.join(tools, "node-bin");
  const home = path.join(tools, "home");
  const repo = path.join(tools, "repo");
  for (const dir of [nodeBinDir, home, repo]) mkdirSync(dir);
  writeFileSync(kiroBinary, "#!/bin/sh\n# stand-in: never run\n");
  const isSetting = (call: RunCall) => call.args.at(-2) === "settings";
  const { run, calls } = recordingRunner((call) => (isSetting(call) ? setting(call.args.at(-1) ?? "", call) : kiro(call)));
  const { logger, lines } = collectingLogger();
  const backend = createKiroCliBackend({ paths, logger, kiroBinary, nodeBinDir, run, home, repoRoot: repo, ...options });
  const prepared = prepareWorkspace({ paths, ideaId: ID, brief: renderBrief({ id: ID, title: "Zebra Stripe Counter", pitch: "Counts the stripes on a photographed zebra." }), now: new Date() });
  const job = { ideaId: ID, workspace: prepared.workspace, briefPath: prepared.briefPath, timeoutMs: 45 * MINUTE };
  return { paths, backend, job, calls, chats: () => calls.filter((call) => !isSetting(call)), settings: () => calls.filter(isSetting), lines, kiroBinary, nodeBinDir, home, repo };
}

/** The -D pairs the shipped profile asks for, in its own order, for a rig's made-up folders. */
function expectedDefines(rig: Rig): string[] {
  const values: Record<string, string> = {
    HOME: rig.home,
    WORKSPACE: rig.job.workspace,
    DATA_DIR: rig.paths.root,
    REPO: rig.repo,
    NODE_DIR: path.dirname(rig.nodeBinDir),
    NPM_CACHE: path.join(rig.home, ".npm"),
  };
  return profileParams(readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8")).flatMap((name) => ["-D", `${name}=${values[name]}`]);
}

describe("Kiro CLI backend: the command it runs", () => {
  it("wraps kiro-cli in our sandbox, with the workspace as the working folder", async () => {
    const rig = makeRig();
    const outcome = await rig.backend.build(rig.job);
    expect(outcome).toMatchObject({ ok: true, backend: "kiro-cli" });
    expect(rig.chats()).toHaveLength(1);
    const call = rig.chats()[0];
    expect(call?.command).toBe("/usr/bin/sandbox-exec");
    expect(call?.options.cwd).toBe(rig.job.workspace);
    expect(call?.options.timeoutMs).toBe(45 * MINUTE);
    // One value for each name the profile asks for, and no other.
    expect(profileParams(readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8")).sort()).toEqual(["DATA_DIR", "HOME", "NODE_DIR", "NPM_CACHE", "REPO", "WORKSPACE"]);
    expect(call?.args.slice(0, -1)).toEqual([
      "-f",
      KIRO_CLI_SANDBOX_PROFILE,
      ...expectedDefines(rig),
      rig.kiroBinary,
      "chat",
      "--no-interactive",
      "--model",
      "auto",
      "--trust-tools",
      "read,write,shell",
    ]);
  });

  it("gives the sandbox real paths, because it does not follow links", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job);
    for (const arg of rig.chats()[0]?.args.filter((value) => /^[A-Z_]+=\//.test(value)) ?? []) {
      const value = arg.slice(arg.indexOf("=") + 1);
      // (npm's cache need not exist yet on a fresh Mac: then the folder it will be made in is the real one.)
      const there = existsSync(value) ? value : path.dirname(value);
      expect(realpathSync(there), arg).toBe(there);
    }
    expect(realpathSync(KIRO_CLI_SANDBOX_PROFILE)).toBe(KIRO_CLI_SANDBOX_PROFILE);
  });

  it("prompts with the build skill, then one line saying where the brief is", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job);
    const prompt = rig.chats()[0]?.args.at(-1) ?? "";
    expect(prompt.endsWith(`\n\nThe brief is brief.md in the current folder: ${rig.job.workspace}.`)).toBe(true);
    // The whole skill, minus the header block that only Kiro Crew reads.
    const body = SKILL.slice(SKILL.indexOf("# Build one Overnight app")).trim();
    expect(prompt.startsWith(body)).toBe(true);
    expect(prompt).toContain("## Hard rules");
    expect(prompt).toContain("OVERNIGHT_BUILD_RESULT: built");
    // A prompt that began with "---" could be read as a command-line option.
    expect(prompt.startsWith("-")).toBe(false);
    expect(prompt).not.toContain("triggers: overnight-build");
    // Nothing from the idea is in the prompt: the brief file is the only place it lives.
    expect(prompt).not.toMatch(/Zebra|zebra|stripes/);
  });

  it("gives Kiro a stripped-down environment: HOME, PATH with macOS's own programs first and then the node folder, TMPDIR, NO_COLOR", async () => {
    process.env.OVERNIGHT_TEST_SECRET = "must-not-be-passed-on";
    process.env.GH_TOKEN = "made-up-token";
    try {
      const rig = makeRig();
      await rig.backend.build(rig.job);
      expect(rig.chats()[0]?.options.env).toEqual({
        HOME: rig.home,
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${rig.nodeBinDir}`,
        // A corner of the build jobs' own temporary folder, not the one every program of this user shares.
        TMPDIR: path.join(rig.paths.buildTmp, KIRO_CLI_TMP),
        NO_COLOR: "1",
      });
    } finally {
      delete process.env.OVERNIGHT_TEST_SECRET;
      delete process.env.GH_TOKEN;
    }
  });

  it("empties the build's temporary folder before the build, without following a link in it", async () => {
    const elsewhere = tempDir();
    writeFileSync(path.join(elsewhere, "keep.txt"), "not ours to remove: made up\n");
    let seenAtStart: string[] | null = null;
    const rig = makeRig((call) => {
      seenAtStart ??= readdirSync(call.options.env?.TMPDIR ?? "");
      // The build leaves things behind, as a real one does.
      writeFileSync(path.join(call.options.env?.TMPDIR ?? "", "left-by-this-build.txt"), "x");
      leaveBuild(call.options.cwd ?? "");
      return reply();
    });
    // What an earlier build left: a file, a folder with files, and a link to a folder elsewhere.
    const own = path.join(rig.paths.buildTmp, KIRO_CLI_TMP);
    mkdirSync(path.join(own, "playwright-transform-cache-501", "ab"), { recursive: true });
    writeFileSync(path.join(own, "playwright-transform-cache-501", "ab", "compiled.js"), "made up");
    writeFileSync(path.join(own, "old.txt"), "made up");
    symlinkSync(elsewhere, path.join(own, "link-out"));
    // What the running Kiro Crew gateway keeps in the rest of the build temp folder is not ours to remove.
    writeFileSync(path.join(rig.paths.buildTmp, "gateway-in-use.tmp"), "made up");

    expect((await rig.backend.build(rig.job)).ok).toBe(true);
    expect(seenAtStart).toEqual([]);
    expect(readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toContain("not ours to remove");
    expect(existsSync(path.join(rig.paths.buildTmp, "gateway-in-use.tmp"))).toBe(true);
    expect(statSync(rig.paths.buildTmp).mode & 0o777).toBe(0o700);
    expect(statSync(own).mode & 0o777).toBe(0o700);
    // The settings questions run in the same, already emptied, folder.
    for (const call of rig.settings()) expect(call.options.env?.TMPDIR).toBe(own);
  });

  it("makes the temporary folder when it is missing, and refuses to build when a link stands in its place", async () => {
    const missing = makeRig();
    rmSync(missing.paths.buildTmp, { recursive: true });
    expect((await missing.backend.build(missing.job)).ok).toBe(true);
    expect(existsSync(missing.paths.buildTmp)).toBe(true);

    const linked = makeRig();
    const elsewhere = tempDir();
    writeFileSync(path.join(elsewhere, "keep.txt"), "made up");
    rmSync(linked.paths.buildTmp, { recursive: true });
    symlinkSync(elsewhere, linked.paths.buildTmp);
    expect(await linked.backend.build(linked.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build's temporary folder could not be made ready" });
    expect(linked.calls).toHaveLength(0);
    expect(existsSync(path.join(elsewhere, "keep.txt"))).toBe(true);
    expect(emptyFolder(path.join(tempDir(), "not-there"))).toBe(false);

    // The same when the link stands in place of the Kiro CLI build's own corner.
    const corner = makeRig();
    symlinkSync(elsewhere, path.join(corner.paths.buildTmp, KIRO_CLI_TMP));
    expect(await corner.backend.build(corner.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build's temporary folder could not be made ready" });
    expect(corner.calls).toHaveLength(0);
    expect(existsSync(path.join(elsewhere, "keep.txt"))).toBe(true);
  });

  it("starts nothing when the profile asks for a value it cannot fill", async () => {
    const odd = path.join(tempDir(), "odd.sb");
    writeFileSync(odd, '(version 1)\n(allow default)\n(deny file-read* (subpath (param "HOME")) (subpath (param "SOMETHING_ELSE")))\n');
    const rig = makeRig(undefined, { sandboxProfile: odd });
    expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "a folder the build sandbox needs is missing" });
    expect(rig.calls).toHaveLength(0);
  });

  it("defaults to the real home folder, this repo and the node that is running", async () => {
    const paths = testPaths();
    const kiroBinary = path.join(tempDir(), "kiro-cli");
    writeFileSync(kiroBinary, "stand-in");
    const { run, calls } = recordingRunner((call) => (call.args.includes("chat") ? (leaveBuild(call.options.cwd ?? ""), reply()) : reply(OFF)));
    const backend = createKiroCliBackend({ paths, logger: collectingLogger().logger, kiroBinary, run });
    const prepared = prepareWorkspace({ paths, ideaId: ID, brief: "b", now: new Date() });
    expect((await backend.build({ ideaId: ID, workspace: prepared.workspace, briefPath: prepared.briefPath, timeoutMs: MINUTE })).ok).toBe(true);

    for (const call of calls) {
      expect(call.args).toContain(`HOME=${realpathSync(homedir())}`);
      expect(call.args).toContain(`REPO=${realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."))}`);
      expect(call.options.env?.PATH).toBe(`/usr/bin:/bin:/usr/sbin:/sbin:${realpathSync(path.dirname(process.execPath))}`);
    }
  });
});

describe("Kiro CLI backend: deciding whether the build worked", () => {
  it("goes by the files Kiro leaves, not by its exit code", async () => {
    const crashedButBuilt = makeRig((call) => (leaveBuild(call.options.cwd ?? ""), reply("", { exitCode: 1 })));
    expect((await crashedButBuilt.backend.build(crashedButBuilt.job)).ok).toBe(true);

    const cleanExitNoBuild = makeRig(() => reply("All done! OVERNIGHT_BUILD_RESULT: built\n", { exitCode: 0 }));
    expect(await cleanExitNoBuild.backend.build(cleanExitNoBuild.job)).toMatchObject({ ok: false, couldNotStart: false, reason: expect.stringContaining("left no BUILD_STATUS.json") });
  });

  it("fails when Kiro says the build failed, or leaves no dist/index.html", async () => {
    const failed = makeRig((call) => (leaveBuild(call.options.cwd ?? "", { status: "failed" }), reply()));
    expect(await failed.backend.build(failed.job)).toMatchObject({ ok: false, couldNotStart: false, reason: expect.stringContaining("reported that the build failed") });

    const noDist = makeRig((call) => (leaveBuild(call.options.cwd ?? "", { dist: false }), reply()));
    expect(await noDist.backend.build(noDist.job)).toMatchObject({ ok: false, reason: expect.stringContaining("dist/index.html is missing") });
  });

  it("fails at the time limit", async () => {
    const rig = makeRig((call) => (leaveBuild(call.options.cwd ?? "", { status: "building" }), reply("", { exitCode: null, timedOut: true })));
    expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, couldNotStart: false, reason: "the build ran past its time limit of 45 minutes" });
  });

  it("says it could not start when the program cannot be run", async () => {
    const rig = makeRig(() => reply("", { exitCode: null, error: "could not start the program (ENOENT)" }));
    expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "Kiro CLI could not be started inside the build sandbox" });
  });

  it("says so when the sandbox itself refuses, or Kiro is signed out", async () => {
    const refused = makeRig(() => reply("", { exitCode: 65, stderr: "sandbox-exec: invalid parameter\n" }));
    expect(await refused.backend.build(refused.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox refused to start Kiro CLI" });

    const signedOut = makeRig(() => reply("", { exitCode: 1, stderr: "error: You are not logged in, please log in with kiro-cli login\n" }));
    expect(await signedOut.backend.build(signedOut.job)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("Kiro is signed out") });
  });

  it("does not start without kiro-cli, the sandbox profile, sandbox-exec, or the brief", async () => {
    const noKiro = makeRig(undefined, { kiroBinary: path.join(tempDir(), "no-kiro") });
    expect(await noKiro.backend.build(noKiro.job)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("Kiro CLI is not installed") });

    const noProfile = makeRig(undefined, { sandboxProfile: path.join(tempDir(), "no-profile.sb") });
    expect(await noProfile.backend.build(noProfile.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox profile is missing" });

    const noSandbox = makeRig(undefined, { sandboxExec: path.join(tempDir(), "no-sandbox-exec") });
    expect(await noSandbox.backend.build(noSandbox.job)).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("no sandbox-exec") });

    const noBrief = makeRig();
    rmSync(noBrief.job.briefPath);
    expect(await noBrief.backend.build(noBrief.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the workspace or its brief.md is missing" });

    for (const rig of [noKiro, noProfile, noSandbox, noBrief]) expect(rig.calls).toHaveLength(0);
  });

  it("never throws", async () => {
    const rig = makeRig(() => {
      throw new Error("made-up runner crash");
    });
    expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, backend: "kiro-cli", reason: "the Kiro CLI build stopped on an unexpected error" });
  });

  it("keeps what Kiro printed beside the brief, and out of the log", async () => {
    const rig = makeRig((call) => (leaveBuild(call.options.cwd ?? ""), reply("I built the Zebra Stripe Counter.\n", { stderr: "[tool] Running: npm install\n" })));
    await rig.backend.build(rig.job);
    const saved = readFileSync(path.join(rig.paths.ideas, ID, KIRO_OUTPUT_FILE), "utf8");
    expect(saved).toContain("I built the Zebra Stripe Counter.");
    expect(saved).toContain("[tool] Running: npm install");
    const log = rig.lines.join("\n");
    expect(log).toContain('"message":"kiro cli build started"');
    for (const never of ["Zebra", "npm install", "Hard rules"]) expect(log, never).not.toContain(never);
  });
});

describe("Kiro CLI backend: what a try cost", () => {
  /**
   * A rig on a clock the test moves: each settings question takes 2 seconds and the build itself
   * `runMs`, and `kiro` says how the build ends.
   */
  function timedRig(runMs: number, kiro: (call: RunCall) => CommandResult, setting: () => CommandResult = () => reply(OFF)) {
    const clock = movableClock();
    const rig = makeRig(
      (call) => {
        clock.advance(runMs);
        return kiro(call);
      },
      { now: clock.now },
      () => {
        clock.advance(2 * SECOND);
        return setting();
      },
    );
    return { ...rig, clock };
  }
  const builds = (call: RunCall) => (leaveBuild(call.options.cwd ?? ""), reply());

  it("says how long the agent ran, which is the one Kiro run and not the questions before it", async () => {
    const rig = timedRig(7 * MINUTE, builds);
    const outcome = await rig.backend.build(rig.job);
    expect(outcome).toEqual({ ok: true, backend: "kiro-cli", ms: 7 * MINUTE + 4 * SECOND, agentMs: 7 * MINUTE });
  });

  it("never gives a figure of its own: Kiro CLI has none, so the month's ledger estimates from the time", async () => {
    for (const kiro of [builds, (call: RunCall) => (leaveBuild(call.options.cwd ?? "", { status: "failed" }), reply())]) {
      const rig = timedRig(MINUTE, kiro);
      const outcome = await rig.backend.build(rig.job);
      expect(outcome).not.toHaveProperty("credits");
      expect(outcome).toHaveProperty("agentMs", MINUTE);
    }
  });

  it("says it for a build that failed, left nothing, or ran past its time limit", async () => {
    const failed = timedRig(9 * MINUTE, (call) => (leaveBuild(call.options.cwd ?? "", { status: "failed" }), reply()));
    expect(await failed.backend.build(failed.job)).toMatchObject({ ok: false, couldNotStart: false, agentMs: 9 * MINUTE });

    const nothing = timedRig(30 * SECOND, () => reply("All done!\n"));
    expect(await nothing.backend.build(nothing.job)).toMatchObject({ ok: false, reason: expect.stringContaining("left no BUILD_STATUS.json"), agentMs: 30 * SECOND });

    const tooLong = timedRig(45 * MINUTE, () => reply("", { exitCode: null, timedOut: true }));
    expect(await tooLong.backend.build(tooLong.job)).toEqual({ ok: false, backend: "kiro-cli", ms: 45 * MINUTE + 4 * SECOND, reason: "the build ran past its time limit of 45 minutes", couldNotStart: false, agentMs: 45 * MINUTE });
  });

  it("says it for a build that was stopped while it ran", async () => {
    const stop = new AbortController();
    // What the runner answers for a program it started and then ended because of the stop.
    const rig = timedRig(11 * MINUTE, () => (stop.abort(), reply("", { exitCode: null, error: STOPPED_WHILE_RUNNING })));
    const outcome = await rig.backend.build(rig.job, { signal: stop.signal });
    expect(outcome).toEqual({ ok: false, backend: "kiro-cli", ms: 11 * MINUTE + 4 * SECOND, reason: STOPPED_REASON, couldNotStart: false, agentMs: 11 * MINUTE });
    expect(STOPPED_WHILE_RUNNING).toBe("the program was stopped: this process is stopping");
  });

  it("never says the agent ran for longer than its time limit, however long the Mac slept in the middle of the build", async () => {
    const stop = new AbortController();
    // Six hours pass on the clock while Kiro "runs": the Mac was asleep, and the run is stopped when it wakes.
    const rig = timedRig(6 * 60 * MINUTE, () => (stop.abort(), reply("", { exitCode: null, error: STOPPED_WHILE_RUNNING })));
    const outcome = await rig.backend.build(rig.job, { signal: stop.signal });
    expect(outcome).toMatchObject({ ok: false, reason: STOPPED_REASON, ms: 6 * 60 * MINUTE + 4 * SECOND });
    expect(outcome.agentMs).toBe(45 * MINUTE);
    expect(rig.job.timeoutMs).toBe(45 * MINUTE);
  });

  it("says nothing about cost when Kiro was never started", async () => {
    // The stop came just before the run: the runner starts nothing and says so.
    const stop = new AbortController();
    const stoppedFirst = timedRig(0, () => (stop.abort(), reply("", { exitCode: null, error: "the program was not started: this process is stopping" })));
    const stopped = await stoppedFirst.backend.build(stoppedFirst.job, { signal: stop.signal });
    expect(stopped).toMatchObject({ ok: false, reason: STOPPED_REASON });
    expect(stopped).not.toHaveProperty("agentMs");

    const cannotRun = timedRig(0, () => reply("", { exitCode: null, error: "could not start the program (ENOENT)" }));
    const outcome = await cannotRun.backend.build(cannotRun.job);
    expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: "Kiro CLI could not be started inside the build sandbox" });
    expect(outcome).not.toHaveProperty("agentMs");

    // Refused before the run: a setting that is on, a missing program.
    const sharing = timedRig(MINUTE, builds, () => reply("true (global)\n"));
    expect(await sharing.backend.build(sharing.job)).not.toHaveProperty("agentMs");
    const noKiro = makeRig(undefined, { kiroBinary: path.join(tempDir(), "no-kiro") });
    expect(await noKiro.backend.build(noKiro.job)).not.toHaveProperty("agentMs");
  });

  it("still says it when the program ran and the answer is that the build could not begin", async () => {
    // Kiro was started and gave up at once (signed out), or sandbox-exec itself refused. The few
    // seconds are passed on; the ledger counts its smallest amount for such a try.
    const signedOut = timedRig(3 * SECOND, () => reply("", { exitCode: 1, stderr: "error: You are not logged in, please log in with kiro-cli login\n" }));
    expect(await signedOut.backend.build(signedOut.job)).toMatchObject({ ok: false, couldNotStart: true, agentMs: 3 * SECOND });
    const refused = timedRig(SECOND, () => reply("", { exitCode: 65, stderr: "sandbox-exec: invalid parameter\n" }));
    expect(await refused.backend.build(refused.job)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox refused to start Kiro CLI", agentMs: SECOND });
  });
});

describe("Kiro CLI backend: Kiro's content-sharing settings", () => {
  it("asks Kiro for both settings before it sends anything, inside the same sandbox, folder and environment as the build", async () => {
    const rig = makeRig();
    expect((await rig.backend.build(rig.job)).ok).toBe(true);
    expect(rig.calls.map((call) => call.args.at(-2))).toEqual(["settings", "settings", "read,write,shell"]);
    expect(rig.settings().map((call) => call.args.at(-1))).toEqual(["codeWhisperer.shareCodeWhispererContentWithAWS", "telemetry.enabled"]);
    expect([...PRIVACY_SETTINGS]).toEqual(["codeWhisperer.shareCodeWhispererContentWithAWS", "telemetry.enabled"]);

    const chat = rig.chats()[0];
    for (const call of rig.settings()) {
      expect(call.command).toBe("/usr/bin/sandbox-exec");
      // The same sandbox values and the same kiro-cli as the build, then "settings <key>": read only.
      expect(call.args.slice(0, -2)).toEqual(chat?.args.slice(0, chat.args.indexOf("chat")));
      expect(call.args).toHaveLength(2 + expectedDefines(rig).length + 1 + 2);
      expect(call.options.cwd).toBe(rig.job.workspace);
      expect(call.options.env).toEqual(chat?.options.env);
      expect(call.options.timeoutMs).toBe(20_000);
    }
  });

  it("accepts \"false\" with or without where it was set, and nothing else", async () => {
    for (const off of ["false (global)\n", "false\n", "  false (workspace)  \n"]) {
      const rig = makeRig(undefined, {}, () => reply(off));
      expect((await rig.backend.build(rig.job)).ok, JSON.stringify(off)).toBe(true);
    }
    for (const notOff of ["true (global)\n", "true\n", "", "False\n", "false true\n", "falsehood\n", "null\n", "false (global) extra\n"]) {
      const rig = makeRig(undefined, {}, () => reply(notOff));
      expect(await rig.backend.build(rig.job), JSON.stringify(notOff)).toMatchObject({ ok: false, couldNotStart: true, reason: SHARING_NOT_OFF });
      // Nothing was sent: the brief never reached Kiro.
      expect(rig.chats(), JSON.stringify(notOff)).toHaveLength(0);
    }
  });

  it("refuses when either one is on", async () => {
    for (const on of PRIVACY_SETTINGS) {
      const rig = makeRig(undefined, {}, (key) => reply(key === on ? "true (global)\n" : OFF));
      expect(await rig.backend.build(rig.job), on).toMatchObject({ ok: false, backend: "kiro-cli", couldNotStart: true, reason: "Kiro's content-sharing settings are not both switched off, so the brief was not sent to Kiro CLI" });
      expect(rig.chats(), on).toHaveLength(0);
      expect(rig.lines.join("\n"), on).toContain(`"key":"${on}"`);
    }
  });

  it("treats a setting that was never set as not off", async () => {
    // What Kiro does for a setting with no value: exit 1 and a note on the other stream.
    const rig = makeRig(undefined, {}, () => reply("", { exitCode: 1, stderr: "No value associated with telemetry.enabled\n" }));
    expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, couldNotStart: true, reason: SHARING_NOT_OFF });
    expect(rig.chats()).toHaveLength(0);
  });

  it("refuses when Kiro cannot be asked", async () => {
    for (const broken of [reply("", { exitCode: null, error: "could not start the program (ENOENT)" }), reply("", { exitCode: null, timedOut: true })]) {
      const rig = makeRig(undefined, {}, () => broken);
      expect(await rig.backend.build(rig.job)).toMatchObject({ ok: false, couldNotStart: true, reason: SHARING_UNKNOWN });
      expect(SHARING_UNKNOWN).toBe("Kiro's content-sharing settings could not be checked, so the brief was not sent to Kiro CLI");
      expect(rig.chats()).toHaveLength(0);
      // The first question failed: the second was not asked.
      expect(rig.settings()).toHaveLength(1);
    }
  });

  it("only ever reads the settings: it never tries to change one", async () => {
    const rig = makeRig(undefined, {}, () => reply("true (global)\n"));
    await rig.backend.build(rig.job);
    // "settings <key>" and nothing after the key. ("settings <key> false" would set it.)
    for (const call of rig.calls) expect(call.args.slice(-2)).toEqual(["settings", "codeWhisperer.shareCodeWhispererContentWithAWS"]);
    expect(rig.calls).toHaveLength(1);
  });
});
