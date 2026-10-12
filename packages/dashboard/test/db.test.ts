// SYNTHETIC: every title, pitch, quote and line in this file is made up. None of it is Bee data.
//
// The dashboard's look at the database, against databases made by the real Store in scratch
// folders. The dashboard has its own SQL and its own row shapes, so the first tests here compare
// what it reads with what the Store reads, field by field: if the Store's tables change, this
// file fails before a page shows something wrong.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { deliverLockFile, listenLockFile, takeLock } from "@overnight/cli";
import { BUILD_STOPPED_REASON, buildBudget, closedRun, createLogger, currentSlot, dataPaths, IDEA_STATES, noteChecked, noticedRun, parseConfig, readCheckedAt, readLastNightRun, readNightRun, startedRun, Store, waitingRun, writeNightRun } from "@overnight/core";
import type { Config, DataPaths, Idea, IdeaState } from "@overnight/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HIDDEN_TITLE, openReadOnly, readDatabase } from "../src/data/db.ts";
import { collectSnapshot, createSnapshotSource } from "../src/data/snapshot.ts";
import { LOG_MESSAGES } from "../src/log-messages.ts";
import { overnightDayStart } from "../src/story.ts";
import type { DashIdea, FilmingPolicy } from "../src/types.ts";

const NOT_FILMING: FilmingPolicy = { on: false, showQuoteFor: new Set() };
const FILMING: FilmingPolicy = { on: true, showQuoteFor: new Set() };
/** 7:00 AM in America/Boise on Oct 10: where the invented day starts. */
const DAY_START = "2026-10-10T13:00:00.000Z";
/** October 2026 in America/Boise: the calendar month the credit ceiling counts. */
const MONTH = { start: "2026-10-01T06:00:00.000Z", end: "2026-11-01T06:00:00.000Z" };
const Q = { dayStart: DAY_START, month: MONTH, filming: NOT_FILMING, pausedByDefault: true };

let scratch: string;
let file: string;
const stores: Store[] = [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard db "));
  file = path.join(scratch, "overnight.db");
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(scratch, { recursive: true, force: true });
});

function openStore(target: string = file): Store {
  const store = new Store(target);
  stores.push(store);
  return store;
}

/** A time some minutes after the invented day's start. */
function at(minutes: number): string {
  return new Date(Date.parse(DAY_START) + minutes * 60_000).toISOString();
}

/** The states an idea passes through on its way to `state`, after "heard". */
const WAY_TO: Record<IdeaState, IdeaState[]> = {
  heard: [],
  asked: ["asked"],
  approved: ["asked", "approved"],
  rejected: ["asked", "rejected"],
  expired: ["asked", "expired"],
  building: ["asked", "approved", "building"],
  built: ["asked", "approved", "building", "built"],
  build_failed: ["asked", "approved", "building", "build_failed"],
  published: ["asked", "approved", "building", "built", "published"],
  publish_failed: ["asked", "approved", "building", "built", "publish_failed"],
  delivered: ["asked", "approved", "building", "built", "published", "delivered"],
};

let made = 0;
/** An invented idea, moved to `state` by the real Store, one minute per step. */
function makeIdea(store: Store, state: IdeaState, startMinute = 60, more: { title?: string; quote?: string; conversationKey?: string } = {}): Idea {
  made += 1;
  const title = more.title ?? `Invented Idea ${made}`;
  let minute = startMinute;
  const idea = store.createIdea({ title, pitch: `An invented pitch for ${title}.`, quote: more.quote ?? `an invented quote for ${title}`, confidence: 0.8, conversationKey: more.conversationKey ?? "c_invented", detectorRunId: null }, at(minute));
  for (const next of WAY_TO[state]) {
    minute += 1;
    const patch =
      next === "asked" ? { todoId: 1000 + made, askedAt: at(minute), askExpiresAt: at(minute + 600) }
      : next === "approved" || next === "rejected" ? { answeredAt: at(minute), note: "ticked in Bee" }
      : next === "building" ? { slug: `invented-idea-${made}`, buildBackend: "kiro-crew", buildStartedAt: at(minute), note: "building with Kiro Crew" }
      : next === "built" ? { builtAt: at(minute), note: "built with Kiro Crew in 60 s" }
      : next === "build_failed" ? { failureReason: "the build ran past its time limit of 45 minutes", note: "the build failed" }
      : next === "publish_failed" ? { failureReason: "The page did not pass Overnight's checks.", note: "The page did not pass Overnight's checks." }
      : next === "published" ? { publishedUrl: `https://example.invalid/overnight-apps/invented-idea-${made}/`, publishedAt: at(minute) }
      : next === "delivered" ? { deliveredAt: at(minute), morningTodoId: 2000 + made, factId: 3000 + made }
      : {};
    store.transitionIdea(idea.id, next, patch, at(minute));
  }
  return store.getIdea(idea.id) as Idea;
}

/** One invented conversation with `lengths.length` lines, each that many characters long, a minute apart. */
function makeConversation(store: Store, name: string, startMinute: number, lengths: number[]): { key: string; ids: number[] } {
  const conversation = store.resolveConversation({ uuid: `invented-${name}` }, at(startMinute));
  const ids = lengths.map((length, index) => {
    const when = at(startMinute + index);
    const result = store.insertUtterance({ beeUtteranceId: null, conversationKey: conversation.key, text: "x".repeat(length), spokenAt: when, receivedAt: when, source: "stream" });
    return result.id as number;
  });
  return { key: conversation.key, ids };
}

function look(q: Partial<typeof Q> = {}, target: string = file) {
  const read = readDatabase(target, { ...Q, ...q });
  if (!read.ok) throw new Error(`the look failed: ${read.problem}`);
  return read.data;
}

/**
 * Hold the database the one way that shuts out even a reader: another connection in SQLite's
 * exclusive locking mode, in the middle of a write. Nothing of Overnight's does this; a backup
 * tool or a person with the sqlite3 command could.
 */
