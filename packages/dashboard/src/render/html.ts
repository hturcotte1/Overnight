// The one place where text becomes HTML.
//
// Titles, pitches, quotes, notes and failure reasons come from overheard speech or from a model
// that read it, so they are not ours. Every page is built with the html`` template below, and the
// template escapes every string it is given. There is no way round it: a `SafeHtml` can only be
// made in this file, there is no raw(), and the server sends nothing but a `SafeHtml`.
//
//   html`<h2 class="title">${idea.title}</h2>`        the title is escaped
//   html`<ul>${ideas.map((idea) => row(idea))}</ul>`   pieces made by html`` pass through once
//
// The template is written for text between tags and for attribute values in double quotes.
// Never put a value into a tag name, an attribute name, an unquoted attribute, a <script> or a
// <style>: escaping cannot make those safe.

/** Proof that a SafeHtml was made here. Never exported. */
const MADE_HERE = Symbol("made by render/html.ts");

/** A piece of HTML in which every value was escaped. Only the html`` template makes one. */
export class SafeHtml {
  // A real private field, so that neither a plain object with a `text` in it nor a made-up object
  // with this class's prototype is taken for a SafeHtml: not by TypeScript, and not by the template.
  readonly #madeHere = true;
  readonly text: string;

  constructor(key: symbol, text: string) {
    if (key !== MADE_HERE) throw new TypeError("A SafeHtml is only made by the html`` template in render/html.ts.");
    this.text = text;
    Object.freeze(this);
  }

  toString(): string {
    return this.text;
  }

  /** True only for an object this file's constructor made. */
  static isReal(value: unknown): value is SafeHtml {
    return typeof value === "object" && value !== null && #madeHere in value;
  }
}

/** What may be put into the template. An array is joined with nothing between its parts. */
export type Renderable = SafeHtml | string | number | null | undefined | false | readonly Renderable[];

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/**
 * Make a text safe between tags and inside a double-quoted attribute, and safe to look at:
 *   & < > " ' `   are written as character references
 *   Cc            control characters are dropped, except new line and tab
 *   Cf            invisible formatting characters are dropped (zero-width ones, the right-to-left
 *                 overrides and isolates, the byte-order mark)
 *   Zl, Zp        the Unicode line and paragraph separators become a new line
 * These are the classes the command line strips before it prints a title (cli, output.ts).
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/[\p{Zl}\p{Zp}]/gu, "\n")
    .replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "")
    .replace(/[&<>"'`]/g, (character) => ESCAPES[character] ?? "");
}

/** What kind of thing a refused value was. Never the value itself: it may be something a person said. */
function kindOf(value: unknown): string {
  if (value === true) return "true";
  if (typeof value === "object" && value !== null) return value instanceof Date ? "a Date" : "an object";
  return `a ${typeof value}`;
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number") return String(value);
  if (SafeHtml.isReal(value)) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  throw new TypeError(`html\`\` was given ${kindOf(value)}. It takes text, numbers, pieces made by html\`\`, arrays of those, and null, undefined or false for nothing.`);
}

/**
 * The template tag every page is built with. Strings are escaped, pieces made by this tag pass
 * through once, arrays are joined, and null, undefined and false leave nothing. Anything else
 * (an object, a Date, true) throws, so a forgotten `.title` shows up in a test instead of on the page.
 */
export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  // Only as a tag: html`...`. Called as html(["<b>"]) the "template" could be anybody's text.
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings) || strings.length !== values.length + 1) {
    throw new TypeError("html is a template tag: write html`...`, not html(...).");
  }
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += render(values[index]) + (strings[index + 1] ?? "");
  }
  return new SafeHtml(MADE_HERE, text);
}

/** The longest link the pages will make. */
const MAX_HREF_CHARS = 2048;

/**
 * A published app's address, if it is fit to be a link: https only, no user name or password in
 * it, no spaces or invisible characters, at most 2,048 characters. Otherwise null, and the page
 * shows the address as plain text. What comes back is the address as a browser reads it, so what
 * was checked is what is linked.
 */
export function safeHref(url: string | null): string | null {
  if (url === null || url.length > MAX_HREF_CHARS) return null;
  // "https://" and then a host at once. A browser would also make sense of "https:host" and
  // "https:///host", but nothing Overnight publishes looks like that.
  if (!/^https:\/\/[^/?#]/.test(url)) return null;
  if (/[\s\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") return null;
  return parsed.href.length <= MAX_HREF_CHARS ? parsed.href : null;
}
