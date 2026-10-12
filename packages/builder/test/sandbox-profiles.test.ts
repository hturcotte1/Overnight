// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The two sandbox profiles that ship with the builder, run for real with /usr/bin/sandbox-exec
// around harmless commands (cat, ls, touch, mv, chmod, kill, a two-line script ...) on a made-up
// home folder, data folder and repo in a temp folder. Nothing real is read or written there:
// every path a rule names is built from the made-up folders.
// The last block starts the real node, npm, kirocrew and kiro-cli inside each profile (to print
// their version, nothing else) and looks at exit codes only. Skipped where a sandbox cannot be
// started, or where a tool is not installed.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataPaths } from "@overnight/core";
import { CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE, sealWorkspace } from "../src/index.ts";
import { BEE_COPY, BUILT_MARKER_FILE, BUILT_TESTS, DECOY_MARK, DECOY_PATTERN, judgeProbe, LIST_TESTS, listTestTargets, probeCommand, startDecoy, takeMadeFiles, WRITE_TEST_FILE, WRITE_TESTS, writeTestTargets, writeTries } from "../src/probe.ts";
import { profileParams, SANDBOX_VALUE_NAMES } from "../src/sandbox-values.ts";
import { tempDir } from "./helpers.ts";

const ID = "idea_20261010_ab12cd34";
const GATEWAY = readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8");
const KIRO = readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8");
const DECOY = "decoy: made up for the test\n";
/** A program a test tries to run: prints one word. */
const SCRIPT = "#!/bin/sh\necho ran\n";
/** The four "fences ... in" tests each start well over a hundred sandboxed commands: a few seconds, more on a busy Mac. */
const FENCE_TEST_TIMEOUT_MS = 60_000;

/** Can this process start a macOS sandbox at all? (Not inside another sandbox, and only on a Mac.) */
const canSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 10_000 }).status === 0;

const helpers: ChildProcess[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const helper of helpers.splice(0)) helper.kill("SIGKILL");
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A made-up home, data folder and repo, each holding decoy files in the places the real ones
 * have them. `layout` "usual" puts the data folder inside the home folder, as on a real install.
 */
function world(layout: "split" | "usual" = "split") {
  const root = tempDir("overnight-sandbox-test-");
  const home = path.join(root, "home");
  const data = layout === "usual" ? path.join(home, ".overnight") : path.join(root, "data");
  const repo = path.join(home, "Documents", "overnight");
  const nodeDir = path.join(home, ".local", "node-made-up");
  const npmCache = path.join(home, ".npm");
  const kiroHome = path.join(home, ".kiro");
  const crewHome = path.join(kiroHome, "crew");
  const workspace = path.join(data, "workspaces", ID);
  /** Where finished builds are kept: out of every build job's reach. */
  const built = path.join(data, "built");
  const buildTmp = path.join(data, "tmp", "build");
  const probe = path.join(data, "tmp", "build-probe");
  const support = path.join(home, "Library", "Application Support", "kiro-cli");
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(nodeDir, "bin"),
    path.join(crewHome, "skills", "overnight-build"),
    path.join(kiroHome, "crew-venv", "bin"),
    path.join(kiroHome, "crew-python"),
    path.join(kiroHome, "agents", ".kirocrew-skill-projection-metadata"),
    path.join(kiroHome, "sessions", "cli"),
    path.join(kiroHome, "settings"),
    path.join(kiroHome, "crew-auth-staging"),
    path.join(home, "workplace", "kirocrew-workspace"),
    path.join(npmCache, "_cacache"),
    path.join(npmCache, "_logs"),
    path.join(npmCache, "_npx"),
    path.join(support, "shell"),
    path.join(home, "Library", "LaunchAgents"),
    path.join(home, "Library", "Preferences"),
    path.join(home, ".config", "fish"),
    path.join(home, "Desktop"),
    probe,
    buildTmp,
    path.join(data, "tmp", "deliver"),
    path.join(data, "workspaces", "idea_other"),
    workspace,
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const files = {
    // Overnight's own data
    database: path.join(data, "overnight.db"),
    wal: path.join(data, "overnight.db-wal"),
    lock: path.join(data, "build.lock"),
    log: path.join(data, "logs", "listen.log"),
    detector: path.join(data, "kiro-detector", "settings.json"),
    spikes: path.join(data, "spikes", "raw.jsonl"),
    otherBrief: path.join(data, "ideas", "idea_other", "brief.md"),
    // a finished build, and the file the nightly check keeps beside the finished builds
    sealedApp: path.join(built, "idea_sealed", "dist", "index.html"),
    builtMarker: path.join(built, BUILT_MARKER_FILE),
    report: path.join(data, "reports", "idea_other.json"),
    pagesConfig: path.join(data, "pages", ".git", "config"),
    deliverRun: path.join(data, "tmp", "deliver", "run.txt"),
    // the usual data folder, when the one in use is elsewhere
    usualDatabase: path.join(home, ".overnight", "overnight.db"),
    usualLog: path.join(home, ".overnight", "logs", "listen.log"),
    // logins
    ssh: path.join(home, ".ssh", "id_made_up"),
    aws: path.join(home, ".aws", "credentials"),
    gh: path.join(home, ".config", "gh", "hosts.yml"),
    keychain: path.join(home, "Library", "Keychains", "login.keychain-db"),
    env: path.join(repo, ".env"),
    // everything else a person keeps in a home folder
    document: path.join(home, "Documents", "letter.txt"),
    desktop: path.join(home, "Desktop", "notes.txt"),
    download: path.join(home, "Downloads", "statement.pdf"),
    browser: path.join(home, "Library", "Application Support", "Some Browser", "Default", "History"),
    otherAppCache: path.join(home, "Library", "Caches", "com.made-up.app", "cache.db"),
    homeFile: path.join(home, "package-lock.json"),
    zshenv: path.join(home, ".zshenv"),
    gitconfig: path.join(home, ".gitconfig"),
    // Claude Code's own
    claudeSession: path.join(home, ".claude", "projects", "made-up", "session.jsonl"),
    claudeJson: path.join(home, ".claude.json"),
    claudeApp: path.join(home, "Library", "Application Support", "Claude", "config.json"),
    // this repo
    repoSource: path.join(repo, "packages", "cli", "src", "main.ts"),
    envExample: path.join(repo, ".env.example"),
    repoBee: path.join(repo, "node_modules", "@beeai", "cli", "bee"),
    // the Node.js install: node, npm and npx, and a tool installed "globally" beside them
    node: path.join(nodeDir, "bin", "node"),
    npm: path.join(nodeDir, "bin", "npm"),
    npmModule: path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    nodeHeader: path.join(nodeDir, "include", "node", "node.h"),
    globalBee: path.join(nodeDir, "bin", "bee"),
    globalBeeModule: path.join(nodeDir, "lib", "node_modules", "@beeai", "cli", "login.txt"),
    // programs and settings that are used outside the sandbox
    ghProgram: path.join(home, ".local", "bin", "gh"),
    ghState: path.join(home, ".local", "state", "gh", "device-id"),
    kirocrew: path.join(kiroHome, "crew-venv", "bin", "kirocrew"),
    kiroSettings: path.join(kiroHome, "settings", "cli.json"),
    shellHook: path.join(support, "shell", "zshrc.pre.zsh"),
    // npm's cache
    cacheEntry: path.join(npmCache, "_cacache", "index-v5", "ab", "entry"),
    npmLog: path.join(npmCache, "_logs", "2026-10-10T00_00_00_000Z-debug-0.log"),
    // the browser for the smoke test
    browserShell: path.join(home, "Library", "Caches", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell"),
    // the workspaces
    brief: path.join(workspace, "brief.md"),
    otherWorkspace: path.join(data, "workspaces", "idea_other", "index.html"),
    // Kiro's and Kiro Crew's own
    crewConfig: path.join(crewHome, "config.json"),
    installedSkill: path.join(crewHome, "skills", "overnight-build", "SKILL.md"),
    crewAgent: path.join(kiroHome, "agents", "kirocrew.json"),
    kiroSession: path.join(kiroHome, "sessions", "cli", "made-up.json"),
    signIn: path.join(support, "data.sqlite3"),
    crewRun: path.join(home, "workplace", "kirocrew-workspace", "cron_made_up", "notes.txt"),
  };
  for (const file of Object.values(files)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, DECOY);
  }
  // Things a test tries to RUN.
  const programs = {
    inWorkspace: path.join(workspace, "tool.sh"),
    inBuildTmp: path.join(buildTmp, "tool.sh"),
    inProbe: path.join(probe, BEE_COPY),
    gh: files.ghProgram,
    repoBee: files.repoBee,
    globalBee: files.globalBee,
    inDocuments: path.join(home, "Documents", "tool.sh"),
    inData: path.join(data, "tool.sh"),
    inBuilt: path.join(built, "idea_sealed", "tool.sh"),
  };
  for (const program of Object.values(programs)) {
    writeFileSync(program, SCRIPT);
    chmodSync(program, 0o755);
  }
  // The same again as real programs, not scripts. A script cannot run unless the shell can READ
  // it, so a script alone would not show that RUNNING is refused: a real program that may not be
  // read can still be started unless that is refused as well. The program is a copy of the node
  // that runs this test (on this disk a clone, which takes no room). A copy of one of macOS's own
  // programs would not do: macOS kills those when they are started from another place.
  const binaries = {
    inWorkspace: path.join(workspace, "tool"),
    repoBee: path.join(repo, "node_modules", "@beeai", "cli", "bee-binary"),
    inDocuments: path.join(home, "Documents", "tool"),
  };
  for (const binary of Object.values(binaries)) {
    copyFileSync(process.execPath, binary, constants.COPYFILE_FICLONE);
    chmodSync(binary, 0o755);
  }
  symlinkSync(path.join(kiroHome, "crew-venv"), path.join(kiroHome, "crew-venv-current"));
  // The links Kiro Crew and Kiro CLI keep in ~/.local/bin to their own programs, and one other tool there.
  writeFileSync(files.kirocrew, SCRIPT);
  chmodSync(files.kirocrew, 0o755);
  symlinkSync(files.kirocrew, path.join(home, ".local", "bin", "kirocrew"));
  symlinkSync(programs.inDocuments, path.join(home, ".local", "bin", "kiro-cli"));
  writeFileSync(path.join(home, ".local", "bin", "other-tool"), SCRIPT);
  chmodSync(path.join(home, ".local", "bin", "other-tool"), 0o755);

  const given: Record<string, string> = { HOME: home, WORKSPACE: workspace, DATA_DIR: data, REPO: repo, NODE_DIR: nodeDir, NPM_CACHE: npmCache, KIRO_HOME: kiroHome, CREW_HOME: crewHome };
  /** sandbox-exec's arguments for a profile file: one -D for each name it asks for, as the builder gives them. */
  const values = (profileFile: string) => ["-f", profileFile, ...profileParams(readFileSync(profileFile, "utf8")).flatMap((name) => ["-D", `${name}=${given[name]}`])];
  const inside = (profileFile: string) => {
    const run = (command: string, args: string[]): SpawnSyncReturns<string> =>
      spawnSync("/usr/bin/sandbox-exec", [...values(profileFile), command, ...args], { cwd: workspace, encoding: "utf8", timeout: 15_000, env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: buildTmp } });
    return {
      run,
      canRead: (file: string) => run("/bin/cat", [file]).status === 0,
      canList: (dir: string) => run("/bin/ls", [dir]).status === 0,
      /** Look at a file or folder without opening it (its name, kind and size). */
      canSee: (file: string) => run("/usr/bin/stat", ["-f", "%z", file]).status === 0,
      /** Make a new file, or open an old one for writing. */
      canWrite: (file: string) => run("/usr/bin/touch", [file]).status === 0,
      canMove: (from: string, to: string) => run("/bin/mv", [from, to]).status === 0,
      canRun: (program: string) => run(program, []).stdout === "ran\n",
      /** The same for one of the copies of node. */
      canRunBinary: (program: string) => run(program, ["-e", "console.log('ran')"]).stdout === "ran\n",
    };
  };
  /** A copy of a shipped profile with rules added at its end (the later rule wins): a deliberately loosened fence. */
  const loosened = (profileFile: string, extraRules: string) => {
    const copy = path.join(root, `loosened-${path.basename(profileFile)}`);
    writeFileSync(copy, `${readFileSync(profileFile, "utf8")}\n${extraRules}\n`);
    return inside(copy);
  };
  return { root, home, data, repo, nodeDir, npmCache, kiroHome, crewHome, workspace, built, buildTmp, probe, support, files, programs, binaries, loosened, gateway: inside(CREW_GATEWAY_SANDBOX_PROFILE), kiro: inside(KIRO_CLI_SANDBOX_PROFILE) };
}
type World = ReturnType<typeof world>;
type Inside = World["gateway"];

