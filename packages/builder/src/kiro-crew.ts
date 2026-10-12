// The primary build backend: one Kiro Crew agent job per idea.
//
// The job is given one sentence (crew/nightly-job.md) with the full paths of the brief and the
// workspace. It never sees the database or the overnight command line, and it never publishes:
// our own code decides whether the build worked, from the files it leaves (build-status.ts).
//
// The recipe is the one the Milestone 2 experiments ran (see crew-client.ts for the details):
//   kirocrew cron add "overnight-build-<idea id>" "<message>" --cron "0 3 1 1 *" --timezone <zone>
//       --approval-mode auto --no-persistent-session --timeout-secs <limit>
//   kirocrew cron trigger <id>      -> must print "Triggered job:"
//   watch <crew home>/cron-running and cron-history until the run is over, or our own limit passes
//   cancel the run if it is not over (our limit passed, or Overnight is being stopped)
//   kirocrew cron remove <id>       -> always, whatever happened
// `--minimal-context` is left off on purpose: with it the agent did not see the skill.
//
// In "overnight" mode (the gateway runs inside our sandbox, sandbox/crew-gateway.sb) every
// kirocrew command above runs inside that same sandbox. Kiro Crew's own files can be written by
// a job, so nothing of Kiro Crew's is run outside the fence by the nightly build.
//
// This file never changes a Kiro Crew setting. It reads two (to refuse to build when the sandbox
// is not the one the BUILD_SANDBOX setting says) and it checks that the installed skill is ours.
//
// runStandaloneSandboxProbe (at the end) is the same sandbox check on its own, for `overnight
// preflight`: it reaches Kiro Crew through the very code the backend uses (crewAccess below).
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config, DataPaths, Logger } from "@overnight/core";
import { checkBuildResult } from "./build-status.ts";
import { abortableSleep, BUILD_JOB_PREFIX, createCrewClient, crewTimeZone, defaultCrewHome, defaultKiroHome, defaultKirocrewBinary, GATEWAY_NOT_RUNNING, gatewayAnswers, gatewayPort, NEVER_DUE_CRON } from "./crew-client.ts";
import type { CancelRequest, CrewClient, CrewCommandSandbox } from "./crew-client.ts";
import { BUILD_SKILL_FILE, fillJobMessage, installedSkillFile, JOB_MESSAGE_FILE, readTextFile, REPO_ROOT, sameText } from "./crew-files.ts";
import { defaultBeeBinary, runSandboxProbe, SANDBOX_CHECK_FAILED } from "./probe.ts";
import type { ProbeResult, StartDecoy } from "./probe.ts";
import { createCommandRunner } from "./run.ts";
import type { CommandRunner } from "./run.ts";
import { readSmallText } from "./safe-read.ts";
import { realPath, realPathAllowMissing, sandboxDefines } from "./sandbox-values.ts";
import { awakeMs, watchSlept } from "./slept.ts";
import type { StartSleptWatch } from "./slept.ts";
import { buildTmpDir, isSafeIdeaId } from "./workspace.ts";
import { minutesText, STOPPED_REASON } from "./types.ts";
import type { BuildBackend, BuildJob, BuildOptions, BuildOutcome } from "./types.ts";

export const KIRO_CREW = "kiro-crew";
export const DEFAULT_POLL_MS = 5_000;
/**
 * Crew is told the same time limit as ours and stops the session itself when it passes. We wait
 * this much longer for it to do so before giving up, so a session is not left running while the
 * next build starts in the same folder.
 */
export const CREW_STOP_GRACE_MS = 90_000;
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The sandbox profile the gateway, and our own kirocrew commands, run in when BUILD_SANDBOX is "overnight". */
export const CREW_GATEWAY_SANDBOX_PROFILE = path.resolve(import.meta.dirname, "..", "sandbox", "crew-gateway.sb");
/** Crew's settings file is a few hundred bytes. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Which sandbox the Kiro Crew gateway runs in: core's `config.buildSandbox` (the BUILD_SANDBOX setting). */
export type BuildSandboxMode = Config["buildSandbox"];

