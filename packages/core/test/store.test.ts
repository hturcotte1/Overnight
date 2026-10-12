// All text in this file is made up for the tests. None of it is Bee data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { HIGHEST_BUILD_CREDIT_LIMIT, InvalidTransitionError, Store, budgetReachedText, buildBudget } from "../src/index.ts";

const T0 = "2026-10-09T18:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("conversations", () => {
  it("creates one row per conversation and fills in what it learns", () => {
    const first = store.resolveConversation({ uuid: "u-1" }, T0);
    const again = store.resolveConversation({ uuid: "u-1", beeId: 42, state: "CAPTURING" }, at(1));
    expect(again.key).toBe(first.key);
    expect(again).toMatchObject({ uuid: "u-1", beeId: 42, state: "CAPTURING", deleted: false });
    expect(store.findConversationByBeeId(42)?.key).toBe(first.key);
  });

  it("merges two rows when it learns they are the same conversation", () => {
    const byUuid = store.resolveConversation({ uuid: "u-2" }, T0);
    const byId = store.resolveConversation({ beeId: 77 }, T0);
    expect(byId.key).not.toBe(byUuid.key);
    store.insertUtterance({ beeUtteranceId: 1, conversationKey: byUuid.key, text: "from the stream", spokenAt: at(1), receivedAt: at(5), source: "stream" });
    store.insertUtterance({ beeUtteranceId: null, conversationKey: byId.key, text: "from backfill", spokenAt: at(9), receivedAt: at(60), source: "backfill" });

    const merged = store.resolveConversation({ uuid: "u-2", beeId: 77 }, at(61));
    expect(merged.key).toBe(byUuid.key);
    expect(store.getConversation(byId.key)).toBeNull();
    expect(store.pendingUtterances(merged.key).map((u) => u.text)).toEqual(["from the stream", "from backfill"]);
  });

  it("remembers that Bee deleted a conversation without losing its lines", () => {
    const conversation = store.resolveConversation({ uuid: "u-3", beeId: 5 }, T0);
    store.insertUtterance({ beeUtteranceId: 9, conversationKey: conversation.key, text: "a short one", spokenAt: at(1), receivedAt: at(2), source: "stream" });
    expect(store.resolveConversation({ beeId: 5, deleted: true }, at(400)).deleted).toBe(true);
    expect(store.pendingUtterances(conversation.key)).toHaveLength(1);
  });

  it("needs at least one id", () => {
    expect(() => store.resolveConversation({}, T0)).toThrow();
  });
});

