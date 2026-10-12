// Checks the templates in launchd/ and scripts/install-agents.sh WITHOUT installing anything on
// this Mac. The script is loaded with `source`, so only the functions named in each test run, and
// HOME is always a scratch folder.
//
// Installing, removing and restarting are run as DRY RUNS only (see dryRun): `launchctl` is
// replaced by a shell function that records its calls, the launchd domain is a made-up name that
// the real launchctl would refuse, and the settings files, the .env, the data folder and the home
// folder are all inside the scratch folder. Kiro Crew's program is a stand-in script in that
// scratch home which only answers "config get" and "status" (the real one is never run, no Kiro
// Crew setting is read or changed, and no gateway is started or asked anything); the look at the
// gateway's port and at the Mac's time zone are stand-ins too. The sandbox profile is a made-up
// one in the scratch folder, so these tests do not depend on what
// packages/builder/sandbox/crew-gateway.sb holds today; one test reads that real file, only to
// check that the installer knows how to fill every value it asks for. The `overnight` tool itself
// is really run (pause, status, and `build --from-now` or `deliver --from-now`, which only write
// down that today's time counts as handled), but always with its data folder forced into the
// scratch folder, so the real one is never opened, and with the gateway's port pointed at one
// where nothing listens. A night job's first look at the clock, which the real job makes when
// macOS loads it, is a stand-in too: the made-up launchctl writes the time of the look into the
// scratch database with the app's own function. No build and no delivery is ever started. No
// test runs the script's own `install`, `uninstall` or `restart` subcommand. Every path, job
// listing and log line below is made up.
//
// The last part checks the tools of spikes/10-night-clock.ts, the script that later tries the
// night clock under real launchd with throwaway jobs. Here nothing of it is run but its own
// refusals and the text it would hand to macOS: no job is loaded.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SKIPPED_NOTHING_APPROVED } from "@overnight/builder";
import { clockMinus, dataPaths, DELIVER_LEAD_MINUTES, nextSlotAt, NIGHT_TICK_SECONDS, parseConfig } from "@overnight/core";
import {
  clockTimes,
  dataDirProblem,
  FIRST_CHECK_MESSAGE,
  inQuietHours,
  labelProblem,
  launchctlProblem,
  notAsleepReason,
  NOTHING_APPROVED_LINE,
  powerEvent,
  REAL_LABELS,
  settingsProblem,
  sittingSteps,
  SPIKE_LABELS,
  STARTING_MESSAGE,
  throwawaySettings,
} from "../../../spikes/10-night-clock.ts";
import { JOB_LABEL, jobSettingsFile, NIGHT_JOB_LABELS, readJobDataDir, readJobTrigger } from "../src/background.ts";
import { buildSummary } from "../src/commands/build.ts";
import { repoRoot } from "../src/context.ts";
import { buildLockFile, deliverLockFile, takeLock } from "../src/single-instance.ts";

const SCRIPT = path.join(repoRoot(), "scripts", "install-agents.sh");
const templateFile = (job: Job) => path.join(repoRoot(), "launchd", `com.overnight.${job}.plist.template`);
const TEMPLATE = templateFile("listen");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const NODE_DIR = path.dirname(process.execPath);
const NODE = path.join(NODE_DIR, "node");
const ENTRY = `${repoRoot()}/packages/cli/src/main.ts`;
/** The profile the gateway is started inside when BUILD_SANDBOX is "overnight". */
const SANDBOX_PROFILE = `${repoRoot()}/packages/builder/sandbox/crew-gateway.sb`;

type Job = "listen" | "crew" | "build" | "deliver";
const JOBS: Job[] = ["listen", "crew", "build", "deliver"];
const label = (job: Job) => `com.overnight.${job}`;

// launchd and plutil exist only on macOS.
const describeOnMac = process.platform === "darwin" ? describe : describe.skip;

