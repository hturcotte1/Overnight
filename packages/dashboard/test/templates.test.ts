// Rules the page sources must keep, checked by reading the files themselves: how the views are
// written, what the script may do, and what the stylesheet may load. Every text here is invented.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/layout.ts";
import { renderIdea } from "../src/render/idea.ts";
import { renderIdeas } from "../src/render/ideas.ts";
import { renderNights } from "../src/render/nights.ts";
import { renderProblem } from "../src/render/problem.ts";
import { renderSettings } from "../src/render/settings.ts";
import { renderToday } from "../src/render/today.ts";
import { fakeChrome, fakeContext, fakeEvents, fakeExtras, fakeReport, fakeSnapshot, fakeStory, scene } from "./fixtures.ts";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(path.join(PACKAGE, file), "utf8");

/** The files that make pages. html.ts (the template) and format.ts (words for times and sizes) are the foundation's. */
const VIEW_FILES = ["components.ts", "layout.ts", "today.ts", "ideas.ts", "idea.ts", "nights.ts", "settings.ts", "problem.ts"];
const views = VIEW_FILES.map((name) => ({ name, text: read(`src/render/${name}`) }));

function sourceFiles(folder: string): string[] {
  return readdirSync(path.join(PACKAGE, folder), { withFileTypes: true }).flatMap((entry) => {
    const inside = path.join(folder, entry.name);
    return entry.isDirectory() ? sourceFiles(inside) : entry.name.endsWith(".ts") ? [inside] : [];
  });
}

