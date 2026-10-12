// The pin. The night's ticks on the dashboard are read from lines that builder, deliver and the
// cli write to build.log and deliver.log. src/log-messages.ts holds copies of those texts. This
// test finds every copy in the file that logs it, so a reworded line fails here, by name, and
// not silently on the page.
//
// To see it fail by hand: copy packages/ to a scratch folder, reword one logged text in the copy,
// and run this file with PIN_SOURCES=<the scratch folder> (the folder that holds packages/).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKIPPED_NOTHING_APPROVED, SKIPPED_PAUSED } from "@overnight/builder";
import {
  BUILD_NOW_NAME,
  buildLockFile,
  DELIVER_LEAD_MINUTES as CLI_DELIVER_LEAD_MINUTES,
  deliverLockFile,
  listenLockFile,
  REHEARSAL_CONVERSATION_KEY as CLI_REHEARSAL_CONVERSATION_KEY,
  REHEARSE_NAME,
  SLEPT_LINE,
  sleptLine,
} from "@overnight/cli";
import { describe, expect, it } from "vitest";
import { TAILS } from "../src/demo/night-files.ts";
import {
  DELIVER_LEAD_MINUTES,
  HAND_RUN_NAMES,
  INTERRUPTED_GRACE_MINUTES,
  LOCK_FILE_NAMES,
  LOG_FIELDS,
  LOG_MESSAGES,
  matchLogMessage,
  REHEARSAL_CONVERSATION_KEY,
  SKIPPED_VALUES,
} from "../src/log-messages.ts";
import type { LogField, LogMessage, LogMessageKey } from "../src/log-messages.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCES_ROOT = process.env.PIN_SOURCES || REPO_ROOT;
const KEYS = Object.keys(LOG_MESSAGES) as LogMessageKey[];
const ENTRIES = KEYS.map((key) => ({ key, entry: LOG_MESSAGES[key] as LogMessage }));

function readSource(file: string): string {
  return readFileSync(path.join(SOURCES_ROOT, file), "utf8");
}

/**
 * How a text looks in the source that logs it: a whole text stands between double quotes, the
 * start of one opens with a double quote, and the end of one closes a template.
 */
function needle(entry: Pick<LogMessage, "text" | "match">): string {
  if (entry.match === "exact") return `"${entry.text}"`;
  if (entry.match === "starts") return `"${entry.text}`;
  return `${entry.text}\``;
}

/** The names of the entries whose text is not in `source`. */
function notPinned(entries: ReadonlyArray<{ key: string; entry: LogMessage }>, source: (file: string) => string): string[] {
  return entries.filter(({ entry }) => !source(entry.source).includes(needle(entry))).map(({ key }) => key);
}

/**
 * The fields the dashboard reads from each line, as the comments in src/log-messages.ts list
 * them. A field that is renamed where it is logged would turn a number on the page into nothing.
 * (An idea id that a logger adds to every line by itself is checked further down.)
 */
const FIELDS_LOGGED_WITH: Partial<Record<LogMessageKey, readonly LogField[]>> = {
  buildRunEnd: ["built", "failed", "skipped"],
  handRunStart: ["ideaId"],
  handRunEnd: ["ideaId", "ok"],
  nightStart: ["approved", "retries", "limit", "building"],
  nightEnd: ["built", "failed"],
  ideaStart: ["ideaId", "backend"],
  signInReady: ["minutesLeft"],
  sandboxPassed: ["ms"],
  sandboxFailed: ["ms"],
  crewStarted: ["ideaId"],
  cliStarted: ["ideaId"],
  fallback: ["ideaId"],
  ideaBuilt: ["ideaId", "backend", "seconds", "credits"],
  ideaFailed: ["ideaId", "seconds"],
  sealed: ["ideaId"],
  sealedPartly: ["ideaId", "files"],
  notSealed: ["ideaId"],
  deliverRunEnd: ["delivered", "failed", "notified"],
  handDeliverStart: ["ideaId"],
  handDeliverEnd: ["ideaId", "ok"],
  verified: ["files", "bytes", "ms"],
  notVerified: ["step", "ms"],
  live: ["liveAfterMs"],
  told: ["ideaId"],
  toldFailure: ["ideaId"],
  fact: ["ideaId"],
};

/** The statement that logs a text: from the text to the end of its line's statement. */
function statementWith(source: string, text: string): string {
  const at = source.indexOf(text);
  if (at === -1) return "";
  const end = source.indexOf(";\n", at);
  return source.slice(at, end === -1 ? undefined : end);
}

function logsField(statement: string, field: string): boolean {
  // As a key ("ideaId: idea.id") or by its own name ("{ ms }", "retries,").
  return new RegExp(`[{,]\\s*${field}\\s*[:,}]`).test(statement);
}

