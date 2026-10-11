// `overnight preflight`: everything that must be true for tonight's run, one line each, with a
// tick or a cross and, for a cross, the fix.
//
// It changes nothing: every check only looks. (The one check that does more than look is the
// sandbox probe, which is the builder's own: it adds a zero-credit Kiro Crew job, reads the
// counts and marks that job writes, and removes the job again. It is not made while a build is
// running on the same data folder: the two would get in each other's way, and that build made
// the same check before its first Kiro Crew build.)
//
// A stop signal (Ctrl-C) ends it: the checks not yet made are skipped, and the sandbox probe, if
// it is the one running, is given the time to remove its job first.
//
// What the outside programs print often names an account (an email address, a user name). None
// of it is ever shown here: each check answers yes or no, and every sentence below is our own.
// This file holds the questions and the words. How each question is really asked of the Mac is in
// ../preflight-probes.ts, and tests pass fakes instead.
import { errorSummary } from "@overnight/core";
import type { Config, LoginState, Store } from "@overnight/core";
import { installCommand, installCommands, NIGHT_JOBS } from "../background.ts";
import type { NightJobsState } from "../background.ts";
import { withDeadline } from "../deadline.ts";
import { oneLine } from "../output.ts";
import type { Write } from "../output.ts";
import { STOP_OVERDUE, watchStopSignals } from "../stop-signals.ts";
import type { WatchStopSignals } from "../stop-signals.ts";

export type SandboxProbeResult = { ok: true } | { ok: false; reason: string };

/** Everything preflight asks of the world outside the database. Each may throw: that is "could not be checked". */
export interface PreflightProbes {
  /** `bee me`, through @overnight/bee. */
  beeLoginState(): Promise<LoginState>;
  /** `kiro-cli whoami`. What it prints (the account's email address) goes nowhere. */
  kiroSignedIn(): Promise<boolean>;
  /** Does the Kiro Crew gateway on this Mac answer? */
  gatewayAnswers(): Promise<boolean>;
  /** Is Kiro Crew set the way this sandbox mode needs? Null when it is; otherwise why not, in our own words. */
  crewSettingsProblem(mode: Config["buildSandbox"]): Promise<string | null>;
  /** Is the skill installed in Kiro Crew the text of crew/build-skill.md? */
  installedSkill(): Promise<"same" | "different" | "missing">;
  /**
   * The builder's own sandbox probe (runStandaloneSandboxProbe in @overnight/builder): from inside
   * a Kiro Crew job, are the Keychain, the Bee login and the transcripts out of reach, and can
   * nothing be written where our own programs are run from? It never throws. When `signal` is
   * aborted it ends at once and removes its job.
   */
  sandboxProbe(signal?: AbortSignal): Promise<SandboxProbeResult>;
  /** Is a build running on this data folder right now (is the build lock held)? Null if that could not be told. */
  buildRunning(): boolean | null;
  /** `gh auth status`, found the way the deliver job will find gh. What it prints goes nowhere. */
  ghLoggedIn(): Promise<boolean>;
  /** Can the logged-in GitHub account see the repo that published apps go to? */
  pagesRepoReachable(repo: string): Promise<boolean>;
  /** Is Playwright's small headless browser on this Mac? The morning's tests run in it. */
  headlessShellPresent(): Promise<boolean>;
  /** Which of the night's background jobs have a settings file in ~/Library/LaunchAgents? */
  nightJobs(): NightJobsState;
  /** How the installed gateway job starts the gateway; null if it is not installed or cannot be read. */
  crewJobSandbox(): "overnight" | "crew" | null;
}

export interface PreflightDeps {
  store: Pick<Store, "isPaused">;
  config: Pick<Config, "pausedByDefault" | "buildSandbox" | "githubPagesRepo">;
  write: Write;
  probes: PreflightProbes;
  /** For tests: the longest any one check may take, in milliseconds. */
  checkLimitMs?: number;
  /** Watches for stop signals while the checks run. Default: the real one (stop-signals.ts). */
  watchStopSignals?: WatchStopSignals;
}

export type CheckLine =
  | { state: "pass"; text: string }
  | { state: "fail"; text: string; fix: string }
  /** Could not be looked at, for the reason given. Not a pass. */
  | { state: "unchecked"; text: string; why: string };

export const TICK = "✓";
export const CROSS = "✗";
/** For a check that was not made. */
export const DASH = "–";

export const PREFLIGHT_TITLE = "Overnight preflight: what tonight's run needs";
export const PREFLIGHT_READY = "Ready: everything tonight's run needs is in place.";
export const PREFLIGHT_STOPPED = "Stopped: not every check was made.";
/** The words the builder puts in front of a failed sandbox check. Our own line already says as much. */
const SANDBOX_REASON_PREFIX = /^the build sandbox check failed:\s*/i;

const INSTALL_CREW = installCommand("crew");
const KIROCREW = "~/.local/bin/kirocrew";
/** The sandbox probe is a Kiro Crew job with its own 3-minute limit. Everything else answers in seconds. */
const CHECK_LIMIT_MS = 4 * 60_000;

