// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { isSlug, slugFor } from "../src/index.ts";

const free = () => false;

describe("slugFor", () => {
  it("makes a lowercase, dashed name from a title", () => {
    expect(slugFor("Coin Flipper", free)).toBe("coin-flipper");
    expect(slugFor("  Whose Turn to Pay?!  ", free)).toBe("whose-turn-to-pay");
    expect(slugFor("Tip_Splitter 2.0", free)).toBe("tip-splitter-2-0");
  });

  it("drops accents and anything that is not a letter or a digit", () => {
    expect(slugFor("Café Münü — déjà vu", free)).toBe("cafe-munu-deja-vu");
    expect(slugFor("Rock 🪨 Paper 📄 Scissors", free)).toBe("rock-paper-scissors");
    expect(slugFor("../../etc/passwd", free)).toBe("etc-passwd");
  });

  it("is never empty: a title with no letters or digits becomes \"app\"", () => {
    expect(slugFor("", free)).toBe("app");
    expect(slugFor("   ", free)).toBe("app");
    expect(slugFor("🪙🪙🪙", free)).toBe("app");
    expect(slugFor("---", free)).toBe("app");
  });

  it("is at least 3 characters: a very short name goes behind \"app-\"", () => {
    expect(slugFor("Qi", free)).toBe("app-qi");
    expect(slugFor("X", free)).toBe("app-x");
    expect(slugFor("abc", free)).toBe("abc");
  });

  it("is at most 40 characters and never ends in a dash", () => {
    const long = slugFor("The Extremely Long Winded Name Of A Very Small Application Indeed", free);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe("the-extremely-long-winded-name-of-a-very");
    // Cut exactly where a dash would be left hanging.
    expect(slugFor("a".repeat(39) + " b", free)).toBe("a".repeat(39));
  });

  it("adds -2, -3, ... until the name is free", () => {
    const taken = new Set(["coin-flipper", "coin-flipper-2"]);
    expect(slugFor("Coin Flipper", (slug) => taken.has(slug))).toBe("coin-flipper-3");
  });

  it("shortens a long name to make room for the number", () => {
    const base = "a".repeat(40);
    const second = slugFor(base, (slug) => slug === base);
    expect(second).toBe(`${"a".repeat(38)}-2`);
    expect(second.length).toBe(40);
  });

  it("makes the fallback unique too", () => {
    const taken = new Set(["app", "app-2"]);
    expect(slugFor("???", (slug) => taken.has(slug))).toBe("app-3");
  });

  it("always answers with a well-formed slug", () => {
    for (const title of ["Coin Flipper", "", "Qi", "Ünïcödé Ål Thë Wäy", "a--b__c", "-lead and trail-", "x".repeat(200), "12 34"]) {
      const slug = slugFor(title, free);
      expect(isSlug(slug), `${JSON.stringify(title)} gave ${slug}`).toBe(true);
    }
  });

  it("gives up instead of looping forever when every name is taken", () => {
    expect(() => slugFor("Coin Flipper", () => true)).toThrow(/free name/);
  });
});

describe("isSlug", () => {
  it("accepts only lowercase letters, digits and single inner dashes, 3 to 40 long", () => {
    expect(isSlug("coin-flipper")).toBe(true);
    expect(isSlug("ab")).toBe(false);
    expect(isSlug("Coin")).toBe(false);
    expect(isSlug("coin--flipper")).toBe(false);
    expect(isSlug("-coin")).toBe(false);
    expect(isSlug("coin/..")).toBe(false);
    expect(isSlug("a".repeat(41))).toBe(false);
  });
});
