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
} from "@overnight/cli";
import { describe, expect, it } from "vitest";
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
    expect(matchLogMessage("build", "the Mac went to sleep during the run; what was in progress was stopped and will be tried again")).toBeNull();
    expect(matchLogMessage("build", "")).toBeNull();
    expect(matchLogMessage("deliver", "toString")).toBeNull();
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

  it("has the builder's grace time for a build that looks cut off", () => {
    // The builder does not export this one, so it is found as text.
    expect(readSource("packages/builder/src/night.ts")).toContain(`INTERRUPTED_GRACE_MS = ${INTERRUPTED_GRACE_MINUTES} * MINUTE_MS;`);
    expect(readSource("packages/builder/src/types.ts")).toContain("MINUTE_MS = 60_000;");
    expect(INTERRUPTED_GRACE_MINUTES).toBe(15);
  });
});
