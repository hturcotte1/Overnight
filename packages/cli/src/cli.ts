// The `overnight` command line: read the arguments, open the data, hand over to one command.
// Each command lives in src/commands and takes what it needs as arguments, so the tests can run
// it against an in-memory database without starting a process.
import path from "node:path";
import { ConfigError, createLogger, errorSummary } from "@overnight/core";
import type { DataPaths, Logger, LoginState } from "@overnight/core";
import { parseArgs } from "./args.ts";
import { readListenerState } from "./background.ts";
import type { ListenerState } from "./background.ts";
import { ideas } from "./commands/ideas.ts";
import { listen } from "./commands/listen.ts";
import type { ListenFactories } from "./commands/listen.ts";
import { pause, resume } from "./commands/pause.ts";
import { queue } from "./commands/queue.ts";
import { status } from "./commands/status.ts";
import { openContext } from "./context.ts";
import type { Context } from "./context.ts";
import type { Write } from "./output.ts";
import { takeListenLock } from "./single-instance.ts";
import type { ReleaseLock } from "./single-instance.ts";
import { USAGE } from "./usage.ts";
import { realBeeLoginState, realListenFactories } from "./wiring.ts";

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
};

/** Each command and the switches it accepts. A Map, so "constructor" is not mistaken for a command. */
const COMMANDS = new Map<string, readonly string[]>([
  ["listen", []],
  ["status", ["json", "check"]],
  ["ideas", ["json", "all"]],
  ["queue", ["approved", "json"]],
  ["pause", []],
  ["resume", []],
]);

function usageError(io: CliIo, problem: string): number {
  io.writeError(problem);
  io.writeError("");
  io.writeError(USAGE);
  return EXIT_USAGE;
}

async function dispatch(command: string, flags: Set<string>, context: Context, io: CliIo): Promise<number> {
  const { store, config, paths } = context;
  const { write, now } = io;
  switch (command) {
    case "listen":
      return listen({ store, config, paths, logger: io.listenLogger(paths), factories: await io.listenFactories(), takeLock: io.takeListenLock });
    case "status":
      return status(
        { store, config, write, now, listenerState: () => io.listenerState(paths) },
        { json: flags.has("json"), beeLoginState: flags.has("check") ? io.beeLoginState : undefined },
      );
    case "ideas":
      return ideas({ store, config, write, now }, { json: flags.has("json"), all: flags.has("all") });
    case "queue":
      return queue({ store, config, write, writeError: io.writeError });
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
  if (unknown.length > 0 || extras.length > 0) {
    const stray = [...unknown.map((flag) => `--${flag}`), ...extras].join(", ");
    return usageError(io, `"overnight ${command}" does not understand: ${stray}`);
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
    if (error instanceof ConfigError) {
      io.writeError(error.message);
      io.writeError("Settings live in the .env file at the top of the repo (see .env.example).");
      return EXIT_USAGE;
    }
    io.writeError(`Overnight could not open its data folder. ${errorSummary(error)}`);
    return EXIT_FAILED;
  }
  try {
    return await dispatch(command, flags, context, io);
  } catch (error) {
    io.writeError(`"overnight ${command}" failed. ${errorSummary(error)}`);
    return EXIT_FAILED;
  } finally {
    context.store.close();
  }
}
