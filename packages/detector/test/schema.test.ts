// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { CHAR_LIMITS, countWords, findJsonObjects, parseVerdict, quoteAppearsIn, shortenQuote } from "../src/index.ts";

const TRANSCRIPT = [
  "[19:00:02] We always forget whose turn it is to pick the board game.",
  "[19:00:09] Someone should build a little page that just picks the next person.",
  "[19:00:15] Yeah, and it remembers who went last.",
].join("\n");

const IDEA = {
  is_idea: true,
  confidence: 0.9,
  title: "Game night picker",
  pitch: "Picks whose turn it is to choose the board game and remembers who went last.",
  quote: "Someone should build a little page that just picks the next person.",
  said_by_wearer_guess: true,
  likely_media: false,
  buildable_as_static_web_app: true,
  reason: "A sincere wish for a small tool that one web page can do.",
};

const NOT_IDEA = { ...IDEA, is_idea: false, confidence: 0.95, title: "", pitch: "", quote: "", buildable_as_static_web_app: false, reason: "Only small talk." };

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
const reply = (value: unknown) => JSON.stringify(value);
const problemOf = (text: string, transcript: string = TRANSCRIPT) => {
  const parsed = parseVerdict(text, transcript);
  return parsed.ok ? null : parsed.problem;
};