export interface KiroCrewBackendOptions {
  paths: DataPaths;
  logger: Logger;
  /** Pass `config.buildSandbox`. Nothing in this package reads BUILD_SANDBOX from the environment. */
  sandboxMode: BuildSandboxMode;
  /** Full path of kirocrew. Default ~/.local/bin/kirocrew. */
  kirocrewBinary?: string;
  /** Kiro Crew's own folder. Default: the KIROCREW_HOME variable, or ~/.kiro/crew. */
  crewHome?: string;
  run?: CommandRunner;
  now?: () => Date;
  /** How often Crew's files are looked at while a job runs. */
  pollMs?: number;
  /** The time zone a job's (never due) schedule is read in. Default: the TZ setting, or America/Boise. */
  timeZone?: string;
  /** The Bee program the sandbox check tries to use. Default: the one in this repo's node_modules. */
  beeBinary?: string;
  /** Our copy of the skill and of the job message. Default: crew/build-skill.md and crew/nightly-job.md. */
  skillFile?: string;
  jobMessageFile?: string;
  /** Waits between looks at Crew's files. Tests pass one that moves their clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** "overnight" mode only. Defaults: /usr/bin/sandbox-exec, sandbox/crew-gateway.sb, the home folder, this repo. */
  sandboxExec?: string;
  sandboxProfile?: string;
  home?: string;
  repoRoot?: string;
  /** Kiro's own folder, for the sandbox's values. Default: the KIRO_HOME variable, or ~/.kiro. */
  kiroHome?: string;
  /** Sends the request that cancels a run. Tests pass a stand-in. */
  postCancel?: (request: CancelRequest) => Promise<number | null>;
  /** Starts the sandbox check's stand-in for "another program". Tests pass one that starts nothing. */
  startDecoy?: StartDecoy;
  /**
   * Counts the time the Mac sleeps while the agent runs, so that it is not counted as the
   * agent's (slept.ts). Default: the real watch, on the real clock. Tests pass their own.
   */
  sleptWatch?: StartSleptWatch;
}