/** The places both profiles must refuse to write, because something outside the sandbox runs or reads them. */
function protectedPlaces(w: World): Record<string, string> {
  return {
    "the home folder": path.join(w.home, "planted.txt"),
    "a shell start-up file that exists": w.files.zshenv,
    "a shell start-up file that does not exist yet": path.join(w.home, ".zshrc"),
    "bash's start-up file": path.join(w.home, ".bash_profile"),
    "git's settings": w.files.gitconfig,
    "~/.config": path.join(w.home, ".config", "fish", "config.fish"),
    "node": w.files.node,
    "a new program beside node": path.join(w.nodeDir, "bin", "git"),
    "a new program beside kirocrew's link": path.join(w.home, ".local", "bin", "git"),
    "the GitHub program": w.files.ghProgram,
    "Kiro Crew's program": w.files.kirocrew,
    "a new file in Kiro Crew's program folder": path.join(w.kiroHome, "crew-venv", "evil.py"),
    "Kiro Crew's Python": path.join(w.kiroHome, "crew-python", "planted"),
    "Kiro's settings": w.files.kiroSettings,
    "a new entry in ~/.kiro": path.join(w.kiroHome, "planted.md"),
    "Kiro's steering folder": path.join(w.kiroHome, "steering", "x.md"),
    "Kiro's skills folder": path.join(w.kiroHome, "skills", "x", "SKILL.md"),
    "Kiro's prompts folder": path.join(w.kiroHome, "prompts", "x.md"),
    "an agent file of somebody else's name": path.join(w.kiroHome, "agents", "planted.json"),
    "the files Kiro CLI gives to shells": w.files.shellHook,
    "npm's folder of packages it runs": path.join(w.npmCache, "_npx", "x"),
    "the top of npm's folder": path.join(w.npmCache, "planted"),
    "a background job": path.join(w.home, "Library", "LaunchAgents", "planted.plist"),
    "a preferences file": path.join(w.home, "Library", "Preferences", "planted.plist"),
    "the Documents folder": path.join(w.home, "Documents", "planted.txt"),
    "the browser for the smoke test": w.files.browserShell,
    "the repo": path.join(w.repo, "packages", "planted.ts"),
    "a file of the repo": w.files.repoSource,
    "the data folder": path.join(w.data, "planted.txt"),
    "the data folder's tmp": path.join(w.data, "tmp", "planted.txt"),
    "the usual data folder": path.join(w.home, ".overnight", "planted.txt"),
    "the temporary folder every program shares": path.join(tmpdir(), `overnight-sandbox-test-${process.pid}.tmp`),
    "/private/tmp": `/private/tmp/overnight-sandbox-test-${process.pid}.tmp`,
    "/private/var/tmp": `/private/var/tmp/overnight-sandbox-test-${process.pid}.tmp`,
  };
}

/** What both profiles must hide, for reading and for writing. */
const HIDDEN = [
  // Overnight's own data, and logins
  ...(["database", "wal", "lock", "log", "detector", "spikes", "otherBrief", "sealedApp", "builtMarker", "report", "pagesConfig", "deliverRun", "usualDatabase", "usualLog", "ssh", "aws", "gh", "keychain", "env"] as const),
  // the rest of the home folder: closed by default
  ...(["document", "desktop", "download", "browser", "otherAppCache", "homeFile", "zshenv", "gitconfig", "claudeSession", "claudeJson", "claudeApp", "repoSource", "envExample", "repoBee", "globalBee", "globalBeeModule", "ghProgram", "ghState"] as const),
] as const;

