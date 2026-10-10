// All text in this file is made up for the tests. None of it is Bee data.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtures, parseFixture } from "../src/fixtures.ts";
import { buildPrompt } from "../src/prompt.ts";
import { countWords } from "../src/schema.ts";
import { formatConfusion, formatRatio, score } from "../src/metrics.ts";
import type { Outcome } from "../src/metrics.ts";

const HEADER = "# SYNTHETIC transcript, written by hand for tests. Not a real conversation and not Bee data.";

describe("parseFixture", () => {
  it("reads the expectation and the utterance lines", () => {
    const text = [HEADER, "# expect: idea", "# a comment that is ignored", "", "[12:14:02] Who paid last time?", "[12:14:15] Someone should build a page for that."].join("\n") + "\n";
    expect(parseFixture("idea-example.txt", text)).toEqual({
      ok: true,
      file: "idea-example.txt",
      fixture: {
        file: "idea-example.txt",
        expect: "idea",
        utterances: [
          { text: "Who paid last time?", spokenAt: "2026-01-01T12:14:02.000Z" },
          { text: "Someone should build a page for that.", spokenAt: "2026-01-01T12:14:15.000Z" },
        ],
      },
    });
  });

  it("ignores every # line except the expectation: the note that gives the answer away never reaches the detector", () => {
    const text = [
      HEADER,
      "# expect: not_idea",
      "# category: joke",
      "# note: This one is a JOKE about a cat translator, so the answer is not_idea.",
      "[10:00:00] Someone should build a cat translator.",
      "#note: no space after the hash",
      "   # note: indented, and between two utterances",
      "# expect:",
      "# expected: idea",
      "#",
      "[10:00:04] It would only ever say feed me.",
      "# note: after the last utterance",
    ].join("\n");
    const parsed = parseFixture("x.txt", text);
    expect(parsed).toMatchObject({ ok: true, fixture: { expect: "not_idea" } });
    if (!parsed.ok) return;
    expect(parsed.fixture.utterances.map((utterance) => utterance.text)).toEqual(["Someone should build a cat translator.", "It would only ever say feed me."]);

    // Nothing from the header or the comments is in what Kiro would be sent.
    const prompt = buildPrompt({ utterances: parsed.fixture.utterances, recentTitles: [] });
    for (const hidden of ["SYNTHETIC", "expect", "not_idea", "category", "JOKE", "note:", "no space after", "indented", "after the last"]) {
      expect(prompt).not.toContain(hidden);
    }
  });

  it("accepts not_idea and Windows line ends", () => {
    const parsed = parseFixture("x.txt", [HEADER, "# expect: not_idea", "[09:15:03] I need to buy coffee filters."].join("\r\n"));
    expect(parsed.ok && parsed.fixture.expect).toBe("not_idea");
  });

  it("rolls over to the next day when the clock passes midnight", () => {
    const parsed = parseFixture("x.txt", [HEADER, "# expect: not_idea", "[23:59:58] Late one.", "[00:00:03] Even later."].join("\n"));
    expect(parsed.ok && parsed.fixture.utterances.map((utterance) => utterance.spokenAt)).toEqual(["2026-01-01T23:59:58.000Z", "2026-01-02T00:00:03.000Z"]);
  });

  it("refuses a file whose first line does not say SYNTHETIC", () => {
    const refused = "refused: the first line does not say SYNTHETIC";
    expect(parseFixture("x.txt", "# expect: idea\n[10:00:00] Hello.")).toEqual({ ok: false, file: "x.txt", problem: refused });
    expect(parseFixture("x.txt", "[10:00:00] SYNTHETIC is only a word here.\n# expect: idea")).toMatchObject({ ok: false, problem: refused });
    expect(parseFixture("x.txt", "# synthetic\n# expect: idea\n[10:00:00] Hello.")).toMatchObject({ ok: false, problem: refused });
    expect(parseFixture("x.txt", "")).toMatchObject({ ok: false, problem: refused });
  });

  it("names the line, not its text, when the format is wrong", () => {
    expect(parseFixture("x.txt", [HEADER, "[10:00:00] Hello."].join("\n"))).toMatchObject({ ok: false, problem: 'no "# expect: idea" or "# expect: not_idea" line' });
    expect(parseFixture("x.txt", [HEADER, "# expect: idea"].join("\n"))).toMatchObject({ ok: false, problem: "no utterance lines" });
    expect(parseFixture("x.txt", [HEADER, "# expect: maybe", "[10:00:00] Hello."].join("\n"))).toMatchObject({ ok: false, problem: 'line 2: expect must be "idea" or "not_idea"' });
    expect(parseFixture("x.txt", [HEADER, "# expect: idea", "# expect: not_idea", "[10:00:00] Hello."].join("\n"))).toMatchObject({ ok: false, problem: 'line 3: a second "# expect:" line' });
    for (const badLine of ["Hello with no time.", "[25:00:00] Not a real hour.", "[10:00] No seconds.", "[10:00:00]"]) {
      const parsed = parseFixture("x.txt", [HEADER, "# expect: idea", badLine].join("\n"));
      expect(parsed).toEqual({ ok: false, file: "x.txt", problem: 'line 3: not a "[HH:MM:SS] text" line' });
    }
  });
});

