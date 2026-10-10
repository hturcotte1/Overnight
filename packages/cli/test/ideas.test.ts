// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { Store } from "@overnight/core";
import { ideas } from "../src/commands/ideas.ts";
import { oneLine } from "../src/output.ts";
import { addIdea, at, capture, fixedNow, moveIdea, SAMPLE_IDEAS, testConfig } from "./helpers.ts";

const config = testConfig();
const HOUR = 3600;

function seeded() {
  const store = new Store(":memory:");
  // 11:30 pm the evening before in Boise: yesterday's idea.
  const yesterday = addIdea(store, SAMPLE_IDEAS.chores, at(-12.5 * HOUR));
  // Half past midnight and 11 am today.
  const early = addIdea(store, SAMPLE_IDEAS.plants, at(-11.5 * HOUR));
  const late = addIdea(store, SAMPLE_IDEAS.turns, at(-1 * HOUR));
  moveIdea(store, late, ["asked"], at(-1 * HOUR + 30));
  store.setIdeaNote(early.id, "over today's ask limit", at(-11 * HOUR));
  return { store, yesterday, early, late };
}

describe("overnight ideas", () => {
  it("says so when there are none", () => {
    const out = capture();
    expect(ideas({ store: new Store(":memory:"), config, write: out.write, now: fixedNow() })).toBe(0);
    expect(out.lines).toEqual(["No ideas today."]);
  });

  it("lists today's ideas, oldest first, with id, state, local time, title and note", () => {
    const { store, early, late } = seeded();
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toEqual([
      "2 ideas today:",
      `  ${early.id}  heard           Oct 9, 12:30 AM  Plant watering tracker  (over today's ask limit)`,
      `  ${late.id}  asked           Oct 9, 11:00 AM  Whose turn to pay`,
    ]);
  });

  it("never shows the quote or the pitch in the plain listing", () => {
    const { store } = seeded();
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() }, { all: true });
    for (const sample of Object.values(SAMPLE_IDEAS)) {
      expect(out.text()).not.toContain(sample.quote);
      expect(out.text()).not.toContain(sample.pitch);
    }
  });

  it("lists every idea with --all", () => {
    const { store, yesterday } = seeded();
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() }, { all: true });
    expect(out.lines[0]).toBe("3 ideas so far:");
    expect(out.lines[1]).toContain(yesterday.id);
    expect(out.lines[1]).toContain("Oct 8, 11:30 PM");
  });

  it("prints full records as JSON with --json", () => {
    const { store, early, late } = seeded();
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() }, { json: true });
    const parsed = JSON.parse(out.text()) as Array<Record<string, unknown>>;
    expect(parsed.map((idea) => idea.id)).toEqual([early.id, late.id]);
    expect(parsed[1]).toMatchObject({ state: "asked", ...SAMPLE_IDEAS.turns });
  });

  it("keeps a title or note with control characters on one line", () => {
    const store = new Store(":memory:");
    const idea = addIdea(store, { title: "Two\nlines\u001b[2J here", pitch: "p", quote: "q" }, at(-60));
    store.setIdeaNote(idea.id, "first\r\nsecond", at(-30));
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[1]).toContain("Two lines [2J here  (first second)");
  });

  it("strips the invisible Unicode characters that could reorder, hide or break a line", () => {
    const INVISIBLE = {
      lineSeparator: "\u2028",
      paragraphSeparator: "\u2029",
      rightToLeftOverride: "\u202e",
      popDirection: "\u202c",
      leftToRightIsolate: "\u2066",
      popIsolate: "\u2069",
      zeroWidthSpace: "\u200b",
      rightToLeftMark: "\u200f",
      wordJoiner: "\u2060",
      byteOrderMark: "\ufeff",
      softHyphen: "\u00ad",
      nextLine: "\u0085",
    };
    for (const [name, character] of Object.entries(INVISIBLE)) {
      expect(oneLine(`before${character}after`), name).toBe("before after");
    }
    expect(oneLine(`\u202eevil\u202c title\u2028second line\u200b`)).toBe("evil  title second line");
    // Ordinary text is left alone, accents, emoji and all.
    expect(oneLine("  Café ñandú 🌱 tracker — v2  ")).toBe("Café ñandú 🌱 tracker — v2");

    const store = new Store(":memory:");
    const idea = addIdea(store, { title: "Plant\u2028watering\u202e tracker", pitch: "p", quote: "q" }, at(-60));
    store.setIdeaNote(idea.id, "over\u2029the\u200blimit", at(-30));
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[1]).toContain("Plant watering  tracker  (over the limit)");
    expect(out.lines[1]).not.toMatch(/[\u2028\u2029\u202e\u200b]/);
  });
});
