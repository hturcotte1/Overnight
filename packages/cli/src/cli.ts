// The `overnight` command line: read the arguments, open the data, hand over to one command.
// Each command lives in src/commands and takes what it needs as arguments, so the tests can run
// it against an in-memory database without starting a process.
import { homedir } from "node:os";
import path from "node:path";
import { ConfigError, createLogger, errorSummary, startKeepAwake } from "@overnight/core";
import type { ClockedJob, DataPaths, Logger, LoginState } from "@overnight/core";
import { parseArgs } from "./args.ts";
import { installedJobFolders, jobsBelongHere, readJobTriggers, readListenerState, readNightJobsState } from "./background.ts";
import type { JobTrigger, ListenerState, NightJobsState } from "./background.ts";
import { build } from "./commands/build.ts";
import type { BuildFactories, KeepAwakeHold } from "./commands/build.ts";
import { buildNow } from "./commands/build-now.ts";
import { deliver } from "./commands/deliver.ts";
import type { DeliverFactories, DeliverSteps } from "./commands/deliver.ts";
import { ideas } from "./commands/ideas.ts";
import { listen } from "./commands/listen.ts";
import type { ListenFactories } from "./commands/listen.ts";
import { nightLockFile, nightTick, startClockFromNow } from "./commands/night-tick.ts";
import type { NightRunMarks } from "./commands/night-tick.ts";
import { pause, resume } from "./commands/pause.ts";
import { preflight } from "./commands/preflight.ts";
import type { PreflightProbes } from "./commands/preflight.ts";
import { queue } from "./commands/queue.ts";
import { isRealDataOnlyCommand, rehearsalFolderRefusal, rehearseNew, rehearseRun } from "./commands/rehearse.ts";
import { status } from "./commands/status.ts";
import { openContext, repoRoot } from "./context.ts";
import type { Context } from "./context.ts";
import { gatewayAnswers } from "./gateway.ts";
import { watchLastResort } from "./last-resort.ts";
import type { WatchLastResort } from "./last-resort.ts";
import { isOnline } from "./online.ts";
import type { Write } from "./output.ts";
import { readPowerSource } from "./power.ts";
import type { PowerSource } from "./power.ts";
import { readEnvFileText, rehearsalFolderProblem, REHEARSAL_WHY } from "./rehearsal-folder.ts";
import { lockHeld, takeListenLock, takeLock } from "./single-instance.ts";
import type { ReleaseLock } from "./single-instance.ts";
import { watchForSleep } from "./sleep-watch.ts";
import type { WatchForSleep } from "./sleep-watch.ts";
import { watchStopSignals } from "./stop-signals.ts";
import type { WatchStopSignals } from "./stop-signals.ts";
import { USAGE } from "./usage.ts";
import { realBeeLoginState, realBuildFactories, realDeliverFactories, realDeliverSteps, realListenFactories, realPreflightProbes } from "./wiring.ts";