describe("LOG_MESSAGES", () => {
  it("names a source file that exists for every entry", () => {
    for (const { key, entry } of ENTRIES) {
      expect(existsSync(path.join(SOURCES_ROOT, entry.source)), `${key}: ${entry.source}`).toBe(true);
      expect(entry.source.startsWith("packages/") && entry.source.endsWith(".ts"), key).toBe(true);
    }
  });

  it("finds every text in the file that logs it", () => {
    // On a failure this prints the entries to look at. Either the line was reworded (change the
    // text here and check what the dashboard makes of it) or it moved (change `source`).
    expect(notPinned(ENTRIES, readSource)).toEqual([]);
  });

  it("would notice one reworded line", () => {
    const entry = LOG_MESSAGES.ideaBuilt;
    const real = readSource(entry.source);
    expect(real).toContain(`"${entry.text}"`);
    const reworded = real.replace(`"${entry.text}"`, `"the build is finished"`);
    const source = (file: string) => (file === entry.source ? reworded : readSource(file));
    // Compared with what is unpinned anyway, so this still says something on a day another line was reworded.
    expect(notPinned(ENTRIES, source).filter((key) => !notPinned(ENTRIES, readSource).includes(key))).toEqual(["ideaBuilt"]);
  });

  it("tells a whole text from the start or the end of one", () => {
    const source = () => `logger.info("build finished and more", {}); logger.info("x build sandbox check passed: fine"); logger.info(\`\${name}: build starting now\`);`;
    const entries = [
      { key: "whole", entry: { log: "build", text: "build finished", match: "exact", source: "a.ts" } },
      { key: "start", entry: { log: "build", text: "build sandbox check passed", match: "starts", source: "a.ts" } },
      { key: "end", entry: { log: "build", text: ": build starting", match: "ends", source: "a.ts" } },
    ] as const;
    expect(notPinned(entries, source)).toEqual(["whole", "start", "end"]);
    const right = () => `logger.info("build finished", {}); logger.info("build sandbox check passed: fine"); logger.info(\`\${name}: build starting\`);`;
    expect(notPinned(entries, right)).toEqual([]);
  });

  it("finds the fields the dashboard reads on the line that logs them", () => {
    const missing: string[] = [];
    for (const key of KEYS) {
      const entry: LogMessage = LOG_MESSAGES[key];
      const statement = statementWith(readSource(entry.source), needle(entry));
      for (const field of FIELDS_LOGGED_WITH[key] ?? []) {
        if (!logsField(statement, field)) missing.push(`${key}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("finds the idea id that deliver's checker and publisher put on every line they log", () => {
    // "verified a built app", "pushed a build to the apps repo" and "the new version is live" carry no idea id of their own.
    for (const file of new Set([LOG_MESSAGES.verified.source, LOG_MESSAGES.pushed.source])) {
      expect(readSource(file), file).toMatch(/\.child\(\{\s*ideaId\b/);
    }
  });

  it("has no two entries with the same text in the same log", () => {
    const seen = ENTRIES.map(({ entry }) => `${entry.log}|${entry.match}|${entry.text}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("is only about the two job logs", () => {
    for (const { key, entry } of ENTRIES) expect(["build", "deliver"], key).toContain(entry.log);
  });
});

describe("matchLogMessage", () => {
  it("knows every entry by a line as it would be logged", () => {
    for (const { key, entry } of ENTRIES) {
      const logged = entry.match === "starts" ? `${entry.text}: and whatever comes after` : entry.match === "ends" ? `${BUILD_NOW_NAME}${entry.text}` : entry.text;
      expect(matchLogMessage(entry.log, logged), key).toBe(key);
    }
  });

  it("tells one idea's build from a run by hand, and from the nightly run", () => {
    expect(matchLogMessage("build", "build finished")).toBe("ideaBuilt");
    expect(matchLogMessage("build", "overnight build finished")).toBe("buildRunEnd");
    expect(matchLogMessage("build", `${BUILD_NOW_NAME}: build finished`)).toBe("handRunEnd");
    expect(matchLogMessage("build", `${REHEARSE_NAME}: build starting`)).toBe("handRunStart");
    expect(matchLogMessage("build", "build started")).toBe("ideaStart");
    expect(matchLogMessage("build", "kiro crew build started")).toBe("crewStarted");
    expect(matchLogMessage("build", "build failed")).toBe("ideaFailed");
    expect(matchLogMessage("build", "build failed; trying the other backend once")).toBe("fallback");
    expect(matchLogMessage("deliver", `${REHEARSE_NAME}: deliver finished`)).toBe("handDeliverEnd");
    expect(matchLogMessage("deliver", "overnight deliver finished")).toBe("deliverRunEnd");
  });

  it("matches the start of a line only for the entries that say so", () => {
    expect(matchLogMessage("build", "build sandbox check failed: nothing will be built with Kiro Crew")).toBe("sandboxFailed");
    expect(matchLogMessage("build", "build sandbox check passed")).toBe("sandboxPassed");
    expect(matchLogMessage("build", "build started again")).toBeNull();
    expect(matchLogMessage("build", "the build finished")).toBeNull();
  });

  it("wants the start at the start and the end at the end", () => {
    expect(matchLogMessage("build", "the build sandbox check passed")).toBeNull();
    expect(matchLogMessage("build", `${BUILD_NOW_NAME}: build finished early`)).toBeNull();
    expect(matchLogMessage("deliver", `${BUILD_NOW_NAME}: deliver starting soon`)).toBeNull();
  });

  it("keeps the two logs apart", () => {
    expect(matchLogMessage("deliver", "build finished")).toBeNull();
    expect(matchLogMessage("build", "verified a built app")).toBeNull();
    expect(matchLogMessage("deliver", `${BUILD_NOW_NAME}: build finished`)).toBeNull();
    expect(matchLogMessage("build", `${BUILD_NOW_NAME}: deliver finished`)).toBeNull();
  });

  it("gives null for a line it does not know, so new log lines break nothing", () => {
    // Lines Overnight really writes today and the dashboard leaves alone (src/log-messages.ts says why).
    // Each is looked up in the file that logs it, so this list cannot go stale without saying so.
    const leftAlone = [
      ["build", "build try counted", "packages/builder/src/night.ts"],
      ["build", "build night stopped early: the month's ceiling on build credits is reached", "packages/builder/src/night.ts"],
      ["build", "build-now refused: the month's ceiling on build credits is reached", "packages/builder/src/night.ts"],
      ["build", "told to stop: ending the build in progress and starting nothing new", "packages/builder/src/night.ts"],
      ["build", "the Mac slept during a kiro crew build; that time is not counted as the agent's", "packages/builder/src/kiro-crew.ts"],
      ["build", "the Mac slept during a kiro cli build; that time is not counted as the agent's", "packages/builder/src/kiro-cli.ts"],
      ["deliver", "stopped before a built app was published; the next run picks it up", "packages/deliver/src/deliver.ts"],
    ] as const;
    for (const [log, text, source] of leftAlone) {
      expect(readSource(source), text).toContain(`"${text}"`);
      expect(matchLogMessage(log, text), text).toBeNull();
    }
    expect(matchLogMessage("build", "")).toBeNull();
    expect(matchLogMessage("deliver", "toString")).toBeNull();
  });

  it("knows the line a command writes when the Mac slept through part of its run, whichever command wrote it", () => {
    // The sentence as the cli makes it today (sleep-watch.ts): a start every command shares, then what follows for that kind of work.
    expect(LOG_MESSAGES.buildSlept.text).toBe(SLEPT_LINE);
    expect(LOG_MESSAGES.deliverSlept.text).toBe(SLEPT_LINE);
    for (const work of ["build", "deliver", "byHand"] as const) expect(sleptLine(work).startsWith(`${SLEPT_LINE}. `), work).toBe(true);
    // The nightly build and the morning's run each write it into their own log; a run by hand into the log of the step it was on.
    expect(matchLogMessage("build", sleptLine("build"))).toBe("buildSlept");
    expect(matchLogMessage("build", sleptLine("byHand"))).toBe("buildSlept");
    expect(matchLogMessage("deliver", sleptLine("deliver"))).toBe("deliverSlept");
    expect(matchLogMessage("deliver", sleptLine("byHand"))).toBe("deliverSlept");
    // And it is through that function that the three commands log it.
    expect(readSource("packages/cli/src/commands/build.ts")).toContain('logger.warn(sleptLine("build")');
    expect(readSource("packages/cli/src/commands/deliver.ts")).toContain('logger.warn(sleptLine("deliver")');
    expect(readSource("packages/cli/src/commands/build-now.ts")).toContain('stepLogger.warn(sleptLine("byHand")');
    // The sentence from before the review round promised every stopped build a second try. Nothing writes it any more.
    expect(sleptLine("build")).not.toContain("and will be tried again");
  });

  it("tells the three lines about where a finished build was left apart", () => {
    expect(matchLogMessage("build", "finished build moved out of the builders' reach")).toBe("sealed");
    // The second goes on after its known start. However that part is worded, it is the same line.
    const partly = "a finished build was moved out of the builders' reach, but some of its files could not be made anew";
    expect(LOG_MESSAGES.sealedPartly).toMatchObject({ text: partly, match: "starts" });
    // Its `files` is the count of files that were NOT made anew: the number the page says a build job could still change.
    expect(readSource(LOG_MESSAGES.sealedPartly.source)).toMatch(/"a finished build was moved out of the builders' reach, but some of its files could not be made anew[^"]*", \{[^}]*\bfiles: sealed\.notMadeAnew\b/);
    expect(matchLogMessage("build", `${partly}; any later job could still change those, through a hard link the build left; the morning still tests the app before publishing it`)).toBe("sealedPartly");
    expect(matchLogMessage("build", `${partly}; its own build could still change those`)).toBe("sealedPartly");
    expect(matchLogMessage("build", `a note: ${partly}`)).toBeNull();
    expect(matchLogMessage("build", "a finished build could not be moved out of the builders' reach; the morning uses it where it is")).toBe("notSealed");
    // Not a line of the morning's log, and not the line about an older build that could not be moved aside.
    expect(matchLogMessage("deliver", "finished build moved out of the builders' reach")).toBeNull();
    expect(matchLogMessage("build", "could not move an older finished build aside, so the build was not started")).toBeNull();
  });
});

describe("LOG_FIELDS", () => {
  it("lists each field once", () => {
    expect(new Set(LOG_FIELDS).size).toBe(LOG_FIELDS.length);
  });

  it("holds every field the dashboard reads", () => {
    for (const fields of Object.values(FIELDS_LOGGED_WITH)) {
      for (const field of fields ?? []) expect(LOG_FIELDS).toContain(field);
    }
  });

  it("leaves out the fields that hold a path, a reason or anything else free-form", () => {
    // "overnight build starting" logs the data folder's path (dataDir), which holds the account's name.
    for (const never of ["dataDir", "reason", "primary", "fallback", "sandboxMode", "timeZone", "message", "name", "at", "level"]) {
      expect(LOG_FIELDS as readonly string[]).not.toContain(never);
    }
  });
});

describe("the other copied values", () => {
  it("has the cli's rehearsal key, lead time and command names", () => {
    expect(CLI_REHEARSAL_CONVERSATION_KEY).toBe("rehearsal");
    expect(REHEARSAL_CONVERSATION_KEY).toBe(CLI_REHEARSAL_CONVERSATION_KEY);
    expect(CLI_DELIVER_LEAD_MINUTES).toBe(30);
    expect(DELIVER_LEAD_MINUTES).toBe(CLI_DELIVER_LEAD_MINUTES);
    expect(HAND_RUN_NAMES).toEqual({ "build-now": BUILD_NOW_NAME, rehearse: REHEARSE_NAME });
  });

  it("has the names of the cli's three lock files, in the top of the data folder", () => {
    const root = path.join(path.sep, "invented", "data folder");
    expect(listenLockFile({ root })).toBe(path.join(root, LOCK_FILE_NAMES.listener));
    expect(buildLockFile({ root })).toBe(path.join(root, LOCK_FILE_NAMES.build));
    expect(deliverLockFile({ root })).toBe(path.join(root, LOCK_FILE_NAMES.deliver));
    expect(LOCK_FILE_NAMES).toEqual({ listener: "listen.lock", build: "build.lock", deliver: "deliver.lock" });
  });

  it("has the builder's two reasons for a night with nothing built", () => {
    expect(SKIPPED_PAUSED).toBe("paused");
    expect(SKIPPED_NOTHING_APPROVED).toBe("nothing approved");
    expect(SKIPPED_VALUES).toEqual({ paused: SKIPPED_PAUSED, nothingApproved: SKIPPED_NOTHING_APPROVED });
  });

  it("ends the demo's two sandbox lines the way the builder ends the real ones", () => {
    // The demo writes these lines whole (src/demo/night-files.ts); the dashboard itself only goes by how they start.
    const probe = readSource("packages/builder/src/probe.ts");
    for (const key of ["sandboxPassed", "sandboxFailed"] as const) expect(probe, key).toContain(`"${LOG_MESSAGES[key].text}${TAILS[key] ?? "(no ending)"}"`);
  });

  it("has the builder's grace time for a build that looks cut off", () => {
    // The builder does not export this one, so it is found as text.
    expect(readSource("packages/builder/src/night.ts")).toContain(`INTERRUPTED_GRACE_MS = ${INTERRUPTED_GRACE_MINUTES} * MINUTE_MS;`);
    expect(readSource("packages/builder/src/types.ts")).toContain("MINUTE_MS = 60_000;");
    expect(INTERRUPTED_GRACE_MINUTES).toBe(15);
  });
});