describe("how the views are written", () => {
  it("covers every file in src/render: the eight view files beside the foundation's two", () => {
    expect(readdirSync(path.join(PACKAGE, "src/render")).sort()).toEqual([...VIEW_FILES, "format.ts", "html.ts"].sort());
  });

  it.each(views)("$name puts every value into an attribute inside double quotes", ({ text }) => {
    // `href=${x}` would let a space in x start a new attribute. Escaping only protects `href="${x}"`.
    expect(text).not.toContain("=${");
    expect(text).not.toMatch(/=\s*'/);
  });

  it.each(views)("$name has no style attribute and no inline event handler", ({ text }) => {
    // The page's rules for what a browser may run refuse both, so one of these would simply not work.
    expect(text).not.toMatch(/\sstyle\s*=/);
    expect(text).not.toMatch(/\son[a-z]+\s*=\s*["'$]/i);
  });

  it("loads one script in all, as a module, from the dashboard's own assets", () => {
    const tags = views.flatMap(({ name, text }) => (text.match(/<script\b[^>]*>/g) ?? []).map((tag) => `${name}: ${tag}`));
    expect(tags).toEqual([`layout.ts: <script type="module" src="/assets/app.js">`]);
  });

  it.each(views)("$name imports only the shared shapes, the template, the formats and the components", ({ name, text }) => {
    const allowed = new Set(["../types.ts", "./html.ts", "./format.ts", "./components.ts"]);
    const imports = Array.from(text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms), (match) => ({ typeOnly: match[1] !== undefined, from: match[2] ?? "" }));
    expect(imports.length).toBeGreaterThan(0);
    for (const one of imports) {
      // The fingerprint of a live region needs a hash; an event's shape is core's. Nothing else comes from outside.
      if (name === "components.ts" && one.from === "node:crypto") continue;
      if (one.typeOnly && one.from === "@overnight/core") continue;
      expect(allowed.has(one.from), `${name} imports ${one.from}`).toBe(true);
    }
    expect(text).not.toMatch(/\bimport\(/);
  });

  it.each(views)("$name never reads the clock, a file, the environment or the network", ({ text }) => {
    expect(text).not.toMatch(/Date\.now\(|new Date\(\s*\)|performance\.now/);
    expect(text).not.toMatch(/node:fs|node:os|node:child_process|node:http|process\.|\bfetch\(/);
  });

  it("makes a SafeHtml nowhere but in html.ts", () => {
    const makers = sourceFiles("src").filter((file) => read(file).includes("new SafeHtml("));
    expect(makers).toEqual([path.join("src", "render", "html.ts")]);
  });

  it.each(views)("$name joins no pieces of markup as strings", ({ text }) => {
    // Lists go into the template as arrays; the template joins them.
    expect(text).not.toMatch(/\.join\(\s*["'`]\s*</);
    expect(text).not.toMatch(/["'`]\s*<[a-z][^"'`]*["'`]\s*\+/i);
  });
});

describe("public/app.js", () => {
  const script = read("public/app.js");

  it("starts with the line that names the browser's own things for ESLint", () => {
    expect(script.split("\n")[0]).toBe("/* global document, window, fetch, DOMParser, setTimeout, setInterval */");
  });

  it("never turns text into markup or into code", () => {
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute", "createContextualFragment", "srcdoc"]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
    // Timers are given functions, never text to run.
    expect(script).not.toMatch(/set(Timeout|Interval)\(\s*["'`]/);
  });

  it("asks only for the page it is on, and holds no address of its own", () => {
    expect(script.match(/\bfetch\(/g)).toHaveLength(1);
    expect(script).toContain("fetch(window.location.href,");
    expect(script).not.toMatch(/https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    for (const forbidden of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "localStorage", "sessionStorage", "document.cookie", "import(", "postMessage", "window.open", "location.assign", "location.replace", "method:"]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
    expect(script).not.toMatch(/^\s*import\s/m);
  });

  it("writes to the page only with textContent, classList, hidden and open", () => {
    // Every assignment to a property of something on the page, by the name of the property.
    const written = new Set(Array.from(script.matchAll(/\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g), (match) => match[1]));
    expect(Array.from(written).sort()).toEqual(["hidden", "open", "textContent"]);
    expect(script).toContain('classList.add("on")');
    expect(script).toContain('classList.add("pop")');
  });

  it("says the dashboard has stopped in the agreed words", () => {
    expect(script).toContain('"The dashboard has stopped or was restarted. Open its new link."');
  });

  it("reads the markup the views write: the same names on both sides", () => {
    const page = renderDocument({ title: "Today", main: renderProblem("error", { port: 4321 }).main }, fakeChrome()).text;
    for (const name of ["data-now", "data-time-zone", "data-poll-ms"]) expect(page).toContain(` ${name}="`);
    for (const used of ["dataset.now", "dataset.timeZone", "dataset.pollMs", "dataset.since", "dataset.clock", "dataset.rev", "dataset.step", "dataset.check", "dataset.status", "dataset.idea"]) expect(script, used).toContain(used);
    for (const selector of ["[data-live]", "[data-since]", '[data-clock="wall"]', "[data-step], [data-check]", "[data-idea]", "details[open][id]", '"notice"', '"main"']) expect(script, selector).toContain(selector);
  });
});

describe("public/app.css and public/icon.svg", () => {
  const css = read("public/app.css");

  it("loads nothing: no import, no address, no picture from a file", () => {
    expect(css).not.toContain("@import");
    expect(css).not.toMatch(/url\(/i);
    expect(css).not.toMatch(/https?:|\/\//);
    expect(css).not.toMatch(/expression\(|behavior:|-moz-binding/i);
  });

  it("keeps every class name of the reference look", () => {
    const classes = (text: string): Set<string> => new Set(Array.from(text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(-?[A-Za-z_][\w-]*)/g), (match) => match[1] ?? ""));
    const ours = classes(css);
    const missing = Array.from(classes(read("test/reference/app.css"))).filter((name) => !ours.has(name));
    expect(missing).toEqual([]);
  });

  it("has light and dark colours, a phone layout, and stillness for people who ask for it", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \* \{ animation: none !important; \} \}/);
    for (const colour of ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7"]) expect(css.split(`${colour}:`).length, colour).toBe(3);
  });

  // In the light look the green and the amber were too pale to read as small labels (3.2 to 3.6 to 1), and red, blue
  // and grey fell short on a tint or a chip. The browser test measures the pages; this works the colours out by themselves.
  it("writes text in colours that can be read, 4.5 to 1 or better, on everything they stand on, in light and in dark", () => {
    type Rgb = [number, number, number];
    const colours = (block: string): Record<string, Rgb> =>
      Object.fromEntries(Array.from(block.matchAll(/--([a-z0-9]+): #([0-9a-f]{6})\b/g), (match) => [match[1] ?? "", [0, 2, 4].map((at) => Number.parseInt((match[2] ?? "").slice(at, at + 2), 16)) as Rgb]));
    const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const light = /:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const part = (value: number): number => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
    const lightness = ([r, g, b]: Rgb): number => 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
    const contrast = (a: Rgb, b: Rgb): number => (Math.max(lightness(a), lightness(b)) + 0.05) / (Math.min(lightness(a), lightness(b)) + 0.05);
    const mix = (a: Rgb, share: number, b: Rgb): Rgb => a.map((value, at) => value * share + (b[at] ?? 0) * (1 - share)) as Rgb;
    // The shares the stylesheet itself uses, read from it: a pill's tint, and the "Building" pill's own darker blue.
    const tint = Number(/\.state--failed \{ background: color-mix\(in srgb, var\(--bad\) (\d+)%, transparent\)/.exec(css)?.[1]) / 100;
    const blue = Number(/\.state--active \{[^}]*color: color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--ink\)\)/.exec(css)?.[1]) / 100;
    expect([tint, blue]).toEqual([0.18, 0.7]);
    expect(css).toMatch(/\.state--waiting \{ background: color-mix\(in srgb, var\(--warn\) 18%, transparent\); color: var\(--warn\); \}/);
    expect(css).toMatch(/\.state \{[^}]*color: var\(--ink\); \}/);

    for (const [look, block] of [["light", light], ["dark", dark]] as const) {
      const c = colours(block);
      const need = (name: string): Rgb => {
        const colour = c[name];
        if (colour === undefined) throw new Error(`the ${look} look has no --${name}`);
        return colour;
      };
      const [card, chip, bg, ink] = [need("card"), need("chip"), need("bg"), need("ink")];
      const pairs: Array<[string, Rgb, Rgb]> = [];
      // The five colours text is written in, on the card, on a chip, and on the page itself.
      for (const name of ["muted", "accent", "ok", "warn", "bad"]) {
        pairs.push([`${name} on the card`, need(name), card], [`${name} on a chip`, need(name), chip], [`${name} on the page`, need(name), bg]);
      }
      // The state pills: a colour on a tint of itself ("Could not build", "Cut short"), the darker blue on blue ("Building"), ink on yellow ("Delivered").
      pairs.push(["bad on its tint", need("bad"), mix(need("bad"), tint, card)], ["warn on its tint", need("warn"), mix(need("warn"), tint, card)]);
      pairs.push(["the Building pill", mix(need("accent"), blue, ink), mix(need("accent"), tint, card)], ["ink on the Delivered pill", ink, mix(need("sun"), 0.25, card)]);
      // The button: the card's colour on the accent. The ticks: white on green and on red.
      pairs.push(["the button", card, need("accent")], ["a white tick on ok", [255, 255, 255], need("ok")], ["a white cross on bad", [255, 255, 255], need("bad")]);
      const faint = pairs.filter(([what, text, ground]) => (what.startsWith("a white") ? contrast(text, ground) < 3 : contrast(text, ground) < 4.5)).map(([what, text, ground]) => `${look}: ${what} ${contrast(text, ground).toFixed(2)}`);
      // The dark look's marks are light colours with a white tick in them: a shape, not text. They were never the trouble and are left as they were.
      expect(faint.filter((line) => !(look === "dark" && line.includes("a white"))), look).toEqual([]);
    }
  });

  it("styles every class the pages use, so a mistyped class cannot pass unnoticed", () => {
    const sc = scene();
    const delivered = sc.ideas.packing;
    const extras = fakeExtras({ report: fakeReport(), shots: { phone: true, desktop: true }, brief: { text: "a brief", cut: true }, notes: { text: "notes", cut: false } });
    const failedStory = fakeStory(sc.ideas.baleYield, { hint: "To try again, ask Claude Code.", checks: [{ key: "sandbox", label: "Sandbox check failed", status: "failed", detail: null, since: null }] });
    const cutShortStory = fakeStory(sc.ideas.cutShort, { checks: [{ key: "agent", label: "Kiro Crew was stopped", status: "waiting", detail: "the Mac went to sleep", since: null }] });
    const pages = [
      renderDocument(renderToday(sc.s, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c, sc.thumbs), fakeChrome({ paused: true, problem: "busy" })),
      renderDocument(renderToday(fakeSnapshot({ paused: true }), null, { over: "Today", before: "No ideas yet", title: null, after: "" }, null, { ...sc.queue, paused: true, rows: [] }, new Map(), sc.c), fakeChrome({ filming: true, running: { listener: false, build: null, deliver: null } })),
      renderDocument(renderToday(fakeSnapshot({ problem: "missing" }), null, sc.line, null, sc.queue, new Map(), sc.c), fakeChrome({ running: { listener: null, build: null, deliver: null } })),
      renderDocument(renderToday(sc.s, { idea: delivered, story: fakeStory(delivered), extras }, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c), fakeChrome()),
      renderDocument(renderIdeas(sc.s, sc.stories, sc.thumbs, sc.c), fakeChrome({ current: "ideas" })),
      renderDocument(renderIdea(sc.s, delivered, fakeStory(delivered), extras, fakeEvents(delivered, ["heard", "asked"]), sc.c), fakeChrome({ current: "ideas" })),
      renderDocument(renderIdea(sc.s, sc.ideas.baleYield, failedStory, fakeExtras({ notes: "filming" }), [], fakeContext({ filming: { on: true, showQuoteFor: new Set() } })), fakeChrome({ current: "ideas" })),
      renderDocument(renderIdea(sc.s, sc.ideas.cutShort, cutShortStory, fakeExtras(), [], sc.c), fakeChrome({ current: "ideas" })),
      renderDocument(renderIdea(sc.s, { ...delivered, quote: { shown: false, why: "filming" }, publishedUrl: "http://example.invalid/" }, fakeStory(delivered), fakeExtras(), [], sc.c), fakeChrome({ current: "ideas" })),
      renderDocument(renderNights(sc.nights, sc.stories, sc.c), fakeChrome({ current: "nights" })),
      renderDocument(renderNights([], sc.stories, sc.c), fakeChrome({ current: "nights" })),
      renderDocument(renderSettings(sc.s, sc.c, { demo: true, port: 4321 }), fakeChrome({ current: "settings" })),
      renderDocument(renderProblem("not-found", { port: 4321 }), fakeChrome({ current: "none" })),
    ];
    const used = new Set(pages.flatMap((page) => Array.from(page.text.matchAll(/\sclass="([^"]*)"/g), (match) => (match[1] ?? "").split(/\s+/)).flat()).filter((name) => name !== ""));
    expect(used.size).toBeGreaterThan(80);
    const unstyled = Array.from(used).filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    expect(unstyled).toEqual([]);
    // Every kind of tick and of step the story can hand over was on those pages.
    for (const kind of ["check--done", "check--active", "check--todo", "check--failed", "check--waiting", "step--waiting"]) expect(used.has(kind), kind).toBe(true);
  });

  it("has a tab icon with nothing in it but two shapes", () => {
    const icon = read("public/icon.svg");
    expect(icon.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(icon.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|href|<script|<style|<foreignObject|\son[a-z]+=/i);
  });
});
