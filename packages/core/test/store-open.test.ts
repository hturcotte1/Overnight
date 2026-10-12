// All text in this file is made up for the tests. None of it is Bee data.
//
// Opening the database from several programs in the same instant. macOS wakes both night jobs in
// the same second, every minute, and each of them opens the database first thing. Neither may
// fail because of the other: not on a brand-new file, and not on one that needs an upgrade.
//
// The programs here are real ones (open-child.ts, upgrade-child.ts), each with the real Store.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "../src/index.ts";

const OPEN_CHILD = fileURLToPath(new URL("./open-child.ts", import.meta.url));
const UPGRADE_CHILD = fileURLToPath(new URL("./upgrade-child.ts", import.meta.url));
const T0 = "2026-10-12T07:00:00.000Z";

/** A scratch folder of its own for one test, removed afterwards. */
async function withScratchDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "overnight-store-open-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Put a file back the way the Milestone 2 code wrote it: no ledger, version 3. */
function backToVersion3(file: string): void {
  const raw = new Database(file);
  raw.exec("DROP TABLE build_costs;");
  raw.pragma("user_version = 3");
  raw.close();
}

/** The version a file is at, and the names of its tables. */
function look(file: string): { version: unknown; tables: string[]; journal: unknown } {
  const raw = new Database(file, { readonly: true });
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return { version: raw.pragma("user_version", { simple: true }), tables, journal: raw.pragma("journal_mode", { simple: true }) };
  } finally {
    raw.close();
  }
}

/**
 * Start `count` programs, wait until every one of them is ready, and have them all open the
 * database at the same millisecond. Gives back what each one said: "ok", or "failed: ...".
 */
async function openTogether(file: string, count: number): Promise<string[]> {
  const programs = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ["--no-warnings", OPEN_CHILD, file], { stdio: ["pipe", "pipe", "inherit"] });
    // A program that has already ended cannot be told the moment. What it said will show that.
    child.stdin.on("error", () => {});
    let said = "";
    let tellReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => (tellReady = resolve));
    child.stdout.on("data", (chunk) => {
      said += String(chunk);
      if (said.includes("ready\n")) tellReady();
    });
    const ended = new Promise<string>((resolve) => child.on("close", () => resolve(said.replace("ready\n", "").trim() || "said nothing")));
    // A program that ends before it is ready has failed: do not wait for it for ever.
    child.on("close", tellReady);
    return { child, ready, ended };
  });
  await Promise.all(programs.map((program) => program.ready));
  const startAt = Date.now() + 100;
  for (const program of programs) program.child.stdin.end(`${startAt}\n`);
  return Promise.all(programs.map((program) => program.ended));
}

const ALL_TABLES = ["build_costs", "conversations", "detector_runs", "idea_events", "ideas", "kv", "utterances"];

