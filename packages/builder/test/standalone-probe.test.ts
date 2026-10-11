// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The sandbox check on its own (what `overnight preflight` calls), against the scripted stand-in
// for Kiro Crew. No Kiro Crew, Keychain, Bee or database is touched, and no process is started.
// The one real network call is to a throwaway web server this test starts on the loopback address.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { BUILD_SKILL_FILE, PROBE_JOB_NAME, probeDir, runStandaloneSandboxProbe, SANDBOX_CHECK_FAILED } from "../src/index.ts";
import { gatewayAnswers, gatewayPort } from "../src/crew-client.ts";
import { standaloneSandboxProbe } from "../src/kiro-crew.ts";
import type { StandaloneProbeOverrides } from "../src/kiro-crew.ts";
import { LIST_TESTS, WRITE_TESTS } from "../src/probe.ts";
import { collectingLogger, FakeCrew, movableClock, T0, tempDir, testConfig, testPaths } from "./helpers.ts";

interface Rig {
  paths: DataPaths;
  crew: FakeCrew;
  lines: string[];
  /** The ports the check asked "is the gateway there?" on. */
  asked: number[];
  gatewayUp: boolean;
  /** What the probe job writes for the Keychain line. */
  keychain: string;
  run(mode?: "overnight" | "crew", overrides?: StandaloneProbeOverrides, signal?: AbortSignal): ReturnType<typeof runStandaloneSandboxProbe>;
}

function makeRig(): Rig {
  const clock = movableClock(T0);
  const paths = testPaths();
  const crew = new FakeCrew(clock);
  crew.installSkill(readFileSync(BUILD_SKILL_FILE, "utf8"));
  crew.writeSettings({ sandbox_allow_unsandboxed_exec: true });
  crew.runForMs = 3_000;
  const tools = tempDir();
  const beeBinary = path.join(tools, "bee");
  const sandboxExec = path.join(tools, "sandbox-exec");
  for (const file of [beeBinary, sandboxExec]) writeFileSync(file, "#!/bin/sh\n# stand-in: never run\n");
  const { logger, lines } = collectingLogger();
  const rig: Rig = {
    paths,
    crew,
    lines,
    asked: [],
    gatewayUp: true,
    keychain: "       0\n",
    run(mode = "overnight", overrides = {}, signal) {
      return standaloneSandboxProbe(
        { config: testConfig(paths.root, { BUILD_SANDBOX: mode }), paths, logger, ...(signal === undefined ? {} : { signal }) },
        {
          kirocrewBinary: crew.binary,
          crewHome: crew.home,
          run: crew.run,
          now: clock.now,
          sleep: crew.sleep,
          beeBinary,
          sandboxExec,
          home: tools,
          repoRoot: tools,
          kiroHome: path.join(tools, ".kiro"),
          postCancel: crew.postCancel,
          startDecoy: () => ({ stop() {} }),
          gatewayAnswers: async (port) => {
            rig.asked.push(port);
            return rig.gatewayUp;
          },
          ...overrides,
        },
      );
    },
  };
  crew.onJobEnd = (job) => {
    if (job.name !== PROBE_JOB_NAME) return;
    const dir = probeDir(paths);
    for (const [name, text] of Object.entries({ "keychain.txt": rig.keychain, "bee.txt": "0\n", "database.txt": "", "processes.txt": "0\n", "finished.txt": "1\n" })) writeFileSync(path.join(dir, name), text);
    for (const test of [...LIST_TESTS, ...WRITE_TESTS]) writeFileSync(path.join(dir, test.file), "0\n");
  };
  return rig;
}