describe("utterances and detector runs", () => {
  it("ignores a stream line it already has", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const line = { beeUtteranceId: 100, conversationKey: key, text: "hello", spokenAt: at(1), receivedAt: at(3), source: "stream" as const };
    expect(store.insertUtterance(line).inserted).toBe(true);
    expect(store.insertUtterance(line).inserted).toBe(false);
    expect(store.countUtterances()).toBe(1);
  });

  it("lists conversations with uncovered lines and clears them once a run covers them", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const a = store.insertUtterance({ beeUtteranceId: 1, conversationKey: key, text: "one two", spokenAt: at(1), receivedAt: at(4), source: "stream" });
    const b = store.insertUtterance({ beeUtteranceId: 2, conversationKey: key, text: "three", spokenAt: at(2), receivedAt: at(9), source: "stream" });
    expect(store.conversationsAwaitingDetection()).toEqual([{ conversationKey: key, pendingCount: 2, lastReceivedAt: at(9) }]);

    const runId = store.recordDetectorRun({ conversationKey: key, ranAt: at(130), utteranceIds: [a.id!, b.id!], wordCount: 3, outcome: "not_idea" });
    expect(runId).toBeGreaterThan(0);
    expect(store.conversationsAwaitingDetection()).toEqual([]);
    expect(store.countDetectorRuns("not_idea")).toBe(1);

    // A later line starts a new pending batch; earlier lines stay covered.
    store.insertUtterance({ beeUtteranceId: 3, conversationKey: key, text: "four", spokenAt: at(200), receivedAt: at(205), source: "stream" });
    expect(store.pendingUtterances(key).map((u) => u.text)).toEqual(["four"]);
  });

  it("finds nearby lines across conversations and knows when the newest line arrived", () => {
    expect(store.newestUtteranceReceivedAt()).toBeNull();
    const a = store.resolveConversation({ uuid: "u-a" }, T0);
    const b = store.resolveConversation({ beeId: 9 }, T0);
    store.insertUtterance({ beeUtteranceId: 1, conversationKey: a.key, text: "same words", spokenAt: at(10), receivedAt: at(12), source: "stream" });
    store.insertUtterance({ beeUtteranceId: null, conversationKey: b.key, text: "same words", spokenAt: at(11), receivedAt: at(90), source: "backfill" });
    expect(store.utterancesSpokenNear(at(10), 3000).map((u) => u.conversationKey)).toEqual([a.key, b.key]);
    expect(store.utterancesSpokenNear(at(100), 3000)).toEqual([]);
    expect(store.newestUtteranceReceivedAt()).toBe(at(90));
  });

  it("finds lines spoken close to a moment", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    store.insertUtterance({ beeUtteranceId: 1, conversationKey: key, text: "near", spokenAt: at(10), receivedAt: at(12), source: "stream" });
    store.insertUtterance({ beeUtteranceId: 2, conversationKey: key, text: "far", spokenAt: at(100), receivedAt: at(102), source: "stream" });
    expect(store.utterancesNear(key, at(11), 3000).map((u) => u.text)).toEqual(["near"]);
    expect(store.lastSpokenAt(key)).toBe(at(100));
  });
});

describe("ideas", () => {
  const sample = (conversationKey: string) => ({
    title: "Whose turn to pay",
    pitch: "Tap who paid; see whose turn is next.",
    quote: "someone should build a tiny app",
    confidence: 0.9,
    conversationKey,
    detectorRunId: null,
  });

  it("starts as heard and keeps a timeline", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const idea = store.createIdea(sample(key), T0);
    expect(idea.id).toMatch(/^idea_20261009_[0-9a-f]{8}$/);
    expect(idea.state).toBe("heard");

    const asked = store.transitionIdea(idea.id, "asked", { todoId: 555, askedAt: at(5), askExpiresAt: at(3600) }, at(5));
    expect(asked).toMatchObject({ state: "asked", todoId: 555, askedAt: at(5) });
    const approved = store.transitionIdea(idea.id, "approved", { answeredAt: at(60), note: "ticked in Bee" }, at(60));
    expect(approved).toMatchObject({ state: "approved", todoId: 555, answeredAt: at(60), note: "ticked in Bee" });

    expect(store.ideaEvents(idea.id).map((event) => [event.fromState, event.toState])).toEqual([
      [null, "heard"],
      ["heard", "asked"],
      ["asked", "approved"],
    ]);
    expect(store.findIdeaByTodoId(555)?.id).toBe(idea.id);
  });

  it("refuses a state change the state machine does not allow, and changes nothing", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const idea = store.createIdea(sample(key), T0);
    expect(() => store.transitionIdea(idea.id, "building", {}, at(1))).toThrow(InvalidTransitionError);
    expect(store.getIdea(idea.id)?.state).toBe("heard");
    expect(store.ideaEvents(idea.id)).toHaveLength(1);
  });

  it("counts asks inside a time range and lists ideas by state", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const one = store.createIdea(sample(key), T0);
    const two = store.createIdea({ ...sample(key), title: "Plant watering tracker" }, at(10));
    store.transitionIdea(one.id, "asked", { todoId: 1 }, at(20));
    expect(store.countAsksBetween(T0, at(100))).toBe(1);
    expect(store.countAsksBetween(at(21), at(100))).toBe(0);
    expect(store.listIdeas({ states: ["heard"] }).map((idea) => idea.id)).toEqual([two.id]);
    expect(store.recentIdeaTitles(T0)).toEqual(["Plant watering tracker", "Whose turn to pay"]);
    expect(store.countIdeasByState()).toEqual({ asked: 1, heard: 1 });
  });
});

