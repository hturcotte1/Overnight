// The one escaping template. Every text here is invented for the test.
import { describe, expect, it } from "vitest";
import { escapeHtml, html, SafeHtml, safeHref } from "../src/render/html.ts";
import type { Renderable } from "../src/render/html.ts";

describe("html``", () => {
  it("escapes a string between tags", () => {
    const title = `<img src=x onerror=1> & "quotes" 'single' \`tick\``;
    expect(html`<h2>${title}</h2>`.text).toBe("<h2>&lt;img src=x onerror=1&gt; &amp; &quot;quotes&quot; &#39;single&#39; &#96;tick&#96;</h2>");
  });

  it("escapes a string inside a double-quoted attribute, so it cannot close the quote or add an attribute", () => {
    const hostile = `" data-xss-probe="1`;
    const out = html`<a class="card" title="${hostile}">x</a>`.text;
    expect(out).toBe(`<a class="card" title="&quot; data-xss-probe=&quot;1">x</a>`);
    expect(out).not.toContain(`" data-xss-probe=`);
    expect(html`<p title="${"'><img src=x onerror=1>"}"></p>`.text).toBe(`<p title="&#39;&gt;&lt;img src=x onerror=1&gt;"></p>`);
  });

  it("leaves the template's own words alone", () => {
    expect(html`<p class="a & b">Tom & Jerry's <b>"best"</b></p>`.text).toBe(`<p class="a & b">Tom & Jerry's <b>"best"</b></p>`);
  });

  it("passes a piece made by html`` through once, without escaping it again", () => {
    const inner = html`<b>${"R&D <lab>"}</b>`;
    const outer = html`<p>${inner}</p>`;
    expect(outer.text).toBe("<p><b>R&amp;D &lt;lab&gt;</b></p>");
    expect(html`<div>${outer}${outer}</div>`.text).toBe("<div><p><b>R&amp;D &lt;lab&gt;</b></p><p><b>R&amp;D &lt;lab&gt;</b></p></div>");
  });

  it("escapes a string that only looks like a piece of HTML", () => {
    const looksSafe = html`<b>bold</b>`.text;
    expect(html`<p>${looksSafe}</p>`.text).toBe("<p>&lt;b&gt;bold&lt;/b&gt;</p>");
  });

  it("joins arrays with nothing between the parts, to any depth", () => {
    const rows = ["Chore <Wheel>", "Lunch Turns"].map((title) => html`<li>${title}</li>`);
    expect(html`<ul>${rows}</ul>`.text).toBe("<ul><li>Chore &lt;Wheel&gt;</li><li>Lunch Turns</li></ul>");
    expect(html`${["a<", ["b>", [html`<i>c</i>`, 4]], null, false]}`.text).toBe("a&lt;b&gt;<i>c</i>4");
    expect(html`<ul>${[]}</ul>`.text).toBe("<ul></ul>");
  });

  it("leaves nothing for null, undefined and false, and writes numbers, zero included", () => {
    const nothing: Renderable[] = [null, undefined, false];
    expect(html`[${nothing[0]}${nothing[1]}${nothing[2]}]`.text).toBe("[]");
    expect(html`${0} ${3} ${4.59} ${-2}`.text).toBe("0 3 4.59 -2");
    expect(html`${""}`.text).toBe("");
  });

  it("throws on anything else, and never repeats the value in the error", () => {
    const secret = "QUOTE-SENTINEL-1";
    const wrong: unknown[] = [{ title: secret }, true, new Date(0), () => secret, Symbol(secret), 10n, new Map([[secret, secret]]), [{ title: secret }]];
    for (const value of wrong) {
      const attempt = () => html`<p>${value as Renderable}</p>`;
      expect(attempt).toThrow(TypeError);
      let message = "did not throw";
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("html`` was given");
      expect(message).not.toContain(secret);
    }
  });

  it("is a template tag only: called as a function it throws", () => {
    const asFunction = html as unknown as (strings: unknown, ...values: unknown[]) => SafeHtml;
    expect(() => asFunction(["<b>not a template</b>"])).toThrow(/template tag/);
    expect(() => asFunction("<b>not a template</b>")).toThrow(/template tag/);
    expect(() => asFunction(Object.freeze(["<b>", "</b>"]), "x")).toThrow(/template tag/);
  });

  it("has a text and prints as it", () => {
    const piece = html`<em>${"a"}</em>`;
    expect(piece).toBeInstanceOf(SafeHtml);
    expect(String(piece)).toBe("<em>a</em>");
    expect(`${piece}`).toBe(piece.text);
  });
});

describe("SafeHtml", () => {
  // The constructor's first parameter is a symbol that only render/html.ts holds.
  const Open = SafeHtml as unknown as new (...args: unknown[]) => SafeHtml;

  it("cannot be made outside render/html.ts: the constructor throws without the file's own symbol", () => {
    expect(() => new Open()).toThrow(TypeError);
    expect(() => new Open("<b>raw</b>")).toThrow(/only made by the html/);
    expect(() => new Open(Symbol("made by render/html.ts"), "<b>raw</b>")).toThrow(TypeError);
    expect(() => new Open(Symbol.for("made by render/html.ts"), "<b>raw</b>")).toThrow(TypeError);
  });

  it("has no raw() and no other way in", () => {
    expect(Object.getOwnPropertyNames(SafeHtml).sort()).toEqual(["isReal", "length", "name", "prototype"]);
    expect(Object.getOwnPropertyNames(SafeHtml.prototype).sort()).toEqual(["constructor", "toString"]);
  });

  it("is not fooled by an object dressed up as one", () => {
    const dressedUp = Object.assign(Object.create(SafeHtml.prototype) as object, { text: "<script>alert(1)</script>" });
    expect(dressedUp).toBeInstanceOf(SafeHtml);
    expect(SafeHtml.isReal(dressedUp)).toBe(false);
    expect(() => html`<p>${dressedUp as SafeHtml}</p>`).toThrow(/was given an object/);
    expect(SafeHtml.isReal({ text: "<b>" })).toBe(false);
    expect(SafeHtml.isReal("<b>")).toBe(false);
    expect(SafeHtml.isReal(null)).toBe(false);
    expect(SafeHtml.isReal(html`<b></b>`)).toBe(true);
  });

  it("cannot be changed once made", () => {
    const piece = html`<p>${"fine"}</p>`;
    expect(Object.isFrozen(piece)).toBe(true);
    expect(() => {
      (piece as { text: string }).text = "<script>";
    }).toThrow(TypeError);
    expect(piece.text).toBe("<p>fine</p>");
  });
});