describe("loadFixtures", () => {
  it("reads every .txt file in name order and keeps going past a bad one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "overnight-fixtures-test-"));
    try {
      writeFileSync(path.join(dir, "b-not-idea.txt"), [HEADER, "# expect: not_idea", "[10:00:00] Nice weather."].join("\n"));
      writeFileSync(path.join(dir, "a-idea.txt"), [HEADER, "# expect: idea", "[10:00:00] I wish there was a page for bin day."].join("\n"));
      writeFileSync(path.join(dir, "c-unmarked.txt"), "[10:00:00] No header at all.");
      writeFileSync(path.join(dir, "notes.md"), "not a fixture");
      const loaded = loadFixtures(dir);
      expect(loaded.map((item) => [item.file, item.ok])).toEqual([
        ["a-idea.txt", true],
        ["b-not-idea.txt", true],
        ["c-unmarked.txt", false],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const goldenSet = fileURLToPath(new URL("../../../fixtures/detector/", import.meta.url));

  it("can read the repo's own golden set: every file is marked synthetic and well formed", () => {
    const loaded = loadFixtures(goldenSet);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((item) => !item.ok)).toEqual([]);
  });

  it("keeps none of the golden set's header lines in what the detector is shown", () => {
    for (const item of loadFixtures(goldenSet)) {
      if (!item.ok) continue;
      for (const utterance of item.fixture.utterances) {
        expect(utterance.text.startsWith("#")).toBe(false);
        expect(utterance.text).not.toMatch(/SYNTHETIC|# ?(expect|category|note):/);
      }
    }
  });

  it("has short ideas in the golden set: a whole idea of 6 to 10 words in one or two lines", () => {
    const short = loadFixtures(goldenSet).filter((item) => item.file.startsWith("idea-short-"));
    expect(short.length).toBeGreaterThanOrEqual(2);
    for (const item of short) {
      expect(item).toMatchObject({ ok: true, fixture: { expect: "idea" } });
      if (!item.ok) continue;
      const { utterances } = item.fixture;
      const wordCount = countWords(utterances.map((utterance) => utterance.text).join(" "));
      expect(utterances.length).toBeLessThanOrEqual(2);
      expect(wordCount).toBeGreaterThanOrEqual(6);
      expect(wordCount).toBeLessThanOrEqual(10);
    }
  });
});

describe("score", () => {
  const outcomes = (truePositive: number, falsePositive: number, falseNegative: number, trueNegative: number): Outcome[] => [
    ...Array.from({ length: truePositive }, (): Outcome => ({ expect: "idea", asked: true })),
    ...Array.from({ length: falsePositive }, (): Outcome => ({ expect: "not_idea", asked: true })),
    ...Array.from({ length: falseNegative }, (): Outcome => ({ expect: "idea", asked: false })),
    ...Array.from({ length: trueNegative }, (): Outcome => ({ expect: "not_idea", asked: false })),
  ];

  it("counts the four boxes and works out precision and recall", () => {
    const result = score(outcomes(12, 2, 3, 23));
    expect(result.confusion).toEqual({ truePositive: 12, falsePositive: 2, falseNegative: 3, trueNegative: 23 });
    expect(result.precision).toBeCloseTo(12 / 14);
    expect(result.recall).toBeCloseTo(12 / 15);
    expect(result.pass).toBe(true);
  });

  it("fails when precision is under 0.85 or recall is under 0.7", () => {
    expect(score(outcomes(10, 2, 0, 28)).pass).toBe(false); // precision 0.83
    expect(score(outcomes(10, 0, 5, 25)).pass).toBe(false); // recall 0.67
    expect(score(outcomes(17, 3, 0, 20)).pass).toBe(true); // precision exactly 0.85
    expect(score(outcomes(7, 0, 3, 30)).pass).toBe(true); // recall exactly 0.7
  });

  it("does not pass a set that cannot measure both numbers", () => {
    expect(score(outcomes(0, 0, 0, 10))).toMatchObject({ precision: null, recall: null, pass: false });
    expect(score(outcomes(0, 0, 4, 10))).toMatchObject({ precision: null, recall: 0, pass: false });
    expect(score([])).toMatchObject({ pass: false });
  });

  it("prints the matrix and the ratios", () => {
    const lines = formatConfusion({ truePositive: 12, falsePositive: 2, falseNegative: 3, trueNegative: 23 }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/expected idea\s+expected not_idea$/);
    expect(lines[1]).toMatch(/^would ask\s+12\s+2$/);
    expect(lines[2]).toMatch(/^would not ask\s+3\s+23$/);
    expect(formatRatio(0.857)).toBe("0.86");
    expect(formatRatio(null)).toBe("n/a");
  });
});
