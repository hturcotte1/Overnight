// The lines of build.log and deliver.log that the dashboard understands.
//
// The night's ticks on the page (sign-in fresh, sandbox check passed, building, checked, pushed,
// live, sent to the wrist) are read from what the other packages log. Those packages do not know
// the dashboard exists, so these texts are copies. test/log-messages.test.ts finds every one of
// them in the file named as its `source`, and fails with the name of the entry when one was
// reworded. A message that is not in this table is ignored, so new log lines break nothing.
//
// Nothing free-form is ever shown from a log: only numbers from the fields in LOG_FIELDS, and our
// own words chosen by which entry matched.

export interface LogMessage {
  /** Which file under <data folder>/logs: build.log or deliver.log. Lines there are read only under the same name. */
  log: "build" | "deliver";
  text: string;
  /** "starts": the logged line goes on after the text. "ends": a command's name comes before it. */
  match: "exact" | "starts" | "ends";
  /** The file that logs it, from the top of the repo. */
  source: string;
}

export const LOG_MESSAGES = {
  buildRunStart:    { log: "build", text: "overnight build starting", match: "exact", source: "packages/cli/src/commands/build.ts" },
  buildRunEnd:      { log: "build", text: "overnight build finished", match: "exact", source: "packages/cli/src/commands/build.ts" },          // built, failed, skipped
  handRunStart:     { log: "build", text: ": build starting", match: "ends", source: "packages/cli/src/commands/build-now.ts" },               // prefix "overnight build-now" or "overnight rehearse"
  handRunEnd:       { log: "build", text: ": build finished", match: "ends", source: "packages/cli/src/commands/build-now.ts" },
  nightStart:       { log: "build", text: "build night started", match: "exact", source: "packages/builder/src/night.ts" },                   // approved, retries, limit, building
  nightPaused:      { log: "build", text: "build night skipped: Overnight is paused", match: "exact", source: "packages/builder/src/night.ts" },
  nightEnd:         { log: "build", text: "build night finished", match: "exact", source: "packages/builder/src/night.ts" },
  ideaStart:        { log: "build", text: "build started", match: "exact", source: "packages/builder/src/night.ts" },                         // ideaId, backend
  signInReady:      { log: "build", text: "Kiro's sign-in is ready for the build", match: "exact", source: "packages/builder/src/kiro-signin.ts" },   // minutesLeft
  signInWaiting:    { log: "build", text: "Kiro's sign-in is about to run out; waiting for that, then renewing it before the build", match: "exact", source: "packages/builder/src/kiro-signin.ts" },
  signedOut:        { log: "build", text: "Kiro is signed out, so nothing can be built", match: "exact", source: "packages/builder/src/kiro-signin.ts" },
  signInUnknown:    { log: "build", text: "could not ask Kiro whether it is signed in; trying the build anyway", match: "exact", source: "packages/builder/src/kiro-signin.ts" },
  sandboxPassed:    { log: "build", text: "build sandbox check passed", match: "starts", source: "packages/builder/src/probe.ts" },           // ms
  sandboxFailed:    { log: "build", text: "build sandbox check failed", match: "starts", source: "packages/builder/src/probe.ts" },           // ms
  crewStarted:      { log: "build", text: "kiro crew build started", match: "exact", source: "packages/builder/src/kiro-crew.ts" },           // ideaId
  cliStarted:       { log: "build", text: "kiro cli build started", match: "exact", source: "packages/builder/src/kiro-cli.ts" },             // ideaId
  fallback:         { log: "build", text: "build failed; trying the other backend once", match: "exact", source: "packages/builder/src/night.ts" },   // ideaId
  ideaBuilt:        { log: "build", text: "build finished", match: "exact", source: "packages/builder/src/night.ts" },                        // ideaId, backend, seconds, credits
  ideaFailed:       { log: "build", text: "build failed", match: "exact", source: "packages/builder/src/night.ts" },                          // ideaId, seconds
  // Where a finished build ended up: out of the build jobs' reach (builder, seal.ts), or not quite, or not at all.
  // The middle one goes on to say who could still change the files that were not made anew, and that the morning
  // tests the app all the same. The page takes nothing from that part: "not made anew" is all it goes by.
  sealed:           { log: "build", text: "finished build moved out of the builders' reach", match: "exact", source: "packages/builder/src/night.ts" },   // ideaId
  sealedPartly:     { log: "build", text: "a finished build was moved out of the builders' reach, but some of its files could not be made anew", match: "starts", source: "packages/builder/src/night.ts" },   // ideaId, files
  notSealed:        { log: "build", text: "a finished build could not be moved out of the builders' reach; the morning uses it where it is", match: "exact", source: "packages/builder/src/night.ts" },   // ideaId
  // The Mac slept through part of a run. The text is the start every command's line shares (SLEPT_LINE); what follows it differs by command.
  buildSlept:       { log: "build", text: "the Mac went to sleep during the run; what was in progress was stopped", match: "starts", source: "packages/cli/src/sleep-watch.ts" },
  deliverSlept:     { log: "deliver", text: "the Mac went to sleep during the run; what was in progress was stopped", match: "starts", source: "packages/cli/src/sleep-watch.ts" },
  deliverRunStart:  { log: "deliver", text: "overnight deliver starting", match: "exact", source: "packages/cli/src/commands/deliver.ts" },
  deliverRunEnd:    { log: "deliver", text: "overnight deliver finished", match: "exact", source: "packages/cli/src/commands/deliver.ts" },   // delivered, failed, notified
  handDeliverStart: { log: "deliver", text: ": deliver starting", match: "ends", source: "packages/cli/src/commands/build-now.ts" },
  handDeliverEnd:   { log: "deliver", text: ": deliver finished", match: "ends", source: "packages/cli/src/commands/build-now.ts" },
  verified:         { log: "deliver", text: "verified a built app", match: "exact", source: "packages/deliver/src/verifier.ts" },             // ideaId, files, bytes, ms
  notVerified:      { log: "deliver", text: "a built app did not pass verification", match: "exact", source: "packages/deliver/src/verifier.ts" },   // ideaId, step, ms
  pushed:           { log: "deliver", text: "pushed a build to the apps repo", match: "exact", source: "packages/deliver/src/publisher.ts" },
  live:             { log: "deliver", text: "the new version is live", match: "exact", source: "packages/deliver/src/publisher.ts" },         // liveAfterMs
  notSeenLive:      { log: "deliver", text: "the new version was pushed but was not seen live before the wait ran out", match: "exact", source: "packages/deliver/src/publisher.ts" },
  told:             { log: "deliver", text: "told the wearer about a built app", match: "exact", source: "packages/deliver/src/deliver.ts" },
  toldFailure:      { log: "deliver", text: "told the wearer an app could not be finished", match: "exact", source: "packages/deliver/src/deliver.ts" },
  fact:             { log: "deliver", text: "wrote the Bee fact", match: "exact", source: "packages/deliver/src/deliver.ts" },
} as const satisfies Record<string, LogMessage>;

