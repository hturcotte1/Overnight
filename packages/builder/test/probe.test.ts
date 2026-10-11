// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The sandbox check ("overnight" mode) against the scripted stand-in for Kiro Crew. The byte
// counts are the ones the experiments measured: 75 for the Keychain entry, 101 for Bee's account
// record, 86,016 for the transcript database. No Keychain, Bee or database is touched here.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { BUILD_SKILL_FILE, createKiroCrewBackend, CREW_GATEWAY_SANDBOX_PROFILE, prepareWorkspace, PROBE_JOB_NAME, PROBE_TIMEOUT_MS, probeCommand, probeDir, renderBrief, SANDBOX_CHECK_FAILED, STOPPED_REASON } from "../src/index.ts";
import type { BuildBackend, BuildJob, KiroCrewBackendOptions } from "../src/index.ts";
import { BEE_COPY, DECOY_MARK, DECOY_PATTERN, judgeProbe, LIST_TESTS, listTestTargets, startDecoy, WRITE_TEST_FILE, WRITE_TESTS, writeTestTargets } from "../src/probe.ts";
import { profileParams } from "../src/sandbox-values.ts";
import { collectingLogger, FakeCrew, flagValue, leaveBuild, MINUTE, movableClock, reply, T0, tempDir, testPaths } from "./helpers.ts";
import type { Clock, FakeCrewJob } from "./helpers.ts";

const SKILL = readFileSync(BUILD_SKILL_FILE, "utf8");
const BLOCKED = { keychain: "       0\n", bee: "0\n", database: "" };
/** Made-up places for the write tests and the list tests of the command-line tests. */
const TARGETS = writeTestTargets({ home: "/home/someone", repo: "/repo", node: "/opt-node/bin", kirocrew: "/crew-venv/bin" });
const LISTS = listTestTargets("/home/someone");

interface Rig {
  clock: Clock;
  paths: DataPaths;
  crew: FakeCrew;
  backend: BuildBackend;
  beeBinary: string;
  lines: string[];
  /** What the probe job writes when it runs. Null: it writes nothing. `writes` also takes the list tests' files. */
  results: { keychain: string; bee: string; database: string; processes?: string; finished?: string; writes?: Record<string, string> } | null;
  /** How often the stand-in for "another program" was started and stopped. No process is started here. */
  decoy: { started: number; stopped: number };
  /** What the probe job found in its results folder when it ran: was the copy of the Bee program there? */
  beeCopySeen: boolean[];
  /** The made-up home folder and repo the sandbox values and the write tests name. */
  home: string;
  repo: string;
  sandboxExec: string;
  job(id?: string): BuildJob;
  probeJobs(): FakeCrewJob[];
  buildJobs(): FakeCrewJob[];
}

