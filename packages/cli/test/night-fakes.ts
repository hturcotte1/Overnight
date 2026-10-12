// Fakes for the night's commands (build, deliver, build-now). Everything here is made up for the
// tests: no builder, no Kiro, no Bee, no GitHub and no network is ever reached through them.
import { EventEmitter } from "node:events";
import { createLogger } from "@overnight/core";
import type { BeeGateway, Config, Logger } from "@overnight/core";
import type { BuildFactories, BuildNightResult, BuildOutcome, BuildRunDeps, KeepAwakeHold } from "../src/commands/build.ts";
import type { DeliverFactories, DeliverOutcome, DeliverResult, DeliverRunDeps } from "../src/commands/deliver.ts";
import type { NightRunMarks } from "../src/commands/night-tick.ts";
import { FAULT_KINDS, watchLastResort } from "../src/last-resort.ts";
import type { FaultKind, WatchLastResort } from "../src/last-resort.ts";
import type { ReleaseLock } from "../src/single-instance.ts";
import type { SleepWatchOptions, WatchForSleep } from "../src/sleep-watch.ts";
import { STOP_SIGNAL_NAMES, watchStopSignals } from "../src/stop-signals.ts";
import type { StopSignalName, WatchStopSignals } from "../src/stop-signals.ts";

export type LogLine = { level: string; name: string; message: string } & Record<string, unknown>;

/** A real logger whose lines are kept in memory, so a test can read what would be in the log file. */
export function collectingLogger(name = "build"): { logger: Logger; lines: LogLine[]; text: () => string } {
  const lines: LogLine[] = [];
  const logger = createLogger({ name, minLevel: "debug", write: (line) => void lines.push(JSON.parse(line) as LogLine) });
  return { logger, lines, text: () => lines.map((line) => JSON.stringify(line)).join("\n") };
}

/** What the fake builders are: a name, and what they were made with. */
export interface FakeBackend {
  name: "kiro-crew" | "kiro-cli";
  sandboxMode?: Config["buildSandbox"];
  logger: Logger;
}

export interface BuildFakes {
  factories: BuildFactories<FakeBackend>;
  /** How often the package was "loaded". */
  loads: number;
  load: () => Promise<BuildFactories<FakeBackend>>;
  /** Every step in the order it happened. */
  order: string[];
  nightDeps: BuildRunDeps<FakeBackend>[];
  oneCalls: Array<{ ideaId: string; deps: BuildRunDeps<FakeBackend> }>;
}

export function fakeBuild(
  options: {
    night?: (deps: BuildRunDeps<FakeBackend>) => BuildNightResult | Promise<BuildNightResult>;
    one?: (ideaId: string, deps: BuildRunDeps<FakeBackend>) => BuildOutcome | Promise<BuildOutcome>;
    order?: string[];
  } = {},
): BuildFakes {
  // Steps are noted in `fakes.order`, read each time, so a test may swap in a shared list.
  const fakes: BuildFakes = {
    loads: 0,
    order: options.order ?? [],
    nightDeps: [],
    oneCalls: [],
    load: async () => {
      fakes.loads += 1;
      fakes.order.push("load builder");
      return fakes.factories;
    },
    factories: {
      createKiroCrewBackend: ({ logger, sandboxMode }) => ({ name: "kiro-crew", sandboxMode, logger }),
      createKiroCliBackend: ({ logger }) => ({ name: "kiro-cli", logger }),
      runBuildNight: async (deps) => {
        fakes.order.push("runBuildNight");
        fakes.nightDeps.push(deps);
        return (await options.night?.(deps)) ?? { built: [], failed: [], skipped: "" };
      },
      buildOne: async (ideaId, deps) => {
        fakes.order.push(`buildOne ${ideaId}`);
        fakes.oneCalls.push({ ideaId, deps });
        return (await options.one?.(ideaId, deps)) ?? { ok: true, backend: deps.backends.primary.name, ms: 142_000 };
      },
    },
  };
  return fakes;
}

export interface DeliverFakes {
  factories: DeliverFactories;
  loads: number;
  load: () => Promise<DeliverFactories>;
  order: string[];
  /** The gateway handed to the deliver step. No method on it works: these tests never drive Bee. */
  bee: BeeGateway & { dispose: () => void };
  beeOptions: Array<{ logger: Logger }>;
  runDeps: DeliverRunDeps[];
  oneCalls: Array<{ ideaId: string; deps: DeliverRunDeps }>;
}

export function fakeDeliver(
  options: {
    run?: (deps: DeliverRunDeps) => DeliverResult | Promise<DeliverResult>;
    one?: (ideaId: string, deps: DeliverRunDeps) => DeliverOutcome | Promise<DeliverOutcome>;
    order?: string[];
  } = {},
): DeliverFakes {
  const bee = { dispose: () => void fakes.order.push("dispose bee") } as BeeGateway & { dispose: () => void };
  const fakes: DeliverFakes = {
    loads: 0,
    order: options.order ?? [],
    bee,
    beeOptions: [],
    runDeps: [],
    oneCalls: [],
    load: async () => {
      fakes.loads += 1;
      fakes.order.push("load deliver");
      return fakes.factories;
    },
    factories: {
      createBee: (beeOptions) => {
        fakes.order.push("create bee");
        fakes.beeOptions.push(beeOptions);
        return bee;
      },
      runDeliver: async (deps) => {
        fakes.order.push("runDeliver");
        fakes.runDeps.push(deps);
        return (await options.run?.(deps)) ?? { delivered: [], failed: [], notified: [] };
      },
      deliverOne: async (ideaId, deps) => {
        fakes.order.push(`deliverOne ${ideaId}`);
        fakes.oneCalls.push({ ideaId, deps });
        return (await options.one?.(ideaId, deps)) ?? { ok: true, url: "https://example.invalid/apps/made-up/" };
      },
    },
  };
  return fakes;
}

