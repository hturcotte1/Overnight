// Checks launchd/com.overnight.listen.plist.template and scripts/install-agents.sh WITHOUT
// installing anything on this Mac. The script is loaded with `source`, so only the functions
// named in each test run, and HOME is always a scratch folder.
//
// The install step is run as a DRY RUN only (see dryRunInstall): `launchctl` is replaced by a
// shell function that records its calls, the launchd domain is a made-up name that the real
// launchctl would refuse, and the settings file, the .env and the data folder are all inside the
// scratch folder. The `overnight` tool itself is really run (pause, status), but always with its
// data folder forced into the scratch folder, so the real one is never opened. No test here calls
// uninstall or restart, and none runs the script's own `install` subcommand. Every path, job
// listing and log line below is made up.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@overnight/core";
import { JOB_LABEL, jobSettingsFile } from "../src/background.ts";
import { repoRoot } from "../src/context.ts";

const SCRIPT = path.join(repoRoot(), "scripts", "install-agents.sh");
const TEMPLATE = path.join(repoRoot(), "launchd", "com.overnight.listen.plist.template");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const NODE_DIR = path.dirname(process.execPath);

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

describeOnMac("scripts/install-agents.sh", () => {
  it("fills the template into a valid plist, even with spaces and XML characters in the paths", () => {
    const node = "/opt/My Tools & Co/node <24>/bin/node";
    const repo = "/Users/someone/My Repo \\ $x & more";
    const dataDir = "/Volumes/Data Disk/over night";
    const file = path.join(scratch, "filled.plist");
    writeFileSync(file, withScript('render_plist "$@"', [node, repo, dataDir, home]));

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

  it("finds the repo from its own location, and uses the job name and settings file the app looks for", () => {
    expect(withScript('printf "%s" "$REPO"')).toBe(repoRoot());
    expect(withScript('printf "%s" "$LABEL"')).toBe(JOB_LABEL);
    expect(withScript('printf "%s" "$PLIST"')).toBe(jobSettingsFile(home));
    expect(withScript('printf "%s" "$ENV_FILE"')).toBe(path.join(repoRoot(), ".env"));
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
      const shown = runScript("launchctl() { return 113; }; cmd_status; echo went on", [], { OVERNIGHT_DATA_DIR: value });
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

    const out = withScript('LISTING="$1"; launchctl() { cat "$LISTING"; }; cmd_status', [listing], { OVERNIGHT_DATA_DIR: dataDir });
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
    const out = withScript("launchctl() { return 113; }; cmd_status", [], { OVERNIGHT_DATA_DIR: dataDir });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           not installed",
      `  nothing in its log yet (${dataDir}/logs/listen.log)`,
      `  nothing printed outside that log (${dataDir}/logs/listen.launchd.log)`,
      "",
    ]);
  });

  it("prints its usage and exits 2 when no subcommand, or an unknown one, is given", () => {
    // Never "install", "uninstall" or "restart" here, not even in a call that should be refused.
    for (const args of [[], ["frobnicate"], ["status", "extra"]]) {
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
  // Stands in for macOS. Records every call; remembers in a file whether the made-up job is
  // "loaded"; and answers `print` the way launchctl does: exit 113 when it is not loaded, else a
  // listing, with a pid unless the job is meant to have died straight away.
  const DRY_RUN = `
    CALLS="$1"; STATE="$2"; MODE="$3"; SCRATCH="$4"; ENV_FILE="$5"; DATA="$6"; CLI_CALLS="$7"
    launchctl() {
      printf '%s\\n' "$*" >>"$CALLS"
      case "$1" in
        bootout) echo down >"$STATE" ;;
        bootstrap)
          if [[ "$MODE" == "bootstrap-fails" ]]; then
            echo "Bootstrap failed: 5: Input/output error" >&2
            return 5
          fi
          echo up >"$STATE"
          ;;
        print)
          [[ "$(cat "$STATE" 2>/dev/null)" == up ]] || return 113
          printf '%s = {\\n' "$2"
          if [[ "$MODE" == "job-dies" ]]; then
            printf '\\tstate = spawn scheduled\\n\\tlast exit code = 2\\n}\\n'
          else
            printf '\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = (never exited)\\n}\\n'
          fi
          ;;
      esac
      return 0
    }
    sleep() { :; }
    DOMAIN="gui/not-a-real-domain"
    TARGET="$DOMAIN/$LABEL"
    case "$PLIST" in
      "$SCRATCH"/*) ;;
      *) echo "refusing: the settings file is outside the scratch folder" >&2; exit 99 ;;
    esac
    case "$DATA" in
      "$SCRATCH"/*) ;;
      *) echo "refusing: the data folder is outside the scratch folder" >&2; exit 99 ;;
    esac
    # The real tool, in the same bare environment as the script's own job_cli, with one addition:
    # the data folder is forced into the scratch folder. (The real tool reads the repo's .env, not
    # the made-up one, so without this it could open the real data folder.)
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
      env -i HOME="$HOME" PATH="$(dirname -- "$node"):/usr/bin:/bin:/usr/sbin:/sbin" OVERNIGHT_DATA_DIR="$DATA" \\
        MAX_ASKS_PER_DAY="$bad" "$node" "$ENTRY" "$@"
    }
    cmd_install
  `;

  interface DryRun extends Ran {
    home: string;
    plist: string;
    dataDir: string;
    /** What was asked of launchctl, in order. */
    calls: string[];
    /** What was asked of the `overnight` tool, in order. */
    cli: string[];
  }

  type DryRunMode = "ok" | "job-dies" | "bootstrap-fails" | "pause-fails" | "bad-setting";

  /** One made-up Mac per call (or the one passed in, to install a second time). */
  function dryRunInstall(options: { mode?: DryRunMode; env?: Record<string, string>; envFile?: "sets the data folder" | "none"; into?: DryRun; pathDir?: string; before?: (dataDir: string) => void } = {}): DryRun {
    counter += 1;
    const root = options.into ? path.dirname(options.into.home) : path.join(scratch, `dry run ${counter}`);
    const fakeHome = path.join(root, "home of someone");
    const dataDir = options.envFile === "none" ? path.join(fakeHome, ".overnight") : path.join(root, "data folder");
    const envFile = path.join(root, "made-up .env");
    mkdirSync(fakeHome, { recursive: true });
    if (options.envFile !== "none") writeFileSync(envFile, `# made up for this test\nOVERNIGHT_DATA_DIR=${dataDir}\n`);
    const callsFile = path.join(root, "launchctl calls.txt");
    const cliCallsFile = path.join(root, "overnight calls.txt");
    options.before?.(dataDir);
    const ran = runScript(DRY_RUN, [callsFile, path.join(root, "job state.txt"), options.mode ?? "ok", scratch, envFile, dataDir, cliCallsFile], {
      PATH: `${options.pathDir ?? NODE_DIR}:${BARE_PATH}`,
      HOME: fakeHome,
      ...options.env,
    });
    const linesOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n") : []);
    return { ...ran, home: fakeHome, plist: jobSettingsFile(fakeHome), dataDir, calls: linesOf(callsFile), cli: linesOf(cliCallsFile) };
  }

  /** Run the real tool against a dry run's scratch data folder, the way the installer's stand-in does. */
  function overnight(run: DryRun, ...args: string[]): string {
    return execFileSync(process.execPath, [path.join(repoRoot(), "packages", "cli", "src", "main.ts"), ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: `${NODE_DIR}:${BARE_PATH}`, HOME: run.home, OVERNIGHT_DATA_DIR: run.dataDir },
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
      ProgramArguments: [path.join(NODE_DIR, "node"), `${repoRoot()}/packages/cli/src/main.ts`, "listen"],
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
    const out = withScript("launchctl() { return 113; }; cmd_status", [], { HOME: installed.home, OVERNIGHT_DATA_DIR: path.join(scratch, "somewhere else") });
    expect(out.split("\n")).toEqual([
      "Overnight listener (com.overnight.listen)",
      "  state:           not loaded (the settings file is there, but macOS is not running the job)",
      "                   Run: scripts/install-agents.sh install",
      `  last 5 lines of its log (${installed.dataDir}/logs/listen.log):`,
      "    made-up log line",
      `  nothing printed outside that log (${installed.dataDir}/logs/listen.launchd.log)`,
      "",
    ]);
  }, 30_000);
});