function makeRig(options: Partial<KiroCrewBackendOptions> = {}): Rig {
  const clock = movableClock(T0);
  const paths = options.paths ?? testPaths();
  const crew = new FakeCrew(clock);
  crew.installSkill(SKILL);
  // What "overnight" mode needs: Crew's own sandbox off, because the gateway runs inside ours.
  crew.writeSettings({ sandbox_allow_unsandboxed_exec: true });
  const tools = tempDir();
  const beeBinary = path.join(tools, "bee");
  const sandboxExec = path.join(tools, "sandbox-exec");
  const home = path.join(tools, "home");
  const repo = path.join(tools, "repo");
  for (const dir of [home, repo]) mkdirSync(dir);
  for (const file of [beeBinary, sandboxExec]) writeFileSync(file, "#!/bin/sh\n# stand-in: never run\n");
  const { logger, lines } = collectingLogger();
  const decoy = { started: 0, stopped: 0 };
  const rig: Rig = {
    clock,
    paths,
    crew,
    beeBinary,
    lines,
    home,
    repo,
    sandboxExec,
    decoy,
    beeCopySeen: [],
    results: { ...BLOCKED },
    backend: createKiroCrewBackend({
      paths,
      logger,
      sandboxMode: "overnight",
      kirocrewBinary: crew.binary,
      crewHome: crew.home,
      run: crew.run,
      now: clock.now,
      sleep: crew.sleep,
      timeZone: "America/Boise",
      beeBinary,
      sandboxExec,
      home,
      repoRoot: repo,
      // A made-up folder for Kiro's own files (it need not exist: the sandbox only needs its name).
      kiroHome: path.join(home, ".kiro"),
      postCancel: crew.postCancel,
      // Never a real process: the stand-in for "another program" is only counted.
      startDecoy: () => {
        decoy.started += 1;
        return { stop: () => void (decoy.stopped += 1) };
      },
      ...options,
    }),
    job(id = "idea_20261010_ab12cd34") {
      const prepared = prepareWorkspace({ paths, ideaId: id, brief: renderBrief({ id, title: "Coin Flipper", pitch: "Flip a coin and keep a tally." }), now: clock.now() });
      return { ideaId: id, workspace: prepared.workspace, briefPath: prepared.briefPath, timeoutMs: 45 * MINUTE };
    },
    probeJobs: () => crew.jobs.filter((job) => job.name === PROBE_JOB_NAME),
    buildJobs: () => crew.jobs.filter((job) => job.name.startsWith("overnight-build-")),
  };
  crew.runForMs = 5_000;
  crew.onJobEnd = (job) => {
    if (job.name === PROBE_JOB_NAME) {
      if (rig.results === null) return;
      const dir = probeDir(paths);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "keychain.txt"), rig.results.keychain);
      writeFileSync(path.join(dir, "bee.txt"), rig.results.bee);
      writeFileSync(path.join(dir, "database.txt"), rig.results.database);
      writeFileSync(path.join(dir, "processes.txt"), rig.results.processes ?? "       0\n");
      rig.beeCopySeen.push(existsSync(path.join(dir, BEE_COPY)));
      // Every list test and every write test refused, unless the test says otherwise.
      for (const test of [...LIST_TESTS, ...WRITE_TESTS]) writeFileSync(path.join(dir, test.file), rig.results.writes?.[test.file] ?? "0\n");
      writeFileSync(path.join(dir, "finished.txt"), rig.results.finished ?? "1\n");
      return;
    }
    const workspace = /in the folder (\S+),/.exec(job.message)?.[1];
    if (workspace) leaveBuild(workspace, { at: clock.now() });
  };
  return rig;
}