const pass = (text: string): CheckLine => ({ state: "pass", text });
const fail = (text: string, fix: string): CheckLine => ({ state: "fail", text, fix });
const unchecked = (text: string, why: string): CheckLine => ({ state: "unchecked", text, why });

export function formatCheck(line: CheckLine): string {
  if (line.state === "pass") return `  ${TICK} ${line.text}`;
  if (line.state === "fail") return `  ${CROSS} ${line.text} Fix: ${line.fix}`;
  return `  ${DASH} ${line.text} Not checked: ${line.why}`;
}

/** The last line: ready, or how many checks stand in the way. */
export function verdict(lines: readonly CheckLine[]): string {
  const failed = lines.filter((line) => line.state === "fail").length;
  const skipped = lines.filter((line) => line.state === "unchecked").length;
  if (failed === 0 && skipped === 0) return PREFLIGHT_READY;
  // Nothing is known to be wrong, but "ready" would be saying more than was looked at.
  if (failed === 0) return `Not confirmed: ${skipped} of ${lines.length} checks could not be made (marked ${DASH}). Everything that was checked is in place.`;
  const parts = [`${failed} failed`, ...(skipped > 0 ? [`${skipped} could not be checked`] : [])];
  return `Not ready: ${parts.join(", ")}, of ${lines.length} checks. Fix what is marked ${CROSS} and run this again.`;
}

/** How to set Kiro Crew for each mode. A setting only takes effect when the gateway starts again, which the install does. */
const CREW_SETTING_FIX: Record<Config["buildSandbox"], string> = {
  overnight: `${KIROCREW} config set agent.sandbox_allow_unsandboxed_exec true   then: ${INSTALL_CREW}`,
  crew: `${KIROCREW} config set agent.sandbox strict   and: ${KIROCREW} config set agent.sandbox_allow_unsandboxed_exec false   then: ${INSTALL_CREW}`,
};

/**
 * Resolves with the exit code: 0 only when every check passed. A check that could not be made is
 * not a pass. Each line is printed as soon as its check has answered.
 */
