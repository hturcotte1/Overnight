// SYNTHETIC: every title, pitch, quote and line in these tests is made up by the demo's seed. None of it is Bee data.
//
// What the dashboard never shows, tried over real HTTP on a scene whose every private text
// carries a mark: each heard line, each quote, each build notes file, and the title and pitch of
// each idea nobody has approved. If a mark turns up in an answer it should not be in, a real
// line, quote or name would have turned up there too.
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_IDEA_KEYS, DEMO_STATES, LINE_SENTINEL, NOTES_SENTINEL, PITCH_SENTINEL, QUOTE_SENTINEL, TITLE_SENTINEL } from "../src/demo/seed.ts";
import type { DemoIdeaKey } from "../src/demo/seed.ts";
import type { FilmingPolicy } from "../src/types.ts";
import { closeServers, FILMING, pageAddresses, removeScratch, scratch, seeded, serve } from "./demo-server.ts";
import type { Seeded, Served } from "./demo-server.ts";

afterEach(async () => {
  await closeServers();
  removeScratch();
});

const numberOf = (key: DemoIdeaKey): number => DEMO_IDEA_KEYS.indexOf(key) + 1;
/** The ideas nobody has said yes to: filming hides their titles and pitches. */
const NOT_APPROVED = DEMO_IDEA_KEYS.filter((key) => ["heard", "asked", "rejected", "expired"].includes(DEMO_STATES[key]));
/** The ideas somebody said (a rehearsal idea was typed, not said, and has no quote). */
const SAID = DEMO_IDEA_KEYS.filter((key) => !key.startsWith("practice"));

/** Every answer the dashboard can give about this scene, as text: its headers and its body. */
async function everyAnswer(served: Served, scene: Seeded): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  const keep = async (name: string, address: string, cookie = true): Promise<void> => {
    const answer = await served.get(address, { cookie });
    expect(answer.status, name).toBeLessThan(500);
    answers.set(name, `${[...answer.headers].map(([header, value]) => `${header}: ${value}`).join("\n")}\n\n${answer.text}`);
  };
  for (const address of pageAddresses(scene.ideaIds)) await keep(address, address);
  await keep("without the key", "/", false);
  await keep("an idea's page without the key", `/ideas/${scene.ideaIds.plantWateringDays}`, false);
  await keep("no such page", "/nope");
  await keep("no such idea", "/ideas/idea_20261012_n0th1ng0");
  await keep("the key link", served.keyUrl, false);
  for (const asset of ["/assets/app.css", "/assets/app.js", "/assets/icon.svg"]) await keep(asset, asset);
  expect(served.logged).toEqual([]);
  return answers;
}

