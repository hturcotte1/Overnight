// All text in this file is made up for the tests. No Bee, Kiro, Kiro Crew, GitHub or network
// call is made: every one of preflight's questions is answered by a fake.
import { describe, expect, it } from "vitest";
import { BeeError, Store } from "@overnight/core";
import { CROSS, DASH, formatCheck, preflight, PREFLIGHT_READY, PREFLIGHT_STOPPED, PREFLIGHT_TITLE, TICK, verdict } from "../src/commands/preflight.ts";
import type { PreflightProbes } from "../src/commands/preflight.ts";
import type { WatchStopSignals } from "../src/stop-signals.ts";
import { at, capture, testConfig } from "./helpers.ts";
import { aborted, fakeStopSignals, never } from "./night-fakes.ts";

/** A Mac on which everything tonight's run needs is in place. Each test breaks one thing. */
function allGood(overrides: Partial<PreflightProbes> = {}): PreflightProbes & { asked: string[] } {
  const asked: string[] = [];
  const note = <T>(name: string, answer: T): T => (asked.push(name), answer);
  return {
    asked,
    beeLoginState: async () => note("bee", "logged-in" as const),
    kiroSignedIn: async () => note("kiro", true),
    gatewayAnswers: async () => note("gateway", true),
    crewSettingsProblem: async (mode) => note(`crew settings for ${mode}`, null),
    installedSkill: async () => note("skill", "same" as const),
    sandboxProbe: async () => note("probe", { ok: true as const }),
    buildRunning: () => note("build lock", false),
    ghLoggedIn: async () => note("gh", true),
    pagesRepoReachable: async (repo) => note(`repo ${repo}`, true),
    headlessShellPresent: async () => note("browser", true),
    nightJobs: () => note("jobs", { build: true, deliver: true, crew: true }),
    crewJobSandbox: () => note("gateway job", "overnight" as const),
    ...overrides,
  };
}

async function run(overrides: Partial<PreflightProbes> = {}, options: { settings?: Record<string, string>; paused?: boolean; checkLimitMs?: number; watchStopSignals?: WatchStopSignals } = {}) {
  const out = capture();
  const store = new Store(":memory:");
  if (options.paused) store.setPaused(true, at(0));
  const probes = allGood(overrides);
  // Made-up stop signals: no test listens to, or sends, a real one.
  const watchStopSignals = options.watchStopSignals ?? fakeStopSignals().watch;
  const code = await preflight({ store, config: testConfig(options.settings), write: out.write, probes, checkLimitMs: options.checkLimitMs, watchStopSignals });
  return { code, lines: out.lines, text: out.text(), asked: probes.asked };
}

