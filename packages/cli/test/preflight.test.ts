// All text in this file is made up for the tests. No Bee, Kiro, Kiro Crew, GitHub or network
// call is made: every one of preflight's questions is answered by a fake.
import { describe, expect, it } from "vitest";
import { BeeError, closedRun, currentSlot, noteChecked, noticedRun, startedRun, Store, waitingRun, writeNightRun } from "@overnight/core";
import type { ClockedJob } from "@overnight/core";
import { CROSS, DASH, formatCheck, preflight, PREFLIGHT_READY, PREFLIGHT_STOPPED, PREFLIGHT_TITLE, TICK, verdict } from "../src/commands/preflight.ts";
import type { PreflightProbes } from "../src/commands/preflight.ts";
import type { WatchStopSignals } from "../src/stop-signals.ts";
import { at, capture, fixedNow, testConfig } from "./helpers.ts";
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
    nightJobTriggers: () => note("triggers", { build: "timer" as const, deliver: "timer" as const }),
    nightJobRunning: (job) => note(`${job} lock`, false),
    gatewayProfileCopy: () => note("gateway copy", "same" as const),
    ...overrides,
  };
}

/** A database in which both night jobs asked the clock a minute before the made-up noon: awake, as on a Mac where all is well. */
function awakeStore(lastChecks: Partial<Record<ClockedJob, string | null>> = {}): Store {
  const store = new Store(":memory:");
  for (const job of ["build", "deliver"] as const) {
    const last = lastChecks[job] === undefined ? at(-60) : lastChecks[job];
    if (last !== null) noteChecked(store, job, new Date(last));
  }
  return store;
}