describe("small values", () => {
  it("stores the pause flag and falls back to the default", () => {
    expect(store.isPaused(false)).toBe(false);
    expect(store.isPaused(true)).toBe(true);
    store.setPaused(true, T0);
    expect(store.isPaused(false)).toBe(true);
    store.setPaused(false, at(1));
    expect(store.isPaused(true)).toBe(false);
  });

  it("stores and replaces a value", () => {
    expect(store.getValue("cursor")).toBeNull();
    store.setValue("cursor", "v1-1", T0);
    store.setValue("cursor", "v1-2", at(1));
    expect(store.getValue("cursor")).toBe("v1-2");
  });
});

describe("database upgrades", () => {
  it("brings an older database up to date and keeps its data", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { default: Database } = await import("better-sqlite3");
    const dir = mkdtempSync(path.join(tmpdir(), "overnight-store-"));
    try {
      const file = path.join(dir, "overnight.db");
      const first = new Store(file);
      const { key } = first.resolveConversation({ uuid: "u-1" }, T0);
      first.insertUtterance({ beeUtteranceId: 1, conversationKey: key, text: "kept", spokenAt: at(1), receivedAt: at(2), source: "stream" });
      first.close();

      // Put the file back the way the first version of the app wrote it.
      const raw = new Database(file);
      raw.exec("DROP INDEX utterances_by_spoken_at; DROP INDEX ideas_by_slug; DROP TABLE build_costs;");
      for (const column of ["slug", "build_backend", "build_started_at", "built_at", "published_url", "published_at", "delivered_at", "morning_todo_id", "fact_id", "failure_reason", "failure_notified_at"]) {
        raw.exec(`ALTER TABLE ideas DROP COLUMN ${column}`);
      }
      raw.pragma("user_version = 1");
      raw.close();

      const upgraded = new Store(file);
      expect(upgraded.utterancesSpokenNear(at(1), 1000).map((u) => u.text)).toEqual(["kept"]);
      upgraded.close();
      const check = new Database(file, { readonly: true });
      expect(check.pragma("user_version", { simple: true })).toBe(4);
      const plan = check.prepare("EXPLAIN QUERY PLAN SELECT * FROM utterances WHERE spoken_at BETWEEN ? AND ? ORDER BY spoken_at, id").all("a", "b") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain("utterances_by_spoken_at");
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("database upgrades: the ledger of build credits (version 4)", () => {
  const sample = { title: "Tip splitter", pitch: "Split a bill.", quote: "we should make a tip splitter", confidence: 0.9, detectorRunId: null };

  /** A database file in a scratch folder of its own, removed afterwards. */
  function withScratchFile(run: (file: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "overnight-store-"));
    try {
      run(path.join(dir, "overnight.db"));
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

  it("adds the ledger to a version 3 file and keeps everything that was in it", () => {
    withScratchFile((file) => {
      const first = new Store(file);
      const { key } = first.resolveConversation({ uuid: "u-1" }, T0);
      first.insertUtterance({ beeUtteranceId: 1, conversationKey: key, text: "kept", spokenAt: at(1), receivedAt: at(2), source: "stream" });
      const idea = first.createIdea({ ...sample, conversationKey: key }, T0);
      first.transitionIdea(idea.id, "asked", { todoId: 7 }, at(3));
      first.setValue("cursor", "v1-9", at(4));
      first.setPaused(false, at(5));
      first.close();
      backToVersion3(file);

      const before = new Database(file, { readonly: true });
      expect(before.pragma("user_version", { simple: true })).toBe(3);
      expect(before.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'build_costs%'").all()).toEqual([]);
      before.close();

      const upgraded = new Store(file);
      expect(upgraded.getIdea(idea.id)).toMatchObject({ state: "asked", todoId: 7, title: "Tip splitter" });
      expect(upgraded.ideaEvents(idea.id)).toHaveLength(2);
      expect(upgraded.pendingUtterances(key).map((u) => u.text)).toEqual(["kept"]);
      expect(upgraded.getValue("cursor")).toBe("v1-9");
      expect(upgraded.isPaused(true)).toBe(false);
      // The new table is there, empty, and works.
      expect(upgraded.buildCreditsBetween(T0, at(1000))).toEqual({ credits: 0, estimated: 0, tries: 0 });
      upgraded.recordBuildCost({ ideaId: idea.id, at: at(10), backend: "kiro-crew", credits: 2.5, measured: true });
      expect(upgraded.buildCreditsBetween(T0, at(1000))).toEqual({ credits: 2.5, estimated: 0, tries: 1 });
      upgraded.close();

      const check = new Database(file, { readonly: true });
      expect(check.pragma("user_version", { simple: true })).toBe(4);
      expect((check.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'build_costs%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["build_costs", "build_costs_by_time"]);
      check.close();

      // Opening it again changes nothing.
      const again = new Store(file);
      expect(again.buildCreditsBetween(T0, at(1000)).tries).toBe(1);
      again.close();
    });
  });

  it("upgrades while an older program has the file open, and that program carries on", () => {
    withScratchFile((file) => {
      const first = new Store(file);
      first.setValue("cursor", "v1-1", T0);
      first.close();
      backToVersion3(file);

      // The listener that is running: started before the upgrade, with its statements already made.
      const listener = new Database(file);
      listener.pragma("journal_mode = WAL");
      listener.pragma("foreign_keys = ON");
      const read = listener.prepare("SELECT value FROM kv WHERE key = ?");
      const write = listener.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
      expect(read.get("cursor")).toEqual({ value: "v1-1" });

      const upgraded = new Store(file);
      expect(upgraded.buildCreditsBetween(T0, at(1000)).tries).toBe(0);

      write.run("cursor", "v1-2", at(1));
      expect(read.get("cursor")).toEqual({ value: "v1-2" });
      expect(upgraded.getValue("cursor")).toBe("v1-2");
      upgraded.setValue("night.build.checkedAt", at(2), at(2));
      expect(read.get("night.build.checkedAt")).toEqual({ value: at(2) });
      listener.close();
      upgraded.close();
    });
  });

  it("opens a file that newer code has upgraded, and leaves its version alone", () => {
    // This is what keeps a step back safe: code that does not know a table still opens the file.
    withScratchFile((file) => {
      const first = new Store(file);
      first.setValue("cursor", "v1-1", T0);
      first.close();
      const raw = new Database(file);
      raw.exec("CREATE TABLE something_newer (id INTEGER PRIMARY KEY, note TEXT);");
      raw.pragma("user_version = 9");
      raw.close();

      const store = new Store(file);
      expect(store.getValue("cursor")).toBe("v1-1");
      store.setValue("cursor", "v1-2", at(1));
      store.close();
      const check = new Database(file, { readonly: true });
      expect(check.pragma("user_version", { simple: true })).toBe(9);
      expect(check.prepare("SELECT COUNT(*) AS n FROM something_newer").get()).toEqual({ n: 0 });
      check.close();
    });
  });
});

describe("what builds cost", () => {
  const sample = (conversationKey: string) => ({ title: "Tip splitter", pitch: "Split a bill.", quote: "we should make a tip splitter", confidence: 0.9, conversationKey, detectorRunId: null });
  const newIdea = () => store.createIdea(sample(store.resolveConversation({ uuid: "u-1" }, T0).key), T0);

  it("has an empty ledger in a new database", () => {
    expect(store.buildCreditsBetween(T0, at(1000))).toEqual({ credits: 0, estimated: 0, tries: 0 });
  });

  it("adds up the tries in a time range, start included and end excluded", () => {
    const idea = newIdea();
    store.recordBuildCost({ ideaId: idea.id, at: at(10), backend: "kiro-crew", credits: 3.25, measured: true });
    store.recordBuildCost({ ideaId: idea.id, at: at(20), backend: "kiro-cli", credits: 1.5, measured: false });
    store.recordBuildCost({ ideaId: idea.id, at: at(30), backend: "kiro-crew", credits: 0, measured: true });

    expect(store.buildCreditsBetween(T0, at(100))).toEqual({ credits: 4.75, estimated: 1.5, tries: 3 });
    expect(store.buildCreditsBetween(at(10), at(20))).toEqual({ credits: 3.25, estimated: 0, tries: 1 });
    expect(store.buildCreditsBetween(at(11), at(21))).toEqual({ credits: 1.5, estimated: 1.5, tries: 1 });
    expect(store.buildCreditsBetween(at(20), at(31))).toEqual({ credits: 1.5, estimated: 1.5, tries: 2 });
    expect(store.buildCreditsBetween(at(31), at(100))).toEqual({ credits: 0, estimated: 0, tries: 0 });
  });

  it("keeps sums to three decimals", () => {
    const idea = newIdea();
    // 0.1 added ten times is 0.9999999999999999 in a computer's arithmetic.
    for (let n = 0; n < 10; n += 1) store.recordBuildCost({ ideaId: idea.id, at: at(n), backend: "kiro-cli", credits: 0.1, measured: false });
    store.recordBuildCost({ ideaId: idea.id, at: at(50), backend: "kiro-crew", credits: 2.71828, measured: true });
    expect(store.buildCreditsBetween(T0, at(100))).toEqual({ credits: 3.718, estimated: 1, tries: 11 });
  });

  it("refuses a try for an idea that does not exist", () => {
    expect(() => store.recordBuildCost({ ideaId: "idea_missing", at: at(1), backend: "kiro-crew", credits: 1, measured: true })).toThrow();
    expect(store.buildCreditsBetween(T0, at(100)).tries).toBe(0);
  });

  it("refuses a figure or a time that would spoil the sums", () => {
    const idea = newIdea();
    const cost = { ideaId: idea.id, at: at(1), backend: "kiro-crew", measured: true };
    for (const credits of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => store.recordBuildCost({ ...cost, credits }), String(credits)).toThrow("credits");
    }
    for (const when of ["", "yesterday", "2026-10-12 07:00", "2026-10-12T07:00:00Z", "2026-10-12T01:00:00.000-06:00"]) {
      expect(() => store.recordBuildCost({ ...cost, at: when, credits: 1 }), when).toThrow("UTC time");
    }
    expect(store.buildCreditsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").tries).toBe(0);
  });

  it("refuses a figure no build could have used: more than the highest limit a month can be given", () => {
    const idea = newIdea();
    const cost = { ideaId: idea.id, at: at(1), backend: "kiro-crew", measured: true };
    expect(HIGHEST_BUILD_CREDIT_LIMIT).toBe(100_000);
    // The measured figure comes from a file a build job can write. One such row would close the
    // month, with no allowed setting left that opens it again.
    for (const credits of [100_000.001, 5e15, 1e306, Number.MAX_VALUE]) {
      expect(() => store.recordBuildCost({ ...cost, credits }), String(credits)).toThrow("One build cannot have used more than 100000 credits.");
    }
    expect(store.buildCreditsBetween(T0, at(100))).toEqual({ credits: 0, estimated: 0, tries: 0 });

    // Exactly the highest limit is still a figure.
    store.recordBuildCost({ ...cost, credits: 100_000 });
    store.recordBuildCost({ ...cost, at: at(2), credits: 100_000, measured: false });
    const total = store.buildCreditsBetween(T0, at(100));
    expect(total).toEqual({ credits: 200_000, estimated: 100_000, tries: 2 });
    // Every sum can be printed: none of them is "Infinity", or null in `status --json`.
    const budget = buildBudget(store, { maxBuildCreditsPerMonth: 100_000, timeZone: "America/Boise" }, new Date(T0));
    expect(JSON.parse(JSON.stringify(budget))).toMatchObject({ counted: 200_000, limit: 100_000, reached: true });
    expect(budgetReachedText(budget, "America/Boise")).toBe("this month's build credits are used up (200000 of 100000 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
  });
});

describe("building and publishing", () => {
  const sample = (conversationKey: string) => ({ title: "Tip splitter", pitch: "Split a bill.", quote: "we should make a tip splitter", confidence: 0.9, conversationKey, detectorRunId: null });

  it("records each step from approved to delivered", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const idea = store.createIdea(sample(key), T0);
    expect(idea).toMatchObject({ slug: null, buildBackend: null, publishedUrl: null, failureReason: null });
    store.transitionIdea(idea.id, "asked", { todoId: 7 }, at(1));
    store.transitionIdea(idea.id, "approved", { answeredAt: at(2) }, at(2));
    store.transitionIdea(idea.id, "building", { slug: "tip-splitter", buildBackend: "kiro-crew", buildStartedAt: at(3) }, at(3));
    store.transitionIdea(idea.id, "built", { builtAt: at(200) }, at(200));
    store.transitionIdea(idea.id, "published", { publishedUrl: "https://example.test/tip-splitter/", publishedAt: at(300) }, at(300));
    const delivered = store.transitionIdea(idea.id, "delivered", { deliveredAt: at(400), morningTodoId: 99 }, at(400));
    expect(delivered).toMatchObject({
      state: "delivered",
      slug: "tip-splitter",
      buildBackend: "kiro-crew",
      builtAt: at(200),
      publishedUrl: "https://example.test/tip-splitter/",
      morningTodoId: 99,
      todoId: 7,
    });
    expect(store.findIdeaBySlug("tip-splitter")?.id).toBe(idea.id);
    expect(store.countBuildsStartedBetween(T0, at(100))).toBe(1);
    expect(store.countBuildsStartedBetween(at(4), at(100))).toBe(0);
  });

  it("counts how many times one idea's build was started", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const idea = store.createIdea(sample(key), T0);
    const other = store.createIdea({ ...sample(key), title: "Other" }, T0);
    expect(store.countBuildStarts(idea.id)).toBe(0);
    for (const one of [idea, other]) {
      store.transitionIdea(one.id, "asked", {}, at(1));
      store.transitionIdea(one.id, "approved", {}, at(2));
      store.transitionIdea(one.id, "building", {}, at(3));
    }
    store.transitionIdea(idea.id, "build_failed", { failureReason: "the build was stopped" }, at(4));
    expect(store.countBuildStarts(idea.id)).toBe(1);
    store.transitionIdea(idea.id, "building", {}, at(5));
    expect(store.countBuildStarts(idea.id)).toBe(2);
    expect(store.countBuildStarts(other.id)).toBe(1);
  });

  it("updates facts about an idea without changing its state, and keeps slugs unique", () => {
    const { key } = store.resolveConversation({ uuid: "u-1" }, T0);
    const one = store.createIdea(sample(key), T0);
    const two = store.createIdea({ ...sample(key), title: "Another" }, at(1));
    const updated = store.updateIdea(one.id, { slug: "tip-splitter", failureReason: "the build timed out", factId: 5 }, at(2));
    expect(updated).toMatchObject({ state: "heard", slug: "tip-splitter", failureReason: "the build timed out", factId: 5 });
    expect(store.ideaEvents(one.id)).toHaveLength(1);
    expect(() => store.updateIdea(two.id, { slug: "tip-splitter" }, at(3))).toThrow();
    expect(() => store.updateIdea("idea_missing", { slug: "x" }, at(3))).toThrow("No idea");
    // Clearing a field is different from leaving it out.
    expect(store.updateIdea(one.id, { failureReason: null }, at(4)).failureReason).toBeNull();
    expect(store.getIdea(one.id)?.slug).toBe("tip-splitter");
  });
});
