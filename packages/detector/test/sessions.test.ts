// All text in this file is made up for the tests. None of it is Bee data or a real Kiro chat.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneSavedSessions, savedSessionsDir, SESSION_MAX_AGE_MS } from "../src/sessions.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 2, 1, 12, 0, 0);

let kiroHome: string;
beforeEach(() => {
  kiroHome = mkdtempSync(path.join(tmpdir(), "overnight-sessions-test-"));
});
afterEach(() => {
  rmSync(kiroHome, { recursive: true, force: true });
});

function fileAged(dir: string, name: string, ageMs: number): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "an invented saved chat");
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
  return file;
}

describe("pruneSavedSessions", () => {
  it("looks where Kiro CLI keeps saved chats, and keeps them for a day", () => {
    expect(savedSessionsDir("/somewhere/kiro-home")).toBe("/somewhere/kiro-home/sessions/cli");
    expect(SESSION_MAX_AGE_MS).toBe(24 * HOUR_MS);
  });

  it("deletes files last written more than a day ago and keeps the rest", async () => {
    const dir = savedSessionsDir(kiroHome);
    const old = [fileAged(dir, "a.json", 24 * HOUR_MS + 1000), fileAged(dir, "a.jsonl", 30 * HOUR_MS), fileAged(dir, "b.json", 400 * HOUR_MS)];
    const kept = [fileAged(dir, "c.json", 24 * HOUR_MS - 1000), fileAged(dir, "c.jsonl", 0)];

    expect(await pruneSavedSessions(kiroHome, NOW)).toBe(3);
    expect(old.map((file) => existsSync(file))).toEqual([false, false, false]);
    expect(kept.map((file) => existsSync(file))).toEqual([true, true]);
    // Nothing left to do the second time.
    expect(await pruneSavedSessions(kiroHome, NOW)).toBe(0);
  });

  it("touches only plain files directly in the sessions folder", async () => {
    const dir = savedSessionsDir(kiroHome);
    const inSubfolder = fileAged(path.join(dir, "kept-folder"), "old.json", 100 * HOUR_MS);
    const nextDoor = fileAged(path.join(kiroHome, "sessions", "other"), "old.json", 100 * HOUR_MS);
    const settings = fileAged(path.join(kiroHome, "settings"), "cli.json", 100 * HOUR_MS);
    const linkTarget = fileAged(kiroHome, "linked-to.json", 100 * HOUR_MS);
    symlinkSync(linkTarget, path.join(dir, "a-link.json"));

    expect(await pruneSavedSessions(kiroHome, NOW)).toBe(0);
    for (const file of [inSubfolder, nextDoor, settings, linkTarget, path.join(dir, "a-link.json")]) expect(existsSync(file)).toBe(true);
  });

  it("does nothing, quietly, when there is no sessions folder yet", async () => {
    expect(await pruneSavedSessions(kiroHome, NOW)).toBe(0);
    expect(await pruneSavedSessions(path.join(kiroHome, "no-such-home"), NOW)).toBe(0);
  });

  it("takes a shorter keeping time when given one", async () => {
    const file = fileAged(savedSessionsDir(kiroHome), "a.json", 2 * HOUR_MS);
    expect(await pruneSavedSessions(kiroHome, NOW, 3 * HOUR_MS)).toBe(0);
    expect(await pruneSavedSessions(kiroHome, NOW, HOUR_MS)).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});