function expectCommonFence(w: World, box: Inside): void {
  for (const [what, file] of Object.entries(protectedPlaces(w))) expect(box.canWrite(file), `write ${what}`).toBe(false);
  expect(existsSync(path.join(w.home, "planted.txt"))).toBe(false);
  expect(existsSync(path.join(w.home, ".zshrc"))).toBe(false);
  expect(existsSync(`/private/tmp/overnight-sandbox-test-${process.pid}.tmp`)).toBe(false);

  for (const name of HIDDEN) {
    expect(box.canRead(w.files[name]), `read ${name}`).toBe(false);
    expect(box.canWrite(w.files[name]), `write ${name}`).toBe(false);
  }
  // Not even their names and sizes can be looked at: only the folders ON THE WAY to an open folder can.
  for (const name of ["document", "claudeSession", "database", "repoSource", "globalBeeModule"] as const) expect(box.canSee(w.files[name]), `look at ${name}`).toBe(false);
  // npm's logs name other projects on this Mac: a log can be made and written, never listed or read back.
  expect(box.canRead(w.files.npmLog)).toBe(false);
  expect(box.canList(path.join(w.npmCache, "_logs"))).toBe(false);
  expect(box.run("/bin/sh", ["-c", `echo made-up-line >> "${path.join(w.npmCache, "_logs", "new-debug-0.log")}"`]).status).toBe(0);

  const closedFolders = [
    w.data,
    path.join(w.data, "tmp"),
    path.join(w.data, "ideas"),
    path.join(w.data, "logs"),
    path.join(w.data, "pages"),
    w.built,
    path.join(w.built, "idea_sealed"),
    path.join(w.home, ".config", "gh"),
    path.join(w.home, "Library", "Keychains"),
    // closed by default: everything a person keeps in a home folder
    path.join(w.home, "Documents"),
    path.join(w.home, "Desktop"),
    path.join(w.home, "Library"),
    path.join(w.home, "Library", "Application Support"),
    path.join(w.home, "Library", "Caches"),
    path.join(w.home, ".claude"),
    path.join(w.home, ".claude", "projects"),
    path.join(w.home, ".npm"),
    w.repo,
    path.join(w.repo, "node_modules"),
    path.join(w.nodeDir, "lib", "node_modules"),
    // other disks, the folder shared between accounts, the shared temporary folders
    "/Volumes",
    "/Users/Shared",
    "/private/tmp",
    "/private/var/tmp",
  ];
  for (const dir of closedFolders) expect(box.canList(dir), `list ${dir}`).toBe(false);

  // What a build needs can be read ...
  for (const name of ["brief", "node", "npm", "npmModule", "nodeHeader", "cacheEntry", "browserShell", "kiroSettings", "kiroSession", "signIn"] as const) expect(box.canRead(w.files[name]), `read ${name}`).toBe(true);
  // ... and written.
  expect(box.canWrite(path.join(w.workspace, "src.ts"))).toBe(true);
  expect(box.canWrite(path.join(w.npmCache, "_cacache", "entry"))).toBe(true);
  expect(box.canWrite(path.join(w.npmCache, "_logs", "a.log"))).toBe(true);
  expect(box.canWrite(path.join(w.npmCache, "_update-notifier-last-checked"))).toBe(true);
  expect(box.canWrite(w.files.kiroSession)).toBe(true);
  expect(box.canWrite(w.files.signIn)).toBe(true);
  // The build jobs' own temporary folder is the one temporary folder there is.
  expect(box.canWrite(path.join(w.buildTmp, "scratch.tmp"))).toBe(true);
  expect(box.canRead(path.join(w.buildTmp, "scratch.tmp"))).toBe(true);
  expect(box.canList(w.buildTmp)).toBe(true);
  expect(box.canMove(w.buildTmp, path.join(w.workspace, "tmp-moved"))).toBe(false);

  // Running: only where a build may read. A file that cannot be read could otherwise still be run.
  expect(box.canRun(w.programs.inWorkspace), "run a program in the workspace").toBe(true);
  expect(box.canRun(w.programs.inBuildTmp), "run a program in the build's temporary folder").toBe(true);
  for (const name of ["gh", "repoBee", "globalBee", "inDocuments", "inData", "inBuilt"] as const) expect(box.canRun(w.programs[name]), `run ${name}`).toBe(false);
  // The same programs do run outside the sandbox: it is the fence that stops them.
  expect(spawnSync(w.programs.gh, [], { encoding: "utf8" }).stdout).toBe("ran\n");
  // Real programs, which need no reading to be started: allowed in the workspace, refused elsewhere.
  expect(box.canRunBinary(w.binaries.inWorkspace), "run a real program in the workspace").toBe(true);
  for (const name of ["repoBee", "inDocuments"] as const) expect(box.canRunBinary(w.binaries[name]), `run the real program ${name}`).toBe(false);
  // It does run outside the sandbox: it is the fence that stops it.
  expect(spawnSync(w.binaries.inDocuments, ["-e", "console.log('ran')"], { encoding: "utf8" }).stdout).toBe("ran\n");

  // Ways round a rule that only names a path: hard links, symbolic links, moving a folder.
  expect(box.run("/bin/ln", [w.files.database, path.join(w.workspace, "hard")]).status).not.toBe(0);
  box.run("/bin/ln", ["-s", w.files.database, path.join(w.workspace, "soft")]);
  expect(box.canRead(path.join(w.workspace, "soft"))).toBe(false);
  box.run("/bin/ln", ["-s", w.files.document, path.join(w.workspace, "soft-doc")]);
  expect(box.canRead(path.join(w.workspace, "soft-doc"))).toBe(false);
  expect(box.canMove(path.join(w.home, ".config"), path.join(w.home, ".config2")), "move ~/.config").toBe(false);
  expect(box.canMove(path.join(w.home, ".kiro"), path.join(w.workspace, "kiro")), "move ~/.kiro").toBe(false);
  expect(box.canMove(path.join(w.home, ".kiro", "crew-venv"), path.join(w.workspace, "venv")), "move crew-venv").toBe(false);
  expect(box.canMove(path.join(w.home, ".kiro", "crew-venv-current"), path.join(w.workspace, "venv-link")), "move the crew-venv-current link").toBe(false);
  expect(box.canMove(path.join(w.home, ".kiro", "sessions"), path.join(w.workspace, "sessions")), "move the sessions folder").toBe(false);
  expect(box.canMove(w.support, path.join(w.workspace, "kiro-cli")), "move Kiro CLI's folder").toBe(false);
  expect(box.canMove(path.join(w.data, "workspaces"), path.join(w.npmCache, "_cacache", "ws")), "move the workspaces folder").toBe(false);
  expect(box.canMove(path.join(w.home, "Documents"), path.join(w.workspace, "docs")), "move the Documents folder").toBe(false);
  expect(existsSync(w.files.shellHook) && existsSync(w.files.kirocrew) && existsSync(w.files.brief) && existsSync(w.files.document)).toBe(true);
}

function expectNoReachingOut(box: Inside): void {
  // Another process of this user, started outside the sandbox.
  const victim = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  helpers.push(victim);
  const pid = String(victim.pid);
  expect(spawnSync("/bin/kill", ["-0", pid]).status).toBe(0);
  for (const signal of ["-0", "-STOP", "-TERM", "-KILL"]) expect(box.run("/bin/kill", [signal, pid]).status, `kill ${signal}`).not.toBe(0);
  expect(spawnSync("/bin/kill", ["-0", pid]).status).toBe(0);
  // What the sandbox started itself can still be signalled: a build tool stops its own helpers.
  const own = box.run("/bin/sh", ["-c", "/bin/sleep 30 & child=$!; kill -TERM $child && wait $child; echo own-child-ended"]);
  expect(own.stdout).toContain("own-child-ended");

  // launchctl cannot be run at all (it would accept "disable" for the listener's job).
  expect(box.run("/bin/launchctl", ["version"]).status).not.toBe(0);
  expect(box.run("/bin/sh", ["-c", "/bin/launchctl version"]).status).not.toBe(0);
  // No starting other apps, no clipboard.
  expect(box.run("/usr/bin/open", ["-g", "-j", "-a", "Calculator"]).status).not.toBe(0);
  expect(box.run("/usr/bin/pbpaste", []).status).not.toBe(0);
  // (The preferences service is cut off too, but that cannot be tried on a made-up home: macOS
  // keeps preferences in the REAL home folder whatever HOME says, and the real one is not behind
  // this test's fence. It was tried from a real Kiro Crew job: `defaults write` was refused.)
  // Ordinary programs still run.
  expect(box.run("/bin/sh", ["-c", "echo still-works"]).stdout).toBe("still-works\n");
}

/**
 * Reads another process's command line the direct way (the sysctl "kern.procargs2", which is what
 * `ps` uses) and prints found=1 when it holds the word. Perl, because macOS ships it and it can
 * make the call without anything being compiled.
 */
const READ_ARGS = [
  "my ($pid, $word) = @ARGV;",
  'my $mib = pack("i3", 1, 49, $pid);', // CTL_KERN, KERN_PROCARGS2
  'my $buf = "\\0" x 262144;',
  'my $len = pack("L!", length $buf);',
  "my $rc = syscall(202, $mib, 3, $buf, $len, 0, 0);", // __sysctl
  'my $found = ($rc == 0 && index($buf, $word) >= 0) ? 1 : 0;',
  'print "rc=$rc found=$found\\n";',
].join(" ");