function holdWholeDatabase(target: string): { release: () => void } {
  const holder = new Database(target);
  holder.pragma("locking_mode = EXCLUSIVE");
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('held_by_a_test', '1', ?)").run(at(0));
  return {
    release: () => {
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

function listing(folder: string = scratch): string[] {
  return readdirSync(folder)
    .sort()
    .map((name) => {
      const info = statSync(path.join(folder, name));
      return `${name} ${info.size} ${info.mtimeMs}`;
    });
}

describe("what the look reads, against what the Store reads", () => {
  /** The fields of the Store's idea that the pages are not given as they are. */
  const LEFT_BEHIND = ["quote", "conversationKey", "detectorRunId", "todoId", "morningTodoId", "factId"];
  /** The fields the dashboard adds. */
  const ADDED = ["quote", "hidden", "rehearsal", "buildStarts", "awaitingRetry", "hasMorningTodo", "hasFact"];

  it("gives every idea in every state the Store's own values, field by field", () => {
    const store = openStore();
    const ideas = IDEA_STATES.map((state, index) => makeIdea(store, state, 60 + index * 10));
    const read = look();
    expect(read.ideas).toHaveLength(IDEA_STATES.length);
    expect(read.unreadableRows).toBe(0);

    for (const idea of ideas) {
      const mine = read.ideas.find((candidate) => candidate.id === idea.id) as DashIdea;
      const stored = store.getIdea(idea.id) as Idea;
      // The same fields, no more and no fewer: a field added to the Store's idea must be decided on here.
      const expected = [...Object.keys(stored).filter((key) => !LEFT_BEHIND.includes(key)), ...ADDED].sort();
      expect(Object.keys(mine).sort()).toEqual(expected);
      for (const key of Object.keys(stored) as Array<keyof Idea>) {
        if (LEFT_BEHIND.includes(key)) continue;
        expect([key, mine[key as keyof DashIdea]]).toEqual([key, stored[key]]);
      }
      expect(mine.quote).toEqual({ shown: true, text: stored.quote });
      expect(mine.hidden).toBe(false);
      expect(mine.hasMorningTodo).toBe(stored.morningTodoId !== null);
      expect(mine.hasFact).toBe(stored.factId !== null);
      expect(mine.buildStarts).toBe(store.countBuildStarts(idea.id));
      expect(read.events.get(idea.id)).toEqual(store.ideaEvents(idea.id));
    }
  });

  it("tells the morning to-do from the Bee fact", () => {
    const store = openStore();
    const both = makeIdea(store, "delivered", 10);
    const noFact = makeIdea(store, "delivered", 30);
    store.updateIdea(noFact.id, { factId: null }, at(50));
    const noTodo = makeIdea(store, "delivered", 60);
    store.updateIdea(noTodo.id, { morningTodoId: null }, at(80));
    const read = look();
    const mine = (id: string): DashIdea => read.ideas.find((idea) => idea.id === id) as DashIdea;
    expect([mine(both.id).hasMorningTodo, mine(both.id).hasFact]).toEqual([true, true]);
    expect([mine(noFact.id).hasMorningTodo, mine(noFact.id).hasFact]).toEqual([true, false]);
    expect([mine(noTodo.id).hasMorningTodo, mine(noTodo.id).hasFact]).toEqual([false, true]);
    // The ids of Bee's to-dos and facts stay behind.
    expect(JSON.stringify(read.ideas)).not.toMatch(/"(todoId|morningTodoId|factId|conversationKey|detectorRunId)"/);
  });

  it("lists ideas newest first", () => {
    const store = openStore();
    const first = makeIdea(store, "heard", 10);
    const second = makeIdea(store, "delivered", 20);
    const third = makeIdea(store, "asked", 30);
    expect(look().ideas.map((idea) => idea.id)).toEqual([third.id, second.id, first.id]);
  });

  it("reads the 200 newest ideas and the events of those only", () => {
    const store = openStore();
    const oldest = makeIdea(store, "delivered", 0);
    for (let n = 1; n <= 200; n += 1) makeIdea(store, n % 2 === 0 ? "asked" : "heard", n);
    const read = look();
    expect(read.ideas).toHaveLength(200);
    expect(read.ideas.some((idea) => idea.id === oldest.id)).toBe(false);
    expect(read.events.has(oldest.id)).toBe(false);
    expect(read.events.size).toBe(200);
    expect([...read.events.values()].reduce((sum, events) => sum + events.length, 0)).toBe(300);
  });

  it("knows a rehearsal idea by the key the rehearse command gives it", () => {
    const store = openStore();
    const rehearsal = makeIdea(store, "approved", 10, { conversationKey: "rehearsal", quote: "" });
    const heard = makeIdea(store, "approved", 20);
    const read = look();
    expect(read.ideas.find((idea) => idea.id === rehearsal.id)?.rehearsal).toBe(true);
    expect(read.ideas.find((idea) => idea.id === heard.id)?.rehearsal).toBe(false);
    // An idea that never had a quote says so, filming or not.
    expect(read.ideas.find((idea) => idea.id === rehearsal.id)?.quote).toEqual({ shown: false, why: "none" });
    expect(look({ filming: FILMING }).ideas.find((idea) => idea.id === rehearsal.id)?.quote).toEqual({ shown: false, why: "none" });
  });

  it("counts build starts, and knows a build that was cut short and gets one more try", () => {
    const store = openStore();
    const cutShort = makeIdea(store, "building", 10);
    store.transitionIdea(cutShort.id, "build_failed", { failureReason: BUILD_STOPPED_REASON, note: "the build failed" }, at(20));
    const failed = makeIdea(store, "build_failed", 30);
    const secondTry = makeIdea(store, "building", 40);
    store.transitionIdea(secondTry.id, "build_failed", { failureReason: BUILD_STOPPED_REASON }, at(50));
    store.transitionIdea(secondTry.id, "building", {}, at(51));
    store.transitionIdea(secondTry.id, "build_failed", { failureReason: BUILD_STOPPED_REASON }, at(52));

    const read = look();
    const mine = (id: string): DashIdea => read.ideas.find((idea) => idea.id === id) as DashIdea;
    expect([mine(cutShort.id).buildStarts, mine(cutShort.id).awaitingRetry]).toEqual([1, true]);
    expect([mine(failed.id).buildStarts, mine(failed.id).awaitingRetry]).toEqual([1, false]);
    expect([mine(secondTry.id).buildStarts, mine(secondTry.id).awaitingRetry]).toEqual([2, false]);
  });
});

describe("what was heard, as counts only", () => {
  it("counts lines, asks and detector runs since the day's start, and nothing before it", () => {
    const store = openStore();
    const early = makeConversation(store, "before", -30, [20, 20, 20]);
    store.recordDetectorRun({ conversationKey: early.key, ranAt: at(-20), utteranceIds: early.ids, wordCount: 12, outcome: "not_idea" });
    makeIdea(store, "asked", -10);

    const a = makeConversation(store, "a", 10, [20, 20]);
    store.recordDetectorRun({ conversationKey: a.key, ranAt: at(15), utteranceIds: a.ids, wordCount: 8, outcome: "not_idea" });
    const b = makeConversation(store, "b", 20, [20, 20, 20, 20]);
    store.recordDetectorRun({ conversationKey: b.key, ranAt: at(25), utteranceIds: b.ids, wordCount: 16, outcome: "idea" });
    const c = makeConversation(store, "c", 30, [5]);
    store.recordDetectorRun({ conversationKey: c.key, ranAt: at(31), utteranceIds: c.ids, wordCount: 1, outcome: "skipped", reason: "too short" });
    const d = makeConversation(store, "d", 40, [20]);
    store.recordDetectorRun({ conversationKey: d.key, ranAt: at(41), utteranceIds: d.ids, wordCount: 4, outcome: "failed", reason: "no reply (gave up after 3 tries)" });
    makeIdea(store, "asked", 50);
    makeIdea(store, "approved", 60);
    makeIdea(store, "heard", 70);

    const read = look();
    expect(read.linesHeard).toBe(8);
    expect(read.asks).toBe(2);
    expect(read.detector).toEqual({ idea: 1, not_idea: 1, skipped: 1, failed: 1 });
    expect(read.lastHeardAt).toBe(at(40));
  });

  it("has nothing to count in a database nobody has spoken into", () => {
    openStore();
    const read = look();
    expect(read).toMatchObject({ linesHeard: 0, lastHeardAt: null, asks: 0, detector: { idea: 0, not_idea: 0, skipped: 0, failed: 0 }, heard: [], ideas: [], unreadableRows: 0 });
    expect(read.events.size).toBe(0);
  });

  it("gives each conversation its line count, its times and what the detector made of it", () => {
    const store = openStore();
    const notIdea = makeConversation(store, "not-idea", 10, [30, 30, 30]);
    store.recordDetectorRun({ conversationKey: notIdea.key, ranAt: at(14), utteranceIds: notIdea.ids, wordCount: 18, outcome: "not_idea" });
    const withIdea = makeConversation(store, "idea", 20, [30, 30]);
    const runId = store.recordDetectorRun({ conversationKey: withIdea.key, ranAt: at(23), utteranceIds: withIdea.ids, wordCount: 12, outcome: "idea" });
    const idea = store.createIdea({ title: "Chore Wheel", pitch: "Spin a wheel to share out chores.", quote: "an invented quote", confidence: 0.9, conversationKey: withIdea.key, detectorRunId: runId }, at(23));
    const tooShort = makeConversation(store, "short", 30, [4]);
    store.recordDetectorRun({ conversationKey: tooShort.key, ranAt: at(32), utteranceIds: tooShort.ids, wordCount: 1, outcome: "skipped", reason: "too short" });
    const tooOld = makeConversation(store, "old", 40, [30]);
    store.recordDetectorRun({ conversationKey: tooOld.key, ranAt: at(42), utteranceIds: tooOld.ids, wordCount: 6, outcome: "skipped", reason: "too old" });
    const failed = makeConversation(store, "failed", 50, [30]);
    store.recordDetectorRun({ conversationKey: failed.key, ranAt: at(52), utteranceIds: failed.ids, wordCount: 6, outcome: "failed", reason: "REASON-NEVER-SHOWN (gave up after 3 tries)" });
    const listening = makeConversation(store, "listening", 60, [30, 30]);
    store.recordDetectorRun({ conversationKey: listening.key, ranAt: at(61), utteranceIds: [listening.ids[0] as number], wordCount: 6, outcome: "not_idea" });

    const read = look();
    expect(read.heard.map((group) => [group.id, group.lines, group.outcome, group.ideaId])).toEqual([
      [listening.key, 2, "listening", null],
      [failed.key, 1, "failed", null],
      [tooOld.key, 1, "too_old", null],
      [tooShort.key, 1, "too_short", null],
      [withIdea.key, 2, "idea", idea.id],
      [notIdea.key, 3, "not_idea", null],
    ]);
    expect(read.heard.at(-1)).toMatchObject({ firstAt: at(10), lastAt: at(12) });
    // Why the detector did what it did is used to pick a word of ours, and goes no further.
    expect(JSON.stringify(read.heard)).not.toContain("REASON-NEVER-SHOWN");
  });

  it("calls a skip it does not know just that", () => {
    const store = openStore();
    const odd = makeConversation(store, "odd", 10, [30]);
    store.recordDetectorRun({ conversationKey: odd.key, ranAt: at(12), utteranceIds: odd.ids, wordCount: 6, outcome: "skipped", reason: "a reason from a later version" });
    expect(look().heard.map((group) => group.outcome)).toEqual(["skipped"]);
  });

  it("shows the six newest conversations", () => {
    const store = openStore();
    const keys = Array.from({ length: 8 }, (_, n) => makeConversation(store, `n${n}`, n * 10, [30]).key);
    expect(look().heard.map((group) => group.id)).toEqual(keys.slice(2).reverse());
  });

  it("counts all 100 lines of a long conversation, and draws its newest eight", () => {
    const store = openStore();
    // 92 short lines, then eight whose lengths give each size of bar.
    const lengths = [...Array.from({ length: 92 }, () => 3), 0, 1, 15, 16, 30, 31, 104, 300];
    const long = makeConversation(store, "long", 0, lengths);
    const read = look();
    expect(read.heard).toHaveLength(1);
    expect(read.heard[0]).toMatchObject({ id: long.key, lines: 100, outcome: "listening" });
    expect(read.heard[0]?.bars).toEqual([1, 1, 1, 2, 2, 3, 7, 7]);
    expect(read.linesHeard).toBe(100);
  });

  it("leaves out a conversation that ended before the day's start", () => {
    const store = openStore();
    makeConversation(store, "yesterday", -100, [30, 30]);
    const today = makeConversation(store, "today", 5, [30]);
    expect(look().heard.map((group) => group.id)).toEqual([today.key]);
  });
});

// The dashboard used to promise a build from the settings alone. Whether one happens is also in
// the database: the ledger of what builds cost, the rehearsal ideas, and the night clock's records.
describe("what decides whether, and when, a build happens", () => {
  it("sums the month's ledger exactly as the Store does: this month's rows, estimates apart", () => {
    const store = openStore();
    const idea = makeIdea(store, "delivered", 10);
    const nothing = { credits: 0, estimated: 0, tries: 0 };
    expect(look().creditsThisMonth).toEqual(nothing);
    expect(look().creditsThisMonth).toEqual(store.buildCreditsBetween(MONTH.start, MONTH.end));
    store.recordBuildCost({ ideaId: idea.id, at: at(20), backend: "kiro-crew", credits: 6.29, measured: true });
    store.recordBuildCost({ ideaId: idea.id, at: at(30), backend: "kiro-cli", credits: 4.09, measured: false });
    // Fractions that do not add up evenly in a computer: the sum is still given to three decimals.
    store.recordBuildCost({ ideaId: idea.id, at: at(40), backend: "kiro-crew", credits: 0.1, measured: true });
    store.recordBuildCost({ ideaId: idea.id, at: at(41), backend: "kiro-crew", credits: 0.2, measured: true });
    // The last moment of September and the first of November are other months'.
    store.recordBuildCost({ ideaId: idea.id, at: "2026-10-01T05:59:59.999Z", backend: "kiro-crew", credits: 50, measured: true });
    store.recordBuildCost({ ideaId: idea.id, at: MONTH.end, backend: "kiro-crew", credits: 70, measured: true });
    expect(look().creditsThisMonth).toEqual({ credits: 10.68, estimated: 4.09, tries: 4 });
    expect(look().creditsThisMonth).toEqual(store.buildCreditsBetween(MONTH.start, MONTH.end));
    // Asked for another month, it is that month's.
    const november = { start: MONTH.end, end: "2026-12-01T07:00:00.000Z" };
    expect(look({ month: november }).creditsThisMonth).toEqual(store.buildCreditsBetween(november.start, november.end));
    expect(look({ month: november }).creditsThisMonth).toEqual({ credits: 70, estimated: 0, tries: 1 });
    expect(look().unreadableRows).toBe(0);
  });

  it("counts nothing, and still reads everything else, in a database that has no ledger yet", () => {
    const store = openStore();
    const idea = makeIdea(store, "approved", 10);
    store.close();
    stores.length = 0;
    // The database as Milestone 2 left it: the live one, until a Milestone 3 program first opens it.
    const raw = new Database(file);
    raw.exec("DROP TABLE build_costs;");
    raw.pragma("user_version = 3");
    raw.close();
    const read = readDatabase(file, Q);
    expect(read.ok).toBe(true);
    expect(look().creditsThisMonth).toEqual({ credits: 0, estimated: 0, tries: 0 });
    expect(look().ideas.map((mine) => mine.id)).toEqual([idea.id]);
    expect(look().unreadableRows).toBe(0);
    // Looking did not upgrade it.
    const after = new Database(file, { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(3);
    expect(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'build_costs'").get()).toEqual({ n: 0 });
    after.close();
  });

  it("counts the rehearsal ideas in the whole database, as the commands that refuse the folder do", () => {
    const store = openStore();
    expect(look().rehearsalIdeas).toBe(0);
    makeIdea(store, "approved", 5);
    expect(look().rehearsalIdeas).toBe(0);
    // The oldest idea is a rehearsal. 200 newer ones push it off the list of ideas that are shown.
    const rehearsal = makeIdea(store, "delivered", 0, { conversationKey: "rehearsal", quote: "" });
    for (let n = 1; n <= 200; n += 1) makeIdea(store, "heard", 10 + n);
    const read = look();
    expect(read.ideas.some((idea) => idea.id === rehearsal.id)).toBe(false);
    expect(read.ideas.some((idea) => idea.rehearsal)).toBe(false);
    expect(read.rehearsalIdeas).toBe(1);
    expect(read.rehearsalIdeas).toBe(store.listIdeas().filter((idea) => idea.conversationKey === "rehearsal").length);
    makeIdea(store, "approved", 300, { conversationKey: "rehearsal", quote: "" });
    expect(look().rehearsalIdeas).toBe(2);
  });

  it("reads what the night clock has stored for both jobs, as core's own readers give it", () => {
    const store = openStore();
    const none = { record: null, last: null, checkedAt: null };
    expect(look().nightClock).toEqual({ build: none, deliver: none });

    const config = parseConfig({ OVERNIGHT_DATA_DIR: scratch, TZ: "America/Boise" });
    // Oct 10: the build ran at 1:00 AM and was closed. Oct 11, 8:00 AM: the next one is found due, with the internet away.
    const lastNight = new Date("2026-10-10T07:00:30.000Z");
    const ranLastNight = closedRun(startedRun(noticedRun(currentSlot("build", lastNight, config), lastNight), lastNight), "done", new Date("2026-10-10T07:05:00.000Z"));
    writeNightRun(store, "build", ranLastNight, new Date("2026-10-10T07:05:00.000Z"));
    const morning = new Date("2026-10-11T14:00:00.000Z");
    const waiting = waitingRun(noticedRun(currentSlot("build", morning, config), morning), "offline");
    writeNightRun(store, "build", waiting, morning);
    noteChecked(store, "build", morning);
    noteChecked(store, "deliver", new Date("2026-10-11T14:00:20.000Z"));

    const read = look();
    expect(read.nightClock.build).toEqual({ record: waiting, last: ranLastNight, checkedAt: morning.toISOString() });
    expect(read.nightClock.deliver).toEqual({ record: null, last: null, checkedAt: "2026-10-11T14:00:20.000Z" });
    for (const job of ["build", "deliver"] as const) {
      expect(read.nightClock[job]).toEqual({ record: readNightRun(store, job), last: readLastNightRun(store, job), checkedAt: readCheckedAt(store, job) });
    }
    expect(read.unreadableRows).toBe(0);
  });

  it("takes a night clock record it cannot read as no record, the way every other program does", () => {
    const store = openStore();
    store.setValue("night.build.run", "not a record at all", at(1));
    store.setValue("night.deliver.run", JSON.stringify({ day: "tomorrow", slotAt: "soon" }), at(1));
    store.setValue("night.build.checkedAt", "half past one", at(1));
    const read = look();
    expect(read.nightClock).toEqual({ build: { record: null, last: null, checkedAt: null }, deliver: { record: null, last: null, checkedAt: null } });
    expect([readNightRun(store, "build"), readNightRun(store, "deliver"), readCheckedAt(store, "build")]).toEqual([null, null, null]);
  });

  it("reads no other small value: where the listener got to in Bee's history stays behind", () => {
    const store = openStore();
    store.setValue("backfill.cursor", "CURSOR-SENTINEL", at(1));
    store.setValue("nightly", "NOT-THE-CLOCK-SENTINEL", at(1));
    const results: unknown[] = [];
    const open = (target: string): Database.Database => {
      const db = openReadOnly(target);
      const prepare = db.prepare.bind(db);
      db.prepare = ((text: string) => {
        const statement = prepare(text);
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args);
          results.push(rows);
          return rows;
        }) as typeof statement.all;
        return statement;
      }) as typeof db.prepare;
      return db;
    };
    expect(readDatabase(file, Q, { open }).ok).toBe(true);
    expect(results.length).toBeGreaterThan(3);
    expect(JSON.stringify(results)).not.toMatch(/SENTINEL/);
  });
});

describe("quiet mode and the demo mark", () => {
  it("uses the setting until somebody has paused or resumed, then what they chose", () => {
    const store = openStore();
    expect(look({ pausedByDefault: true }).paused).toBe(true);
    expect(look({ pausedByDefault: false }).paused).toBe(false);
    store.setPaused(false, at(1));
    expect(look({ pausedByDefault: true }).paused).toBe(false);
    store.setPaused(true, at(2));
    expect(look({ pausedByDefault: false }).paused).toBe(true);
  });

  it("knows a database that says its data is invented", () => {
    const store = openStore();
    expect(look().demoMark).toBe(false);
    store.setValue("dashboard_demo", "true", at(1));
    expect(look().demoMark).toBe(true);
  });
});

describe("filming", () => {
  it("hides every quote, and the title and pitch of ideas nobody has approved", () => {
    const store = openStore();
    const ideas = IDEA_STATES.map((state, index) => makeIdea(store, state, 60 + index * 10, { title: `TITLE-${state}`, quote: `QUOTE-${state}` }));
    const read = look({ filming: FILMING });
    const hidden = ["heard", "asked", "rejected", "expired"];
    for (const stored of ideas) {
      const mine = read.ideas.find((idea) => idea.id === stored.id) as DashIdea;
      expect(mine.quote).toEqual({ shown: false, why: "filming" });
      if (hidden.includes(stored.state)) {
        expect([mine.state, mine.hidden, mine.title, mine.pitch, mine.slug]).toEqual([stored.state, true, HIDDEN_TITLE, "", null]);
      } else {
        expect([mine.state, mine.hidden, mine.title, mine.pitch]).toEqual([stored.state, false, stored.title, stored.pitch]);
      }
    }
    const sent = JSON.stringify([read.ideas, [...read.events.values()]]);
    expect(sent).not.toContain("QUOTE-");
    for (const state of hidden) expect(sent).not.toContain(`TITLE-${state}`);
    expect(HIDDEN_TITLE).toBe("An idea (hidden while filming)");
  });

  it("hides a hidden idea's folder name too, because it is made from the title", () => {
    const store = openStore();
    const asked = makeIdea(store, "asked", 10, { title: "TITLE-asked" });
    // No unapproved idea has a folder name today. If one ever does, it must not get out.
    const raw = new Database(file);
    raw.prepare("UPDATE ideas SET slug = 'title-asked' WHERE id = ?").run(asked.id);
    raw.close();
    expect(look().ideas[0]?.slug).toBe("title-asked");
    const filmed = look({ filming: FILMING }).ideas[0];
    expect([filmed?.hidden, filmed?.slug]).toEqual([true, null]);
    expect(JSON.stringify(filmed).toLowerCase()).not.toContain("title-asked");
  });

  it("lets the one idea named with --show-quote through, and only that one", () => {
    const store = openStore();
    const delivered = makeIdea(store, "delivered", 10, { quote: "QUOTE-delivered" });
    const asked = makeIdea(store, "asked", 20, { title: "TITLE-asked", quote: "QUOTE-asked" });
    const other = makeIdea(store, "delivered", 30, { quote: "QUOTE-other" });
    const otherAsked = makeIdea(store, "asked", 40, { title: "TITLE-other-asked", quote: "QUOTE-other-asked" });

    const read = look({ filming: { on: true, showQuoteFor: new Set([delivered.id, asked.id]) } });
    const mine = (id: string): DashIdea => read.ideas.find((idea) => idea.id === id) as DashIdea;
    expect(mine(delivered.id).quote).toEqual({ shown: true, text: "QUOTE-delivered" });
    expect([mine(asked.id).quote, mine(asked.id).title, mine(asked.id).hidden]).toEqual([{ shown: true, text: "QUOTE-asked" }, "TITLE-asked", false]);
    expect(mine(other.id).quote).toEqual({ shown: false, why: "filming" });
    expect([mine(otherAsked.id).quote, mine(otherAsked.id).title, mine(otherAsked.id).hidden]).toEqual([{ shown: false, why: "filming" }, HIDDEN_TITLE, true]);
  });

  it("changes nothing when it is off, whatever is named", () => {
    const store = openStore();
    const asked = makeIdea(store, "asked", 20, { title: "TITLE-asked", quote: "QUOTE-asked" });
    const read = look({ filming: { on: false, showQuoteFor: new Set(["some-other-id"]) } });
    expect(read.ideas.find((idea) => idea.id === asked.id)).toMatchObject({ title: "TITLE-asked", hidden: false, quote: { shown: true, text: "QUOTE-asked" } });
  });
});

describe("a database that cannot be read", () => {
  it("is 'missing' when the file is not there, and nothing is created", () => {
    expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "missing" });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("is 'missing' when the folder is not there either", () => {
    expect(readDatabase(path.join(scratch, "no such folder", "overnight.db"), Q)).toEqual({ ok: false, problem: "missing" });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("is 'empty' for a file with nothing in it", () => {
    writeFileSync(file, "");
    expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "empty" });
    expect(statSync(file).size).toBe(0);
  });

  it("is 'empty' for a database without Overnight's tables", () => {
    const other = new Database(file);
    other.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
    other.pragma("user_version = 1");
    other.close();
    expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "empty" });
  });

  it("is 'unreadable' for a file that is not a database", () => {
    writeFileSync(file, randomBytes(8192));
    expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "unreadable" });
  });

  it("is 'unreadable', not 'missing', for a folder where the database should be", () => {
    mkdirSync(file);
    expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "unreadable" });
  });

  // Opening a named pipe waits until someone writes into it. The look used to wait with it, for ever, and every page with the look.
  // It is asked in a process of its own, ended after five seconds: a look that never came back would stop this whole file otherwise.
  describe("when a named pipe stands where a file should be", () => {
    const lookElsewhere = (target: string): string => {
      const ran = spawnSync(process.execPath, [fileURLToPath(new URL("./pipe-child.ts", import.meta.url)), "database", target], { timeout: 5000, encoding: "utf8" });
      return ran.status === 0 ? ran.stdout.trim() : `no answer (${ran.signal ?? ran.status})`;
    };
    const UNREADABLE = JSON.stringify({ ok: false, problem: "unreadable" });

    it("is 'unreadable', at once, for a pipe under the database's own name", () => {
      execFileSync("mkfifo", [file]);
      expect(lookElsewhere(file)).toBe(UNREADABLE);
      expect(readdirSync(scratch)).toEqual(["overnight.db"]);
    }, 15_000);

    it("is 'unreadable', at once, for a pipe under one of the names SQLite opens beside the database", () => {
      openStore().close();
      for (const ending of ["-journal", "-wal", "-shm"]) {
        execFileSync("mkfifo", [file + ending]);
        expect(lookElsewhere(file), ending).toBe(UNREADABLE);
        rmSync(file + ending);
      }
      // With nothing odd beside it, the same database reads as usual.
      expect(JSON.parse(lookElsewhere(file))).toMatchObject({ ok: true });
    }, 30_000);

    it("never hands SQLite something that is not a plain file", () => {
      execFileSync("mkfifo", [file]);
      let opened = 0;
      // A stand-in that only counts: the real opener would wait for the pipe, and this test with it.
      const open = (): never => {
        opened += 1;
        throw new Error("the pipe was about to be opened");
      };
      expect(readDatabase(file, Q, { open })).toEqual({ ok: false, problem: "unreadable" });
      expect(opened).toBe(0);
      // A plain file is handed over as before.
      rmSync(file);
      writeFileSync(file, "");
      expect(readDatabase(file, Q, { open })).toEqual({ ok: false, problem: "unreadable" });
      expect(opened).toBe(1);
    });
  });

  it("is 'busy' when SQLite says the database is busy", () => {
    openStore();
    const busy = (code: string) => () => {
      throw Object.assign(new Error("database is locked"), { code });
    };
    expect(readDatabase(file, Q, { open: busy("SQLITE_BUSY") })).toEqual({ ok: false, problem: "busy" });
    expect(readDatabase(file, Q, { open: busy("SQLITE_BUSY_SNAPSHOT") })).toEqual({ ok: false, problem: "busy" });
    expect(readDatabase(file, Q, { open: busy("SQLITE_IOERR") })).toEqual({ ok: false, problem: "unreadable" });
  });

  it("is 'busy' for real when another program holds the whole database: it waits a quarter of a second, no longer", () => {
    const store = openStore();
    makeIdea(store, "asked");
    store.close();
    stores.length = 0;
    const holder = holdWholeDatabase(file);
    try {
      const started = performance.now();
      expect(readDatabase(file, Q)).toEqual({ ok: false, problem: "busy" });
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThan(200);
      expect(waited).toBeLessThan(1500);
    } finally {
      holder.release();
    }
    expect(look().ideas).toHaveLength(1);
  });

  it("is 'busy' when the database turns busy in the middle of the look, and the connection is still closed", () => {
    const store = openStore();
    makeIdea(store, "asked");
    let handed: Database.Database | null = null;
    const open = (target: string): Database.Database => {
      const db = openReadOnly(target);
      handed = db;
      const prepare = db.prepare.bind(db);
      let asked = 0;
      // The third statement finds the database busy.
      db.prepare = ((sql: string) => {
        asked += 1;
        if (asked === 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return prepare(sql);
      }) as typeof db.prepare;
      return db;
    };
    expect(readDatabase(file, Q, { open })).toEqual({ ok: false, problem: "busy" });
    expect((handed as Database.Database | null)?.open).toBe(false);
  });
});