/**
 * Stand-in locks. Every file is free unless named in `held` (another process has it) or `broken`
 * (the file cannot be used). Taking and releasing are noted in `order` by the file's base name.
 */
export function fakeLocks(options: { held?: string[]; broken?: string[]; order?: string[] } = {}) {
  const order = options.order ?? [];
  const files: string[] = [];
  const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1);
  const takeLock = (file: string): ReleaseLock | null => {
    files.push(file);
    const name = baseName(file);
    if (options.broken?.includes(name)) throw new Error("unable to open database file\n    at somewhere");
    if (options.held?.includes(name)) return null;
    order.push(`lock ${name}`);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      order.push(`release ${name}`);
    };
  };
  return { takeLock, files, order };
}

/** A promise that never settles: a build that hangs. */
export const never = <T>(): Promise<T> => new Promise<T>(() => {});

/**
 * Made-up stop signals. The real watch (stop-signals.ts) is used, but it listens to an emitter of
 * the test's own instead of this process, and "end the process at once" only notes the exit code.
 * So no test ever sends a real signal or ends the test run.
 */
export function fakeStopSignals(options: { waitMs?: number } = {}) {
  const source = new EventEmitter();
  const exits: number[] = [];
  const watch: WatchStopSignals = (given = {}) => watchStopSignals({ ...given, source, exitNow: (code) => void exits.push(code), waitMs: options.waitMs ?? 2_000 });
  return {
    watch,
    /** Deliver one signal, as macOS or Ctrl-C would. */
    send: (name: StopSignalName) => void source.emit(name),
    /** The codes the process would have ended with at once (a second signal). */
    exits,
    /** How many handlers are in place right now. None may be left when a command returns. */
    handlers: () => STOP_SIGNAL_NAMES.reduce((count, name) => count + source.listenerCount(name), 0),
  };
}

/** Resolves when `signal` is aborted: what a well-behaved builder or deliver step waits on. */
export function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Made-up "errors nobody caught". The real watch (last-resort.ts) is used, but it listens to an
 * emitter of the test's own instead of this process, and "end the process" only notes the exit
 * code. So no test ever throws an uncaught error for real or ends the test run.
 */
export function fakeLastResort() {
  const source = new EventEmitter();
  const exits: number[] = [];
  const watch: WatchLastResort = (given) => watchLastResort({ ...given, source, exitNow: (code) => void exits.push(code) });
  return {
    watch,
    /** Deliver one such error, as Node would. */
    send: (kind: FaultKind, reason: unknown) => void source.emit(kind, reason),
    /** The codes the process would have ended with. */
    exits,
    /** How many handlers are in place right now. None may be left when a command returns. */
    handlers: () => FAULT_KINDS.reduce((count, kind) => count + source.listenerCount(kind), 0),
  };
}

/**
 * A made-up watch for the Mac having slept. No timer is set: the test says when the Mac "slept"
 * by calling `fire`, which is what the real watch's timer would do on its first late tick. Or by
 * calling `sleepUnnoticed`: the Mac slept and has woken, but the watch's timer has not ticked
 * yet, so the sleep is only seen when the command asks the watch to look.
 */
export function fakeSleepWatch() {
  const watches: Array<{ options: SleepWatchOptions; stopped: boolean }> = [];
  let unnoticedMs: number | null = null;
  const tell = (one: { options: SleepWatchOptions; stopped: boolean }, gapMs: number): void => {
    if (one.stopped) return;
    one.stopped = true;
    one.options.onSleep(gapMs);
  };
  const watch: WatchForSleep = (options) => {
    const one = { options, stopped: false };
    watches.push(one);
    return {
      stop: () => void (one.stopped = true),
      look: () => {
        looks += 1;
        if (unnoticedMs !== null) tell(one, unnoticedMs);
      },
    };
  };
  let looks = 0;
  return {
    watch,
    /** How many watches were ever started. */
    started: () => watches.length,
    /** How many are still looking. None may be left when a command returns. */
    watching: () => watches.filter((one) => !one.stopped).length,
    /** The Mac slept for `gapMs` (default two hours) and has just woken. Like the real watch, it fires once and is done. */
    fire: (gapMs = 2 * 3_600_000) => {
      for (const one of watches) tell(one, gapMs);
    },
    /** The Mac slept for `gapMs` and has just woken, and the watch's own timer has not come round yet. */
    sleepUnnoticed: (gapMs = 2 * 3_600_000) => void (unnoticedMs = gapMs),
    /** How often a command asked a watch to look at the clock right now. */
    looks: () => looks,
  };
}

/** A made-up hold on the Mac's sleep. Nothing is started: taking and letting go are noted in `order`. */
export function fakeKeepAwake(order: string[] = []) {
  const loggers: Logger[] = [];
  let held = 0;
  const keepAwake: KeepAwakeHold = (logger) => {
    loggers.push(logger);
    held += 1;
    order.push("keep awake");
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        held -= 1;
        order.push("let sleep");
      },
    };
  };
  return { keepAwake, order, loggers, /** Holds not let go of yet. None may be left when a command returns. */ held: () => held };
}

/** The night clock's marks, as `--if-due` hands them over. Each call is noted in `order`. */
export function fakeMarks(order: string[] = []) {
  const ended: Array<"finished" | "cut-short"> = [];
  let started = 0;
  const marks: NightRunMarks = {
    started: () => {
      started += 1;
      order.push("mark started");
    },
    ended: (how) => {
      ended.push(how);
      order.push(`mark ended ${how}`);
    },
  };
  return { marks, order, started: () => started, ended };
}