function expectOtherProgramsHidden(w: World, box: Inside, profileFile: string): void {
  // The stand-in for "another program": outside the sandbox, with a made-up word on its command line.
  const word = `made-up-prompt-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const other = spawn("/usr/bin/perl", ["-e", "sleep 60", word], { stdio: "ignore" });
  helpers.push(other);
  const pid = String(other.pid);
  // A pattern that matches the word and not itself, as the probe's does.
  const pattern = `${word.slice(0, -1)}[${word.slice(-1)}]`;

  // Outside any sandbox both ways work: the test's own tools are sound.
  expect(spawnSync("/usr/bin/perl", ["-e", READ_ARGS, pid, word], { encoding: "utf8" }).stdout).toBe("rc=0 found=1\n");
  expect(spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim()).toBe(pid);

  // Inside: the direct read is refused, and pgrep finds nothing.
  expect(box.run("/usr/bin/perl", ["-e", READ_ARGS, pid, word]).stdout).toBe("rc=-1 found=0\n");
  expect(box.run("/usr/bin/pgrep", ["-f", pattern]).stdout).toBe("");
  expect(box.run("/usr/bin/pgrep", ["-fl", "perl"]).stdout).not.toContain(word);

  // With the four rules taken back (a deliberately loosened copy) both ways work from inside:
  // it is those rules, and nothing else in the profile, that hide other programs.
  const loose = w.loosened(profileFile, '(allow process-info*)\n(allow sysctl-read)\n(allow mach-lookup (global-name "com.apple.sysmond"))');
  expect(loose.run("/usr/bin/perl", ["-e", READ_ARGS, pid, word]).stdout).toBe("rc=0 found=1\n");
  expect(loose.run("/usr/bin/pgrep", ["-f", pattern]).stdout.trim()).toBe(pid);
}

/**
 * Finished builds (<data>/built) are out of a build job's reach in every way a job could use one:
 * reading or changing the app that will be published, listing which ideas were built, putting a
 * build of its own there, or moving one away.
 */
function expectFinishedBuildsClosed(w: World, box: Inside): void {
  const sealed = path.join(w.built, "idea_sealed");
  // The app is really there, and readable outside the sandbox.
  expect(readFileSync(w.files.sealedApp, "utf8")).toBe(DECOY);
  expect(box.canRead(w.files.sealedApp), "read the finished app").toBe(false);
  expect(box.canSee(w.files.sealedApp), "look at the finished app").toBe(false);
  expect(box.canSee(sealed), "look at the idea's folder").toBe(false);
  expect(box.canList(w.built), "list the finished builds").toBe(false);
  expect(box.canList(sealed), "list one finished build").toBe(false);
  expect(box.canList(path.join(sealed, "dist")), "list its dist folder").toBe(false);
  expect(box.canWrite(w.files.sealedApp), "write the finished app").toBe(false);
  expect(box.run("/bin/sh", ["-c", `echo changed >> "${w.files.sealedApp}"`]).status, "add to the finished app").not.toBe(0);
  expect(box.canWrite(path.join(sealed, "dist", "planted.js")), "add a file to a finished build").toBe(false);
  expect(box.canWrite(path.join(w.built, WRITE_TEST_FILE)), "make a file among the finished builds").toBe(false);
  expect(box.run("/bin/mkdir", [path.join(w.built, "idea_planted")]).status, "make a folder among the finished builds").not.toBe(0);
  expect(box.canRun(w.programs.inBuilt), "run a program in a finished build").toBe(false);
  // Moving: a finished build away, the whole folder away, or a workspace of its own in.
  expect(box.canMove(sealed, path.join(w.workspace, "taken")), "move a finished build into the workspace").toBe(false);
  expect(box.canMove(sealed, path.join(w.built, "idea_renamed")), "rename a finished build").toBe(false);
  expect(box.canMove(w.built, path.join(w.buildTmp, "built-moved")), "move the folder itself").toBe(false);
  expect(box.canMove(path.join(w.workspace, "brief.md"), path.join(sealed, "dist", "brief.md")), "move a file of its own into a finished build").toBe(false);
  expect(box.run("/bin/rm", ["-rf", sealed]).status === 0 && !existsSync(sealed), "remove a finished build").toBe(false);
  expect(box.run("/bin/ln", ["-s", w.workspace, path.join(w.built, "idea_linked")]).status, "put a link among the finished builds").not.toBe(0);
  expect(box.run("/bin/ln", [w.files.sealedApp, path.join(w.workspace, "hard-app")]).status, "hard-link the finished app into the workspace").not.toBe(0);
  box.run("/bin/ln", ["-s", w.files.sealedApp, path.join(w.workspace, "soft-app")]);
  expect(box.canRead(path.join(w.workspace, "soft-app")), "read the finished app through a link").toBe(false);
  // Nothing changed.
  expect(readFileSync(w.files.sealedApp, "utf8")).toBe(DECOY);
  expect(readdirSync(w.built).sort()).toEqual([BUILT_MARKER_FILE, "idea_sealed"]);
  expect(existsSync(w.files.brief)).toBe(true);
}

/** A made-up folder named like Claude Code's scratch folders, with a decoy in it. Removed after the test. */
function claudeScratch(): { dir: string; file: string } {
  const dir = `/private/tmp/claude-9${String(process.pid).padStart(7, "0")}`;
  const file = path.join(dir, "scratchpad", "changed.out");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, DECOY);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
}

function expectClaudeScratchClosed(w: World, box: Inside, profileFile: string): void {
  const scratch = claudeScratch();
  expect(readFileSync(scratch.file, "utf8")).toBe(DECOY);
  expect(box.canRead(scratch.file)).toBe(false);
  expect(box.canSee(scratch.file)).toBe(false);
  expect(box.canList(scratch.dir)).toBe(false);
  expect(box.canWrite(path.join(scratch.dir, "planted.txt"))).toBe(false);
  expect(box.canRun(scratch.file)).toBe(false);
  // Even a later rule that opens all of /private/tmp, or names the folder itself, would have to
  // come AFTER the refusal to win. A copy with such a rule placed where the allow lists are shows
  // the refusal survives: it is the last word on these paths.
  const text = readFileSync(profileFile, "utf8");
  const marker = ";; 4. Writing:";
  expect(text).toContain(marker);
  const copy = path.join(w.root, `opened-early-${path.basename(profileFile)}`);
  writeFileSync(copy, text.replace(marker, `(allow file-read* file-write* process-exec* (subpath "/private/tmp") (subpath (string-append (param "HOME") "/.claude")))\n${marker}`));
  const args = ["-f", copy, ...profileParams(text).flatMap((name) => ["-D", `${name}=${{ HOME: w.home, WORKSPACE: w.workspace, DATA_DIR: w.data, REPO: w.repo, NODE_DIR: w.nodeDir, NPM_CACHE: w.npmCache, KIRO_HOME: w.kiroHome, CREW_HOME: w.crewHome }[name]}`])];
  const early = (command: string, file: string) => spawnSync("/usr/bin/sandbox-exec", [...args, command, file], { cwd: w.workspace, encoding: "utf8", timeout: 15_000 }).status === 0;
  expect(early("/bin/cat", scratch.file)).toBe(false);
  expect(early("/bin/cat", w.files.claudeSession)).toBe(false);
  expect(early("/usr/bin/touch", path.join(scratch.dir, "planted.txt"))).toBe(false);
}

describe("the sandbox profiles: what they say", () => {
  it("start from allow-default, and ask only for values the installer and the builder can fill", () => {
    for (const profile of [GATEWAY, KIRO]) {
      expect(profile).toMatch(/^\(version 1\)\n\(allow default\)$/m);
      for (const name of profileParams(profile)) expect(SANDBOX_VALUE_NAMES, name).toContain(name);
    }
    expect(profileParams(GATEWAY).sort()).toEqual(["CREW_HOME", "DATA_DIR", "HOME", "KIRO_HOME", "NODE_DIR", "NPM_CACHE", "REPO"]);
    expect(profileParams(KIRO).sort()).toEqual(["DATA_DIR", "HOME", "NODE_DIR", "NPM_CACHE", "REPO", "WORKSPACE"]);
    // The build jobs' temporary folder is worked out from the data folder inside the profile:
    // the installer's TMPDIR value is the account's shared one, which is not what is opened.
    for (const profile of [GATEWAY, KIRO]) expect(profile).toContain('(define build-tmp (data-path "/tmp/build"))');
  });

  it("refuse reading and running in the home folder, the data folder, the repo, the Node.js install, other disks and the shared temporary folders, before anything is allowed", () => {
    for (const profile of [GATEWAY, KIRO]) {
      const deny = profile.indexOf(
        '(deny file-read* process-exec*\n  (subpath home)\n  (subpath data-dir)\n  (subpath (home-path "/.overnight"))\n  (subpath repo)\n  (subpath node-dir)\n  (subpath "/Volumes")\n  (subpath "/Users/Shared")\n  (subpath "/private/tmp")\n  (subpath "/private/var/tmp")\n  (subpath "/private/var/folders"))',
      );
      expect(deny).toBeGreaterThan(0);
      expect(profile.indexOf('(deny file-read* (literal "/Users"))')).toBeGreaterThan(deny);
      expect(profile.indexOf("(allow file-read*")).toBeGreaterThan(deny);
      expect(profile.indexOf("(allow-traverse ", deny)).toBeGreaterThan(deny);
    }
  });

  it("refuse writing in the same places and where programs are installed, before anything is allowed", () => {
    for (const profile of [GATEWAY, KIRO]) {
      const deny = profile.indexOf(
        '(deny file-write*\n  (subpath home)\n  (subpath data-dir)\n  (subpath (home-path "/.overnight"))\n  (subpath repo)\n  (subpath node-dir)\n  (subpath "/Applications")\n  (subpath "/Library")\n  (subpath "/opt")\n  (subpath "/usr/local")\n  (subpath "/Users/Shared")\n  (subpath "/Volumes")\n  (subpath "/private/tmp")\n  (subpath "/private/var/tmp")\n  (subpath "/private/var/folders"))',
      );
      expect(deny).toBeGreaterThan(0);
      expect(profile.indexOf("(allow file-write*")).toBeGreaterThan(deny);
    }
  });

  it("name every protected place again after the allow rules, so a later allow cannot open one by mistake", () => {
    for (const profile of [GATEWAY, KIRO]) {
      const last = profile.slice(profile.indexOf(";; 7. Never writable"));
      for (const rule of [
        '(subpath (home-path "/.local"))',
        "(subpath node-dir)",
        '(subpath "/Applications")',
        '(subpath (home-path "/.kiro/crew-venv"))',
        '(literal (home-path "/.kiro/crew-venv-current"))',
        '(subpath (home-path "/.kiro/crew-python"))',
        '(subpath (home-path "/.kiro/settings"))',
        '(subpath (home-path "/Library/Application Support/kiro-cli/shell"))',
        "(subpath repo)",
        '(subpath (home-path "/Library/LaunchAgents"))',
        '(literal (home-path "/.zshenv"))',
        '(literal (home-path "/.zshrc"))',
        '(literal (home-path "/.zprofile"))',
        '(literal (home-path "/.bash_profile"))',
        '(literal (home-path "/.bashrc"))',
        '(literal (home-path "/.profile"))',
        '(literal (home-path "/.gitconfig"))',
        '(subpath (home-path "/.config"))',
      ]) {
        expect(last, rule).toContain(rule);
      }
      // Sections 3 and 5 are the only places a file rule opens anything outside the data folder.
      expect(profile.indexOf(";; 7. Never writable")).toBeGreaterThan(profile.indexOf(";; 5. ... except what a build needs."));
    }
  });

  it("close all of the data folder, the usual one too, and the logins, after the allow lists", () => {
    for (const profile of [GATEWAY, KIRO]) {
      const data = profile.indexOf('(deny file-read* file-write* process-exec*\n  (subpath (home-path "/.overnight"))\n  (subpath data-dir))');
      expect(data).toBeGreaterThan(profile.indexOf(";; 5. ... except what a build needs."));
      const logins = profile.slice(profile.indexOf(";; 6. Logins"), profile.indexOf(";; 7. Never writable"));
      expect(logins).toContain("(deny file-read* file-write* process-exec*");
      for (const rule of ['(subpath (home-path "/.ssh"))', '(subpath (home-path "/.aws"))', '(subpath (home-path "/.config/gh"))', '(subpath (home-path "/Library/Keychains"))', '(literal (string-append repo "/.env"))', '(literal (home-path "/.local/bin/gh"))']) {
        expect(logins, rule).toContain(rule);
      }
    }
  });

  it("refuse Claude Code's session records and scratch folders last of all the file rules", () => {
    for (const profile of [GATEWAY, KIRO]) {
      const rule = '(deny file-read* file-write* process-exec*\n  (regex #"^/private/tmp/claude-[0-9]+(/|$)")\n  (subpath (home-path "/.claude"))';
      const at = profile.indexOf(rule);
      expect(at).toBeGreaterThan(0);
      // Nothing after it allows a file to be read, run, written or looked at.
      const after = profile.slice(at + rule.length);
      expect(after).not.toMatch(/\(allow file-|\(allow process-exec|\(allow-traverse|\(allow-open-above/);
    }
  });

  it("cut the ways out, signals to other programs, looking at other programs, the Keychain, the clipboard, the preferences service and the ssh agent", () => {
    for (const profile of [GATEWAY, KIRO]) {
      for (const rule of [
        "(deny lsopen)",
        "(deny appleevent-send)",
        "(deny job-creation)",
        '(deny process-exec* (literal "/bin/launchctl"))',
        "(deny signal)\n(allow signal (target same-sandbox))",
        '(deny process-info*)\n(allow process-info* (target same-sandbox))\n(deny sysctl-read (sysctl-name-prefix "kern.procargs"))\n(deny mach-lookup (global-name "com.apple.sysmond"))',
        '(global-name "com.apple.SecurityServer")',
        '(global-name "com.apple.securityd")',
        '(global-name "com.apple.pasteboard.1")',
        '(global-name "com.apple.cfprefsd.agent")',
        '(global-name "com.apple.cfprefsd.daemon")',
        "(deny network-outbound\n  (remote unix-socket (path-regex",
      ]) {
        expect(profile, rule).toContain(rule);
      }
      const rules = profile.replace(/^\s*;;.*$/gm, "");
      // The one-line form loads but stops nothing on this macOS: it must not be what the profile relies on.
      expect(rules).not.toContain("(deny signal (target others))");
      // The exact name alone does not stop the read (measured): the rule has to be the prefix.
      expect(rules).not.toContain('(sysctl-name "kern.procargs2")');
    }
  });

  it("no longer say that other programs' command lines cannot be hidden", () => {
    expect(KIRO).not.toMatch(/no sandbox rule tried on this macOS hides them/);
    expect(KIRO).toMatch(/Other programs cannot be listed, looked at or signalled, and their command lines cannot be\s*\n;;\s+read/);
    expect(KIRO).toContain("detector");
    expect(GATEWAY).toMatch(/their command lines cannot be\s*\n;;\s+read/);
  });

  it("let Kiro Crew write only its own agent files, by name", () => {
    expect(GATEWAY).toContain('(regex (string-append "^" (regex-quote (kiro-path "/agents")) "/\\\\.?kirocrew[^/]*(/|$)"))');
    expect(GATEWAY).toContain('(regex (string-append "^" (regex-quote (kiro-path "/agents")) "/tmp[a-z0-9_]+\\\\.tmp$"))');
    expect(GATEWAY).not.toContain('(below (home-path "/.kiro/agents"))');
    expect(GATEWAY).not.toContain('(below (kiro-path "/agents"))');
  });

  it("open the folders above Kiro Crew's own only in the gateway profile, and say why", () => {
    expect(GATEWAY).toContain("(allow-open-above crew-home)");
    expect(GATEWAY).toContain("cannot verify that macOS");
    expect(KIRO).not.toContain("allow-open-above");
  });
});

describe.skipIf(!canSandbox)("the Kiro CLI build profile, run for real on a made-up home", () => {
  for (const layout of ["split", "usual"] as const) {
    it(`fences the build in (${layout === "usual" ? "data folder inside the home folder" : "data folder elsewhere"})`, () => {
      const w = world(layout);
      const loaded = w.kiro.run("/bin/cat", [w.files.brief]);
      expect(loaded.stderr).toBe("");
      expect(loaded.stdout).toBe(DECOY);
      expectCommonFence(w, w.kiro);

      // The home folder itself cannot be listed, nor the folder it is in, nor /Users.
      expect(w.kiro.canList(w.home)).toBe(false);
      expect(w.kiro.canList(w.root)).toBe(false);
      expect(w.kiro.canList("/Users")).toBe(false);
      expect(w.kiro.canList(tmpdir())).toBe(false);
      // This build's workspace is the only folder of Overnight's it can see or write.
      expect(w.kiro.canRead(w.files.otherWorkspace)).toBe(false);
      expect(w.kiro.canWrite(w.files.otherWorkspace)).toBe(false);
      expect(w.kiro.canWrite(path.join(w.data, "workspaces", "idea_new", "x"))).toBe(false);
      expect(w.kiro.canList(path.join(w.data, "workspaces"))).toBe(false);
      expect(w.kiro.canWrite(path.join(w.probe, "x.txt"))).toBe(false);
      expect(w.kiro.canList(w.probe)).toBe(false);
      expect(w.kiro.canRun(w.programs.inProbe)).toBe(false);
      // Nothing in the folder kirocrew is started from, and nothing of Kiro Crew's: not its home,
      // not its program, not the folder it runs agents in.
      expect(w.kiro.canRun(path.join(w.home, ".local", "bin", "kirocrew"))).toBe(false);
      expect(w.kiro.canRun(path.join(w.home, ".local", "bin", "other-tool"))).toBe(false);
      expect(w.kiro.canList(path.join(w.home, ".local", "bin"))).toBe(false);
      expect(w.kiro.canRead(w.files.crewConfig)).toBe(false);
      expect(w.kiro.canWrite(w.files.crewConfig)).toBe(false);
      expect(w.kiro.canRead(w.files.installedSkill)).toBe(false);
      expect(w.kiro.canWrite(w.files.installedSkill)).toBe(false);
      expect(w.kiro.canRead(w.files.kirocrew)).toBe(false);
      expect(w.kiro.canRead(w.files.crewRun)).toBe(false);
      expect(w.kiro.canRead(path.join(w.kiroHome, "crew-auth-staging", "x"))).toBe(false);
      expect(w.kiro.canWrite(path.join(w.home, "workplace", "kirocrew-workspace", "x"))).toBe(false);
      // The agent files it shares with Kiro CLI can be read (Kiro CLI loads them), never written.
      expect(w.kiro.canRead(w.files.crewAgent)).toBe(true);
      expect(w.kiro.canWrite(w.files.crewAgent)).toBe(false);
      expect(w.kiro.canWrite(path.join(w.kiroHome, "agents", "kirocrew-new.json"))).toBe(false);
    }, FENCE_TEST_TIMEOUT_MS);
  }

  it("does not let a build move its own workspace away and put a link in its place", () => {
    const w = world();
    expect(w.kiro.canMove(w.workspace, path.join(w.buildTmp, "moved-away"))).toBe(false);
    expect(w.kiro.canMove(w.workspace, path.join(w.workspace, "..", "idea_moved"))).toBe(false);
    expect(w.kiro.run("/bin/rmdir", [w.workspace]).status).not.toBe(0);
    expect(w.kiro.run("/bin/chmod", ["777", w.workspace]).status).not.toBe(0);
    expect(existsSync(w.files.brief)).toBe(true);
    // Inside it, everything works: files, folders, renames, deletes.
    const worked = w.kiro.run("/bin/sh", ["-c", `mkdir -p "${w.workspace}/dist" && echo x > "${w.workspace}/dist/index.html" && mv "${w.workspace}/dist" "${w.workspace}/dist2" && rm -r "${w.workspace}/dist2" && echo done`]);
    expect(worked.stdout).toBe("done\n");
  });

  for (const layout of ["split", "usual"] as const) {
    it(`keeps finished builds out of a build's reach: not read, listed, written, run or moved (${layout === "usual" ? "data folder inside the home folder" : "data folder elsewhere"})`, () => {
      const w = world(layout);
      expectFinishedBuildsClosed(w, w.kiro);
    });
  }

  it("does not let a build reach other programs or the services it has no business with", () => {
    expectNoReachingOut(world().kiro);
  });

  it("hides other programs' command lines: read directly, and through pgrep", () => {
    const w = world();
    expectOtherProgramsHidden(w, w.kiro, KIRO_CLI_SANDBOX_PROFILE);
  });

  it("keeps Claude Code's scratch folders and session records closed, whatever else is opened", () => {
    const w = world();
    expectClaudeScratchClosed(w, w.kiro, KIRO_CLI_SANDBOX_PROFILE);
  });

  it("refuses to start anything when a value is missing", () => {
    const w = world();
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", KIRO_CLI_SANDBOX_PROFILE, "-D", `WORKSPACE=${w.workspace}`, "-D", `HOME=${w.home}`, "-D", `DATA_DIR=${w.data}`, "-D", `REPO=${w.repo}`, "/usr/bin/true"], { encoding: "utf8", timeout: 15_000 });
    expect(result.status).not.toBe(0);
  });
});

