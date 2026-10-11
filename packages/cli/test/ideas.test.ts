// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { BUILD_INTERRUPTED_REASON, BUILD_STOPPED_REASON, Store } from "@overnight/core";
import type { Idea } from "@overnight/core";
import { buildLines, ideas, REHEARSAL_MARK, SECOND_TRY_LINE } from "../src/commands/ideas.ts";
import { REHEARSAL_CONVERSATION_KEY } from "../src/commands/rehearse.ts";
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

  it("shows the slug and the link once an idea is published, under its own line", () => {
    const store = new Store(":memory:");
    const idea = moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, at(-3 * HOUR)), ["asked", "approved"], at(-3 * HOUR + 60));
    const url = "https://example.invalid/apps/whose-turn-to-pay/";

    // Being built: the slug is known, there is no link yet.
    store.transitionIdea(idea.id, "building", { slug: "whose-turn-to-pay", buildBackend: "kiro-crew" }, at(-2 * HOUR));
    const building = capture();
    ideas({ store, config, write: building.write, now: fixedNow() });
    expect(building.lines).toEqual(["1 idea today:", `  ${idea.id}  building        Oct 9, 9:00 AM  Whose turn to pay`, "      slug    whose-turn-to-pay"]);

    store.transitionIdea(idea.id, "built", {}, at(-2 * HOUR + 150));
    store.transitionIdea(idea.id, "published", { publishedUrl: url, publishedAt: at(-HOUR) }, at(-HOUR));
    store.transitionIdea(idea.id, "delivered", { deliveredAt: at(-HOUR + 5) }, at(-HOUR + 5));
    const delivered = capture();
    ideas({ store, config, write: delivered.write, now: fixedNow() });
    expect(delivered.lines).toEqual(["1 idea today:", `  ${idea.id}  delivered       Oct 9, 9:00 AM  Whose turn to pay`, "      slug    whose-turn-to-pay", `      link    ${url}`]);

    // The same facts are in the JSON form, under the store's own names.
    const json = capture();
    ideas({ store, config, write: json.write, now: fixedNow() }, { json: true });
    expect((JSON.parse(json.text()) as Array<Record<string, unknown>>)[0]).toMatchObject({ slug: "whose-turn-to-pay", publishedUrl: url, failureReason: null });
  });

  it("shows why a build or a publish failed, for as long as that is where the idea stands", () => {
    const store = new Store(":memory:");
    const failedBuild = moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, at(-3 * HOUR)), ["asked", "approved", "building"], at(-3 * HOUR + 60));
    store.transitionIdea(failedBuild.id, "build_failed", { slug: "whose-turn-to-pay", failureReason: "the build ran out of time on both builders" }, at(-2 * HOUR));
    const failedPublish = moveIdea(store, addIdea(store, SAMPLE_IDEAS.plants, at(-3 * HOUR + 1)), ["asked", "approved", "building", "built"], at(-3 * HOUR + 61));
    store.transitionIdea(failedPublish.id, "publish_failed", { slug: "plant-watering-tracker", failureReason: "the smoke test\nfailed in the browser\u001b[2J" }, at(-2 * HOUR + 1));
    // No reason on record: say that, so the line is never just missing.
    const noReason = moveIdea(store, addIdea(store, SAMPLE_IDEAS.chores, at(-3 * HOUR + 2)), ["asked", "approved", "building", "build_failed"], at(-3 * HOUR + 62));

    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toEqual([
      "3 ideas today:",
      `  ${failedBuild.id}  build_failed    Oct 9, 9:00 AM  Whose turn to pay`,
      "      slug    whose-turn-to-pay",
      "      failed  the build ran out of time on both builders",
      `  ${failedPublish.id}  publish_failed  Oct 9, 9:00 AM  Plant watering tracker`,
      "      slug    plant-watering-tracker",
      "      failed  the smoke test failed in the browser [2J",
      `  ${noReason.id}  build_failed    Oct 9, 9:00 AM  Chore wheel`,
      "      failed  no reason was recorded",
    ]);

    // Tried again and built: the old reason is still on the idea, but it is no longer the news.
    store.transitionIdea(failedBuild.id, "building", {}, at(-HOUR));
    store.transitionIdea(failedBuild.id, "built", {}, at(-HOUR + 100));
    expect(store.getIdea(failedBuild.id)?.failureReason).toBe("the build ran out of time on both builders");
    expect(buildLines(store.getIdea(failedBuild.id) as Idea)).toEqual(["      slug    whose-turn-to-pay"]);
  });

  it("says in plain words that an idea whose build was cut short will be tried again, and stops saying so when it will not", () => {
    const store = new Store(":memory:");
    const approved = (sample: (typeof SAMPLE_IDEAS)[keyof typeof SAMPLE_IDEAS], offset: number) => moveIdea(store, addIdea(store, sample, at(-3 * HOUR + offset)), ["asked", "approved"], at(-3 * HOUR + 60 + offset));
    const cutShort = (id: string, reason: string, when: number) => {
      store.transitionIdea(id, "building", { slug: null, buildStartedAt: at(when) }, at(when));
      store.transitionIdea(id, "build_failed", { failureReason: reason }, at(when + 30));
    };
    const stopped = approved(SAMPLE_IDEAS.turns, 0);
    cutShort(stopped.id, BUILD_STOPPED_REASON, -2 * HOUR);
    const interrupted = approved(SAMPLE_IDEAS.plants, 1);
    cutShort(interrupted.id, BUILD_INTERRUPTED_REASON, -2 * HOUR + 100);
    // A build that failed for a reason of its own is never tried again by itself.
    const failed = approved(SAMPLE_IDEAS.chores, 2);
    cutShort(failed.id, "the build ran out of time on both builders", -2 * HOUR + 200);

    const listing = () => {
      const out = capture();
      ideas({ store, config, write: out.write, now: fixedNow() });
      return out.lines;
    };
    expect(SECOND_TRY_LINE).toBe("its build was cut off, not failed: it will be built once more at the next nightly build, and nobody has been told yet");
    expect(listing()).toEqual([
      "3 ideas today:",
      `  ${stopped.id}  build_failed    Oct 9, 9:00 AM  Whose turn to pay`,
      "      failed  the build was stopped",
      `      next    ${SECOND_TRY_LINE}`,
      `  ${interrupted.id}  build_failed    Oct 9, 9:00 AM  Plant watering tracker`,
      "      failed  the build was interrupted",
      `      next    ${SECOND_TRY_LINE}`,
      `  ${failed.id}  build_failed    Oct 9, 9:00 AM  Chore wheel`,
      "      failed  the build ran out of time on both builders",
    ]);

    // Cut short a second time: it has had both of its starts, so nothing more is promised.
    cutShort(stopped.id, BUILD_STOPPED_REASON, -HOUR);
    // And once the wearer has been told, it is over as well.
    store.updateIdea(interrupted.id, { failureNotifiedAt: at(-60) }, at(-60));
    expect(listing().filter((line) => line.includes("next"))).toEqual([]);

    // The JSON form is the store's own, unchanged: a program applies core's rule itself.
    const json = capture();
    ideas({ store, config, write: json.write, now: fixedNow() }, { json: true });
    expect(Object.keys((JSON.parse(json.text()) as Array<Record<string, unknown>>)[0] ?? {})).not.toContain("next");
  });

  it("marks an idea made by a rehearsal, whatever its note says by now", () => {
    const store = new Store(":memory:");
    const invented = store.createIdea({ title: "Zebra dice", pitch: "Rolls dice.", quote: "", confidence: 1, conversationKey: REHEARSAL_CONVERSATION_KEY, detectorRunId: null, note: "rehearsal: an invented idea" }, at(-HOUR));
    const heard = addIdea(store, SAMPLE_IDEAS.turns, at(-HOUR + 1));
    // The builder writes its own note over the first one.
    store.setIdeaNote(invented.id, "built with Kiro Crew in 142 s", at(-60));
    const out = capture();
    ideas({ store, config, write: out.write, now: fixedNow() });
    expect(REHEARSAL_MARK).toBe("[rehearsal]");
    expect(out.lines).toEqual(["2 ideas today:", `  ${invented.id}  heard           Oct 9, 11:00 AM  [rehearsal] Zebra dice  (built with Kiro Crew in 142 s)`, `  ${heard.id}  heard           Oct 9, 11:00 AM  Whose turn to pay`]);
  });

  it("adds nothing under an idea that has not been through a build", () => {
    const { store, late } = seeded();
    expect(buildLines(store.getIdea(late.id) as Idea)).toEqual([]);
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