describe("rows that do not fit", () => {
  it("leaves out an idea in a state it does not know, or with an id that is not one, and counts them", () => {
    const store = openStore();
    const good = makeIdea(store, "approved", 10);
    const odd = makeIdea(store, "asked", 20);
    const raw = new Database(file);
    raw.prepare("UPDATE ideas SET state = 'a-state-from-the-future' WHERE id = ?").run(odd.id);
    raw
      .prepare("INSERT INTO ideas (id, state, title, pitch, quote, confidence, conversation_key, created_at, updated_at) VALUES (?, 'heard', 'Bad Id', 'p', 'q', 0.5, 'c_invented', ?, ?)")
      .run("../../etc/passwd", at(30), at(30));
    raw.close();

    const read = look();
    expect(read.ideas.map((idea) => idea.id)).toEqual([good.id]);
    expect([...read.events.keys()]).toEqual([good.id]);
    expect(read.unreadableRows).toBe(2);
  });

  it("leaves out a timeline entry it cannot read, keeps the rest, and counts it", () => {
    const store = openStore();
    const idea = makeIdea(store, "approved", 10);
    const raw = new Database(file);
    raw.prepare("INSERT INTO idea_events (idea_id, at, from_state, to_state, note) VALUES (?, ?, 'approved', 'a-state-from-the-future', NULL)").run(idea.id, at(40));
    raw.close();

    const read = look();
    expect(read.events.get(idea.id)?.map((event) => event.toState)).toEqual(["heard", "asked", "approved"]);
    expect(read.unreadableRows).toBe(1);
  });

  it("reads a database from before Milestone 2, with what it does not have yet as nothing", () => {
    const store = openStore();
    const idea = makeIdea(store, "approved", 10);
    store.close();
    stores.length = 0;
    // Take away everything the later upgrades added, leaving the tables as the first two made them.
    const raw = new Database(file);
    raw.exec("DROP INDEX ideas_by_slug; DROP TABLE build_costs;");
    for (const column of ["slug", "build_backend", "build_started_at", "built_at", "published_url", "published_at", "delivered_at", "morning_todo_id", "fact_id", "failure_reason", "failure_notified_at"]) {
      raw.exec(`ALTER TABLE ideas DROP COLUMN ${column}`);
    }
    raw.pragma("user_version = 2");
    raw.close();

    const read = look();
    expect(read.unreadableRows).toBe(0);
    // No ledger and no rehearsal idea: nothing counted, nothing in the way.
    expect(read).toMatchObject({ creditsThisMonth: { credits: 0, estimated: 0, tries: 0 }, rehearsalIdeas: 0 });
    expect(read.ideas).toHaveLength(1);
    expect(read.ideas[0]).toMatchObject({
      id: idea.id, state: "approved", title: idea.title, slug: null, buildBackend: null, buildStartedAt: null, builtAt: null, publishedUrl: null, publishedAt: null,
      deliveredAt: null, failureReason: null, failureNotifiedAt: null, hasMorningTodo: false, hasFact: false, buildStarts: 0, awaitingRetry: false,
    });
  });

  it("is not thrown by a column it has never heard of", () => {
    const store = openStore();
    const idea = makeIdea(store, "asked", 10);
    const raw = new Database(file);
    raw.exec("ALTER TABLE ideas ADD COLUMN from_a_later_version TEXT DEFAULT 'x'");
    raw.close();
    const read = look();
    expect(read.ideas.map((mine) => mine.id)).toEqual([idea.id]);
    expect(Object.keys(read.ideas[0] ?? {})).not.toContain("from_a_later_version");
  });
});

