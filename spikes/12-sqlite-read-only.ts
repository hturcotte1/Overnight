// All data this spike writes is synthetic: invented lines in a new temporary folder. None of it is Bee data.
//
// Spike 12: can a second program read Overnight's database while the listener writes to it,
// without ever getting in the listener's way? And can it tell whether the listener, a build or a
// deliver is running without touching their lock files?
//
// Why it matters: the dashboard (Milestone 3) is a page that only reads. The listener runs for
// weeks and must never wait for it, never lose a line to it, and never find its files changed.
//
// Usage: node spikes/12-sqlite-read-only.ts
// It needs no Bee, no Kiro and no data folder, and it costs nothing. Unlike the other spikes it
// does NOT use <data folder>/spikes/: it makes a new folder under the system's temporary folder,
// works only there, and removes it at the end. It never opens ~/.overnight.
//
// What it tries, each with the real Store from packages/core as the writer and the cli's own
// takeLock as the lock holder:
//   1. a read-only open of a file that is not there, of a folder that is not there, of an empty file
//   2. a read-only open when no other program has the database open: which files appear, and
//      whether the database file itself changes; a write through the read-only connection
//   3. a writer in another process adding a line every 5 ms, alone and then beside a reader that
//      opens, reads in one short transaction and closes, over and over
//   4. a reader while a write is held open; a reader after the writer was killed
//   5. the one thing that hurts: a read that is left open while the writer adds 3,000 lines
//   6. looking at a lock file read-only: missing, held, given back, and after its holder was killed
//
// Result on 2026-10-11 (better-sqlite3 13.0.3, SQLite 3.53.4, Node 24.21.0): reading never slowed
// the writer or failed, and a write through the read-only connection is refused. A read left
// open let the write-ahead file grow to 86 to 90 MB over 3,000 lines (about 4 MB with short looks).
// With no other program on the database, SQLite itself leaves two small side files. A read-only
// look at a lock file tells held from free and changes nothing. The table is in docs/spikes.md,
// "Spike 12".
//
// It prints counts, sizes, times and SQLite's own error codes. The lines it writes are
// "synthetic line <n>", and it never prints one.
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Store } from "@overnight/core";
import { buildLockFile, takeLock } from "../packages/cli/src/single-instance.ts";

const SELF = fileURLToPath(import.meta.url);
const role = process.argv[2] ?? "main";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown error";
};
const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
/** In a child: tell the parent something, and wait until the message has really left. */
const tell = (message: unknown): Promise<void> => new Promise((resolve) => (process.send ? process.send(message, () => resolve()) : resolve()));

/** Add one invented line through the real Store. Returns how long the write took, in milliseconds. */
function addLine(store: Store, conversationKey: string, n: number): number {
  const at = new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + n * 1000).toISOString();
  const started = performance.now();
  const result = store.insertUtterance({ beeUtteranceId: process.pid * 1_000_000 + n, conversationKey, text: `synthetic line ${n} `.repeat(6), spokenAt: at, receivedAt: at, source: "stream" });
  if (!result.inserted) throw new Error("the line was not added");
  return performance.now() - started;
}

// ---------- The other processes this spike starts (the same file, with a role) ----------

if (role === "writer") {
  // The listener's stand-in: the real Store, one line about every 5 ms for <ms> milliseconds.
  const [file, ms] = [process.argv[3] ?? "", Number(process.argv[4] ?? 0)];
  const store = new Store(file);
  const conversation = store.resolveConversation({ uuid: `synthetic-writer-${process.pid}` }, new Date().toISOString());
  let lines = 0;
  let errors = 0;
  let worst = 0;
  let total = 0;
  await tell("ready");
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const took = addLine(store, conversation.key, lines);
      lines += 1;
      worst = Math.max(worst, took);
      total += took;
    } catch {
      errors += 1;
    }
    await sleep(5);
  }
  store.close();
  await tell({ lines, errors, worstMs: round(worst), meanMs: round(total / Math.max(1, lines), 3) });
  process.exit(0);
}

if (role === "long-write") {
  // Holds one write open for <ms> milliseconds, as a slow migration would.
  const [file, ms] = [process.argv[3] ?? "", Number(process.argv[4] ?? 0)];
  const db = new Database(file, { timeout: 5000 });
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('spike_long_write', '1', '2026-10-11T12:00:00.000Z')").run();
  await tell("ready");
  await sleep(ms);
  db.exec("COMMIT");
  db.close();
  process.exit(0);
}

