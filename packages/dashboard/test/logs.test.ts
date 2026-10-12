// SYNTHETIC: every id, path and reason in these log lines is made up. None of it is Bee data.
//
// Reading the job logs. The lines are written by core's own logger, the way the night jobs
// write them, into a scratch folder.
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "@overnight/core";
import type { LogFields } from "@overnight/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLogText, readLogTail } from "../src/data/logs.ts";
import { LOG_FIELDS, LOG_MESSAGES } from "../src/log-messages.ts";

const ID = "idea_20261009_aa11bb22";
const AT = "2026-10-11T07:00:05.000Z";

let scratch: string;
let file: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard logs "));
  file = path.join(scratch, "build.log");
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Log one line the way a night job does. */
function log(message: string, fields: LogFields = {}, more: { name?: string; level?: "info" | "warn" | "error"; at?: string } = {}): void {
  const logger = createLogger({ name: more.name ?? "build", file, write: () => {}, now: () => new Date(more.at ?? AT) });
  logger[more.level ?? "info"](message, fields);
}

describe("a line of a log", () => {
  it("is read as its time, level, name, message and the fields the dashboard uses", () => {
    log(LOG_MESSAGES.ideaBuilt.text, { ideaId: ID, backend: "kiro-crew", seconds: 160, credits: 4.59 });
    expect(readLogTail(file)).toEqual([{ at: AT, level: "info", name: "build", message: "build finished", fields: { ideaId: ID, backend: "kiro-crew", seconds: 160, credits: 4.59 } }]);
  });

  it("keeps the level and the name it was logged under", () => {
    log("build sandbox check passed: and so on", { ms: 7100 }, { name: "preflight", level: "warn" });
    expect(readLogTail(file)).toMatchObject([{ level: "warn", name: "preflight", fields: { ms: 7100 } }]);
  });

  it("drops every field that is not on the list, the data folder's path first of all", () => {
    log(LOG_MESSAGES.buildRunStart.text, { primary: "kiro-crew", fallback: "kiro-cli", sandboxMode: "overnight", dataDir: "/Users/sam/.overnight" });
    log(LOG_MESSAGES.ideaFailed.text, { ideaId: ID, backend: "kiro-cli", seconds: 12, reason: "REASON-NOT-KEPT" });
    log("a build backend threw", { ideaId: ID, error: "ERROR-NOT-KEPT at /Users/sam/x" });
    const lines = readLogTail(file);
    expect(lines.map((line) => line.fields)).toEqual([{}, { ideaId: ID, backend: "kiro-cli", seconds: 12 }, { ideaId: ID }]);
    expect(JSON.stringify(lines)).not.toMatch(/\/Users\/sam|NOT-KEPT|kiro-crew/);
  });

  it("keeps every field on the list, whatever simple kind it is", () => {
    const fields = Object.fromEntries(LOG_FIELDS.map((name, index) => [name, index % 3 === 0 ? `v${index}` : index % 3 === 1 ? index : index % 2 === 0]));
    log("anything", { ...fields, minutesLeft: null });
    expect(readLogTail(file)[0]?.fields).toEqual({ ...fields, minutesLeft: null });
  });

  it("drops a field of the wrong kind and keeps the line", () => {
    const line = { at: AT, level: "info", name: "build", message: "build finished", ideaId: { nested: "object" }, seconds: [1, 2], credits: 4.59, backend: "b".repeat(201), step: "s".repeat(200) };
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    expect(readLogTail(file)).toEqual([{ at: AT, level: "info", name: "build", message: "build finished", fields: { credits: 4.59, step: "s".repeat(200) } }]);
  });

  it("has fields that cannot be changed afterwards", () => {
    log("anything", { ideaId: ID });
    const line = readLogTail(file)[0];
    expect(Object.isFrozen(line?.fields)).toBe(true);
  });
});