let scratch: string;
let home: string;
let counter = 0;
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight agents "));
  home = path.join(scratch, "home of someone");
  mkdirSync(home, { recursive: true });
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a few lines of bash with the installer's functions loaded. `$1` is the script itself. */
function runScript(lines: string, args: string[] = [], env: Record<string, string> = {}): Ran {
  try {
    const stdout = execFileSync("/bin/bash", ["-c", `source "$1"; shift; ${lines}`, "bash", SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      // A bare environment, like the one a background job gets. HOME is never the real one.
      env: { PATH: BARE_PATH, HOME: home, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    if (failed.status === undefined) throw error;
    return { status: failed.status, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
  }
}

/** The same, for lines that must succeed: returns what they printed. */
function withScript(lines: string, args: string[] = [], env: Record<string, string> = {}): string {
  const ran = runScript(lines, args, env);
  if (ran.status !== 0) throw new Error(`the script lines failed with code ${ran.status}: ${ran.stderr}`);
  return ran.stdout;
}

function plistAsJson(file: string): unknown {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", timeout: 15_000 }));
}

const mode = (file: string) => statSync(file).mode & 0o777;

describe("launchd template", () => {
  const template = readFileSync(TEMPLATE, "utf8");

  it("uses only the placeholders the installer fills in", () => {
    const names = [...new Set(template.match(/__[A-Z][A-Z_]*__/g))].sort();
    expect(names).toEqual(["__DATA_DIR__", "__HOME__", "__NODE_DIR__", "__NODE__", "__REPO__"]);
  });

  it("names the job and runs the listener from the repo", () => {
    expect(template).toContain(`<string>${JOB_LABEL}</string>`);
    expect(template).toContain("<string>__REPO__/packages/cli/src/main.ts</string>");
    expect(template).toContain("<string>__NODE_DIR__:/usr/bin:/bin:/usr/sbin:/sbin</string>");
  });

  it("gives the listener 30 seconds to stop, and keeps a file for what is printed outside its own log", () => {
    expect(template).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
    expect(template).toContain("<key>StandardOutPath</key>");
    expect(template).toContain("<key>StandardErrorPath</key>");
  });
});

describe("launchd templates for the night", () => {
  const read = (job: Job) => readFileSync(templateFile(job), "utf8");
  const placeholders = (text: string) => [...new Set(text.match(/__[A-Z][A-Z_]*__/g))].sort();
  /** A template without its XML comments: the settings themselves. */
  const settingsOf = (job: Job) => read(job).replace(/<!--[\s\S]*?-->/g, "");

  it("use only the placeholders the installer fills in: the build and deliver jobs take no hour and minute", () => {
    for (const job of ["build", "deliver"] as const) {
      expect(placeholders(read(job)), job).toEqual(["__DATA_DIR__", "__HOME__", "__NODE_DIR__", "__NODE__", "__REPO__"]);
    }
    expect(placeholders(read("crew"))).toEqual(["__CREW_ARGUMENTS__", "__DATA_DIR__", "__HOME__", "__NODE_DIR__"]);
  });

  it("name the jobs the way the app does, and run the right command: build and deliver with the if-due switch", () => {
    expect(read("build")).toContain(`<string>${NIGHT_JOB_LABELS.build}</string>`);
    expect(read("deliver")).toContain(`<string>${NIGHT_JOB_LABELS.deliver}</string>`);
    expect(read("crew")).toContain(`<string>${NIGHT_JOB_LABELS.crew}</string>`);
    // Without the switch the command means "now": a job started every minute would build every minute.
    expect(settingsOf("build")).toMatch(/<string>__REPO__\/packages\/cli\/src\/main\.ts<\/string>\s*<string>build<\/string>\s*<string>--if-due<\/string>\s*<\/array>/);
    expect(settingsOf("deliver")).toMatch(/<string>__REPO__\/packages\/cli\/src\/main\.ts<\/string>\s*<string>deliver<\/string>\s*<string>--if-due<\/string>\s*<\/array>/);
  });

  it("have macOS wake the build and deliver jobs as often as the night clock expects, and when they are loaded, and never by its calendar", () => {
    for (const job of ["build", "deliver"] as const) {
      const settings = settingsOf(job);
      const every = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(settings)?.[1];
      // One number: the template's, and the one Overnight's own clock is built around.
      expect(Number(every), job).toBe(NIGHT_TICK_SECONDS);
      expect(settings, job).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      expect(settings, job).not.toContain("StartCalendarInterval");
      expect(settings, job).not.toContain("KeepAlive");
      expect(settings, job).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/);
      // The comment beside it says the same number, and who decides.
      expect(read(job), job).toContain(`macOS starts this job every ${NIGHT_TICK_SECONDS} seconds`);
      expect(read(job), job).toContain("Overnight's own clock does");
      expect(read(job), job).toContain("the if-due switch");
    }
  });

  it("have no two hyphens in a row inside a comment, which XML does not allow", () => {
    for (const job of JOBS) {
      const comments = read(job).match(/<!--[\s\S]*?-->/g) ?? [];
      expect(comments.length, job).toBeGreaterThan(0);
      for (const comment of comments) expect(comment.slice(4, -3), `${job}: ${comment.slice(0, 60)}`).not.toContain("--");
    }
  });

  it("say in the gateway's template that it is not a valid settings file until it is filled in", () => {
    expect(read("crew")).toContain("not a valid settings file");
    expect(read("crew")).toMatch(/The installer\s+checks the filled-in result/);
  });
});

describeOnMac("scripts/install-agents.sh", () => {
  it("fills the template into a valid plist, even with spaces and XML characters in the paths", () => {
    const node = "/opt/My Tools & Co/node <24>/bin/node";
    const repo = "/Users/someone/My Repo \\ $x & more";
    const dataDir = "/Volumes/Data Disk/over night";
    const file = path.join(scratch, "filled.plist");
    writeFileSync(file, withScript('render_plist listen "$@"', [node, repo, dataDir, home]));

    execFileSync("/usr/bin/plutil", ["-lint", file], { timeout: 15_000, stdio: "ignore" });
    expect(plistAsJson(file)).toEqual({
      Label: "com.overnight.listen",
      ProgramArguments: [node, `${repo}/packages/cli/src/main.ts`, "listen"],
      WorkingDirectory: repo,
      EnvironmentVariables: { PATH: "/opt/My Tools & Co/node <24>/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ProcessType: "Background",
      ExitTimeOut: 30,
      StandardOutPath: `${dataDir}/logs/listen.launchd.log`,
      StandardErrorPath: `${dataDir}/logs/listen.launchd.log`,
    });
  });

  it("fills the build and deliver templates into valid plists: woken every minute and at load, with the if-due switch, never on macOS's calendar", () => {
    const node = "/opt/My Tools & Co/node <24>/bin/node";
    const repo = "/Users/someone/My Repo \\ $x & more";
    const dataDir = "/Volumes/Data Disk/over night";
    for (const job of ["build", "deliver"] as const) {
      const file = path.join(scratch, `filled ${job}.plist`);
      writeFileSync(file, withScript('render_plist "$@"', [job, node, repo, dataDir, home]));
      execFileSync("/usr/bin/plutil", ["-lint", file], { timeout: 15_000, stdio: "ignore" });
      // Exactly these keys: no StartCalendarInterval, no KeepAlive.
      expect(plistAsJson(file), job).toEqual({
        Label: label(job),
        ProgramArguments: [node, `${repo}/packages/cli/src/main.ts`, job, "--if-due"],
        WorkingDirectory: repo,
        // macOS's own folders first: `git` must be the system's. gh, kirocrew and kiro-cli live in ~/.local/bin.
        EnvironmentVariables: { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/My Tools & Co/node <24>/bin:${home}/.local/bin`, HOME: home },
        StartInterval: NIGHT_TICK_SECONDS,
        RunAtLoad: true,
        ExitTimeOut: 60,
        StandardOutPath: `${dataDir}/logs/${job}.launchd.log`,
        StandardErrorPath: `${dataDir}/logs/${job}.launchd.log`,
      });
      expect(NIGHT_TICK_SECONDS).toBe(60);
      // An hour and a minute, as older callers passed them, are no longer looked at.
      expect(withScript('render_plist "$@"', [job, node, repo, dataDir, home, "1", "0"])).toBe(readFileSync(file, "utf8"));
    }
  });

  it("the templates as they are in the repo: listen, build and deliver pass macOS's own check, the gateway's does not until it is filled in", () => {
    const lint = (job: Job) => {
      try {
        execFileSync("/usr/bin/plutil", ["-lint", templateFile(job)], { timeout: 15_000, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    for (const job of ["listen", "build", "deliver"] as const) expect(lint(job), job).toBe(true);
    // The whole command stands in for one name, where bare text is not allowed. Its comment says so.
    expect(lint("crew")).toBe(false);
    expect(readFileSync(templateFile("crew"), "utf8")).toContain("not a valid settings file");
  });

  it("fills the gateway template with whatever command it is given, one word per argument", () => {
    const node = "/opt/My Tools & Co/node <24>/bin/node";
    const dataDir = "/Volumes/Data Disk/over night";
    const command = ["/usr/bin/sandbox-exec", "-f", "/Users/someone/My Repo & more/profile.sb", "-D", "HOME=/Users/some one", "/Users/some one/.local/bin/kirocrew", "gateway", "--no-open", "--no-tunnel"];
    const file = path.join(scratch, "filled crew.plist");
    writeFileSync(file, withScript('render_plist crew "$@"', [node, "/Users/someone/My Repo & more", dataDir, home, ...command]));
    execFileSync("/usr/bin/plutil", ["-lint", file], { timeout: 15_000, stdio: "ignore" });
    expect(plistAsJson(file)).toEqual({
      Label: "com.overnight.crew",
      ProgramArguments: command,
      WorkingDirectory: `${dataDir}/workspaces`,
      // macOS's own folders first, as for the build and deliver jobs. TMPDIR: the build jobs' own
      // temporary folder inside the data folder, not the one every program on the Mac shares.
      EnvironmentVariables: {
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/My Tools & Co/node <24>/bin:${home}/.local/bin`,
        HOME: home,
        TMPDIR: `${dataDir}/tmp/build`,
        LANG: "en_US.UTF-8",
        NO_COLOR: "1",
      },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ExitTimeOut: 30,
      StandardOutPath: `${dataDir}/logs/crew.launchd.log`,
      StandardErrorPath: `${dataDir}/logs/crew.launchd.log`,
    });
    expect(runScript('render_plist crew "$@"', [node, "/r", dataDir, home]).stderr).toBe("install-agents: The crew job needs the gateway's command.\n");
  });

  it("gives the gateway job the same PATH order as the build and deliver jobs, and its own temporary folder", () => {
    const crew = readFileSync(templateFile("crew"), "utf8");
    const night = "<string>/usr/bin:/bin:/usr/sbin:/sbin:__NODE_DIR__:__HOME__/.local/bin</string>";
    for (const job of ["crew", "build", "deliver"] as const) expect(readFileSync(templateFile(job), "utf8"), job).toContain(night);
    expect(crew).toMatch(/<key>TMPDIR<\/key>\s*<string>__DATA_DIR__\/tmp\/build<\/string>/);
    // The same folder core calls buildTmp, and the one the installer creates and hands the profile.
    expect(dataPaths("/made-up/data").buildTmp).toBe("/made-up/data/tmp/build");
    expect(withScript('build_tmp_of "$1"', ["/made-up/data"])).toBe("/made-up/data/tmp/build");
  });

  /** A made-up sandbox profile that asks for the given values. Not the real one. */
  const madeUpProfile = (name: string, params: string[], extra = "") => {
    const file = path.join(scratch, name);
    writeFileSync(file, [";; Made up for the tests. Not Overnight's profile.", "(version 1)", "(allow default)", ...params.map((param, index) => `(define value-${index} (param "${param}"))`), extra, ""].join("\n"));
    return file;
  };

  it("follows every link in a path, also when its last parts do not exist yet, and refuses rather than hand back a link", () => {
    const real = path.join(scratch, "real things");
    mkdirSync(path.join(real, "inner"), { recursive: true });
    writeFileSync(path.join(real, "inner", "program"), "#!/bin/sh\n");
    const linkedDir = path.join(scratch, "linked things");
    if (!existsSync(linkedDir)) symlinkSync(real, linkedDir);
    const linkedFile = path.join(real, "linked program");
    if (!existsSync(linkedFile)) symlinkSync(path.join(linkedDir, "inner", "program"), linkedFile);
    const resolve = (target: string) => runScript('real_path "$1"', [target]);
    const realScratch = realpathSync(scratch);

    // The scratch folder itself sits behind a link on macOS (/var -> /private/var).
    expect(realScratch).not.toBe(scratch);
    expect(resolve(path.join(linkedDir, "inner"))).toMatchObject({ status: 0, stdout: `${realScratch}/real things/inner` });
    // A file reached through two links: the linked name, then the linked folder.
    expect(resolve(linkedFile)).toMatchObject({ status: 0, stdout: `${realScratch}/real things/inner/program` });
    expect(resolve(`${linkedDir}/`)).toMatchObject({ status: 0, stdout: `${realScratch}/real things` });
    // Not there yet: the part that exists is followed, the rest is kept as written.
    expect(resolve(path.join(linkedDir, "not", "there yet"))).toMatchObject({ status: 0, stdout: `${realScratch}/real things/not/there yet` });
    expect(resolve("/")).toMatchObject({ status: 0, stdout: "/" });

    // A link to nowhere cannot be followed, so there is no real path to give.
    const dangling = path.join(real, "dangling");
    if (!existsSync(dangling) && lstatSync(dangling, { throwIfNoEntry: false }) === undefined) symlinkSync(path.join(scratch, "nowhere at all"), dangling);
    for (const bad of [dangling, path.join(dangling, "below"), "relative/path", "", `${linkedDir}/missing/../inner`]) {
      expect(resolve(bad), bad).toMatchObject({ status: 1, stdout: "" });
    }
  });

  it("reads from a sandbox profile which values it wants: each name once, in order, comments left out", () => {
    const profile = path.join(scratch, "params profile.sb");
    writeFileSync(
      profile,
      [
        ';; (param "IN_A_COMMENT") is not a value the profile wants',
        "(version 1)",
        '(define home (param "HOME"))   ; and neither is (param "AFTER_A_SEMICOLON")',
        '(define data-dir (param "DATA_DIR")) (define repo (param "REPO"))',
        '(deny file-read* (subpath (string-append (param "HOME") "/.ssh")))',
        '(allow file-write* (subpath (param "NODE_DIR")))',
        "",
      ].join("\n"),
    );
    expect(withScript('profile_params "$1"', [profile]).trimEnd().split("\n")).toEqual(["HOME", "DATA_DIR", "REPO", "NODE_DIR"]);
    // A profile that asks for nothing gives no names (and no error from this helper).
    expect(runScript('profile_params "$1"', [madeUpProfile("no params.sb", [])])).toMatchObject({ status: 0, stdout: "" });
  });

  it("starts the gateway plainly in crew mode, and inside the sandbox profile in overnight mode, with every path a real one", () => {
    // Links everywhere a real install has them: the data folder, node's folder (~/.local/node),
    // and Kiro Crew's program (~/.local/bin/kirocrew points into its own folder).
    const real = path.join(scratch, "real data folder");
    const linked = path.join(scratch, "linked data folder");
    mkdirSync(real, { recursive: true });
    if (!existsSync(linked)) symlinkSync(real, linked);
    const nodeInstall = path.join(scratch, "node-v99.0.0-made-up");
    mkdirSync(path.join(nodeInstall, "bin"), { recursive: true });
    writeFileSync(path.join(nodeInstall, "bin", "node"), "#!/bin/sh\n");
    const nodeLink = path.join(scratch, "node");
    if (!existsSync(nodeLink)) symlinkSync(nodeInstall, nodeLink);
    const venv = path.join(scratch, "crew-venv", "bin");
    mkdirSync(venv, { recursive: true });
    writeFileSync(path.join(venv, "kirocrew"), "#!/bin/sh\n");
    mkdirSync(path.join(scratch, "bin"), { recursive: true });
    const kirocrew = path.join(scratch, "bin", "kirocrew");
    if (!existsSync(kirocrew)) symlinkSync(path.join(venv, "kirocrew"), kirocrew);
    const realScratch = realpathSync(scratch);

    const profile = madeUpProfile("command profile.sb", ["HOME", "DATA_DIR", "REPO", "NODE_DIR", "NPM_CACHE", "KIRO_HOME", "CREW_HOME", "TMPDIR"]);
    const words = (mode: string, profileFile = profile) =>
      runScript('SANDBOX_PROFILE="$1"; shift; crew_command "$@"', [profileFile, mode, kirocrew, home, linked, path.join(nodeLink, "bin", "node")]);

    // crew mode: nothing of the sandbox, and the program as it was found.
    expect(words("crew").stdout.trimEnd().split("\n")).toEqual([kirocrew, "gateway", "--no-open", "--no-tunnel"]);

    const overnight = words("overnight");
    expect(overnight.stderr).toBe("");
    const line = overnight.stdout.trimEnd().split("\n");
    expect(line.slice(0, 3)).toEqual(["/usr/bin/sandbox-exec", "-f", `${realScratch}/command profile.sb`]);
    expect(line.slice(-4)).toEqual([`${realScratch}/crew-venv/bin/kirocrew`, "gateway", "--no-open", "--no-tunnel"]);
    const pairs = line.slice(3, -4);
    expect(pairs.filter((_, index) => index % 2 === 0).every((word) => word === "-D")).toBe(true);
    const values = Object.fromEntries(pairs.filter((_, index) => index % 2 === 1).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    expect(Object.keys(values)).toEqual(["HOME", "DATA_DIR", "REPO", "NODE_DIR", "NPM_CACHE", "KIRO_HOME", "CREW_HOME", "TMPDIR"]);
    expect(values).toMatchObject({
      HOME: realpathSync(home),
      DATA_DIR: `${realScratch}/real data folder`,
      REPO: repoRoot(),
      // The Node.js install itself, not the link to it and not its bin folder.
      NODE_DIR: `${realScratch}/node-v99.0.0-made-up`,
      NPM_CACHE: `${realpathSync(home)}/.npm`,
      KIRO_HOME: `${realpathSync(home)}/.kiro`,
      CREW_HOME: `${realpathSync(home)}/.kiro/crew`,
      // The folder the job is handed as TMPDIR: the build jobs' own, inside the (real) data folder.
      // Never the temporary folder this account shares with every other program.
      TMPDIR: `${realScratch}/real data folder/tmp/build`,
    });
    expect(values.TMPDIR).toBe(`${values.DATA_DIR}/tmp/build`);
    // No word on the line has a link left in it: each is its own real path.
    for (const value of [line[2], line.at(-4), ...Object.values(values)]) {
      expect(value?.startsWith("/"), value).toBe(true);
      const existing = existsSync(value ?? "") ? value : path.dirname(value ?? "");
      if (existsSync(existing ?? "")) expect(realpathSync(existing ?? ""), value).toBe(existing);
    }
  });

  it("stops, naming them, when the profile wants a value the installer does not know how to fill", () => {
    const profile = madeUpProfile("unknown params.sb", ["HOME", "MADE_UP_PLACE", "DATA_DIR", "ANOTHER_ONE"]);
    const ran = runScript('SANDBOX_PROFILE="$1"; shift; crew_command "$@"', [profile, "overnight", "/bin/sh", home, scratch, process.execPath]);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain("install-agents: The sandbox profile asks for values this script does not know how to fill: MADE_UP_PLACE ANOTHER_ONE");
    expect(ran.stderr).toContain("Nothing was changed.");

    // A profile that asks for nothing is not the right file.
    const empty = runScript('SANDBOX_PROFILE="$1"; shift; crew_command "$@"', [madeUpProfile("empty profile.sb", []), "overnight", "/bin/sh", home, scratch, process.execPath]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("install-agents: The sandbox profile names nothing to protect");
    // crew mode never reads the profile at all.
    expect(runScript('SANDBOX_PROFILE="$1"; shift; crew_command "$@"', [path.join(scratch, "no such profile.sb"), "crew", "/bin/sh", home, scratch, process.execPath]).status).toBe(0);
  });

  it("knows how to fill every value the real profile asks for today", () => {
    // The one look at the real packages/builder/sandbox/crew-gateway.sb: its names only.
    const names = withScript('profile_params "$SANDBOX_PROFILE"').trimEnd().split("\n").filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(["HOME", "DATA_DIR", "REPO"]));
    for (const name of names) {
      const filled = runScript('profile_value "$@"', [name, home, scratch, process.execPath]);
      expect(filled.status, `the installer does not know the profile's ${name}`).toBe(0);
      expect(filled.stdout.startsWith("/"), name).toBe(true);
    }
    expect(runScript('profile_value "$@"', ["NOT_A_NAME_IT_KNOWS", home, scratch, process.execPath]).status).toBe(2);
  });

  it("checks with macOS itself that the sandbox command loads, by starting nothing but /usr/bin/true inside it", () => {
    // Skipped where one sandbox cannot be started inside another (these tests may run in one).
    const usable = runScript("/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true").status === 0;
    if (!usable) return;
    const loads = (profile: string, pairs: string[]) => runScript('sandbox_command_loads "$@"', ["/usr/bin/sandbox-exec", "-f", profile, ...pairs, "/made-up/kirocrew", "gateway", "--no-open", "--no-tunnel"]).status;
    const good = madeUpProfile("loads.sb", ["HOME", "DATA_DIR"], '(deny file-write* (subpath (param "HOME")))');
    expect(loads(good, ["-D", `HOME=${realpathSync(home)}`, "-D", `DATA_DIR=${realpathSync(scratch)}`])).toBe(0);
    // A value the profile wants and was not given, and a profile that is not one.
    expect(loads(good, ["-D", `DATA_DIR=${realpathSync(scratch)}`])).not.toBe(0);
    const broken = path.join(scratch, "broken.sb");
    writeFileSync(broken, "(version 1)\n(this is not a sandbox rule\n");
    expect(loads(broken, ["-D", `HOME=${realpathSync(home)}`])).not.toBe(0);
    // Too short to be a sandbox command at all.
    expect(runScript('sandbox_command_loads "$@"', ["/made-up/kirocrew", "gateway", "--no-open", "--no-tunnel"]).status).not.toBe(0);
  });

  it("takes only kirocrew's own words for \"the gateway is running\"", () => {
    const standIn = (name: string, body: string) => {
      const file = path.join(scratch, name);
      writeFileSync(file, `#!/bin/sh\n# Made up for the tests. Not Kiro Crew.\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const says = (name: string, body: string) => runScript('gateway_says_running "$1"', [standIn(name, body)]).status === 0;
    // What kirocrew 0.8.0 prints, checked against the real program: it exits 0 either way.
    expect(says("status token", 'echo "Kiro Crew gateway is running (token auth enabled)."')).toBe(true);
    expect(says("status figures", 'printf "Kiro Crew v0.8.0\\n\\n  Uptime:      1m\\n"')).toBe(true);
    expect(says("status http", 'echo "Kiro Crew gateway is running but returned HTTP 500."')).toBe(true);
    expect(says("status down", 'echo "Kiro Crew gateway is not running."; echo "  Start it with: kirocrew gateway"')).toBe(false);
    expect(says("status silent", "exit 0")).toBe(false);
    expect(says("status other words", 'echo "Usage: kirocrew <command>"')).toBe(false);
    expect(says("status failed", 'echo "Kiro Crew gateway is running (token auth enabled)."; exit 3')).toBe(false);
    expect(runScript('gateway_says_running "$1"', [path.join(scratch, "no such kirocrew")]).status).not.toBe(0);
    // Only "status" is ever asked, with a bare environment.
    const asked = path.join(scratch, "status asked.txt");
    says("status recorder", `printf '%s|%s\\n' "$*" "$PATH" >"${asked}"; echo "Kiro Crew gateway is not running."`);
    expect(readFileSync(asked, "utf8")).toBe("status|/usr/bin:/bin:/usr/sbin:/sbin\n");
  });

  it("finds the repo from its own location, and uses the job names and settings files the app looks for", () => {
    expect(withScript('printf "%s" "$REPO"')).toBe(repoRoot());
    expect(withScript("label_of listen")).toBe(JOB_LABEL);
    expect(withScript("plist_of listen")).toBe(jobSettingsFile(home));
    expect(withScript('printf "%s" "$ENV_FILE"')).toBe(path.join(repoRoot(), ".env"));
    for (const job of ["build", "deliver", "crew"] as const) {
      expect(withScript(`label_of ${job}`)).toBe(NIGHT_JOB_LABELS[job]);
      expect(withScript(`plist_of ${job}`)).toBe(jobSettingsFile(home, NIGHT_JOB_LABELS[job]));
      expect(withScript(`DOMAIN=gui/not-a-real-domain; target_of ${job}`)).toBe(`gui/not-a-real-domain/${NIGHT_JOB_LABELS[job]}`);
      expect(withScript(`template_of ${job}`)).toBe(templateFile(job));
    }
    expect(withScript('printf "%s " "${ALL_JOBS[@]}"').trim().split(" ")).toEqual(JOBS);
    expect(withScript('printf "%s" "$SANDBOX_PROFILE"')).toBe(SANDBOX_PROFILE);
    expect(withScript('printf "%s" "$SKILL_SOURCE"')).toBe(path.join(repoRoot(), "crew", "build-skill.md"));
  });

  it("works out when the morning starts: 30 minutes before DELIVER_TIME, around midnight too", () => {
    const minus = (time: string, minutes: number) => runScript('clock_minus "$@"', [time, String(minutes)]);
    expect(minus("07:00", 30)).toMatchObject({ status: 0, stdout: "6 30" });
    expect(minus("01:00", 0)).toMatchObject({ status: 0, stdout: "1 0" });
    // "08" and "09" must not be read as (invalid) octal numbers.
    expect(minus("08:09", 0)).toMatchObject({ status: 0, stdout: "8 9" });
    expect(minus("09:08", 30)).toMatchObject({ status: 0, stdout: "8 38" });
    expect(minus("00:10", 30)).toMatchObject({ status: 0, stdout: "23 40" });
    expect(minus("00:00", 30)).toMatchObject({ status: 0, stdout: "23 30" });
    expect(minus("23:59", 30)).toMatchObject({ status: 0, stdout: "23 29" });
    for (const bad of ["24:00", "7:00", "07:60", "seven", ""]) expect(minus(bad, 30).status, bad).toBe(1);
    expect(withScript("clock_text 6 5")).toBe("06:05");
  });

  it("tells two names for one clock from two different clocks", () => {
    const same = (a: string, b: string) => runScript('same_clock "$@"', [process.execPath, a, b]).status === 0;
    expect(same("America/Boise", "America/Boise")).toBe(true);
    expect(same("America/Boise", "America/Denver")).toBe(true);
    // Same offset for half the year only: Arizona does not change its clocks.
    expect(same("America/Denver", "America/Phoenix")).toBe(false);
    expect(same("America/Boise", "America/New_York")).toBe(false);
    expect(same("America/Boise", "Not/AZone")).toBe(false);
  });

  it("says so, once and only then, when this Mac's clock is not the one Overnight goes by", () => {
    const note = (mac: string, setting: string) => runScript('MAC="$1"; mac_time_zone() { [[ -n "$MAC" ]] || return 1; printf "%s" "$MAC"; }; print_clock_note "$2" "$3"', [mac, process.execPath, setting]);
    expect(note("America/New_York", "America/Boise")).toEqual({
      status: 0,
      stdout: "  Note: this Mac's clock is set to America/New_York. Overnight goes by its own TZ setting, America/Boise: 01:00 means 01:00 there.\n",
      stderr: "",
    });
    // The same zone, two names for one clock, and a Mac whose zone cannot be read: nothing to say, and nothing refused.
    for (const mac of ["America/Boise", "America/Denver", ""]) expect(note(mac, "America/Boise"), mac).toEqual({ status: 0, stdout: "", stderr: "" });
    // The check that used to refuse an install is gone from the script.
    expect(readFileSync(SCRIPT, "utf8")).not.toContain("require_same_clock");
  });

  it("reads a value from the tool's report by name, also one further down, and only when it is there as text", () => {
    const report = JSON.stringify({ timeZone: "America/Boise", paused: true, empty: "", nightClock: { tickSeconds: 60, build: { checkedAt: "2026-10-11T07:00:00.000Z", lastRun: null }, deliver: { checkedAt: null } }, "dotted.name": "not reached by a path" });
    const value = (name: string) => runScript('report_value "$@"', [process.execPath, report, name]);
    expect(value("timeZone")).toMatchObject({ status: 0, stdout: "America/Boise" });
    expect(value("nightClock.build.checkedAt")).toMatchObject({ status: 0, stdout: "2026-10-11T07:00:00.000Z" });
    // Not there, not text, empty, or a way down through something that is not a list of names.
    for (const name of ["nightClock.deliver.checkedAt", "nightClock.build.lastRun", "nightClock.build.lastRun.startedAt", "nightClock.crew.checkedAt", "nightClock.tickSeconds", "nightClock", "paused", "empty", "timeZone.length", "nightClock.build.checkedAt.length", "constructor.name", "dotted.name", "", "."]) {
      expect(value(name), name).toMatchObject({ status: 1, stdout: "" });
    }
    expect(runScript('report_value "$@"', [process.execPath, "not a report", "timeZone"])).toMatchObject({ status: 1, stdout: "" });
  });

  it("writes the time now the way the app writes one, so two of them compare as text", () => {
    const before = new Date().toISOString();
    const stamp = withScript('utc_now "$1"', [process.execPath]).trim();
    const after = new Date().toISOString();
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(stamp).toISOString()).toBe(stamp);
    expect(before <= stamp && stamp <= after).toBe(true);
    // Without a node that answers it still gives a time of that shape, to the second.
    expect(withScript('utc_now "$1"', [path.join(scratch, "no such node")]).trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  });

  /** A made-up launchctl that says a job has a process at the looks named (their numbers, or "all"), and counts its looks. */
  const LOOKS = `
    BUSY="$1"; COUNT="$2"; shift 2
    launchctl() {
      local looks=$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 ))
      echo "$looks" >"$COUNT"
      printf '%s = {\\n\\tstate = x\\n' "$2"
      if [[ "$BUSY" == all || " $BUSY " == *" $looks "* ]]; then printf '\\tpid = 5151\\n'; fi
      printf '}\\n'
    }
    sleep() { echo "slept $1" >>"$COUNT.sleeps"; }
  `;

  it("takes a night job to be at work only when it has a process on two looks, two seconds apart", () => {
    const busy = (looks: string) => {
      counter += 1;
      const count = path.join(scratch, `busy looks ${counter}`);
      const ran = runScript(`${LOOKS} night_job_busy build`, [looks, count]);
      return { busy: ran.status === 0, looks: Number(readFileSync(count, "utf8")), sleeps: existsSync(`${count}.sleeps`) ? readFileSync(`${count}.sleeps`, "utf8") : "" };
    };
    expect(busy("all")).toEqual({ busy: true, looks: 2, sleeps: "slept 2\n" });
    // Its look at the clock, which takes a moment every minute, is not work.
    expect(busy("1")).toEqual({ busy: false, looks: 2, sleeps: "slept 2\n" });
    // No process at the first look: no need for a second.
    expect(busy("")).toEqual({ busy: false, looks: 1, sleeps: "" });
    expect(busy("2")).toEqual({ busy: false, looks: 1, sleeps: "" });
    // A job macOS does not list is not at work.
    expect(runScript("launchctl() { return 113; }; night_job_busy build").status).toBe(1);

    const refused = runScript(`${LOOKS} require_not_busy "$@"; echo went on`, ["all", path.join(scratch, "busy looks refused"), "deliver", "restarting"]);
    expect(refused).toEqual({ status: 1, stdout: "", stderr: "install-agents: The morning delivery is running right now, and restarting would cut it off. Run this again when it has finished. Nothing was changed.\n" });
    // When jobs named before it are done by then, it does not claim that nothing was changed.
    const later = runScript(`${LOOKS} DONE_JOBS=(listen crew); require_not_busy "$@"; echo went on`, ["all", path.join(scratch, "busy looks later"), "build", "installing"]);
    expect(later).toEqual({ status: 1, stdout: "", stderr: "install-agents: The nightly build is running right now, and installing would cut it off. Run this again when it has finished. The build job was left as it was (already done: listen crew).\n" });
    expect(runScript(`${LOOKS} require_not_busy "$@"; echo went on`, ["1", path.join(scratch, "busy looks free"), "build", "installing"])).toMatchObject({ status: 0, stdout: "went on\n" });
  });

  /** A made-up tool whose report gives the look number at which each answer starts: "<look> <checkedAt or null>" per line of $ANSWERS. */
  const REPORTS = `
    ANSWERS="$1"; ASKED="$2"; shift 2
    job_cli() {
      shift
      printf '%s\\n' "$*" >>"$ASKED"
      local looks checked=null from value
      looks="$(wc -l <"$ASKED" | tr -d ' ')"
      while read -r from value; do
        if (( looks >= from )); then checked="$value"; fi
      done <"$ANSWERS"
      [[ "$checked" != fails ]] || return 1
      [[ "$checked" == null || "$checked" == '{}' ]] || checked="\\"$checked\\""
      printf '{"nightClock":{"build":{"checkedAt":%s},"deliver":{"checkedAt":null}}}\\n' "$checked"
    }
    sleep() { echo "slept $1" >>"$ASKED.sleeps"; }
  `;

  it("waits for a night job's first look at the clock: one written down after the job was started, within 30 seconds", () => {
    const SINCE = "2026-10-11T07:00:00.000Z";
    const waited = (answers: string[], job = "build") => {
      counter += 1;
      const file = path.join(scratch, `first check ${counter}`);
      writeFileSync(`${file}.answers`, answers.map((line) => `${line}\n`).join(""));
      const ran = runScript(`${REPORTS} wait_for_first_check "$@"`, [`${file}.answers`, file, process.execPath, job, SINCE]);
      const asked = existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n") : [];
      return { came: ran.status === 0, asked: asked.length, sleeps: existsSync(`${file}.sleeps`) ? readFileSync(`${file}.sleeps`, "utf8").trimEnd().split("\n").length : 0, questions: [...new Set(asked)] };
    };
    // There at the first look: no waiting at all. Only ever `status --json` is asked.
    expect(waited(["1 2026-10-11T07:00:00.001Z"])).toEqual({ came: true, asked: 1, sleeps: 0, questions: ["status --json"] });
    // It comes at the fourth look: three waits of two seconds.
    expect(waited(["1 null", "4 2026-10-11T07:00:06.500Z"])).toEqual({ came: true, asked: 4, sleeps: 3, questions: ["status --json"] });
    // A look from before the start, however recent, is not the new job's: the old copy made it.
    expect(waited(["1 2026-10-11T06:59:59.999Z", "3 2026-10-11T07:00:02.000Z"])).toMatchObject({ came: true, asked: 3 });
    // Never: a look of ours every two seconds for 30 seconds, and no more.
    const never = { came: false, asked: 15, sleeps: 14 };
    expect(waited(["1 null"])).toMatchObject(never);
    expect(waited(["1 2026-10-11T06:59:59.999Z"])).toMatchObject(never);
    // The very moment of the start is not after it.
    expect(waited([`1 ${SINCE}`])).toMatchObject(never);
    // Something that is not a time written the app's way is not compared at all, even if it would sort later.
    for (const odd of ["2026-10-11T07:00:01Z", "9999", "tomorrow", "2026-10-12", "{}"]) expect(waited([`1 ${odd}`]), odd).toMatchObject(never);
    // The tool will not answer: the job would fail the same way, so that is "not yet" too.
    expect(waited(["1 fails"])).toMatchObject(never);
    // The other job's look does not count for this one.
    expect(waited(["1 2026-10-11T07:00:00.001Z"], "deliver")).toMatchObject(never);
    expect(withScript('printf "%s" "$FIRST_CHECK_WAIT_SECONDS"')).toBe("30");
  }, 60_000);

  it("works out the data folder the way the app does", () => {
    // The app asks the system for the home folder, so point that at the same scratch folder the script gets.
    vi.stubEnv("HOME", home);
    // No node is passed, so the repo's own .env (if there is one) plays no part here.
    const script = (value?: string) => withScript('resolve_data_dir ""', [], value === undefined ? {} : { OVERNIGHT_DATA_DIR: value });
    const app = (value?: string) => parseConfig(value === undefined ? {} : { OVERNIGHT_DATA_DIR: value }).dataDir;

    // Proof that the app really is looking at the scratch home.
    expect(app()).toBe(path.join(home, ".overnight"));
    for (const value of [undefined, "", "   ", "~", "~/over night", "~/ends with a slash/", "/Volumes/Data Disk/overnight", "/Volumes/Data Disk/overnight/"]) {
      expect(script(value), `OVERNIGHT_DATA_DIR=${JSON.stringify(value)}`).toBe(app(value));
    }
  });

  it("refuses a relative OVERNIGHT_DATA_DIR with the same words as the app", () => {
    const message = "OVERNIGHT_DATA_DIR must be a full path or start with ~/";
    for (const value of ["data here", "./data", "../data", "~someone/data"]) {
      expect(() => parseConfig({ OVERNIGHT_DATA_DIR: value }), value).toThrow("OVERNIGHT_DATA_DIR: must be a full path or start with ~/");
      const ran = runScript('resolve_data_dir ""', [], { OVERNIGHT_DATA_DIR: value });
      expect(ran.status, value).toBe(1);
      expect(ran.stderr).toBe(`install-agents: ${message}\n`);
      expect(ran.stdout).toBe("");

      // From the .env file, which is what the job reads: refused there too, and the caller stops.
      const envFile = path.join(scratch, "relative .env");
      writeFileSync(envFile, `# made up for this test\nOVERNIGHT_DATA_DIR=${value}\n`);
      const fromFile = runScript('set -e; ENV_FILE="$1"; data="$(job_data_dir "$2")"; echo "went on with $data"', [envFile, process.execPath]);
      expect(fromFile.status, value).toBe(1);
      expect(fromFile.stderr).toBe(`install-agents: ${message}\n`);
      expect(fromFile.stdout).toBe("");

      // Status stops rather than guessing a folder.
      const shown = runScript("launchctl() { return 113; }; cmd_status listen; echo went on", [], { OVERNIGHT_DATA_DIR: value });
      expect(shown.status, value).toBe(1);
      expect(shown.stderr).toContain(message);
      expect(shown.stdout).not.toContain("went on");
    }
  });

  it("reads OVERNIGHT_DATA_DIR from the .env file when the environment does not set it", () => {
    const envFile = path.join(scratch, "made-up .env");
    writeFileSync(envFile, "# made up for this test\nMAX_ASKS_PER_DAY=1\nOVERNIGHT_DATA_DIR=/Volumes/Data Disk/from env file\n");
    const lines = 'ENV_FILE="$1"; resolve_data_dir "$2"';
    expect(withScript(lines, [envFile, process.execPath])).toBe("/Volumes/Data Disk/from env file");
    // A value already in the environment wins, as it does in the app.
    expect(withScript(lines, [envFile, process.execPath], { OVERNIGHT_DATA_DIR: "/tmp/from the environment" })).toBe("/tmp/from the environment");
    // The background job never sees the shell's value: it gets what .env says.
    expect(withScript('ENV_FILE="$1"; job_data_dir "$2"', [envFile, process.execPath], { OVERNIGHT_DATA_DIR: "/tmp/from the environment" })).toBe("/Volumes/Data Disk/from env file");
    expect(withScript('ENV_FILE="$1"; job_data_dir "$2"', [path.join(scratch, "no such .env"), process.execPath], { OVERNIGHT_DATA_DIR: "/tmp/from the environment" })).toBe(path.join(home, ".overnight"));
  });

  it("refuses a Node.js older than 22.18", () => {
    const fakeNode = (version: string) => {
      const file = path.join(scratch, `node ${version}`);
      writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    for (const version of ["22.18.0", "22.19.3", "24.21.0", "26.0.0"]) {
      expect(withScript('require_node_version "$1"; printf ok', [fakeNode(version)])).toBe("ok");
    }
    for (const version of ["18.20.4", "20.19.0", "22.17.1"]) {
      const failed = runScript('require_node_version "$1"; printf ok', [fakeNode(version)]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(`Node.js ${version}`);
      expect(failed.stderr).toContain("too old");
    }
  });

  it("boils the job's state down to state, pid and last exit code, plus the last 5 lines of each log", () => {
    const dataDir = path.join(scratch, "data folder");
    mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    const numbered = (what: string, count: number) => Array.from({ length: count }, (_, index) => `made-up ${what} line ${index + 1}`).join("\n") + "\n";
    writeFileSync(path.join(dataDir, "logs", "listen.log"), numbered("log", 7));
    writeFileSync(path.join(dataDir, "logs", "listen.launchd.log"), numbered("crash", 2));
    const listing = path.join(scratch, "launchctl print.txt");
    writeFileSync(
      listing,
      [
        "gui/501/com.overnight.listen = {",
        "\tactive count = 1",
        "\tpath = /Users/someone/Library/LaunchAgents/com.overnight.listen.plist",
        "\ttype = LaunchAgent",
        "\tstate = running",
        "",
        "\tprogram = /opt/node/bin/node",
        "\truns = 3",
        "\tpid = 4242",
        "\tlast exit code = 0",
        "",
        "\tresource coalition = {",
        "\t\tID = 9001",
        "\t\ttype = resource",
        "\t\tstate = active",
        "\t\tpid = 1",
        "\t}",
        "}",
        "",
      ].join("\n"),
    );

    const out = withScript('LISTING="$1"; launchctl() { cat "$LISTING"; }; cmd_status listen', [listing], { OVERNIGHT_DATA_DIR: dataDir });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           running",
      "  pid:             4242",
      "  last exit code:  0",
      `  last 5 lines of its log (${dataDir}/logs/listen.log):`,
      "    made-up log line 3",
      "    made-up log line 4",
      "    made-up log line 5",
      "    made-up log line 6",
      "    made-up log line 7",
      `  last 5 lines printed outside that log, for example by a crash (${dataDir}/logs/listen.launchd.log):`,
      "    made-up crash line 1",
      "    made-up crash line 2",
      "",
    ]);
  });

  it("says so when the job is not installed", () => {
    const dataDir = path.join(scratch, "empty data folder");
    const out = withScript("launchctl() { return 113; }; cmd_status listen", [], { OVERNIGHT_DATA_DIR: dataDir });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           not installed",
      `  nothing in its log yet (${dataDir}/logs/listen.log)`,
      `  nothing printed outside that log (${dataDir}/logs/listen.launchd.log)`,
      "",
    ]);
  });

  it("shows all four jobs, one after the other, when none is named", () => {
    const dataDir = path.join(scratch, "empty data folder");
    const out = withScript("launchctl() { return 113; }; cmd_status", [], { OVERNIGHT_DATA_DIR: dataDir });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           not installed",
      `  nothing in its log yet (${dataDir}/logs/listen.log)`,
      `  nothing printed outside that log (${dataDir}/logs/listen.launchd.log)`,
      "",
      "Kiro Crew gateway (com.overnight.crew)",
      "  state:           not installed",
      `  nothing printed yet (${dataDir}/logs/crew.launchd.log)`,
      "  its own log:     kirocrew logs",
      "",
      "Overnight nightly build (com.overnight.build)",
      "  state:           not installed",
      `  nothing in its log yet (${dataDir}/logs/build.log)`,
      `  nothing printed outside that log (${dataDir}/logs/build.launchd.log)`,
      "",
      "Overnight morning delivery (com.overnight.deliver)",
      "  state:           not installed",
      `  nothing in its log yet (${dataDir}/logs/deliver.log)`,
      `  nothing printed outside that log (${dataDir}/logs/deliver.launchd.log)`,
      "",
    ]);
    // Naming one shows that one alone.
    expect(withScript("launchctl() { return 113; }; cmd_status build", [], { OVERNIGHT_DATA_DIR: dataDir }).split("\n")[0]).toBe("Overnight nightly build (com.overnight.build)");
  });

  it("hands each subcommand the job named, every job when none or \"all\" is, and refuses a name it does not know", () => {
    // The real subcommands are replaced by stand-ins that only say what they were asked.
    const asked = (...args: string[]) =>
      runScript('for name in install uninstall restart status; do eval "cmd_$name() { echo \\"$name:\\$*\\"; }"; done; main "$@"', args);
    for (const action of ["install", "uninstall", "restart", "status"]) {
      expect(asked(action)).toMatchObject({ status: 0, stdout: `${action}:\n` });
      expect(asked(action, "all")).toMatchObject({ status: 0, stdout: `${action}:\n` });
      for (const job of JOBS) expect(asked(action, job)).toMatchObject({ status: 0, stdout: `${action}:${job}\n` });
      for (const bad of ["listener", "ALL", "", "build deliver"]) {
        const refused = asked(action, bad);
        expect(refused.status, `${action} ${bad}`).toBe(2);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("Usage: scripts/install-agents.sh");
      }
      expect(asked(action, "build", "deliver").status).toBe(2);
    }
    expect(asked("help")).toMatchObject({ status: 0 });
    expect(asked("help").stdout).toContain("[listen | crew | build | deliver | all]");
  });

  it("prints its usage and exits 2 when no subcommand, or an unknown one, is given", () => {
    // Never "install", "uninstall" or "restart" here, not even in a call that should be refused.
    for (const args of [[], ["frobnicate"], ["status", "extra"], ["status", "listen", "extra"]]) {
      try {
        execFileSync(SCRIPT, args, { encoding: "utf8", timeout: 15_000, env: { PATH: BARE_PATH, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
        throw new Error("expected the script to refuse");
      } catch (error) {
        const failed = error as { status?: number | null; stderr?: string };
        expect(failed.status).toBe(2);
        expect(failed.stderr).toContain("Usage: scripts/install-agents.sh <install | uninstall | restart | status>");
      }
    }
  });
});

describeOnMac("scripts/install-agents.sh install (dry run: nothing real is installed or started)", () => {
  // Stands in for macOS. Records every call; remembers in one file per job whether that made-up
  // job is "loaded"; and answers `print` the way launchctl does: exit 113 when it is not loaded,
  // else a listing. An always-on job has a pid unless it is meant to have died straight away; a
  // night job is listed with no pid, as between two of its looks at the clock, unless the test
  // names the looks at which it has one (DRY_BUSY_LOOKS: "all", or their numbers in this run).
  //
  // It also stands in for what macOS does with a night job it has just loaded: the job is started
  // once, and looks at the clock. Only for a settings file that asks for it, as the real one does
  // (started when loaded, and run with the if-due switch), and unless the test says the job never
  // looks. No build or delivery is run: the time of the look is written into the scratch database
  // with the app's own function, which is all a look at the clock that finds nothing due does.
  const DRY_RUN = `
    CALLS="$1"; STATE="$2"; MODE="$3"; SCRATCH="$4"; ENV_FILE="$5"; DATA="$6"; CLI_CALLS="$7"
    shift 7
    ORDER="$CALLS.order"
    first_look() {
      [[ "$(plutil -extract RunAtLoad raw -o - "$2" 2>/dev/null)" == true ]] || return 0
      [[ "$(plutil -extract ProgramArguments.3 raw -o - "$2" 2>/dev/null)" == --if-due ]] || return 0
      "$(command -v node)" --input-type=module -e '
        const [core, database, job] = process.argv.slice(1);
        const { Store, noteChecked } = await import(core);
        const store = new Store(database);
        noteChecked(store, job, new Date());
        store.close();
      ' "$REPO/packages/core/src/index.ts" "$DATA/overnight.db" "$1"
    }
    # What the gateway job's own copy of the sandbox profile holds at this moment: the first
    # letters of its checksum, or "none". And how many new copies are waiting beside it.
    profile_now() {
      local copy="$DATA/sandbox/crew-gateway.sb" sum=none waiting
      if [[ -f "$copy" ]]; then sum="$(/usr/bin/shasum <"$copy" | cut -c1-12)"; fi
      waiting="$(find "$DATA/sandbox" -name '.crew-gateway.sb.*' 2>/dev/null | wc -l | tr -d ' ')"
      printf '%s copy=%s waiting=%s\\n' "$1" "$sum" "$waiting" >>"$CALLS.profile"
    }
    launchctl() {
      printf '%s\\n' "$*" >>"$CALLS"
      printf 'launchctl %s\\n' "$*" >>"$ORDER"
      local job looks
      case "$1" in
        bootout)
          job="\${2##*/}"
          profile_now "stop $job"
          # A job that will not stop stays on macOS's list however often it is asked.
          if [[ "$MODE" != "wont-stop" ]]; then echo down >"$STATE.$job"; fi
          ;;
        bootstrap)
          if [[ "$MODE" == "bootstrap-fails" ]]; then
            echo "Bootstrap failed: 5: Input/output error" >&2
            return 5
          fi
          job="$(basename -- "$3" .plist)"
          profile_now "start $job"
          if [[ "$MODE" != "not-listed" ]]; then echo up >"$STATE.$job"; fi
          if [[ "$MODE" != "not-listed" && "$MODE" != "never-looks" ]] && [[ "$job" == com.overnight.build || "$job" == com.overnight.deliver ]]; then
            first_look "\${job##*.}" "$3"
          fi
          ;;
        print)
          job="\${2##*/}"
          [[ "$(cat "$STATE.$job" 2>/dev/null)" == up ]] || return 113
          # The looks at this job in this run, counted: $$ is this run's own number.
          looks=$(( $(cat "$STATE.$job.looks.$$" 2>/dev/null || echo 0) + 1 ))
          echo "$looks" >"$STATE.$job.looks.$$"
          printf '%s = {\\n' "$2"
          if [[ "$MODE" == "job-dies" ]]; then
            printf '\\tstate = spawn scheduled\\n\\tlast exit code = 2\\n}\\n'
          elif [[ "$job" == com.overnight.build || "$job" == com.overnight.deliver ]]; then
            if [[ "\${DRY_BUSY_LOOKS:-}" == all || " \${DRY_BUSY_LOOKS:-} " == *" $looks "* ]]; then
              printf '\\tstate = running\\n\\tpid = 5151\\n\\tlast exit code = 0\\n}\\n'
            else
              printf '\\tstate = not running\\n\\tlast exit code = (never exited)\\n}\\n'
            fi
          else
            printf '\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = (never exited)\\n}\\n'
          fi
          ;;
      esac
      return 0
    }
    sleep() { :; }
    DOMAIN="gui/not-a-real-domain"
    for job in "\${ALL_JOBS[@]}"; do
      case "$(plist_of "$job")" in
        "$SCRATCH"/*) ;;
        *) echo "refusing: a settings file is outside the scratch folder" >&2; exit 99 ;;
      esac
    done
    # The build skill is copied under HOME, so that has to be a scratch folder too.
    case "$HOME" in
      "$SCRATCH"/*) ;;
      *) echo "refusing: the home folder is outside the scratch folder" >&2; exit 99 ;;
    esac
    case "$DATA" in
      "$SCRATCH"/*) ;;
      *) echo "refusing: the data folder is outside the scratch folder" >&2; exit 99 ;;
    esac
    # The real tool, in the same bare environment as the script's own job_cli, with two additions:
    # the data folder is forced into the scratch folder, and the settings these tests read back
    # are given by the test. (The real tool reads the repo's .env, not the made-up one, so without
    # this it could open the real data folder, or schedule by whatever the real .env says.)
    job_cli() {
      local node="$1"
      shift
      printf '%s\\n' "$*" >>"$CLI_CALLS"
      printf 'overnight %s\\n' "$*" >>"$ORDER"
      if [[ "$MODE" == "pause-fails" && "$1" == pause ]]; then
        echo "made-up failure of the pause command" >&2
        return 1
      fi
      local bad="3"
      if [[ "$MODE" == "bad-setting" ]]; then bad="not a number"; fi
      # KIROCREW_PORT: the status command asks this Mac whether the Kiro Crew gateway answers.
      # Port 9 is one where nothing listens, so a real gateway on this Mac is never asked.
      env -i HOME="$HOME" PATH="$(dirname -- "$node"):/usr/bin:/bin:/usr/sbin:/sbin" OVERNIGHT_DATA_DIR="$DATA" \\
        MAX_ASKS_PER_DAY="$bad" TZ="\${DRY_TZ:-America/Boise}" BUILD_TIME="\${DRY_BUILD_TIME:-01:00}" DELIVER_TIME="\${DRY_DELIVER_TIME:-07:00}" \\
        BUILD_SANDBOX="\${DRY_SANDBOX:-}" KIROCREW_PORT=9 "$node" "$ENTRY" "$@"
    }
    # This Mac's time zone, and whether something already listens on the gateway's port: made up.
    mac_time_zone() {
      [[ "\${DRY_MAC_ZONE-America/Boise}" != "" ]] || return 1
      printf '%s' "\${DRY_MAC_ZONE-America/Boise}"
    }
    gateway_port_busy() { [[ "\${DRY_PORT_BUSY:-no}" == yes ]]; }
    SKILL_SOURCE="$SCRATCH/made-up build-skill.md"
    # A made-up sandbox profile, never the real one, and a stand-in for asking macOS whether the
    # sandbox command loads: it notes what it was asked and answers as the test says.
    SANDBOX_PROFILE="\${DRY_PROFILE:-$SCRATCH/made-up crew-gateway.sb}"
    sandbox_command_loads() {
      printf '%s\\n' "$*" >>"$CALLS.sandbox"
      [[ "\${DRY_PROFILE_LOADS:-yes}" == yes ]]
    }
    "$@"
  `;

  interface DryRun extends Ran {
    home: string;
    /** The listener's settings file. The other jobs': plistOf(run, job). */
    plist: string;
    dataDir: string;
    /** What was asked of launchctl, in order. */
    calls: string[];
    /** What was asked of the `overnight` tool, in order. */
    cli: string[];
    /** Both of those in one list, in the order they happened: "launchctl ..." and "overnight ...". */
    order: string[];
    /** What was asked of the stand-in for Kiro Crew's program, in order. */
    kirocrew: string[];
    /** The sandbox commands macOS was "asked" to load (a stand-in answered), one per line. */
    sandboxChecks: string[];
    /** What the gateway job's copy of the sandbox profile held each time a job was stopped or started: "stop com.overnight.crew copy=<checksum or none> waiting=<new copies beside it>". */
    profileAt: string[];
  }

  type DryRunMode = "ok" | "job-dies" | "bootstrap-fails" | "pause-fails" | "bad-setting" | "not-listed" | "never-looks" | "wont-stop";

  interface DryRunOptions {
    mode?: DryRunMode;
    env?: Record<string, string>;
    envFile?: "sets the data folder" | "none";
    into?: DryRun;
    pathDir?: string;
    /** Runs just before the script does, on the made-up Mac: its data folder and its home folder. */
    before?: (dataDir: string, home: string) => void;
    /** Which jobs to name. Default: the listener alone. An empty list means none named, which is all of them. */
    jobs?: Job[];
    /** The subcommand's function. Default: install. */
    action?: "cmd_install" | "cmd_uninstall" | "cmd_restart";
    /** What the background jobs will read as BUILD_SANDBOX. Default: not set, which means "overnight". */
    sandbox?: string;
    /**
     * What the stand-in for Kiro Crew answers. "missing": there is no such program. Default: set
     * the way the sandbox mode needs. `gateway`: what its "status" says once the job has started
     * ("up" by default; "down" never answers; a number answers from that look on).
     */
    crew?: { sandbox?: string; allowUnsandboxed?: string; gateway?: "up" | "down" | number } | "missing";
    /** Leave the made-up build skill out. */
    skill?: "missing";
  }

  const SKILL_TEXT = "# made up for this test\nBuild one Overnight app.\n";
  /** The made-up sandbox profile every dry run uses unless it names another. */
  const MADE_UP_PROFILE = () => path.join(scratch, "made-up crew-gateway.sb");

  /** One made-up Mac per call (or the one passed in, to act on it a second time). */
  function dryRun(options: DryRunOptions = {}): DryRun {
    counter += 1;
    const root = options.into ? path.dirname(options.into.home) : path.join(scratch, `dry run ${counter}`);
    const fakeHome = path.join(root, "home of someone");
    const dataDir = options.envFile === "none" ? path.join(fakeHome, ".overnight") : path.join(root, "data folder");
    const envFile = path.join(root, "made-up .env");
    mkdirSync(fakeHome, { recursive: true });
    if (options.envFile !== "none") writeFileSync(envFile, `# made up for this test\nOVERNIGHT_DATA_DIR=${dataDir}\n`);
    const callsFile = path.join(root, "launchctl calls.txt");
    const cliCallsFile = path.join(root, "overnight calls.txt");

    // The stand-in for Kiro Crew's program: it answers "config get" from two small files and
    // refuses everything else, so a test can show that no setting is ever changed.
    const bin = path.join(fakeHome, ".local", "bin");
    const kirocrewCalls = path.join(bin, "kirocrew calls.txt");
    if (options.crew === "missing") {
      rmSync(path.join(bin, "kirocrew"), { force: true });
    } else {
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, "kirocrew"),
        [
          "#!/bin/sh",
          "# Made up for the tests. Not Kiro Crew.",
          'here="$(dirname "$0")"',
          `printf '%s\\n' "$*" >>"$here/kirocrew calls.txt"`,
          'if [ "$1" = config ] && [ "$2" = get ]; then',
          '  case "$3" in',
          '    agent.sandbox) cat "$here/agent.sandbox" || exit 1 ;;',
          '    agent.sandbox_allow_unsandboxed_exec) cat "$here/agent.allow" || exit 1 ;;',
          '    *) echo "Unknown key: $3" >&2; exit 1 ;;',
          "  esac",
          '  echo "a made-up warning on standard error" >&2',
          "  exit 0",
          "fi",
          // "status": the words kirocrew 0.8.0 prints, and its exit code 0 either way. The file
          // "gateway" holds "up", "down", or the number of the look from which it answers.
          'if [ "$1" = status ] && [ "$#" = 1 ]; then',
          '  looks=$(( $(cat "$here/looks" 2>/dev/null || echo 0) + 1 ))',
          '  echo "$looks" >"$here/looks"',
          '  answer="$(cat "$here/gateway")"',
          '  if [ "$answer" = up ] || { [ "$answer" != down ] && [ "$looks" -ge "$answer" ]; }; then',
          '    echo "Kiro Crew gateway is running (token auth enabled)."',
          '    echo "  For detailed stats, see the Overview page in the dashboard."',
          "  else",
          '    echo "Kiro Crew gateway is not running."',
          '    echo "  Start it with: kirocrew gateway"',
          "  fi",
          "  exit 0",
          "fi",
          'echo "the stand-in was asked for something other than config get or status" >&2',
          "exit 9",
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "kirocrew"), 0o755);
      // Set the way the mode needs unless the test says otherwise. Kiro Crew prints a Python value: "strict", "False", "True".
      const forCrewMode = options.sandbox === "crew";
      writeFileSync(path.join(bin, "agent.sandbox"), `${options.crew?.sandbox ?? "strict"}\n`);
      writeFileSync(path.join(bin, "agent.allow"), `${options.crew?.allowUnsandboxed ?? (forCrewMode ? "False" : "True")}\n`);
      writeFileSync(path.join(bin, "gateway"), `${options.crew?.gateway ?? "up"}\n`);
      rmSync(path.join(bin, "looks"), { force: true });
    }
    // The made-up sandbox profile: the three values every profile of ours asks for.
    writeFileSync(MADE_UP_PROFILE(), [";; Made up for the tests. Not Overnight's profile.", "(version 1)", "(allow default)", '(define home (param "HOME"))', '(define data-dir (param "DATA_DIR"))', '(define repo (param "REPO"))', ""].join("\n"));
    const skill = path.join(scratch, "made-up build-skill.md");
    if (options.skill === "missing") rmSync(skill, { force: true });
    else writeFileSync(skill, SKILL_TEXT);

    options.before?.(dataDir, fakeHome);
    const jobs = options.jobs ?? ["listen"];
    const ran = runScript(DRY_RUN, [callsFile, path.join(root, "job state"), options.mode ?? "ok", scratch, envFile, dataDir, cliCallsFile, options.action ?? "cmd_install", ...jobs], {
      PATH: `${options.pathDir ?? NODE_DIR}:${BARE_PATH}`,
      HOME: fakeHome,
      ...(options.sandbox === undefined ? {} : { DRY_SANDBOX: options.sandbox }),
      ...options.env,
    });
    const linesOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n") : []);
    return { ...ran, home: fakeHome, plist: jobSettingsFile(fakeHome), dataDir, calls: linesOf(callsFile), cli: linesOf(cliCallsFile), order: linesOf(`${callsFile}.order`), kirocrew: linesOf(kirocrewCalls), sandboxChecks: linesOf(`${callsFile}.sandbox`), profileAt: linesOf(`${callsFile}.profile`) };
  }
  /** The name the tests written for the listener alone know it by. */
  const dryRunInstall = dryRun;

  const plistOf = (run: DryRun, job: Job) => jobSettingsFile(run.home, label(job));
  const targetOf = (job: Job) => `gui/not-a-real-domain/${label(job)}`;
  const isNightJob = (job: Job) => job === "build" || job === "deliver";
  /** The launchctl calls that put one job in place: stop the old copy, start the new one, look. For a night job, first: is it at work? */
  const applyCalls = (run: DryRun, job: Job) => [...(isNightJob(job) ? [`print ${targetOf(job)}`] : []), `bootout ${targetOf(job)}`, `print ${targetOf(job)}`, `enable ${targetOf(job)}`, `bootstrap gui/not-a-real-domain ${plistOf(run, job)}`, `print ${targetOf(job)}`];
  /**
   * The launchctl calls of one install, or one restart, of one job: for a night job a look at
   * whether it is at work, before anything is changed; then the job is put in place; then its
   * status is shown.
   */
  const installCalls = (run: DryRun, job: Job) => [...(isNightJob(job) ? [`print ${targetOf(job)}`] : []), ...applyCalls(run, job), `print ${targetOf(job)}`];

  /** Run the real tool against a dry run's scratch data folder, the way the installer's stand-in does. */
  function overnight(run: DryRun, ...args: string[]): string {
    return execFileSync(process.execPath, [path.join(repoRoot(), "packages", "cli", "src", "main.ts"), ...args], {
      encoding: "utf8",
      timeout: 30_000,
      // KIROCREW_PORT: a port where nothing listens, so `status` never asks a real gateway.
      env: { PATH: `${NODE_DIR}:${BARE_PATH}`, HOME: run.home, OVERNIGHT_DATA_DIR: run.dataDir, KIROCREW_PORT: "9" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  /** What the real tool says about a night job's clock on a dry run's scratch data folder. */
  const clockOf = (run: DryRun, job: "build" | "deliver") =>
    (JSON.parse(overnight(run, "status", "--json")) as { nightClock: Record<string, { checkedAt: string | null; state: string; lastRun: unknown; trigger: string | null }> }).nightClock[job];

  const TARGET = "gui/not-a-real-domain/com.overnight.listen";

  it("stops any old copy, writes a private settings file, starts the job, and checks that it stayed up", () => {
    const run = dryRunInstall();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      `bootout ${TARGET}`,
      `print ${TARGET}`, // has the old copy gone?
      `enable ${TARGET}`,
      `bootstrap gui/not-a-real-domain ${run.plist}`,
      `print ${TARGET}`, // did the new one stay up?
      `print ${TARGET}`, // the status shown at the end
    ]);

    expect(mode(run.plist)).toBe(0o600);
    execFileSync("/usr/bin/plutil", ["-lint", run.plist], { timeout: 15_000, stdio: "ignore" });
    expect(plistAsJson(run.plist)).toEqual({
      Label: "com.overnight.listen",
      ProgramArguments: [NODE, ENTRY, "listen"],
      WorkingDirectory: repoRoot(),
      EnvironmentVariables: { PATH: `${NODE_DIR}:${BARE_PATH}`, HOME: run.home },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ProcessType: "Background",
      ExitTimeOut: 30,
      StandardOutPath: `${run.dataDir}/logs/listen.launchd.log`,
      StandardErrorPath: `${run.dataDir}/logs/listen.launchd.log`,
    });
    // macOS will not start a job whose log folder is missing, so install makes it, private.
    expect(mode(path.join(run.dataDir, "logs"))).toBe(0o700);
    expect(mode(run.dataDir)).toBe(0o700);

    // A first install: quiet mode is stored before anything else, the settings are tried the way
    // the job will read them, and after the start the mode is read back to tell the operator.
    expect(run.cli).toEqual(["--help", "pause", "status --json", "status --json"]);
    expect(JSON.parse(overnight(run, "status", "--json"))).toMatchObject({ paused: true });

    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe("Installed. Overnight now listens in the background and starts again at login.");
    expect(lines).toContain(`  data folder:  ${run.dataDir}`);
    expect(lines).toContain("This is a first install, so Overnight was put in quiet mode before it started.");
    expect(lines).toContain("Mode: paused (quiet mode). Overnight is listening and saving, not asking or building.");
    expect(lines).toContain("  Turn asking on with:      npx overnight resume");
    expect(run.stdout).not.toContain("LIVE");
    expect(lines).toContain("  state:           running");
    expect(lines).toContain("  pid:             4242");
  }, 30_000);

  it("is safe to repeat", () => {
    const first = dryRunInstall();
    const second = dryRunInstall({ into: first });
    expect(second.status).toBe(0);
    expect(second.plist).toBe(first.plist);
    expect(second.calls.slice(first.calls.length).map((call) => call.split(" ")[0])).toEqual(["bootout", "print", "enable", "bootstrap", "print", "print"]);
    expect(mode(second.plist)).toBe(0o600);
    execFileSync("/usr/bin/plutil", ["-lint", second.plist], { timeout: 15_000, stdio: "ignore" });
    // There is a database now, so the mode is left as it was: no second "pause".
    expect(second.cli.slice(first.cli.length)).toEqual(["--help", "status --json", "status --json"]);
    expect(second.stdout).not.toContain("first install");
    expect(second.stdout).toContain("Mode: paused (quiet mode).");
  }, 30_000);

  it("leaves a mode the operator chose alone on a later install, and says plainly when that mode is live", () => {
    const first = dryRunInstall();
    overnight(first, "resume");
    const second = dryRunInstall({ into: first });
    expect(second.status).toBe(0);
    expect(second.cli.slice(first.cli.length)).toEqual(["--help", "status --json", "status --json"]);
    const lines = second.stdout.split("\n");
    expect(lines).toContain("Mode: LIVE. Overnight asks about new ideas on the watch and builds approved ones.");
    expect(lines).toContain("  Go back to quiet mode with:  npx overnight pause");
    expect(JSON.parse(overnight(second, "status", "--json"))).toMatchObject({ paused: false });
  }, 30_000);

  it("stops before installing anything when a first install cannot be put in quiet mode", () => {
    const run = dryRunInstall({ mode: "pause-fails" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("made-up failure of the pause command");
    expect(run.stderr).toContain("install-agents: Could not put Overnight in quiet mode");
    expect(run.stderr).toContain("Nothing was installed or started.");
    expect(run.cli).toEqual(["--help", "pause"]);
    expect(run.calls).toEqual([]);
    expect(existsSync(run.plist)).toBe(false);
  }, 30_000);

  it("stops before installing anything when a setting is bad, with the tool's own message", () => {
    // On a first install the bad setting already stops "pause".
    const fresh = dryRunInstall({ mode: "bad-setting" });
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toContain("MAX_ASKS_PER_DAY");
    expect(fresh.cli).toEqual(["--help", "pause"]);
    expect(fresh.calls).toEqual([]);
    expect(existsSync(fresh.plist)).toBe(false);

    // On a later install it is the status check that catches it. The job already there is not touched.
    const first = dryRunInstall();
    const second = dryRunInstall({ into: first, mode: "bad-setting" });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("MAX_ASKS_PER_DAY");
    expect(second.stderr).toContain('install-agents: "overnight status" failed, so the job would fail too.');
    expect(second.cli.slice(first.cli.length)).toEqual(["--help", "status --json"]);
    expect(second.calls).toEqual(first.calls);
  }, 30_000);

  it("makes a data folder that already exists, open to others, private", () => {
    const run = dryRunInstall({
      before: (dataDir) => {
        mkdirSync(path.join(dataDir, "logs"), { recursive: true });
        chmodSync(dataDir, 0o755);
        chmodSync(path.join(dataDir, "logs"), 0o755);
      },
    });
    expect(run.status).toBe(0);
    expect(mode(run.dataDir)).toBe(0o700);
    expect(mode(path.join(run.dataDir, "logs"))).toBe(0o700);
  }, 30_000);

  it("does not claim success when the job is put in place but dies straight away", () => {
    const run = dryRunInstall({ mode: "job-dies" });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Installed.");
    // The state and the last exit code are shown, then the plain verdict.
    expect(run.stdout).toContain("  pid:             none (not running right now)");
    expect(run.stdout).toContain("  last exit code:  2");
    expect(run.stderr).toContain("install-agents: The job is in place but is not running.");
    // Two looks (a slow start is not a failure), then the status.
    expect(run.calls.map((call) => call.split(" ")[0])).toEqual(["bootout", "print", "enable", "bootstrap", "print", "print", "print"]);
  }, 30_000);

  it("exits 1 with a clear message when macOS will not start the job", () => {
    const run = dryRunInstall({ mode: "bootstrap-fails" });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Installed.");
    expect(run.stderr).toContain("install-agents: macOS would not start the job (launchctl bootstrap failed).");
    // One retry, out loud, and no "did it stay up" look after a start that never happened.
    expect(run.calls.map((call) => call.split(" ")[0])).toEqual(["bootout", "print", "enable", "bootstrap", "bootstrap"]);
  }, 30_000);

  it("refuses a Node.js older than 22.18 before touching anything", () => {
    const bin = path.join(scratch, "old node bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "node"), "#!/bin/sh\necho 22.17.1\n");
    chmodSync(path.join(bin, "node"), 0o755);

    const run = dryRunInstall({ pathDir: bin });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Node.js 22.17.1");
    expect(run.stderr).toContain("too old");
    expect(run.calls).toEqual([]);
    expect(existsSync(run.plist)).toBe(false);
    expect(existsSync(run.dataDir)).toBe(false);
  }, 30_000);

  it("refuses when OVERNIGHT_DATA_DIR is set only in the shell, where the background job would never see it", () => {
    const shellOnly = path.join(scratch, "shell-only data folder");
    const run = dryRunInstall({ envFile: "none", env: { OVERNIGHT_DATA_DIR: shellOnly } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`OVERNIGHT_DATA_DIR is set in this shell (${shellOnly})`);
    expect(run.stderr).toContain(`would use ${path.join(run.home, ".overnight")}`);
    expect(run.stderr).toContain("Nothing was changed.");
    expect(run.calls).toEqual([]);
    expect(existsSync(run.plist)).toBe(false);
    expect(existsSync(shellOnly)).toBe(false);

    // The same value in the shell and in .env is no disagreement.
    const agreeing = dryRunInstall();
    const again = dryRunInstall({ into: agreeing, env: { OVERNIGHT_DATA_DIR: agreeing.dataDir } });
    expect(again.status).toBe(0);
  }, 30_000);

  it("with no .env and nothing in the shell, uses ~/.overnight", () => {
    const run = dryRunInstall({ envFile: "none" });
    expect(run.status).toBe(0);
    expect(run.dataDir).toBe(path.join(run.home, ".overnight"));
    expect((plistAsJson(run.plist) as { StandardOutPath: string }).StandardOutPath).toBe(`${run.home}/.overnight/logs/listen.launchd.log`);
  }, 30_000);

  it("status reads the log folder from the installed settings file, not from the shell it runs in", () => {
    const installed = dryRunInstall();
    writeFileSync(path.join(installed.dataDir, "logs", "listen.log"), "made-up log line\n");
    // A shell that points somewhere else entirely, and a job macOS is not running.
    const out = withScript("launchctl() { return 113; }; cmd_status listen", [], { HOME: installed.home, OVERNIGHT_DATA_DIR: path.join(scratch, "somewhere else") });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           not loaded (the settings file is there, but macOS is not running the job)",
      // The job is named: a bare "install" would mean every job.
      "                   Run: scripts/install-agents.sh install listen",
      `  last 5 lines of its log (${installed.dataDir}/logs/listen.log):`,
      "    made-up log line",
      `  nothing printed outside that log (${installed.dataDir}/logs/listen.launchd.log)`,
      "",
    ]);
  }, 30_000);

  // ---------- the night's jobs ----------

  const kirocrewOf = (run: DryRun) => path.join(run.home, ".local", "bin", "kirocrew");
  const skillDirOf = (run: DryRun) => path.join(run.home, ".kiro", "crew", "skills", "overnight-build");
  const skillOf = (run: DryRun) => path.join(skillDirOf(run), "SKILL.md");
  /** Nothing was installed, started, stopped or copied. */
  const expectUntouched = (run: DryRun, jobs: Job[] = JOBS) => {
    expect(run.calls).toEqual([]);
    for (const job of jobs) expect(existsSync(plistOf(run, job)), job).toBe(false);
    expect(existsSync(skillOf(run))).toBe(false);
    // None of the folders `install crew` makes for the gateway was made either.
    for (const folder of [path.join(run.home, "workplace"), path.join(run.home, ".kiro", "sessions"), path.join(run.home, ".npm")]) expect(existsSync(folder), folder).toBe(false);
    // Nor was the gateway job given a copy of the sandbox profile, or even a folder for one.
    expect(existsSync(path.join(run.dataDir, "sandbox")), "the folder for the gateway's copy of the sandbox profile").toBe(false);
    expect(run.stdout).not.toContain("Installed.");
  };
  /** The folders in the home folder a sandboxed gateway writes in but cannot create: Kiro Crew's work folder, Kiro CLI's sessions, npm's cache. */
  const gatewayHomeFolders = (run: DryRun) => [
    path.join(run.home, "workplace", "kirocrew-workspace"),
    path.join(run.home, ".kiro", "agents"),
    path.join(run.home, ".kiro", "sessions"),
    path.join(run.home, ".kiro", "settings"),
    path.join(run.home, ".kiro", "crew-auth-staging"),
    path.join(run.home, ".npm", "_cacache"),
    path.join(run.home, ".npm", "_logs"),
  ];
  /** The gateway job's own copy of the sandbox profile: <data>/sandbox/crew-gateway.sb, as a real path. */
  const installedProfile = (run: DryRun) => path.join(realpathSync(run.dataDir), "sandbox", "crew-gateway.sb");
  /** What Kiro Crew's stand-in was asked, without the looks at whether the gateway answers. */
  const settingsAsked = (run: DryRun) => run.kirocrew.filter((call) => call !== "status");
  /** The system's own folders first, then node's and ~/.local/bin: what the build and deliver jobs run with. */
  const nightPath = (run: DryRun) => `${BARE_PATH}:${NODE_DIR}:${run.home}/.local/bin`;

  /** The two sentences install prints for the night jobs, with the times the dry run's settings give unless others are named. */
  const buildLine = (at = "01:00", zone = "America/Boise") =>
    `Installed. Overnight now checks the time every minute and builds approved ideas at ${at} (${zone}). If the Mac is asleep or off then, it builds once it is awake again. It has checked the time once already.`;
  const deliverLine = (at = "06:30", buzz = "07:00", zone = "America/Boise") =>
    `Installed. Overnight now checks the time every minute, and tests, publishes and delivers at ${at} (${zone}), for a buzz on the wrist at ${buzz}. If the Mac is asleep then, it delivers when the Mac is next awake and online, and the wrist buzzes two minutes after the link is ready.`;
  /** The settings file install writes for a night job: woken every minute and when loaded, run with the if-due switch. */
  const nightPlist = (run: DryRun, job: "build" | "deliver") => ({
    Label: label(job),
    ProgramArguments: [NODE, ENTRY, job, "--if-due"],
    WorkingDirectory: repoRoot(),
    // macOS's own folders come first: a program the job starts by name (`git`, `gh`) is the system's.
    EnvironmentVariables: { PATH: nightPath(run), HOME: run.home },
    StartInterval: 60,
    RunAtLoad: true,
    ExitTimeOut: 60,
    StandardOutPath: `${run.dataDir}/logs/${job}.launchd.log`,
    StandardErrorPath: `${run.dataDir}/logs/${job}.launchd.log`,
  });

  it("installs the nightly build alone: woken every minute, its clock started from now before anything is stopped, its first look waited for, and nothing else is touched", () => {
    const started = new Date().toISOString();
    const run = dryRun({ jobs: ["build"] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // Is it at work (twice: before anything is changed, and when its turn comes)? Stop any old
    // copy, hand the new one to macOS, check macOS lists it, show its status.
    expect(run.calls).toEqual(installCalls(run, "build"));
    expect(mode(plistOf(run, "build"))).toBe(0o600);
    expect(plistAsJson(plistOf(run, "build"))).toEqual(nightPlist(run, "build"));
    expect(nightPath(run).startsWith("/usr/bin:/bin:/usr/sbin:/sbin:")).toBe(true);
    for (const other of ["listen", "crew", "deliver"] as const) expect(existsSync(plistOf(run, other)), other).toBe(false);
    // The times are read from the tool, the way the job itself will see them; the clock is started
    // from now; the job's first look is read back; and the mode is read back to tell the operator.
    expect(run.cli).toEqual(["--help", "pause", "status --json", "build --from-now", "status --json", "status --json"]);
    // The clock is started from now BEFORE the old copy is stopped, and after the look at whether it is at work.
    const order = (entry: string) => run.order.indexOf(entry);
    expect(order("overnight build --from-now")).toBeGreaterThan(order(`launchctl print ${targetOf("build")}`));
    expect(order("overnight build --from-now")).toBeLessThan(order(`launchctl bootout ${targetOf("build")}`));
    expect(run.order.filter((entry) => entry.startsWith("launchctl bootout") || entry.endsWith("--from-now"))).toEqual(["overnight build --from-now", `launchctl bootout ${targetOf("build")}`]);
    // Kiro Crew is no business of this job: not asked, and no skill is copied.
    expect(run.kirocrew).toEqual([]);
    expect(existsSync(skillOf(run))).toBe(false);

    // What the tool now says about the build's clock: today's time counts as handled without a
    // run, the job has looked at the clock since this test began, and macOS wakes it on a timer.
    const clock = clockOf(run, "build");
    expect(clock).toMatchObject({ state: "done", lastRun: null, trigger: "timer" });
    expect((clock?.checkedAt ?? "") > started).toBe(true);
    expect(clockOf(run, "deliver")).toMatchObject({ state: "no-record", checkedAt: null, trigger: null });
    // The app's own readers agree with what was written.
    expect(readJobTrigger("build", run.home)).toBe("timer");
    expect(readJobDataDir(run.home, NIGHT_JOB_LABELS.build)).toBe(run.dataDir);

    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe(buildLine());
    expect(lines[0]).toBe("Installed. Overnight now checks the time every minute and builds approved ideas at 01:00 (America/Boise). If the Mac is asleep or off then, it builds once it is awake again. It has checked the time once already.");
    expect(lines).toContain(`  settings:     ${plistOf(run, "build")}`);
    expect(lines).toContain('  Note: the "kiro-crew" builder needs the Kiro Crew gateway job too: scripts/install-agents.sh install crew');
    // This made-up Mac's clock is Overnight's own, so there is nothing to say about clocks.
    expect(run.stdout).not.toContain("this Mac's clock");
    expect(lines).toContain("Mode: paused (quiet mode). Overnight is listening and saving, not asking or building.");
    // A night job has no process between its looks at the clock, and that is not a fault.
    expect(lines).toContain("Overnight nightly build (com.overnight.build)");
    expect(lines).toContain("  state:           not running");
    expect(lines).toContain("  pid:             none (it wakes for a moment every minute)");
    expect(lines).toContain("  wakes every:     60 seconds, and at login. Overnight's own clock decides when it is time");
    expect(run.stdout).not.toContain("runs at:");
  }, 30_000);

  it("installs the morning delivery the same way, and says when it delivers: 30 minutes before DELIVER_TIME, around midnight too", () => {
    const run = dryRun({ jobs: ["deliver"] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(installCalls(run, "deliver"));
    expect(plistAsJson(plistOf(run, "deliver"))).toEqual(nightPlist(run, "deliver"));
    expect(run.cli).toEqual(["--help", "pause", "status --json", "deliver --from-now", "status --json", "status --json"]);
    expect(run.order.filter((entry) => entry.startsWith("launchctl bootout") || entry.endsWith("--from-now"))).toEqual(["overnight deliver --from-now", `launchctl bootout ${targetOf("deliver")}`]);
    expect(clockOf(run, "deliver")).toMatchObject({ state: "done", lastRun: null, trigger: "timer" });
    expect(clockOf(run, "deliver")?.checkedAt).not.toBeNull();
    expect(run.stdout.split("\n")[0]).toBe("Installed. Overnight now checks the time every minute, and tests, publishes and delivers at 06:30 (America/Boise), for a buzz on the wrist at 07:00. If the Mac is asleep then, it delivers when the Mac is next awake and online, and the wrist buzzes two minutes after the link is ready.");
    expect(run.stdout).toContain("  wakes every:     60 seconds, and at login. Overnight's own clock decides when it is time");

    // The times are only told to the person installing: the settings files are the same whatever they are.
    const early = dryRun({ jobs: ["build", "deliver"], env: { DRY_BUILD_TIME: "23:45", DRY_DELIVER_TIME: "00:10" } });
    expect(early.status).toBe(0);
    expect(plistAsJson(plistOf(early, "build"))).toEqual(nightPlist(early, "build"));
    expect(plistAsJson(plistOf(early, "deliver"))).toEqual(nightPlist(early, "deliver"));
    expect(early.stdout.split("\n").filter((line) => line.startsWith("Installed."))).toEqual([buildLine("23:45"), deliverLine("23:40", "00:10")]);
  }, 30_000);

  it("installs the night jobs whatever time zone this Mac's clock is set to, and says so once when it is not Overnight's", () => {
    const note = (mac: string, zone = "America/Boise") => `  Note: this Mac's clock is set to ${mac}. Overnight goes by its own TZ setting, ${zone}: 01:00 means 01:00 there.`;
    const notes = (run: DryRun) => run.stdout.split("\n").filter((line) => line.includes("this Mac's clock"));
    for (const jobs of [["build"], ["deliver"], [] as Job[]] as Job[][]) {
      const run = dryRun({ jobs, env: { DRY_MAC_ZONE: "America/New_York" } });
      expect(run.stderr, jobs.join("+")).toBe("");
      expect(run.status, jobs.join("+")).toBe(0);
      // Once, also when both night jobs are installed together.
      expect(notes(run), jobs.join("+")).toEqual([note("America/New_York")]);
      for (const job of jobs.length === 0 ? (["build", "deliver"] as const) : (jobs as ("build" | "deliver")[])) expect(plistAsJson(plistOf(run, job)), job).toEqual(nightPlist(run, job));
    }

    // Two names for one clock are no difference, and neither is the same zone on both sides.
    for (const env of [{ DRY_MAC_ZONE: "America/Denver" }, { DRY_MAC_ZONE: "America/New_York", DRY_TZ: "America/New_York" }] as Record<string, string>[]) {
      const run = dryRun({ jobs: ["build"], env });
      expect(run.status).toBe(0);
      expect(notes(run)).toEqual([]);
    }
    // The times are named in Overnight's zone, whichever that is.
    const eastern = dryRun({ jobs: ["build"], env: { DRY_MAC_ZONE: "America/Boise", DRY_TZ: "America/New_York" } });
    expect(eastern.stdout.split("\n")[0]).toBe(buildLine("01:00", "America/New_York"));
    expect(notes(eastern)).toEqual([note("America/Boise", "America/New_York")]);
    // The listener and the gateway have no time of day, so there is nothing to say for them.
    const listener = dryRun({ jobs: ["listen", "crew"], env: { DRY_MAC_ZONE: "America/New_York" } });
    expect(listener.status).toBe(0);
    expect(notes(listener)).toEqual([]);
    // A Mac whose time zone cannot be read: installed all the same, with nothing said about it.
    const unknown = dryRun({ jobs: ["deliver"], env: { DRY_MAC_ZONE: "" } });
    expect(unknown.stderr).toBe("");
    expect(unknown.status).toBe(0);
    expect(notes(unknown)).toEqual([]);
  }, 120_000);

  it("starts the gateway inside Overnight's own sandbox unless told otherwise: real paths, the profile's own values, Kiro Crew's setting checked first", () => {
    // Nothing set means "overnight" (SPEC §6): the stronger fence is the one you get by default.
    for (const sandbox of [undefined, "overnight"]) {
      const run = dryRun({ jobs: ["crew"], sandbox });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(installCalls(run, "crew"));
      expect(mode(plistOf(run, "crew"))).toBe(0o600);
      const command = [
        "/usr/bin/sandbox-exec",
        "-f",
        // Real paths everywhere: the sandbox compares those. (The scratch folder sits behind a link on macOS.)
        // The job is pointed at its own copy of the profile in the data folder, never at the repo's
        // file: macOS does not let a background job's sandbox-exec read under ~/Documents.
        installedProfile(run),
        "-D",
        `HOME=${realpathSync(run.home)}`,
        "-D",
        `DATA_DIR=${realpathSync(run.dataDir)}`,
        "-D",
        `REPO=${repoRoot()}`,
        realpathSync(kirocrewOf(run)),
        "gateway",
        "--no-open",
        "--no-tunnel",
      ];
      expect(plistAsJson(plistOf(run, "crew"))).toEqual({
        Label: "com.overnight.crew",
        ProgramArguments: command,
        WorkingDirectory: `${run.dataDir}/workspaces`,
        EnvironmentVariables: { PATH: nightPath(run), HOME: run.home, TMPDIR: `${run.dataDir}/tmp/build`, LANG: "en_US.UTF-8", NO_COLOR: "1" },
        RunAtLoad: true,
        KeepAlive: true,
        ThrottleInterval: 30,
        ExitTimeOut: 30,
        StandardOutPath: `${run.dataDir}/logs/crew.launchd.log`,
        StandardErrorPath: `${run.dataDir}/logs/crew.launchd.log`,
      });
      expect(realpathSync(run.dataDir)).not.toBe(run.dataDir);
      // Every path on the line is its own real path: nothing is reached through a link.
      for (const word of command) {
        const place = word.includes("=/") ? word.slice(word.indexOf("=") + 1) : word;
        if (place.startsWith("/")) expect(realpathSync(place), word).toBe(place);
      }
      // macOS was asked, before anything was changed, whether that command loads: the same words,
      // with the repo's own profile in the copy's place. The copy is only made once the old
      // gateway has stopped, and what is there until then may be an older one.
      expect(run.sandboxChecks).toEqual([command.map((word, index) => (index === 2 ? realpathSync(MADE_UP_PROFILE()) : word)).join(" ")]);
      expect(readFileSync(installedProfile(run), "utf8")).toBe(readFileSync(MADE_UP_PROFILE(), "utf8"));
      expect(mode(installedProfile(run))).toBe(0o600);
      expect(mode(path.dirname(installedProfile(run)))).toBe(0o700);
      // Only the one setting this mode needs was read (agent.sandbox means nothing in this mode),
      // nothing was set, and after the start the gateway was asked whether it is there.
      expect(run.kirocrew).toEqual(["config get agent.sandbox_allow_unsandboxed_exec", "status"]);
      // The build skill is copied to where Kiro Crew looks for skills.
      expect(readFileSync(skillOf(run), "utf8")).toBe(SKILL_TEXT);
      // The folder the gateway starts in exists.
      expect(existsSync(path.join(run.dataDir, "workspaces"))).toBe(true);
      // So does the folder it is handed as TMPDIR, private to the user ...
      expect(mode(path.join(run.dataDir, "tmp", "build"))).toBe(0o700);
      expect(mode(path.join(run.dataDir, "tmp"))).toBe(0o700);
      // ... and the three folders in the home folder that it may write in but could not create
      // from inside the sandbox.
      for (const needed of gatewayHomeFolders(run)) expect(statSync(needed).isDirectory(), needed).toBe(true);

      const lines = run.stdout.split("\n");
      expect(lines[0]).toBe("Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: overnight, from Overnight's settings). It answers.");
      expect(lines[1]).toBe(`  build skill:  ${skillOf(run)} (the build skill was installed)`);
      expect(lines[2]).toBe(`  build temp:   ${run.dataDir}/tmp/build (the build jobs' own temporary folder)`);
      expect(lines).toContain("Kiro Crew gateway (com.overnight.crew)");
      expect(lines).toContain("  state:           running");
      expect(lines).toContain("  pid:             4242");
      expect(lines).toContain("  sandbox:         overnight (the gateway runs inside Overnight's own sandbox)");
      expect(lines).toContain("  its own log:     kirocrew logs");
    }
  }, 60_000);

  it("installs the Kiro Crew gateway plainly when BUILD_SANDBOX is crew, after checking Kiro Crew's sandbox is at strict", () => {
    const run = dryRun({ jobs: ["crew"], sandbox: "crew" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(installCalls(run, "crew"));
    expect((plistAsJson(plistOf(run, "crew")) as { ProgramArguments: string[] }).ProgramArguments).toEqual([kirocrewOf(run), "gateway", "--no-open", "--no-tunnel"]);
    // Kiro Crew was only ever asked what two settings are, and then whether the gateway answers.
    expect(run.kirocrew).toEqual(["config get agent.sandbox", "config get agent.sandbox_allow_unsandboxed_exec", "status"]);
    // No sandbox of ours in this mode, so nothing to ask macOS about.
    expect(run.sandboxChecks).toEqual([]);
    expect(readFileSync(skillOf(run), "utf8")).toBe(SKILL_TEXT);
    // The job is handed the same TMPDIR in this mode, so that folder is made here too. The three
    // folders in the home folder are not: outside our sandbox the gateway makes them itself.
    expect((plistAsJson(plistOf(run, "crew")) as { EnvironmentVariables: Record<string, string> }).EnvironmentVariables.TMPDIR).toBe(`${run.dataDir}/tmp/build`);
    expect(mode(path.join(run.dataDir, "tmp", "build"))).toBe(0o700);
    for (const notNeeded of gatewayHomeFolders(run)) expect(existsSync(notNeeded), notNeeded).toBe(false);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe("Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: crew, from Overnight's settings). It answers.");
    expect(lines).toContain("  sandbox:         crew (Kiro Crew's own sandbox)");
  }, 30_000);

  it("fills in whatever values the sandbox profile asks for, and refuses, before changing anything, a profile it cannot serve", () => {
    // A profile with more names, in its own order. (What each stands for is checked with crew_command above.)
    const wider = path.join(scratch, "wider profile.sb");
    const widerNames = ["REPO", "NODE_DIR", "HOME", "DATA_DIR", "TMPDIR", "NPM_CACHE", "KIRO_HOME", "CREW_HOME"];
    writeFileSync(wider, ["(version 1)", "(allow default)", ...widerNames.map((name, index) => `(define value-${index} (param "${name}"))`), ""].join("\n"));
    const run = dryRun({ jobs: ["crew"], env: { DRY_PROFILE: wider } });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const args = (plistAsJson(plistOf(run, "crew")) as { ProgramArguments: string[] }).ProgramArguments;
    expect(args.slice(0, 3)).toEqual(["/usr/bin/sandbox-exec", "-f", installedProfile(run)]);
    expect(readFileSync(installedProfile(run), "utf8")).toBe(readFileSync(wider, "utf8"));
    const realHome = realpathSync(run.home);
    // Every one of the eight names a builder profile may use, each with a real path, in the profile's own order.
    expect(args.slice(3, -4)).toEqual([
      "-D",
      `REPO=${repoRoot()}`,
      "-D",
      `NODE_DIR=${path.dirname(realpathSync(NODE_DIR))}`,
      "-D",
      `HOME=${realHome}`,
      "-D",
      `DATA_DIR=${realpathSync(run.dataDir)}`,
      // The profile's TMPDIR is the folder the job is handed as TMPDIR, as a real path.
      "-D",
      `TMPDIR=${realpathSync(run.dataDir)}/tmp/build`,
      "-D",
      `NPM_CACHE=${realHome}/.npm`,
      "-D",
      `KIRO_HOME=${realHome}/.kiro`,
      "-D",
      `CREW_HOME=${realHome}/.kiro/crew`,
    ]);
    expect(realpathSync(path.join(run.dataDir, "tmp", "build"))).toBe(`${realpathSync(run.dataDir)}/tmp/build`);
    // That line was the one macOS was asked to load, before anything was changed, with the repo's own file in the copy's place.
    expect(run.sandboxChecks).toEqual([args.map((word, index) => (index === 2 ? realpathSync(wider) : word)).join(" ")]);

    // A name the installer does not know: stop, and say which.
    const odd = path.join(scratch, "odd profile.sb");
    writeFileSync(odd, ["(version 1)", "(allow default)", '(define home (param "HOME"))', '(define other (param "SOMEWHERE_NEW"))', ""].join("\n"));
    const unknown = dryRun({ jobs: ["crew"], env: { DRY_PROFILE: odd } });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("install-agents: The sandbox profile asks for values this script does not know how to fill: SOMEWHERE_NEW");
    expect(unknown.stderr).toContain("Nothing was changed.");
    expectUntouched(unknown);

    // macOS will not load the profile (here: the stand-in says so). The job would die every 30 seconds.
    const broken = dryRun({ jobs: ["crew"], env: { DRY_PROFILE_LOADS: "no" } });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("install-agents: macOS would not start a program inside the sandbox profile");
    expect(broken.stderr).toContain("Nothing was changed.");
    expect(broken.sandboxChecks).toHaveLength(1);
    expectUntouched(broken);

    const noProfile = dryRun({ jobs: ["crew"], env: { DRY_PROFILE: path.join(scratch, "no such profile.sb") } });
    expect(noProfile.status).toBe(1);
    expect(noProfile.stderr).toContain(`install-agents: The sandbox profile is missing: ${path.join(scratch, "no such profile.sb")}`);
    expectUntouched(noProfile);
    // crew mode does not use the profile, so it does not ask for it.
    expect(dryRun({ jobs: ["crew"], sandbox: "crew", env: { DRY_PROFILE: path.join(scratch, "no such profile.sb") } }).status).toBe(0);
  }, 90_000);

  it("never changes a Kiro Crew setting: when one is not what the mode needs, it stops and prints the one command", () => {
    // overnight mode: Kiro Crew must be told it may run inside a sandbox it did not make.
    for (const allowUnsandboxed of ["False", "false", "None", ""]) {
      const run = dryRun({ jobs: ["crew"], sandbox: "overnight", crew: { allowUnsandboxed } });
      expect(run.status, allowUnsandboxed).toBe(1);
      expect(run.stderr).toContain('install-agents: BUILD_SANDBOX is "overnight", and Kiro Crew is not set for it yet');
      // One plain sentence of why, the exact command, and nothing done for the operator.
      expect(run.stderr).toContain("Kiro Crew refuses to run any job inside a sandbox it did not create unless its setting agent.sandbox_allow_unsandboxed_exec is true");
      expect(run.stderr).toContain(`(it is "${allowUnsandboxed.toLowerCase()}" now)`);
      expect(run.stderr).toContain("which switches Kiro Crew's OWN sandbox off so that Overnight's can take its place");
      expect(run.stderr).toContain("This script never changes a Kiro Crew setting.");
      expect(run.stderr).toContain(`\n    "${kirocrewOf(run)}" config set agent.sandbox_allow_unsandboxed_exec true\n`);
      expect(run.stderr).toContain("Nothing was changed.");
      expect(run.kirocrew).toEqual(["config get agent.sandbox_allow_unsandboxed_exec"]);
      expect(run.sandboxChecks).toEqual([]);
      expectUntouched(run);
    }
    // The same when nothing is set at all, since that means "overnight".
    const byDefault = dryRun({ jobs: [], crew: { allowUnsandboxed: "False" } });
    expect(byDefault.status).toBe(1);
    expect(byDefault.stderr).toContain(`\n    "${kirocrewOf(byDefault)}" config set agent.sandbox_allow_unsandboxed_exec true\n`);
    // Not even the listener, when every job was asked for.
    expectUntouched(byDefault);

    // crew mode: Kiro Crew's own sandbox must be at strict ...
    for (const sandbox of ["auto", "standard", "off", ""]) {
      const run = dryRun({ jobs: ["crew"], sandbox: "crew", crew: { sandbox } });
      expect(run.status, sandbox).toBe(1);
      expect(run.stderr).toContain('install-agents: BUILD_SANDBOX is "crew"');
      expect(run.stderr).toContain(`(agent.sandbox is "${sandbox}" now)`);
      expect(run.stderr).toContain(`\n    "${kirocrewOf(run)}" config set agent.sandbox strict\n`);
      expect(run.stderr).toContain("Nothing was changed.");
      expect(run.kirocrew).toEqual(["config get agent.sandbox"]);
      expectUntouched(run);
    }

    // ... and not switched off by a setting left over from the other mode.
    const leftOver = dryRun({ jobs: ["crew"], sandbox: "crew", crew: { sandbox: "strict", allowUnsandboxed: "True" } });
    expect(leftOver.status).toBe(1);
    expect(leftOver.stderr).toContain("agent.sandbox_allow_unsandboxed_exec is true, which lets it run jobs with no sandbox at all");
    expect(leftOver.stderr).toContain(`\n    "${kirocrewOf(leftOver)}" config set agent.sandbox_allow_unsandboxed_exec false\n`);
    expectUntouched(leftOver);

    // In no run, refused or not, was Kiro Crew asked for anything but "config get" and "status".
    const every = [leftOver, byDefault, dryRun({ jobs: [] }), dryRun({ jobs: [], sandbox: "crew" })];
    for (const run of every) expect(settingsAsked(run).filter((call) => !call.startsWith("config get "))).toEqual([]);
  }, 120_000);

  it("refuses the gateway job when something it needs is missing, before anything is changed", () => {
    const noCrew = dryRun({ jobs: ["crew"], crew: "missing" });
    expect(noCrew.status).toBe(1);
    expect(noCrew.stderr).toContain(`install-agents: Could not find Kiro Crew. Expected it at ${noCrew.home}/.local/bin/kirocrew`);
    expectUntouched(noCrew);

    const noSkill = dryRun({ jobs: ["crew"], skill: "missing" });
    expect(noSkill.status).toBe(1);
    expect(noSkill.stderr).toContain("install-agents: The build skill is missing:");
    expectUntouched(noSkill);

    // Kiro Crew will not say what its settings are (here: the stand-in has lost its answer).
    const silent = dryRun({ jobs: ["crew"], sandbox: "crew" });
    rmSync(path.join(silent.home, ".local", "bin", "agent.sandbox"));
    const again = runScript(DRY_RUN, [path.join(scratch, "silent calls.txt"), path.join(scratch, "silent state"), "ok", scratch, path.join(path.dirname(silent.home), "made-up .env"), silent.dataDir, path.join(scratch, "silent cli.txt"), "require_crew_settings", "crew", kirocrewOf(silent)], {
      PATH: `${NODE_DIR}:${BARE_PATH}`,
      HOME: silent.home,
    });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("install-agents: Could not read Kiro Crew's settings");
  }, 60_000);

  it("replaces the gateway job's copy of the sandbox profile at one moment only: after the old gateway has stopped and before the new one starts, and never when it refuses", () => {
    const sum = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 12);
    const crewLines = (run: DryRun, from: number) => run.profileAt.slice(from).filter((line) => line.includes(label("crew")));
    const waiting = (run: DryRun) => readdirSync(path.dirname(installedProfile(run))).filter((name) => name !== "crew-gateway.sb");

    // A first install, of every job: no copy yet when the old gateway is "stopped", the repo's when the new one starts.
    const installed = dryRun({ jobs: [] });
    expect(installed.status).toBe(0);
    const older = sum(MADE_UP_PROFILE());
    expect(crewLines(installed, 0)).toEqual([`stop ${label("crew")} copy=none waiting=1`, `start ${label("crew")} copy=${older} waiting=0`]);
    expect(sum(installedProfile(installed))).toBe(older);
    expect(waiting(installed)).toEqual([]);

    // The repo's rules change (a merge). Until `install crew` has run through, the gateway that is
    // running, and one macOS starts again by itself, must go on behind the copy it has.
    const newer = path.join(scratch, "newer rules.sb");
    writeFileSync(newer, [";; Made up for the tests: the made-up profile with one more rule.", "(version 1)", "(allow default)", '(define home (param "HOME"))', '(define data-dir (param "DATA_DIR"))', '(define repo (param "REPO"))', '(deny file-write* (subpath "/made-up/nowhere"))', ""].join("\n"));
    expect(sum(newer)).not.toBe(older);
    const withNewRules = { DRY_PROFILE: newer };
    let seen = installed.profileAt.length;
    const untouchedBy = (run: DryRun, why: string) => {
      expect(sum(installedProfile(run)), why).toBe(older);
      expect(waiting(run), why).toEqual([]);
      expect(run.profileAt.slice(seen), why).toEqual([]);
      expect(readFileSync(plistOf(run, "crew"), "utf8"), why).toBe(crewSettings);
    };
    const crewSettings = readFileSync(plistOf(installed, "crew"), "utf8");

    // The nightly build is at work: the gateway and the build were named together, and the build's turn refuses.
    const busy = dryRun({ jobs: ["crew", "build"], into: installed, env: { ...withNewRules, DRY_BUSY_LOOKS: "all" } });
    expect(busy.status).toBe(1);
    expect(busy.stderr).toBe("install-agents: The nightly build is running right now, and installing would cut it off. Run this again when it has finished. Nothing was changed.\n");
    untouchedBy(busy, "refused because the build is at work");
    // The same with no job named, which is every job.
    const busyAll = dryRun({ jobs: [], into: installed, env: { ...withNewRules, DRY_BUSY_LOOKS: "all" } });
    expect(busyAll.status).toBe(1);
    expect(busyAll.stderr).toContain("Nothing was changed.");
    untouchedBy(busyAll, "refused with every job named");

    // The gateway alone, and macOS will not load the new rules.
    const wontLoad = dryRun({ jobs: ["crew"], into: installed, env: { ...withNewRules, DRY_PROFILE_LOADS: "no" } });
    expect(wontLoad.status).toBe(1);
    expect(wontLoad.stderr).toContain("the profile does not load, or wants a value it was not given.");
    expect(wontLoad.stderr).toContain("Nothing was changed.");
    // It was the new rules macOS was asked about, not the copy the gateway is running behind.
    expect(wontLoad.sandboxChecks.at(-1)?.startsWith(`/usr/bin/sandbox-exec -f ${realpathSync(newer)} -D `)).toBe(true);
    untouchedBy(wontLoad, "refused because the profile does not load");

    // Rules that ask for a value the installer cannot fill.
    const odd = path.join(scratch, "odd newer rules.sb");
    writeFileSync(odd, ["(version 1)", "(allow default)", '(define home (param "HOME"))', '(define other (param "SOMEWHERE_ELSE"))', ""].join("\n"));
    const unknown = dryRun({ jobs: ["crew"], into: installed, env: { DRY_PROFILE: odd } });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Nothing was changed.");
    untouchedBy(unknown, "refused because of a value it cannot fill");

    // The old gateway will not stop: the new copy had been written beside the old one, and is thrown away.
    const stuck = dryRun({ jobs: ["crew"], into: installed, mode: "wont-stop", env: withNewRules });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toBe("install-agents: The old copy of the crew job would not stop. Its settings file was not changed. Try again in a minute.\n");
    expect(stuck.profileAt.slice(seen)).toEqual([`stop ${label("crew")} copy=${older} waiting=1`]);
    seen = stuck.profileAt.length;
    untouchedBy(stuck, "the old gateway would not stop");

    // A restart is not an install: the gateway comes back behind the copy it has.
    const restarted = dryRun({ jobs: ["crew"], into: installed, action: "cmd_restart", env: withNewRules });
    expect(restarted.status).toBe(0);
    expect(restarted.profileAt.slice(seen)).toEqual([`stop ${label("crew")} copy=${older} waiting=0`, `start ${label("crew")} copy=${older} waiting=0`]);
    seen = restarted.profileAt.length;
    untouchedBy(restarted, "a restart");

    // The install that runs through: the old gateway is stopped behind the old copy, and the new one starts behind the new.
    const done = dryRun({ jobs: ["crew"], into: installed, env: withNewRules });
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(done.profileAt.slice(seen)).toEqual([`stop ${label("crew")} copy=${older} waiting=1`, `start ${label("crew")} copy=${sum(newer)} waiting=0`]);
    expect(readFileSync(installedProfile(done), "utf8")).toBe(readFileSync(newer, "utf8"));
    expect(mode(installedProfile(done))).toBe(0o600);
    expect(waiting(done)).toEqual([]);
  }, 180_000);

  it("looks at the place for that copy before anything is changed, and never writes it through a symbolic link", () => {
    const elsewhere = path.join(scratch, "a file the copy must not reach.txt");
    writeFileSync(elsewhere, "made up: not a sandbox profile\n");
    // The copy's own name is a link.
    const linkedFile = dryRun({
      jobs: ["crew"],
      before: (dataDir) => {
        mkdirSync(path.join(dataDir, "sandbox"), { recursive: true });
        symlinkSync(elsewhere, path.join(dataDir, "sandbox", "crew-gateway.sb"));
      },
    });
    expect(linkedFile.status).toBe(1);
    expect(linkedFile.stderr).toContain("crew-gateway.sb is a symbolic link, so the sandbox profile cannot be kept there. Remove it, then run install again. Nothing was changed.");
    expect(linkedFile.calls).toEqual([]);
    expect(existsSync(plistOf(linkedFile, "crew"))).toBe(false);
    expect(readFileSync(elsewhere, "utf8")).toBe("made up: not a sandbox profile\n");
    // Its folder is a link.
    const outside = path.join(scratch, "a folder the copy must not land in");
    mkdirSync(outside, { recursive: true });
    const linkedFolder = dryRun({
      jobs: ["crew"],
      before: (dataDir) => {
        mkdirSync(dataDir, { recursive: true });
        symlinkSync(outside, path.join(dataDir, "sandbox"));
      },
    });
    expect(linkedFolder.status).toBe(1);
    expect(linkedFolder.stderr).toContain("is not a plain folder (a symbolic link?), so the sandbox profile cannot be kept there. Nothing was changed.");
    expect(linkedFolder.calls).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
    // In crew mode there is no copy, so its place is not looked at.
    const crewMode = dryRun({
      jobs: ["crew"],
      sandbox: "crew",
      before: (dataDir) => {
        mkdirSync(dataDir, { recursive: true });
        symlinkSync(outside, path.join(dataDir, "sandbox"));
      },
    });
    expect(crewMode.status).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  }, 60_000);

  it("refuses a second gateway: one already listening on the port that is not our own job", () => {
    const busy = dryRun({ jobs: ["crew"], env: { DRY_PORT_BUSY: "yes" } });
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain("install-agents: Something is already listening on port 5476");
    expect(busy.stderr).toContain("kirocrew service install");
    expect(busy.stderr).toContain(`"${kirocrewOf(busy)}" stop`);
    expect(busy.stderr).toContain("Nothing was changed.");
    // One look at whether our own copy is the one holding the port, and nothing else.
    expect(busy.calls).toEqual([`print ${targetOf("crew")}`]);
    expect(existsSync(plistOf(busy, "crew"))).toBe(false);
    expect(existsSync(skillOf(busy))).toBe(false);

    // Our own job holds the port while it runs: installing it again is fine.
    const first = dryRun({ jobs: ["crew"] });
    const again = dryRun({ jobs: ["crew"], into: first, env: { DRY_PORT_BUSY: "yes" } });
    expect(again.status).toBe(0);
  }, 60_000);

  it("takes the sandbox mode from Overnight's own settings and from nowhere else: a value it does not know stops every job, and one set only in this shell is never looked at", () => {
    // A bad BUILD_SANDBOX is a bad setting like any other: the tool itself refuses it, for
    // whichever job is being installed, and says which setting it is.
    for (const jobs of [["crew"], ["build"], ["listen", "deliver"]] as Job[][]) {
      const run = dryRun({ jobs, sandbox: "strict" });
      expect(run.status, jobs.join()).toBe(1);
      expect(run.stderr).toContain("Bad setting. BUILD_SANDBOX:");
      expect(run.stderr).toContain("install-agents: Could not put Overnight in quiet mode");
      expect(run.stderr).toContain("Nothing was installed or started.");
      expectUntouched(run);
    }

    // Set in the shell running the installer, where no background job will ever see it: the
    // script does not read it. The gateway is started the way the settings say, and the line
    // install prints says which way that was.
    for (const [inShell, inSettings, used] of [["crew", undefined, "overnight"], ["overnight", "crew", "crew"], ["nonsense", undefined, "overnight"]] as const) {
      const run = dryRun({ jobs: ["crew"], sandbox: inSettings, env: { BUILD_SANDBOX: inShell } });
      expect(run.stderr, inShell).toBe("");
      expect(run.status, inShell).toBe(0);
      expect(run.stdout.split("\n")[0]).toBe(`Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: ${used}, from Overnight's settings). It answers.`);
      const first = (plistAsJson(plistOf(run, "crew")) as { ProgramArguments: string[] }).ProgramArguments[0];
      expect(first === "/usr/bin/sandbox-exec", inShell).toBe(used === "overnight");
    }
    // The script itself names the variable only in words for people, never as something to read.
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).not.toMatch(/\$\{?BUILD_SANDBOX/);
  }, 120_000);

  // ---------- the build skill ----------

  it("installs the build skill as a plain copy, leaves an exact copy alone, and keeps a different one beside the new one", () => {
    const first = dryRun({ jobs: ["crew"] });
    expect(first.status).toBe(0);
    expect(readFileSync(skillOf(first), "utf8")).toBe(SKILL_TEXT);
    expect(lstatSync(skillOf(first)).isFile()).toBe(true);
    expect(mode(skillOf(first))).toBe(0o644);
    expect(readdirSync(skillDirOf(first))).toEqual(["SKILL.md"]);
    const installedAt = statSync(skillOf(first)).mtimeMs;
    const inode = statSync(skillOf(first)).ino;

    // Again, nothing changed in the repo: the file there is not rewritten, and no backup is made.
    const again = dryRun({ jobs: ["crew"], into: first });
    expect(again.status).toBe(0);
    expect(statSync(skillOf(again)).ino).toBe(inode);
    expect(statSync(skillOf(again)).mtimeMs).toBe(installedAt);
    expect(readdirSync(skillDirOf(again))).toEqual(["SKILL.md"]);
    expect(again.stdout.split("\n")[1]).toBe(`  build skill:  ${skillOf(again)} (the build skill there is already this repo's)`);

    // Someone (or something) changed the installed copy: ours goes in, theirs is kept beside it.
    const altered = "# not ours any more\nPublish whatever you like.\n";
    writeFileSync(skillOf(first), altered);
    const replaced = dryRun({ jobs: ["crew"], into: first });
    expect(replaced.status).toBe(0);
    expect(readFileSync(skillOf(replaced), "utf8")).toBe(SKILL_TEXT);
    const kept = readdirSync(skillDirOf(replaced)).filter((name) => name !== "SKILL.md");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^SKILL\.md\.bak-\d{8}T\d{6}Z$/);
    expect(readFileSync(path.join(skillDirOf(replaced), kept[0] ?? ""), "utf8")).toBe(altered);
    expect(replaced.stdout.split("\n")[1]).toBe(`  build skill:  ${skillOf(replaced)} (the build skill was replaced, and the one that was there is kept as ${path.join(skillDirOf(replaced), kept[0] ?? "")})`);
    // No temporary file is left behind.
    expect(readdirSync(skillDirOf(replaced)).filter((name) => name.startsWith(".SKILL"))).toEqual([]);
  }, 60_000);

  it("never writes the build skill through a symbolic link: it refuses, and the file the link points at is untouched", () => {
    // What a build job could plant: SKILL.md as a link to a file it cannot reach itself.
    const precious = path.join(scratch, "precious.txt");
    writeFileSync(precious, "made-up: something that must not be overwritten\n");
    const planted = dryRun({
      jobs: ["crew"],
      before: (_dataDir, fakeHome) => {
        mkdirSync(path.join(fakeHome, ".kiro", "crew", "skills", "overnight-build"), { recursive: true });
        symlinkSync(precious, path.join(fakeHome, ".kiro", "crew", "skills", "overnight-build", "SKILL.md"));
      },
    });
    expect(planted.status).toBe(1);
    expect(planted.stderr).toContain(`install-agents: The build skill cannot be installed: ${skillOf(planted)} is a symbolic link, and this script does not write through one`);
    expect(planted.stderr).toContain("Nothing was changed.");
    expect(readFileSync(precious, "utf8")).toBe("made-up: something that must not be overwritten\n");
    // Refused before anything was stopped, started or written, and the link's target was not copied anywhere.
    expect(planted.calls).toEqual([]);
    expect(existsSync(plistOf(planted, "crew"))).toBe(false);
    expect(lstatSync(skillOf(planted)).isSymbolicLink()).toBe(true);
    expect(readdirSync(skillDirOf(planted))).toEqual(["SKILL.md"]);
    expect(planted.stdout).not.toContain("Installed.");

    // The same for a link anywhere on the way: here the skills folder points somewhere else.
    const elsewhere = path.join(scratch, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const linkedFolder = dryRun({
      jobs: [],
      before: (_dataDir, fakeHome) => {
        mkdirSync(path.join(fakeHome, ".kiro", "crew"), { recursive: true });
        symlinkSync(elsewhere, path.join(fakeHome, ".kiro", "crew", "skills"));
      },
    });
    expect(linkedFolder.status).toBe(1);
    expect(linkedFolder.stderr).toContain(`install-agents: The build skill cannot be installed: ${path.join(linkedFolder.home, ".kiro", "crew", "skills")} is a symbolic link`);
    expect(readdirSync(elsewhere)).toEqual([]);
    // Every job was asked for, and none was touched.
    expect(linkedFolder.calls).toEqual([]);
    for (const job of JOBS) expect(existsSync(plistOf(linkedFolder, job)), job).toBe(false);

    // Something that is neither a file nor a link where the skill should be: refused too.
    const folder = dryRun({
      jobs: ["crew"],
      before: (_dataDir, fakeHome) => {
        mkdirSync(path.join(fakeHome, ".kiro", "crew", "skills", "overnight-build", "SKILL.md"), { recursive: true });
      },
    });
    expect(folder.status).toBe(1);
    expect(folder.stderr).toContain(`${skillOf(folder)} is not a plain file`);
    expect(folder.calls).toEqual([]);
  }, 60_000);

  // ---------- waiting for the gateway ----------

  it("waits for the gateway to answer after starting its job, and takes a late answer", () => {
    // Not there for the first four looks, then it answers.
    const slow = dryRun({ jobs: ["crew"], crew: { gateway: 5 } });
    expect(slow.stderr).toBe("");
    expect(slow.status).toBe(0);
    expect(slow.kirocrew).toEqual(["config get agent.sandbox_allow_unsandboxed_exec", "status", "status", "status", "status", "status"]);
    expect(slow.stdout.split("\n")[0]).toContain("It answers.");
  }, 30_000);

  it("does not claim success when the gateway never answers: it says so, and points at the log file", () => {
    const run = dryRun({ jobs: [], crew: { gateway: "down" } });
    expect(run.status).toBe(1);
    // A look every two seconds for 60 seconds, and no more.
    expect(run.kirocrew.filter((call) => call === "status")).toHaveLength(30);
    expect(run.stderr).toContain("install-agents: The Kiro Crew gateway job is in place and has a process, but the gateway did not answer within 60 seconds");
    expect(run.stderr).toContain(`${run.dataDir}/logs/crew.launchd.log`);
    expect(run.stderr).toContain(`"${kirocrewOf(run)}" logs`);
    expect(run.stderr).toContain("scripts/install-agents.sh status crew");
    // Its state is shown first, like any job that did not come up.
    expect(run.stdout).toContain("Kiro Crew gateway (com.overnight.crew)");
    // The listener, installed before it, is in place. Nothing is claimed for the gateway or what comes after.
    const installed = run.stdout.split("\n").filter((line) => line.startsWith("Installed."));
    expect(installed).toEqual(["Installed. Overnight now listens in the background and starts again at login."]);
    expect(existsSync(plistOf(run, "build"))).toBe(false);
    expect(existsSync(plistOf(run, "deliver"))).toBe(false);
    // Their clocks were not touched either: a job that is not put in place keeps the clock it had.
    expect(run.cli.filter((call) => call.endsWith("--from-now"))).toEqual([]);
  }, 60_000);

  it("installs all four when no job is named: listener, gateway, build, delivery, each checked before any is touched", () => {
    const run = dryRun({ jobs: [] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      // Before anything is changed: is either night job at work?
      `print ${targetOf("build")}`,
      `print ${targetOf("deliver")}`,
      ...applyCalls(run, "listen"),
      ...applyCalls(run, "crew"),
      ...applyCalls(run, "build"),
      ...applyCalls(run, "deliver"),
      // The status at the end, one job after the other.
      ...JOBS.map((job) => `print ${targetOf(job)}`),
    ]);
    for (const job of JOBS) {
      expect(mode(plistOf(run, job)), job).toBe(0o600);
      execFileSync("/usr/bin/plutil", ["-lint", plistOf(run, job)], { timeout: 15_000, stdio: "ignore" });
      expect((plistAsJson(plistOf(run, job)) as { Label: string }).Label).toBe(label(job));
    }
    // Quiet mode is stored once and the settings are read once; each night job's clock is started
    // from now and its first look read back; and the mode is read back once.
    expect(run.cli).toEqual(["--help", "pause", "status --json", "build --from-now", "status --json", "deliver --from-now", "status --json", "status --json"]);
    // Neither clock is touched before the listener and the gateway are in place, and each is started just before its own job is stopped.
    expect(run.order.filter((entry) => entry.startsWith("launchctl bootout") || entry.endsWith("--from-now"))).toEqual([
      `launchctl bootout ${targetOf("listen")}`,
      `launchctl bootout ${targetOf("crew")}`,
      "overnight build --from-now",
      `launchctl bootout ${targetOf("build")}`,
      "overnight deliver --from-now",
      `launchctl bootout ${targetOf("deliver")}`,
    ]);
    const lines = run.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("Installed."))).toEqual([
      "Installed. Overnight now listens in the background and starts again at login.",
      "Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: overnight, from Overnight's settings). It answers.",
      buildLine(),
      deliverLine(),
    ]);
    // With the gateway installed alongside, there is nothing to remind about.
    expect(run.stdout).not.toContain("Note:");
    expect(lines).toContain("This is a first install, so Overnight was put in quiet mode before it started.");
    for (const title of ["Overnight listener (com.overnight.listen)", "Kiro Crew gateway (com.overnight.crew)", "Overnight nightly build (com.overnight.build)", "Overnight morning delivery (com.overnight.deliver)"]) {
      expect(lines).toContain(title);
    }
    // What the installed tool then says about the night, read back the way the installer reads it.
    expect(JSON.parse(overnight(run, "status", "--json"))).toMatchObject({
      buildSandbox: "overnight",
      nightJobs: { build: true, deliver: true, crew: true },
      gatewayAnswers: false,
      paused: true,
      jobsBelongHere: true,
      nightClock: { tickSeconds: 60, build: { trigger: "timer", state: "done", fresh: true }, deliver: { trigger: "timer", state: "done", fresh: true } },
    });
  }, 30_000);

  it("leaves every job that is not named exactly as it was", () => {
    const first = dryRun({ jobs: [] });
    expect(first.status).toBe(0);
    const snapshot = () => Object.fromEntries(JOBS.map((job) => [job, { text: readFileSync(plistOf(first, job), "utf8"), changed: statSync(plistOf(first, job)).mtimeMs }]));

    let previous = first;
    for (const job of ["build", "deliver", "crew", "listen"] as const) {
      const before = snapshot();
      const again = dryRun({ jobs: [job], into: first });
      expect(again.status, job).toBe(0);
      // Every launchctl call of this install names this job and no other.
      const mine = again.calls.slice(previous.calls.length);
      expect(mine, job).toEqual(installCalls(again, job));
      expect(mine.filter((call) => !call.includes(label(job))), job).toEqual([]);
      const after = snapshot();
      for (const other of JOBS.filter((name) => name !== job)) {
        expect(after[other]?.text, `${job} left ${other} alone`).toBe(before[other]?.text);
        expect(after[other]?.changed, `${job} did not rewrite ${other}`).toBe(before[other]?.changed);
      }
      previous = again;
    }
  }, 120_000);

  it("does not claim success when the gateway is put in place but dies straight away", () => {
    const run = dryRun({ jobs: ["crew"], mode: "job-dies" });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Installed.");
    expect(run.stdout).toContain("Kiro Crew gateway (com.overnight.crew)");
    expect(run.stdout).toContain("  last exit code:  2");
    expect(run.stderr).toContain("install-agents: The job is in place but is not running.");
    expect(run.stderr).toContain("scripts/install-agents.sh uninstall crew");
    // A job with no process is not asked whether its gateway answers.
    expect(run.kirocrew.filter((call) => call === "status")).toEqual([]);
  }, 30_000);

  it("does not claim success when macOS does not list a night job after taking it", () => {
    const run = dryRun({ jobs: ["build"], mode: "not-listed" });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Installed.");
    expect(run.stderr).toContain("install-agents: The settings file is in place, but macOS does not list the job, so it will not run at its time.");
    // One look after the start, not two, and no waiting for a look at the clock by a job that is not there.
    expect(run.calls.map((call) => call.split(" ")[0])).toEqual(["print", "print", "bootout", "print", "enable", "bootstrap", "print", "print"]);
    expect(run.cli).toEqual(["--help", "pause", "status --json", "build --from-now"]);
  }, 30_000);

  // ---------- the night jobs' own clock ----------

  it("does not claim success when a night job is in place but never looks at the clock: it waits 30 seconds, says so, and points at its status", () => {
    for (const job of ["build", "deliver"] as const) {
      const run = dryRun({ jobs: [job], mode: "never-looks" });
      expect(run.status, job).toBe(1);
      expect(run.stdout).not.toContain("Installed.");
      expect(run.stderr).toBe(`install-agents: The job is in place, but it has not checked the time yet, so it may not be running. See: scripts/install-agents.sh status ${job}\n`);
      // Its state is shown first, like any job that did not come up. The job itself is in place.
      expect(run.stdout).toContain(`(${label(job)})`);
      expect(run.stdout).toContain("  pid:             none (it wakes for a moment every minute)");
      expect(plistAsJson(plistOf(run, job))).toEqual(nightPlist(run, job));
      // A look every two seconds for 30 seconds, and no more.
      expect(run.cli).toEqual(["--help", "pause", "status --json", `${job} --from-now`, ...Array.from({ length: 15 }, () => "status --json")]);
      expect(clockOf(run, job)).toMatchObject({ checkedAt: null, state: "done" });
    }

    // A look the old copy made before it was stopped does not count for the new one.
    const first = dryRun({ jobs: ["build"] });
    expect(first.status).toBe(0);
    const before = clockOf(first, "build")?.checkedAt;
    expect(before).not.toBeNull();
    const again = dryRun({ jobs: ["build"], into: first, mode: "never-looks" });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("install-agents: The job is in place, but it has not checked the time yet, so it may not be running.");
    expect(clockOf(again, "build")?.checkedAt).toBe(before);
    expect(again.cli.slice(first.cli.length).filter((call) => call === "status --json")).toHaveLength(16);
  }, 120_000);

  it("asks the real tool the way the job does, and takes its look at the clock for the first one", () => {
    // The one place the real `build --if-due` is run. Its settings put the build's time six hours
    // away, so there is nothing due and the look does nothing but write its own time down: no
    // build, no lock, no log, nothing asked of the internet.
    const run = dryRun({ jobs: ["listen"] });
    expect(run.status).toBe(0);
    const zone = "America/Boise";
    const local = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    const env = { PATH: `${NODE_DIR}:${BARE_PATH}`, HOME: run.home, OVERNIGHT_DATA_DIR: run.dataDir, KIROCREW_PORT: "9", TZ: zone, BUILD_TIME: local(new Date(Date.now() + 6 * 3_600_000)), DELIVER_TIME: local(new Date(Date.now() + 12 * 3_600_000)) };
    const tool = (...args: string[]) => execFileSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", timeout: 30_000, env, stdio: ["ignore", "pipe", "pipe"] });
    expect(tool("build", "--from-now")).toMatch(/^The build clock starts from now: the next build is /);
    const since = withScript('utc_now "$1"', [process.execPath]).trim();
    const waiting = (job: string) =>
      runScript(DRY_RUN, [path.join(scratch, "if-due calls.txt"), path.join(scratch, "if-due state"), "ok", scratch, path.join(path.dirname(run.home), "made-up .env"), run.dataDir, path.join(scratch, "if-due cli.txt"), "wait_for_first_check", process.execPath, job, since], {
        PATH: `${NODE_DIR}:${BARE_PATH}`,
        HOME: run.home,
      }).status;
    // Not yet: `--from-now` writes no look down.
    expect(waiting("build")).toBe(1);
    expect(tool("build", "--if-due")).toBe("");
    expect(waiting("build")).toBe(0);
    expect(waiting("deliver")).toBe(1);
    // Nothing was built or logged by that look: no run is on record, and the build has no log yet.
    expect(existsSync(path.join(run.dataDir, "logs", "build.log"))).toBe(false);
    expect(JSON.parse(tool("status", "--json"))).toMatchObject({ nightClock: { build: { state: "done", lastRun: null } } });
  }, 60_000);

  it("changes nothing when the job's clock cannot be started from now: here a build holds the build lock", () => {
    const first = dryRun({ jobs: ["build"] });
    expect(first.status).toBe(0);
    const before = { text: readFileSync(plistOf(first, "build"), "utf8"), changed: statSync(plistOf(first, "build")).mtimeMs, clock: clockOf(first, "build") };

    // The lock a real `overnight build` holds while it builds, also one started by hand, which
    // macOS knows nothing about. Held here by this test, and given back straight after.
    const release = takeLock(buildLockFile({ root: first.dataDir }));
    expect(release).not.toBeNull();
    let again: DryRun;
    try {
      again = dryRun({ jobs: ["build"], into: first });
    } finally {
      release?.();
    }
    expect(again.status).toBe(1);
    expect(again.stdout).not.toContain("Installed.");
    // The tool's own refusal, then the installer's.
    expect(again.stderr).toBe(
      'A build is running right now on this data folder. Try again when it has finished. Nothing was changed.\ninstall-agents: Could not start the build job\'s clock ("overnight build --from-now" failed; its message is above). Nothing was changed.\n',
    );
    // Two looks at whether the job is at work, and then nothing: not stopped, not rewritten, not started.
    expect(again.calls.slice(first.calls.length)).toEqual([`print ${targetOf("build")}`, `print ${targetOf("build")}`]);
    expect(again.cli.slice(first.cli.length)).toEqual(["--help", "status --json", "build --from-now"]);
    expect(readFileSync(plistOf(again, "build"), "utf8")).toBe(before.text);
    expect(statSync(plistOf(again, "build")).mtimeMs).toBe(before.changed);
    expect(clockOf(again, "build")).toEqual(before.clock);

    // The delivery's lock is another one: with only that held, the build job installs.
    const other = takeLock(deliverLockFile({ root: first.dataDir }));
    try {
      expect(dryRun({ jobs: ["build"], into: first }).status).toBe(0);
    } finally {
      other?.();
    }
  }, 60_000);

  it("refuses to install or restart a night job that is at work, before anything is changed, and removes one all the same", () => {
    const installed = dryRun({ jobs: [] });
    expect(installed.status).toBe(0);
    const snapshot = () => Object.fromEntries(JOBS.map((job) => [job, { text: readFileSync(plistOf(installed, job), "utf8"), changed: statSync(plistOf(installed, job)).mtimeMs }]));
    const before = snapshot();
    let seen = installed.calls.length;
    let asked = installed.cli.length;
    const busy = (action: "cmd_install" | "cmd_restart", jobs: Job[]) => dryRun({ jobs, into: installed, action, env: { DRY_BUSY_LOOKS: "all" } });

    for (const [job, work] of [["build", "nightly build"], ["deliver", "morning delivery"]] as const) {
      for (const [action, doing] of [["cmd_install", "installing"], ["cmd_restart", "restarting"]] as const) {
        const run = busy(action, [job]);
        expect(run.status, `${action} ${job}`).toBe(1);
        expect(run.stderr).toBe(`install-agents: The ${work} is running right now, and ${doing} would cut it off. Run this again when it has finished. Nothing was changed.\n`);
        // Two looks, two seconds apart, and nothing else asked of macOS.
        expect(run.calls.slice(seen)).toEqual([`print ${targetOf(job)}`, `print ${targetOf(job)}`]);
        // The clock was not started from now either.
        expect(run.cli.slice(asked).filter((call) => call.endsWith("--from-now"))).toEqual([]);
        seen = run.calls.length;
        asked = run.cli.length;
      }
    }
    // With every job named, the listener and the gateway are not touched either: a build that is
    // going runs on that gateway.
    for (const action of ["cmd_install", "cmd_restart"] as const) {
      const run = busy(action, []);
      expect(run.status, action).toBe(1);
      expect(run.stderr).toContain("install-agents: The nightly build is running right now");
      expect(run.stderr).toContain("Nothing was changed.");
      expect(run.calls.slice(seen).filter((call) => !call.startsWith("print "))).toEqual([]);
      seen = run.calls.length;
    }
    expect(snapshot()).toEqual(before);

    // Its look at the clock, a moment every minute, is not work: seen once and gone two seconds later.
    const moment = dryRun({ jobs: ["build"], into: installed, env: { DRY_BUSY_LOOKS: "1 3" } });
    expect(moment.stderr).toBe("");
    expect(moment.status).toBe(0);
    seen = moment.calls.length;

    // Found at work only when its turn comes, after the listener was done: said as it is.
    const late = dryRun({ jobs: ["listen", "build"], into: installed, env: { DRY_BUSY_LOOKS: "2 3" } });
    expect(late.status).toBe(1);
    expect(late.stdout).toContain("Installed. Overnight now listens in the background and starts again at login.");
    expect(late.stderr).toBe("install-agents: The nightly build is running right now, and installing would cut it off. Run this again when it has finished. The build job was left as it was (already done: listen).\n");
    expect(late.calls.slice(seen).filter((call) => call.includes(label("build")))).toEqual([`print ${targetOf("build")}`, `print ${targetOf("build")}`, `print ${targetOf("build")}`]);
    seen = late.calls.length;
    // The same on a restart of every job: the listener and the gateway were started again by then.
    const lateRestart = dryRun({ jobs: [], into: installed, action: "cmd_restart", env: { DRY_BUSY_LOOKS: "2 3" } });
    expect(lateRestart.status).toBe(1);
    expect(lateRestart.stdout.split("\n").filter((line) => line.startsWith("Restarted"))).toEqual(["Restarted: Overnight listener.", "Restarted: Kiro Crew gateway."]);
    expect(lateRestart.stderr).toBe("install-agents: The nightly build is running right now, and restarting would cut it off. Run this again when it has finished. The build job was left as it was (already done: listen crew).\n");
    expect(lateRestart.calls.slice(seen).filter((call) => call.startsWith("bootout"))).toEqual([`bootout ${targetOf("listen")}`, `bootout ${targetOf("crew")}`]);
    seen = lateRestart.calls.length;

    // Removing a job is how a run is stopped on purpose, so it is not refused.
    const removed = dryRun({ jobs: ["build"], into: installed, action: "cmd_uninstall", env: { DRY_BUSY_LOOKS: "all" } });
    expect(removed.status).toBe(0);
    expect(removed.stdout).toBe("Removed. Overnight no longer builds at night. Saved data was not touched.\n");
    expect(removed.calls.slice(seen)).toEqual([`bootout ${targetOf("build")}`, `print ${targetOf("build")}`]);
    expect(existsSync(plistOf(removed, "build"))).toBe(false);
  }, 120_000);

  /** A build or deliver settings file the way Milestone 2's installer wrote one: on macOS's calendar. Made up, in that layout. */
  const calendarPlist = (run: DryRun, job: "build" | "deliver", hour: number, minute: number) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      "<!-- Made up for the tests, in the shape the older installer wrote. -->",
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key>\n  <string>${label(job)}</string>`,
      `  <key>ProgramArguments</key>\n  <array>\n    <string>${NODE}</string>\n    <string>${ENTRY}</string>\n    <string>${job}</string>\n  </array>`,
      `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${hour}</integer>\n    <key>Minute</key>\n    <integer>${minute}</integer>\n  </dict>`,
      "  <key>RunAtLoad</key>\n  <false/>",
      `  <key>StandardOutPath</key>\n  <string>${run.dataDir}/logs/${job}.launchd.log</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");

  it("moves a job that is still on macOS's calendar to Overnight's own clock, and until then shows it for what it is", () => {
    // A Mac as Milestone 2 left it: the job loaded, its settings file the calendar kind.
    const old = dryRun({ jobs: ["build", "deliver"] });
    expect(old.status).toBe(0);
    writeFileSync(plistOf(old, "build"), calendarPlist(old, "build", 1, 0));
    writeFileSync(plistOf(old, "deliver"), calendarPlist(old, "deliver", 6, 30));
    expect(readJobTrigger("build", old.home)).toBe("calendar");

    // Status says which kind each job is, and how to move it.
    const shown = runScript(DRY_RUN, [path.join(scratch, "old calls.txt"), path.join(path.dirname(old.home), "job state"), "ok", scratch, path.join(path.dirname(old.home), "made-up .env"), old.dataDir, path.join(scratch, "old cli.txt"), "cmd_status", "build", "deliver"], {
      PATH: `${NODE_DIR}:${BARE_PATH}`,
      HOME: old.home,
    });
    expect(shown.status).toBe(0);
    const lines = shown.stdout.split("\n");
    expect(lines).toContain("  runs at:         01:00 every day, on macOS's calendar (the old way, which ran an hour late on Oct 11). Move it with: scripts/install-agents.sh install build");
    expect(lines).toContain("  runs at:         06:30 every day, on macOS's calendar (the old way, which ran an hour late on Oct 11). Move it with: scripts/install-agents.sh install deliver");
    expect(lines.filter((line) => line.startsWith("  pid:"))).toEqual(["  pid:             none (it runs at its time, not in between)", "  pid:             none (it runs at its time, not in between)"]);
    expect(shown.stdout).not.toContain("wakes every:");

    // A restart leaves it the kind it is: such a job is not started when loaded, so no look at the clock is waited for.
    const seen = old.cli.length;
    const restarted = dryRun({ jobs: ["build"], into: old, action: "cmd_restart" });
    expect(restarted.stderr).toBe("");
    expect(restarted.status).toBe(0);
    expect(restarted.cli.slice(seen)).toEqual([]);
    expect(restarted.stdout).toContain("  runs at:         01:00 every day, on macOS's calendar");
    expect(readJobTrigger("build", restarted.home)).toBe("calendar");

    // Install moves it: today's time is written down as handled before the calendar job is
    // stopped, so the calendar and the timer never both have a claim on the same day.
    const moved = dryRun({ jobs: ["build"], into: old });
    expect(moved.stderr).toBe("");
    expect(moved.status).toBe(0);
    expect(moved.order.slice(restarted.order.length).filter((entry) => entry.startsWith("launchctl bootout") || entry.endsWith("--from-now"))).toEqual(["overnight build --from-now", `launchctl bootout ${targetOf("build")}`]);
    expect(plistAsJson(plistOf(moved, "build"))).toEqual(nightPlist(moved, "build"));
    expect(readJobTrigger("build", moved.home)).toBe("timer");
    expect(clockOf(moved, "build")).toMatchObject({ state: "done", lastRun: null, trigger: "timer" });
    // The deliver job was not named, and is still the calendar kind: half moved is a state the two can be in.
    expect(readJobTrigger("deliver", moved.home)).toBe("calendar");
    expect(readFileSync(plistOf(moved, "deliver"), "utf8")).toBe(calendarPlist(old, "deliver", 6, 30));
  }, 120_000);

  it("removes one job and leaves the others in place and running", () => {
    const installed = dryRun({ jobs: [] });
    const seen = installed.calls.length;
    const removed = dryRun({ jobs: ["build"], into: installed, action: "cmd_uninstall" });
    expect(removed.status).toBe(0);
    expect(removed.stdout).toBe("Removed. Overnight no longer builds at night. Saved data was not touched.\n");
    expect(removed.calls.slice(seen)).toEqual([`bootout ${targetOf("build")}`, `print ${targetOf("build")}`]);
    expect(existsSync(plistOf(removed, "build"))).toBe(false);
    for (const other of ["listen", "crew", "deliver"] as const) expect(existsSync(plistOf(removed, other)), other).toBe(true);
    // The data folder, the database in it and the copied skill are left alone.
    expect(existsSync(path.join(removed.dataDir, "overnight.db"))).toBe(true);
    expect(existsSync(skillOf(removed))).toBe(true);

    // With no job named, all of them go. Fine for one that is already gone.
    const all = dryRun({ jobs: [], into: installed, action: "cmd_uninstall" });
    expect(all.status).toBe(0);
    expect(all.stdout.split("\n").filter(Boolean)).toHaveLength(4);
    for (const job of JOBS) expect(existsSync(plistOf(all, job)), job).toBe(false);
    expect(existsSync(path.join(all.dataDir, "overnight.db"))).toBe(true);
    // Kiro Crew's settings were never touched, by install or by uninstall, and uninstall asked it nothing.
    expect(settingsAsked(all).filter((call) => !call.startsWith("config get "))).toEqual([]);
    expect(all.kirocrew).toEqual(installed.kirocrew);
    expect(existsSync(skillOf(all))).toBe(true);
  }, 60_000);

  it("restarts one job, or every installed one, and refuses a job that is not installed", () => {
    const installed = dryRun({ jobs: ["listen", "build"] });
    let seen = installed.calls.length;

    const plistBefore = readFileSync(plistOf(installed, "build"), "utf8");
    const one = dryRun({ jobs: ["build"], into: installed, action: "cmd_restart" });
    expect(one.stderr).toBe("");
    expect(one.status).toBe(0);
    // Is it at work (twice)? Stop it, start it, check macOS lists it, show its status.
    expect(one.calls.slice(seen)).toEqual(installCalls(one, "build"));
    expect(one.stdout.split("\n")[0]).toBe("Restarted: Overnight nightly build.");
    // A restart waits for the job's first look at the clock too, and asks the tool nothing else:
    // the clock is left as it is, so a run that is due is still due.
    expect(one.cli.slice(installed.cli.length)).toEqual(["status --json"]);
    expect(readFileSync(plistOf(one, "build"), "utf8")).toBe(plistBefore);

    // Started again, but it never looks at the clock: not called restarted.
    const blind = dryRun({ jobs: ["build"], into: installed, action: "cmd_restart", mode: "never-looks" });
    expect(blind.status).toBe(1);
    expect(blind.stdout).not.toContain("Restarted:");
    expect(blind.stderr).toBe("install-agents: The job is in place, but it has not checked the time yet, so it may not be running. See: scripts/install-agents.sh status build\n");
    seen = blind.calls.length;

    const missing = dryRun({ jobs: ["crew"], into: installed, action: "cmd_restart" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("install-agents: The crew job is not installed. Run: scripts/install-agents.sh install crew\n");
    expect(missing.calls.slice(seen)).toEqual([]);

    // No job named: the two that are installed, and only those.
    const every = dryRun({ jobs: [], into: installed, action: "cmd_restart" });
    expect(every.status).toBe(0);
    expect(every.stdout.split("\n").filter((line) => line.startsWith("Restarted"))).toEqual(["Restarted: Overnight listener.", "Restarted: Overnight nightly build."]);
    expect(every.calls.slice(seen).filter((call) => call.includes(label("crew")) || call.includes(label("deliver")))).toEqual([]);

    const none = dryRun({ jobs: [], action: "cmd_restart" });
    expect(none.status).toBe(1);
    // It names no bare "install": that would put every job in place at once.
    expect(none.stderr).toBe("install-agents: No Overnight job is installed. Install the one you want with: scripts/install-agents.sh install <listen | crew | build | deliver>\n");
    expect(none.calls).toEqual([]);
  }, 60_000);

  it("waits for the gateway to answer after a restart too, and changes neither the skill nor a Kiro Crew setting", () => {
    const installed = dryRun({ jobs: ["crew"] });
    expect(installed.status).toBe(0);
    const skillBefore = statSync(skillOf(installed)).mtimeMs;
    const plistBefore = readFileSync(plistOf(installed, "crew"), "utf8");

    const again = dryRun({ jobs: ["crew"], into: installed, action: "cmd_restart" });
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(again.calls.slice(installed.calls.length)).toEqual(installCalls(again, "crew"));
    expect(again.stdout.split("\n")[0]).toBe("Restarted: Kiro Crew gateway.");
    // A restart only asks whether the gateway is there: no setting is read, and nothing is rewritten.
    expect(again.kirocrew.slice(installed.kirocrew.length)).toEqual(["status"]);
    expect(statSync(skillOf(again)).mtimeMs).toBe(skillBefore);
    expect(readFileSync(plistOf(again, "crew"), "utf8")).toBe(plistBefore);

    const silent = dryRun({ jobs: ["crew"], into: installed, action: "cmd_restart", crew: { gateway: "down" } });
    expect(silent.status).toBe(1);
    expect(silent.stdout).not.toContain("Restarted:");
    expect(silent.stderr).toContain("install-agents: The Kiro Crew gateway job is in place and has a process, but the gateway did not answer within 60 seconds");
    expect(silent.stderr).toContain(`${silent.dataDir}/logs/crew.launchd.log`);
  }, 60_000);
});

describe("spikes/10-night-clock.ts (its own tools only: no job is loaded, and nothing is asked of macOS's launchd)", () => {
  // A made-up user number: these are only the words a call would be made of.
  const target = (name: string) => `gui/501/${name}`;

  it("refuses the four real jobs by name, whatever would be asked of macOS about them", () => {
    expect([...REAL_LABELS].sort()).toEqual(["com.overnight.build", "com.overnight.crew", "com.overnight.deliver", "com.overnight.listen"]);
    expect(REAL_LABELS).toEqual([JOB_LABEL, ...Object.values(NIGHT_JOB_LABELS)]);
    for (const real of REAL_LABELS) {
      expect(labelProblem(real), real).toContain("is one of the four real jobs");
      expect(labelProblem(real.toUpperCase()), real).toContain("is one of the four real jobs");
      for (const action of ["print", "bootout", "bootstrap"]) expect(launchctlProblem([action, target(real)], "/Users/someone"), `${action} ${real}`).toContain("is one of the four real jobs");
      // A settings file named after a real job, wherever it lies.
      expect(launchctlProblem(["bootstrap", "gui/501", `/made-up/scratch/spike/${real}.plist`], "/Users/someone"), real).toContain("is one of the four real jobs");
      // Anywhere in the call, not only first.
      expect(launchctlProblem(["print", target(SPIKE_LABELS.build), target(real)], "/Users/someone"), real).toContain("is one of the four real jobs");
    }
    // A job of Overnight's that does not exist yet would be one of the family too.
    expect(labelProblem("com.overnight.dashboard")).toContain("the real jobs' family of names");
    expect(labelProblem("com.example.other")).toBe('"com.example.other" is not one of this script\'s two throwaway jobs.');
    expect(labelProblem("")).not.toBeNull();
    // Its own two names are the only ones it takes, and they are not in the family.
    for (const own of Object.values(SPIKE_LABELS)) {
      expect(labelProblem(own), own).toBeNull();
      expect(own.startsWith("com.overnight."), own).toBe(false);
    }
    expect(Object.keys(SPIKE_LABELS)).toEqual(["build", "deliver"]);
  });

  it("makes three kinds of launchctl call and no other, and never names a file among the installed settings files", () => {
    const fakeHome = path.join(scratch, "spike home");
    const agents = path.join(fakeHome, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const own = target(SPIKE_LABELS.build);
    const ownFile = path.join(scratch, "spike data", "spike", `${SPIKE_LABELS.deliver}.plist`);
    expect(launchctlProblem(["print", own], fakeHome)).toBeNull();
    expect(launchctlProblem(["bootout", own], fakeHome)).toBeNull();
    expect(launchctlProblem(["bootstrap", "gui/501", ownFile], fakeHome)).toBeNull();
    for (const action of ["kickstart", "disable", "enable", "remove", "unload", "load", "kill", "submit", ""]) {
      expect(launchctlProblem([action, own], fakeHome), action).toContain("is not something this script does");
    }
    expect(launchctlProblem([], fakeHome)).not.toBeNull();
    // The installed jobs' folder: by its own name, and through a link to it.
    const refused = "That settings file is among the installed jobs' own (~/Library/LaunchAgents). This script never touches that folder.";
    expect(launchctlProblem(["bootstrap", "gui/501", path.join(agents, `${SPIKE_LABELS.build}.plist`)], fakeHome)).toBe(refused);
    const link = path.join(scratch, "spike link to agents");
    if (lstatSync(link, { throwIfNoEntry: false }) === undefined) symlinkSync(agents, link);
    expect(launchctlProblem(["bootstrap", "gui/501", path.join(link, `${SPIKE_LABELS.build}.plist`)], fakeHome)).toBe(refused);
    // A word it cannot check stops the call, and so does a call that names no job at all.
    expect(launchctlProblem(["print", "system/com.example.something"], fakeHome)).toContain("which this script does not know how to check");
    expect(launchctlProblem(["bootstrap", "gui/501", "relative.plist"], fakeHome)).toContain("which this script does not know how to check");
    expect(launchctlProblem(["bootout", "gui/501"], fakeHome)).toBe("The launchctl call names no job.");
  });

  it("refuses a real data folder however it is spelled, and anything inside or above one, inside the repo, or already in use", () => {
    const fakeHome = path.join(scratch, "spike facts home");
    const real = path.join(fakeHome, ".overnight");
    const repo = path.join(scratch, "spike facts repo");
    const fromEnv = path.join(scratch, "spike env data");
    const fromJob = path.join(scratch, "spike job data");
    for (const folder of [real, repo, fromEnv, fromJob]) mkdirSync(folder, { recursive: true });
    const facts = { home: fakeHome, repo, envFileText: `# made up for this test\nOVERNIGHT_DATA_DIR=${fromEnv}\n`, jobFolders: [fromJob] };
    const isReal = "OVERNIGHT_DATA_DIR is a real data folder, or inside one. This script only works on a scratch folder of its own.";

    // The default one, the one the repo's .env names, the one an installed job names, and inside each.
    for (const folder of [real, "~/.overnight", `${real}/`, path.join(real, "inside"), fromEnv, path.join(fromEnv, "a", "b"), fromJob, path.join(fromJob, "logs")]) {
      expect(dataDirProblem(folder, facts), folder).toBe(isReal);
    }
    // Through a link, and by macOS's other name for the same place.
    const link = path.join(scratch, "spike link to data");
    if (lstatSync(link, { throwIfNoEntry: false }) === undefined) symlinkSync(real, link);
    expect(dataDirProblem(link, facts)).toBe(isReal);
    expect(dataDirProblem(path.join(link, "inside"), facts)).toBe(isReal);
    const otherName = `/System/Volumes/Data${realpathSync(real)}`;
    if (process.platform === "darwin" && existsSync(otherName)) expect(dataDirProblem(otherName, facts)).toBe(isReal);
    // A real data folder that has not been made yet is refused by its place.
    const fresh = { ...facts, home: path.join(scratch, "spike facts home not made") };
    expect(dataDirProblem(path.join(fresh.home, ".overnight"), fresh)).toBe(isReal);

    // Above one: the home folder itself.
    for (const above of [fakeHome, "~", scratch]) expect(dataDirProblem(above, facts), above).toBe("OVERNIGHT_DATA_DIR has a real data folder inside it. This script only works on a scratch folder of its own.");
    expect(dataDirProblem(path.join(repo, "data"), facts)).toBe("OVERNIGHT_DATA_DIR is inside the repo. Data never goes there: it could end up committed.");
    expect(dataDirProblem(repo, facts)).toContain("is inside the repo");

    for (const none of [undefined, "", "   "]) expect(dataDirProblem(none, facts)).toContain("OVERNIGHT_DATA_DIR is not set.");
    for (const relative of ["scratch/data", "./data", "~someone/data"]) expect(dataDirProblem(relative, facts), relative).toBe("OVERNIGHT_DATA_DIR must be a full path, or start with ~/.");

    // The measurement starts from an empty database: a folder with anything in it, or a file, will not do.
    const inUse = "OVERNIGHT_DATA_DIR must be a new or an empty folder: the measurement starts from an empty database.";
    const used = path.join(scratch, "spike used data");
    mkdirSync(used, { recursive: true });
    writeFileSync(path.join(used, "overnight.db"), "made up for this test\n");
    expect(dataDirProblem(used, facts)).toBe(inUse);
    expect(dataDirProblem(path.join(used, "overnight.db"), facts)).toBe(inUse);
    const linkToEmpty = path.join(scratch, "spike link to empty");
    const empty = path.join(scratch, "spike empty data");
    mkdirSync(empty, { recursive: true });
    if (lstatSync(linkToEmpty, { throwIfNoEntry: false }) === undefined) symlinkSync(empty, linkToEmpty);
    expect(dataDirProblem(linkToEmpty, facts)).toBe(inUse);

    // What it takes: a folder that is not there yet, or an empty one, of its own.
    expect(dataDirProblem(path.join(scratch, "spike new data"), facts)).toBeNull();
    expect(dataDirProblem(empty, facts)).toBeNull();
    expect(dataDirProblem("~/.overnight-night-clock", facts)).toBeNull();
    expect(existsSync(path.join(scratch, "spike new data"))).toBe(false);
  });

  it("sets the build's time a few whole minutes ahead, and the delivery's own time twelve hours from it", () => {
    // 14:00:50 in Boise.
    const now = new Date("2026-10-11T20:00:50.000Z");
    const times = clockTimes(now, "America/Boise", 3);
    expect(times).toEqual({ buildTime: "14:03", buildAt: new Date("2026-10-11T20:03:00.000Z"), deliverTime: "02:33" });
    expect(clockMinus(times.deliverTime, DELIVER_LEAD_MINUTES)).toBe("02:03");
    // As Overnight's own clock reads those two settings: the next build is at that minute, the next delivery twelve hours later.
    const config = { timeZone: "America/Boise", buildTime: times.buildTime, deliverTime: times.deliverTime };
    expect(nextSlotAt("build", now, config)).toEqual(times.buildAt);
    expect(nextSlotAt("deliver", now, config)).toEqual(new Date(times.buildAt.getTime() + 12 * 3_600_000));
    // Between two and three minutes away, never less than a whole minute: the first look has to come first.
    expect(clockTimes(new Date("2026-10-11T20:00:00.000Z"), "America/Boise", 2).buildTime).toBe("14:02");
    expect(clockTimes(new Date("2026-10-11T20:00:59.999Z"), "America/Boise", 2).buildTime).toBe("14:02");
    // Around midnight, and in a zone that is not on the hour.
    expect(clockTimes(new Date("2026-10-12T05:58:10.000Z"), "America/Boise", 3)).toMatchObject({ buildTime: "00:01", deliverTime: "12:31" });
    expect(clockTimes(now, "Asia/Kolkata", 2)).toMatchObject({ buildTime: "01:32", deliverTime: "14:02" });
    for (const bad of [0, 1, 61, 2.5, Number.NaN]) expect(() => clockTimes(now, "America/Boise", bad), String(bad)).toThrow("--minutes must be a whole number from 2 to 60");
    expect(() => clockTimes(now, "Not/AZone", 3)).toThrow('"Not/AZone" is not a time zone this Mac knows.');
  });

  it("keeps away from the hours of the real night", () => {
    const quiet = (time: string) => inQuietHours(new Date(`2026-10-11T${time}:00.000-06:00`), "America/Boise");
    expect(["00:44", "00:45", "01:00", "02:29", "02:30", "06:14", "06:15", "06:30", "07:44", "07:45", "12:00", "23:59"].map(quiet)).toEqual([false, true, true, true, false, false, true, true, true, false, false, false]);
  });

  it("reads a sleep or a wake out of a line of macOS's power log, and nothing out of any other line", () => {
    // Made-up lines in the layout `pmset -g log` prints.
    expect(powerEvent("2026-10-11 14:59:51 -0600 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using AC (Charge:80%) 494 secs  ")).toEqual({
      at: new Date("2026-10-11T20:59:51.000Z"),
      text: "Sleep: Entering Sleep state due to 'Clamshell Sleep'",
    });
    expect(powerEvent("2026-10-11 15:08:05 -0600 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using AC (Charge:80%)")).toEqual({
      at: new Date("2026-10-11T21:08:05.000Z"),
      text: "Wake: DarkWake to FullWake from Deep Idle [CDNVA] due to UserActivity Assertion",
    });
    expect(powerEvent("2026-10-11 01:02:03 +0530 DarkWake            \tDarkWake from Deep Idle [CDN] : due to EC.LidOpen/Lid Open Using BATT (Charge:71%) 12 secs")).toEqual({
      at: new Date("2026-10-10T19:32:03.000Z"),
      text: "DarkWake: DarkWake from Deep Idle [CDN] due to EC.LidOpen/Lid Open",
    });
    // Other kinds of line name programs, and are not looked at.
    for (const other of ["2026-10-11 14:59:51 -0600 Assertions          \tPID 123(a made-up program) Created PreventUserIdleSystemSleep", "2026-10-11 14:59:51 -0600 Notification        \tDisplay is turned off", "Time stamp                Domain              \tMessage", "not a line of that log", ""]) {
      expect(powerEvent(other), other).toBeNull();
    }
    // Anything odd in the words is dropped, and they are cut to a length.
    const long = powerEvent(`2026-10-11 14:59:51 -0600 Sleep \t${"<made-up> {words}; ".repeat(20)}`);
    expect(long?.text).toMatch(/^Sleep: [A-Za-z0-9 '[\]._/-]{1,90}$/);
  });

  it("tells the person at a sitting to pull out the power plug before closing the lid, and to put it back afterwards", () => {
    // On mains power this Mac stays awake with the lid closed (the live listener holds it awake),
    // so a sitting with the plug in measures nothing. The build's time here is 14:05:00.
    const clock = (at: Date) => at.toISOString().slice(11, 19);
    const steps = sittingSteps(new Date("2026-10-12T14:05:00.000Z"), clock);
    expect(steps).toHaveLength(4);
    expect(steps.map((step) => step.slice(0, 3))).toEqual(["1. ", "2. ", "3. ", "4. "]);
    const [wait, close, open, leave] = steps;
    // First the plug stays in: unplugged with the lid open, this Mac falls asleep by itself after an idle minute.
    expect(wait).toContain("Leave the power plug in.");
    expect(wait).toContain('two lines saying "the build job looked at the clock"');
    // The plug comes out first, the lid follows at once, half a minute before the build's time at the latest.
    expect(close).toContain("pull out the power plug and close the lid at once, before 14:04:30.");
    expect(close?.indexOf("pull out the power plug")).toBeLessThan(close?.indexOf("close the lid") ?? -1);
    expect(close).toContain("With the plug in, this Mac stays awake with the lid closed.");
    // Two minutes after the build's time, and the plug goes back.
    expect(open).toContain("Open the lid again any time after 14:07:00, log in, and put the power plug back.");
    expect(leave).toContain("Leave it open for five minutes.");
    // Nowhere is the lid closed without the plug being named in the same step.
    for (const step of steps) if (/close the lid/i.test(step)) expect(step, step).toMatch(/power plug/);
    // With no clock of its own given, the times are this Mac's: a time of day, nothing else.
    expect(sittingSteps(new Date("2026-10-12T14:05:00.000Z"))[1]).toMatch(/before \d\d:\d\d:\d\d\./);
  });

  it("says the likely cause when a sitting's Mac was not asleep at the build's time: still on mains power", () => {
    const never = notAsleepReason(false);
    expect(never).toContain("the Mac never slept");
    expect(never).toContain("Most likely it was still on mains power");
    expect(never).toContain("Pull out the power plug, then close the lid at once");
    expect(never).toContain("this was an ordinary run");
    // It slept, at another time: then the plug was out, and the timing was off.
    const elsewhen = notAsleepReason(true);
    expect(elsewhen).toContain("the Mac slept, but not across the build's time");
    expect(elsewhen).toContain("closed too late or opened too early");
    expect(elsewhen).not.toContain("mains power");
    // Each is the end of a line the script prints, and is put into a sentence of its last line.
    for (const reason of [never, elsewhen]) expect(reason, reason).toMatch(/^the Mac [^\n]*[a-z]$/);
  });

  it("looks for the lines the tool itself writes: the build's summary, and the night clock's two messages", () => {
    expect(buildSummary({ built: [], failed: [], skipped: SKIPPED_NOTHING_APPROVED })).toBe(NOTHING_APPROVED_LINE);
    const clock = readFileSync(path.join(repoRoot(), "packages", "cli", "src", "commands", "night-tick.ts"), "utf8");
    expect(clock).toContain(`"${STARTING_MESSAGE}"`);
    expect(clock).toContain(`"${FIRST_CHECK_MESSAGE}"`);
  });

  (process.platform === "darwin" ? it : it.skip)("turns the installer's filled-in settings into the throwaway ones: the name is swapped, six settings are added, and nothing else changes", () => {
    const node = process.execPath;
    const dataDir = path.join(scratch, "spike data & <more>");
    const fakeHome = path.join(dataDir, "spike", "home");
    const without = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "");
    for (const job of ["build", "deliver"] as const) {
      // The real template, filled in by the real installer function (nothing is installed).
      const rendered = withScript('render_plist "$@"', [job, node, repoRoot(), dataDir, fakeHome]);
      const options = { job, dataDir, timeZone: "America/Boise", buildTime: "14:03", deliverTime: "02:33" };
      const expected = { ...options, node, home: fakeHome };
      const text = throwawaySettings(rendered, options);
      const file = path.join(scratch, `spike ${job}.plist`);
      writeFileSync(file, text);
      execFileSync("/usr/bin/plutil", ["-lint", file], { timeout: 15_000, stdio: "ignore" });
      const settings = plistAsJson(file) as Record<string, unknown>;
      expect(settings, job).toEqual({
        Label: SPIKE_LABELS[job],
        ProgramArguments: [node, ENTRY, job, "--if-due"],
        WorkingDirectory: repoRoot(),
        EnvironmentVariables: {
          PATH: `${BARE_PATH}:${path.dirname(node)}:${fakeHome}/.local/bin`,
          // A made-up home inside the scratch folder: no login is in the job's reach.
          HOME: fakeHome,
          OVERNIGHT_DATA_DIR: dataDir,
          TZ: "America/Boise",
          BUILD_TIME: "14:03",
          DELIVER_TIME: "02:33",
          PAUSED: "false",
          // A port nothing listens on: the real gateway is never asked.
          KIROCREW_PORT: "9",
        },
        StartInterval: NIGHT_TICK_SECONDS,
        RunAtLoad: true,
        ExitTimeOut: 60,
        StandardOutPath: `${dataDir}/logs/${job}.launchd.log`,
        StandardErrorPath: `${dataDir}/logs/${job}.launchd.log`,
      });
      expect(settingsProblem(settings, expected), job).toBeNull();
      // The real job's name is nowhere in the settings themselves.
      expect(without(text), job).not.toContain(label(job));
      // Line for line the installer's text, but for the one name and the twelve added lines.
      const before = rendered.split("\n");
      const after = text.split("\n");
      expect(after.filter((line) => !before.includes(line)), job).toHaveLength(13);
      expect(before.filter((line) => !after.includes(line)), job).toEqual([`  <string>${label(job)}</string>`]);

      // Each thing that would make it something else is named.
      const environment = settings.EnvironmentVariables as Record<string, string>;
      const wrong = (change: Record<string, unknown>) => settingsProblem({ ...settings, ...change }, expected);
      expect(wrong({ Label: label(job) })).toBe("its job name is not the throwaway one");
      expect(wrong({ ProgramArguments: [node, ENTRY, job] })).toBe(`it does not run "overnight ${job} --if-due"`);
      expect(wrong({ StartInterval: 30 })).toBe("macOS would not wake it every 60 seconds");
      expect(wrong({ RunAtLoad: false })).toBe("macOS would not start it when it is loaded");
      expect(wrong({ StartCalendarInterval: { Hour: 1, Minute: 0 } })).toBe("it is on macOS's calendar, or kept alive");
      expect(wrong({ KeepAlive: true })).toBe("it is on macOS's calendar, or kept alive");
      expect(wrong({ StandardOutPath: "/made-up/real data/logs/build.launchd.log" })).toBe("what it prints would not go to the scratch folder");
      expect(wrong({ EnvironmentVariables: { ...environment, HOME: "/Users/someone" } })).toBe("its environment is not the made-up home and the six added settings");
      expect(wrong({ EnvironmentVariables: { ...environment, OVERNIGHT_DATA_DIR: "/Users/someone/.overnight" } })).toBe("its environment is not the made-up home and the six added settings");
      expect(wrong({ EnvironmentVariables: { ...environment, KIROCREW_PORT: "5476" } })).toBe("its environment is not the made-up home and the six added settings");
      expect(wrong({ EnvironmentVariables: { ...environment, PATH: `${fakeHome}/.local/bin:${BARE_PATH}` } })).toBe("its PATH is not the night jobs' own");
      expect(settingsProblem(null, expected)).toBe("it is not a settings file");
      expect(settingsProblem(settings, { ...expected, job: job === "build" ? "deliver" : "build" })).toBe("its job name is not the throwaway one");

      // Text that is not shaped the way the installer writes it is not guessed at.
      expect(() => throwawaySettings("<plist/>", options)).toThrow(`The filled-in ${job} settings do not name their job exactly once`);
      expect(() => throwawaySettings(rendered.replace("<key>HOME</key>", "<key>NOT_HOME</key>"), options)).toThrow(`The filled-in ${job} settings do not give HOME exactly once`);
      // The listener's settings are never taken for a night job's.
      expect(() => throwawaySettings(withScript('render_plist "$@"', ["listen", node, repoRoot(), dataDir, fakeHome]), options)).toThrow("do not name their job exactly once");
    }
  });
});
