// The only code in Overnight that talks to Bee. It implements BeeGateway (from @overnight/core)
// on top of Bee's official library, which runs the `bee` program and parses what it prints.
//
// Four promises this file keeps:
// - Every command has a time limit. The library's own helpers (client.api.*) take no options, so
//   each command goes through client.runJson with an abort signal instead.
// - Nothing but the fields in the BeeGateway types leaves here. Raw replies and raw stream
//   payloads hold names and transcripts; they are never returned, stored or logged.
// - A bad payload, a failing handler, a failing logger or a dead stream never throws into the
//   caller's loop.
// - A to-do is not created twice. When a create fails in a way that may still have reached Bee,
//   createTodo looks for the to-do before it reports the failure, and the kind of the error it
//   throws says whether the to-do may exist (see errors.ts).
import { createBeeClient } from "@beeai/cli/lib";
import { BeeError, silentLogger } from "@overnight/core";
import type { BackfillUtterance, BeeEvent, BeeGateway, BeeStream, ChangedSince, Logger, LoginState, StreamEnd, TodoStatus } from "@overnight/core";
import { defaultBeeBinary } from "./binary.ts";
import { safeFirstLine, toBeeError } from "./errors.ts";
import type { ErrorHints } from "./errors.ts";
import { neverThrowing } from "./logging.ts";
import { findOpenTodo, parseChanged, parseCreatedTodo, parseTodoCompleted, parseTranscript } from "./replies.ts";
import { sanitiseStreamPayload } from "./sanitise.ts";

/** The part of Bee's library we use. The real client fits it; tests pass a fake. */
export type BeeClientLike = {
  runJson<T = unknown>(args: string[], options?: { signal?: AbortSignal }): Promise<T>;
  sse: {
    streamJson<T = unknown>(options?: { types?: string[]; signal?: AbortSignal }): {
      events: AsyncIterable<{ data: T; raw: string }>;
      close(): void;
      /**
       * The real client also returns the child process. Fakes can leave it out.
       * `exited` rejects if the program cannot be started. `stdout` is the pipe the events are
       * read from; we set its encoding (see stream() below).
       */
      process?: { exited: Promise<unknown>; stdout?: { setEncoding?: (encoding: "utf8") => unknown } | null };
    };
  };
};

