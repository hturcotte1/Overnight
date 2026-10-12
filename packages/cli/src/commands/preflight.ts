// `overnight preflight`: everything that must be true for tonight's run, one line each, with a
// tick or a cross and, for a cross, the fix.
//
// It changes nothing: every check only looks. (The one check that does more than look is the
// sandbox probe, which is the builder's own: it adds a zero-credit Kiro Crew job, reads the
// counts and marks that job writes, and removes the job again. It is not made while a build is
// running on the same data folder: the two would get in each other's way, and that build makes
// the same check before its first Kiro Crew build.)
//
// A stop signal (Ctrl-C) ends it: the checks not yet made are skipped, and the sandbox probe, if
// it is the one running, is given the time to remove its job first.
//
// What the outside programs print often names an account (an email address, a user name). None
// of it is ever shown here: each check answers yes or no, and every sentence below is our own.
// This file holds the questions and the words. How each question is really asked of the Mac is in
// ../preflight-probes.ts, and tests pass fakes instead.
import { CLOCKED_JOBS, currentSlot, errorSummary, formatLocal, NIGHT_CHECK_FRESH_MS, readCheckedAt, readNightRun } from "@overnight/core";
import type { ClockedJob, Config, LoginState, Store } from "@overnight/core";
import { installCommand, installCommands, NIGHT_JOBS } from "../background.ts";
import type { JobTrigger, NightJobsState } from "../background.ts";
import { withDeadline } from "../deadline.ts";
import { oneLine } from "../output.ts";
import type { Write } from "../output.ts";
import { STOP_OVERDUE, watchStopSignals } from "../stop-signals.ts";
import type { WatchStopSignals } from "../stop-signals.ts";
import { nextStartAt, runNotStarting } from "./night-tick.ts";
import { recordAheadWords } from "./status.ts";

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
  /** How macOS starts the build and the deliver job: every minute ("timer") or still by its calendar. Null for a job whose settings file cannot be read. */
  nightJobTriggers(): Record<ClockedJob, JobTrigger | null>;
  /** Is the build, or the deliver, running on this data folder right now (is its lock held)? Null if that could not be told. */
  nightJobRunning(job: ClockedJob): boolean | null;
  /**
   * The gateway job's own copy of the sandbox rules (<data folder>/sandbox/crew-gateway.sb, made
   * by `install crew`) against the repo's packages/builder/sandbox/crew-gateway.sb.
   */
  gatewayProfileCopy(): "same" | "different" | "missing";
}