if (role === "holder") {
  // Holds a lock exactly as `overnight build` does, for <ms> milliseconds (0: until killed).
  const [file, ms] = [process.argv[3] ?? "", Number(process.argv[4] ?? 0)];
  const release = takeLock(file);
  if (release === null) {
    await tell("refused");
    process.exit(1);
  }
  await tell("ready");
  await sleep(ms > 0 ? ms : 600_000);
  release();
  process.exit(0);
}

interface Started {
  child: ChildProcess;
  /** What the child said first: "ready", or "refused" from a holder that did not get the lock. */
  said: string;
  /** The child's last message (its numbers), once it has ended. */
  done: Promise<unknown>;
}

function start(args: string[]): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, args, { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let last: unknown = null;
    let first = true;
    const done = new Promise<unknown>((ended) => child.once("exit", () => ended(last)));
    child.on("message", (message) => {
      if (first && typeof message === "string") {
        first = false;
        resolve({ child, said: message, done });
      } else last = message;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (first) reject(new Error(`the spike's ${args[0] ?? "child"} process ended (code ${String(code)}) before it said anything`));
    });
  });
}

// ---------- What the dashboard would do ----------

/** A read-only connection, opened the way the dashboard will. */
function openReadOnly(file: string, timeoutMs = 250): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: timeoutMs });
  db.pragma("query_only = ON");
  return db;
}

/** One look: open, a few SELECTs inside one short transaction, close. Never the words of a line. */
function look(file: string): { lines: number; ideas: number; newestChars: number } {
  const db = openReadOnly(file);
  try {
    return db.transaction(() => ({
      lines: (db.prepare("SELECT COUNT(*) AS n FROM utterances").get() as { n: number }).n,
      ideas: db.prepare("SELECT * FROM ideas ORDER BY created_at DESC, id DESC LIMIT 200").all().length,
      newestChars: (db.prepare("SELECT length(text) AS chars FROM utterances ORDER BY id DESC LIMIT 1").get() as { chars: number } | undefined)?.chars ?? 0,
    }))();
  } finally {
    db.close();
  }
}

/** Is the lock in this file held? Looks read-only: no write lock is ever asked for. */
function peek(file: string): string {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
    return "free";
  } catch (error) {
    return codeOf(error);
  } finally {
    db?.close();
  }
}

// ---------- The spike ----------

const dir = mkdtempSync(path.join(tmpdir(), "overnight-spike-12-"));
const file = path.join(dir, "overnight.db");
const listing = (folder: string = dir): string =>
  readdirSync(folder)
    .sort()
    .map((name) => `${name} (${statSync(path.join(folder, name)).size} bytes)`)
    .join(", ") || "(nothing)";
