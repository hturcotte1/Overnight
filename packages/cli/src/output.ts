// Small helpers for what the commands print.

/** Prints one line. The commands never write to the terminal directly, so tests can capture it. */
export type Write = (line: string) => void;

/**
 * Titles and notes come from a model that read overheard speech, so they are not ours. Before
 * showing them in a terminal, strip anything that could move the cursor, start a new line, or
 * reorder or hide the rest of the line:
 *   Cc      control characters (new lines, escape sequences)
 *   Cf      invisible formatting characters (zero-width ones, the right-to-left overrides and
 *           isolates, the byte-order mark)
 *   Zl, Zp  the Unicode line and paragraph separators
 */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