/** Exit codes: 0 worked, 1 something failed, 2 the command or a setting was wrong. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Everything that touches the outside world. Tests replace all of it. */
export interface CliIo {
  write: Write;
  writeError: Write;
  now: () => Date;
  open: () => Context;
  listenFactories: () => Promise<ListenFactories>;
  beeLoginState: () => Promise<LoginState>;
  listenLogger: (paths: DataPaths) => Logger;
  /** The one-listener-per-data-folder lock: how to release it, or null if another listener holds it. */
  takeListenLock: (file: string) => ReleaseLock | null;
  /** For `status`: is a listener running, and is the background job installed? */
  listenerState: (paths: DataPaths) => ListenerState;
  /** For `status`: which of the night jobs (build, deliver, the Kiro Crew gateway) are installed? */
  nightJobsState: () => NightJobsState;
  /** @overnight/builder, loaded only when a command needs it. */
  buildFactories: () => Promise<BuildFactories>;
  /** @overnight/deliver and the Bee gateway, loaded only when a command needs them. */
  deliverFactories: () => Promise<DeliverFactories>;
  /**
   * The log of the nightly build (logs/build.log) or of the morning deliver (logs/deliver.log).
   * `quiet` keeps its lines off the screen, for a command that prints its own.
   */
  jobLogger: (paths: DataPaths, name: "build" | "deliver", options?: { quiet?: boolean }) => Logger;
  /** The one-at-a-time lock of `build` and of `deliver`: how to release it, or null if it is held. */
  takeJobLock: (file: string) => ReleaseLock | null;
  /** For `status`: does the Kiro Crew gateway on this Mac answer? */
  gatewayAnswers: () => Promise<boolean>;
  /** For `build`, `deliver`, `build-now` and `rehearse run`: watches for stop signals while they work (stop-signals.ts). */
  watchStopSignals: WatchStopSignals;
  /** For the same commands: watches for an error nobody caught while they work (last-resort.ts). */
  watchLastResort: WatchLastResort;
  /** For `preflight`: how each of its questions is really asked of this Mac. */
  preflightProbes: (context: Pick<Context, "config" | "paths">) => Promise<PreflightProbes>;
  /** For `rehearse run`: @overnight/deliver alone. Unlike `deliverFactories`, this never loads the Bee gateway. */
  deliverSteps: () => Promise<DeliverSteps>;
  /** For `rehearse`: OVERNIGHT_DATA_DIR as this process was given it. Asked before the settings (and .env) are read. */
  givenDataDir: () => string | undefined;
  /** For `rehearse`: why a rehearsal may not run on that data folder, in one sentence, or null when it may. Never throws. */
  rehearsalFolderProblem: (dataDir: string | undefined) => string | null;
  /** Does some process hold this job lock right now? Null if that could not be told. For `status`, and for the deliver job's question about the build. */
  jobLockHeld: (file: string) => boolean | null;
  /** For `status`: is this Mac on mains power or on battery? */
  powerSource: () => Promise<PowerSource>;
  /** For `--if-due`: is there real internet (online.ts)? */
  isOnline: () => Promise<boolean>;
  /** For `--if-due`: wait in place this many milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** For `build`, `deliver` and `build-now`: holds the Mac awake while a run is going, also on battery. */
  keepAwake: KeepAwakeHold;
  /** For the same commands and `rehearse run`: watches for the Mac having slept during a run (sleep-watch.ts). */
  watchForSleep: WatchForSleep;
  /** For `status`: how macOS starts the build and the deliver job: every minute, or still by its calendar. */
  jobTriggers: () => Record<ClockedJob, JobTrigger | null>;
  /** For `status`: were the installed background jobs installed for this data folder? Null if that cannot be told. */
  jobsBelongHere: (paths: Pick<DataPaths, "root">) => boolean | null;
}

/** What this Mac says about which data folders are real ones. Replaced in tests. */
export interface RealFolderFacts {
  home: () => string;
  /** The text of the repo's .env file, or null when there is none. */
  envFileText: () => string | null;
  /** The data folders the installed background jobs were installed for. */
  jobFolders: (home: string) => string[];
}

const THIS_MAC: RealFolderFacts = { home: homedir, envFileText: () => readEnvFileText(repoRoot()), jobFolders: installedJobFolders };

/**
 * Is a rehearsal allowed on this folder? Asked of this Mac: the home folder, the repo's .env and
 * the installed background jobs' own settings files say which folders are real ones (the jobs'
 * folders count whatever .env says by now). Never throws.
 */
export function realRehearsalFolderProblem(dataDir: string | undefined, mac: RealFolderFacts = THIS_MAC): string | null {
  try {
    const home = mac.home();
    return rehearsalFolderProblem({ given: dataDir, home, envFileText: mac.envFileText(), jobFolders: mac.jobFolders(home) });
  } catch (error) {
    // Not knowing which folder is the real one is a reason to refuse, not to go ahead.
    return `Not started: ${errorSummary(error)}, and a rehearsal must not run on it, because ${REHEARSAL_WHY}.`;
  }
}