describe("escapeHtml", () => {
  it("writes the six characters as references", () => {
    expect(escapeHtml(`& < > " ' \``)).toBe("&amp; &lt; &gt; &quot; &#39; &#96;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml("plain words, 100%")).toBe("plain words, 100%");
  });

  it("drops control characters but keeps new line and tab", () => {
    expect(escapeHtml("a\u0000b\u0007c\u001bd\u007fe\u0085f")).toBe("abcdef");
    expect(escapeHtml("one\ntwo\tthree")).toBe("one\ntwo\tthree");
    expect(escapeHtml("one\r\ntwo\rthree")).toBe("one\ntwothree");
  });

  it("drops invisible formatting characters: direction overrides and isolates, zero-width ones, the byte-order mark", () => {
    // U+202E turns the rest of a line right to left; a title could use it to show other words than it holds.
    expect(escapeHtml("Chore \u202Eleehw\u202C Wheel")).toBe("Chore leehw Wheel");
    expect(escapeHtml("\u2066a\u2067b\u2068c\u2069\u200Ed\u200F")).toBe("abcd");
    expect(escapeHtml("ze\u200Bro\u200C wi\u200Ddth\uFEFF\u00AD")).toBe("zero width");
    expect(escapeHtml("tag\u{E0041}s")).toBe("tags");
  });

  it("turns the Unicode line and paragraph separators into new lines", () => {
    expect(escapeHtml("one\u2028two\u2029three")).toBe("one\ntwo\nthree");
  });

  it("keeps ordinary letters from any language, and emoji", () => {
    expect(escapeHtml("café 日本語 😀 naïve")).toBe("café 日本語 😀 naïve");
  });
});

describe("safeHref", () => {
  it("lets an https address through", () => {
    expect(safeHref("https://example.invalid/overnight-apps/packing-checklist/")).toBe("https://example.invalid/overnight-apps/packing-checklist/");
    expect(safeHref("https://example.invalid/a?b=1&c=2#top")).toBe("https://example.invalid/a?b=1&c=2#top");
  });

  it("gives the address back as a browser reads it", () => {
    expect(safeHref("https://EXAMPLE.invalid")).toBe("https://example.invalid/");
    expect(safeHref("https://example.invalid/a/../b")).toBe("https://example.invalid/b");
  });

  it("refuses everything that is not plain https", () => {
    const refused = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://example.invalid/",
      "//example.invalid/app/",
      "/ideas/abc",
      "example.invalid/app/",
      "ftp://example.invalid/",
      "file:///etc/hosts",
      "vbscript:x",
      "https:example.invalid",
      "https:///example.invalid",
      "https://",
      "HTTPS://example.invalid/",
      "",
    ];
    for (const url of refused) expect(safeHref(url), url).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it("refuses a user name or password in the address", () => {
    expect(safeHref("https://user:pass@example.invalid/")).toBeNull();
    expect(safeHref("https://user@example.invalid/")).toBeNull();
    expect(safeHref("https://example.invalid@evil.invalid/")).toBeNull();
  });

  it("refuses spaces, backslashes and invisible characters anywhere in it", () => {
    for (const url of ["https://example.invalid/a b", "https://example.invalid/\n", "https://example.invalid\\@evil.invalid/", "https://exa\u200Bmple.invalid/", "https://example.invalid/\u202Egnp.exe", "java\tscript:alert(1)"]) {
      expect(safeHref(url), JSON.stringify(url)).toBeNull();
    }
  });

  it("refuses an address longer than 2,048 characters, before or after the browser's reading of it", () => {
    const base = "https://example.invalid/";
    expect(safeHref(base + "a".repeat(2048 - base.length))).toHaveLength(2048);
    expect(safeHref(base + "a".repeat(2049 - base.length))).toBeNull();
    // 700 letters that each become six characters ("%C3%A9") when the address is written out.
    expect(safeHref(base + "é".repeat(700))).toBeNull();
    // Too long as given, though a browser would read it as the short "https://example.invalid/".
    expect(safeHref(base + "a/../".repeat(600))).toBeNull();
    expect(safeHref(base + "a/../".repeat(6))).toBe(base);
  });

  it("still goes through the template's escaping when it is used", () => {
    const href = safeHref("https://example.invalid/a?b=1&c=2");
    expect(html`<a href="${href}">Open the app</a>`.text).toBe(`<a href="https://example.invalid/a?b=1&amp;c=2">Open the app</a>`);
    // A quote in an address is written out by the browser's reading of it, so it cannot close the attribute.
    expect(safeHref(`https://example.invalid/a?b="1"&c='2'`)).toBe("https://example.invalid/a?b=%221%22&c=%272%27");
  });
});