describe("the sandbox check before a Crew build (BUILD_SANDBOX=overnight)", () => {
  it("passes when the Keychain, Bee and the database are all out of reach, and the build goes ahead", async () => {
    const rig = makeRig();
    const outcome = await rig.backend.build(rig.job());
    expect(outcome).toMatchObject({ ok: true, backend: "kiro-crew" });
    // The probe job first (added, triggered, removed), then the build job.
    expect(rig.crew.commands()).toEqual(["cron add", "cron trigger", "cron remove", "cron add", "cron trigger", "cron remove"]);
    expect(rig.crew.jobs.map((job) => job.name)).toEqual([PROBE_JOB_NAME, "overnight-build-idea_20261010_ab12cd34"]);
    expect(rig.crew.jobs.every((job) => job.removed)).toBe(true);
    expect(rig.lines.join("\n")).toContain("build sandbox check passed");
  });

  it("runs as a zero-credit command job: no message, no agent, a schedule that is never due", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job());
    const probe = rig.probeJobs()[0];
    expect(probe?.message).toBe("");
    const flags = probe?.flags ?? [];
    expect(flagValue(flags, "--cron")).toBe("0 3 1 1 *");
    expect(flagValue(flags, "--timezone")).toBe("America/Boise");
    expect(flagValue(flags, "--timeout")).toBe("90");
    expect(flagValue(flags, "--timeout-secs")).toBe("120");
    expect(flags).toContain("--no-persistent-session");
    expect(flags).toContain("--minimal-context");
    expect(flags).not.toContain("--approval-mode");
    // The write tests name the places our own programs are run from: the home folder, the repo,
    // the folder of the node that is running, the folder kirocrew is in, and the background jobs.
    const writeTargets = writeTestTargets({ home: rig.home, repo: rig.repo, node: path.dirname(process.execPath), kirocrew: path.dirname(rig.crew.binary) });
    expect(writeTargets.launchAgents).toBe(path.join(rig.home, "Library", "LaunchAgents", WRITE_TEST_FILE));
    // Bee is tried with a copy of the Bee program in the results folder, where a job may run programs.
    expect(flagValue(flags, "--command")).toBe(
      probeCommand({ dir: probeDir(rig.paths), beeBinary: path.join(probeDir(rig.paths), BEE_COPY), database: rig.paths.database, listTargets: listTestTargets(rig.home), writeTargets }),
    );
  });

  it("gives the job a copy of the Bee program it can run, and takes it away afterwards", async () => {
    const rig = makeRig();
    // Something left at the copy's name by an earlier job, here a link to somewhere else, is cleared first.
    const elsewhere = path.join(tempDir(), "planted");
    writeFileSync(elsewhere, "planted: made up\n");
    mkdirSync(probeDir(rig.paths), { recursive: true });
    symlinkSync(elsewhere, path.join(probeDir(rig.paths), BEE_COPY));

    expect((await rig.backend.build(rig.job())).ok).toBe(true);
    expect(rig.beeCopySeen).toEqual([true]);
    expect(existsSync(path.join(probeDir(rig.paths), BEE_COPY))).toBe(false);
    // The link was removed, not written through; the real program is untouched.
    expect(readFileSync(elsewhere, "utf8")).toBe("planted: made up\n");
    expect(readFileSync(rig.beeBinary, "utf8")).toContain("stand-in");
  });

  it("removes the copy of the Bee program when the check fails, too", async () => {
    const rig = makeRig();
    rig.results = { ...BLOCKED, keychain: "75\n" };
    expect((await rig.backend.build(rig.job())).ok).toBe(false);
    expect(rig.beeCopySeen).toEqual([true]);
    expect(existsSync(path.join(probeDir(rig.paths), BEE_COPY))).toBe(false);
  });

  it("starts a stand-in for another program for the length of the check, and always ends it", async () => {
    const passed = makeRig();
    expect((await passed.backend.build(passed.job())).ok).toBe(true);
    expect(passed.decoy).toEqual({ started: 1, stopped: 1 });

    const failed = makeRig();
    failed.results = null;
    expect((await failed.backend.build(failed.job())).ok).toBe(false);
    expect(failed.decoy).toEqual({ started: 1, stopped: 1 });

    const refused = makeRig();
    refused.crew.addReplies = [reply("", { exitCode: 1, stderr: "Error: cron command blocked: made-up reason\n" })];
    expect((await refused.backend.build(refused.job())).ok).toBe(false);
    expect(refused.decoy).toEqual({ started: 1, stopped: 1 });
  });

  it("fails without its stand-in: the line about other programs would otherwise pass for the wrong reason", async () => {
    const rig = makeRig({ startDecoy: () => null });
    expect(await rig.backend.build(rig.job())).toMatchObject({
      ok: false,
      couldNotStart: true,
      reason: "the build sandbox check failed: it could not be run (its stand-in for another program could not be started)",
    });
    expect(rig.crew.calls).toHaveLength(0);
    expect(existsSync(path.join(probeDir(rig.paths), BEE_COPY))).toBe(false);
  });

  it("the real stand-in is one sleeping process with the mark on its command line, and ends when told", async () => {
    const decoy = startDecoy();
    expect(decoy).not.toBeNull();
    decoy?.stop();
    // The pattern the job searches with matches the mark, and not itself.
    expect(new RegExp(DECOY_PATTERN).test(DECOY_MARK)).toBe(true);
    expect(new RegExp(DECOY_PATTERN).test(DECOY_PATTERN)).toBe(false);
  });

  it("runs every kirocrew command of its own inside the same sandbox as the gateway, with the values the profile asks for", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job());
    expect(rig.crew.wrappers).toHaveLength(6);
    // The names are read from the profile itself, like scripts/install-agents.sh does for the
    // gateway's background job; every value is a real path.
    const values: Record<string, string> = {
      HOME: rig.home,
      DATA_DIR: rig.paths.root,
      REPO: rig.repo,
      NODE_DIR: path.dirname(path.dirname(realpathSync(process.execPath))),
      NPM_CACHE: path.join(rig.home, ".npm"),
      KIRO_HOME: path.join(rig.home, ".kiro"),
      CREW_HOME: rig.crew.home,
    };
    const names = profileParams(readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8"));
    expect([...names].sort()).toEqual(["CREW_HOME", "DATA_DIR", "HOME", "KIRO_HOME", "NODE_DIR", "NPM_CACHE", "REPO"]);
    const expected = names.flatMap((name) => ["-D", `${name}=${values[name]}`]);
    for (const wrapper of rig.crew.wrappers) expect(wrapper).toEqual(["-f", CREW_GATEWAY_SANDBOX_PROFILE, ...expected]);
  });

  it("gives kirocrew the build jobs' own temporary folder, made private, and not the shared one", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job());
    for (const call of rig.crew.calls) expect(call.options.env?.TMPDIR).toBe(rig.paths.buildTmp);
    expect(statSync(rig.paths.buildTmp).mode & 0o777).toBe(0o700);
  });

  it("starts kirocrew in that folder, never in the folder Overnight was started in (the sandbox closes this repo, and kirocrew stops when it may not look at its working folder)", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job());
    expect(rig.crew.calls).toHaveLength(6);
    for (const call of rig.crew.calls) expect(call.options.cwd).toBe(rig.paths.buildTmp);
  });

  it("tries exactly its reads, lists, the look at other programs and five writes, with full paths, and writes only counts and marks", () => {
    const command = probeCommand({ dir: "/data/tmp/build-probe", beeBinary: "/data/tmp/build-probe/bee-copy", database: "/data/overnight.db", listTargets: LISTS, writeTargets: TARGETS });
    const writeTest = (target: string, result: string) => [`/usr/bin/touch ${target} 2>/dev/null && echo 1 > /data/tmp/build-probe/${result} || echo 0 > /data/tmp/build-probe/${result}`, `/bin/rm -f ${target} 2>/dev/null`];
    expect(command).toBe(
      [
        "/usr/bin/security find-generic-password -s gh:github.com -w 2>/dev/null | /usr/bin/wc -c > /data/tmp/build-probe/keychain.txt",
        "/data/tmp/build-probe/bee-copy me --json > /dev/null 2>&1 && /data/tmp/build-probe/bee-copy me --json 2>/dev/null | /usr/bin/wc -c > /data/tmp/build-probe/bee.txt || echo 0 > /data/tmp/build-probe/bee.txt",
        "(/usr/bin/wc -c < /data/overnight.db) > /data/tmp/build-probe/database.txt 2>/dev/null",
        "/bin/ls -A /home/someone/Documents 2>/dev/null | /usr/bin/wc -l > /data/tmp/build-probe/list-documents.txt",
        "/bin/ls -A /home/someone/Library 2>/dev/null | /usr/bin/wc -l > /data/tmp/build-probe/list-library.txt",
        "/bin/ls -A /home/someone/.claude 2>/dev/null | /usr/bin/wc -l > /data/tmp/build-probe/list-claude.txt",
        "/usr/bin/pgrep -f 'overnight-sandbox-probe-deco[y]' 2>/dev/null | /usr/bin/wc -l > /data/tmp/build-probe/processes.txt",
        ...writeTest("/home/someone/overnight-sandbox-probe-write-test", "write-home.txt"),
        ...writeTest("/repo/overnight-sandbox-probe-write-test", "write-repo.txt"),
        ...writeTest("/opt-node/bin/overnight-sandbox-probe-write-test", "write-node.txt"),
        ...writeTest("/crew-venv/bin/overnight-sandbox-probe-write-test", "write-kirocrew.txt"),
        ...writeTest("/home/someone/Library/LaunchAgents/overnight-sandbox-probe-write-test", "write-launch-agents.txt"),
        "echo 1 > /data/tmp/build-probe/finished.txt",
      ].join("; "),
    );
    // A write test only ever makes a NEW file with our own name, and takes it away again.
    for (const target of Object.values(TARGETS)) expect(path.basename(target)).toBe(WRITE_TEST_FILE);
    // Crew refuses shell variables, command substitution, brace groups and loops in a command job.
    expect(command).not.toMatch(/[$`{}\\]|\bfor\b|\bwhile\b/);
    // Every secret goes straight into `wc -c` or to /dev/null: none is written to a file. A folder's
    // names and other programs' command lines go straight into `wc -l`.
    for (const part of (command ?? "").split("; ")) {
      if (/security|bee-copy me|overnight\.db/.test(part)) expect(part).toMatch(/\| \/usr\/bin\/wc -c >|> \/dev\/null|\(\/usr\/bin\/wc -c </);
      if (/\/bin\/ls|pgrep/.test(part)) expect(part).toMatch(/2>\/dev\/null \| \/usr\/bin\/wc -l > \S+$/);
    }
    // The home folder itself is not on the list: Kiro Crew has to be able to open it (see probe.ts).
    expect(Object.values(LISTS)).toEqual(["/home/someone/Documents", "/home/someone/Library", "/home/someone/.claude"]);
  });

  it("quotes a path with a space, and refuses to run with a path it cannot write safely", () => {
    const spaced = probeCommand({ dir: "/data dir/tmp/build-probe", beeBinary: "/repo/bee", database: "/data dir/overnight.db", listTargets: listTestTargets("/Users/some one"), writeTargets: { ...TARGETS, home: "/Users/some one/overnight-sandbox-probe-write-test" } });
    expect(spaced).toContain("(/usr/bin/wc -c < '/data dir/overnight.db') > '/data dir/tmp/build-probe/database.txt' 2>/dev/null");
    expect(spaced).toContain("/bin/ls -A '/Users/some one/Documents' 2>/dev/null | /usr/bin/wc -l > '/data dir/tmp/build-probe/list-documents.txt'");
    expect(spaced).toContain("/usr/bin/touch '/Users/some one/overnight-sandbox-probe-write-test' 2>/dev/null && echo 1 > '/data dir/tmp/build-probe/write-home.txt' || echo 0 > '/data dir/tmp/build-probe/write-home.txt'; /bin/rm -f '/Users/some one/overnight-sandbox-probe-write-test' 2>/dev/null");
    for (const bad of ["/data/$HOME/x", "/data/it's/x", "/data/`id`/x", "/data/a;b", "/data/a\nb", "relative/path", "/data/{a,b}"]) {
      expect(probeCommand({ dir: "/ok", beeBinary: "/repo/bee", database: bad, listTargets: LISTS, writeTargets: TARGETS }), bad).toBeNull();
      expect(probeCommand({ dir: bad, beeBinary: "/repo/bee", database: "/ok.db", listTargets: LISTS, writeTargets: TARGETS }), bad).toBeNull();
      expect(probeCommand({ dir: "/ok", beeBinary: bad, database: "/ok.db", listTargets: LISTS, writeTargets: TARGETS }), bad).toBeNull();
      expect(probeCommand({ dir: "/ok", beeBinary: "/repo/bee", database: "/ok.db", listTargets: LISTS, writeTargets: { ...TARGETS, node: bad } }), bad).toBeNull();
      expect(probeCommand({ dir: "/ok", beeBinary: "/repo/bee", database: "/ok.db", listTargets: { ...LISTS, claude: bad }, writeTargets: TARGETS }), bad).toBeNull();
    }
  });

  for (const [what, results, said] of [
    ["the Keychain entry", { ...BLOCKED, keychain: "      75\n" }, "the GitHub login in the Keychain can be reached"],
    ["Bee", { ...BLOCKED, bee: "     101\n" }, "the Bee login can be reached"],
    ["the transcript database", { ...BLOCKED, database: "   86016\n" }, "the transcript database can be read"],
  ] as const) {
    it(`fails when ${what} is reachable, and builds nothing`, async () => {
      const rig = makeRig();
      rig.results = { ...results };
      const outcome = await rig.backend.build(rig.job());
      expect(outcome).toEqual({ ok: false, backend: "kiro-crew", ms: 5_000, reason: `${SANDBOX_CHECK_FAILED}: ${said}`, couldNotStart: true });
      expect(rig.buildJobs()).toHaveLength(0);
      // The probe job is removed all the same.
      expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
      expect(rig.lines.join("\n")).toContain("build sandbox check failed");
    });
  }

  it("names every one that is reachable", async () => {
    const rig = makeRig();
    rig.results = { keychain: "75\n", bee: "101\n", database: "86016\n", processes: "2\n", writes: { "list-library.txt": "40\n", "write-repo.txt": "1\n" } };
    const outcome = await rig.backend.build(rig.job());
    expect(outcome).toMatchObject({
      ok: false,
      couldNotStart: true,
      reason:
        "the build sandbox check failed: the GitHub login in the Keychain can be reached, the Bee login can be reached, the transcript database can be read, " +
        "a job can list the Library folder (other programs' data), a job can read the command lines of other programs, a job can write in this repo",
    });
  });

  for (const test of WRITE_TESTS) {
    it(`fails when ${test.said}, and builds nothing`, async () => {
      const rig = makeRig();
      rig.results = { ...BLOCKED, writes: { [test.file]: "1\n" } };
      const outcome = await rig.backend.build(rig.job());
      expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: `${SANDBOX_CHECK_FAILED}: ${test.said}` });
      expect(rig.buildJobs()).toHaveLength(0);
      expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
    });
  }

  for (const test of LIST_TESTS) {
    it(`fails when ${test.said}, and builds nothing`, async () => {
      const rig = makeRig();
      rig.results = { ...BLOCKED, writes: { [test.file]: "      31\n" } };
      const outcome = await rig.backend.build(rig.job());
      expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: `${SANDBOX_CHECK_FAILED}: ${test.said}` });
      expect(rig.buildJobs()).toHaveLength(0);
      expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
    });
  }

  it("fails when a job can read the command lines of other programs, and builds nothing", async () => {
    const rig = makeRig();
    rig.results = { ...BLOCKED, processes: "       1\n" };
    const outcome = await rig.backend.build(rig.job());
    expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: `${SANDBOX_CHECK_FAILED}: a job can read the command lines of other programs` });
    expect(rig.buildJobs()).toHaveLength(0);
  });

  it("fails when a list test or the look at other programs left no count, or something that is not a count", async () => {
    const odds: Array<{ processes?: string; writes?: Record<string, string> }> = [{ processes: "" }, { processes: "pgrep: Cannot get process list\n" }, { writes: { "list-documents.txt": "" } }, { writes: { "list-claude.txt": "ls: Operation not permitted\n" } }];
    for (const odd of odds) {
      const rig = makeRig();
      rig.results = { ...BLOCKED, ...odd };
      expect(await rig.backend.build(rig.job()), JSON.stringify(odd)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (its results could not be read)" });
      expect(rig.buildJobs()).toHaveLength(0);
    }
  });

  it("fails when a write test left no mark, or something that is not 0 or 1", async () => {
    for (const odd of ["", "yes\n", "touch: Operation not permitted\n"]) {
      const rig = makeRig();
      rig.results = { ...BLOCKED, writes: { "write-repo.txt": odd } };
      expect(await rig.backend.build(rig.job()), JSON.stringify(odd)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (its results could not be read)" });
    }
    // Any number but 0 means "it could be written".
    const rig = makeRig();
    rig.results = { ...BLOCKED, writes: { "write-home.txt": "2\n" } };
    expect(await rig.backend.build(rig.job())).toMatchObject({ ok: false, reason: "the build sandbox check failed: a job can write in the home folder" });
  });

  it("treats a database that gives 0 bytes or cannot be opened as out of reach", () => {
    const dir = tempDir();
    const write = (results: { keychain: string; bee: string; database: string }) => {
      for (const [name, text] of Object.entries(results)) writeFileSync(path.join(dir, `${name}.txt`), text);
      for (const test of [...LIST_TESTS, ...WRITE_TESTS]) writeFileSync(path.join(dir, test.file), "0\n");
      writeFileSync(path.join(dir, "processes.txt"), "       0\n");
      writeFileSync(path.join(dir, "finished.txt"), "1\n");
    };
    write({ keychain: "0\n", bee: "0\n", database: "" });
    expect(judgeProbe(dir)).toEqual({ ok: true });
    write({ keychain: "0\n", bee: "0\n", database: "       0\n" });
    expect(judgeProbe(dir)).toEqual({ ok: true });
    write({ keychain: "0\n", bee: "0\n", database: "1\n" });
    expect(judgeProbe(dir)).toMatchObject({ ok: false });
  });

  it("runs once per process, and a pass covers the night's later builds", async () => {
    const rig = makeRig();
    expect((await rig.backend.build(rig.job())).ok).toBe(true);
    expect((await rig.backend.build(rig.job("idea_20261010_ffff0000"))).ok).toBe(true);
    expect(rig.probeJobs()).toHaveLength(1);
    expect(rig.buildJobs()).toHaveLength(2);
  });

  it("stays failed for the whole night: no later build is tried with Crew", async () => {
    const rig = makeRig();
    rig.results = { ...BLOCKED, keychain: "75\n" };
    expect((await rig.backend.build(rig.job())).ok).toBe(false);
    // Even if the wall were "up" a minute later, the answer for tonight has been given.
    rig.results = { ...BLOCKED };
    const calls = rig.crew.calls.length;
    const second = await rig.backend.build(rig.job("idea_20261010_ffff0000"));
    expect(second).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("the GitHub login in the Keychain can be reached") });
    expect(rig.crew.calls).toHaveLength(calls);
    expect(rig.buildJobs()).toHaveLength(0);
  });

  it("fails when the check does not finish within 3 minutes, and removes the probe job", async () => {
    const rig = makeRig();
    rig.crew.runForMs = Number.POSITIVE_INFINITY;
    const outcome = await rig.backend.build(rig.job());
    expect(PROBE_TIMEOUT_MS).toBe(3 * MINUTE);
    expect(outcome).toEqual({ ok: false, backend: "kiro-crew", ms: 3 * MINUTE, reason: "the build sandbox check failed: it could not be run (it did not finish within 3 minutes)", couldNotStart: true });
    expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
    expect(rig.buildJobs()).toHaveLength(0);
  });

  it("fails when the gateway is not running", async () => {
    const rig = makeRig();
    rig.crew.triggerReplies = [reply("Error: cannot reach gateway. Is `kirocrew gateway` running?\n")];
    expect(await rig.backend.build(rig.job())).toMatchObject({
      ok: false,
      couldNotStart: true,
      reason: "the build sandbox check failed: it could not be run (the Kiro Crew gateway is not running)",
    });
    expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
  });

  it("fails when Crew will not take the probe job", async () => {
    const rig = makeRig();
    rig.crew.addReplies = [reply("", { exitCode: 1, stderr: "Error: cron command blocked: made-up reason\n" })];
    const outcome = await rig.backend.build(rig.job());
    expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (Kiro Crew did not accept the job)" });
    expect(JSON.stringify(outcome) + rig.lines.join("\n")).not.toContain("made-up reason");
  });

  it("fails when the job ran but left no results, or results that are not counts", async () => {
    const nothing = makeRig();
    nothing.results = null;
    expect(await nothing.backend.build(nothing.job())).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (the check did not finish)" });

    for (const odd of [
      { ...BLOCKED, keychain: "ghp_not-a-count\n" },
      { ...BLOCKED, bee: "" },
      { ...BLOCKED, database: "wc: /data/overnight.db: Operation not permitted\n" },
      { ...BLOCKED, keychain: "-1\n" },
    ]) {
      const rig = makeRig();
      rig.results = odd;
      const outcome = await rig.backend.build(rig.job());
      expect(outcome, JSON.stringify(odd)).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (its results could not be read)" });
      expect(rig.buildJobs()).toHaveLength(0);
    }

    const cutShort = makeRig();
    cutShort.results = { ...BLOCKED, finished: "" };
    expect((await cutShort.backend.build(cutShort.job())).ok).toBe(false);
  });

  it("does not pass on results left over from an earlier night", async () => {
    const rig = makeRig();
    const dir = probeDir(rig.paths);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries({ keychain: "0\n", bee: "0\n", database: "", processes: "0\n", finished: "1\n" })) writeFileSync(path.join(dir, `${name}.txt`), text);
    for (const test of [...LIST_TESTS, ...WRITE_TESTS]) writeFileSync(path.join(dir, test.file), "0\n");
    expect(judgeProbe(dir)).toEqual({ ok: true });
    // Tonight the job writes nothing (say, Crew refused to run it).
    rig.results = null;
    expect(await rig.backend.build(rig.job())).toMatchObject({ ok: false, couldNotStart: true });
    expect(existsSync(path.join(dir, "keychain.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "processes.txt"))).toBe(false);
    for (const test of [...LIST_TESTS, ...WRITE_TESTS]) expect(existsSync(path.join(dir, test.file)), test.file).toBe(false);
  });

  it("fails without the Bee program: its line would otherwise pass for the wrong reason", async () => {
    const rig = makeRig({ beeBinary: path.join(tempDir(), "no-bee-here") });
    expect(await rig.backend.build(rig.job())).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (the Bee program was not found)" });
    expect(rig.crew.calls).toHaveLength(0);
  });

  it("does not build unless Crew is set up for the outer sandbox", async () => {
    const rig = makeRig();
    rig.crew.writeSettings({ sandbox: "strict" });
    const outcome = await rig.backend.build(rig.job());
    expect(outcome).toMatchObject({ ok: false, couldNotStart: true, reason: expect.stringContaining("the build sandbox check failed: Kiro Crew is not set up to run inside the Overnight sandbox") });
    expect(rig.crew.calls).toHaveLength(0);
  });

  it("keeps its results in <data>/tmp/build-probe, private to the user", async () => {
    const rig = makeRig();
    await rig.backend.build(rig.job());
    expect(probeDir(rig.paths)).toBe(path.join(rig.paths.root, "tmp", "build-probe"));
    expect(readFileSync(path.join(probeDir(rig.paths), "keychain.txt"), "utf8").trim()).toBe("0");
    expect(statSync(probeDir(rig.paths)).mode & 0o777).toBe(0o700);
  });

  it("makes an older results folder private again", async () => {
    const rig = makeRig();
    mkdirSync(probeDir(rig.paths), { recursive: true });
    chmodSync(probeDir(rig.paths), 0o755);
    await rig.backend.build(rig.job());
    expect(statSync(probeDir(rig.paths)).mode & 0o777).toBe(0o700);
  });

  it("fails when the results folder is a link to somewhere else", async () => {
    const rig = makeRig();
    const elsewhere = tempDir();
    mkdirSync(path.dirname(probeDir(rig.paths)), { recursive: true });
    symlinkSync(elsewhere, probeDir(rig.paths));
    expect(await rig.backend.build(rig.job())).toMatchObject({ ok: false, couldNotStart: true, reason: "the build sandbox check failed: it could not be run (its results folder is not a plain folder)" });
    expect(rig.crew.calls).toHaveLength(0);
  });

  it("ends at once when Overnight is told to stop, cancels and removes its job, and is not held against a later night", async () => {
    const rig = makeRig();
    rig.crew.writeSecret();
    rig.crew.runForMs = Number.POSITIVE_INFINITY;
    const stop = new AbortController();
    rig.crew.onCommand = (call) => {
      if (call.args[1] === "trigger") stop.abort();
    };
    const outcome = await rig.backend.build(rig.job(), { signal: stop.signal });
    expect(outcome).toMatchObject({ ok: false, couldNotStart: false, reason: STOPPED_REASON });
    expect(rig.probeJobs()).toMatchObject([{ removed: true }]);
    expect(rig.crew.cancels).toHaveLength(1);
    expect(rig.buildJobs()).toHaveLength(0);

    // The check that was cut short said nothing about the sandbox: the next build runs it again.
    rig.crew.onCommand = () => {};
    rig.crew.runForMs = 5_000;
    expect((await rig.backend.build(rig.job("idea_20261010_ffff0000"))).ok).toBe(true);
    expect(rig.probeJobs()).toHaveLength(2);
  });
});

describe("no sandbox check in \"crew\" mode", () => {
  it("adds no probe job", async () => {
    const rig = makeRig({ sandboxMode: "crew" });
    rig.crew.writeSettings({ sandbox: "strict" });
    expect((await rig.backend.build(rig.job())).ok).toBe(true);
    expect(rig.probeJobs()).toHaveLength(0);
    expect(rig.crew.commands()).toEqual(["cron add", "cron trigger", "cron remove"]);
    expect(existsSync(probeDir(rig.paths))).toBe(false);
  });
});