export interface BeeGatewayOptions {
  logger?: Logger;
  /** Full path of the `bee` program. Default: the binary inside node_modules (defaultBeeBinary()). */
  command?: string;
  /** Time limit for each command: a whole number of milliseconds, at most about 24 days. Default 30 seconds. */
  timeoutMs?: number;
  /** Event types to ask the live stream for. All of them share one stream. */
  streamTypes?: string[];
  /** A ready-made client, for tests. When given, `command` is ignored. */
  client?: BeeClientLike;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/** The longest wait a JavaScript timer can hold. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_STREAM_TYPES: readonly string[] = ["new-utterance", "new-conversation", "update-conversation", "delete-conversation", "todo-deleted"];

const TODO_NOT_FOUND = /todo not found/i;
const CONVERSATION_NOT_FOUND = /conversation not found/i;

// Where createTodo looks for a to-do whose "created" reply never arrived. Twenty is far more
// than Bee and Overnight create between them in the two minutes that matter.
const RECENT_TODOS = ["todos", "list", "--limit", "20"];
// A to-do's created time is Bee's clock; "when we started" is this Mac's. They may disagree.
const CLOCK_SLACK_MS = 120_000;

// An error's name is logged, so it must look like a name.
function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9_$]{0,59}$/.test(error.name) ? error.name : "Error";
}

// Every gateway's "stop everything" switch. One listener on the process's exit flips them all,
// however many gateways there are, so the bee programs still running at that moment are stopped
// with us and not left behind. (Aborting a signal kills the child straight away, which is all an
// "exit" listener has time for.)
const stopSwitches = new Set<AbortController>();
let watchingExit = false;

function stopEverythingInFlight(): void {
  for (const stopAll of [...stopSwitches]) stopAll.abort();
  stopSwitches.clear();
}

function stopAtExit(stopAll: AbortController): void {
  stopSwitches.add(stopAll);
  if (watchingExit) return;
  watchingExit = true;
  process.once("exit", stopEverythingInFlight);
}

/** A BeeGateway that can also be told to stop: see dispose(). */
export type DisposableBeeGateway = BeeGateway & {
  /**
   * Optional. Stops every bee command and stream this gateway still has running, as the
   * process's exit would, and lets go of the gateway. Commands started afterwards fail at once.
   */
  dispose(): void;
};

export function createBeeGateway(options: BeeGatewayOptions = {}): DisposableBeeGateway {
  const log = neverThrowing(options.logger ?? silentLogger);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // AbortSignal.timeout() throws for anything else, and it is called on every command.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  const streamTypes = [...(options.streamTypes ?? DEFAULT_STREAM_TYPES)];
  const client: BeeClientLike = options.client ?? createBeeClient({ command: options.command ?? defaultBeeBinary() });
  // Aborted when the process exits, or by dispose(). Everything in flight listens to it.
  const stopAll = new AbortController();
  stopAtExit(stopAll);

  /**
   * Run one bee command with a time limit and return its parsed JSON. Throws only BeeErrors.
   * `label` names the command in errors and logs. It is fixed text, never built from the
   * arguments, because arguments can hold to-do text.
   */
  async function run(label: string, args: string[], hints?: ErrorHints): Promise<unknown> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, stopAll.signal]);
    // Only a real time limit is called one. Stopped because we are stopping is the same kind,
    // "timeout": we stopped waiting, and the request may have reached Bee (see createTodo).
    const timedOut = () =>
      stopAll.signal.aborted && !timeout.aborted
        ? new BeeError("timeout", `bee ${label} was stopped before it answered, because Overnight is stopping.`)
        : new BeeError("timeout", `bee ${label} timed out after ${timeoutMs / 1000} s`);
    // The signal makes the library kill the child process. The race makes the limit hold even
    // if a client were to ignore the signal.
    const limit = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(timedOut()), { once: true });
    });
    // If a client throws straight away, the race below never starts and nothing is listening
    // when the timer fires later. Node stops the process over a rejection nobody handles.
    limit.catch(() => {});
    try {
      // Already stopping: don't start a program only to kill it.
      if (signal.aborted) throw timedOut();
      const reply = await Promise.race([client.runJson<unknown>(args, { signal }), limit]);
      log.debug("Bee command finished", { command: label, ms: Date.now() - started });
      return reply;
    } catch (error) {
      const failure = signal.aborted ? timedOut() : toBeeError(label, error, hints);
      log.debug("Bee command failed", { command: label, kind: failure.kind, ms: Date.now() - started });
      throw failure;
    }
  }

  async function loginState(): Promise<LoginState> {
    try {
      // The reply holds the account holder's real name. It is not read, kept or logged.
      await run("me", ["me"], { rejectedLoginIsLoggedOut: true });
      return "logged-in";
    } catch (error) {
      const failure = toBeeError("me", error);
      if (failure.kind === "logged-out") return "logged-out";
      // Offline, slow or broken is not the same as logged out. Say we don't know.
      // Only the kind is logged: the error's text comes from outside and is not ours to vouch for.
      log.warn("Could not check the Bee login", { kind: failure.kind });
      return "unknown";
    }
  }

  function stream(onEvent: (event: BeeEvent) => void): BeeStream {
    const started = Date.now();
    let closed = false;
    let over = false;
    let delivered = 0;
    let dropped = 0;
    let resolveDone: (end: StreamEnd) => void = () => {};
    const done = new Promise<StreamEnd>((resolve) => {
      resolveDone = resolve;
    });

    const finish = (end: StreamEnd): void => {
      if (over) return;
      over = true;
      // Tell whoever is waiting first. Nothing after this line can keep `done` from resolving.
      resolveDone(end);
      log.info("Bee stream over", { reason: end.reason, error: end.message, delivered, dropped, ms: Date.now() - started });
    };

    const handlerFailed = (eventType: string, error: unknown): void => {
      // Neither the event nor the error's message is logged. The handler is the code that holds
      // what somebody said, so its error text can quote it. The kind of error is enough to go on.
      log.error("A Bee event handler failed", { eventType, errorName: safeErrorName(error) });
    };

    const handle = (data: unknown): void => {
      const result = sanitiseStreamPayload(data);
      if (!result.ok) {
        dropped += 1;
        const fields = { eventType: result.eventType, problem: result.problem, fields: result.fields ?? undefined };
        // Empty lines are ordinary noise. Anything else means Bee sent something we did not expect.
        if (result.problem === "empty-text") log.debug("Dropped a Bee stream event", fields);
        else log.warn("Dropped a Bee stream event", fields);
        return;
      }
      delivered += 1;
      try {
        const returned: unknown = onEvent(result.event);
        // An async handler that fails must not become an unhandled rejection, which would stop Node.
        if (returned instanceof Promise) returned.catch((error: unknown) => handlerFailed(result.event.type, error));
      } catch (error) {
        handlerFailed(result.event.type, error);
      }
    };

    let source: ReturnType<BeeClientLike["sse"]["streamJson"]>;
    try {
      source = client.sse.streamJson<unknown>({ types: streamTypes });
    } catch (error) {
      finish({ reason: "error", message: safeFirstLine(error) });
      return { close: () => {}, done };
    }
    // If the bee program cannot be started, the library rejects this promise before anything is
    // listening to it, and Node stops the whole process over an unhandled rejection. The same
    // failure still reaches us through the event iterator below.
    source.process?.exited.catch(() => {});
    // The library (0.7.3) decodes each piece of the stream's output by itself, so a character
    // whose bytes straddle two pieces (any accent, any emoji) arrives as "unknown character"
    // marks (U+FFFD) inside what somebody said. Telling the pipe it carries UTF-8 makes Node hold
    // a half character back until the rest of it arrives. It must happen before anything is read.
    try {
      source.process?.stdout?.setEncoding?.("utf8");
    } catch {
      // No worse off than before.
    }
    log.info("Bee stream opened", { types: streamTypes.join(",") });

    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        source.close();
      } catch {
        // Already gone.
      }
      // Don't wait for the child to wind down: the caller asked to stop, so we have stopped.
      finish({ reason: "closed" });
    };
    // The stream's program must not outlive us either: closing it kills it. (The stream is not
    // handed the signal itself; close() is the way of stopping it the library documents.)
    if (stopAll.signal.aborted) close();
    else stopAll.signal.addEventListener("abort", close, { once: true });
    void done.then(() => stopAll.signal.removeEventListener("abort", close));

    void (async () => {
      try {
        for await (const item of source.events) {
          if (closed) break;
          handle(item.data);
        }
        finish({ reason: closed ? "closed" : "ended" });
      } catch (error) {
        // close() kills the child, and the library reports that as an error. It is not one.
        finish(closed ? { reason: "closed" } : { reason: "error", message: safeFirstLine(error) });
      }
    })();

    return { close, done };
  }

  async function changedSince(cursor: string | null): Promise<ChangedSince> {
    const args = cursor === null || cursor === "" ? ["changed"] : ["changed", "--cursor", cursor];
    const { nextCursor, conversationIds, skipped } = parseChanged(await run("changed", args));
    log.debug("Bee changes read", { hadCursor: args.length > 1, gotCursor: nextCursor !== null, conversations: conversationIds.length, skipped });
    return { nextCursor, conversationIds };
  }

  async function transcriptSince(conversationBeeId: number, sinceMs: number): Promise<BackfillUtterance[] | null> {
    if (!Number.isSafeInteger(conversationBeeId)) throw new BeeError("failed", "transcriptSince needs a whole-number conversation id.");
    if (!Number.isFinite(sinceMs)) throw new BeeError("failed", "transcriptSince needs a time in milliseconds.");
    const since = Math.floor(sinceMs);
    let reply: unknown;
    try {
      reply = await run("conversations transcript", ["conversations", "transcript", String(conversationBeeId), "--since", String(since)], { notFound: CONVERSATION_NOT_FOUND });
    } catch (error) {
      // Bee deletes very short recordings a few minutes after they are made. That is normal.
      if (error instanceof BeeError && error.kind === "not-found") return null;
      throw error;
    }
    const { lines, skipped } = parseTranscript(reply, since);
    log.debug("Bee transcript read", { conversationBeeId, lines: lines.length, skipped });
    return lines;
  }

  /**
   * After a create that failed in a way that may still have reached Bee: is the to-do there?
   *
   * A time limit, a dropped connection or an unreadable reply all leave that open. The request
   * can land a moment before the bee program is stopped. If the caller then simply tried again,
   * the wrist would buzz twice for one idea and only the second to-do would be watched.
   *
   * Returns the to-do's id, or null when it is not there or we could not find out. Never throws.
   */
  async function findLostTodo(text: string, startedMs: number, failure: BeeError): Promise<{ id: number } | null> {
    // These two kinds are proof that nothing was created (see errors.ts). Nothing to look for.
    if (failure.kind === "failed" || failure.kind === "logged-out") return null;
    try {
      const id = findOpenTodo(await run("todos list", [...RECENT_TODOS]), text, startedMs - CLOCK_SLACK_MS);
      if (id === null) {
        log.info("No Bee to-do found after a failed create", { kind: failure.kind });
        return null;
      }
      log.info("Bee to-do found after a failed create", { todoId: id, kind: failure.kind });
      return { id };
    } catch (error) {
      log.warn("Could not look for the Bee to-do after a failed create", { kind: failure.kind, lookupKind: toBeeError("todos list", error).kind });
      return null;
    }
  }

  /**
   * Create a to-do with an alarm. Worst case this takes two time limits: one for the create and
   * one for the look-up after a create that may or may not have worked.
   *
   * The kind of the error it throws tells the caller what to do next: "failed" and "logged-out"
   * mean nothing was created, so trying again is safe; "timeout" and "bad-response" mean the
   * to-do may exist (we looked and could not find it, or could not look), so the caller must not
   * create another one.
   */
  async function createTodo(text: string, alarmAt: Date): Promise<{ id: number }> {
    if (text.trim() === "") throw new BeeError("failed", "createTodo needs some text.");
    // Node will not start a program with a NUL character in an argument, and says so by quoting
    // the argument. Refuse it here, in our own words.
    if (text.includes("\u0000")) throw new BeeError("failed", "createTodo cannot send text with a NUL character in it.");
    if (Number.isNaN(alarmAt.getTime())) throw new BeeError("failed", "createTodo needs a valid alarm time.");
    const startedMs = Date.now();
    let created: { id: number };
    try {
      // toISOString() is always UTC ending in Z, which is the form Bee stored exactly in spike 3.
      created = parseCreatedTodo(await run("todos create", ["todos", "create", "--text", text, "--alarm-at", alarmAt.toISOString()]));
    } catch (error) {
      const failure = toBeeError("todos create", error);
      const found = await findLostTodo(text, startedMs, failure);
      if (found === null) throw failure;
      return found;
    }
    log.info("Bee to-do created", { todoId: created.id });
    return created;
  }

  async function todoStatus(id: number): Promise<TodoStatus> {
    if (!Number.isSafeInteger(id)) throw new BeeError("failed", "todoStatus needs a whole-number to-do id.");
    let reply: unknown;
    try {
      reply = await run("todos get", ["todos", "get", String(id)], { notFound: TODO_NOT_FOUND });
    } catch (error) {
      // Only Bee's own "Todo not found" means deleted. Offline, slow or logged out all throw.
      if (error instanceof BeeError && error.kind === "not-found") return "deleted";
      throw error;
    }
    return parseTodoCompleted(reply) ? "completed" : "open";
  }

  function dispose(): void {
    stopAll.abort();
    stopSwitches.delete(stopAll);
  }

  return { loginState, stream, changedSince, transcriptSince, createTodo, todoStatus, dispose };
}