describe("lines that cannot be read", () => {
  it("are skipped: junk, a list, a number, a line with a part missing or of the wrong kind", () => {
    const good = JSON.stringify({ at: AT, level: "info", name: "build", message: "build started", ideaId: ID });
    const bad = [
      "not json at all",
      '{"at": "2026-10-11T07:00:05.000Z", "level": "info", "name": "build", "message": "cut off in the midd',
      "[1, 2, 3]",
      "42",
      "null",
      JSON.stringify({ level: "info", name: "build", message: "no time" }),
      JSON.stringify({ at: "yesterday-ish", level: "info", name: "build", message: "a time that is not one" }),
      JSON.stringify({ at: AT, level: "info", name: "build" }),
      JSON.stringify({ at: AT, level: "info", name: 7, message: "a name that is a number" }),
      JSON.stringify({ at: AT, level: ["info"], name: "build", message: "a level that is a list" }),
      JSON.stringify({ at: AT, level: "info", name: "build", message: { text: "a message that is an object" } }),
      "",
    ];
    const text = [good, ...bad, good].join("\n");
    expect(parseLogText(text)).toHaveLength(2);
    expect(parseLogText(bad.join("\n"))).toEqual([]);
    expect(parseLogText("")).toEqual([]);
  });

  it("are skipped when they are far too long to be ours", () => {
    const line = (padding: number): string => JSON.stringify({ at: AT, level: "info", name: "build", message: "build started", filler: "x".repeat(padding) });
    const lines = parseLogText([line(10), line(1024 * 1024), line(64 * 1024), line(10)].join("\n"));
    expect(lines).toHaveLength(2);
    // Just under the limit is still read.
    const fits = line(64 * 1024 - 200);
    expect(fits.length).toBeLessThan(64 * 1024);
    expect(parseLogText(fits)).toHaveLength(1);
  });
});

describe("the end of a log file", () => {
  it("is no lines for a log that is not there", () => {
    expect(readLogTail(path.join(scratch, "nothing.log"))).toEqual([]);
  });

  it("is no lines for a link put where the log should be", () => {
    log("build started", { ideaId: ID });
    symlinkSync(file, path.join(scratch, "deliver.log"));
    expect(readLogTail(path.join(scratch, "deliver.log"))).toEqual([]);
  });

  it("gives the lines in the order they were written", () => {
    for (let n = 0; n < 5; n += 1) log("build started", { seconds: n });
    expect(readLogTail(file).map((line) => line.fields.seconds)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads only the end of a long log, and drops the line it started in the middle of", () => {
    for (let n = 0; n < 200; n += 1) log("build started", { seconds: n });
    const all = readLogTail(file);
    expect(all).toHaveLength(200);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ at: AT, level: "info", name: "build", message: "build started", seconds: 199 })}\n`);
    // Room for ten whole lines and half of an eleventh.
    const tail = readLogTail(file, lineBytes * 10 + Math.floor(lineBytes / 2));
    expect(tail.map((line) => line.fields.seconds)).toEqual([190, 191, 192, 193, 194, 195, 196, 197, 198, 199]);
  });

  it("reads the last megabyte unless told otherwise", () => {
    const filler = "x".repeat(1000);
    const line = (n: number): string => `${JSON.stringify({ at: AT, level: "info", name: "build", message: "build started", seconds: n, filler })}\n`;
    writeFileSync(file, "");
    for (let n = 0; n < 1500; n += 1) appendFileSync(file, line(n));
    // How many whole lines fit into the last 1,048,576 bytes, counted from the end.
    let room = 1024 * 1024;
    let whole = 0;
    for (let n = 1499; n >= 0 && Buffer.byteLength(line(n)) <= room; n -= 1) {
      room -= Buffer.byteLength(line(n));
      whole += 1;
    }
    expect(room).toBeGreaterThan(0);
    const lines = readLogTail(file);
    expect(lines).toHaveLength(whole);
    expect(lines[0]?.fields.seconds).toBe(1500 - whole);
    expect(lines.at(-1)?.fields.seconds).toBe(1499);
  });

  it("is not thrown by a last line that is still being written", () => {
    log("build started", { ideaId: ID });
    appendFileSync(file, '{"at":"2026-10-11T07:00:06.000Z","level":"info","name":"build","mess');
    expect(readLogTail(file)).toHaveLength(1);
  });
});