/** The numbers of the marks of one kind found anywhere in the answers. */
function marks(answers: ReadonlyMap<string, string>, sentinel: string): number[] {
  const found = new Set<number>();
  for (const text of answers.values()) for (const match of text.matchAll(new RegExp(`${sentinel}(\\d+)`, "g"))) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

function expectNowhere(answers: ReadonlyMap<string, string>, text: string): void {
  for (const [name, answer] of answers) expect(answer.includes(text), `${text} in the answer for ${name}`).toBe(false);
}

describe("the lines Bee heard", () => {
  it.each([
    ["showing what was said", undefined],
    ["filming", FILMING],
  ] as Array<[string, FilmingPolicy | undefined]>)("are in no answer, %s", async (_mode, filming) => {
    const scene = seeded({ sentinels: true });
    const answers = await everyAnswer(await serve(scene, { filming }), scene);
    expect(answers.size).toBeGreaterThan(20);
    expectNowhere(answers, LINE_SENTINEL);
    // The count of them is what the page shows instead.
    expect(answers.get("/")).toContain(">214<");
  });
});

describe("without filming", () => {
  it("each idea's quote is on its own page and under its Heard step, and nothing is hidden", async () => {
    const scene = seeded({ sentinels: true });
    const served = await serve(scene);
    const answers = await everyAnswer(served, scene);
    for (const key of SAID) expect(answers.get(`/ideas/${scene.ideaIds[key]}`), key).toContain(`${QUOTE_SENTINEL}${numberOf(key)} `);
    expect(marks(answers, QUOTE_SENTINEL)).toEqual(SAID.map(numberOf).sort((a, b) => a - b));
    expect(marks(answers, TITLE_SENTINEL)).toEqual(NOT_APPROVED.map(numberOf).sort((a, b) => a - b));
    expect(marks(answers, PITCH_SENTINEL)).toEqual(NOT_APPROVED.map(numberOf).sort((a, b) => a - b));
    expect(answers.get(`/ideas/${scene.ideaIds.packingChecklist}`)).toContain(NOTES_SENTINEL);
    // The pages that need no key and the ones that lead nowhere carry none of it.
    for (const name of ["without the key", "an idea's page without the key", "no such page", "no such idea", "the key link", "/assets/app.js", "/settings"]) expect(answers.get(name), name).not.toContain("SENTINEL");
  });
});

describe("while filming", () => {
  it("no quote, no build notes and no title or pitch of an idea nobody approved is in any answer", async () => {
    const scene = seeded({ sentinels: true });
    const answers = await everyAnswer(await serve(scene, { filming: FILMING }), scene);
    expectNowhere(answers, "SENTINEL");
    // What stands there instead.
    for (const key of NOT_APPROVED) {
      const page = answers.get(`/ideas/${scene.ideaIds[key]}`) ?? "";
      expect(page, key).toContain("An idea (hidden while filming)");
      expect(page, key).toContain("Hidden while filming");
    }
    // An approved idea keeps its title; only what was said about it is gone.
    const approved = answers.get(`/ideas/${scene.ideaIds.packingChecklist}`) ?? "";
    expect(approved).toContain("Packing Checklist");
    expect(approved).toContain("Build notes are hidden while filming.");
  });

  it("--show-quote lets exactly the one agreed quote through", async () => {
    const scene = seeded({ sentinels: true });
    const answers = await everyAnswer(await serve(scene, { filming: { on: true, showQuoteFor: new Set([scene.ideaIds.packingChecklist]) } }), scene);
    expect(marks(answers, QUOTE_SENTINEL)).toEqual([numberOf("packingChecklist")]);
    expectNowhere(answers, TITLE_SENTINEL);
    expectNowhere(answers, PITCH_SENTINEL);
    expectNowhere(answers, NOTES_SENTINEL);
    expectNowhere(answers, LINE_SENTINEL);
  });

  it("--show-quote for an idea nobody approved shows that idea whole, and no other", async () => {
    const scene = seeded({ sentinels: true });
    const answers = await everyAnswer(await serve(scene, { filming: { on: true, showQuoteFor: new Set([scene.ideaIds.plantWateringDays]) } }), scene);
    const only = [numberOf("plantWateringDays")];
    expect(marks(answers, QUOTE_SENTINEL)).toEqual(only);
    expect(marks(answers, TITLE_SENTINEL)).toEqual(only);
    expect(marks(answers, PITCH_SENTINEL)).toEqual(only);
    expectNowhere(answers, NOTES_SENTINEL);
  });
});

describe("where things are on this Mac", () => {
  it.each([
    ["showing what was said", undefined],
    ["filming", FILMING],
  ] as Array<[string, FilmingPolicy | undefined]>)("is in no answer: the home folder is shown as ~, %s", async (_mode, filming) => {
    // A pretend home folder, with the data folder inside it as ~/.overnight is inside the real one.
    const home = scratch();
    const scene = seeded({ sentinels: true, inHome: home });
    // An agent's notes and a brief that name the folder in full, as a build agent's notes may.
    const inFull = `${home}/overnight-data/workspaces/invented/dist/index.html`;
    // The notes also name it the two other ways a Mac takes for the same folder: under the disk's own name, and in other capitals.
    const otherSpellings = `By the disk's name: /System/Volumes/Data${home}/x\nIn capitals: ${home.toUpperCase()}/y\n`;
    appendFileSync(path.join(scene.paths.built, scene.ideaIds.packingChecklist, "BUILD_NOTES.md"), `\nThe built page is at ${inFull}\n${otherSpellings}`);
    appendFileSync(path.join(scene.paths.ideas, scene.ideaIds.packingChecklist, "brief.md"), `\nInvented line: see ${inFull}\n`);
    const answers = await everyAnswer(await serve(scene, { filming, home }), scene);

    expectNowhere(answers, home);
    // The same folder by its other name (on a Mac /var is a link to /private/var).
    expectNowhere(answers, home.replace(/^\/private/, ""));
    expectNowhere(answers, path.basename(home));
    // The real home folder of whoever runs the tests has no business on a page either.
    expectNowhere(answers, homedir());
    expect(answers.get("/settings")).toContain("~/overnight-data");
    const page = answers.get(`/ideas/${scene.ideaIds.packingChecklist}`) ?? "";
    expect(page).toContain("Invented line: see ~/overnight-data/workspaces/invented/dist/index.html");
    if (filming === undefined) {
      expect(page).toContain("The built page is at ~/overnight-data/workspaces/invented/dist/index.html");
      expect(page).toContain("By the disk&#39;s name: ~/x\nIn capitals: ~/y");
    }
    expectNowhere(answers, home.toUpperCase());
    expectNowhere(answers, path.basename(home).toUpperCase());
    expectNowhere(answers, "/System/Volumes/Data");
  });
});
