// "Have we already heard this one?" by comparing titles. Deliberately crude: it only has to catch
// the same idea worded slightly differently ("Plant watering tracker" / "Watering tracker for
// plants"). The prompt also asks the model to reuse the old title for a repeat, which is what
// makes this check reliable.

// Words that say nothing about which idea it is.
const FILLER = new Set([
  ...["a", "an", "the", "for", "to", "of", "my", "your", "our", "and", "or", "with", "in", "on", "at", "by", "that", "this", "it", "is"],
  ...["app", "application", "tool", "site", "website", "web", "page", "bot", "thing"],
  ...["simple", "tiny", "little", "small", "quick", "mini"],
]);

// Crude on purpose: "plants" and "plant" must meet, and so must "movies" and "movie".
function foldPlural(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ie")) return word.slice(0, -2) + "y";
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function words(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/['‘’]/g, "") // "who's" stays one word
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(foldPlural);
}

/** The words of a title that carry meaning: lower case, no punctuation, no filler, plurals folded. */
export function titleTokens(title: string): Set<string> {
  return new Set(words(title).filter((word) => !FILLER.has(word)));
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

function sameIdea(a: string, b: string): boolean {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  // A title made only of filler ("My app") can still be compared as plain words.
  if (tokensA.size === 0 || tokensB.size === 0) {
    const plainA = words(a).join(" ");
    return plainA !== "" && plainA === words(b).join(" ");
  }
  const shared = sharedCount(tokensA, tokensB);
  const jaccard = shared / (tokensA.size + tokensB.size - shared);
  if (jaccard >= 0.6) return true;
  // "Plant tracker" inside "Plant watering tracker". One-word titles are too thin for this rule.
  return tokensA.size >= 2 && tokensB.size >= 2 && shared === Math.min(tokensA.size, tokensB.size);
}

/** True if `title` names the same idea as one of `recentTitles`. */
export function isNearDuplicate(title: string, recentTitles: string[]): boolean {
  return recentTitles.some((recent) => sameIdea(title, recent));
}