const fingerprint = (target: string): string => {
  const stat = statSync(target);
  return `${createHash("sha256").update(readFileSync(target)).digest("hex").slice(0, 12)} ${stat.size} ${stat.mtimeMs}`;
};
const sizeOf = (target: string): number => (existsSync(target) ? statSync(target).size : 0);
const megabytes = (bytes: number): string => `${round(bytes / 1_000_000, 1)} MB`;
const say = (label: string, value: unknown): void => console.log(`  ${label.padEnd(66)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
const attempt = (fn: () => unknown): string => {
  try {
    return `ok ${JSON.stringify(fn())}`;
  } catch (error) {
    return `refused: ${codeOf(error)}`;
  }
};

try {
  const versions = new Database(":memory:");
  console.log(`better-sqlite3 ${(JSON.parse(readFileSync(new URL("../node_modules/better-sqlite3/package.json", import.meta.url), "utf8")) as { version: string }).version}, SQLite ${(versions.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v}, Node ${process.version}`);
  versions.close();

  console.log("\n1. Nothing there yet");
  say("read-only open of a file that is not there", attempt(() => look(file)));
  say("the folder afterwards", listing());
  say("read-only open inside a folder that is not there", attempt(() => look(path.join(dir, "no-such-folder", "overnight.db"))));
  const empty = path.join(dir, "empty.db");
  writeFileSync(empty, "");
  {
    const db = openReadOnly(empty);
    say("an empty file: user_version", db.pragma("user_version", { simple: true }));
    try {
      db.prepare("SELECT COUNT(*) FROM ideas").get();
      say("an empty file: SELECT from ideas", "ok?!");
    } catch (error) {
      say("an empty file: SELECT from ideas", `refused: ${codeOf(error)}, "${String((error as Error).message).slice(0, 13)}"`);
    }
    db.close();
  }
  rmSync(empty);

  console.log("\n2. Nobody else has the database open");
  let store = new Store(file);
  const conversation = store.resolveConversation({ uuid: "synthetic-conversation-1" }, "2026-10-11T12:00:00.000Z");
  for (let n = 0; n < 2000; n += 1) addLine(store, conversation.key, n);
  const idea = store.createIdea({ title: "Chore Wheel", pitch: "Spin a wheel to share out chores.", quote: "an invented line for a spike", confidence: 0.9, conversationKey: conversation.key, detectorRunId: null }, "2026-10-11T12:05:00.000Z");
  store.close();
  say("files after the Store closed cleanly", listing());
  const before = fingerprint(file);
  {
    const db = openReadOnly(file);
    say("journal mode and user_version seen read-only", `${String(db.pragma("journal_mode", { simple: true }))}, ${String(db.pragma("user_version", { simple: true }))}`);
    say("lines and ideas read", `${(db.prepare("SELECT COUNT(*) AS n FROM utterances").get() as { n: number }).n}, ${(db.prepare("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n}`);
    say("files while the reader is open", listing());
    say("a write through the read-only connection", attempt(() => db.prepare("UPDATE ideas SET title = 'changed'").run()));
    db.pragma("query_only = OFF");
    say("the same write with query_only switched back off", attempt(() => db.prepare("UPDATE ideas SET title = 'changed'").run()));
    db.close();
  }
  say("files after the reader closed", listing());
  say("the database file itself: bytes, size and time unchanged", fingerprint(file) === before);
  say("side files are private (mode)", readdirSync(dir).filter((name) => name !== "overnight.db").map((name) => `${name} ${(statSync(path.join(dir, name)).mode & 0o777).toString(8)}`).join(", ") || "(none)");
  store = new Store(file);
  store.transitionIdea(idea.id, "asked", { askedAt: "2026-10-11T12:06:00.000Z" }, "2026-10-11T12:06:00.000Z");
  say("the Store opens again beside those files and writes", store.getIdea(idea.id)?.state ?? "missing");
  const linesBefore = look(file).lines;
  addLine(store, conversation.key, 5000);
  say("a line written is in the very next look", look(file).lines === linesBefore + 1);
  store.close();
  say("files after the Store closed again", listing());
  // SQLite's "immutable" mode would read without making side files. It needs a URI file name.
  say("the same file by a URI name with immutable=1", attempt(() => new Database(`file:${file}?immutable=1`, { readonly: true, fileMustExist: true }).close()));
  {
    // A folder the reader may not write in, with no side files yet.
    const locked = path.join(dir, "no-writing-here");
    mkdirSync(locked, { mode: 0o700 });
    const inside = path.join(locked, "overnight.db");
    new Store(inside).close();
    chmodSync(locked, 0o500);
    say("read-only open in a folder that cannot be written", attempt(() => look(inside)));
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true, force: true });
  }

  console.log("\n3. Beside a writer in another process (the real Store, a line every 5 ms for 3 s)");
  {
    const alone = await start(["writer", file, "3000"]);
    say("the writer alone", await alone.done);
    const beside = await start(["writer", file, "3000"]);
    let looks = 0;
    let errors = 0;
    let slowest = 0;
    let sawMore = 0;
    let wentBack = 0;
    let last = 0;
    const until = Date.now() + 2800;
    while (Date.now() < until) {
      const started = performance.now();
      try {
        const seen = look(file).lines;
        if (seen > last) sawMore += 1;
        if (seen < last) wentBack += 1;
        last = seen;
        looks += 1;
      } catch {
        errors += 1;
      }
      slowest = Math.max(slowest, performance.now() - started);
      await sleep(1);
    }
    say("the writer beside a reader", await beside.done);
    say("the reader: looks (open, 3 SELECTs, close)", { looks, errors, slowestMs: round(slowest), sawMoreLines: sawMore, countWentBackwards: wentBack });
    say("files after that writer closed", listing());
  }

  console.log("\n4. Awkward moments");
  {
    const writing = await start(["long-write", file, "1500"]);
    const started = performance.now();
    const result = attempt(() => look(file).lines);
    say("a look while another process holds a write open for 1.5 s", `${result} after ${round(performance.now() - started, 1)} ms`);
    await writing.done;

    const doomed = await start(["writer", file, "60000"]);
    await sleep(700);
    doomed.child.kill("SIGKILL");
    await doomed.done;
    say("files after the writer was killed mid-way", listing());
    say("a look straight after", attempt(() => look(file).lines > 0));
    const checker = openReadOnly(file);
    say("the database, checked by SQLite afterwards (integrity_check)", checker.pragma("integrity_check", { simple: true }));
    checker.close();
    new Store(file).close();
    say("files after the next Store opened and closed", listing());
  }

  console.log("\n5. The one thing that hurts: a read left open");
  {
    store = new Store(file);
    const other = store.resolveConversation({ uuid: "synthetic-conversation-2" }, "2026-10-11T13:00:00.000Z");
    const wal = `${file}-wal`;
    const checkpointer = new Database(file, { timeout: 250 });
    /** Ask SQLite to move the write-ahead file's pages into the database. busy 1: it could not finish. */
    const checkpoint = (mode: "PASSIVE" | "TRUNCATE"): unknown => (checkpointer.pragma(`wal_checkpoint(${mode})`) as unknown[])[0];

    let worst = 0;
    let slowestLook = 0;
    for (let n = 10_000; n < 13_000; n += 1) {
      worst = Math.max(worst, addLine(store, other.key, n));
      if (n % 10 === 0) {
        const started = performance.now();
        look(file);
        slowestLook = Math.max(slowestLook, performance.now() - started);
      }
    }
    say("3,000 lines with a short look every 10th: slowest write, slowest look", `${round(worst)} ms, ${round(slowestLook)} ms`);
    say("the write-ahead file after that", megabytes(sizeOf(wal)));
    say("a checkpoint then (busy, pages in the file, pages moved)", checkpoint("TRUNCATE"));

    const held = openReadOnly(file);
    held.exec("BEGIN");
    held.prepare("SELECT COUNT(*) AS n FROM utterances").get();
    worst = 0;
    for (let n = 20_000; n < 23_000; n += 1) worst = Math.max(worst, addLine(store, other.key, n));
    say("3,000 lines beside a read that is HELD open: slowest write", `${round(worst)} ms`);
    say("the write-ahead file after that", megabytes(sizeOf(wal)));
    say("a checkpoint while the read is held", checkpoint("PASSIVE"));
    say("what the held read still counts, against a new look", `${(held.prepare("SELECT COUNT(*) AS n FROM utterances").get() as { n: number }).n} against ${look(file).lines}`);
    held.exec("COMMIT");
    held.close();
    say("a checkpoint once the read was let go", checkpoint("TRUNCATE"));
    say("the write-ahead file after that", megabytes(sizeOf(wal)));

    const unfinished = openReadOnly(file);
    const rows = unfinished.prepare("SELECT id FROM utterances").iterate();
    rows.next();
    addLine(store, other.key, 30_000);
    say("a checkpoint beside an .iterate() that was not finished", checkpoint("TRUNCATE"));
    rows.return?.();
    unfinished.close();
    say("and once it was", checkpoint("TRUNCATE"));
    checkpointer.close();
    store.close();
  }

  console.log("\n6. Looking at a lock file read-only (the cli's own takeLock holds it)");
  {
    const lock = buildLockFile({ root: dir });
    const lockFiles = (): string =>
      readdirSync(dir)
        .filter((name) => name.startsWith(path.basename(lock)))
        .sort()
        .map((name) => `${name} (${statSync(path.join(dir, name)).size} bytes)`)
        .join(", ") || "(nothing)";
    say("no lock file", `${peek(lock)}; files: ${lockFiles()}`);

    let holder = await start(["holder", lock, "600"]);
    const whileHeld = `${lockFiles()} ${statSync(lock).mtimeMs}`;
    say("held by another process", `${peek(lock)}, ${peek(lock)}; files: ${lockFiles()}`);
    say("the look changed no file (names, sizes, the lock's time)", `${lockFiles()} ${statSync(lock).mtimeMs}` === whileHeld);
    await holder.done;
    say("after the holder gave it back", `${peek(lock)}; files: ${lockFiles()}`);

    holder = await start(["holder", lock, "0"]);
    holder.child.kill("SIGKILL");
    await holder.done;
    const leftBehind = `${lockFiles()} ${statSync(lock).mtimeMs}`;
    say("after a holder was killed outright: files left", lockFiles());
    say("the look then", `${peek(lock)}, ${peek(lock)}`);
    say("the look changed no file", `${lockFiles()} ${statSync(lock).mtimeMs}` === leftBehind);

    holder = await start(["holder", lock, "300"]);
    say("a real start after the killed one", holder.said === "ready" ? "got the lock" : holder.said);
    await holder.done;
    say("files after it gave the lock back", lockFiles());

    let looking = true;
    let peeks = 0;
    const loop = (async () => {
      while (looking) {
        peek(lock);
        peeks += 1;
        await sleep(0);
      }
    })();
    let got = 0;
    for (let n = 0; n < 40; n += 1) {
      const starter = await start(["holder", lock, "20"]);
      if (starter.said === "ready") got += 1;
      await starter.done;
    }
    looking = false;
    await loop;
    say("40 real starts, one after another, while being looked at non-stop", `${got} of 40 got the lock (${peeks} looks meanwhile)`);
  }

  console.log("\nDone. Everything above happened in a temporary folder that is now removed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
