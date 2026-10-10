// Reads the golden-set files in fixtures/detector/. Every one is a made-up conversation:
//
//   # SYNTHETIC transcript, written by hand for tests. ...     <- line 1 must say SYNTHETIC
//   # expect: idea                                             <- or "# expect: not_idea"
//   # any other "#" line is a comment
//   [12:14:02] One utterance per line.
//
// A file whose first line does not say SYNTHETIC is refused, so a real transcript saved here by
// mistake is never sent anywhere by the eval.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DetectorInput } from "@overnight/core";

export type Expectation = "idea" | "not_idea";

export interface Fixture {
  file: string;
  expect: Expectation;
  utterances: DetectorInput["utterances"];
}

export type FixtureResult = { ok: true; file: string; fixture: Fixture } | { ok: false; file: string; problem: string };

// Fixtures carry a clock time only. Any date will do; this one is plainly not a real recording.
const FIXTURE_DAY_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse one fixture. Problems name a line number, never the line's text. */
export function parseFixture(file: string, text: string): FixtureResult {
  const lines = text.split(/\r?\n/);
  const bad = (problem: string): FixtureResult => ({ ok: false, file, problem });
  const first = lines[0] ?? "";
  if (!first.startsWith("#") || !first.includes("SYNTHETIC")) return bad("refused: the first line does not say SYNTHETIC");

  let expect: Expectation | null = null;
  const utterances: Fixture["utterances"] = [];
  let dayOffset = 0;
  let previousSeconds = -1;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const match = /^#\s*expect:\s*(\S+)\s*$/.exec(line);
      if (!match) continue;
      if (match[1] !== "idea" && match[1] !== "not_idea") return bad(`line ${index + 1}: expect must be "idea" or "not_idea"`);
      if (expect !== null) return bad(`line ${index + 1}: a second "# expect:" line`);
      expect = match[1];
      continue;
    }
    const match = /^\[([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\]\s+(\S.*)$/.exec(line);
    if (!match) return bad(`line ${index + 1}: not a "[HH:MM:SS] text" line`);
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    // A clock that jumps backwards means the conversation ran past midnight.
    if (seconds < previousSeconds) dayOffset += 1;
    previousSeconds = seconds;
    utterances.push({ text: match[4]!, spokenAt: new Date(FIXTURE_DAY_MS + dayOffset * DAY_MS + seconds * 1000).toISOString() });
  }
  if (expect === null) return bad('no "# expect: idea" or "# expect: not_idea" line');
  if (utterances.length === 0) return bad("no utterance lines");
  return { ok: true, file, fixture: { file, expect, utterances } };
}

/** Every .txt file in the folder, in name order. A file that cannot be read comes back as a problem. */
export function loadFixtures(dir: string): FixtureResult[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort();
  return files.map((file) => {
    try {
      return parseFixture(file, readFileSync(path.join(dir, file), "utf8"));
    } catch {
      return { ok: false, file, problem: "could not be read" };
    }
  });
}
