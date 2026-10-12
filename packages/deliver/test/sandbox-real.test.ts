// Synthetic test data: every file these tests touch is a decoy made for the test.
// These tests start the REAL macOS sandbox with the profile we ship and ask it yes/no questions,
// the way the M2 experiments did by hand. Only shell built-ins and the system's own small tools
// run inside it. They are skipped where the macOS sandbox does not exist.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.ts";
import { SANDBOX_EXEC, sandboxCommand, sandboxEnv } from "../src/sandbox.ts";
import type { SandboxPlaces } from "../src/sandbox.ts";
import { tempDir, writeTree } from "./helpers.ts";

const PROFILE = fileURLToPath(new URL("../sandbox/deliver.sb", import.meta.url));

function sandboxWorks(): boolean {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return false;
  try {
    // Inside another sandbox (some CI runners, some editors) a second one cannot be started.
    execFileSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** A made-up Mac: a home folder, a data folder with one run in it, and a made-up Node install with a "bee" in it. */
function makeWorld() {
  const root = tempDir("overnight-sandbox-");
  const home = path.join(root, "home");
  const dataDir = path.join(home, ".overnight");
  const run = path.join(dataDir, "tmp", "deliver", "idea_1", "run-1");
  const build = path.join(run, "build");
  const contract = path.join(run, "contract");
  const nodeDir = path.join(home, ".local", "node-made-up");
  const script = (text: string) => `#!/bin/sh\necho ${text}\n`;
  writeTree(root, {
    "home/private-notes.txt": "made-up private text\n",
    "home/.overnight/overnight.db": "made-up database\n",
    "home/.overnight/tmp/deliver/idea_1/run-1/site/index.html": "<h1>made-up</h1>\n",
    "home/.overnight/tmp/deliver/idea_1/run-1/harness-contract/contract.spec.ts": "// made-up\n",
    "home/.overnight/tmp/deliver/idea_1/run-1/build/app/package.json": "{}\n",
    "home/.overnight/tmp/deliver/idea_1/run-1/build/scratch-1/tmp/.keep": "",
    "home/.overnight/tmp/deliver/idea_1/run-1/contract/work/.keep": "",
    "home/.overnight/tmp/deliver/idea_1/run-1/contract/scratch-2/tmp/.keep": "",
    "home/.local/node-made-up/bin/node": script("node-ran"),
    "home/.local/node-made-up/lib/node_modules/npm/bin/npm-cli.js": script("npm-ran"),
    "home/.local/node-made-up/lib/node_modules/@beeai/cli/bin/bee.js": script("bee-ran"),
    "home/.local/node-made-up/lib/node_modules/@beeai/cli/login.txt": "made-up login\n",
    "home/.local/node-made-up/include/node/node.h": "// made-up header\n",
    "home/tools/node_modules/@playwright/test/cli.js": "// made-up\n",
    "home/tools/node_modules/@beeai/cli/bee": script("repo-bee-ran"),
    "home/Library/Caches/ms-playwright/.keep": "",
    "home/.npm/_cacache/.keep": "",
  });
  for (const file of ["bin/node", "lib/node_modules/npm/bin/npm-cli.js", "lib/node_modules/@beeai/cli/bin/bee.js"]) chmodSync(path.join(nodeDir, file), 0o755);
  chmodSync(path.join(home, "tools/node_modules/@beeai/cli/bee"), 0o755);
  symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", path.join(nodeDir, "bin", "npm"));
  symlinkSync("../lib/node_modules/@beeai/cli/bin/bee.js", path.join(nodeDir, "bin", "bee"));
  mkdirSync(path.join(root, "outside"));

  const base = { home, dataDir, siteDir: path.join(run, "site"), harnessDir: path.join(run, "harness-contract"), nodeDir, toolsDir: path.join(home, "tools", "node_modules"), browsersDir: path.join(home, "Library", "Caches", "ms-playwright"), npmCache: path.join(home, ".npm") };
  const buildStep: SandboxPlaces = { ...base, workspace: path.join(build, "app"), runDir: path.join(build, "scratch-1") };
  const contractStep: SandboxPlaces = { ...base, workspace: path.join(contract, "work"), runDir: path.join(contract, "scratch-2") };

  /** Run a shell script inside the sandbox of one step and return its lines. */
  const ask = async (places: SandboxPlaces, script: string, cwd: string = places.workspace): Promise<string[]> => {
    const { command, args } = sandboxCommand(PROFILE, places, { port: null, proxyPort: null }, ["/bin/sh", "-c", script]);
    const result = await runCommand(command, args, { cwd, env: sandboxEnv(places), timeoutMs: 20_000 });
    if (result.error !== undefined || result.timedOut) throw new Error("The sandbox could not be started for the test.");
    return result.stdout.trim().split("\n");
  };
  return { root, home, dataDir, run, build, contract, nodeDir, buildStep, contractStep, ask };
}

const PERL = "/usr/bin/perl";
const PGREP = "/usr/bin/pgrep";

/**
 * Asks the operating system directly about one process, the way a program would that wants to
 * read other programs' command lines without ps or pgrep. Usage: reader.pl <pid> <marker> <what>.
 * - "args": sysctl kern.procargs2 for that process id (its whole command line).
 * - "old-args": the older sysctl kern.procargs.
 * - "path": which program it is (what libproc's proc_pidpath asks).
 * - "one": sysctl kern.proc.pid.<pid>, the process table's entry for that one process.
 * - "table": sysctl kern.proc.all, the whole process table (the process id is not used).
 * Prints "marker found", "read without the marker", "seen", "answered", "read" or "refused".
 * Never prints what it read.
 */
const READER = `# Synthetic test tool, made for one test. It only ever looks at decoy processes.
use strict; use warnings;
my ($pid, $marker, $what) = ($ARGV[0] + 0, $ARGV[1], $ARGV[2]);
if ($what eq "path") {
  # proc_info(PROC_INFO_CALL_PIDINFO = 2, pid, PROC_PIDPATHINFO = 11, 0, buffer, size) is system call 336.
  my $buf = "\\0" x 4096;
  my $rc = syscall(336, 2, $pid, 11, 0, $buf, 4096);
  my ($found) = unpack("Z*", $buf);
  print(($rc == 0 && length($found) > 0) ? "seen" : "refused", "\\n");
} elsif ($what eq "one" || $what eq "table") {
  # sysctl({ CTL_KERN = 1, KERN_PROC = 14, KERN_PROC_PID = 1, pid }) or ({ 1, 14, KERN_PROC_ALL = 0 }).
  my $mib = $what eq "one" ? pack("i4", 1, 14, 1, $pid) : pack("i3", 1, 14, 0);
  my $room = $what eq "one" ? 4096 : 8 << 20;
  my $size = pack("Q", $room);
  my $buf = "\\0" x $room;
  my $rc = syscall(202, $mib, $what eq "one" ? 4 : 3, $buf, $size, 0, 0);
  # An answer of at least one record. (A table too big for the room given would also count as readable.)
  my $got = $rc == 0 ? unpack("Q", $size) > 100 : $! == 12;
  print($got ? ($what eq "one" ? "answered" : "read") : "refused", "\\n");
} else {
  # sysctl({ CTL_KERN = 1, KERN_PROCARGS2 = 49 or KERN_PROCARGS = 38, pid }) is system call 202.
  my $mib = pack("i3", 1, $what eq "args" ? 49 : 38, $pid);
  my $size = pack("Q", 1 << 20);
  my $buf = "\\0" x (1 << 20);
  my $rc = syscall(202, $mib, 3, $buf, $size, 0, 0);
  if ($rc != 0) { print "refused\\n"; }
  else { print index(substr($buf, 0, unpack("Q", $size)), $marker) >= 0 ? "marker found" : "read without the marker", "\\n"; }
}
`;

/** Shell helpers: "yes"/"no" for whether something could be read, written or run. */
const SHELL = `
can_read() { if /bin/cat "$1" >/dev/null 2>&1; then echo yes; else echo no; fi; }
can_list() { if /bin/ls "$1" >/dev/null 2>&1; then echo yes; else echo no; fi; }
can_write() { if ( echo x > "$1" ) 2>/dev/null; then echo yes; else echo no; fi; }
can_mkdir() { if /bin/mkdir "$1" 2>/dev/null; then echo yes; else echo no; fi; }
runs() { out=$("$@" 2>/dev/null); if [ -n "$out" ]; then echo "$out"; else echo no; fi; }
`;

describe.skipIf(!sandboxWorks())("the shipped sandbox profile, for real", () => {
  it("lets a step read and write its own two folders, and nothing private", async () => {
    const w = makeWorld();
    const answers = await w.ask(
      w.buildStep,
      `${SHELL}
      echo "write app: $(can_write '${w.buildStep.workspace}/made.txt')"
      echo "write scratch: $(can_write '${w.buildStep.runDir}/tmp/made.txt')"
      echo "read site: $(can_read '${w.buildStep.siteDir}/index.html')"
      echo "write site: $(can_write '${w.buildStep.siteDir}/made.txt')"
      echo "write harness: $(can_write '${w.buildStep.harnessDir}/made.txt')"
      echo "read home file: $(can_read '${w.home}/private-notes.txt')"
      echo "list home: $(can_list '${w.home}')"
      echo "read database: $(can_read '${w.dataDir}/overnight.db')"
      echo "write home: $(can_write '${w.home}/made.txt')"
      echo "write outside: $(can_write '${w.root}/outside/made.txt')"`,
    );
    expect(answers).toEqual([
      "write app: yes",
      "write scratch: yes",
      "read site: yes",
      "write site: no",
      "write harness: no",
      "read home file: no",
      "list home: no",
      "read database: no",
      "write home: no",
      "write outside: no",
    ]);
  });

  it("cannot read, list, change, move or run anything among the finished builds or the build workspaces: an app being tested only ever sees our copy of itself", async () => {
    // Since Milestone 3 a finished build is kept in <data>/built/<id>, and the app is copied from
    // there (by us, outside the sandbox) to be tested. Another idea's finished build, published
    // or not, must stay out of reach of the app's own scripts and tests.
    const w = makeWorld();
    const tool = "#!/bin/sh\necho finished-build-tool-ran\n";
    writeTree(w.dataDir, {
      "built/idea_0/package.json": '{"name":"made-up-other-app"}\n',
      "built/idea_0/tool.sh": tool,
      "workspaces/idea_2/package.json": '{"name":"made-up-app-in-progress"}\n',
      "workspaces/idea_2/tool.sh": tool,
    });
    for (const folder of ["built/idea_0", "workspaces/idea_2"]) chmodSync(path.join(w.dataDir, folder, "tool.sh"), 0o755);
    const questions = (folder: string, id: string) => `
      echo "${folder}: read a file: $(can_read '${w.dataDir}/${folder}/${id}/package.json')"
      echo "${folder}: list it: $(can_list '${w.dataDir}/${folder}')"
      echo "${folder}: list one: $(can_list '${w.dataDir}/${folder}/${id}')"
      echo "${folder}: write into one: $(can_write '${w.dataDir}/${folder}/${id}/made.txt')"
      echo "${folder}: change a file: $(can_write '${w.dataDir}/${folder}/${id}/package.json')"
      echo "${folder}: add one: $(can_mkdir '${w.dataDir}/${folder}/idea_9')"
      echo "${folder}: move one: $(if /bin/mv '${w.dataDir}/${folder}/${id}' '${w.dataDir}/${folder}/${id}-moved' 2>/dev/null; then echo yes; else echo no; fi)"
      echo "${folder}: delete a file: $(if /bin/rm '${w.dataDir}/${folder}/${id}/package.json' 2>/dev/null; then echo yes; else echo no; fi)"
      echo "${folder}: run a file: $(runs '${w.dataDir}/${folder}/${id}/tool.sh')"`;
    const refused = (folder: string) => ["read a file", "list it", "list one", "write into one", "change a file", "add one", "move one", "delete a file", "run a file"].map((what) => `${folder}: ${what}: no`);

    // The decoys are real: outside the sandbox every one of these works.
    expect(execFileSync("/bin/sh", ["-c", `${SHELL}\necho "$(can_read '${w.dataDir}/built/idea_0/package.json') $(can_list '${w.dataDir}/built') $(runs '${w.dataDir}/built/idea_0/tool.sh')"`], { encoding: "utf8" }).trim()).toBe("yes yes finished-build-tool-ran");

    for (const step of [w.buildStep, w.contractStep]) {
      expect(await w.ask(step, `${SHELL}${questions("built", "idea_0")}${questions("workspaces", "idea_2")}`)).toEqual([...refused("built"), ...refused("workspaces")]);
    }

    // And nothing was changed, whatever the answers said.
    for (const [folder, id] of [["built", "idea_0"], ["workspaces", "idea_2"]] as const) {
      expect(readdirSync(path.join(w.dataDir, folder))).toEqual([id]);
      expect(readdirSync(path.join(w.dataDir, folder, id)).sort()).toEqual(["package.json", "tool.sh"]);
    }
    expect(readFileSync(path.join(w.dataDir, "built/idea_0/package.json"), "utf8")).toBe('{"name":"made-up-other-app"}\n');
  });

  it("of the Node install only node and npm can be read or run: the Bee program next to them cannot", async () => {
    const w = makeWorld();
    const answers = await w.ask(
      w.buildStep,
      `${SHELL}
      echo "node: $(runs node)"
      echo "npm: $(runs npm)"
      echo "bee by name: $(runs bee)"
      echo "bee by path: $(runs '${w.nodeDir}/bin/bee')"
      echo "bee.js by path: $(runs '${w.nodeDir}/lib/node_modules/@beeai/cli/bin/bee.js')"
      echo "read bee's files: $(can_read '${w.nodeDir}/lib/node_modules/@beeai/cli/login.txt')"
      echo "list global packages: $(can_list '${w.nodeDir}/lib/node_modules')"
      echo "list node's bin: $(can_list '${w.nodeDir}/bin')"
      echo "read a header: $(can_read '${w.nodeDir}/include/node/node.h')"
      echo "repo's bee: $(runs '${w.buildStep.toolsDir}/@beeai/cli/bee')"
      echo "read playwright: $(can_read '${w.buildStep.toolsDir}/@playwright/test/cli.js')"`,
    );
    expect(answers).toEqual([
      "node: node-ran",
      "npm: npm-ran",
      "bee by name: no",
      "bee by path: no",
      "bee.js by path: no",
      "read bee's files: no",
      "list global packages: no",
      "list node's bin: no",
      "read a header: yes",
      "repo's bee: no",
      "read playwright: yes",
    ]);
  });

  it("one step cannot write another step's folders, so a program left over from the build cannot touch the contract test's", async () => {
    const w = makeWorld();
    const answers = await w.ask(
      w.buildStep,
      `${SHELL}
      echo "the contract step's work folder: $(can_write '${w.contractStep.workspace}/made.txt')"
      echo "the contract step's scratch folder: $(can_write '${w.contractStep.runDir}/tmp/made.txt')"
      echo "a new folder in the run folder: $(can_mkdir '${w.run}/made-up')"
      echo "a new folder in its own box: $(can_mkdir '${w.build}/made-up')"`,
    );
    expect(answers).toEqual(["the contract step's work folder: no", "the contract step's scratch folder: no", "a new folder in the run folder: no", "a new folder in its own box: no"]);
  });

  it("once its box has been renamed away, a step can neither write its old folders nor bring them back", async () => {
    const w = makeWorld();
    const { moveAside } = await import("../src/remove-tree.ts");
    const gone = moveAside(w.build);
    expect(gone).not.toBeNull();
    // The same sandbox as before the rename: this is what a program that stayed running is left
    // with. (Started from the harness folder, because its old working folder no longer exists.)
    const answers = await w.ask(
      w.buildStep,
      `${SHELL}
      echo "recreate the box: $(can_mkdir '${w.build}')"
      echo "recreate the app folder: $(/bin/mkdir -p '${w.buildStep.workspace}' 2>/dev/null && echo yes || echo no)"
      echo "write under the new name: $(can_write '${gone}/app/made.txt')"
      echo "write the moved scratch: $(can_write '${gone}/scratch-1/tmp/made.txt')"`,
      w.buildStep.harnessDir,
    );
    expect(answers).toEqual(["recreate the box: no", "recreate the app folder: no", "write under the new name: no", "write the moved scratch: no"]);
    expect(existsSync(w.build)).toBe(false);
    expect(existsSync(path.join(gone ?? "", "app", "made.txt"))).toBe(false);
  });

  it("with its box read-only, a step cannot swap the folders it may write for links to somewhere else", async () => {
    // What the verifier relies on: our own code reads app/dist and the screenshots afterwards with
    // the user's full rights, and must find the folders IT made, not a link an app planted.
    const w = makeWorld();
    writeTree(w.root, { "outside/decoy/dist/index.html": "made-up private project\n" });
    const decoy = path.join(w.root, "outside", "decoy");
    const swap = `${SHELL}
      cd '${w.buildStep.harnessDir}'
      /bin/mv '${w.buildStep.workspace}' '${w.buildStep.runDir}/old-app' 2>/dev/null
      /bin/ln -s '${decoy}' '${w.buildStep.workspace}' 2>/dev/null
      /bin/mv '${w.buildStep.runDir}' '${w.buildStep.workspace}/old-scratch' 2>/dev/null
      /bin/chmod 700 '${w.build}' 2>/dev/null
      echo "tried"`;

    // First without the lock, to show the danger is real: the sandbox alone does not stop the swap.
    const unlocked = makeWorld();
    const unlockedDecoy = path.join(unlocked.root, "outside");
    await unlocked.ask(unlocked.buildStep, `/bin/mv '${unlocked.buildStep.workspace}' '${unlocked.buildStep.runDir}/old-app' && /bin/ln -s '${unlockedDecoy}' '${unlocked.buildStep.workspace}'; echo tried`, unlocked.buildStep.harnessDir);
    expect(lstatSync(unlocked.buildStep.workspace).isSymbolicLink()).toBe(true);

    chmodSync(w.build, 0o500);
    try {
      expect(await w.ask(w.buildStep, swap, w.buildStep.harnessDir)).toEqual(["tried"]);
      expect(lstatSync(w.buildStep.workspace).isDirectory()).toBe(true);
      expect(lstatSync(w.buildStep.workspace).isSymbolicLink()).toBe(false);
      expect(lstatSync(w.buildStep.runDir).isDirectory()).toBe(true);
      // The sandbox did not let it unlock the box either.
      expect(statSync(w.build).mode & 0o777).toBe(0o500);
      // It can still do its work inside the folders.
      expect(await w.ask(w.buildStep, `${SHELL}\necho "write app: $(can_write '${w.buildStep.workspace}/made.txt')"`)).toEqual(["write app: yes"]);
    } finally {
      chmodSync(w.build, 0o700);
    }
  });

  it("cannot read or find the command line of a program outside the sandbox, by process id or with pgrep, nor list the programs on this Mac, and can still see and signal its own children", async () => {
    // Why it matters: the detector hands the transcript to kiro-cli on its command line, and
    // process ids can simply be tried one after the other (or, before the process table was
    // closed off as well, just be read from it).
    const w = makeWorld();
    const marker = `overnight-made-up-decoy-${randomBytes(6).toString("hex")}`;
    const reader = path.join(w.buildStep.harnessDir, "reader.pl");
    writeFileSync(reader, READER);
    const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", marker], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        decoy.once("spawn", resolve);
        decoy.once("error", reject);
      });
      const pid = decoy.pid ?? 0;
      const questions = `
        echo "command line: $(${PERL} '${reader}' ${pid} ${marker} args)"
        echo "command line, older call: $(${PERL} '${reader}' ${pid} ${marker} old-args)"
        echo "program path: $(${PERL} '${reader}' ${pid} ${marker} path)"
        echo "its entry in the process table: $(${PERL} '${reader}' ${pid} ${marker} one)"
        echo "the whole process table: $(${PERL} '${reader}' ${pid} ${marker} table)"
        echo "pgrep: $(${PGREP} -f ${marker} 2>/dev/null | /usr/bin/grep -c '^${pid}$')"
        echo "pgrep with command lines: $(${PGREP} -fl ${marker} 2>/dev/null | /usr/bin/grep -c '^${pid} ')"
        echo "signal: $(if kill -0 ${pid} 2>/dev/null; then echo yes; else echo no; fi)"`;

      // First outside the sandbox: every tool used below works on this Mac and finds the decoy,
      // so a "no" inside the sandbox is the sandbox refusing, not a tool that is missing or broken.
      const outside = await runCommand("/bin/sh", ["-c", questions], { timeoutMs: 20_000 });
      expect(outside.stdout.trim().split("\n"), "the test's own tools must work outside the sandbox").toEqual([
        "command line: marker found",
        "command line, older call: marker found",
        "program path: seen",
        "its entry in the process table: answered",
        "the whole process table: read",
        "pgrep: 1",
        "pgrep with command lines: 1",
        "signal: yes",
      ]);

      const inside = await w.ask(
        w.buildStep,
        `${questions}
        /bin/sleep 60 &
        child=$!
        echo "own child, command line: $(${PERL} '${reader}' $child sleep args)"
        echo "own child, program path: $(${PERL} '${reader}' $child sleep path)"
        echo "own child, its entry in the process table: $(${PERL} '${reader}' $child sleep one)"
        echo "own child, signal: $(if kill -0 $child 2>/dev/null; then echo yes; else echo no; fi)"
        kill $child
        wait $child
        echo "own child, ended by our signal: $?"`,
      );
      expect(inside).toEqual([
        "command line: refused",
        "command line, older call: refused",
        "program path: refused",
        "its entry in the process table: refused",
        "the whole process table: refused",
        "pgrep: 0",
        "pgrep with command lines: 0",
        "signal: no",
        "own child, command line: marker found",
        "own child, program path: seen",
        "own child, its entry in the process table: answered",
        "own child, signal: yes",
        // 143 = ended by SIGTERM (128 + 15): our signal reached it.
        "own child, ended by our signal: 143",
      ]);
      // The decoy never noticed any of it.
      expect(decoy.exitCode).toBeNull();
      expect(decoy.signalCode).toBeNull();
    } finally {
      decoy.kill("SIGKILL");
    }
  });

  it("does not let the accounts on this Mac be listed", async () => {
    const w = makeWorld();
    const answers = await w.ask(w.buildStep, `${SHELL}\necho "list /Users: $(can_list /Users)"`);
    expect(answers).toEqual(["list /Users: no"]);
  });
});