async function run(
  overrides: Partial<PreflightProbes> = {},
  options: { settings?: Record<string, string>; paused?: boolean; checkLimitMs?: number; watchStopSignals?: WatchStopSignals; store?: Store; now?: string } = {},
) {
  const out = capture();
  const store = options.store ?? awakeStore();
  if (options.paused) store.setPaused(true, at(0));
  const probes = allGood(overrides);
  // Made-up stop signals: no test listens to, or sends, a real one.
  const watchStopSignals = options.watchStopSignals ?? fakeStopSignals().watch;
  const code = await preflight({ store, config: testConfig(options.settings), write: out.write, now: fixedNow(options.now), probes, checkLimitMs: options.checkLimitMs, watchStopSignals });
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
      `  ${TICK} The build and deliver jobs wake every minute and go by Overnight's own clock (America/Boise). Both checked the time in the last 3 minutes.`,
      `  ${TICK} The gateway job was installed for BUILD_SANDBOX=overnight, and its copy of the sandbox rules is the repo's.`,
      PREFLIGHT_READY,
    ]);
    // Thirteen checks, and the title and the verdict around them.
    expect(ran.lines).toHaveLength(15);
    // Every question was asked once, and the sandbox mode asked about is the one in the settings.
    // (Before the probe, one look at the build lock: the probe must not get in the way of a build.)
    expect(ran.asked).toEqual(["bee", "kiro", "gateway", "crew settings for overnight", "skill", "build lock", "probe", "gh", "repo overnight-apps", "browser", "jobs", "triggers", "build lock", "deliver lock", "gateway job", "gateway copy"]);
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
      expect(ran.last).toBe(`Not ready: 1 failed, of 13 checks. Fix what is marked ${CROSS} and run this again.`);
    }
  });

  it("crosses the Bee line when Bee is logged out, and does not call it a pass when Bee will not say", async () => {
    const out = await broken({ beeLoginState: async () => "logged-out" });
    expect(out.code).toBe(1);
    expect(out.marked).toEqual([`  ${CROSS} Bee is logged out, so the link cannot be put on the wrist. Fix: log Bee in again (node spikes/00-bee-login.ts prints the link; the wearer approves it in the Bee app)`]);

    const unknown = await broken({ beeLoginState: async () => "unknown" });
    expect(unknown.code).toBe(1);
    expect(unknown.marked).toEqual([`  ${DASH} Is Bee logged in? Not checked: Bee did not answer`]);
    expect(unknown.last).toBe(`Not confirmed: 1 of 13 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);

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
    expect(ran.last).toBe(`Not ready: 1 failed, 1 could not be checked, of 13 checks. Fix what is marked ${CROSS} and run this again.`);
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
    expect(ran.last).toBe(`Not ready: 1 failed, of 13 checks. Fix what is marked ${CROSS} and run this again.`);

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
      `  ${DASH} Does the build sandbox hold? Not checked: a build is running on this data folder right now, and the check would get in its way. That build makes the same check itself before it builds anything with Kiro Crew: see logs/build.log`,
    ]);
    // The build that holds the lock may have begun a second ago, or have nothing to build with
    // Kiro Crew at all: the line must not say it has already made the check.
    expect(building.lines.join("\n")).not.toContain("made the same check");
    // Nothing is known to be wrong, so nothing is called a failure. It is still not "ready", and the exit code says so.
    expect(building.last).toBe(`Not confirmed: 1 of 13 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);

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
    // With one of the two clocked jobs missing, there is no telling whether "they" keep their own time.
    expect(one.marked).toEqual([
      `  ${CROSS} Not installed: deliver. Fix: scripts/install-agents.sh install deliver`,
      `  ${DASH} Do the night jobs keep their own time? Not checked: the build and deliver jobs are not both installed`,
    ]);

    const none = await broken({ nightJobs: () => ({ build: false, deliver: false, crew: false }), crewJobSandbox: () => null });
    expect(none.marked).toEqual([
      // One command per job, the gateway first: the build needs it.
      `  ${CROSS} Not installed: build, deliver, Kiro Crew gateway. Fix: scripts/install-agents.sh install crew   then: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver`,
      `  ${DASH} Do the night jobs keep their own time? Not checked: the build and deliver jobs are not both installed`,
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

  it("crosses the last line when the gateway is running behind a copy of the sandbox rules that is not the repo's, or has none", async () => {
    // The line says what was compared: the job's own copy and the repo's file.
    const different = await broken({ gatewayProfileCopy: () => "different" });
    expect(different.code).toBe(1);
    expect(different.marked).toEqual([
      `  ${CROSS} The gateway job's copy of the sandbox rules (sandbox/crew-gateway.sb in the data folder) is not the repo's, so the gateway is not running behind the rules in this repo. Fix: scripts/install-agents.sh install crew`,
    ]);
    const missing = await broken({ gatewayProfileCopy: () => "missing" });
    expect(missing.code).toBe(1);
    expect(missing.marked).toEqual([`  ${CROSS} The gateway job's copy of the sandbox rules is missing (sandbox/crew-gateway.sb in the data folder). Fix: scripts/install-agents.sh install crew`]);
    // In crew mode the gateway has no rules of ours to copy: the copy is not looked at.
    const crew = await run({ crewJobSandbox: () => "crew", gatewayProfileCopy: () => "missing" }, { settings: { BUILD_SANDBOX: "crew" } });
    expect(crew.code).toBe(0);
    expect(crew.asked).not.toContain("gateway copy");
    // Installed for the other mode: that is said first, and it is the whole of the trouble.
    const otherMode = await broken({ crewJobSandbox: () => "crew", gatewayProfileCopy: () => "different" });
    expect(otherMode.marked).toEqual([`  ${CROSS} The gateway job was installed for BUILD_SANDBOX=crew, but the setting is now overnight. Fix: scripts/install-agents.sh install crew`]);
    // The copy cannot be compared at all: not a pass.
    const threw = await broken({
      gatewayProfileCopy: () => {
        throw new Error("packages/builder/sandbox/crew-gateway.sb could not be read");
      },
    });
    expect(threw.marked).toEqual([`  ${DASH} Was the gateway job installed for this build sandbox? Not checked: packages/builder/sandbox/crew-gateway.sb could not be read`]);
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
    expect(ran.last).toBe(`Not confirmed: 3 of 13 checks could not be made (marked ${DASH}). Everything that was checked is in place.`);
  });

  it("changes nothing: it only reads the pause switch and the night clock's stored values", async () => {
    const store = awakeStore();
    const touched: string[] = [];
    const readOnly = new Proxy(store, {
      get(target, property, receiver) {
        touched.push(String(property));
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const out = capture();
    expect(await preflight({ store: readOnly, config: testConfig(), write: out.write, now: fixedNow(), probes: allGood(), watchStopSignals: fakeStopSignals().watch })).toBe(0);
    expect([...new Set(touched)]).toEqual(["isPaused", "getValue"]);
  });

  describe("do the night jobs keep their own time?", () => {
    const QUESTION = "Do the night jobs keep their own time?";
    const STALE_FIX = (jobs: string[]) => `if the Mac has only just woken, wait two minutes and run this again. Otherwise: ${jobs.map((job) => `scripts/install-agents.sh status ${job}   then: scripts/install-agents.sh install ${job}`).join("   then: ")}`;

    it("crosses the line when a job is still on macOS's calendar, naming it, with the command that moves it", async () => {
      const both = await broken({ nightJobTriggers: () => ({ build: "calendar", deliver: "calendar" }) });
      expect(both.code).toBe(1);
      expect(both.marked).toEqual([`  ${CROSS} Still on macOS's calendar: build, deliver. That calendar ran both jobs an hour late on Oct 11. Fix: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver`]);
      const one = await broken({ nightJobTriggers: () => ({ build: "timer", deliver: "calendar" }) });
      expect(one.marked).toEqual([`  ${CROSS} Still on macOS's calendar: deliver. That calendar ran both jobs an hour late on Oct 11. Fix: scripts/install-agents.sh install deliver`]);
      // A job on the calendar is said first: whether it has checked the time lately is beside the point.
      const stale = await broken({ nightJobTriggers: () => ({ build: "calendar", deliver: "timer" }) }, { store: awakeStore({ build: null, deliver: null }) });
      expect(stale.marked).toEqual([`  ${CROSS} Still on macOS's calendar: build. That calendar ran both jobs an hour late on Oct 11. Fix: scripts/install-agents.sh install build`]);
    });

    it("does not call it either way when the look at the installed jobs itself failed", async () => {
      const ran = await broken({
        nightJobs: () => {
          throw new Error("made-up: the folder could not be listed");
        },
      });
      expect(ran.marked).toEqual([
        `  ${DASH} Are the night's background jobs installed? Not checked: made-up: the folder could not be listed`,
        `  ${DASH} ${QUESTION} Not checked: could not tell which background jobs are installed`,
        `  ${DASH} Was the gateway job installed for this build sandbox? Not checked: the gateway job is not installed`,
      ]);
    });

    it("does not call it either way when a job's settings file cannot be read", async () => {
      const ran = await broken({ nightJobTriggers: () => ({ build: "timer", deliver: null }) });
      expect(ran.code).toBe(1);
      expect(ran.marked).toEqual([`  ${DASH} ${QUESTION} Not checked: the settings file of the deliver job could not be read`]);
      const both = await broken({ nightJobTriggers: () => ({ build: null, deliver: null }) });
      expect(both.marked).toEqual([`  ${DASH} ${QUESTION} Not checked: the settings files of the build and deliver jobs could not be read`]);
    });

    it("crosses the line when a job has not checked the time lately, says since when, and says to wait before installing anything", async () => {
      // The deliver job last asked the clock at 9:02 am on Oct 9. Now it is noon.
      const one = await broken({}, { store: awakeStore({ deliver: "2026-10-09T15:02:00.000Z" }) });
      expect(one.code).toBe(1);
      expect(one.marked).toEqual([`  ${CROSS} The deliver job has not checked the time since Oct 9, 9:02 AM, so it would not start at its time. Fix: ${STALE_FIX(["deliver"])}`]);

      const never = await broken({}, { store: awakeStore({ build: null }) });
      expect(never.marked).toEqual([`  ${CROSS} The build job has never checked the time, so it would not start at its time. Fix: ${STALE_FIX(["build"])}`]);

      // Both at once is what a Mac that has only just woken shows: one line for the two, with the later of their times.
      const both = await broken({}, { store: awakeStore({ build: "2026-10-09T05:01:00.000Z", deliver: "2026-10-09T05:02:00.000Z" }) });
      expect(both.marked).toEqual([`  ${CROSS} The build and deliver jobs have not checked the time since Oct 8, 11:02 PM, so they would not start at their times. Fix: ${STALE_FIX(["build", "deliver"])}`]);
      const neither = await broken({}, { store: awakeStore({ build: null, deliver: null }) });
      expect(neither.marked).toEqual([`  ${CROSS} The build and deliver jobs have never checked the time, so they would not start at their times. Fix: ${STALE_FIX(["build", "deliver"])}`]);
      // One never, one long ago: the first one's story is told, and the fix still names both.
      const mixed = await broken({}, { store: awakeStore({ build: null, deliver: "2026-10-09T05:02:00.000Z" }) });
      expect(mixed.marked).toEqual([`  ${CROSS} The build job has never checked the time, so it would not start at its time. Fix: ${STALE_FIX(["build", "deliver"])}`]);
    });

    it("takes three minutes as lately, to the millisecond, by the clock it is given", async () => {
      const justInTime = await run({}, { store: awakeStore({ build: at(-180), deliver: at(-180) }) });
      expect(justInTime.code).toBe(0);
      const justTooLong = await broken({}, { store: awakeStore({ build: "2026-10-09T17:56:59.999Z" }) });
      expect(justTooLong.marked[0]).toContain("The build job has not checked the time since Oct 9, 11:56 AM");
      // The same heartbeats, an hour later.
      const later = await broken({}, { now: at(3600) });
      expect(later.marked[0]).toContain("The build and deliver jobs have not checked the time since Oct 9, 11:59 AM");
    });

    it("takes a job whose lock is held right now as awake, and says only what a held lock shows: a build or a delivery is running", async () => {
      const OWN_TIME = "The build and deliver jobs wake every minute and go by Overnight's own clock (America/Boise).";
      // The build has been going for forty minutes: it has not asked the clock since it started.
      const store = awakeStore({ build: at(-2400) });
      const building = await run({ nightJobRunning: (job) => job === "build" }, { store });
      expect(building.code).toBe(0);
      expect(building.lines).toContain(`  ${TICK} ${OWN_TIME} A build is running right now, and the deliver job checked the time in the last 3 minutes.`);
      const delivering = await run({ nightJobRunning: (job) => job === "deliver" }, { store: awakeStore({ deliver: at(-600) }) });
      expect(delivering.lines).toContain(`  ${TICK} ${OWN_TIME} A delivery is running right now, and the build job checked the time in the last 3 minutes.`);
      const both = await run({ nightJobRunning: () => true }, { store: awakeStore({ build: null, deliver: null }) });
      expect(both.lines).toContain(`  ${TICK} ${OWN_TIME} A build and a delivery are running right now.`);
      // A build-now, or a build started by hand, holds the same lock while the build job goes on
      // checking the time every minute. The lock does not say who has it, so no line may say that
      // the job itself is the one running.
      const byHand = await run({ nightJobRunning: (job) => job === "build" });
      expect(byHand.code).toBe(0);
      expect(byHand.lines).toContain(`  ${TICK} ${OWN_TIME} A build is running right now, and the deliver job checked the time in the last 3 minutes.`);
      for (const ran of [building, delivering, both, byHand]) expect(ran.text).not.toMatch(/job is running right now|Both are running/);
      // Not being able to tell is not "running".
      const unknown = await broken({ nightJobRunning: () => null }, { store });
      expect(unknown.marked[0]).toContain("The build job has not checked the time since");
    });

    it("crosses the line when a clock's record is dated ahead, and says when that job's next run really is", async () => {
      const store = awakeStore();
      // The Mac's clock once read January 5: the deliver job's record is from then.
      const then = new Date("2027-01-05T14:00:00.000Z");
      writeNightRun(store, "deliver", closedRun(noticedRun(currentSlot("deliver", then, testConfig()), then), "first-check", then), then);
      const ran = await broken({}, { store });
      expect(ran.code).toBe(1);
      expect(ran.marked).toEqual([
        `  ${CROSS} The deliver clock already has Jan 5, 2027 on record, so the next deliver is Jan 6, 2027, 6:30 AM (DELIVER_TIME, TZ or the Mac's clock was moved). Fix: scripts/install-agents.sh install deliver   (that starts the deliver clock from now)`,
      ]);
      // A record of today's slot, or of an earlier one, is as it should be.
      const usual = awakeStore();
      const noon = new Date(at(0));
      for (const job of ["build", "deliver"] as const) writeNightRun(usual, job, closedRun(noticedRun(currentSlot(job, noon, testConfig()), noon), "first-check", noon), noon);
      expect((await run({}, { store: usual })).code).toBe(0);
    });

    it("does not promise today's new time after BUILD_TIME was moved later on a day whose build had already run", async () => {
      // Oct 9: the build ran at 1:00 am. At noon BUILD_TIME is 15:00. The clock starts nothing at 3:00 pm today.
      const store = awakeStore();
      const ranAt = new Date("2026-10-09T07:00:05.000Z");
      writeNightRun(store, "build", closedRun(startedRun(noticedRun(currentSlot("build", ranAt, testConfig()), ranAt), ranAt), "done", new Date("2026-10-09T07:20:00.000Z")), ranAt);
      const ran = await broken({}, { store, settings: { BUILD_TIME: "15:00" } });
      expect(ran.code).toBe(1);
      expect(ran.marked).toEqual([
        `  ${CROSS} The build clock already has Oct 9 on record, so the next build is Oct 10, 3:00 PM (BUILD_TIME, TZ or the Mac's clock was moved). Fix: scripts/install-agents.sh install build   (that starts the build clock from now)`,
      ]);
      expect(ran.lines.join("\n")).not.toContain("nothing runs until then");
      // Once today's new time has come round, the record is today's and nothing is wrong: the next build is tomorrow's.
      const later = awakeStore({ build: "2026-10-09T21:29:30.000Z", deliver: "2026-10-09T21:29:30.000Z" });
      writeNightRun(later, "build", closedRun(startedRun(noticedRun(currentSlot("build", ranAt, testConfig()), ranAt), ranAt), "done", new Date("2026-10-09T07:20:00.000Z")), ranAt);
      expect((await run({}, { store: later, settings: { BUILD_TIME: "15:00" }, now: "2026-10-09T21:30:00.000Z" })).code).toBe(0);
    });

    it("crosses the line when a job is awake and the run that is due does not start, and says where the reason is", async () => {
      // 1:29 am on Oct 9. The build's time came at 1:00 am; it was first tried then, and every try since has ended before the work began.
      const NOW = "2026-10-09T07:29:30.000Z";
      const tried = (job: ClockedJob, firstTry: string): Store => {
        const store = awakeStore({ build: "2026-10-09T07:29:00.000Z", deliver: "2026-10-09T07:29:00.000Z" });
        const first = new Date(firstTry);
        writeNightRun(store, job, noticedRun(currentSlot(job, first, testConfig()), first), first);
        return store;
      };
      const stuck = await broken({}, { store: tried("build", "2026-10-09T07:00:05.000Z"), now: NOW });
      expect(stuck.code).toBe(1);
      expect(stuck.marked).toEqual([
        `  ${CROSS} The build job is awake and tries every minute, but the build that was due at Oct 9, 1:00 AM does not start. Fix: the reason is in the last lines of logs/build.log: scripts/install-agents.sh status build`,
      ]);
      // Three minutes after the first try, to the millisecond, is not yet long enough to say so.
      expect((await run({}, { store: tried("build", "2026-10-09T07:26:30.000Z"), now: NOW })).code).toBe(0);
      expect((await broken({}, { store: tried("build", "2026-10-09T07:26:29.999Z"), now: NOW })).marked[0]).toContain("does not start");
      // While some run holds the build lock, a try may be going, or another build is: that is the "running right now" line.
      const held = await run({ nightJobRunning: (job) => job === "build" }, { store: tried("build", "2026-10-09T07:00:05.000Z"), now: NOW });
      expect(held.code).toBe(0);
      expect(held.text).toContain("A build is running right now, and the deliver job checked the time in the last 3 minutes.");
      // A run that is waiting for something it has stored (the internet) is not one that does not start.
      const waiting = tried("build", "2026-10-09T07:00:05.000Z");
      const first = new Date("2026-10-09T07:00:05.000Z");
      writeNightRun(waiting, "build", waitingRun(noticedRun(currentSlot("build", first, testConfig()), first), "offline"), first);
      expect((await run({}, { store: waiting, now: NOW })).code).toBe(0);

      // Both jobs at once, in the morning: one line for the two.
      const morning = "2026-10-09T12:45:30.000Z";
      const both = awakeStore({ build: "2026-10-09T12:45:00.000Z", deliver: "2026-10-09T12:45:00.000Z" });
      for (const [job, firstTry] of [["build", "2026-10-09T07:00:05.000Z"], ["deliver", "2026-10-09T12:30:05.000Z"]] as const) {
        writeNightRun(both, job, noticedRun(currentSlot(job, new Date(firstTry), testConfig()), new Date(firstTry)), new Date(firstTry));
      }
      expect((await broken({}, { store: both, now: morning })).marked).toEqual([
        `  ${CROSS} The build and deliver jobs are awake and try every minute, but the build that was due at Oct 9, 1:00 AM and the delivery that was due at Oct 9, 6:30 AM do not start. Fix: the reason is in the last lines of logs/build.log and logs/deliver.log: scripts/install-agents.sh status build   then: scripts/install-agents.sh status deliver`,
      ]);
    });

    it("names the time zone from the settings", async () => {
      const ran = await run({}, { settings: { TZ: "Europe/Vienna" } });
      expect(ran.lines).toContain(`  ${TICK} The build and deliver jobs wake every minute and go by Overnight's own clock (Europe/Vienna). Both checked the time in the last 3 minutes.`);
    });
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