const settingsSchema = z.object({
  agent: z
    .object({
      sandbox: z.string().optional(),
      sandbox_allow_unsandboxed_exec: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Is Kiro Crew set up the way BUILD_SANDBOX says? Returns a reason when it is not.
 * - "crew": Crew's own sandbox must be on, at its strict level.
 * - "overnight": Crew's own sandbox must be off (Crew refuses to run jobs inside ours otherwise);
 *   the probe then proves that ours is really there.
 * Read only. Changing these settings is the installer's job, and the owner's decision.
 */
export function crewSettingsProblem(crewHome: string, mode: BuildSandboxMode): string | null {
  const unreadable = "Kiro Crew's settings could not be read, so its sandbox could not be checked";
  // A job inside the gateway can write this file: read it as carefully as anything an agent wrote.
  const text = readSmallText(path.join(crewHome, "config.json"), MAX_SETTINGS_BYTES);
  if (text === null) return unreadable;
  let settings;
  try {
    settings = settingsSchema.safeParse(JSON.parse(text));
  } catch {
    return unreadable;
  }
  if (!settings.success) return unreadable;
  const unsandboxed = settings.data.agent?.sandbox_allow_unsandboxed_exec === true;
  if (mode === "overnight") {
    return unsandboxed ? null : `${SANDBOX_CHECK_FAILED}: Kiro Crew is not set up to run inside the Overnight sandbox (agent.sandbox_allow_unsandboxed_exec is not true)`;
  }
  if (unsandboxed) return 'Kiro Crew\'s own sandbox is switched off, but BUILD_SANDBOX is "crew"';
  return settings.data.agent?.sandbox === "strict" ? null : "Kiro Crew's sandbox is not at its strict level";
}

/** What the backend and the stand-alone sandbox check share: where Kiro Crew is, and how it is reached. */
interface CrewAccess {
  logger: Logger;
  now: () => Date;
  binary: string;
  crewHome: string;
  timeZone: string;
  /**
   * The client for this Kiro Crew, made at first use (in "overnight" mode it needs folders that
   * must exist by then). Null when a folder or file the Overnight sandbox needs is missing.
   */
  client(): CrewClient | null;
  /** Run the sandbox check once ("overnight" mode). */
  probe(crew: CrewClient, signal: AbortSignal | undefined): Promise<ProbeResult>;
}

function crewAccess(options: KiroCrewBackendOptions): CrewAccess {
  const { paths, sandboxMode } = options;
  const logger = options.logger.child({ backend: KIRO_CREW });
  const now = options.now ?? (() => new Date());
  const binary = options.kirocrewBinary ?? defaultKirocrewBinary();
  const crewHome = options.crewHome ?? defaultCrewHome();
  const timeZone = crewTimeZone(options.timeZone);
  const run = options.run ?? createCommandRunner();
  const sleep = options.sleep ?? abortableSleep;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const home = options.home ?? homedir();
  const repoRoot = options.repoRoot ?? REPO_ROOT;

  /**
   * How our own kirocrew commands are fenced in: the profile and its values, as real paths, or
   * null if one is missing. Only looked up in "overnight" mode. The names come from the profile
   * itself and the paths are worked out as scripts/install-agents.sh works them out for the
   * gateway's background job, so both are started with the same values.
   */
  function commandSandbox(): CrewCommandSandbox | null {
    const exec = options.sandboxExec ?? SANDBOX_EXEC;
    const profile = realPath(options.sandboxProfile ?? CREW_GATEWAY_SANDBOX_PROFILE);
    if (!existsSync(exec) || profile === null) return null;
    const node = realPath(process.execPath);
    const defines = sandboxDefines(profile, {
      HOME: realPath(home),
      DATA_DIR: realPath(paths.root),
      REPO: realPath(repoRoot),
      // The Node.js install: the folder that holds bin/node.
      NODE_DIR: node === null ? null : path.dirname(path.dirname(node)),
      NPM_CACHE: realPathAllowMissing(path.join(home, ".npm")),
      KIRO_HOME: realPathAllowMissing(options.kiroHome ?? defaultKiroHome()),
      CREW_HOME: realPathAllowMissing(crewHome),
    });
    return defines === null ? null : { exec, profile, defines };
  }

  let client: CrewClient | null | undefined;
  return {
    logger,
    now,
    binary,
    crewHome,
    timeZone,
    client() {
      if (client !== undefined) return client;
      const tmpDir = buildTmpDir(paths);
      const sandbox = sandboxMode === "overnight" ? commandSandbox() : undefined;
      client =
        sandbox === null || tmpDir === null
          ? null
          : createCrewClient({
              binary,
              crewHome,
              crewHomeIsExplicit: options.crewHome !== undefined,
              run,
              logger,
              now,
              sleep,
              pollMs,
              tmpDir,
              ...(sandbox === undefined ? {} : { sandbox }),
              ...(options.postCancel === undefined ? {} : { postCancel: options.postCancel }),
            });
      return client;
    },
    probe(crew, signal) {
      return runSandboxProbe({
        crew,
        paths,
        beeBinary: options.beeBinary ?? defaultBeeBinary(),
        // Where our own unsandboxed programs are run from: the probe checks a job cannot write there.
        protectedDirs: { home, repo: repoRoot, node: path.dirname(process.execPath), kirocrew: path.dirname(realPath(binary) ?? binary) },
        timeZone,
        logger,
        now,
        ...(signal === undefined ? {} : { signal }),
        ...(options.startDecoy === undefined ? {} : { startDecoy: options.startDecoy }),
      });
    },
  };
}

const SANDBOX_PARTS_MISSING = `${SANDBOX_CHECK_FAILED}: a folder or file the Overnight sandbox needs is missing`;
const NOT_INSTALLED = "Kiro Crew is not installed (kirocrew was not found)";
const UNEXPECTED_ERROR = "the Kiro Crew build stopped on an unexpected error";

export function createKiroCrewBackend(options: KiroCrewBackendOptions): BuildBackend {
  const { sandboxMode } = options;
  const access = crewAccess(options);
  const { logger, now, binary, crewHome, timeZone } = access;
  const startSleptWatch = options.sleptWatch ?? watchSlept;

  // Once per process, before the first Crew build: clear out jobs a killed run left behind. This
  // comes before every check that can refuse a build, so a left-over job never waits for the
  // night a build gets through.
  let swept: Promise<void> | null = null;
  const sweepOnce = (crew: CrewClient, signal: AbortSignal | undefined): Promise<void> => {
    swept ??= crew
      .removeLeftovers(signal)
      .then(() => {})
      .catch(() => {});
    return swept;
  };
  // Once per process, in "overnight" mode: prove the sandbox. A failed check stays failed for the
  // whole night. (A check cut short because Overnight is stopping is not kept: nothing follows it.)
  let probed: Promise<ProbeResult> | null = null;
  const probeOnce = (crew: CrewClient, signal: AbortSignal | undefined): Promise<ProbeResult> => {
    if (sandboxMode !== "overnight") return Promise.resolve({ ok: true });
    probed ??= access.probe(crew, signal);
    return probed;
  };

  async function build(job: BuildJob, startedMs: number, signal: AbortSignal | undefined): Promise<BuildOutcome> {
    const ms = () => now().getTime() - startedMs;
    const cannotStart = (reason: string): BuildOutcome => ({ ok: false, backend: KIRO_CREW, ms: ms(), reason, couldNotStart: true });
    const failed = (reason: string): BuildOutcome => ({ ok: false, backend: KIRO_CREW, ms: ms(), reason, couldNotStart: false });
    const stopped = (): boolean => signal?.aborted === true;

    if (stopped()) return failed(STOPPED_REASON);
    if (!isSafeIdeaId(job.ideaId)) return cannotStart("the idea id cannot be used as a job name");
    if (!existsSync(binary)) return cannotStart(NOT_INSTALLED);
    const crew = access.client();
    if (crew === null) return cannotStart(SANDBOX_PARTS_MISSING);
    await sweepOnce(crew, signal);
    if (stopped()) return failed(STOPPED_REASON);

    const settingsProblem = crewSettingsProblem(crewHome, sandboxMode);
    if (settingsProblem !== null) return cannotStart(settingsProblem);

    // The workspace as it is now, before any agent has touched it. The result is checked against this.
    const workspace = realPath(job.workspace);
    if (workspace === null) return cannotStart("the workspace folder is missing");

    // The skill carries the rules the agent works under. Build only with the text in this repo.
    const skillFile = installedSkillFile(crewHome);
    let message: string;
    try {
      const ours = readTextFile(options.skillFile ?? BUILD_SKILL_FILE);
      const template = readTextFile(options.jobMessageFile ?? JOB_MESSAGE_FILE);
      if (ours === null || template === null) return cannotStart("the build instructions in crew/ could not be read");
      // The installed copy sits in Kiro Crew's own folder, where a job can write: a link or a pipe there is "missing".
      const installed = readTextFile(skillFile);
      if (installed === null || !sameText(installed, ours)) {
        return cannotStart("the overnight-build skill installed in Kiro Crew is missing or is not the one in crew/build-skill.md (install it again: see crew/README.md)");
      }
      message = fillJobMessage(template, { brief: job.briefPath, workspace: job.workspace, skill: realpathSync(skillFile) });
    } catch {
      return cannotStart("the build instructions in crew/ could not be read");
    }

    const check = await probeOnce(crew, signal);
    if (stopped()) {
      // The check was cut short. Do not keep its answer: it says nothing about the sandbox.
      probed = null;
      return failed(STOPPED_REASON);
    }
    if (!check.ok) return cannotStart(check.reason);

    // Crew takes 1 to 86,400 seconds. Under a minute is not a build.
    const timeoutSecs = Math.min(86_400, Math.max(60, Math.ceil(job.timeoutMs / 1000)));
    const added = await crew.addJob(
      `${BUILD_JOB_PREFIX}${job.ideaId}`,
      message,
      ["--cron", NEVER_DUE_CRON, "--timezone", timeZone, "--approval-mode", "auto", "--no-persistent-session", "--timeout-secs", String(timeoutSecs)],
      signal,
    );
    if (!added.ok) return stopped() ? failed(STOPPED_REASON) : cannotStart(added.reason);

    // `mayBeRunning` is true from the trigger until we know the run is over. A run that may still
    // be going is cancelled before its job is removed (removing alone does not end it), so no
    // agent is left working with nobody watching. Asking costs nothing when nothing is running.
    // `triggeredAtMs` is when the agent was started, once Kiro Crew has said it was. From then on
    // the try has a cost, however it ends.
    const run: { mayBeRunning: boolean; triggeredAtMs: number | null } = { mayBeRunning: false, triggeredAtMs: null };
    let agentEndedMs: number;

    /** Start the job and wait for it. Its answer is the outcome, less what the try cost. */
    const runJob = async (jobId: string): Promise<BuildOutcome> => {
      if (stopped()) return failed(STOPPED_REASON);
      run.mayBeRunning = true;
      const triggered = await crew.trigger(jobId, signal);
      if (!triggered.ok) return stopped() ? failed(STOPPED_REASON) : cannotStart(triggered.reason);
      run.triggeredAtMs = triggered.triggeredAtMs;
      logger.info("kiro crew build started", { ideaId: job.ideaId, jobId, timeoutSecs });

      const waited = await crew.waitUntilFinished(jobId, triggered.triggeredAtMs, triggered.triggeredAtMs + job.timeoutMs + CREW_STOP_GRACE_MS, signal);
      if (!waited.finished) {
        if (waited.stopped) logger.warn("kiro crew build stopped: Overnight was told to stop", { ideaId: job.ideaId, jobId });
        return failed(waited.stopped ? STOPPED_REASON : `the build ran past its time limit of ${minutesText(job.timeoutMs)}`);
      }
      run.mayBeRunning = false;

      const result = checkBuildResult(workspace, triggered.triggeredAtMs);
      logger.info("kiro crew job ended", { ideaId: job.ideaId, jobId, crewStatus: waited.status, built: result.ok });
      if (result.ok) return { ok: true, backend: KIRO_CREW, ms: ms() };
      if (waited.status === "timeout") return failed(`the build ran past its time limit of ${minutesText(job.timeoutMs)}`);
      // Crew recorded a failure and the agent never wrote a thing: Crew refused to run the job.
      if (result.neverStarted && waited.status === "failure") return cannotStart("Kiro Crew could not run the build job (its own record says it failed at once)");
      return failed(result.reason);
    };

    let outcome: BuildOutcome;
    let sleptMs: number;
    // From just before the agent is started until its time ends: how long the Mac slept meanwhile.
    const slept = startSleptWatch();
    try {
      outcome = await runJob(added.id);
    } catch {
      // The error's own text is not passed on: it could quote a path or a tool's reply.
      logger.error("kiro crew build stopped on an unexpected error", { ideaId: job.ideaId });
      outcome = failed(UNEXPECTED_ERROR);
    } finally {
      // The agent's time ends here: the clean-up below is ours, not the agent's.
      agentEndedMs = now().getTime();
      sleptMs = slept.stop();
      if (run.mayBeRunning) await crew.cancel(added.id).catch(() => false);
      await crew.remove(added.id, signal === undefined ? {} : { signal }).catch(() => false);
    }
    if (run.triggeredAtMs === null) return outcome;

    // What the try cost, read only now: the run is over (it was cancelled if it had to be), so
    // Kiro Crew has had its chance to write the figure down. This goes for a build that failed,
    // ran out of time or was stopped as much as for one that worked. Reading it is a look at a
    // few small files: no time worth counting against the 10 seconds a stop may take.
    // How long the agent worked: by the clock on the wall, less the time the Mac slept in the
    // middle of the build (slept.ts). A build the lid was closed on two minutes in is two
    // minutes of agent, however many hours later it was stopped. And never more than the try
    // was allowed: a second bound, should a sleep ever go unseen.
    const agentMs = Math.min(awakeMs(run.triggeredAtMs, agentEndedMs, sleptMs), job.timeoutMs + CREW_STOP_GRACE_MS);
    if (sleptMs > 0) logger.info("the Mac slept during a kiro crew build; that time is not counted as the agent's", { ideaId: job.ideaId, sleptSeconds: Math.round(sleptMs / 1000), agentSeconds: Math.round(agentMs / 1000) });
    // Kiro Crew's own record, best effort. Without it the ledger takes an estimate.
    const credits = crew.creditsFor(added.id, [new Date(run.triggeredAtMs), now()]);
    return { ...outcome, agentMs, ...(credits === undefined ? {} : { credits }) };
  }

  return {
    name: KIRO_CREW,
    async build(job: BuildJob, buildOptions: BuildOptions = {}) {
      const startedMs = now().getTime();
      try {
        return await build(job, startedMs, buildOptions.signal);
      } catch {
        // The error's own text is not passed on: it could quote a path or a tool's reply.
        logger.error("kiro crew build stopped on an unexpected error", { ideaId: job.ideaId });
        return { ok: false, backend: KIRO_CREW, ms: now().getTime() - startedMs, reason: UNEXPECTED_ERROR, couldNotStart: false };
      }
    },
  };
}

/** What `runStandaloneSandboxProbe` needs. */
export interface StandaloneProbeDeps {
  config: Config;
  paths: DataPaths;
  logger: Logger;
  /** Aborted when Overnight is told to stop: the check ends at once and its job is removed. */
  signal?: AbortSignal;
}

/** For tests: everything about Kiro Crew that the stand-alone check would otherwise work out itself. */
export type StandaloneProbeOverrides = Partial<Omit<KiroCrewBackendOptions, "paths" | "logger" | "sandboxMode">> & {
  /** Is the gateway answering on this port? Default: ask it, over the loopback address. */
  gatewayAnswers?: (port: number, signal?: AbortSignal) => Promise<boolean>;
};

/** The stand-alone check with its parts replaceable. `runStandaloneSandboxProbe` is this with none replaced. */
export async function standaloneSandboxProbe(deps: StandaloneProbeDeps, overrides: StandaloneProbeOverrides = {}): Promise<ProbeResult> {
  const couldNotRun = (why: string): ProbeResult => ({ ok: false, reason: `${SANDBOX_CHECK_FAILED}: it could not be run (${why})` });
  try {
    const { gatewayAnswers: answers = gatewayAnswers, ...backendOptions } = overrides;
    const mode = deps.config.buildSandbox;
    const access = crewAccess({ timeZone: deps.config.timeZone, ...backendOptions, paths: deps.paths, logger: deps.logger, sandboxMode: mode });
    const stopped = (): boolean => deps.signal?.aborted === true;
    if (stopped()) return couldNotRun("Overnight was being stopped");
    if (!existsSync(access.binary)) return { ok: false, reason: NOT_INSTALLED };

    // 1. Kiro Crew's own setting: its sandbox must be the one BUILD_SANDBOX says.
    const settingsProblem = crewSettingsProblem(access.crewHome, mode);
    if (settingsProblem !== null) return { ok: false, reason: settingsProblem };

    // 2. The gateway: nothing can be asked of one that is not there.
    if (!(await answers(gatewayPort(), deps.signal))) return stopped() ? couldNotRun("Overnight was being stopped") : couldNotRun(GATEWAY_NOT_RUNNING);

    // 3. The check itself. In "crew" mode there is none to run (Kiro Crew's own sandbox does the
    //    fencing, and the setting above is all the nightly build looks at), so that is a pass.
    if (mode !== "overnight") return { ok: true };
    const crew = access.client();
    if (crew === null) return { ok: false, reason: SANDBOX_PARTS_MISSING };
    return await access.probe(crew, deps.signal);
  } catch {
    // The error's own text is not passed on: it could quote a path or a tool's reply.
    return couldNotRun("an unexpected error");
  }
}

/**
 * The build sandbox check on its own, for `overnight preflight`: the same check the nightly build
 * makes before its first Kiro Crew build, through the same code. In order: Kiro Crew's sandbox
 * setting, then whether the gateway answers, then (in "overnight" mode) the probe job, once. It
 * spends no Kiro credits and opens nothing of Overnight's: the job writes counts and 0/1 marks
 * into <data>/tmp/build-probe. Never throws. A reason is one plain sentence of our own.
 */
export function runStandaloneSandboxProbe(deps: { config: Config; paths: DataPaths; logger: Logger; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; reason: string }> {
  return standaloneSandboxProbe(deps);
}