// Lines left out on purpose, so nobody adds them thinking they were forgotten:
//   - "build night stopped early: the month's ceiling on build credits is reached" and "build-now
//     refused: …": the pages say that the month is used up from the ledger in the database, as
//     `overnight status` does, and that stays right when a log is lost.
//   - "build try counted" and the two warnings about a builder's credit figure: what was counted
//     is the ledger's to say (Settings shows its sum). The credits beside a build are the
//     builder's own figure for the try that built it, from "build finished".
//   - "the Mac slept during a kiro crew build; …" (and "kiro cli"): the builder's own note for
//     its cost reckoning. The run's line above says the same thing once, for either builder.
//   - Every "… did not stop in time …" and "could not …" line: a person reads those in the log.

/**
 * The only fields of a log line that are kept. Everything else is dropped when the line is read:
 * a start line carries the data folder's path, which holds the account's name.
 */
export const LOG_FIELDS = ["ideaId", "backend", "minutesLeft", "ms", "seconds", "credits", "approved", "retries", "limit", "building", "built", "failed", "skipped", "delivered", "notified", "files", "bytes", "step", "liveAfterMs", "ok"] as const;

export type LogMessageKey = keyof typeof LOG_MESSAGES;
export type LogField = (typeof LOG_FIELDS)[number];

/** The table sorted once, for the look-up below: per log, the whole texts by text, and the rest in the table's order. */
function sortFor(log: LogMessage["log"]): { whole: ReadonlyMap<string, LogMessageKey>; partial: ReadonlyArray<{ key: LogMessageKey; text: string; match: "starts" | "ends" }> } {
  const whole = new Map<string, LogMessageKey>();
  const partial: Array<{ key: LogMessageKey; text: string; match: "starts" | "ends" }> = [];
  for (const key of Object.keys(LOG_MESSAGES) as LogMessageKey[]) {
    const entry: LogMessage = LOG_MESSAGES[key];
    if (entry.log !== log) continue;
    if (entry.match === "exact") whole.set(entry.text, key);
    else partial.push({ key, text: entry.text, match: entry.match });
  }
  return { whole, partial };
}

const SORTED = { build: sortFor("build"), deliver: sortFor("deliver") } as const;

/**
 * Which entry a logged message is, or null for a line the dashboard does not know.
 * Whole-text matches are tried first, so "build finished" (one idea was built) is never taken for
 * "overnight build-now: build finished" (a run by hand ended), nor the other way round.
 */
export function matchLogMessage(log: LogMessage["log"], message: string): LogMessageKey | null {
  const { whole, partial } = SORTED[log];
  const exact = whole.get(message);
  if (exact !== undefined) return exact;
  for (const entry of partial) {
    if (entry.match === "starts" ? message.startsWith(entry.text) : message.endsWith(entry.text)) return entry.key;
  }
  return null;
}

// ---------- Other values copied from packages the dashboard does not load ----------
// The cli is only a test-time neighbour of this package, and builder is loaded only by the demo.
// test/log-messages.test.ts compares each value below with the real one.

/** The conversation key `overnight rehearse` gives the ideas it invents (cli, commands/rehearse.ts). */
export const REHEARSAL_CONVERSATION_KEY = "rehearsal";
/** The deliver job starts this many minutes before DELIVER_TIME (cli, background.ts). */
export const DELIVER_LEAD_MINUTES = 30;
/** The three lock files, by name, in the top of the data folder (cli, single-instance.ts). */
export const LOCK_FILE_NAMES = { listener: "listen.lock", build: "build.lock", deliver: "deliver.lock" } as const;
/** What comes before ": build starting" and its three sisters (cli, commands/build-now.ts and rehearse.ts). */
export const HAND_RUN_NAMES = { "build-now": "overnight build-now", rehearse: "overnight rehearse" } as const;
/** The `skipped` field of "overnight build finished" (builder, night.ts). Any other value is not compared. */
export const SKIPPED_VALUES = { paused: "paused", nothingApproved: "nothing approved" } as const;
/** A build still marked "building" this long after its time limit counts as cut off (builder, night.ts). */
export const INTERRUPTED_GRACE_MINUTES = 15;