describe("the look never gets in the writer's way", () => {
  it("holds no read open afterwards: the writer can tidy its write-ahead file at once", () => {
    const store = openStore();
    for (let n = 0; n < 20; n += 1) makeIdea(store, "asked", n);
    makeConversation(store, "a", 5, [30, 30, 30]);
    const checker = new Database(file, { timeout: 250 });
    try {
      for (let n = 0; n < 25; n += 1) {
        look();
        makeIdea(store, "heard", 100 + n);
        // [{ busy, log, checkpointed }]: busy 1 means a reader stood in the way.
        expect(checker.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
      }
    } finally {
      checker.close();
    }
  });

  it("would be caught: a read that IS left open makes the same checkpoint report busy", () => {
    const store = openStore();
    makeIdea(store, "asked", 1);
    const checker = new Database(file, { timeout: 0 });
    const held = openReadOnly(file);
    try {
      const rows = held.prepare("SELECT id FROM idea_events").iterate();
      rows.next();
      makeIdea(store, "heard", 2);
      expect((checker.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>)[0]?.busy).toBe(1);
      rows.return?.();
    } finally {
      held.close();
      checker.close();
    }
  });

  it("closes its connection after every look, whether it worked or not", () => {
    const store = openStore();
    makeIdea(store, "asked", 1);
    const handed: Database.Database[] = [];
    const open = (target: string): Database.Database => {
      const db = openReadOnly(target);
      handed.push(db);
      return db;
    };
    expect(readDatabase(file, Q, { open }).ok).toBe(true);

    const other = path.join(scratch, "other.db");
    const raw = new Database(other);
    raw.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
    raw.pragma("user_version = 3");
    raw.close();
    expect(readDatabase(other, Q, { open })).toEqual({ ok: false, problem: "empty" });

    expect(handed).toHaveLength(2);
    expect(handed.map((db) => db.open)).toEqual([false, false]);
  });

  it("cannot write: SQLite refuses, with query_only on and with it switched off again", () => {
    const store = openStore();
    const idea = makeIdea(store, "asked", 1);
    const db = openReadOnly(file);
    try {
      expect(db.readonly).toBe(true);
      expect(db.pragma("query_only", { simple: true })).toBe(1);
      const write = (): unknown => db.prepare("UPDATE ideas SET title = 'changed'").run();
      expect(write).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
      db.pragma("query_only = OFF");
      expect(write).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
    } finally {
      db.close();
    }
    expect(store.getIdea(idea.id)?.title).toBe(idea.title);
  });

  it("refuses to open a database that is not there, instead of creating one", () => {
    expect(() => openReadOnly(file)).toThrow();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("changes no file while a writer has the database open", () => {
    const store = openStore();
    makeIdea(store, "delivered", 1);
    makeConversation(store, "a", 5, [30, 30]);
    const before = listing();
    for (let n = 0; n < 10; n += 1) look();
    expect(listing()).toEqual(before);
  });

  it("leaves the database file itself untouched when nobody else has it open", () => {
    const store = openStore();
    makeIdea(store, "delivered", 1);
    store.close();
    stores.length = 0;
    expect(readdirSync(scratch)).toEqual(["overnight.db"]);
    const fingerprint = (): string => `${createHash("sha256").update(readFileSync(file)).digest("hex")} ${statSync(file).size} ${statSync(file).mtimeMs}`;
    const before = fingerprint();
    for (let n = 0; n < 5; n += 1) look();
    expect(fingerprint()).toBe(before);
    // SQLite's own two helper files, which the next Overnight command removes. Nothing else.
    expect(readdirSync(scratch).sort()).toEqual(["overnight.db", "overnight.db-shm", "overnight.db-wal"]);
    expect(statSync(`${file}-wal`).size).toBe(0);
    new Store(file).close();
    expect(readdirSync(scratch)).toEqual(["overnight.db"]);
  });
});

describe("the source of the look", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/data/db.ts", import.meta.url)), "utf8");
  // Comments may say what the code must not do; only the code is checked.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line) || /SQL-(START|END)/.test(line))
    .join("\n");
  const start = code.indexOf("// SQL-START");
  const end = code.indexOf("// SQL-END");
  const sql = code.slice(start, end);
  const rest = code.slice(0, start) + code.slice(end);

  it("keeps every statement in one block", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sql).toContain("FROM utterances");
    // Outside the block nothing looks like SQL, and every statement that is run comes from the block.
    expect(rest).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|ATTACH|CREATE|DROP|ALTER)\b/);
    const prepared = rest.match(/\.prepare\([^)]*\)/g) ?? [];
    expect(prepared.length).toBeGreaterThan(5);
    for (const call of prepared) expect(call).toMatch(/^\.prepare\(SQL\.[A-Za-z]+\)$/);
    expect(rest).not.toContain(".exec(");
  });

  it("never reads what was said: a line's words appear only as their length", () => {
    const mentions = sql.match(/\btext\b/g) ?? [];
    expect(mentions.length).toBe(1);
    expect(sql).toContain("length(text)");
    expect(sql).not.toMatch(/utterances\.\*|\bu\.\*/);
    // "SELECT *" is used for ideas only.
    expect(sql.match(/SELECT \*/g)).toEqual(["SELECT *"]);
    expect(sql).toContain("SELECT * FROM ideas");
  });

  it("never reads the detector's verdict, only writes nothing, and never leaves a list half-read", () => {
    expect(code).not.toContain("verdict_json");
    expect(code).not.toContain(".iterate(");
    expect(code).not.toMatch(/\bBEGIN\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|VACUUM)\b/);
    // Two pragmas and no more: the version, and the fence against writes.
    expect(rest.match(/\.pragma\("[^"]*"/g)).toEqual(['.pragma("query_only = ON"', '.pragma("user_version"']);
  });

  it("opens the database read-only and only if it exists", () => {
    const opens = rest.match(/new Database\([^)]*\)/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(opens[0]).toContain("readonly: true");
    expect(opens[0]).toContain("fileMustExist: true");
  });

  it("really reads nothing that was said, with the real connection", () => {
    const store = openStore();
    const conversation = store.resolveConversation({ uuid: "invented-sentinel" }, at(1));
    store.insertUtterance({ beeUtteranceId: null, conversationKey: conversation.key, text: "LINE-SENTINEL an invented line", spokenAt: at(1), receivedAt: at(1), source: "stream" });
    store.recordDetectorRun({ conversationKey: conversation.key, ranAt: at(2), utteranceIds: [], wordCount: 5, outcome: "idea", verdict: { is_idea: true, confidence: 0.9, title: "T", pitch: "P", quote: "VERDICT-SENTINEL", said_by_wearer_guess: true, likely_media: false, buildable_as_static_web_app: true, reason: "REASON-SENTINEL" }, reason: "REASON-SENTINEL" });
    const statements: string[] = [];
    const results: unknown[] = [];
    const open = (target: string): Database.Database => {
      const db = openReadOnly(target);
      const prepare = db.prepare.bind(db);
      db.prepare = ((text: string) => {
        statements.push(text);
        const statement = prepare(text);
        const all = statement.all.bind(statement);
        const get = statement.get.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args);
          results.push(rows);
          return rows;
        }) as typeof statement.all;
        statement.get = ((...args: unknown[]) => {
          const row = get(...args);
          results.push(row);
          return row;
        }) as typeof statement.get;
        return statement;
      }) as typeof db.prepare;
      return db;
    };
    expect(readDatabase(file, Q, { open }).ok).toBe(true);
    expect(statements.length).toBeGreaterThan(8);
    expect(JSON.stringify(results)).not.toMatch(/LINE-SENTINEL|VERDICT-SENTINEL|REASON-SENTINEL/);
  });
});

