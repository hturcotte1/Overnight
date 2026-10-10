// All text in this file is made up for the tests. None of it is Bee data.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, dataPaths, silentLogger } from "@overnight/core";
import type { BeeGateway, LoginState } from "@overnight/core";
import { readListenerState } from "../src/background.ts";
import { processIo, runCli } from "../src/cli.ts";
import type { CliIo } from "../src/cli.ts";
import { PAUSED_LINE, RESUMED_LINE } from "../src/commands/pause.ts";
import { ALREADY_RUNNING } from "../src/commands/listen.ts";
import type { ListenFactories } from "../src/commands/listen.ts";
import { PAUSED_QUEUE_NOTE } from "../src/commands/queue.ts";
import { openContext, repoRoot } from "../src/context.ts";
import type { Context } from "../src/context.ts";
import { takeListenLock } from "../src/single-instance.ts";
import { USAGE } from "../src/usage.ts";
import { addIdea, at, capture, fixedNow, moveIdea, SAMPLE_IDEAS, testContext } from "./helpers.ts";

/**
 * A command line whose every outside part is a fake. `open`, the Bee check, the listener parts
 * and the listen lock fail the test if a command reaches for them without the test having
 * offered them. The look at the real lock file and the real ~/Library/LaunchAgents is faked too.
 */
function harness(overrides: Partial<CliIo> = {}) {
  const out = capture();
  const err = capture();
  const context = testContext();
  // The command line closes the store when it is done. Keep it open so the test can look inside.
  const close = vi.spyOn(context.store, "close").mockImplementation(() => {});
  const io: Partial<CliIo> = {
    write: out.write,
    writeError: err.write,
    now: fixedNow(),
    open: () => context,
    beeLoginState: () => Promise.reject(new Error("this test did not expect a Bee call")),
    listenFactories: () => Promise.reject(new Error("this test did not expect the listener")),
    listenLogger: () => silentLogger,
    takeListenLock: () => {
      throw new Error("this test did not expect the listen lock to be taken");
    },
    listenerState: () => ({ running: false, jobInstalled: false }),
    ...overrides,
  };
  return { out, err, context, close, run: (...argv: string[]) => runCli(argv, io) };
}