export async function preflight(deps: PreflightDeps): Promise<number> {
  const { store, config, write, probes } = deps;
  const limitMs = deps.checkLimitMs ?? CHECK_LIMIT_MS;
  const mode = config.buildSandbox;
  const lines: CheckLine[] = [];

  const stop = (deps.watchStopSignals ?? watchStopSignals)();
  const STOPPED = Symbol("stopped");
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    stop.signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  const whyStopped = "preflight was stopped";

  /**
   * Run one check and print its line. A check that throws or never answers is "could not be
   * checked", in our own words. After a stop signal nothing more is asked or printed. `signal`
   * is aborted when the check is given up on (a stop signal, or its time limit): the sandbox
   * probe listens to it, and is the one check that is waited for after a stop signal.
   */
  const check = async (what: string, run: (signal: AbortSignal) => Promise<CheckLine> | CheckLine, options: { waitWhenStopped?: boolean } = {}): Promise<CheckLine> => {
    let line: CheckLine;
    if (stop.signal.aborted) {
      line = unchecked(what, whyStopped);
    } else {
      const givenUp = new AbortController();
      try {
        const work = withDeadline(
          Promise.resolve().then(() => run(AbortSignal.any([stop.signal, givenUp.signal]))),
          limitMs,
          "This check",
        );
        // Whichever way the wait below ends, a late error from the work must not stop Node.
        work.catch(() => {});
        const answer = await (options.waitWhenStopped ? stop.settle(work) : Promise.race([work, stopped]));
        line = answer === STOPPED || answer === STOP_OVERDUE ? unchecked(what, whyStopped) : answer;
      } catch (error) {
        givenUp.abort();
        line = unchecked(what, oneLine(errorSummary(error)));
      }
    }
    lines.push(line);
    if (!stop.signal.aborted) write(formatCheck(line));
    return line;
  };

  const runChecks = async (): Promise<number> => {
    write(PREFLIGHT_TITLE);

    await check("Is Overnight live?", () =>
      store.isPaused(config.pausedByDefault) ? fail("Overnight is paused, so nothing is asked or built.", "npx overnight resume") : pass("Overnight is live (not paused)."),
    );

    await check("Is Bee logged in?", async () => {
      const state = await probes.beeLoginState();
      if (state === "logged-in") return pass("Bee is logged in.");
      if (state === "logged-out") return fail("Bee is logged out, so the link cannot be put on the wrist.", "log Bee in again (node spikes/00-bee-login.ts prints the link; the wearer approves it in the Bee app)");
      return unchecked("Is Bee logged in?", "Bee did not answer");
    });

    await check("Is Kiro signed in?", async () =>
      (await probes.kiroSignedIn()) ? pass("Kiro is signed in.") : fail("Kiro is signed out on this Mac, so nothing can be built.", "kiro-cli login"),
    );

    const gateway = await check("Does the Kiro Crew gateway answer?", async () =>
      (await probes.gatewayAnswers())
        ? pass("The Kiro Crew gateway is running.")
        : fail("The Kiro Crew gateway does not answer, so builds would fall back to Kiro CLI.", `${INSTALL_CREW}   (why it is down: scripts/install-agents.sh status crew)`),
    );

    await check("Is Kiro Crew set up for this build sandbox?", async () => {
      const problem = await probes.crewSettingsProblem(mode);
      return problem === null
        ? pass(`Kiro Crew is set up for BUILD_SANDBOX=${mode}.`)
        : fail(`Kiro Crew is not set up for BUILD_SANDBOX=${mode}: ${oneLine(problem).replace(SANDBOX_REASON_PREFIX, "")}.`, CREW_SETTING_FIX[mode]);
    });

    await check("Is the build skill installed?", async () => {
      const skill = await probes.installedSkill();
      if (skill === "same") return pass("The build skill installed in Kiro Crew is the one in crew/build-skill.md.");
      return fail(skill === "missing" ? "The build skill is not installed in Kiro Crew." : "The build skill installed in Kiro Crew is not the one in crew/build-skill.md.", INSTALL_CREW);
    });

    await check(
      "Does the build sandbox hold?",
      async (signal) => {
        const question = "Does the build sandbox hold?";
        if (mode === "crew") return pass("No sandbox probe in this mode (BUILD_SANDBOX=crew: Kiro Crew's own sandbox, which is not probed).");
        if (gateway.state !== "pass") return unchecked(question, "the probe is a Kiro Crew job, and the gateway is not running");
        // The probe uses one job name and one results folder. A build that is running may be using
        // them this minute, and it made this same check before its first Kiro Crew build.
        const building = probes.buildRunning();
        if (building !== false) {
          return unchecked(question, building === null ? "could not tell whether a build is running right now, and the check must not get in its way" : "a build is running on this data folder right now, and the check would get in its way. That build made the same check itself: see logs/build.log");
        }
        const result = await probes.sandboxProbe(signal);
        return result.ok
          ? pass("The build sandbox holds: from inside a Kiro Crew job, the GitHub login, the Bee login and the transcripts are out of reach, and nothing can be written where Overnight's own programs run from.")
          : fail(`The build sandbox check did not pass: ${oneLine(result.reason).replace(SANDBOX_REASON_PREFIX, "")}.`, `${INSTALL_CREW}   then run this again. Until it passes, nothing is built with Kiro Crew`);
      },
      { waitWhenStopped: true },
    );

    const gh = await check("Is the GitHub CLI logged in?", async () =>
      (await probes.ghLoggedIn()) ? pass("The GitHub CLI (gh) is logged in.") : fail("The GitHub CLI (gh) is not logged in, or was not found, so nothing can be published.", "gh auth login"),
    );

    await check("Can the apps repo be reached?", async () => {
      const question = "Can the apps repo be reached?";
      if (gh.state !== "pass") return unchecked(question, "the GitHub CLI is not logged in");
      return (await probes.pagesRepoReachable(config.githubPagesRepo))
        ? pass(`The apps repo (${config.githubPagesRepo}) can be reached on GitHub.`)
        : fail(`The apps repo (${config.githubPagesRepo}) could not be reached on GitHub.`, "check GITHUB_PAGES_REPO in .env, that the repo exists under the logged-in account, and the network");
    });

    await check("Is the headless browser installed?", async () =>
      (await probes.headlessShellPresent())
        ? pass("Playwright's headless browser is installed.")
        : fail("Playwright's headless browser is not installed, so the morning's tests cannot run.", "npx playwright install --only-shell"),
    );

    let gatewayJobInstalled = false;
    await check("Are the night's background jobs installed?", () => {
      const state = probes.nightJobs();
      gatewayJobInstalled = state.crew;
      const names: Record<keyof NightJobsState, string> = { build: "build", deliver: "deliver", crew: "Kiro Crew gateway" };
      const missing = NIGHT_JOBS.filter((job) => !state[job]);
      return missing.length === 0
        ? pass("The three background jobs are installed: build, deliver and the Kiro Crew gateway.")
        : // One command per missing job, each naming its job: a bare "install" would also restart the listener.
          fail(`Not installed: ${missing.map((job) => names[job]).join(", ")}.`, installCommands(missing));
    });

    await check("Was the gateway job installed for this build sandbox?", () => {
      const question = "Was the gateway job installed for this build sandbox?";
      if (!gatewayJobInstalled) return unchecked(question, "the gateway job is not installed");
      const installed = probes.crewJobSandbox();
      if (installed === null) return unchecked(question, "its settings file could not be read");
      return installed === mode
        ? pass(`The gateway job was installed for BUILD_SANDBOX=${mode}.`)
        : fail(`The gateway job was installed for BUILD_SANDBOX=${installed}, but the setting is now ${mode}.`, INSTALL_CREW);
    });

    const stopCode = stop.exitCode();
    if (stopCode !== null) {
      write(PREFLIGHT_STOPPED);
      return stopCode;
    }
    write(verdict(lines));
    return lines.every((line) => line.state === "pass") ? 0 : 1;
  };

  try {
    return await runChecks();
  } finally {
    stop.close();
  }
}