describe("one look at everything", () => {
  let paths: DataPaths;
  let config: Config;

  beforeEach(() => {
    paths = dataPaths(scratch);
    config = parseConfig({ OVERNIGHT_DATA_DIR: scratch, PAUSED: "false", TZ: "America/Boise" });
  });

  /** Write log lines the way the night jobs do, at invented times. */
  function writeLog(name: "build" | "deliver", lines: Array<[string, string, Record<string, string | number | boolean>]>): void {
    let when = "";
    const logger = createLogger({ name, file: path.join(paths.logs, `${name}.log`), write: () => {}, now: () => new Date(when) });
    for (const [time, message, fields] of lines) {
      when = time;
      logger.info(message, fields);
    }
  }

  it("puts the database, the locks, the logs and the clock together", () => {
    const store = openStore(paths.database);
    const idea = makeIdea(store, "delivered", 60);
    makeConversation(store, "a", 5, [30, 30]);
    writeLog("build", [
      [at(63), LOG_MESSAGES.buildRunStart.text, { dataDir: scratch }],
      [at(63), LOG_MESSAGES.ideaStart.text, { ideaId: idea.id, backend: "kiro-crew" }],
      [at(64), LOG_MESSAGES.ideaBuilt.text, { ideaId: idea.id, backend: "kiro-crew", seconds: 60, credits: 3.09 }],
      [at(64), LOG_MESSAGES.buildRunEnd.text, { built: 1, failed: 0 }],
    ]);
    writeLog("deliver", [
      [at(65), LOG_MESSAGES.deliverRunStart.text, { dataDir: scratch }],
      [at(65), LOG_MESSAGES.verified.text, { ideaId: idea.id, files: 3, bytes: 5602, ms: 5200 }],
      [at(66), LOG_MESSAGES.deliverRunEnd.text, { delivered: 1, failed: 0, notified: 0 }],
    ]);

    // 1:02 AM in Boise on Oct 11.
    const now = new Date("2026-10-11T07:02:00.000Z");
    const snapshot = collectSnapshot({ config, paths, filming: NOT_FILMING, now });
    expect(snapshot).toMatchObject({
      at: now.toISOString(),
      problem: null,
      staleSince: null,
      demoMark: false,
      paused: false,
      running: { listener: false, build: false, deliver: false },
      dayStart: DAY_START,
      linesHeard: 2,
      nextBuildAt: "2026-10-12T07:00:00.000Z",
      nextDeliverAt: "2026-10-11T12:30:00.000Z",
      unreadableRows: 0,
    });
    expect(snapshot.dayStart).toBe(overnightDayStart(now, config).toISOString());
    expect(snapshot.ideas.map((mine) => mine.id)).toEqual([idea.id]);
    expect(snapshot.build.get(idea.id)?.finished).toEqual({ at: at(64), ok: true, seconds: 60, credits: 3.09 });
    expect(snapshot.deliver.get(idea.id)?.checked).toMatchObject({ ok: true, files: 3, bytes: 5602, ms: 5200 });
    expect(snapshot.buildRuns).toHaveLength(1);
    expect(snapshot.deliverRuns).toHaveLength(1);
    // The data folder's path was on two of those lines, and is nowhere in what was read.
    expect(JSON.stringify([snapshot.buildRuns, snapshot.deliverRuns, [...snapshot.build], [...snapshot.deliver]])).not.toContain(scratch);
  });

  it("holds the month's credits against the limit by core's own rule, and says when it cannot", () => {
    const store = openStore(paths.database);
    const idea = makeIdea(store, "delivered", 60);
    const now = new Date("2026-10-11T07:02:00.000Z");
    const limited = { ...config, maxBuildCreditsPerMonth: 5 };
    expect(collectSnapshot({ config: limited, paths, filming: NOT_FILMING, now }).buildCredits).toEqual(buildBudget(store, limited, now));
    expect(collectSnapshot({ config: limited, paths, filming: NOT_FILMING, now }).buildCredits).toMatchObject({ counted: 0, limit: 5, reached: false });
    store.recordBuildCost({ ideaId: idea.id, at: at(64), backend: "kiro-crew", credits: 6.29, measured: true });
    store.recordBuildCost({ ideaId: idea.id, at: at(70), backend: "kiro-cli", credits: 4.09, measured: false });
    const used = collectSnapshot({ config: limited, paths, filming: NOT_FILMING, now }).buildCredits;
    expect(used).toEqual(buildBudget(store, limited, now));
    expect(used).toMatchObject({ counted: 10.38, estimated: 4.09, tries: 2, limit: 5, reached: true, monthStart: MONTH.start, monthEnd: MONTH.end });
    // The same ledger under the usual limit is far from reached. A limit of 0 always is.
    expect(collectSnapshot({ config, paths, filming: NOT_FILMING, now }).buildCredits).toMatchObject({ counted: 10.38, limit: 400, reached: false });
    expect(collectSnapshot({ config: { ...config, maxBuildCreditsPerMonth: 0 }, paths, filming: NOT_FILMING, now }).buildCredits).toEqual(buildBudget(store, { ...config, maxBuildCreditsPerMonth: 0 }, now));
    // Seen from November, October's credits are not this month's.
    const november = new Date("2026-11-02T08:02:00.000Z");
    expect(collectSnapshot({ config: limited, paths, filming: NOT_FILMING, now: november }).buildCredits).toEqual(buildBudget(store, limited, november));
    expect(collectSnapshot({ config: limited, paths, filming: NOT_FILMING, now: november }).buildCredits).toMatchObject({ counted: 0, reached: false });
    // A database that cannot be read: nothing is claimed about the month.
    const nowhere = path.join(scratch, "nowhere");
    expect(collectSnapshot({ config: { ...limited, dataDir: nowhere }, paths: dataPaths(nowhere), filming: NOT_FILMING, now })).toMatchObject({ problem: "missing", buildCredits: null, rehearsalIdeas: 0, nightClock: { build: { record: null }, deliver: { record: null } } });
  });

  it("sees which programs hold their locks in the data folder", () => {
    openStore(paths.database);
    const now = new Date("2026-10-11T07:02:00.000Z");
    const listening = takeLock(listenLockFile(paths));
    const delivering = takeLock(deliverLockFile(paths));
    try {
      expect(collectSnapshot({ config, paths, filming: NOT_FILMING, now }).running).toEqual({ listener: true, build: false, deliver: true });
    } finally {
      listening?.();
      delivering?.();
    }
    expect(collectSnapshot({ config, paths, filming: NOT_FILMING, now }).running).toEqual({ listener: false, build: false, deliver: false });
  });

  it("applies filming and the paused setting", () => {
    const store = openStore(paths.database);
    makeIdea(store, "asked", 60, { title: "TITLE-asked", quote: "QUOTE-asked" });
    const now = new Date("2026-10-11T07:02:00.000Z");
    const filmed = collectSnapshot({ config: { ...config, pausedByDefault: true }, paths, filming: FILMING, now });
    expect(filmed.paused).toBe(true);
    expect(JSON.stringify(filmed.ideas)).not.toMatch(/TITLE-asked|QUOTE-asked/);
  });

  it("says what is wrong, and creates nothing, for a data folder that has never been used", () => {
    const empty = path.join(scratch, "never used");
    const now = new Date("2026-10-11T07:02:00.000Z");
    const snapshot = collectSnapshot({ config: { ...config, dataDir: empty, pausedByDefault: true }, paths: dataPaths(empty), filming: NOT_FILMING, now });
    expect(snapshot).toMatchObject({ problem: "missing", paused: true, ideas: [], heard: [], buildRuns: [], deliverRuns: [], linesHeard: 0, running: { listener: false, build: false, deliver: false } });
    expect(readdirSync(scratch)).toEqual([]);
  });

  describe("asked for again and again", () => {
    let clock: number;
    let tick: number;
    const source = (more: { reuseMs?: number } = {}) => createSnapshotSource({ config, paths, filming: NOT_FILMING, now: () => new Date(clock), ticks: () => tick, ...more });

    beforeEach(() => {
      clock = Date.parse("2026-10-11T07:02:00.000Z");
      tick = 5000;
    });

    it("reuses one look for a second, then looks again", () => {
      const store = openStore(paths.database);
      makeIdea(store, "asked", 60);
      const looks = source();
      const first = looks.get();
      expect(first.ideas).toHaveLength(1);

      makeIdea(store, "heard", 70);
      tick += 999;
      expect(looks.get()).toBe(first);
      tick += 1;
      const second = looks.get();
      expect(second).not.toBe(first);
      expect(second.ideas).toHaveLength(2);
    });

    it("measures that second by a steady clock, so a pretend clock that stands still does not freeze the page", () => {
      const store = openStore(paths.database);
      const looks = createSnapshotSource({ config, paths, filming: NOT_FILMING, now: () => new Date(clock), reuseMs: 20 });
      expect(looks.get().ideas).toHaveLength(0);
      makeIdea(store, "heard", 70);
      const until = performance.now() + 2000;
      let seen = 0;
      while (seen === 0 && performance.now() < until) seen = looks.get().ideas.length;
      expect(seen).toBe(1);
    });

    it("keeps showing the last good look when the database cannot be read for a moment, and says since when", () => {
      const store = openStore(paths.database);
      const idea = makeIdea(store, "asked", 60);
      const looks = source({ reuseMs: 0 });
      const good = looks.get();
      expect(good.problem).toBeNull();
      store.close();
      stores.length = 0;

      // The file is damaged for a while.
      const saved = readFileSync(paths.database);
      writeFileSync(paths.database, randomBytes(saved.length));
      clock += 3000;
      const stale = looks.get();
      expect(stale.problem).toBe("unreadable");
      expect(stale.staleSince).toBe(good.at);
      expect(stale.at).toBe(new Date(clock).toISOString());
      expect(stale.ideas.map((mine) => mine.id)).toEqual([idea.id]);

      // And readable again.
      writeFileSync(paths.database, saved);
      clock += 3000;
      const fresh = looks.get();
      expect([fresh.problem, fresh.staleSince]).toEqual([null, null]);
      expect(fresh.ideas.map((mine) => mine.id)).toEqual([idea.id]);
    });

    it("does the same while another program holds the whole database", () => {
      const store = openStore(paths.database);
      const idea = makeIdea(store, "asked", 60);
      const looks = source({ reuseMs: 0 });
      const good = looks.get();
      store.close();
      stores.length = 0;

      const holder = holdWholeDatabase(paths.database);
      let stale;
      try {
        clock += 2000;
        stale = looks.get();
      } finally {
        holder.release();
      }
      expect([stale.problem, stale.staleSince]).toEqual(["busy", good.at]);
      expect(stale.ideas.map((mine) => mine.id)).toEqual([idea.id]);
      expect(looks.get().problem).toBeNull();
    });

    it("has nothing older to show when the very first look fails", () => {
      writeFileSync(paths.database, randomBytes(4096));
      const first = source().get();
      expect([first.problem, first.staleSince, first.ideas.length]).toEqual(["unreadable", null, 0]);
    });

    it("does not show an old look in place of a database that is gone", () => {
      const store = openStore(paths.database);
      makeIdea(store, "asked", 60);
      const looks = source({ reuseMs: 0 });
      expect(looks.get().ideas).toHaveLength(1);
      store.close();
      stores.length = 0;
      rmSync(paths.database);
      const gone = looks.get();
      expect([gone.problem, gone.staleSince, gone.ideas.length]).toEqual(["missing", null, 0]);
    });
  });
});
