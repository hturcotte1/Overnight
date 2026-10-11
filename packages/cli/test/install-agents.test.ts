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
// is really run (pause, status), but always with its data folder forced into the scratch folder,
// so the real one is never opened, and with the gateway's port pointed at one where nothing
// listens. No test runs the script's own `install`, `uninstall` or `restart` subcommand. Every
// path, job listing and log line below is made up.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dataPaths, parseConfig } from "@overnight/core";
import { JOB_LABEL, jobSettingsFile, NIGHT_JOB_LABELS } from "../src/background.ts";
import { repoRoot } from "../src/context.ts";

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

  it("use only the placeholders the installer fills in", () => {
    for (const job of ["build", "deliver"] as const) {
      expect(placeholders(read(job)), job).toEqual(["__DATA_DIR__", "__HOME__", "__HOUR__", "__MINUTE__", "__NODE_DIR__", "__NODE__", "__REPO__"]);
    }
    expect(placeholders(read("crew"))).toEqual(["__CREW_ARGUMENTS__", "__DATA_DIR__", "__HOME__", "__NODE_DIR__"]);
  });

  it("name the jobs the way the app does, and run the right command", () => {
    expect(read("build")).toContain(`<string>${NIGHT_JOB_LABELS.build}</string>`);
    expect(read("deliver")).toContain(`<string>${NIGHT_JOB_LABELS.deliver}</string>`);
    expect(read("crew")).toContain(`<string>${NIGHT_JOB_LABELS.crew}</string>`);
    expect(read("build")).toMatch(/<string>__REPO__\/packages\/cli\/src\/main\.ts<\/string>\s*<string>build<\/string>/);
    expect(read("deliver")).toMatch(/<string>__REPO__\/packages\/cli\/src\/main\.ts<\/string>\s*<string>deliver<\/string>/);
  });

  it("say, where the schedule is, what macOS does about a run missed while asleep", () => {
    for (const job of ["build", "deliver"] as const) {
      expect(read(job), job).toContain("macOS runs the job once when the Mac next wakes");
      expect(read(job), job).toContain("launchd.plist(5)");
    }
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

  it("fills the build and deliver templates into valid plists: once a day, never at load, never kept alive", () => {
    const node = "/opt/My Tools & Co/node <24>/bin/node";
    const repo = "/Users/someone/My Repo \\ $x & more";
    const dataDir = "/Volumes/Data Disk/over night";
    for (const [job, hour, minute] of [["build", "1", "0"], ["deliver", "6", "30"], ["deliver", "23", "40"]] as const) {
      const file = path.join(scratch, `filled ${job} ${hour}.plist`);
      writeFileSync(file, withScript('render_plist "$@"', [job, node, repo, dataDir, home, hour, minute]));
      execFileSync("/usr/bin/plutil", ["-lint", file], { timeout: 15_000, stdio: "ignore" });
      // Exactly these keys: no KeepAlive, and nothing that would start the job at login.
      expect(plistAsJson(file), job).toEqual({
        Label: label(job),
        ProgramArguments: [node, `${repo}/packages/cli/src/main.ts`, job],
        WorkingDirectory: repo,
        // macOS's own folders first: `git` must be the system's. gh, kirocrew and kiro-cli live in ~/.local/bin.
        EnvironmentVariables: { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/My Tools & Co/node <24>/bin:${home}/.local/bin`, HOME: home },
        StartCalendarInterval: { Hour: Number(hour), Minute: Number(minute) },
        RunAtLoad: false,
        ExitTimeOut: 60,
        StandardOutPath: `${dataDir}/logs/${job}.launchd.log`,
        StandardErrorPath: `${dataDir}/logs/${job}.launchd.log`,
      });
    }
  });

  it("refuses to fill a calendar template without an hour and a minute", () => {
    for (const extra of [[], ["1"], ["one", "0"], ["1", ""]]) {
      const ran = runScript('render_plist "$@"', ["build", "/n/node", "/r", "/d", home, ...extra]);
      expect(ran.status, JSON.stringify(extra)).toBe(1);
      expect(ran.stderr).toBe("install-agents: The build job needs an hour and a minute.\n");
    }
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
  // calendar job is listed with no pid, as between two of its runs.
  const DRY_RUN = `
    CALLS="$1"; STATE="$2"; MODE="$3"; SCRATCH="$4"; ENV_FILE="$5"; DATA="$6"; CLI_CALLS="$7"
    shift 7
    launchctl() {
      printf '%s\\n' "$*" >>"$CALLS"
      local job
      case "$1" in
        bootout)
          job="\${2##*/}"
          echo down >"$STATE.$job"
          ;;
        bootstrap)
          if [[ "$MODE" == "bootstrap-fails" ]]; then
            echo "Bootstrap failed: 5: Input/output error" >&2
            return 5
          fi
          job="$(basename -- "$3" .plist)"
          if [[ "$MODE" != "not-listed" ]]; then echo up >"$STATE.$job"; fi
          ;;
        print)
          job="\${2##*/}"
          [[ "$(cat "$STATE.$job" 2>/dev/null)" == up ]] || return 113
          printf '%s = {\\n' "$2"
          if [[ "$MODE" == "job-dies" ]]; then
            printf '\\tstate = spawn scheduled\\n\\tlast exit code = 2\\n}\\n'
          elif [[ "$job" == com.overnight.build || "$job" == com.overnight.deliver ]]; then
            printf '\\tstate = not running\\n\\tlast exit code = (never exited)\\n}\\n'
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
    /** What was asked of the stand-in for Kiro Crew's program, in order. */
    kirocrew: string[];
    /** The sandbox commands macOS was "asked" to load (a stand-in answered), one per line. */
    sandboxChecks: string[];
  }

  type DryRunMode = "ok" | "job-dies" | "bootstrap-fails" | "pause-fails" | "bad-setting" | "not-listed";

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
    return { ...ran, home: fakeHome, plist: jobSettingsFile(fakeHome), dataDir, calls: linesOf(callsFile), cli: linesOf(cliCallsFile), kirocrew: linesOf(kirocrewCalls), sandboxChecks: linesOf(`${callsFile}.sandbox`) };
  }
  /** The name the tests written for the listener alone know it by. */
  const dryRunInstall = dryRun;

  const plistOf = (run: DryRun, job: Job) => jobSettingsFile(run.home, label(job));
  const targetOf = (job: Job) => `gui/not-a-real-domain/${label(job)}`;
  /** The launchctl calls of one install of one job: stop the old copy, start the new one, look, show. */
  const installCalls = (run: DryRun, job: Job) => [`bootout ${targetOf(job)}`, `print ${targetOf(job)}`, `enable ${targetOf(job)}`, `bootstrap gui/not-a-real-domain ${plistOf(run, job)}`, `print ${targetOf(job)}`, `print ${targetOf(job)}`];

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

  it("installs the nightly build alone: once a day at BUILD_TIME, and nothing else is touched", () => {
    const run = dryRun({ jobs: ["build"] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // Stop any old copy, hand the new one to macOS, check macOS lists it, show its status.
    expect(run.calls).toEqual(installCalls(run, "build"));
    expect(mode(plistOf(run, "build"))).toBe(0o600);
    expect(plistAsJson(plistOf(run, "build"))).toEqual({
      Label: "com.overnight.build",
      ProgramArguments: [NODE, ENTRY, "build"],
      WorkingDirectory: repoRoot(),
      // macOS's own folders come first: a program the job starts by name is the system's.
      EnvironmentVariables: { PATH: nightPath(run), HOME: run.home },
      StartCalendarInterval: { Hour: 1, Minute: 0 },
      RunAtLoad: false,
      ExitTimeOut: 60,
      StandardOutPath: `${run.dataDir}/logs/build.launchd.log`,
      StandardErrorPath: `${run.dataDir}/logs/build.launchd.log`,
    });
    expect(nightPath(run).startsWith("/usr/bin:/bin:/usr/sbin:/sbin:")).toBe(true);
    for (const other of ["listen", "crew", "deliver"] as const) expect(existsSync(plistOf(run, other)), other).toBe(false);
    // The times are read from the tool, the way the job itself will see them.
    expect(run.cli).toEqual(["--help", "pause", "status --json", "status --json"]);
    // Kiro Crew is no business of this job: not asked, and no skill is copied.
    expect(run.kirocrew).toEqual([]);
    expect(existsSync(skillOf(run))).toBe(false);

    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe("Installed. Overnight now builds approved ideas every day at 01:00.");
    expect(lines).toContain(`  settings:     ${plistOf(run, "build")}`);
    expect(lines).toContain('  Note: the "kiro-crew" builder needs the Kiro Crew gateway job too: scripts/install-agents.sh install crew');
    expect(lines).toContain("Mode: paused (quiet mode). Overnight is listening and saving, not asking or building.");
    // A calendar job has no process between its runs, and that is not a fault.
    expect(lines).toContain("Overnight nightly build (com.overnight.build)");
    expect(lines).toContain("  state:           not running");
    expect(lines).toContain("  pid:             none (it runs at its time, not in between)");
    expect(lines).toContain("  runs at:         01:00 every day, on this Mac's clock");
  }, 30_000);

  it("installs the morning delivery 30 minutes before DELIVER_TIME, around midnight too", () => {
    const run = dryRun({ jobs: ["deliver"] });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(installCalls(run, "deliver"));
    expect(plistAsJson(plistOf(run, "deliver"))).toEqual({
      Label: "com.overnight.deliver",
      ProgramArguments: [NODE, ENTRY, "deliver"],
      WorkingDirectory: repoRoot(),
      // `git` and `gh` are started by name: the system's folders come first.
      EnvironmentVariables: { PATH: nightPath(run), HOME: run.home },
      StartCalendarInterval: { Hour: 6, Minute: 30 },
      RunAtLoad: false,
      ExitTimeOut: 60,
      StandardOutPath: `${run.dataDir}/logs/deliver.launchd.log`,
      StandardErrorPath: `${run.dataDir}/logs/deliver.launchd.log`,
    });
    expect(run.stdout.split("\n")[0]).toBe("Installed. Overnight now tests, publishes and delivers every day at 06:30, for a buzz on the wrist at 07:00.");
    expect(run.stdout).toContain("  runs at:         06:30 every day, on this Mac's clock");

    const early = dryRun({ jobs: ["build", "deliver"], env: { DRY_BUILD_TIME: "23:45", DRY_DELIVER_TIME: "00:10" } });
    expect(early.status).toBe(0);
    expect((plistAsJson(plistOf(early, "build")) as { StartCalendarInterval: unknown }).StartCalendarInterval).toEqual({ Hour: 23, Minute: 45 });
    expect((plistAsJson(plistOf(early, "deliver")) as { StartCalendarInterval: unknown }).StartCalendarInterval).toEqual({ Hour: 23, Minute: 40 });
    expect(early.stdout).toContain("Installed. Overnight now builds approved ideas every day at 23:45.");
    expect(early.stdout).toContain("Installed. Overnight now tests, publishes and delivers every day at 23:40, for a buzz on the wrist at 00:10.");
  }, 30_000);

  it("refuses to schedule the night when this Mac's clock and the TZ setting disagree, and changes nothing", () => {
    for (const jobs of [["build"], ["deliver"], [] as Job[]] as Job[][]) {
      const run = dryRun({ jobs, env: { DRY_MAC_ZONE: "America/New_York" } });
      expect(run.status, jobs.join("+")).toBe(1);
      expect(run.stderr).toContain("install-agents: This Mac's clock is set to the time zone America/New_York, but Overnight's TZ setting is America/Boise.");
      expect(run.stderr).toContain("would run at the wrong hour");
      expect(run.stderr).toContain("Set TZ=America/New_York in");
      expect(run.stderr).toContain("Nothing was changed.");
      // Not even the listener, when every job was asked for: nothing is half-installed.
      expectUntouched(run);
    }

    // Two names for one clock are no disagreement.
    const sameClock = dryRun({ jobs: ["build"], env: { DRY_MAC_ZONE: "America/Denver" } });
    expect(sameClock.status).toBe(0);
    // The listener and the gateway have no schedule, so the clock is no concern of theirs.
    const listener = dryRun({ jobs: ["listen", "crew"], env: { DRY_MAC_ZONE: "America/New_York" } });
    expect(listener.status).toBe(0);
    // The setting can be anything, as long as the Mac agrees with it.
    const eastern = dryRun({ jobs: ["build"], env: { DRY_MAC_ZONE: "America/New_York", DRY_TZ: "America/New_York" } });
    expect(eastern.status).toBe(0);

    const unknown = dryRun({ jobs: ["deliver"], env: { DRY_MAC_ZONE: "" } });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("install-agents: Could not read this Mac's time zone");
    expectUntouched(unknown);
  }, 60_000);

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
      // macOS was asked, before anything was changed, whether that very command loads.
      expect(run.sandboxChecks).toEqual([command.join(" ")]);
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
    // That very line was the one macOS was asked to load, before anything was changed.
    expect(run.sandboxChecks).toEqual([args.join(" ")]);

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
  }, 60_000);

  it("installs all four when no job is named: listener, gateway, build, delivery, each checked before any is touched", () => {
    const run = dryRun({ jobs: [] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const starts = (job: Job) => installCalls(run, job).slice(0, 5);
    expect(run.calls).toEqual([
      ...starts("listen"),
      ...starts("crew"),
      ...starts("build"),
      ...starts("deliver"),
      // The status at the end, one job after the other.
      ...JOBS.map((job) => `print ${targetOf(job)}`),
    ]);
    for (const job of JOBS) {
      expect(mode(plistOf(run, job)), job).toBe(0o600);
      execFileSync("/usr/bin/plutil", ["-lint", plistOf(run, job)], { timeout: 15_000, stdio: "ignore" });
      expect((plistAsJson(plistOf(run, job)) as { Label: string }).Label).toBe(label(job));
    }
    // Quiet mode is stored once, the settings are read once, and the mode is read back once.
    expect(run.cli).toEqual(["--help", "pause", "status --json", "status --json"]);
    const lines = run.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("Installed."))).toEqual([
      "Installed. Overnight now listens in the background and starts again at login.",
      "Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: overnight, from Overnight's settings). It answers.",
      "Installed. Overnight now builds approved ideas every day at 01:00.",
      "Installed. Overnight now tests, publishes and delivers every day at 06:30, for a buzz on the wrist at 07:00.",
    ]);
    // With the gateway installed alongside, there is nothing to remind about.
    expect(run.stdout).not.toContain("Note:");
    expect(lines).toContain("This is a first install, so Overnight was put in quiet mode before it started.");
    for (const title of ["Overnight listener (com.overnight.listen)", "Kiro Crew gateway (com.overnight.crew)", "Overnight nightly build (com.overnight.build)", "Overnight morning delivery (com.overnight.deliver)"]) {
      expect(lines).toContain(title);
    }
    // What the installed tool then says about the night, read back the way the installer reads it.
    expect(JSON.parse(overnight(run, "status", "--json"))).toMatchObject({ buildSandbox: "overnight", nightJobs: { build: true, deliver: true, crew: true }, gatewayAnswers: false, paused: true });
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

  it("does not claim success when macOS does not list a calendar job after taking it", () => {
    const run = dryRun({ jobs: ["build"], mode: "not-listed" });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Installed.");
    expect(run.stderr).toContain("install-agents: The settings file is in place, but macOS does not list the job, so it will not run at its time.");
    // One look, not two: a calendar job is not expected to have a process to wait for.
    expect(run.calls.map((call) => call.split(" ")[0])).toEqual(["bootout", "print", "enable", "bootstrap", "print", "print"]);
  }, 30_000);

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

    const one = dryRun({ jobs: ["build"], into: installed, action: "cmd_restart" });
    expect(one.status).toBe(0);
    expect(one.calls.slice(seen)).toEqual(installCalls(one, "build"));
    expect(one.stdout.split("\n")[0]).toBe("Restarted: Overnight nightly build.");
    seen = one.calls.length;

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