describe("parseVerdict: finding the JSON", () => {
  it("accepts clean JSON", () => {
    expect(parseVerdict(reply(IDEA), TRANSCRIPT)).toEqual({ ok: true, verdict: IDEA });
  });

  it("accepts JSON inside a code fence", () => {
    const fenced = "```json\n" + JSON.stringify(IDEA, null, 2) + "\n```";
    expect(parseVerdict(fenced, TRANSCRIPT)).toEqual({ ok: true, verdict: IDEA });
  });

  it("accepts JSON with prose around it, even prose with braces in it", () => {
    const chatty = `Sure. Here is my {final} answer:\n${reply(IDEA)}\nLet me know if you need anything else {really}.`;
    expect(parseVerdict(chatty, TRANSCRIPT)).toEqual({ ok: true, verdict: IDEA });
  });

  it("picks the object that looks like a verdict", () => {
    const twoObjects = `An example of the format: {"example": true}\n${reply(IDEA)}`;
    expect(parseVerdict(twoObjects, TRANSCRIPT)).toEqual({ ok: true, verdict: IDEA });
  });

  it("copes with braces and escaped quotes inside strings", () => {
    const tricky = { ...NOT_IDEA, reason: 'They said "nothing {much}" and laughed.' };
    expect(parseVerdict(`Answer: ${reply(tricky)}`, TRANSCRIPT)).toEqual({ ok: true, verdict: tricky });
  });

  it("drops keys it does not know", () => {
    const parsed = parseVerdict(reply({ ...NOT_IDEA, mood: "cheerful" }), TRANSCRIPT);
    expect(parsed).toEqual({ ok: true, verdict: NOT_IDEA });
  });

  it("says so when there is no JSON object", () => {
    expect(problemOf("I could not decide.")).toBe("no JSON object in the reply");
    expect(problemOf("")).toBe("no JSON object in the reply");
    expect(problemOf('{"is_idea": true, "confidence": ')).toBe("no JSON object in the reply");
    expect(problemOf("[1, 2, 3]")).toBe("no JSON object in the reply");
  });

  it("finds each outermost object once", () => {
    expect(findJsonObjects('x {"a": {"b": 1}} y {"c": 2} {oops}')).toEqual([{ a: { b: 1 } }, { c: 2 }]);
  });

  it("gives up quickly on a reply that is nothing but braces", () => {
    for (const runaway of ["{".repeat(20_000), "{".repeat(200_000), "{}".repeat(100_000).replace(/\}/g, "") + "}".repeat(100_000), '{"a":'.repeat(40_000)]) {
      const started = performance.now();
      expect(problemOf(runaway)).toBe("no JSON object in the reply");
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("only looks through the start of a very long reply, and only so many braces", () => {
    // Far more prose than any real reply, then the answer: not found, so it costs a retry, not a hang.
    expect(problemOf(`${"word ".repeat(5_000)}${reply(IDEA)}`)).toBe("no JSON object in the reply");
    expect(problemOf(`${"{ ".repeat(250)}${reply(IDEA)}`)).toBe("no JSON object in the reply");
    // A normal amount of stray braces is still fine.
    expect(parseVerdict(`${"{ ".repeat(50)}${reply(IDEA)}`, TRANSCRIPT)).toEqual({ ok: true, verdict: IDEA });
  });
});

describe("parseVerdict: the rules", () => {
  it("names missing keys", () => {
    const { likely_media: _likelyMedia, reason: _reason, ...rest } = IDEA;
    const problem = problemOf(reply(rest));
    expect(problem).toContain("likely_media is missing or is not a boolean");
    expect(problem).toContain("reason is missing or is not a string");
  });

  it("rejects wrong types and a confidence outside 0 to 1", () => {
    expect(problemOf(reply({ ...IDEA, is_idea: "yes" }))).toBe("is_idea is missing or is not a boolean");
    expect(problemOf(reply({ ...IDEA, confidence: "0.9" }))).toBe("confidence is missing or is not a number");
    expect(problemOf(reply({ ...IDEA, confidence: 1.2 }))).toBe("confidence is not between 0 and 1");
    expect(problemOf(reply({ ...IDEA, confidence: -0.1 }))).toBe("confidence is not between 0 and 1");
  });

  it("rejects a title or pitch that is too long, and a quote that is too long and was never said", () => {
    expect(problemOf(reply({ ...IDEA, title: words(7) }))).toBe("title is longer than 6 words (it has 7)");
    expect(problemOf(reply({ ...IDEA, pitch: words(41) }))).toBe("pitch is longer than 40 words (it has 41)");
    expect(problemOf(reply({ ...IDEA, quote: words(26) }))).toBe("quote is longer than 25 words (it has 26); quote is not copied word for word from the conversation");
  });

  it("rejects a title, pitch or quote made of a few enormous words", () => {
    const giant = (length: number) => "x".repeat(length);
    expect(CHAR_LIMITS).toMatchObject({ title: 80, pitch: 400, quote: 300 });
    expect(problemOf(reply({ ...IDEA, title: giant(81) }))).toBe("title is longer than 80 characters");
    expect(problemOf(reply({ ...IDEA, title: giant(5_000) }))).toBe("title is longer than 80 characters");
    expect(problemOf(reply({ ...IDEA, pitch: `${giant(200)} ${giant(200)}` }))).toBe("pitch is longer than 400 characters");
    const longQuote = `${giant(150)} and ${giant(150)}`;
    expect(problemOf(reply({ ...IDEA, quote: longQuote }), `[10:00:00] ${longQuote}`)).toBe("quote is longer than 300 characters");
    // Exactly at the limit is fine.
    expect(parseVerdict(reply({ ...IDEA, title: giant(80), pitch: `${giant(200)} ${giant(199)}` }), TRANSCRIPT).ok).toBe(true);
  });

  it("cuts an enormous reason instead of rejecting the reply", () => {
    const parsed = parseVerdict(reply({ ...IDEA, reason: "y".repeat(5_000) }), TRANSCRIPT);
    expect(parsed.ok && parsed.verdict.reason).toBe(`${"y".repeat(400)}...`);
  });

  it("takes control characters and text-direction marks out of every string", () => {
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    const BELL = String.fromCharCode(7);
    const dirty = {
      ...IDEA,
      title: `Game${NUL}night ${ESC}[31mpicker\u202E`,
      pitch: `\u2066Picks whose turn${BELL} it is.\u2069\u2028Remembers who went last.\u202A`,
      quote: `Someone should build${NUL} a little page\tthat just picks the next person.`,
      reason: `A sincere${ESC} wish.\u2029`,
    };
    const parsed = parseVerdict(reply(dirty), TRANSCRIPT);
    expect(parsed).toMatchObject({
      ok: true,
      verdict: {
        title: "Game night [31mpicker",
        pitch: "Picks whose turn it is. Remembers who went last.",
        quote: "Someone should build a little page that just picks the next person.",
        reason: "A sincere wish.",
      },
    });
    // Nothing invisible is left anywhere in the verdict.
    expect(JSON.stringify(parsed)).not.toMatch(/\\u00[01][0-9a-f]|\\u007f|[\u202A-\u202E\u2066-\u2069\u2028\u2029]/i);
  });

  it("cuts a reason that runs long instead of rejecting the reply", () => {
    const parsed = parseVerdict(reply({ ...IDEA, reason: words(55) }), TRANSCRIPT);
    expect(parsed.ok && parsed.verdict.reason).toBe(`${words(40)}...`);
    expect(parsed.ok && countWords(parsed.verdict.reason)).toBe(40);
  });

  it("accepts each field at exactly its limit", () => {
    const quote = words(25);
    const atLimit = { ...IDEA, title: words(6), pitch: words(40), quote, reason: words(40) };
    expect(parseVerdict(reply(atLimit), `[10:00:00] ${quote}`).ok).toBe(true);
  });

  it("rejects an idea with an empty title, pitch or quote", () => {
    expect(problemOf(reply({ ...IDEA, title: " " }))).toBe("title is empty although is_idea is true");
    expect(problemOf(reply({ ...IDEA, quote: "" }))).toBe("quote is empty although is_idea is true");
  });

  it("rejects an idea whose quote is only a word or two, even when those words were said", () => {
    expect(problemOf(reply({ ...IDEA, quote: "page" }))).toBe("quote is shorter than 3 words");
    expect(problemOf(reply({ ...IDEA, quote: "little page" }))).toBe("quote is shorter than 3 words");
    expect(problemOf(reply({ ...IDEA, quote: "e" }))).toBe("quote is shorter than 3 words; quote is not copied word for word from the conversation");
    expect(parseVerdict(reply({ ...IDEA, quote: "a little page" }), TRANSCRIPT).ok).toBe(true);
  });

  it("accepts a whole short idea as its own quote", () => {
    const said = "Someone should build a dice roller page.";
    expect(parseVerdict(reply({ ...IDEA, quote: said }), `[21:07:33] ${said}`)).toMatchObject({ ok: true, verdict: { quote: said } });
  });

  it("rejects a quote that is not in the conversation, without repeating it", () => {
    const invented = "I really wish somebody made a karaoke scoring website.";
    const problem = problemOf(reply({ ...IDEA, quote: invented }));
    expect(problem).toBe("quote is not copied word for word from the conversation");
    expect(problem).not.toContain("karaoke");
  });

  it("forces title, pitch and quote to empty for a non-idea, whatever was in them", () => {
    const stray = { ...NOT_IDEA, title: words(9), pitch: "Something half thought", quote: "This was never said by anyone." };
    expect(parseVerdict(reply(stray), TRANSCRIPT)).toEqual({ ok: true, verdict: NOT_IDEA });
  });

  it("puts every string on one line", () => {
    const messy = { ...IDEA, title: "  Game   night\npicker ", quote: "Someone should build a little page\n that just picks the next person." };
    const parsed = parseVerdict(reply(messy), TRANSCRIPT);
    expect(parsed.ok && parsed.verdict.title).toBe("Game night picker");
    expect(parsed.ok && parsed.verdict.quote).toBe("Someone should build a little page that just picks the next person.");
  });
});

describe("quoteAppearsIn", () => {
  it("ignores case, spacing and the punctuation at the ends", () => {
    expect(quoteAppearsIn("someone should build a little page", TRANSCRIPT)).toBe(true);
    expect(quoteAppearsIn("SOMEONE  SHOULD build a little page...", TRANSCRIPT)).toBe(true);
    expect(quoteAppearsIn('"it remembers who went last!"', TRANSCRIPT)).toBe(true);
  });

  it("treats curly and straight apostrophes as the same", () => {
    expect(quoteAppearsIn("why isn’t there a page for that", "[08:00:00] Why isn't there a page for that?")).toBe(true);
    expect(quoteAppearsIn("why isn't there a page for that", "Why isn’t there a page for that?")).toBe(true);
  });

  it("matches a quote that runs across two lines", () => {
    expect(quoteAppearsIn("just picks the next person. Yeah, and it remembers who went last", TRANSCRIPT)).toBe(true);
  });

  it("needs the words in between to match exactly", () => {
    expect(quoteAppearsIn("Someone should build a page that picks the next person", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("Someone should build a little page, that just picks", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("...", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("", TRANSCRIPT)).toBe(false);
  });

  it("does not accept a quote that starts or ends in the middle of a word", () => {
    expect(quoteAppearsIn("omeone should buil", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("should buil", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("omeone should build", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("e", TRANSCRIPT)).toBe(false);
    expect(quoteAppearsIn("art app", "[09:00:00] We need a smart application for this.")).toBe(false);
    expect(quoteAppearsIn("page 1", "[09:00:00] Open page 12 of the manual.")).toBe(false);
    expect(quoteAppearsIn("caf", "[09:00:00] The café was shut.")).toBe(false);
  });

  it("finds a whole-word match even when a mid-word one comes first", () => {
    const transcript = "[09:00:00] A smart application is not what I want. I want an art app for the kids.";
    expect(quoteAppearsIn("art app", transcript)).toBe(true);
    expect(quoteAppearsIn("an art app for the kids", transcript)).toBe(true);
    expect(quoteAppearsIn("I want", transcript)).toBe(true);
  });

  it("treats punctuation and the ends of the transcript as word edges", () => {
    expect(quoteAppearsIn("we always forget", TRANSCRIPT)).toBe(true);
    expect(quoteAppearsIn("who went last", TRANSCRIPT)).toBe(true);
    expect(quoteAppearsIn("the board game", TRANSCRIPT)).toBe(true);
    expect(quoteAppearsIn("isn't there a page", "Why isn't there a page-turner app?")).toBe(true);
  });
});

describe("shortenQuote", () => {
  const LONG = "I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many cans of paint to buy for the job.";
  const FIRST_25 = "I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many";

  it("leaves a quote that fits alone", () => {
    expect(shortenQuote("I want a little page for paint.")).toBe("I want a little page for paint.");
    expect(shortenQuote(words(25))).toBe(words(25));
  });

  it("keeps the first 25 words and changes nothing inside them", () => {
    expect(shortenQuote(LONG)).toBe(FIRST_25);
    expect(countWords(shortenQuote(LONG))).toBe(25);
    expect(shortenQuote(words(30))).toBe(words(25));
    expect(shortenQuote(`Okay, ${words(30)}`)).toBe(`Okay, ${words(24)}`);
  });

  it("does not leave a comma dangling at the cut", () => {
    expect(shortenQuote(`${words(24)} last, ${words(5)}`)).toBe(`${words(24)} last`);
    expect(shortenQuote(`${words(24)} last. ${words(5)}`)).toBe(`${words(24)} last.`);
  });
});

describe("parseVerdict: a quote that is right but too long", () => {
  const LONG = "I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many cans of paint to buy for the job.";
  const FIRST_25 = "I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many";
  const transcript = `[10:00:00] The hallway needs doing.\n[10:00:05] ${LONG}`;

  it("is cut to its first 25 words and accepted, and says that it was cut", () => {
    const parsed = parseVerdict(reply({ ...IDEA, quote: LONG }), transcript);
    expect(parsed).toEqual({ ok: true, verdict: { ...IDEA, quote: FIRST_25 }, quoteCut: true });
    expect(quoteAppearsIn(FIRST_25, transcript)).toBe(true);
  });

  it("is cut even when the long quote runs across two lines", () => {
    const twoLines = `[10:00:00] ${words(20)}\n[10:00:04] ${words(40).split(" ").slice(20).join(" ")}`;
    const parsed = parseVerdict(reply({ ...IDEA, quote: words(40) }), twoLines);
    expect(parsed.ok && parsed.verdict.quote).toBe(words(25));
  });

  it("does not say cut when nothing was cut", () => {
    expect(parseVerdict(reply(IDEA), TRANSCRIPT)).not.toHaveProperty("quoteCut");
  });

  it("still rejects a long quote that was never said", () => {
    expect(parseVerdict(reply({ ...IDEA, quote: words(30) }), TRANSCRIPT)).toEqual({
      ok: false,
      problem: "quote is longer than 25 words (it has 30); quote is not copied word for word from the conversation",
    });
  });

  it("still reports the other faults of a reply whose long quote could be cut", () => {
    expect(problemOf(reply({ ...IDEA, quote: LONG, title: words(7) }), transcript)).toBe("title is longer than 6 words (it has 7)");
  });

  it("leaves a non-idea's leftover quote alone, however long", () => {
    expect(parseVerdict(reply({ ...NOT_IDEA, quote: LONG }), transcript)).toEqual({ ok: true, verdict: NOT_IDEA });
  });
});

describe("countWords", () => {
  it("counts words whatever the spacing", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords(" one  two\nthree ")).toBe(3);
  });
});
