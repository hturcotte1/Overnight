// SYNTHETIC: every title, pitch, quote and line in these tests is made up by the demo's seed. None of it is Bee data.
//
// Everything on a page that came from speech or from a model is untrusted text. Here every such
// field of the invented scene ends with markup, a quote that tries to close an attribute, a
// script's closing tag, a character that turns text round and a 300-letter word; the published
// links are a script, a data address and a web address with markup in it; and the logs carry an
// idea id and a step name that are markup too. The pages, as the server sends them, must hold
// all of it as plain text. (test/browser.test.ts asks a real browser the same question.)
import { afterEach, describe, expect, it } from "vitest";
import { HOSTILE_LINKS, HOSTILE_STRINGS } from "../src/demo/seed.ts";
import type { FilmingPolicy } from "../src/types.ts";
import { closeServers, FILMING, pageAddresses, removeScratch, seeded, serve } from "./demo-server.ts";

afterEach(async () => {
  await closeServers();
  removeScratch();
});

const MODES: Array<[string, FilmingPolicy | undefined]> = [
  ["showing what was said", undefined],
  ["filming", FILMING],
];

describe.each(MODES)("a scene whose every text is hostile, %s", (_mode, filming) => {
  it("is on every page as text and nowhere as markup", async () => {
    const scene = seeded({ hostile: true });
    const served = await serve(scene, { filming });
    let probesSeen = 0;
    for (const address of [...pageAddresses(scene.ideaIds), "/nope", "/ideas/idea_20261012_n0th1ng0"]) {
      const answer = await served.get(address);
      const page = answer.text;
      expect(answer.status, address).toBeLessThan(500);
      // No element of the attacker's making, and no attribute of it either.
      expect(page, address).not.toContain("<xss-probe");
      expect(page, address).not.toContain("<img src=x");
      expect(page, address).not.toContain('" data-xss-probe=');
      expect(page, address).not.toMatch(/data-xss-probe\s*=\s*["']?1/);
      // No link that runs something, no style attribute, no inline handler.
      expect(page, address).not.toMatch(/(href|src)\s*=\s*["']?\s*(javascript|data|vbscript):/i);
      expect(page, address).not.toContain('style="');
      expect(page, address).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      // One script in all, the dashboard's own, and its closing tag is the only one.
      expect(page.match(/<script\b/gi)?.length ?? 0, address).toBe(1);
      expect(page.match(/<\/script/gi)?.length ?? 0, address).toBe(1);
      // No character that turns text round, hides in it, or is a control character.
      expect(page, address).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/);
      // eslint-disable-next-line no-control-regex
      expect(page, address).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
      // Every attribute value is closed by the quote that opened it: no tag has a stray quote in it.
      for (const tag of page.match(/<[a-z][^>]*>/gi) ?? []) expect((tag.match(/"/g)?.length ?? 0) % 2, `${address}: ${tag.slice(0, 80)}`).toBe(0);
      probesSeen += page.split("&lt;xss-probe&gt;").length - 1;
    }
    // The hostile text did reach the pages, as text. (While filming, less of it: quotes and unapproved ideas are hidden.)
    expect(probesSeen).toBeGreaterThan(20);
    expect(served.logged).toEqual([]);
  });

  it("makes a link only of a real https address, and writes the others out as text", async () => {
    const scene = seeded({ hostile: true });
    const served = await serve(scene, { filming });
    const script = (await served.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text;
    expect(script).toContain(`Published at ${HOSTILE_LINKS.packingChecklist} (shown as text, because it is not an https address)`);
    expect(script).not.toContain("Open the app");
    const data = (await served.get(`/ideas/${scene.ideaIds.practiceDiceRoller}`)).text;
    expect(data).toContain("Published at data:text/html,&lt;script&gt;alert(1)&lt;/script&gt; (shown as text");
    expect(data).not.toContain("Open the app");
    // The web address with markup in it: a link to that very address with its markup made harmless, or text. Never markup.
    const web = (await served.get(`/ideas/${scene.ideaIds.readingLog}`)).text;
    const hrefs = Array.from(web.matchAll(/<a class="button" href="([^"]*)" target="_blank" rel="noopener noreferrer">/g), (match) => match[1] ?? "");
    for (const href of hrefs) {
      expect(href.startsWith("https://example.invalid/overnight-apps/")).toBe(true);
      expect(href).not.toMatch(/[<>'\s]/);
    }
    expect(hrefs.length === 1 || web.includes("(shown as text, because it is not an https address)")).toBe(true);
    expect(web).not.toContain("onmouseover=\"");
    // No card or row offers one of them as a link either. (In this scene the idea Today leads with is still being built, so these three pages link nowhere outside the dashboard.)
    for (const address of ["/", "/ideas", "/nights"]) {
      const outside = Array.from((await served.get(address)).text.matchAll(/(?:href|src)="([^"]*)"/g), (match) => match[1] ?? "").filter((target) => !target.startsWith("/"));
      expect(outside, address).toEqual([]);
    }
  });
});

describe("the hostile strings themselves", () => {
  it("are the ones the design names", () => {
    expect(HOSTILE_STRINGS).toContain("<xss-probe>");
    expect(HOSTILE_STRINGS).toContain('" data-xss-probe="1');
    expect(HOSTILE_STRINGS).toContain("'><img src=x onerror=1>");
    expect(HOSTILE_STRINGS).toContain("</script>");
    expect(HOSTILE_STRINGS.some((text) => text.includes("\u202e"))).toBe(true);
    expect(HOSTILE_STRINGS.some((text) => /^\S{300}$/.test(text))).toBe(true);
    expect(HOSTILE_LINKS.packingChecklist).toBe("javascript:alert(1)");
  });

  it("show on a page exactly as they were written, letter for letter", async () => {
    const scene = seeded({ hostile: true });
    const served = await serve(scene);
    const page = (await served.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text;
    expect(page).toContain("Packing Checklist &lt;xss-probe&gt; &quot; data-xss-probe=&quot;1 &#39;&gt;&lt;img src=x onerror=1&gt; &lt;/script&gt; desrever ");
    expect(page).toContain("W".repeat(300));
  });
});