describe("two programs opening the database at the same moment", () => {
  it("both open a brand-new file, and it is made once", { timeout: 60_000 }, async () => {
    await withScratchDir(async (dir) => {
      // The instant has to be hit for this to mean anything, so it is tried a few times over.
      for (let round = 1; round <= 3; round += 1) {
        const file = path.join(dir, `new-${round}.db`);
        expect(await openTogether(file, 3), `round ${round}`).toEqual(["ok", "ok", "ok"]);
        expect(look(file), `round ${round}`).toEqual({ version: 4, tables: ALL_TABLES, journal: "wal" });
        // Every program's write is there.
        const raw = new Database(file, { readonly: true });
        expect(raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'opened.%' AND value = 'yes'").get(), `round ${round}`).toEqual({ n: 3 });
        raw.close();
      }
    });
  });

  it("both open a file that needs the upgrade, and it is upgraded once", { timeout: 60_000 }, async () => {
    await withScratchDir(async (dir) => {
      for (let round = 1; round <= 3; round += 1) {
        const file = path.join(dir, `older-${round}.db`);
        const first = new Store(file);
        first.setValue("cursor", "v1-7", T0);
        first.close();
        backToVersion3(file);

        expect(await openTogether(file, 3), `round ${round}`).toEqual(["ok", "ok", "ok"]);
        expect(look(file), `round ${round}`).toEqual({ version: 4, tables: ALL_TABLES, journal: "wal" });
        const after = new Store(file);
        expect(after.getValue("cursor")).toBe("v1-7");
        expect(after.buildCreditsBetween(T0, "2026-10-13T07:00:00.000Z")).toEqual({ credits: 0, estimated: 0, tries: 0 });
        after.close();
      }
    });
  });

  it("finds the upgrade done when another program did it while this one was waiting for the file", { timeout: 30_000 }, async () => {
    await withScratchDir(async (dir) => {
      const file = path.join(dir, "older.db");
      const first = new Store(file);
      first.setValue("cursor", "v1-7", T0);
      first.close();
      // What the upgrade to version 4 is, word for word, read from the file before it is taken out.
      const made = new Database(file, { readonly: true });
      const ledger = (made.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'build_costs' AND sql IS NOT NULL ORDER BY type DESC").all() as Array<{ sql: string }>).map((row) => row.sql);
      made.close();
      expect(ledger).toHaveLength(2);
      backToVersion3(file);

      // The other program has the file locked for writing, and upgrades it 400 ms from now.
      const other = spawn(process.execPath, ["--no-warnings", UPGRADE_CHILD, file, "400", `${ledger.join("; ")}; PRAGMA user_version = 4;`], { stdio: ["ignore", "pipe", "inherit"] });
      const otherEnded = new Promise<number | null>((resolve) => other.on("close", resolve));
      await new Promise<void>((resolve) => other.stdout.once("data", () => resolve()));

      // This one opens the file meanwhile. It sees version 3, waits its turn, and must then
      // notice that there is nothing left to do, not make the ledger a second time.
      const started = Date.now();
      const store = new Store(file);
      expect(Date.now() - started).toBeGreaterThan(200);
      expect(store.getValue("cursor")).toBe("v1-7");
      store.setValue("cursor", "v1-8", T0);
      store.close();

      expect(await otherEnded).toBe(0);
      expect(look(file)).toEqual({ version: 4, tables: ALL_TABLES, journal: "wal" });
    });
  });
});

describe("a database that stays locked", () => {
  it("is given up on with SQLite's own message, not waited for without end", { timeout: 30_000 }, async () => {
    await withScratchDir(async (dir) => {
      const file = path.join(dir, "older.db");
      new Store(file).close();
      backToVersion3(file);
      // Locked for writing for far longer than anything waits.
      const other = spawn(process.execPath, ["--no-warnings", UPGRADE_CHILD, file, "20000", "SELECT 1;"], { stdio: ["ignore", "pipe", "inherit"] });
      const otherEnded = new Promise<void>((resolve) => other.on("close", () => resolve()));
      try {
        await new Promise<void>((resolve) => other.stdout.once("data", () => resolve()));
        const started = Date.now();
        expect(() => new Store(file)).toThrow("database is locked");
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThan(4000);
        expect(waited).toBeLessThan(10_000);
      } finally {
        other.kill("SIGKILL");
        await otherEnded;
      }
      // Nothing was half done: once the lock is gone the file opens, and is upgraded then.
      new Store(file).close();
      // And the open that failed left nothing open behind it. That close was the last one, so
      // SQLite tidied its write-ahead file away.
      expect(existsSync(`${file}-wal`)).toBe(false);
      expect(look(file).version).toBe(4);
    });
  });

  it("is not what a file that is no database looks like: that one is refused at once", async () => {
    await withScratchDir(async (dir) => {
      const file = path.join(dir, "notes.db");
      writeFileSync(file, "Invented text, not a database. ".repeat(200));
      const started = Date.now();
      expect(() => new Store(file)).toThrow("file is not a database");
      // Only "locked" is asked again. Any other answer is final.
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