describe("overnight preflight", () => {
  it("prints one ticked line for each thing tonight's run needs, in order, and exits 0 when all of them hold", async () => {
    const ran = await run();
    expect(ran.code).toBe(0);
    expect(ran.lines).toEqual([
      PREFLIGHT_TITLE,
      `  ${TICK} Overnight is live (not paused).`,
      `  ${TICK} Bee is logged in.`,
      `  ${TICK} Kiro is signed in.`,
      `  ${TICK} The Kiro Crew gateway is running.`,
      `  ${TICK} Kiro Crew is set up for BUILD_SANDBOX=overnight.`,
      `  ${TICK} The build skill installed in Kiro Crew is the one in crew/build-skill.md.`,
      `  ${TICK} The build sandbox holds: from inside a Kiro Crew job, the GitHub login, the Bee login and the transcripts are out of reach, and nothing can be written where Overnight's own programs run from.`,
      `  ${TICK} The GitHub CLI (gh) is logged in.`,
      `  ${TICK} The apps repo (overnight-apps) can be reached on GitHub.`,
      `  ${TICK} Playwright's headless browser is installed.`,
      `  ${TICK} The three background jobs are installed: build, deliver and the Kiro Crew gateway.`,
      `  ${TICK} The gateway job was installed for BUILD_SANDBOX=overnight.`,
      PREFLIGHT_READY,
    ]);
    // Every question was asked once, and the sandbox mode asked about is the one in the settings.
    // (Before the probe, one look at the build lock: the probe must not get in the way of a build.)
    expect(ran.asked).toEqual(["bee", "kiro", "gateway", "crew settings for overnight", "skill", "build lock", "probe", "gh", "repo overnight-apps", "browser", "jobs", "gateway job"]);
    expect([TICK, CROSS, DASH]).toEqual(["✓", "✗", "–"]);
  });

  /** The one line that changed, and the exit code. Everything else must still be ticked. */
  async function broken(overrides: Partial<PreflightProbes>, options: Parameters<typeof run>[1] = {}) {
    const ran = await run(overrides, options);
    const marked = ran.lines.slice(1, -1).filter((line) => !line.startsWith(`  ${TICK} `));
    return { code: ran.code, marked, last: ran.lines.at(-1), lines: ran.lines };
  }

  it("crosses the paused line, by the stored switch or by the setting, and names the command that turns Overnight on", async () => {
    for (const options of [{ paused: true }, { settings: { PAUSED: "true" } }]) {
      const ran = await broken({}, options);
      expect(ran.code).toBe(1);
      expect(ran.marked).toEqual([`  ${CROSS} Overnight is paused, so nothing is asked or built. Fix: npx overnight resume`]);
      expect(ran.last).toBe(`Not ready: 1 failed, of 12 checks. Fix what is marked ${CROSS} and run this again.`);
    }
  });

  it("crosses the Bee line when Bee is logged out, and does not call it a pass when Bee will not say", async () => {
    const out = await broken({ beeLoginState: async () => "logged-out" });
    expect(out.code).toBe(1);
    expect(out.marked).toEqual([`  ${CROSS} Bee is logged out, so the link cannot be put on the wrist. Fix: log Bee in again (node spikes/00-bee-login.ts prints the link; the wearer approves it in the Bee app)`]);

    const unknown = await broken({ beeLoginState: async () => "unknown" });
    expect(unknown.code).toBe(1);
    expect(unknown.marked).toEqual([`  ${DASH} Is Bee logged in? Not checked: Bee did not answer`]);
    expect(unknown.last).toBe(`Not confirmed: 1 of 12 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);

    // A Bee call that fails outright is "could not be checked", with Bee's own one-line reason.
    const threw = await broken({
      beeLoginState: async () => {
        throw new BeeError("timeout", "Bee did not answer within 30 seconds.\n    at somewhere");
      },
    });
    expect(threw.code).toBe(1);
    expect(threw.marked).toEqual([`  ${DASH} Is Bee logged in? Not checked: Bee did not answer within 30 seconds.`]);
  });

  it("crosses the Kiro line when Kiro is signed out", async () => {
    const ran = await broken({ kiroSignedIn: async () => false });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([`  ${CROSS} Kiro is signed out on this Mac, so nothing can be built. Fix: kiro-cli login`]);
  });

  it("crosses the gateway line when it does not answer, and then does not run the sandbox probe through it", async () => {
    let probed = 0;
    const ran = await broken({ gatewayAnswers: async () => false, sandboxProbe: async () => ((probed += 1), { ok: true }) });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([
      `  ${CROSS} The Kiro Crew gateway does not answer, so builds would fall back to Kiro CLI. Fix: scripts/install-agents.sh install crew   (why it is down: scripts/install-agents.sh status crew)`,
      `  ${DASH} Does the build sandbox hold? Not checked: the probe is a Kiro Crew job, and the gateway is not running`,
    ]);
    expect(probed).toBe(0);
    expect(ran.last).toBe(`Not ready: 1 failed, 1 could not be checked, of 12 checks. Fix what is marked ${CROSS} and run this again.`);
  });

  it("crosses the settings line when Kiro Crew is not set the way the sandbox mode needs, with the command for that mode", async () => {
    const overnight = await broken({ crewSettingsProblem: async () => "agent.sandbox_allow_unsandboxed_exec is not true" });
    expect(overnight.code).toBe(1);
    expect(overnight.marked).toEqual([
      `  ${CROSS} Kiro Crew is not set up for BUILD_SANDBOX=overnight: agent.sandbox_allow_unsandboxed_exec is not true. Fix: ~/.local/bin/kirocrew config set agent.sandbox_allow_unsandboxed_exec true   then: scripts/install-agents.sh install crew`,
    ]);

    // The builder puts "the build sandbox check failed: " in front of this reason for its own log. Not repeated here.
    const prefixed = await broken({ crewSettingsProblem: async () => "the build sandbox check failed: Kiro Crew is not set up to run inside the Overnight sandbox (agent.sandbox_allow_unsandboxed_exec is not true)" });
    expect(prefixed.marked[0]).toContain("Kiro Crew is not set up for BUILD_SANDBOX=overnight: Kiro Crew is not set up to run inside the Overnight sandbox (agent.sandbox_allow_unsandboxed_exec is not true). Fix: ");

    const asked: string[] = [];
    const crew = await broken(
      { crewSettingsProblem: async (mode) => (asked.push(mode), "Kiro Crew's sandbox is not at its strict level"), crewJobSandbox: () => "crew" },
      { settings: { BUILD_SANDBOX: "crew" } },
    );
    expect(asked).toEqual(["crew"]);
    expect(crew.marked).toEqual([
      `  ${CROSS} Kiro Crew is not set up for BUILD_SANDBOX=crew: Kiro Crew's sandbox is not at its strict level. Fix: ~/.local/bin/kirocrew config set agent.sandbox strict   and: ~/.local/bin/kirocrew config set agent.sandbox_allow_unsandboxed_exec false   then: scripts/install-agents.sh install crew`,
    ]);
  });

  it("crosses the skill line when the installed skill is missing or is not ours", async () => {
    expect((await broken({ installedSkill: async () => "missing" })).marked).toEqual([`  ${CROSS} The build skill is not installed in Kiro Crew. Fix: scripts/install-agents.sh install crew`]);
    const different = await broken({ installedSkill: async () => "different" });
    expect(different.code).toBe(1);
    expect(different.marked).toEqual([`  ${CROSS} The build skill installed in Kiro Crew is not the one in crew/build-skill.md. Fix: scripts/install-agents.sh install crew`]);
  });

  it("ticks the sandbox line when the builder's own probe passes, so preflight can say Ready in overnight mode", async () => {
    let probed = 0;
    const ran = await run({ sandboxProbe: async () => ((probed += 1), { ok: true }) });
    expect(testConfig().buildSandbox).toBe("overnight");
    expect(probed).toBe(1);
    expect(ran.code).toBe(0);
    expect(ran.lines.at(-1)).toBe(PREFLIGHT_READY);
    expect(ran.lines.filter((line) => line.includes("build sandbox holds"))).toHaveLength(1);
  });

  it("crosses the sandbox line when the probe finds something within reach, in the builder's own words, with the fix", async () => {
    // The builder's reasons start with "the build sandbox check failed: "; our line says that already.
    const ran = await broken({ sandboxProbe: async () => ({ ok: false, reason: "the build sandbox check failed: the transcript database can be read" }) });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([
      `  ${CROSS} The build sandbox check did not pass: the transcript database can be read. Fix: scripts/install-agents.sh install crew   then run this again. Until it passes, nothing is built with Kiro Crew`,
    ]);
    expect(ran.last).toBe(`Not ready: 1 failed, of 12 checks. Fix what is marked ${CROSS} and run this again.`);

    // A reason without those words is said as it is, on one line.
    const other = await broken({ sandboxProbe: async () => ({ ok: false, reason: "Kiro Crew's sandbox\nis not at its strict level" }) });
    expect(other.marked).toEqual([
      `  ${CROSS} The build sandbox check did not pass: Kiro Crew's sandbox is not at its strict level. Fix: scripts/install-agents.sh install crew   then run this again. Until it passes, nothing is built with Kiro Crew`,
    ]);
  });

  it("does not run the probe while a build is running on the data folder, or when that cannot be told, and that is not a pass", async () => {
    let probed = 0;
    const building = await broken({ buildRunning: () => true, sandboxProbe: async () => ((probed += 1), { ok: true }) });
    expect(building.code).toBe(1);
    expect(building.marked).toEqual([
      `  ${DASH} Does the build sandbox hold? Not checked: a build is running on this data folder right now, and the check would get in its way. That build made the same check itself: see logs/build.log`,
    ]);
    // Nothing is known to be wrong, so nothing is called a failure. It is still not "ready", and the exit code says so.
    expect(building.last).toBe(`Not confirmed: 1 of 12 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);

    const unknown = await broken({ buildRunning: () => null, sandboxProbe: async () => ((probed += 1), { ok: true }) });
    expect(unknown.marked).toEqual([`  ${DASH} Does the build sandbox hold? Not checked: could not tell whether a build is running right now, and the check must not get in its way`]);
    expect(probed).toBe(0);
  });

  it("hands the probe a signal, and aborts it when the probe runs past its time limit", async () => {
    const signals: AbortSignal[] = [];
    const ran = await broken({ sandboxProbe: (signal) => (signals.push(signal as AbortSignal), never()) }, { checkLimitMs: 20 });
    expect(ran.marked).toEqual([`  ${DASH} Does the build sandbox hold? Not checked: This check was still going after 0 minutes, which is past its time limit.`]);
    // The builder removes its probe job when this fires.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    const fine: AbortSignal[] = [];
    await run({ sandboxProbe: async (signal) => (fine.push(signal as AbortSignal), { ok: true }) });
    expect(fine[0]?.aborted).toBe(false);
  });

  it("runs no probe in crew mode, where there is none, and says so", async () => {
    let probed = 0;
    const ran = await run({ sandboxProbe: async () => ((probed += 1), { ok: true }), crewJobSandbox: () => "crew" }, { settings: { BUILD_SANDBOX: "crew" } });
    expect(ran.code).toBe(0);
    expect(probed).toBe(0);
    expect(ran.lines).toContain(`  ${TICK} No sandbox probe in this mode (BUILD_SANDBOX=crew: Kiro Crew's own sandbox, which is not probed).`);
    expect(ran.lines).toContain(`  ${TICK} Kiro Crew is set up for BUILD_SANDBOX=crew.`);
    expect(ran.lines).toContain(`  ${TICK} The gateway job was installed for BUILD_SANDBOX=crew.`);
  });

  it("crosses the GitHub line when gh is not logged in, and then does not ask GitHub about the repo", async () => {
    let asked = 0;
    const ran = await broken({ ghLoggedIn: async () => false, pagesRepoReachable: async () => ((asked += 1), true) });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([
      `  ${CROSS} The GitHub CLI (gh) is not logged in, or was not found, so nothing can be published. Fix: gh auth login`,
      `  ${DASH} Can the apps repo be reached? Not checked: the GitHub CLI is not logged in`,
    ]);
    expect(asked).toBe(0);
  });

  it("crosses the repo line when the apps repo cannot be reached, naming the repo from the settings", async () => {
    const seen: string[] = [];
    const ran = await broken({ pagesRepoReachable: async (repo) => (seen.push(repo), false) }, { settings: { GITHUB_PAGES_REPO: "made-up-apps" } });
    expect(seen).toEqual(["made-up-apps"]);
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([`  ${CROSS} The apps repo (made-up-apps) could not be reached on GitHub. Fix: check GITHUB_PAGES_REPO in .env, that the repo exists under the logged-in account, and the network`]);
  });

  it("crosses the browser line when Playwright's headless shell is missing", async () => {
    const ran = await broken({ headlessShellPresent: async () => false });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([`  ${CROSS} Playwright's headless browser is not installed, so the morning's tests cannot run. Fix: npx playwright install --only-shell`]);
  });

  it("crosses the jobs line naming each background job that is not installed", async () => {
    const one = await broken({ nightJobs: () => ({ build: true, deliver: false, crew: true }) });
    expect(one.code).toBe(1);
    // The fix names the job. A bare "scripts/install-agents.sh install" would also stop and restart the listener.
    expect(one.marked).toEqual([`  ${CROSS} Not installed: deliver. Fix: scripts/install-agents.sh install deliver`]);

    const none = await broken({ nightJobs: () => ({ build: false, deliver: false, crew: false }), crewJobSandbox: () => null });
    expect(none.marked).toEqual([
      // One command per job, the gateway first: the build needs it.
      `  ${CROSS} Not installed: build, deliver, Kiro Crew gateway. Fix: scripts/install-agents.sh install crew   then: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver`,
      `  ${DASH} Was the gateway job installed for this build sandbox? Not checked: the gateway job is not installed`,
    ]);
    for (const ran of [one, none]) expect(ran.lines.join("\n")).not.toMatch(/install-agents\.sh install(?! (crew|build|deliver|listen))/);
  });

  it("crosses the last line when the gateway job was installed for the other sandbox mode", async () => {
    // The setting says the gateway runs inside our sandbox, but the installed job starts it bare.
    const ran = await broken({ crewJobSandbox: () => "crew" });
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([`  ${CROSS} The gateway job was installed for BUILD_SANDBOX=crew, but the setting is now overnight. Fix: scripts/install-agents.sh install crew`]);

    const unreadable = await broken({ crewJobSandbox: () => null });
    expect(unreadable.marked).toEqual([`  ${DASH} Was the gateway job installed for this build sandbox? Not checked: its settings file could not be read`]);
  });

  it("goes on to the next line when a check throws or never answers, and never repeats what a program printed", async () => {
    const ran = await broken(
      {
        kiroSignedIn: () => never(),
        ghLoggedIn: async () => {
          throw new Error("gh did not answer within 30 seconds\n    at somewhere\n    someone@example.invalid");
        },
      },
      { checkLimitMs: 20 },
    );
    expect(ran.code).toBe(1);
    expect(ran.marked).toEqual([
      `  ${DASH} Is Kiro signed in? Not checked: This check was still going after 0 minutes, which is past its time limit.`,
      `  ${DASH} Is the GitHub CLI logged in? Not checked: gh did not answer within 30 seconds`,
      `  ${DASH} Can the apps repo be reached? Not checked: the GitHub CLI is not logged in`,
    ]);
    expect(ran.lines.join("\n")).not.toContain("example.invalid");
    // The checks after the broken ones were still made.
    expect(ran.lines).toContain(`  ${TICK} Playwright's headless browser is installed.`);
    expect(ran.last).toBe(`Not confirmed: 3 of 12 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);
  });

  it("changes nothing: it only reads the pause switch", async () => {
    const store = new Store(":memory:");
    const touched: string[] = [];
    const readOnly = new Proxy(store, {
      get(target, property, receiver) {
        touched.push(String(property));
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const out = capture();
    expect(await preflight({ store: readOnly, config: testConfig(), write: out.write, probes: allGood(), watchStopSignals: fakeStopSignals().watch })).toBe(0);
    expect([...new Set(touched)]).toEqual(["isPaused"]);
  });

  it("on a stop signal during the sandbox probe: aborts it, waits for it to remove its job, asks nothing more, and exits with the signal's code", async () => {
    const stop = fakeStopSignals();
    const steps: string[] = [];
    const running = run(
      {
        // A probe that keeps the builder's promise: when told to stop it removes its job and comes back.
        sandboxProbe: async (signal) => {
          steps.push("probe started");
          await aborted(signal);
          steps.push("probe job removed");
          return { ok: false, reason: "the build sandbox check failed: it could not be run (Overnight was being stopped)" };
        },
        ghLoggedIn: async () => (steps.push("gh asked"), true),
      },
      { watchStopSignals: stop.watch },
    );
    await expect.poll(() => steps).toEqual(["probe started"]);
    expect(stop.handlers()).toBe(3);
    stop.send("SIGINT");
    const ran = await running;
    expect(ran.code).toBe(130);
    expect(steps).toEqual(["probe started", "probe job removed"]);
    // The lines printed before the signal stay; nothing is printed about the checks that were not made.
    expect(ran.lines.at(-1)).toBe(PREFLIGHT_STOPPED);
    expect(ran.lines.filter((line) => line.startsWith(`  ${CROSS}`) || line.startsWith(`  ${DASH}`))).toEqual([]);
    expect(ran.lines).toHaveLength(8);
    expect(stop.handlers()).toBe(0);
  });

  it("on a stop signal during any other check: does not wait for it, and exits with the signal's code", async () => {
    const stop = fakeStopSignals();
    let probed = 0;
    const running = run({ kiroSignedIn: () => never(), sandboxProbe: async () => ((probed += 1), { ok: true }) }, { watchStopSignals: stop.watch });
    await expect.poll(() => stop.handlers()).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.send("SIGTERM");
    const ran = await running;
    expect(ran.code).toBe(143);
    expect(probed).toBe(0);
    expect(ran.lines).toEqual([PREFLIGHT_TITLE, `  ${TICK} Overnight is live (not paused).`, `  ${TICK} Bee is logged in.`, PREFLIGHT_STOPPED]);
    expect(stop.handlers()).toBe(0);
  });

  it("writes each kind of line the same way, and sums up plainly", () => {
    expect(formatCheck({ state: "pass", text: "Made-up thing is fine." })).toBe(`  ${TICK} Made-up thing is fine.`);
    expect(formatCheck({ state: "fail", text: "Made-up thing is off.", fix: "switch it on" })).toBe(`  ${CROSS} Made-up thing is off. Fix: switch it on`);
    expect(formatCheck({ state: "unchecked", text: "Is the made-up thing on?", why: "nobody was home" })).toBe(`  ${DASH} Is the made-up thing on? Not checked: nobody was home`);
    expect(verdict([{ state: "pass", text: "a" }])).toBe(PREFLIGHT_READY);
    expect(verdict([{ state: "pass", text: "a" }, { state: "unchecked", text: "f", why: "g" }])).toBe(`Not confirmed: 1 of 2 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);
    expect(verdict([{ state: "pass", text: "a" }, { state: "fail", text: "b", fix: "c" }, { state: "fail", text: "d", fix: "e" }, { state: "unchecked", text: "f", why: "g" }])).toBe(
      `Not ready: 2 failed, 1 could not be checked, of 4 checks. Fix what is marked ${CROSS} and run this again.`,
    );
  });
});