export interface PreflightDeps {
  store: Pick<Store, "isPaused" | "getValue">;
  config: Pick<Config, "pausedByDefault" | "buildSandbox" | "githubPagesRepo" | "timeZone" | "buildTime" | "deliverTime">;
  write: Write;
  probes: PreflightProbes;
  now?: () => Date;
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
/** Where the gateway job's own copy of the sandbox rules is kept, as said to a person. scripts/install-agents.sh makes it (installed_profile_of). */
const GATEWAY_COPY = "sandbox/crew-gateway.sb in the data folder";
const JOB_STATUS_COMMAND = "scripts/install-agents.sh status";
/** "3", for "in the last 3 minutes": how recent a job's last look at the clock has to be. */
const FRESH_MINUTES = Math.round(NIGHT_CHECK_FRESH_MS / 60_000);
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

/** Why a job that has stopped asking the clock is a problem, for one job or for both. */
function staleText(jobs: readonly ClockedJob[], checkedAt: Record<ClockedJob, string | null>, timeZone: string): string {
  const times = jobs.map((job) => checkedAt[job]);
  const known = times.filter((time): time is string => time !== null);
  // Both at once is the usual case (the Mac was asleep). When their stories differ, the first one is told.
  const told = jobs.length > 1 && (known.length === 0 || known.length === times.length) ? jobs : jobs.slice(0, 1);
  const who = told.length === 1 ? `The ${told[0]} job has` : `The ${told.join(" and ")} jobs have`;
  const then = told.length === 1 ? "so it would not start at its time" : "so they would not start at their times";
  const last = told.map((job) => checkedAt[job]).filter((time): time is string => time !== null).sort().at(-1);
  return last === undefined ? `${who} never checked the time, ${then}.` : `${who} not checked the time since ${formatLocal(new Date(last), timeZone)}, ${then}.`;
}

/**
 * What to do about it. Waiting comes first, on purpose: a Mac that has only just woken shows
 * exactly this for a minute or two, and installing a job again starts its clock from now, which
 * would skip a run that is still due.
 */
function staleFix(jobs: readonly ClockedJob[]): string {
  const commands = jobs.map((job) => `${JOB_STATUS_COMMAND} ${job}   then: ${installCommand(job)}`).join("   then: ");
  return `if the Mac has only just woken, wait two minutes and run this again. Otherwise: ${commands}`;
}

/** What it means that a job is awake and its due run does not start, for one job or for both. */
function notStartingText(jobs: readonly ClockedJob[], now: Date, config: Pick<Config, "timeZone" | "buildTime" | "deliverTime">): string {
  const work: Record<ClockedJob, string> = { build: "build", deliver: "delivery" };
  const due = (job: ClockedJob) => `the ${work[job]} that was due at ${formatLocal(currentSlot(job, now, config).at, config.timeZone)}`;
  const [first, second] = jobs;
  if (first === undefined) return "";
  if (second === undefined) return `The ${first} job is awake and tries every minute, but ${due(first)} does not start.`;
  return `The ${first} and ${second} jobs are awake and try every minute, but ${due(first)} and ${due(second)} do not start.`;
}

/** Where the reason is: each failed try leaves a line in the job's own log and in what it printed. */
function notStartingFix(jobs: readonly ClockedJob[]): string {
  return `the reason is in the last lines of ${jobs.map((job) => `logs/${job}.log`).join(" and ")}: ${jobs.map((job) => `${JOB_STATUS_COMMAND} ${job}`).join("   then: ")}`;
}

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
        // them this minute, and it makes this same check before its first Kiro Crew build.
        const building = probes.buildRunning();
        if (building !== false) {
          // "Makes", not "made": the build that is running may only just have begun, and one with nothing to build with Kiro Crew never gets that far.
          return unchecked(question, building === null ? "could not tell whether a build is running right now, and the check must not get in its way" : "a build is running on this data folder right now, and the check would get in its way. That build makes the same check itself before it builds anything with Kiro Crew: see logs/build.log");
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
    let installed: NightJobsState | null = null;
    await check("Are the night's background jobs installed?", () => {
      const state = probes.nightJobs();
      installed = state;
      gatewayJobInstalled = state.crew;
      const names: Record<keyof NightJobsState, string> = { build: "build", deliver: "deliver", crew: "Kiro Crew gateway" };
      const missing = NIGHT_JOBS.filter((job) => !state[job]);
      return missing.length === 0
        ? pass("The three background jobs are installed: build, deliver and the Kiro Crew gateway.")
        : // One command per missing job, each naming its job: a bare "install" would also restart the listener.
          fail(`Not installed: ${missing.map((job) => names[job]).join(", ")}.`, installCommands(missing));
    });

    await check("Do the night jobs keep their own time?", () => {
      const question = "Do the night jobs keep their own time?";
      const state = installed as NightJobsState | null;
      if (state === null) return unchecked(question, "could not tell which background jobs are installed");
      if (!state.build || !state.deliver) return unchecked(question, "the build and deliver jobs are not both installed");
      const triggers = probes.nightJobTriggers();
      const unread = CLOCKED_JOBS.filter((job) => triggers[job] === null);
      if (unread.length > 0) return unchecked(question, unread.length === 1 ? `the settings file of the ${unread[0]} job could not be read` : "the settings files of the build and deliver jobs could not be read");
      const onCalendar = CLOCKED_JOBS.filter((job) => triggers[job] === "calendar");
      if (onCalendar.length > 0) return fail(`Still on macOS's calendar: ${onCalendar.join(", ")}. That calendar ran both jobs an hour late on Oct 11.`, installCommands(onCalendar));

      const now = deps.now?.() ?? new Date();
      const records = { build: readNightRun(store, "build"), deliver: readNightRun(store, "deliver") };
      // A record dated after the day the job's clock has come to: a setting or the Mac's clock was
      // moved, and the job starts nothing until that day is past. Say when its next run really is.
      for (const job of CLOCKED_JOBS) {
        const record = records[job];
        const slot = currentSlot(job, now, config);
        if (record !== null && record.day > slot.day) {
          const said = recordAheadWords(job, record.day, { slotDay: slot.day, slotAt: slot.at.toISOString(), nextStartAt: nextStartAt(job, now, config, record).toISOString() }, config.timeZone);
          return fail(`The ${said}`, `${installCommand(job)}   (that starts the ${job} clock from now)`);
        }
      }
      // Awake means: asked the clock moments ago, or its lock is held right now (a job that is running does not ask).
      const lockHeld = { build: probes.nightJobRunning("build"), deliver: probes.nightJobRunning("deliver") };
      const running = CLOCKED_JOBS.filter((job) => lockHeld[job] === true);
      const checkedAt = { build: readCheckedAt(store, "build"), deliver: readCheckedAt(store, "deliver") };
      const asleep = CLOCKED_JOBS.filter((job) => {
        const at = checkedAt[job];
        return !running.includes(job) && !(at !== null && now.getTime() - Date.parse(at) <= NIGHT_CHECK_FRESH_MS);
      });
      if (asleep.length > 0) return fail(staleText(asleep, checkedAt, config.timeZone), staleFix(asleep));
      // Awake, and getting nowhere: a run is due, the job tries every minute, and the work never begins.
      const stuck = CLOCKED_JOBS.filter((job) => runNotStarting({ job, now, config, record: records[job], lockHeld: lockHeld[job] }));
      if (stuck.length > 0) return fail(notStartingText(stuck, now, config), notStartingFix(stuck));
      const ownTime = `The build and deliver jobs wake every minute and go by Overnight's own clock (${config.timeZone}).`;
      if (running.length === 0) return pass(`${ownTime} Both checked the time in the last ${FRESH_MINUTES} minutes.`);
      // A held lock says that a build (or a delivery) is running on this data folder, not who
      // started it: the job itself, a build-now or a run by hand. So that is all the line says.
      if (running.length === CLOCKED_JOBS.length) return pass(`${ownTime} A build and a delivery are running right now.`);
      const other = CLOCKED_JOBS.find((job) => !running.includes(job));
      return pass(`${ownTime} ${running[0] === "build" ? "A build" : "A delivery"} is running right now, and the ${other} job checked the time in the last ${FRESH_MINUTES} minutes.`);
    });

    await check("Was the gateway job installed for this build sandbox?", () => {
      const question = "Was the gateway job installed for this build sandbox?";
      if (!gatewayJobInstalled) return unchecked(question, "the gateway job is not installed");
      const installedFor = probes.crewJobSandbox();
      if (installedFor === null) return unchecked(question, "its settings file could not be read");
      if (installedFor !== mode) return fail(`The gateway job was installed for BUILD_SANDBOX=${installedFor}, but the setting is now ${mode}.`, INSTALL_CREW);
      if (mode !== "overnight") return pass(`The gateway job was installed for BUILD_SANDBOX=${mode}.`);
      // Inside Overnight's sandbox the gateway goes by its own copy of the rules. `install crew`
      // replaces that copy only once it has stopped the old gateway, so the copy is what the
      // gateway started behind. What is compared here is that copy and the repo's file: a copy
      // that is not the repo's means the rules changed since the gateway job was last installed.
      const copy = probes.gatewayProfileCopy();
      if (copy === "missing") return fail(`The gateway job's copy of the sandbox rules is missing (${GATEWAY_COPY}).`, INSTALL_CREW);
      if (copy === "different") return fail(`The gateway job's copy of the sandbox rules (${GATEWAY_COPY}) is not the repo's, so the gateway is not running behind the rules in this repo.`, INSTALL_CREW);
      return pass(`The gateway job was installed for BUILD_SANDBOX=${mode}, and its copy of the sandbox rules is the repo's.`);
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