describe("overnight (command line)", () => {
  it("prints the usage text and exits 0 for --help, -h and help", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["status", "--help"]]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(0);
      expect(h.out.text()).toBe(USAGE);
      expect(h.err.lines).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("exits 2 with the usage text for an unknown command, and opens nothing", async () => {
    for (const argv of [["dance"], ["constructor"], []]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(2);
      expect(h.out.lines).toEqual([]);
      expect(h.err.text()).toContain(USAGE);
      expect(open).not.toHaveBeenCalled();
    }
    const h = harness();
    await h.run("dance");
    expect(h.err.lines[0]).toBe('"dance" is not an Overnight command.');
  });

  it("exits 2 for a switch or extra word a command does not know", async () => {
    for (const argv of [["status", "--jsno"], ["pause", "--json"], ["ideas", "today"], ["queue", "--approved", "--json", "--all"]]) {
      const open = vi.fn<() => Context>();
      const h = harness({ open });
      expect(await h.run(...argv)).toBe(2);
      expect(h.err.text()).toContain("does not understand");
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("reads the queue only when asked with both switches", async () => {
    for (const argv of [["queue"], ["queue", "--approved"], ["queue", "--json"]]) {
      const h = harness();
      expect(await h.run(...argv)).toBe(2);
      expect(h.out.lines).toEqual([]);
      expect(h.err.text()).toContain("overnight queue --approved --json");
    }

    const h = harness();
    const idea = addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(h.context.store, idea, ["asked", "approved"], at(-500));
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(JSON.parse(h.out.text())).toEqual([{ id: idea.id, ...SAMPLE_IDEAS.turns, approvedAt: at(-440) }]);
    expect(h.err.lines).toEqual([]);
  });

  it("hands the builder an empty queue while paused, with the reason on standard error only", async () => {
    const h = harness();
    const idea = addIdea(h.context.store, SAMPLE_IDEAS.turns, at(-600));
    moveIdea(h.context.store, idea, ["asked", "approved"], at(-500));

    expect(await h.run("pause")).toBe(0);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(h.out.lines).toEqual([PAUSED_LINE, "[]"]);
    expect(h.err.lines).toEqual([PAUSED_QUEUE_NOTE]);

    expect(await h.run("resume")).toBe(0);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect(JSON.parse(h.out.lines.at(-1) ?? "")).toEqual([{ id: idea.id, ...SAMPLE_IDEAS.turns, approvedAt: at(-440) }]);
    expect(h.err.lines).toEqual([PAUSED_QUEUE_NOTE]);
  });

  it("applies the nightly build limit from the settings to the queue", async () => {
    const h = harness();
    const approved = [SAMPLE_IDEAS.turns, SAMPLE_IDEAS.plants, SAMPLE_IDEAS.chores].map((sample, index) => {
      const idea = addIdea(h.context.store, sample, at(-900 + index));
      moveIdea(h.context.store, idea, ["asked", "approved"], at(-800 + index * 100));
      return idea;
    });
    // The test settings leave MAX_BUILDS_PER_NIGHT at its default of 2.
    expect(h.context.config.maxBuildsPerNight).toBe(2);
    expect(await h.run("queue", "--approved", "--json")).toBe(0);
    expect((JSON.parse(h.out.text()) as Array<{ id: string }>).map((queued) => queued.id)).toEqual([approved[0]?.id, approved[1]?.id]);
  });

  it("runs pause and resume against the store, and closes it afterwards", async () => {
    const h = harness();
    expect(await h.run("pause")).toBe(0);
    expect(h.context.store.isPaused(false)).toBe(true);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(await h.run("resume")).toBe(0);
    expect(h.context.store.isPaused(true)).toBe(false);
    expect(h.out.lines).toEqual([PAUSED_LINE, RESUMED_LINE]);
  });

  it("runs status without touching Bee, and with --check asks only for the login state", async () => {
    const quiet = harness();
    expect(await quiet.run("status")).toBe(0);
    expect(quiet.out.lines[0]).toBe("Overnight status");
    expect(quiet.out.text()).not.toContain("Bee login");
    expect(quiet.out.lines[2]).toBe("  Listener          not running (background job not installed). Start it with: scripts/install-agents.sh install");

    // The look at the listener is given this data folder's paths.
    const listenerState = vi.fn<CliIo["listenerState"]>(() => ({ running: true, jobInstalled: true }));
    const running = harness({ listenerState });
    expect(await running.run("status", "--json")).toBe(0);
    expect(listenerState).toHaveBeenCalledWith(running.context.paths);
    expect(JSON.parse(running.out.text())).toMatchObject({ listener: { running: true, jobInstalled: true }, newestUtteranceAt: null });

    const beeLoginState = vi.fn<() => Promise<LoginState>>(async () => "logged-out");
    const checked = harness({ beeLoginState });
    expect(await checked.run("status", "--check", "--json")).toBe(0);
    expect(beeLoginState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(checked.out.text())).toMatchObject({ paused: false, utterances: 0, beeLogin: "logged-out" });
  });

  it("runs ideas with its switches", async () => {
    const h = harness();
    addIdea(h.context.store, SAMPLE_IDEAS.chores, at(-20 * 3600));
    addIdea(h.context.store, SAMPLE_IDEAS.plants, at(-600));
    expect(await h.run("ideas")).toBe(0);
    expect(h.out.lines[0]).toBe("1 idea today:");
    expect(await h.run("ideas", "--all", "--json")).toBe(0);
    expect(JSON.parse(h.out.lines.at(-1) ?? "")).toHaveLength(2);
  });

  it("wires listen from the factories it is given", async () => {
    const started: string[] = [];
    const factories: ListenFactories = {
      createBee: () => ({}) as BeeGateway,
      createDetector: () => ({ detect: async () => ({ ok: false, reason: "fake", ms: 0, attempts: 0 }), ensureSetup: async () => {} }),
      createListener: (deps) => ({
        start: async () => {
          started.push(`handleSignals=${deps.options.handleSignals} keepAwake=${deps.options.keepAwake}`);
        },
      }),
    };
    const lock: string[] = [];
    const takeListenLock: CliIo["takeListenLock"] = (file) => {
      lock.push(`taken ${file}`);
      return () => void lock.push("released");
    };
    const h = harness({ listenFactories: async () => factories, takeListenLock });
    expect(await h.run("listen")).toBe(0);
    expect(started).toEqual(["handleSignals=true keepAwake=true"]);
    expect(lock).toEqual([`taken ${path.join(h.context.paths.root, "listen.lock")}`, "released"]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 without starting anything when another listener is already running", async () => {
    const createListener = vi.fn<ListenFactories["createListener"]>();
    const factories: ListenFactories = {
      createBee: () => ({}) as BeeGateway,
      createDetector: () => ({ detect: async () => ({ ok: false, reason: "fake", ms: 0, attempts: 0 }), ensureSetup: async () => {} }),
      createListener,
    };
    const logged: string[] = [];
    const logger = { ...silentLogger, error: (message: string) => void logged.push(message) };
    const h = harness({ listenFactories: async () => factories, takeListenLock: () => null, listenLogger: () => logger });
    expect(await h.run("listen")).toBe(1);
    expect(createListener).not.toHaveBeenCalled();
    expect(logged).toEqual([ALREADY_RUNNING]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 with a one-line reason when a command fails, and still closes the store", async () => {
    const h = harness({ listenFactories: () => Promise.reject(new Error("Cannot find package '@overnight/listener'\n    at somewhere")) });
    expect(await h.run("listen")).toBe(1);
    expect(h.err.lines).toEqual([`"overnight listen" failed. Cannot find package '@overnight/listener'`]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("exits 2 and names the setting when a setting is bad", async () => {
    const h = harness({
      open: () => {
        throw new ConfigError("Bad setting. ASK_CUTOFF: must be a 24-hour time like 23:00");
      },
    });
    expect(await h.run("status")).toBe(2);
    expect(h.err.lines[0]).toBe("Bad setting. ASK_CUTOFF: must be a 24-hour time like 23:00");
    expect(h.out.lines).toEqual([]);
  });

  it("exits 1 when the data folder cannot be opened", async () => {
    const h = harness({
      open: () => {
        throw new Error("EACCES: permission denied, mkdir '/nope'");
      },
    });
    expect(await h.run("status")).toBe(1);
    expect(h.err.text()).toContain("could not open its data folder");
  });
});

describe("opening the data", () => {
  let scratch: string | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("finds the repo root from its own location", () => {
    expect(existsSync(path.join(repoRoot(), "SPEC.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot(), "packages", "cli", "src", "main.ts"))).toBe(true);
  });

  it("creates private data folders and the database where the settings say", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const dataDir = path.join(scratch, "data folder");
    vi.stubEnv("OVERNIGHT_DATA_DIR", dataDir);
    // An empty folder stands in for the repo, so no real .env is read.
    const context = openContext(scratch);
    try {
      expect(context.config.dataDir).toBe(dataDir);
      expect(context.paths.database).toBe(path.join(dataDir, "overnight.db"));
      expect(existsSync(context.paths.database)).toBe(true);
      expect(statSync(context.paths.logs).mode & 0o777).toBe(0o700);
      expect(context.store.countUtterances()).toBe(0);
    } finally {
      context.store.close();
    }
  });

  it("uses the real lock and the real look at the listener unless a test replaces them", () => {
    expect(processIo.takeListenLock).toBe(takeListenLock);
    expect(processIo.listenerState).toBe(readListenerState);
  });

  it("writes the listener's log to logs/listen.log in the data folder", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const paths = dataPaths(path.join(scratch, "data folder"));
    // Whether the line is also shown on screen is the logger's own business (only when there is
    // a terminal). Either way, keep it out of the test output.
    const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      processIo.listenLogger(paths).info("a made-up log line", { count: 1 });
    } finally {
      printed.mockRestore();
    }
    const lines = readFileSync(path.join(paths.logs, "listen.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", name: "listener", message: "a made-up log line", count: 1 });
  });

  it("turns a bad setting into exit code 2 before anything is created", async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight-cli-"));
    const dataDir = path.join(scratch, "data");
    vi.stubEnv("OVERNIGHT_DATA_DIR", dataDir);
    vi.stubEnv("MAX_ASKS_PER_DAY", "lots");
    const root = scratch;
    const err = capture();
    expect(await runCli(["status"], { write: () => {}, writeError: err.write, open: () => openContext(root) })).toBe(2);
    expect(err.lines[0]).toContain("MAX_ASKS_PER_DAY");
    expect(existsSync(dataDir)).toBe(false);
  });
});