export const processIo: CliIo = {
  write: (line) => void process.stdout.write(line + "\n"),
  writeError: (line) => void process.stderr.write(line + "\n"),
  now: () => new Date(),
  open: () => openContext(),
  listenFactories: realListenFactories,
  beeLoginState: realBeeLoginState,
  // The logger prints to the screen only when there is one; as a background job it writes the file alone.
  listenLogger: (paths) => createLogger({ name: "listener", file: path.join(paths.logs, "listen.log") }),
  takeListenLock,
  listenerState: readListenerState,
  nightJobsState: () => readNightJobsState(),
  buildFactories: realBuildFactories,
  deliverFactories: realDeliverFactories,
  // Like the listener's: on the screen only when there is one and the command wants it there.
  jobLogger: (paths, name, options) => createLogger({ name, file: path.join(paths.logs, `${name}.log`), ...(options?.quiet ? { write: () => {} } : {}) }),
  takeJobLock: takeLock,
  gatewayAnswers: () => gatewayAnswers(),
  watchStopSignals,
  watchLastResort,
  preflightProbes: realPreflightProbes,
  deliverSteps: realDeliverSteps,
  givenDataDir: () => process.env.OVERNIGHT_DATA_DIR,
  rehearsalFolderProblem: (dataDir) => realRehearsalFolderProblem(dataDir),
  jobLockHeld: lockHeld,
  powerSource: () => readPowerSource(),
  isOnline: () => isOnline(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // "always": on battery too. With the lid closed on battery the Mac sleeps all the same.
  keepAwake: (logger) => startKeepAwake(logger, process.pid, undefined, "always"),
  watchForSleep,
  jobTriggers: () => readJobTriggers(),
  jobsBelongHere: (paths) => jobsBelongHere(paths),
};

/** Each command and the switches it accepts. A Map, so "constructor" is not mistaken for a command. */
const COMMANDS = new Map<string, readonly string[]>([
  ["listen", []],
  ["status", ["json", "check"]],
  ["ideas", ["json", "all"]],
  ["queue", ["approved", "json"]],
  // --if-due: ask the night clock first. --from-now: start that clock from now. Never both.
  ["build", ["if-due", "from-now"]],
  ["deliver", ["if-due", "from-now"]],
  ["build-now", []],
  ["rehearse", ["no-publish"]],
  ["preflight", []],
  ["pause", []],
  ["resume", []],
]);

/** The commands that take words after their name, and how many at most. Every other command takes none. */
const WORDS_AFTER = new Map<string, number>([
  ["build-now", 1],
  // "new" <title> <pitch>, or "run" <ideaId>
  ["rehearse", 3],
]);

export const REHEARSE_USAGE = 'A rehearsal is one of:  overnight rehearse new "<title>" "<pitch>"   or   overnight rehearse run <ideaId> [--no-publish]';

/** What is wrong with the words after "rehearse", or null when they fit one of its two forms. */
function rehearseUsageProblem(flags: Set<string>, extras: readonly string[]): string | null {
  const [action] = extras;
  if (action === "new" && extras.length === 3 && !flags.has("no-publish")) return null;
  if (action === "run" && extras.length === 2) return null;
  return REHEARSE_USAGE;
}

function usageError(io: CliIo, problem: string): number {
  io.writeError(problem);
  io.writeError("");
  io.writeError(USAGE);
  return EXIT_USAGE;
}

function settingError(io: CliIo, error: ConfigError): number {
  io.writeError(error.message);
  io.writeError("Settings live in the .env file at the top of the repo (see .env.example).");
  return EXIT_USAGE;
}

async function dispatch(command: string, flags: Set<string>, extras: readonly string[], context: Context, io: CliIo): Promise<number> {
  const { store, config, paths } = context;
  const { write, writeError, now } = io;
  // The commands that only ever run on real data do not run on a data folder that holds a
  // rehearsal idea. With --if-due the question is asked later, inside the run (see `ifDue`);
  // --from-now only moves a clock.
  const clockSwitch = flags.has("if-due") || flags.has("from-now");
  if (isRealDataOnlyCommand(command) && !clockSwitch) {
    const refused = rehearsalFolderRefusal(store, command);
    if (refused !== null) {
      writeError(refused);
      return EXIT_FAILED;
    }
  }

  /** What `--if-due` hands the work: the job's lock, already held, and the night clock's marks. */
  type NightHand = { takeLock: (file: string) => ReleaseLock | null; marks: NightRunMarks };

  /** `--if-due`: one check of the night clock. `work` is called only when the job's slot is due. */
  const ifDue = (job: ClockedJob, work: (logger: Logger, hand: NightHand) => Promise<number>): Promise<number> => {
    // The job's log is made only when there is something to log: nearly every check finds
    // nothing due, and must not open a file each minute to say so.
    let made: Logger | undefined;
    const logger = (): Logger => (made ??= io.jobLogger(paths, job));
    return nightTick({
      job,
      store,
      config,
      paths,
      now,
      logger,
      takeLock: io.takeJobLock,
      lockHeld: io.jobLockHeld,
      isOnline: io.isOnline,
      sleep: io.sleep,
      writeError,
      run: async (hand) => {
        // Asked here, when a run is due, and not at every check: said each minute it would fill
        // the job's log. Said here it also closes the slot, so it is said once a night.
        const refused = rehearsalFolderRefusal(store, job);
        if (refused !== null) {
          writeError(refused);
          hand.marks.started();
          hand.marks.ended("finished");
          return EXIT_FAILED;
        }
        return work(logger(), hand);
      },
    });
  };

  switch (command) {
    case "listen":
      return listen({ store, config, paths, logger: io.listenLogger(paths), factories: await io.listenFactories(), takeLock: io.takeListenLock });
    case "status":
      return status(
        {
          store,
          config,
          write,
          now,
          listenerState: () => io.listenerState(paths),
          nightJobs: io.nightJobsState,
          gatewayAnswers: io.gatewayAnswers,
          jobRunning: (job) => io.jobLockHeld(nightLockFile(job, paths)),
          jobTriggers: io.jobTriggers,
          powerSource: io.powerSource,
          jobsBelongHere: () => io.jobsBelongHere(paths),
        },
        { json: flags.has("json"), beeLoginState: flags.has("check") ? io.beeLoginState : undefined },
      );
    case "ideas":
      return ideas({ store, config, write, now }, { json: flags.has("json"), all: flags.has("all") });
    case "queue":
      return queue({ store, config, write, writeError });
    case "build": {
      if (flags.has("from-now")) return startClockFromNow({ job: "build", store, config, paths, now, takeLock: io.takeJobLock }, write, writeError);
      // The sandbox mode is one of the settings (config.buildSandbox). A value that is neither of
      // the two has already stopped the command, like any other bad setting.
      const run = (logger: Logger, hand?: NightHand): Promise<number> =>
        build({
          store,
          config,
          paths,
          logger,
          loadFactories: io.buildFactories,
          takeLock: hand?.takeLock ?? io.takeJobLock,
          write,
          writeError,
          watchStopSignals: io.watchStopSignals,
          watchLastResort: io.watchLastResort,
          watchForSleep: io.watchForSleep,
          keepAwake: io.keepAwake,
          ...(hand === undefined ? {} : { onRun: hand.marks }),
        });
      // Without the switch this means "now": the night clock is neither asked nor told.
      return flags.has("if-due") ? ifDue("build", run) : run(io.jobLogger(paths, "build"));
    }
    case "deliver": {
      if (flags.has("from-now")) return startClockFromNow({ job: "deliver", store, config, paths, now, takeLock: io.takeJobLock }, write, writeError);
      const run = (logger: Logger, hand?: NightHand): Promise<number> =>
        deliver({
          store,
          config,
          paths,
          logger,
          loadFactories: io.deliverFactories,
          takeLock: hand?.takeLock ?? io.takeJobLock,
          write,
          writeError,
          watchStopSignals: io.watchStopSignals,
          watchLastResort: io.watchLastResort,
          watchForSleep: io.watchForSleep,
          keepAwake: io.keepAwake,
          ...(hand === undefined ? {} : { onRun: hand.marks }),
        });
      return flags.has("if-due") ? ifDue("deliver", run) : run(io.jobLogger(paths, "deliver"));
    }
    case "build-now":
      return buildNow(extras[0] ?? "", {
        store,
        config,
        paths,
        // This command prints its own step-by-step lines, so the two logs go to their files only.
        buildLogger: io.jobLogger(paths, "build", { quiet: true }),
        deliverLogger: io.jobLogger(paths, "deliver", { quiet: true }),
        loadBuildFactories: io.buildFactories,
        loadDeliverFactories: io.deliverFactories,
        takeLock: io.takeJobLock,
        write,
        writeError,
        now,
        watchStopSignals: io.watchStopSignals,
        watchLastResort: io.watchLastResort,
        watchForSleep: io.watchForSleep,
        // One hold for the whole command: nobody may be at the Mac while it builds.
        keepAwake: io.keepAwake,
      });
    case "rehearse": {
      // Asked a second time, now of the folder that was really opened.
      const folderProblem = () => io.rehearsalFolderProblem(paths.root);
      if (extras[0] === "new") return rehearseNew(extras[1] ?? "", extras[2] ?? "", { store, write, writeError, now, folderProblem });
      return rehearseRun(
        extras[1] ?? "",
        { noPublish: flags.has("no-publish") },
        {
          store,
          config,
          paths,
          // Like build-now, this prints its own step-by-step lines, so the two logs go to their files only.
          buildLogger: io.jobLogger(paths, "build", { quiet: true }),
          deliverLogger: io.jobLogger(paths, "deliver", { quiet: true }),
          loadBuildFactories: io.buildFactories,
          // @overnight/deliver alone. io.deliverFactories, which makes the real Bee gateway, is never used here.
          loadDeliverSteps: io.deliverSteps,
          takeLock: io.takeJobLock,
          write,
          writeError,
          now,
          watchStopSignals: io.watchStopSignals,
          watchLastResort: io.watchLastResort,
          // No hold on the Mac's sleep: someone is at the Mac for a rehearsal. A sleep is still noticed.
          watchForSleep: io.watchForSleep,
          folderProblem,
        },
      );
    }
    case "preflight":
      return preflight({ store, config, write, now, probes: await io.preflightProbes({ config, paths }) });
    case "pause":
      return pause({ store, write, now });
    case "resume":
      return resume({ store, write, now });
    default:
      throw new Error(`No code for the command "${command}".`);
  }
}

/** Run one command and return its exit code. Never throws. */
export async function runCli(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<number> {
  const io: CliIo = { ...processIo, ...overrides };
  const { command, flags, extras } = parseArgs(argv);

  if (flags.has("help") || command === "help") {
    io.write(USAGE);
    return EXIT_OK;
  }
  if (command === null) return usageError(io, "Which command? None was given.");
  const allowed = COMMANDS.get(command);
  if (allowed === undefined) return usageError(io, `"${command}" is not an Overnight command.`);
  const unknown = [...flags].filter((flag) => !allowed.includes(flag));
  const wordsAfter = WORDS_AFTER.get(command) ?? 0;
  if (unknown.length > 0 || extras.length > wordsAfter) {
    const stray = [...unknown.map((flag) => `--${flag}`), ...extras.slice(wordsAfter)].join(", ");
    return usageError(io, `"overnight ${command}" does not understand: ${stray}`);
  }
  if (flags.has("if-due") && flags.has("from-now")) return usageError(io, "Use --if-due or --from-now, not both.");
  if (command === "build-now" && extras.length < wordsAfter) {
    return usageError(io, 'Which idea? Give its id: "overnight build-now <ideaId>". See the ids with: overnight ideas --all');
  }
  if (command === "rehearse") {
    const problem = rehearseUsageProblem(flags, extras);
    if (problem !== null) return usageError(io, problem);
    // Before anything is opened: a rehearsal never touches the real data folder, not even to look.
    const refused = io.rehearsalFolderProblem(io.givenDataDir());
    if (refused !== null) {
      io.writeError(refused);
      return EXIT_USAGE;
    }
  }
  // The queue has one reader, a program. Asking for both switches by name keeps its output a
  // promise: if the shape ever has to change, it changes under a new switch.
  if (command === "queue" && !(flags.has("approved") && flags.has("json"))) {
    return usageError(io, 'The queue is read as "overnight queue --approved --json".');
  }

  let context: Context;
  try {
    context = io.open();
  } catch (error) {
    if (error instanceof ConfigError) return settingError(io, error);
    io.writeError(`Overnight could not open its data folder. ${errorSummary(error)}`);
    return EXIT_FAILED;
  }
  try {
    return await dispatch(command, flags, extras, context, io);
  } catch (error) {
    if (error instanceof ConfigError) return settingError(io, error);
    io.writeError(`"overnight ${command}" failed. ${errorSummary(error)}`);
    return EXIT_FAILED;
  } finally {
    context.store.close();
  }
}
