// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { countWords, isSimilarText, normaliseText, tidyTitle, toIsoOrNull, tokenSetSimilarity } from "../src/text.ts";

describe("text helpers", () => {
  it("counts words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("  one   two\nthree ")).toBe(3);
  });

  it("normalises case, punctuation and spacing", () => {
    expect(normaliseText("Well,  that's IT!")).toBe("well thats it");
    expect(normaliseText("…")).toBe("");
    expect(normaliseText("Café №5 — open?")).toBe("café 5 open");
  });

  it("measures how many words two lines share", () => {
    expect(tokenSetSimilarity("the red bike", "The red bike.")).toBe(1);
    expect(tokenSetSimilarity("the red bike", "a blue car")).toBe(0);
    // Four words shared, six different words in all.
    expect(tokenSetSimilarity("we could split the bill", "we should split the bill")).toBeCloseTo(4 / 6);
    expect(tokenSetSimilarity("", "")).toBe(1);
    expect(tokenSetSimilarity("", "something")).toBe(0);
  });

  it("treats lines as the same when they read alike", () => {
    expect(isSimilarText("Let's meet at noon.", "lets meet at noon", 0.8)).toBe(true);
    // One word different out of ten: a transcription difference, not a new line.
    expect(isSimilarText("i think the garden needs water again by friday morning", "i think the garden needs water again by friday evening", 0.8)).toBe(true);
    expect(isSimilarText("yeah", "yeah okay", 0.8)).toBe(false);
    expect(isSimilarText("let's meet at noon", "the garden needs water", 0.8)).toBe(false);
  });

  it("keeps a title on one short line", () => {
    expect(tidyTitle("  Whose turn\n to   pay ")).toBe("Whose turn to pay");
    const long = tidyTitle("word ".repeat(40));
    expect([...long].length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes every time the same way, or says it is not a time", () => {
    expect(toIsoOrNull("2026-10-09T20:00:05Z")).toBe("2026-10-09T20:00:05.000Z");
    expect(toIsoOrNull("2026-10-09T14:00:05-06:00")).toBe("2026-10-09T20:00:05.000Z");
    expect(toIsoOrNull("yesterday-ish")).toBeNull();
  });
});
