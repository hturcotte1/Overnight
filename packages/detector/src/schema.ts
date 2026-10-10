// What a detector reply must look like (SPEC §5), and how to find it in the model's free text.
//
// Privacy rule: the `problem` strings made here are our own words only. They never repeat what
// the model wrote, because the model may be quoting the conversation and problems end up in logs.
import { z } from "zod";
import type { DetectorVerdict } from "@overnight/core";
import { oneLine } from "./text.ts";

export const WORD_LIMITS = { title: 6, pitch: 40, quote: 25, reason: 40 } as const;
/**
 * Word limits alone let one endless "word" through. No real title, pitch or quote comes near
 * these; they only stop a runaway string reaching a to-do, a log line or the brief.
 */
export const CHAR_LIMITS = { title: 80, pitch: 400, quote: 300, reason: 400 } as const;
/** An idea's quote is what ties it to something that was really said, so one or two words will not do. */
export const MIN_QUOTE_WORDS = 3;

/** Longest reply we look through. A real reply is under 1,000 characters. */
const MAX_REPLY_CHARS = 20_000;
/** How many "{" we try as the start of the answer before giving up on a reply. */
const MAX_OBJECT_STARTS = 200;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Every string ends up on one line with no control characters, so a title can go straight into
// a to-do, a command-line argument or a log line.
const line = z.string().transform(oneLine);

// The reason is a note for the dashboard and nothing is built from it, so one that runs long is
// cut to the limit instead of costing a retry.
const reason = line.transform((value) => {
  const words = value.split(" ");
  const text = words.length <= WORD_LIMITS.reason ? value : `${words.slice(0, WORD_LIMITS.reason).join(" ")}...`;
  if (text.length <= CHAR_LIMITS.reason) return text;
  // Cut by whole characters, so an emoji at the cut is not left as half of one.
  return `${[...text].slice(0, CHAR_LIMITS.reason).join("")}...`;
});

const shape = z.object({
  is_idea: z.boolean(),
  confidence: z.number().min(0).max(1),
  title: line,
  pitch: line,
  quote: line,
  said_by_wearer_guess: z.boolean(),
  likely_media: z.boolean(),
  buildable_as_static_web_app: z.boolean(),
  reason,
});

/**
 * The shape and the length limits. The "quote is word for word" rule is not here because it
 * needs the transcript; parseVerdict() adds it.
 */
export const verdictSchema = shape
  // A non-idea has no title, pitch or quote. Blank them before the limits are checked, so a
  // stray leftover in an unused field never costs us a retry.
  .transform((value): DetectorVerdict => (value.is_idea ? value : { ...value, title: "", pitch: "", quote: "" }))
  .superRefine((value, context) => {
    for (const key of ["title", "pitch", "quote"] as const) {
      if (countWords(value[key]) > WORD_LIMITS[key]) {
        // The count is for the model's second try. It is a number, so it gives nothing away.
        context.addIssue({ code: "custom", path: [key], message: `${key} is longer than ${WORD_LIMITS[key]} words (it has ${countWords(value[key])})` });
      }
      if (value[key].length > CHAR_LIMITS[key]) {
        context.addIssue({ code: "custom", path: [key], message: `${key} is longer than ${CHAR_LIMITS[key]} characters` });
      }
    }
    if (!value.is_idea) return;
    for (const key of ["title", "pitch", "quote"] as const) {
      if (value[key] === "") context.addIssue({ code: "custom", path: [key], message: `${key} is empty although is_idea is true` });
    }
    if (value.quote !== "" && countWords(value.quote) < MIN_QUOTE_WORDS) {
      context.addIssue({ code: "custom", path: ["quote"], message: `quote is shorter than ${MIN_QUOTE_WORDS} words` });
    }
  });

type Issue = z.ZodError["issues"][number];

/** A zod issue in our own plain words. Uses the key name and the kind of problem, never a value. */
function describeIssue(issue: Issue): string {
  const key = issue.path.length > 0 ? issue.path.join(".") : "the reply";
  switch (issue.code) {
    case "custom":
      return issue.message; // written above, by us
    case "invalid_type":
      return `${key} is missing or is not a ${issue.expected}`;
    case "too_big":
    case "too_small":
      return `${key} is not between 0 and 1`;
    default:
      return `${key} is not valid`;
  }
}

/** Index of the "}" that closes the "{" at `start`, or -1. Braces inside JSON strings do not count. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every outermost {...} in the text that parses as a JSON object, in order. The model is asked
 * for bare JSON but sometimes wraps it in a sentence or a code fence; a stray "{" in that prose
 * is skipped rather than spoiling the search.
 *
 * Each "{" means a scan to the end of the text, so both the text and the number of "{" tried
 * are capped: a runaway reply full of braces must not hold up the listener.
 */
