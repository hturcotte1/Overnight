// Text cleaning shared by the prompt (what Kiro is shown) and the schema (what Kiro sends back).
// Both sides use the same function, so a quote the model copies from what it was shown still
// matches after cleaning.

/**
 * One line, single spaces, nothing invisible that could change how the text is read.
 * Removed: every control character (Cc: newlines, tabs, NUL and ESC included), Unicode's own
 * line and paragraph breaks (Zl, Zp), and the characters that flip text direction (U+202A to
 * U+202E and U+2066 to U+2069), which can make a title read differently from what it says.
 */
export function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