describe("the sandbox check on its own", () => {
  it("passes when Kiro Crew is set up for the outer sandbox, the gateway answers and the probe finds nothing in reach", async () => {
    const rig = makeRig();
    expect(await rig.run()).toEqual({ ok: true });
    // The gateway was asked on the port our kirocrew commands use, once; then one probe job, removed again.
    expect(rig.asked).toEqual([gatewayPort()]);
    expect(rig.crew.commands()).toEqual(["cron add", "cron trigger", "cron remove"]);
    expect(rig.crew.jobs).toMatchObject([{ name: PROBE_JOB_NAME, removed: true }]);
    // Through the same client as the nightly build: every command inside the gateway's sandbox.
    expect(rig.crew.wrappers.every((wrapper) => wrapper !== null && wrapper[0] === "-f")).toBe(true);
    expect(rig.lines.join("\n")).toContain("build sandbox check passed");
  });

  it("says what a job can reach when the probe finds something, in one plain sentence", async () => {
    const rig = makeRig();
    rig.keychain = "      75\n";
    expect(await rig.run()).toEqual({ ok: false, reason: `${SANDBOX_CHECK_FAILED}: the GitHub login in the Keychain can be reached` });
    expect(rig.crew.jobs).toMatchObject([{ removed: true }]);
  });

  it("checks Kiro Crew's setting first: nothing is asked of the gateway and no job is added when it is wrong", async () => {
    const rig = makeRig();
    rig.crew.writeSettings({ sandbox: "strict" });
    const result = await rig.run();
    expect(result).toEqual({ ok: false, reason: "the build sandbox check failed: Kiro Crew is not set up to run inside the Overnight sandbox (agent.sandbox_allow_unsandboxed_exec is not true)" });
    expect(rig.asked).toEqual([]);
    expect(rig.crew.calls).toHaveLength(0);

    const unreadable = makeRig();
    writeFileSync(path.join(unreadable.crew.home, "config.json"), "not json");
    expect(await unreadable.run()).toEqual({ ok: false, reason: "Kiro Crew's settings could not be read, so its sandbox could not be checked" });
    expect(unreadable.asked).toEqual([]);
  });

  it("then checks that the gateway answers: no job is added when it does not", async () => {
    const rig = makeRig();
    rig.gatewayUp = false;
    expect(await rig.run()).toEqual({ ok: false, reason: "the build sandbox check failed: it could not be run (the Kiro Crew gateway is not running)" });
    expect(rig.asked).toHaveLength(1);
    expect(rig.crew.calls).toHaveLength(0);
    expect(existsSync(probeDir(rig.paths))).toBe(false);
  });

  it("runs the probe once per call, and again on the next call", async () => {
    const rig = makeRig();
    expect((await rig.run()).ok).toBe(true);
    rig.keychain = "75\n";
    expect((await rig.run()).ok).toBe(false);
    expect(rig.crew.jobs.filter((job) => job.name === PROBE_JOB_NAME)).toHaveLength(2);
  });

  it("removes nothing but its own probe job: a job left by an earlier night stays for the nightly run to clear", async () => {
    const rig = makeRig();
    const stale = rig.crew.leaveJob("overnight-build-idea_20261009_0000aaaa");
    expect((await rig.run()).ok).toBe(true);
    expect(stale.removed).toBe(false);
  });

  it("in \"crew\" mode does what the nightly check does there: the setting, the gateway, and no probe job", async () => {
    const rig = makeRig();
    rig.crew.writeSettings({ sandbox: "strict" });
    expect(await rig.run("crew")).toEqual({ ok: true });
    expect(rig.asked).toHaveLength(1);
    expect(rig.crew.calls).toHaveLength(0);
    expect(existsSync(probeDir(rig.paths))).toBe(false);

    const off = makeRig();
    expect(await off.run("crew")).toEqual({ ok: false, reason: 'Kiro Crew\'s own sandbox is switched off, but BUILD_SANDBOX is "crew"' });
    const loose = makeRig();
    loose.crew.writeSettings({ sandbox: "auto" });
    expect(await loose.run("crew")).toEqual({ ok: false, reason: "Kiro Crew's sandbox is not at its strict level" });
    expect(loose.asked).toEqual([]);

    const down = makeRig();
    down.crew.writeSettings({ sandbox: "strict" });
    down.gatewayUp = false;
    expect(await down.run("crew")).toMatchObject({ ok: false, reason: expect.stringContaining("the Kiro Crew gateway is not running") });
  });

  it("never throws, whatever goes wrong, and never passes on an error's own text", async () => {
    const rig = makeRig();
    const thrown = await rig.run("overnight", {
      gatewayAnswers: async () => {
        throw new Error("made-up failure with a /private/path in it");
      },
    });
    expect(thrown).toEqual({ ok: false, reason: "the build sandbox check failed: it could not be run (an unexpected error)" });

    const notInstalled = makeRig();
    expect(await notInstalled.run("overnight", { kirocrewBinary: path.join(tempDir(), "no-kirocrew") })).toEqual({ ok: false, reason: "Kiro Crew is not installed (kirocrew was not found)" });
    expect(notInstalled.asked).toEqual([]);

    const noProfile = makeRig();
    expect(await noProfile.run("overnight", { sandboxProfile: path.join(tempDir(), "no-profile.sb") })).toEqual({ ok: false, reason: "the build sandbox check failed: a folder or file the Overnight sandbox needs is missing" });
    expect(noProfile.crew.calls).toHaveLength(0);
  });

  it("ends at once when Overnight is being stopped", async () => {
    const before = makeRig();
    const already = new AbortController();
    already.abort();
    expect(await before.run("overnight", {}, already.signal)).toEqual({ ok: false, reason: "the build sandbox check failed: it could not be run (Overnight was being stopped)" });
    expect(before.asked).toEqual([]);

    const during = makeRig();
    during.crew.writeSecret();
    during.crew.runForMs = Number.POSITIVE_INFINITY;
    const stop = new AbortController();
    during.crew.onCommand = (call) => {
      if (call.args[1] === "trigger") stop.abort();
    };
    expect(await during.run("overnight", {}, stop.signal)).toEqual({ ok: false, reason: "the build sandbox check failed: it could not be run (Overnight was being stopped)" });
    expect(during.crew.jobs).toMatchObject([{ removed: true }]);
  });

  it("the exported function has the shape preflight calls, and stops at the setting when Kiro Crew is not set up", async () => {
    // Pointed at an empty made-up Kiro Crew folder: it answers from the settings check (or, on a
    // Mac without Kiro Crew, from "not installed") and never reaches a gateway.
    const paths = testPaths();
    const before = process.env.KIROCREW_HOME;
    process.env.KIROCREW_HOME = tempDir();
    try {
      const result = await runStandaloneSandboxProbe({ config: testConfig(paths.root), paths, logger: collectingLogger().logger });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(["Kiro Crew's settings could not be read, so its sandbox could not be checked", "Kiro Crew is not installed (kirocrew was not found)"]).toContain(result.reason);
      expect(existsSync(probeDir(paths))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.KIROCREW_HOME;
      else process.env.KIROCREW_HOME = before;
    }
  });
});

describe("asking whether the gateway answers", () => {
  it("is true only for a 200 from the gateway's health address, and false when nothing listens", async () => {
    const seen: string[] = [];
    let status = 200;
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"made":"up"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await gatewayAnswers(port)).toBe(true);
      expect(seen).toEqual(["GET /api/health"]);
      status = 404;
      expect(await gatewayAnswers(port)).toBe(false);
      status = 500;
      expect(await gatewayAnswers(port)).toBe(false);
      const stopped = new AbortController();
      stopped.abort();
      expect(await gatewayAnswers(port, stopped.signal)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The port is closed now: nothing answers.
    expect(await gatewayAnswers(port)).toBe(false);
  });
});