export function findJsonObjects(text: string): Record<string, unknown>[] {
  const source = text.slice(0, MAX_REPLY_CHARS);
  const found: Record<string, unknown>[] = [];
  let from = 0;
  let starts = 0;
  while (from < source.length && starts < MAX_OBJECT_STARTS) {
    const start = source.indexOf("{", from);
    if (start === -1) break;
    starts += 1;
    const end = closingBrace(source, start);
    const value = end === -1 ? null : parseObject(source.slice(start, end + 1));
    if (value) found.push(value);
    from = value ? end + 1 : start + 1;
  }
  return found;
}

/** For comparing: lower case, single spaces, straight quote marks. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const ENDS_IN_LETTER_OR_DIGIT = /[\p{L}\p{N}]$/u;
const STARTS_WITH_LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

/**
 * Is the quote in the transcript word for word? Case, spacing and the punctuation at the quote's
 * two ends are ignored; the words in between must match exactly and in order, and the quote must
 * start and end on whole words ("art app" is not a quote from "smart application").
 * `transcriptText` may be the bare utterance texts or the "[HH:MM:SS] text" lines: clock times at
 * the start of a line are dropped first, so a quote that runs across two lines still matches.
 */
export function quoteAppearsIn(quote: string, transcriptText: string): boolean {
  const needle = comparable(quote)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
  if (needle === "") return false;
  const haystack = comparable(transcriptText.replace(/^[ \t]*\[\d{2}:\d{2}:\d{2}\][ \t]?/gm, ""));
  for (let hit = haystack.indexOf(needle); hit !== -1; hit = haystack.indexOf(needle, hit + 1)) {
    const end = hit + needle.length;
    // Two code units either side are enough to see one whole character, whatever its size.
    const midWordBefore = ENDS_IN_LETTER_OR_DIGIT.test(haystack.slice(Math.max(0, hit - 2), hit));
    const midWordAfter = STARTS_WITH_LETTER_OR_DIGIT.test(haystack.slice(end, end + 2));
    if (!midWordBefore && !midWordAfter) return true;
  }
  return false;
}

/**
 * The first `maxWords` words of a quote, without a comma, semicolon or colon left dangling at
 * the cut. Nothing inside is changed, so a quote that was word for word still is.
 */
export function shortenQuote(quote: string, maxWords: number = WORD_LIMITS.quote): string {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words
    .slice(0, maxWords)
    .join(" ")
    .replace(/[,;:]+$/, "");
}

export type ParsedVerdict =
  | {
      ok: true;
      verdict: DetectorVerdict;
      /** Present when the quote was word for word but too long, and was cut to its first words. */
      quoteCut?: true;
    }
  | { ok: false; problem: string };

const NOT_WORD_FOR_WORD = "quote is not copied word for word from the conversation";

/**
 * Turn the model's reply into a checked verdict, or say what is wrong with it.
 * `transcriptText` is the conversation the model was shown; the quote is checked against it.
 *
 * One fault is put right here instead of being sent back: a quote that is word for word but
 * runs past the word limit is cut to its first words. People talk in long sentences and the
 * model counts words badly; asking again fixed 2 of 11 such replies when it was measured, so
 * a second call is not worth it. A quote that was never said is still a bad reply.
 */
export function parseVerdict(replyText: string, transcriptText: string): ParsedVerdict {
  const objects = findJsonObjects(replyText);
  // Prefer the object that looks like a verdict, in case the model printed an example first.
  const found = objects.find((value) => "is_idea" in value) ?? objects[0];
  if (!found) return { ok: false, problem: "no JSON object in the reply" };

  // Cleaned the way the schema will clean it, so both look at the same text.
  const quote = found.is_idea === true && typeof found.quote === "string" ? oneLine(found.quote) : "";
  const wordForWord = quote !== "" && quoteAppearsIn(quote, transcriptText);
  const quoteCut = wordForWord && countWords(quote) > WORD_LIMITS.quote;
  const candidate = quoteCut ? { ...found, quote: shortenQuote(quote) } : found;

  const parsed = verdictSchema.safeParse(candidate);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 3).map(describeIssue);
    // Say so in the same breath, so the model's one retry can put both right.
    if (quote !== "" && !wordForWord) problems.push(NOT_WORD_FOR_WORD);
    return { ok: false, problem: problems.join("; ") };
  }
  const verdict = parsed.data;
  if (verdict.is_idea && !quoteAppearsIn(verdict.quote, transcriptText)) return { ok: false, problem: NOT_WORD_FOR_WORD };
  return quoteCut ? { ok: true, verdict, quoteCut: true } : { ok: true, verdict };
}
