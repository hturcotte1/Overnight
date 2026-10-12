// SYNTHETIC: every line and idea here is made up by test/writer-child.ts. None of it is Bee data.
//
// The one thing about the dashboard that could hurt the live system: its look at the database.
// The listener writes to that database for weeks on end. Here another process stands in for the
// listener and writes with the real Store, while this process looks again and again with the
// dashboard's own readDatabase. The writer must never fail, never wait long, and its write-ahead
// file (SQLite's journal of recent writes) must stay small.
//
// That last one is the guard. A look that left a read open, with a half-read list or a
// connection that was not closed, would stop SQLite from ever tidying the write-ahead file, and it
// would grow for as long as the dashboard ran. The second test does exactly that on purpose, to
// show that the limit the first test sets is one a held read breaks.
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnly, readDatabase } from "../src/data/db.ts";
import type { FilmingPolicy } from "../src/types.ts";

const WRITER = fileURLToPath(new URL("./writer-child.ts", import.meta.url));
const LEAST_LINES = 500;
const LEAST_LOOKS = 200;
const WAL_LIMIT_BYTES = 8 * 1024 * 1024;
const SLOWEST_WRITE_MS = 250;
const NOT_FILMING: FilmingPolicy = { on: false, showQuoteFor: new Set() };
/** The month the look sums the credit ledger over. Any month will do here: the writer adds nothing to the ledger. */
const MONTH = { start: "2026-10-01T06:00:00.000Z", end: "2026-11-01T06:00:00.000Z" };

interface WriterResult { lines: number; ideas: number; moves: number; errors: number; worstMs: number; walBytes: number }

let scratch: string;
let file: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard beside-writer "));
  file = path.join(scratch, "overnight.db");
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** With BESIDE_WRITER_NUMBERS=1 the measured numbers are printed, for the record of a run by hand. */
const note = (what: string, numbers: object): void => {
  if (process.env.BESIDE_WRITER_NUMBERS) console.log(`${what}: ${JSON.stringify(numbers)}`);
};

/** Start the writer. Resolves once it has opened the database and is about to write. */
function startWriter(): Promise<{ written: () => number; finish: () => Promise<WriterResult> }> {
  return new Promise((resolve, reject) => {
    const child = fork(WRITER, [file, String(LEAST_LINES)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child);
    let written = 0;
    let result: WriterResult | null = null;
    let ready = false;
    const ended = new Promise<void>((done) => child.once("exit", () => done()));
    child.on("message", (message: unknown) => {
      if (message === "ready") {
        ready = true;
        resolve({
          written: () => written,
          finish: async () => {
            child.send("stop");
            await ended;
            if (result === null) throw new Error("the writer ended without reporting its numbers");
            return result;
          },
        });
      } else if (typeof message === "object" && message !== null) {
        const numbers = message as Partial<WriterResult>;
        if (typeof numbers.lines === "number") written = numbers.lines;
        if (typeof numbers.walBytes === "number") result = numbers as WriterResult;
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!ready) reject(new Error(`the writer ended (code ${String(code)}) before it was ready`));
    });
  });
}

function walBytes(): number {
  try {
    return statSync(`${file}-wal`).size;
  } catch {
    return 0;
  }
}

describe("looking at the database beside a writer", () => {
  it("never fails, never slows the writer, never goes backwards, and leaves the write-ahead file small", async () => {
    const dayStart = new Date(Date.now() - 60_000).toISOString();
    const writer = await startWriter();

    let looks = 0;
    const problems: string[] = [];
    let wentBackwards = 0;
    let sawMore = 0;
    let largestWal = 0;
    let last = { lines: 0, ideas: 0, events: 0, asks: 0 };
    const until = Date.now() + 60_000;
    while ((looks < LEAST_LOOKS || writer.written() < LEAST_LINES) && Date.now() < until) {
      const read = readDatabase(file, { dayStart, month: MONTH, filming: NOT_FILMING, pausedByDefault: true });
      looks += 1;
      if (!read.ok) problems.push(read.problem);
      else {
        const seen = { lines: read.data.linesHeard, ideas: read.data.ideas.length, events: [...read.data.events.values()].reduce((sum, events) => sum + events.length, 0), asks: read.data.asks };
        if (seen.lines < last.lines || seen.ideas < last.ideas || seen.events < last.events || seen.asks < last.asks) wentBackwards += 1;
        if (seen.lines > last.lines) sawMore += 1;
        if (read.data.unreadableRows > 0) problems.push("unreadable rows");
        last = seen;
      }
      largestWal = Math.max(largestWal, walBytes());
      // Let the writer's messages in, and give it room: the real dashboard looks once a second at most.
      await sleep(2);
    }
    const result = await writer.finish();
    note("beside short looks", { ...result, looks, problems: problems.length, wentBackwards, sawMore, largestWal });

    // The writer: every write worked, none waited long, and it did the work it was meant to.
    expect(result.errors).toBe(0);
    expect(result.lines).toBeGreaterThanOrEqual(LEAST_LINES);
    expect(result.ideas).toBeGreaterThan(10);
    expect(result.moves).toBeGreaterThan(50);
    expect(result.worstMs).toBeLessThan(SLOWEST_WRITE_MS);

    // The reader: every look worked, new lines showed up as they were written, nothing ever went back.
    expect(looks).toBeGreaterThanOrEqual(LEAST_LOOKS);
    expect(problems).toEqual([]);
    expect(wentBackwards).toBe(0);
    expect(sawMore).toBeGreaterThan(20);

    // The guard: the write-ahead file never grew past what SQLite keeps when nothing holds it back.
    expect(result.walBytes).toBeLessThan(WAL_LIMIT_BYTES);
    expect(largestWal).toBeLessThan(WAL_LIMIT_BYTES);

    // Nothing of ours is still reading: SQLite can tidy the write-ahead file away completely.
    const checker = new Database(file, { timeout: 1000 });
    try {
      expect((checker.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>)[0]?.busy).toBe(0);
    } finally {
      checker.close();
    }

    // And a last look, with the writer gone, sees everything it wrote.
    const after = readDatabase(file, { dayStart, month: MONTH, filming: NOT_FILMING, pausedByDefault: true });
    expect(after.ok && after.data.linesHeard).toBe(result.lines);
    expect(after.ok && after.data.ideas.length).toBe(Math.min(200, result.ideas));
  }, 90_000);

  it("would be caught: one read left open beside the same writer takes the write-ahead file past the limit", async () => {
    const writer = await startWriter();
    // Wait for the tables, then do what a careless look would: start reading a list and not finish.
    while (writer.written() < 25) await sleep(5);
    const held = openReadOnly(file);
    let result: WriterResult;
    try {
      const rows = held.prepare("SELECT id FROM idea_events").iterate();
      rows.next();
      while (writer.written() < LEAST_LINES) await sleep(5);
      result = await writer.finish();
      rows.return?.();
    } finally {
      held.close();
    }
    note("beside a read left open", result);
    expect(result.errors).toBe(0);
    expect(result.walBytes).toBeGreaterThan(WAL_LIMIT_BYTES);
  }, 90_000);
});
