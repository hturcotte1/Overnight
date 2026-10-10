// Small text helpers. Pure: no clock, no store, no logging.

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Lowercase, punctuation removed, spaces collapsed: "Well, that's it!" becomes "well thats it". */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Shared words over all words, from 0 to 1. Word order and repeats do not count. */
export function tokenSetSimilarity(a: string, b: string): number {
  const left = new Set(normaliseText(a).split(" ").filter(Boolean));
  const right = new Set(normaliseText(b).split(" ").filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Do two lines read like the same line, allowing for small transcription differences? */
export function isSimilarText(a: string, b: string, threshold: number): boolean {
  return normaliseText(a) === normaliseText(b) || tokenSetSimilarity(a, b) >= threshold;
}

const MAX_TITLE_CHARS = 80;

/** A title on one line, short enough for a watch face. The detector aims for six words; this is the backstop. */
export function tidyTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  const chars = [...oneLine];
  return chars.length <= MAX_TITLE_CHARS ? oneLine : `${chars.slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd()}…`;
}

/**
 * The same instant as a full UTC ISO string, or null if `value` is not a time. The store compares
 * times as text, so "…:05Z" and "…:05.000Z" must not both be stored.
 */
export function toIsoOrNull(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