describe.skipIf(!canSandbox)("the Kiro Crew gateway profile, run for real on a made-up home", () => {
  for (const layout of ["split", "usual"] as const) {
    it(`fences the gateway and its jobs in (${layout === "usual" ? "data folder inside the home folder" : "data folder elsewhere"})`, () => {
      const w = world(layout);
      const loaded = w.gateway.run("/bin/cat", [w.files.brief]);
      expect(loaded.stderr).toBe("");
      expect(loaded.stdout).toBe(DECOY);
      expectCommonFence(w, w.gateway);

      // The three folders a job works in. Every workspace is open: one profile covers every job
      // the gateway starts, so it cannot tell this build's workspace from another idea's.
      expect(w.gateway.canList(path.join(w.data, "workspaces"))).toBe(true);
      expect(w.gateway.canRead(w.files.otherWorkspace)).toBe(true);
      expect(w.gateway.canWrite(w.files.otherWorkspace)).toBe(true);
      expect(w.gateway.canWrite(path.join(w.probe, "keychain.txt"))).toBe(true);
      expect(w.gateway.canMove(w.probe, path.join(w.workspace, "probe"))).toBe(false);
      // The probe's copy of the Bee program can be run from its results folder.
      expect(w.gateway.canRun(w.programs.inProbe)).toBe(true);
      // Kiro Crew's own state, and its program (read and run, never written).
      expect(w.gateway.canRead(w.files.crewConfig)).toBe(true);
      expect(w.gateway.canWrite(w.files.crewConfig)).toBe(true);
      expect(w.gateway.canRead(w.files.installedSkill)).toBe(true);
      expect(w.gateway.canWrite(path.join(w.crewHome, "crons.json"))).toBe(true);
      expect(w.gateway.canRead(w.files.kirocrew)).toBe(true);
      expect(w.gateway.canWrite(path.join(w.kiroHome, "crew-auth-staging", "x"))).toBe(true);
      expect(w.gateway.canRead(w.files.crewRun)).toBe(true);
      expect(w.gateway.canWrite(path.join(w.home, "workplace", "kirocrew-workspace", "cron_x"))).toBe(true);
      expect(w.gateway.canWrite(path.join(w.home, "workplace", "planted"))).toBe(false);
      // In the folder kirocrew is started from, only the links to Kiro's own programs can be used.
      const bin = path.join(w.home, ".local", "bin");
      expect(w.gateway.canRun(path.join(bin, "kirocrew")), "run kirocrew through its link").toBe(true);
      expect(spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/sh", "-c", `PATH="${bin}:/usr/bin:/bin" kirocrew`], { encoding: "utf8" }).stdout).toBe("ran\n");
      expect(w.gateway.run("/bin/sh", ["-c", `PATH="${bin}:/usr/bin:/bin" kirocrew`]).stdout, "find kirocrew through the PATH").toBe("ran\n");
      expect(w.gateway.canRun(path.join(bin, "other-tool")), "run another tool installed there").toBe(false);
      expect(w.gateway.canRead(path.join(bin, "other-tool"))).toBe(false);
      expect(w.gateway.run("/bin/sh", ["-c", `PATH="${bin}:/usr/bin:/bin" other-tool`]).stdout).toBe("");
      // A link there opens nothing by itself: what it points at must be open too.
      expect(w.gateway.canRun(path.join(bin, "kiro-cli")), "a link to a program in a closed folder").toBe(false);
      // Its home may be made private (Kiro Crew does that at every start), not moved or replaced.
      expect(w.gateway.run("/bin/chmod", ["700", w.crewHome]).status).toBe(0);
      expect(w.gateway.canMove(w.crewHome, path.join(w.workspace, "crew"))).toBe(false);
      expect(w.gateway.run("/bin/chmod", ["700", path.join(w.kiroHome, "agents")]).status).not.toBe(0);
    }, FENCE_TEST_TIMEOUT_MS);
  }

  it("lets Kiro Crew refresh its own agent files, and nobody add one under another name", () => {
    const w = world();
    const agents = path.join(w.kiroHome, "agents");
    // What Kiro Crew 0.8.0 writes there (seen at a real gateway start): its own .json files, each
    // through a temporary file made by Python's mkstemp, two lock files and two folders.
    for (const name of ["kirocrew.json", "kirocrew-lite.json", "kirocrew-skill-view-0395a0dfd188ea34aae611fd.json", "kirocrew.lock", ".kirocrew-agents.lock", ".kirocrew-skill-projection.lock", "tmpi63q5awz.tmp", "tmp_0a9zq_x.tmp"]) {
      expect(w.gateway.canWrite(path.join(agents, name)), name).toBe(true);
    }
    expect(w.gateway.canWrite(path.join(agents, ".kirocrew-skill-projection-metadata", "entry.json"))).toBe(true);
    expect(w.gateway.run("/bin/mkdir", [path.join(agents, ".kirocrew-skill-projection-leases")]).status).toBe(0);
    // The write-then-rename Kiro Crew does.
    expect(w.gateway.canMove(path.join(agents, "tmpi63q5awz.tmp"), path.join(agents, "kirocrew-guest.json"))).toBe(true);
    // Kiro CLI loads the .json files in this folder as agents: none of these may appear.
    for (const name of ["planted.json", "helper.json", "my-kirocrew.json", "tmp.json", "tmpi63q5awz.json", "tmpi63q5awz.tmp.json", "x-tmpabcdefgh.tmp", ".hidden.json"]) {
      expect(w.gateway.canWrite(path.join(agents, name)), name).toBe(false);
    }
    expect(w.gateway.run("/bin/mkdir", [path.join(agents, "sub")]).status).not.toBe(0);
    // A Kiro Crew file cannot be renamed to another name either, and the folder itself cannot be moved.
    expect(w.gateway.canMove(path.join(agents, "kirocrew.json"), path.join(agents, "planted.json"))).toBe(false);
    expect(w.gateway.canMove(agents, path.join(w.workspace, "agents"))).toBe(false);
    expect(existsSync(path.join(agents, "planted.json"))).toBe(false);
  });

  it("opens the folders above Kiro Crew's own, and nothing behind the names in them", () => {
    const w = world();
    // Kiro Crew will not start an agent unless it can open every folder above its own folder,
    // above the folder it runs the agent in, and above each folder on the PATH. Opening a folder
    // lets its names be listed: that much a job can see of the home folder.
    for (const dir of [w.home, w.kiroHome, path.join(w.home, "workplace"), path.join(w.home, ".local"), w.nodeDir, path.join(w.nodeDir, "bin"), path.join(w.home, ".local", "bin")]) {
      expect(w.gateway.canList(dir), `list ${dir}`).toBe(true);
    }
    const names = w.gateway.run("/bin/ls", ["-a", w.home]).stdout.split("\n");
    expect(names).toContain("Documents");
    expect(names).toContain(".claude");
    // The names, and no more: what they stand for cannot be looked at, listed, read or run.
    for (const name of ["Documents", "Desktop", "Library", ".claude", ".ssh", ".config"]) {
      expect(w.gateway.canList(path.join(w.home, name)), `list ${name}`).toBe(false);
      expect(w.gateway.canSee(path.join(w.home, name, "anything")), `look inside ${name}`).toBe(false);
    }
    expect(w.gateway.canSee(w.files.homeFile)).toBe(false);
    expect(w.gateway.canSee(w.files.zshenv)).toBe(false);
    expect(w.gateway.canRead(w.files.homeFile)).toBe(false);
    // In Node's bin folder the Bee command's name shows; the command cannot be looked at or run.
    expect(w.gateway.run("/bin/ls", [path.join(w.nodeDir, "bin")]).stdout.split("\n")).toContain("bee");
    expect(w.gateway.canSee(w.files.globalBee)).toBe(false);
    expect(w.gateway.canRun(w.files.globalBee)).toBe(false);
    // Folders that are not above one of Kiro Crew's stay closed.
    expect(w.gateway.canList(path.join(w.home, "Library", "Application Support"))).toBe(false);
    expect(w.gateway.canList(path.join(w.nodeDir, "lib"))).toBe(false);
  });

  for (const layout of ["split", "usual"] as const) {
    it(`keeps finished builds out of a job's reach: not read, listed, written, run or moved (${layout === "usual" ? "data folder inside the home folder" : "data folder elsewhere"})`, () => {
      const w = world(layout);
      expectFinishedBuildsClosed(w, w.gateway);
    });
  }

  it("a workspace a job could read and change is out of its reach the moment Overnight has sealed it", () => {
    const w = world("usual");
    // Another idea's workspace: one profile covers every job, so this job can read and change it.
    expect(w.gateway.canRead(w.files.otherWorkspace)).toBe(true);
    expect(w.gateway.run("/bin/sh", ["-c", `echo changed-by-a-job >> "${w.files.otherWorkspace}"`]).status).toBe(0);
    const before = readFileSync(w.files.otherWorkspace, "utf8");

    // Our own code, outside the sandbox: the one rename the night flow does when an idea is built.
    const sealed = sealWorkspace({ paths: dataPaths(w.data), ideaId: "idea_other", now: new Date("2026-10-10T07:40:00.000Z") });
    expect(sealed).toEqual({ ok: true, dir: path.join(w.built, "idea_other"), movedAside: null });

    const app = path.join(w.built, "idea_other", "index.html");
    expect(w.gateway.canRead(app)).toBe(false);
    expect(w.gateway.canSee(app)).toBe(false);
    expect(w.gateway.canWrite(app)).toBe(false);
    expect(w.gateway.run("/bin/sh", ["-c", `echo changed-again >> "${app}"`]).status).not.toBe(0);
    expect(w.gateway.canMove(path.join(w.built, "idea_other"), path.join(w.data, "workspaces", "idea_other"))).toBe(false);
    // What a job leaves under the old name does not come along either: it stays a workspace.
    expect(w.gateway.run("/bin/mkdir", [path.join(w.data, "workspaces", "idea_other")]).status).toBe(0);
    expect(readFileSync(app, "utf8")).toBe(before);
  });

  it("does not let a job reach other programs or the services it has no business with", () => {
    expectNoReachingOut(world().gateway);
  });

  it("hides other programs' command lines: read directly, and through pgrep", () => {
    const w = world();
    expectOtherProgramsHidden(w, w.gateway, CREW_GATEWAY_SANDBOX_PROFILE);
  });

  it("keeps Claude Code's scratch folders and session records closed, whatever else is opened", () => {
    const w = world();
    expectClaudeScratchClosed(w, w.gateway, CREW_GATEWAY_SANDBOX_PROFILE);
  });

  it("refuses to start anything when a value is missing", () => {
    const w = world();
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", CREW_GATEWAY_SANDBOX_PROFILE, "-D", `HOME=${w.home}`, "-D", `DATA_DIR=${w.data}`, "-D", `REPO=${w.repo}`, "/usr/bin/true"], { encoding: "utf8", timeout: 15_000 });
    expect(result.status).not.toBe(0);
  });
});

describe.skipIf(!canSandbox)("the nightly probe's own command, run for real inside the gateway profile on a made-up home", () => {
  /**
   * Run the probe's command line the way a Kiro Crew command job would, and judge what it left
   * the way the check does: the job's marks, and our own look for its test files afterwards.
   */
  function runProbe(w: World, box: Inside) {
    const dirs = { home: w.home, repo: w.repo, node: path.join(w.nodeDir, "bin"), kirocrew: path.join(w.kiroHome, "crew-venv", "bin") };
    for (const name of ["keychain.txt", "bee.txt", "database.txt", "processes.txt", "finished.txt", ...[...LIST_TESTS, ...WRITE_TESTS, ...BUILT_TESTS].map((test) => test.file)]) {
      rmSync(path.join(w.probe, name), { force: true });
    }
    // The stand-in for the Bee program answers as Bee does when it cannot get at its login.
    writeFileSync(path.join(w.probe, BEE_COPY), "#!/bin/sh\necho 'not logged in: made up' >&2\nexit 1\n");
    const command = probeCommand({
      dir: w.probe,
      beeBinary: path.join(w.probe, BEE_COPY),
      database: w.files.database,
      listTargets: listTestTargets(w.home),
      writeTargets: writeTestTargets(dirs),
      built: w.built,
    });
    expect(command).not.toBeNull();
    const ran = box.run("/bin/sh", ["-c", command ?? "exit 9"]);
    expect(ran.error).toBeUndefined();
    return judgeProbe(w.probe, takeMadeFiles(writeTries(dirs, w.built)));
  }

  it("passes under the shipped profile: three reads, three lists, the look at other programs, five writes and the two tries at the finished builds all refused", () => {
    const w = world("usual");
    const decoy = startDecoy();
    expect(decoy).not.toBeNull();
    cleanups.push(() => decoy?.stop());
    // The stand-in really is there to be found, from outside.
    expect(spawnSync("/usr/bin/pgrep", ["-f", DECOY_PATTERN], { encoding: "utf8" }).stdout.trim()).not.toBe("");
    expect(runProbe(w, w.gateway)).toEqual({ ok: true });
    // The files it left are counts and marks: 0 everywhere, nothing else.
    const marks = ["keychain.txt", "bee.txt", "processes.txt", "list-documents.txt", "list-library.txt", "list-claude.txt", "write-home.txt", "write-repo.txt", "write-node.txt", "write-kirocrew.txt", "write-launch-agents.txt", "list-built.txt", "write-built.txt"];
    for (const name of marks) expect(readFileSync(path.join(w.probe, name), "utf8").trim(), name).toBe("0");
    expect(readFileSync(path.join(w.probe, "database.txt"), "utf8")).toBe("");
    // Fourteen things were tried, and nothing was left behind among the finished builds.
    expect(marks.length + 1).toBe(14);
    expect(readdirSync(w.built).sort()).toEqual([BUILT_MARKER_FILE, "idea_sealed"]);
    expect(DECOY_MARK).toMatch(new RegExp(DECOY_PATTERN));
  });

  // The control: each new line of the probe fails on a copy of the profile that is loosened in
  // exactly that one way, and names what a job can now reach.
  const loosenings: Array<{ what: string; rules: (w: World) => string; said: string }> = [
    ...LIST_TESTS.map((test) => ({ what: `the ${test.folder} folder can be listed`, rules: () => `(allow file-read* (subpath (string-append (param "HOME") "/${test.folder}")))`, said: test.said })),
    {
      what: "other programs can be looked at",
      rules: () => '(allow process-info*)\n(allow sysctl-read)\n(allow mach-lookup (global-name "com.apple.sysmond"))',
      said: "a job can read the command lines of other programs",
    },
    { what: "the finished builds can be listed", rules: () => '(allow file-read* (subpath (string-append (param "DATA_DIR") "/built")))', said: BUILT_TESTS[0].said },
    // Opened for writing only: the job's own mark says 0 here, and it is our look afterwards that catches it.
    { what: "a file can be made among the finished builds", rules: () => '(allow file-write* (subpath (string-append (param "DATA_DIR") "/built")))', said: BUILT_TESTS[1].said },
    {
      what: "the finished builds can be listed and written",
      rules: () => '(allow file-read* file-write* (subpath (string-append (param "DATA_DIR") "/built")))',
      said: `${BUILT_TESTS[0].said}, ${BUILT_TESTS[1].said}`,
    },
  ];
  for (const loosening of loosenings) {
    it(`fails on a copy of the profile in which ${loosening.what}`, () => {
      const w = world("usual");
      const decoy = startDecoy();
      cleanups.push(() => decoy?.stop());
      const loose = w.loosened(CREW_GATEWAY_SANDBOX_PROFILE, loosening.rules(w));
      expect(runProbe(w, loose)).toEqual({ ok: false, reason: `the build sandbox check failed: ${loosening.said}` });
      // The same world under the shipped profile passes: the loosening is the only difference.
      expect(runProbe(w, w.gateway)).toEqual({ ok: true });
    });
  }

  it("catches a fence opened for writing only, where the job's own marks all say 0, and leaves no test file behind", () => {
    const w = world("usual");
    const decoy = startDecoy();
    cleanups.push(() => decoy?.stop());
    // Everything in the home folder can be written again, and still nothing in it can be looked at.
    const loose = w.loosened(CREW_GATEWAY_SANDBOX_PROFILE, '(allow file-write* (subpath (param "HOME")))');
    const dirs = { home: w.home, repo: w.repo, node: path.join(w.nodeDir, "bin"), kirocrew: path.join(w.kiroHome, "crew-venv", "bin") };
    const tries = writeTries(dirs, w.built);

    const result = runProbe(w, loose);
    // Where the job may not look, it could not tell: `touch` made the file and still ended with
    // an error, so the mark says 0. Only Kiro Crew's program folder, which a job may read, says 1.
    for (const test of [...WRITE_TESTS, BUILT_TESTS[1]]) expect(readFileSync(path.join(w.probe, test.file), "utf8").trim(), test.file).toBe(test.file === "write-kirocrew.txt" ? "1" : "0");
    expect(judgeProbe(w.probe)).toEqual({ ok: false, reason: "the build sandbox check failed: a job can write where Kiro Crew is installed" });
    // Our own look afterwards could: every write test is named, the one among the finished builds too.
    expect(result).toEqual({ ok: false, reason: `the build sandbox check failed: ${tries.map((entry) => entry.said).join(", ")}` });
    expect(tries).toHaveLength(6);
    for (const entry of tries) expect(existsSync(entry.file), entry.file).toBe(false);
    // The same world under the shipped profile passes.
    expect(runProbe(w, w.gateway)).toEqual({ ok: true });
  });

  it("needs its marker file: an empty folder lists as nothing, with or without a fence", () => {
    const w = world("usual");
    const decoy = startDecoy();
    cleanups.push(() => decoy?.stop());
    const loose = w.loosened(CREW_GATEWAY_SANDBOX_PROFILE, '(allow file-read* (subpath (string-append (param "DATA_DIR") "/built")))');
    // With only the marker in it, the opened folder is still caught ...
    rmSync(path.join(w.built, "idea_sealed"), { recursive: true });
    expect(runProbe(w, loose)).toEqual({ ok: false, reason: `the build sandbox check failed: ${BUILT_TESTS[0].said}` });
    expect(readFileSync(path.join(w.probe, "list-built.txt"), "utf8").trim()).toBe("1");
    // ... and without it the same opened folder would have passed. That is what the marker is for.
    rmSync(w.files.builtMarker);
    expect(runProbe(w, loose)).toEqual({ ok: true });
  });

  it("fails on a copy in which the whole home folder can be read again, naming every list test", () => {
    const w = world("usual");
    const decoy = startDecoy();
    cleanups.push(() => decoy?.stop());
    const loose = w.loosened(CREW_GATEWAY_SANDBOX_PROFILE, '(allow file-read* (subpath (param "HOME")))');
    const result = runProbe(w, loose);
    expect(result.ok).toBe(false);
    if (!result.ok) for (const test of LIST_TESTS) expect(result.reason).toContain(test.said);
  });
});

// The real tools, to print their version and nothing else. The home folder here is the real one,
// so only exit codes are looked at: nothing a command prints about it is kept or shown.
const realHome = realpathSync(homedir());
const realNodeDir = path.dirname(path.dirname(realpathSync(process.execPath)));
const realNpm = path.join(realNodeDir, "bin", "npm");
const realKirocrew = path.join(realHome, ".local", "bin", "kirocrew");
const realKiro = [path.join(realHome, ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli"].find((candidate) => existsSync(candidate));

describe.skipIf(!canSandbox || !existsSync(realNpm))("the real node and npm, started inside each profile", () => {
  /** A scratch data folder and made-up Kiro folders; the home folder, the Node.js install and npm's cache are the real ones. */
  function realWorld() {
    const root = tempDir("overnight-sandbox-real-");
    const data = path.join(root, "data");
    const workspace = path.join(data, "workspaces", ID);
    const kiroHome = path.join(root, "kiro");
    const crewHome = path.join(kiroHome, "crew");
    for (const dir of [workspace, path.join(data, "tmp", "build"), path.join(data, "tmp", "build-probe"), crewHome, path.join(kiroHome, "agents")]) mkdirSync(dir, { recursive: true });
    const given: Record<string, string> = {
      HOME: realHome,
      WORKSPACE: workspace,
      DATA_DIR: data,
      REPO: realpathSync(path.resolve(import.meta.dirname, "..", "..", "..")),
      NODE_DIR: realNodeDir,
      NPM_CACHE: path.join(realHome, ".npm"),
      KIRO_HOME: kiroHome,
      CREW_HOME: crewHome,
    };
    const run = (profileFile: string, command: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync("/usr/bin/sandbox-exec", ["-f", profileFile, ...profileParams(readFileSync(profileFile, "utf8")).flatMap((name) => ["-D", `${name}=${given[name]}`]), command, ...args], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 60_000,
        env: { HOME: realHome, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.join(realNodeDir, "bin")}:${path.join(realHome, ".local", "bin")}`, TMPDIR: path.join(data, "tmp", "build"), NO_COLOR: "1", ...env },
      });
    return { root, data, workspace, kiroHome, crewHome, run };
  }

  for (const [label, profileFile] of [
    ["the gateway profile", CREW_GATEWAY_SANDBOX_PROFILE],
    ["the Kiro CLI profile", KIRO_CLI_SANDBOX_PROFILE],
  ] as const) {
    it(`node and npm start inside ${label}, found through the PATH, and work in the workspace`, () => {
      const w = realWorld();
      const node = w.run(profileFile, "/bin/sh", ["-c", "node -e 'require(\"fs\").writeFileSync(\"made.txt\", String(1 + 1)); console.log(require(\"os\").tmpdir())'"]);
      expect(node.status).toBe(0);
      // Node's temporary folder is the build's own.
      expect(node.stdout.trim()).toBe(path.join(w.data, "tmp", "build"));
      expect(readFileSync(path.join(w.workspace, "made.txt"), "utf8")).toBe("2");
      const npm = w.run(profileFile, "/bin/sh", ["-c", "npm --version"]);
      expect(npm.status).toBe(0);
      expect(npm.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(w.run(profileFile, "/bin/sh", ["-c", "npx --version"]).status).toBe(0);
    });

    it(`the real Documents, Library and Claude folders cannot be listed inside ${label}, and the GitHub program cannot be run`, () => {
      const w = realWorld();
      // Exit codes only: nothing these print is looked at.
      const status = (command: string, args: string[]) => w.run(profileFile, command, args).status;
      for (const name of ["Documents", "Library", "Desktop", "Downloads"]) expect(status("/bin/ls", [path.join(realHome, name)]), name).not.toBe(0);
      if (existsSync(path.join(realHome, ".claude"))) expect(status("/bin/ls", [path.join(realHome, ".claude")])).not.toBe(0);
      expect(status("/bin/ls", ["/private/tmp"])).not.toBe(0);
      expect(status("/bin/ls", ["/private/var/tmp"])).not.toBe(0);
      expect(status("/bin/ls", ["/Volumes"])).not.toBe(0);
      // This account's own temporary folder: closed too. (Not asked of the gateway profile here,
      // because this test keeps its made-up Kiro Crew folder IN that folder, and the profile opens
      // the folders above Kiro Crew's own. On a real install that is ~/.kiro, not a temporary folder.)
      if (profileFile === KIRO_CLI_SANDBOX_PROFILE) expect(status("/bin/ls", [tmpdir()])).not.toBe(0);
      // A file in a neighbouring temporary folder cannot be read by either.
      const neighbour = path.join(tempDir("overnight-sandbox-neighbour-"), "left-by-another-program.txt");
      writeFileSync(neighbour, DECOY);
      expect(status("/bin/cat", [neighbour])).not.toBe(0);
      expect(status("/usr/bin/touch", [path.join(path.dirname(neighbour), "planted.txt")])).not.toBe(0);
      const gh = path.join(realHome, ".local", "bin", "gh");
      if (existsSync(gh)) expect(status(gh, ["--version"])).not.toBe(0);
      // The repo this test is part of cannot be read from inside, not even this file.
      expect(status("/bin/cat", [realpathSync(import.meta.filename)])).not.toBe(0);
      // The home folder itself: closed for a Kiro CLI build; openable (names only) for Kiro Crew.
      expect(status("/bin/ls", [realHome]) === 0).toBe(profileFile === CREW_GATEWAY_SANDBOX_PROFILE);
      expect(status("/bin/ls", ["/Users"]) === 0).toBe(profileFile === CREW_GATEWAY_SANDBOX_PROFILE);
    });
  }

  it.skipIf(!existsSync(realKirocrew))("kirocrew starts inside the gateway profile, and not inside the Kiro CLI profile", () => {
    const w = realWorld();
    // Pointed at a made-up, empty Kiro Crew folder: the real one is never opened.
    const env = { KIROCREW_HOME: w.crewHome, KIRO_HOME: w.kiroHome, KIROCREW_PORT: "5479" };
    const inGateway = w.run(CREW_GATEWAY_SANDBOX_PROFILE, "/bin/sh", ["-c", "kirocrew --version"], env);
    expect(inGateway.status).toBe(0);
    expect(inGateway.stdout).toMatch(/^kirocrew \d+\.\d+/);
    // Nothing of Kiro Crew's can be read or run from a Kiro CLI build.
    expect(w.run(KIRO_CLI_SANDBOX_PROFILE, "/bin/sh", ["-c", "kirocrew --version"], env).status).not.toBe(0);
    expect(w.run(KIRO_CLI_SANDBOX_PROFILE, realpathSync(realKirocrew), ["--version"], env).status).not.toBe(0);
  });

  it.skipIf(realKiro === undefined)("kiro-cli starts inside each profile", () => {
    const w = realWorld();
    for (const profileFile of [CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE]) {
      const version = w.run(profileFile, realpathSync(realKiro ?? ""), ["--version"]);
      expect(version.status, path.basename(profileFile)).toBe(0);
      expect(version.stdout).toMatch(/^kiro-cli \d+\.\d+/);
    }
    // Found by name where the gateway's PATH has it.
    expect(w.run(CREW_GATEWAY_SANDBOX_PROFILE, "/bin/sh", ["-c", "kiro-cli --version"]).status).toBe(0);
  });
});
