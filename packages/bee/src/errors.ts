// Turns whatever the Bee library throws into a BeeError with a short, safe message.
//
// A failing bee command prints its error on standard error and its usage text on standard
// output, and exits 1. The library then throws a plain Error whose message is that error text.
//
// The kind of a BeeError says how sure we are that nothing happened. createTodo's callers rely on
// it (see BeeGateway in @overnight/core): creating the same to-do twice buzzes the wrist twice.
//
//   "failed"        Nothing happened, and we can show it: the bee program never started, the
//                   request never left this Mac, or Bee's server turned it down.
//   "logged-out"    Nothing happened, because there is no login.
//   "not-found"     Bee says the thing asked for does not exist.
//   "timeout"       We stopped waiting. The request may have reached Bee.
//   "bad-response"  There was no answer we could use. The request may have reached Bee.
//
// Whatever we do not recognise is "bad-response". Saying "nothing happened" needs proof.
import { BeeError } from "@overnight/core";

const GENERIC = "no error message";

// Texts that prove a request was not carried out.
const REFUSALS: readonly RegExp[] = [
  // The bee program's own words when Bee's server answers with a 4xx status and no text of its
  // own (from the CLI's source at 0.7.3; the same sentence with 503 was seen for real).
  /^Request failed with status 4\d\d\b/,
  // No connection could be made: nothing answered at that address, or the name could not be
  // looked up, which is what being offline looks like. Seen for real on 2026-10-09 by pointing
  // `bee me` at a dead local address. A connection that drops later reads differently ("The
  // socket connection was closed unexpectedly") and is not proof of anything.
  /^Unable to connect\. Is the computer able to access the url\?/,
];

// A login that Bee's server no longer accepts. NOT SEEN FOR REAL YET: testing it would mean
// breaking the login. With no token at all the bee program says "Not logged in" before it calls
// anyone. With a rejected token it would pass on the server's own words, or "Request failed with
// status 401". Only the login check reads an error this way.
const REJECTED_LOGIN = /(^|\s)401\b|unauthori[sz]ed/i;

// The only error texts that are passed on in a BeeError's message: sentences the bee program
// itself writes. Each is given back in our own fixed wording (only a three-digit status is copied
// from the line), so nothing else that happens to be on the line comes along with it.
const KNOWN_SENTENCES: ReadonlyArray<readonly [RegExp, string | ((match: RegExpExecArray) => string)]> = [
  [/^Request failed with status (\d{3})(?!\d)/, (match) => `Request failed with status ${match[1]}`],
  [/^Unable to connect\. Is the computer able to access the url\?/, "Unable to connect. Is the computer able to access the url?"],
  [/^The socket connection was closed unexpectedly/, "The socket connection was closed unexpectedly."],
  [/^Not logged in\b/, "Not logged in."],
  [/^Todo not found\b/, "Todo not found."],
  [/^Conversation not found\b/, "Conversation not found."],
  [/^[a-z][a-z -]{0,40} does not accept arguments\b/, "The command does not accept arguments."],
  [/^Unknown option\b/, "Unknown option."],
  [/^Unknown command\b/, "Unknown command."],
];

/** One of the bee program's own error sentences, in fixed words, or null for anything else. */
function knownSentence(firstLine: string): string | null {
  for (const [pattern, wording] of KNOWN_SENTENCES) {
    const match = pattern.exec(firstLine);
    if (match !== null) return typeof wording === "string" ? wording : wording(match);
  }
  return null;
}

export interface ErrorHints {
  /**
   * The "it does not exist" message for this one command, if it has one: only that exact answer
   * becomes kind "not-found", so a to-do is never taken for deleted by accident.
   */
  notFound?: RegExp;
  /** Read a login the server rejects (HTTP 401) as "logged-out". */
  rejectedLoginIsLoggedOut?: boolean;
}

function firstLineOf(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

/**
 * The first line of an error from the bee program, short enough and safe enough to pass on.
 * A line that looks like data is replaced: it could be the start of a reply, and replies can hold
 * names and speech.
 */
export function safeFirstLine(error: unknown): string {
  const line = firstLineOf(error instanceof Error ? error.message : String(error)).slice(0, 200);
  return line === "" || /^[[{"]/.test(line) ? GENERIC : line;
}

/** Node's code for one of its own errors ("ENOENT", "ERR_INVALID_ARG_VALUE"), or null. */
function nodeErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return null;
  // The code goes into a message, so it must look like a code.
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(error.code) ? error.code : "UNKNOWN";
}

/** True when Node could not even start the program, so no request can have been made. */
function neverStarted(error: Error, code: string): boolean {
  // "spawn /path/to/bee ENOENT", "spawn E2BIG": the operating system refused to start it.
  if ("syscall" in error && typeof error.syscall === "string" && error.syscall.startsWith("spawn")) return true;
  // Node turned an argument down before trying, for example text with a NUL character in it.
  return code === "ERR_INVALID_ARG_VALUE" || code === "ERR_INVALID_ARG_TYPE";
}

/** Map a failed command to a BeeError. `label` is fixed text that names the command. */
export function toBeeError(label: string, error: unknown, hints: ErrorHints = {}): BeeError {
  if (error instanceof BeeError) return error;

  // Node's own errors come first, and their messages are never passed on or matched against:
  // they can quote an argument ("... Received '<the text>'"), and an argument can be to-do text.
  const code = nodeErrorCode(error);
  if (code !== null && error instanceof Error) {
    if (code === "ABORT_ERR") return new BeeError("timeout", `bee ${label} was stopped before it answered.`);
    if (neverStarted(error, code)) return new BeeError("failed", `bee ${label} failed: the bee program could not be started (${code}).`);
    // The program was running, so it may have reached Bee before this went wrong.
    return new BeeError("bad-response", `bee ${label} broke off before its reply could be read (${code}).`);
  }

  const message = error instanceof Error ? error.message : String(error);
  // The library's message for unreadable output quotes a piece of that output. Never pass it on,
  // and check for it first so the quoted piece cannot be mistaken for one of Bee's own messages.
  if (message.startsWith("Failed to parse Bee CLI JSON output")) {
    return new BeeError("bad-response", `bee ${label} printed something that is not JSON.`);
  }
  if (/not logged in/i.test(message)) return new BeeError("logged-out", `bee ${label} failed: Bee is not logged in.`);
  const firstLine = firstLineOf(message);
  if (hints.rejectedLoginIsLoggedOut && REJECTED_LOGIN.test(firstLine)) {
    return new BeeError("logged-out", `bee ${label} failed: Bee did not accept the login.`);
  }
  if (hints.notFound?.test(message)) return new BeeError("not-found", `bee ${label}: Bee says it does not exist.`);

  const refused = REFUSALS.some((refusal) => refusal.test(firstLine));
  const known = knownSentence(firstLine);
  // Anything we do not know is not repeated. With nothing on standard error the library uses
  // standard output as the message, and that can be the start of a reply: a name, or speech.
  const text = known === null ? `bee ${label} failed with an unrecognised error` : `bee ${label} failed: ${known}`;
  return new BeeError(refused ? "failed" : "bad-response", text);
}
