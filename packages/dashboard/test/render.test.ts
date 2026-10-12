// The pages, rendered from hand-made fixtures. Every title, pitch, quote and time here is invented.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBudget } from "@overnight/core";
import type { BuildBudget, IdeaState } from "@overnight/core";
import { buildSeconds, checksRow, count, dotted, ideaCard, ideaHref, live, miniStory, openTheApp, shortTime, shotSrc, sinceClock, stateLabel, statePill, stateTime, storySteps } from "../src/render/components.ts";
import type { Clock } from "../src/render/components.ts";
import { html } from "../src/render/html.ts";
import { renderIdea } from "../src/render/idea.ts";
import { renderIdeas } from "../src/render/ideas.ts";
import { renderDocument } from "../src/render/layout.ts";
import { renderNights } from "../src/render/nights.ts";
import { renderProblem } from "../src/render/problem.ts";
import { renderSettings } from "../src/render/settings.ts";
import { renderToday } from "../src/render/today.ts";
import type { BuildHold, DashIdea, HeardGroup, Night, Story, TonightQueue, View } from "../src/types.ts";
import { boise, DAY_START, fakeChrome, fakeConfig, fakeContext, fakeEvents, fakeExtras, fakeIdea, fakeReport, fakeSnapshot, fakeStory, HOME, HOSTILE, NOW, scene, TIME_ZONE } from "./fixtures.ts";

const K: Clock = { timeZone: TIME_ZONE, now: NOW, dayStart: DAY_START };

/** The ids of the live regions in a piece of a page, in order. */
function liveIds(text: string): string[] {
  return Array.from(text.matchAll(/<section id="([^"]+)"(?: class="[^"]*")? data-live data-rev="[0-9a-f]{12}">/g), (match) => match[1] ?? "");
}

/** What is inside one region. Regions never sit inside each other. */
function region(text: string, id: string): string {
  const match = new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(text);
  if (match === null) throw new Error(`no region #${id}`);
  return match[1] ?? "";
}

function rev(text: string, id: string): string {
  return new RegExp(`<section id="${id}"[^>]*data-rev="([0-9a-f]+)"`).exec(text)?.[1] ?? "";
}

/** How often a piece of text appears. */
function times(text: string, piece: string): number {
  return text.split(piece).length - 1;
}

function todayOf(sc = scene(), over: { thumbs?: boolean } = {}): string {
  return renderToday(sc.s, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c, over.thumbs === false ? undefined : sc.thumbs).main.text;
}

// ---------- components ----------

describe("live()", () => {
  it("marks a region with its id, data-live and a 12-character fingerprint of what is inside", () => {
    const body = html`<p>${"Chore Wheel"}</p>`;
    const expected = createHash("sha1").update("<p>Chore Wheel</p>").digest("hex").slice(0, 12);
    expect(live("story", body).text).toBe(`<section id="story" data-live data-rev="${expected}"><p>Chore Wheel</p></section>`);
    expect(live("story", body, "card hero").text).toBe(`<section id="story" class="card hero" data-live data-rev="${expected}"><p>Chore Wheel</p></section>`);
  });

  it("gives the same fingerprint for the same inside and another for a changed one", () => {
    expect(rev(live("a", html`<b>1</b>`).text, "a")).toBe(rev(live("a", html`<b>1</b>`).text, "a"));
    expect(rev(live("a", html`<b>1</b>`).text, "a")).not.toBe(rev(live("a", html`<b>2</b>`).text, "a"));
  });
});

describe("times", () => {
  it("writes a clock time alone inside the page's day or on today's date, and the day with anything older", () => {
    expect(shortTime(boise(10, 12, 41), K)).toBe("12:41 PM"); // yesterday afternoon, seen at 1:02 AM: still the page's day
    expect(shortTime(boise(11, 1, 0), K)).toBe("1:00 AM");
    expect(shortTime(boise(10, 6, 59), K)).toBe("yesterday, 6:59 AM"); // before the day began
    expect(shortTime(boise(8, 18, 2), K)).toBe("Oct 8, 6:02 PM");
    // In the morning, the night's own times are on today's date although the page's day has just begun.
    const morning: Clock = { timeZone: TIME_ZONE, now: new Date(boise(11, 7, 30)), dayStart: boise(11, 7) };
    expect(shortTime(boise(11, 1, 3), morning)).toBe("1:03 AM");
    expect(shortTime(boise(10, 12, 41), morning)).toBe("yesterday, 12:41 PM");
  });

  it("writes a running clock with words that stay the same while the fact does", () => {
    const at = boise(11, 1, 0, 48);
    expect(sinceClock(at, "elapsed", K).text).toBe(`<time datetime="${at}" data-since="${at}" data-clock="elapsed">since 1:00 AM</time>`);
    expect(sinceClock(at, "ago", K).text).toBe(`<time datetime="${at}" data-since="${at}" data-clock="ago">at 1:00 AM</time>`);
    const later: Clock = { ...K, now: new Date(NOW.getTime() + 59 * 60_000) };
    expect(sinceClock(at, "elapsed", later).text).toBe(sinceClock(at, "elapsed", K).text);
  });
});

describe("the seven-step story", () => {
  const sc = scene();
  const steps = storySteps(sc.hero.story, K).text;

  it("writes seven steps in order, each with its key and its status", () => {
    const found = Array.from(steps.matchAll(/<li class="step step--([a-z]+)[^"]*" data-step="([a-z]+)" data-status="([a-z]+)"/g), (match) => [match[2], match[1], match[3]]);
    expect(found).toEqual([
      ["heard", "done", "done"],
      ["asked", "done", "done"],
      ["approved", "done", "done"],
      ["built", "active", "active"],
      ["checked", "todo", "todo"],
      ["published", "todo", "todo"],
      ["delivered", "todo", "todo"],
    ]);
    expect(steps.startsWith(`<ol class="story" data-idea="${sc.hero.idea.id}">`)).toBe(true);
  });

  it("marks the active step, and only that one, as the current step", () => {
    expect(times(steps, 'aria-current="step"')).toBe(1);
    expect(steps).toContain('data-step="built" data-status="active" aria-current="step">');
  });

  it("draws the line on from a finished step only when the next one has been reached", () => {
    const out = Array.from(steps.matchAll(/<li class="([^"]+)" data-step="([a-z]+)"/g), (match) => [match[2], (match[1] ?? "").includes("step--out")]);
    expect(out).toEqual([["heard", true], ["asked", true], ["approved", true], ["built", false], ["checked", false], ["published", false], ["delivered", false]]);
    const approved = storySteps(fakeStory(fakeIdea({ state: "approved" })), K).text;
    expect(approved).toContain('<li class="step step--done" data-step="approved"'); // the next step is still to come
    const delivered = storySteps(fakeStory(scene().ideas.packing), K).text;
    expect(times(delivered, "step--out")).toBe(6); // the last step has no next one
    // Only a finished step sends the line on: a failed one before a running one does not.
    const odd = storySteps(fakeStory(fakeIdea({ state: "approved" }), { steps: { approved: { status: "failed" }, built: { status: "active" } } }), K).text;
    expect(odd).toContain('<li class="step step--failed" data-step="approved" data-status="failed">');
    expect(times(odd, "step--out")).toBe(1);
  });

  it("shows each reached step's time, and its own label", () => {
    expect(steps).toContain(`<b class="step__label">Heard</b><time class="step__time" datetime="${boise(10, 12, 41)}">12:41 PM</time>`);
    expect(steps).toContain('<b class="step__label">Building</b>');
    expect(steps).toContain('<p class="step__detail">Kiro Crew, inside Overnight&#39;s sandbox</p>');
  });

  it("puts what a step still to come is waiting for where its time would be", () => {
    expect(steps).toContain('<b class="step__label">Checked</b><span class="step__time">at 6:30 AM</span></div>');
    expect(steps).not.toContain('<p class="step__detail">at 6:30 AM</p>');
    // A step with nothing to say has only its label.
    expect(steps).toContain('<b class="step__label">Published</b></div>');
  });

  it("shows the quote under Heard in quotation marks, or that it is hidden, or nothing", () => {
    expect(steps).toContain('<p class="step__detail">“it would be cool if a wheel just picked who does the dishes”</p>');
    const filming = storySteps(fakeStory(fakeIdea({ quote: { shown: false, why: "filming" } })), K).text;
    expect(filming).toContain('<p class="step__detail step__hidden">Hidden while filming</p>');
    expect(filming).not.toContain("“");
    const none = storySteps(fakeStory(fakeIdea({ quote: { shown: false, why: "none" } })), K).text;
    expect(none).toContain('<b class="step__label">Heard</b><time class="step__time"');
    expect(none).not.toContain("Hidden while filming");
    expect(none).not.toContain("“");
  });

  it("keeps the words of a step that is waiting or active under its label, not where the time goes", () => {
    const heard = fakeIdea({ state: "heard", askedAt: null, answeredAt: null });
    const waiting = storySteps(fakeStory(heard, { steps: { asked: { detail: "About to ask" } } }), K).text;
    expect(waiting).toContain('<li class="step step--waiting" data-step="asked" data-status="waiting"><span class="step__dot">');
    expect(waiting).toContain('<b class="step__label">Asked</b><p class="step__detail">About to ask</p></div>');
    expect(waiting).not.toContain('<span class="step__time">About to ask</span>');
  });

  it("shows why a step failed", () => {
    const failed = storySteps(fakeStory(scene().ideas.baleYield), K).text;
    expect(failed).toContain('<li class="step step--failed" data-step="built" data-status="failed">');
    expect(failed).toContain('<p class="step__detail">the build ran past its time limit of 45 minutes</p>');
  });
});

describe("the night's ticks", () => {
  const sc = scene();

  it("writes one tick per check, with its key, its status and its small print", () => {
    const row = checksRow(sc.hero.story, K)?.text ?? "";
    expect(row.startsWith(`<ul class="checks" aria-label="The night, step by step" data-idea="${sc.hero.idea.id}">`)).toBe(true);
    expect(Array.from(row.matchAll(/data-check="([a-z-]+)" data-status="([a-z]+)"/g), (match) => `${match[1]}:${match[2]}`)).toEqual(["sign-in:done", "sandbox:done", "agent:active", "built:todo"]);
    expect(row).toMatch(/<li class="check check--done" data-check="sign-in" data-status="done"><span class="check__mark"><svg[^>]*>.*?<\/svg><\/span>Kiro sign-in fresh <small>47 min left<\/small><\/li>/);
    expect(row).toContain('<li class="check check--todo" data-check="built" data-status="todo"><span class="check__mark"></span>Built</li>');
  });

  it("gives a running tick a clock that starts at its `since`", () => {
    const row = checksRow(sc.hero.story, K)?.text ?? "";
    const since = boise(11, 1, 0, 48);
    expect(row).toContain(`<span class="check__mark"></span>Kiro Crew is building <small><time datetime="${since}" data-since="${since}" data-clock="elapsed">since 1:00 AM</time></small></li>`);
  });

  it("draws a tick for done, a cross for failed and nothing for the rest", () => {
    const story: Story = { ...sc.hero.story, checks: [{ key: "a", label: "A", status: "done", detail: null, since: null }, { key: "b", label: "B", status: "failed", detail: "why", since: null }, { key: "c", label: "C", status: "active", detail: "x", since: boise(11, 1) }] };
    const row = checksRow(story, K)?.text ?? "";
    expect(row).toContain('<path d="M4 8.5l2.6 2.6L12 5.6"/></svg></span>A</li>');
    expect(row).toContain('<path d="M5 5l6 6M11 5l-6 6"/></svg></span>B <small>why</small>');
    expect(row).toMatch(/<span class="check__mark"><\/span>C <small>x · <time [^>]*>since 1:00 AM<\/time><\/small>/);
  });

  it("marks a tick that is waiting as its own kind: no tick, no cross, and not a failure", () => {
    // A build that was stopped and gets one more try (story.ts). The stylesheet draws its mark as the step's own dashed amber ring.
    const story: Story = { ...sc.hero.story, checks: [{ key: "agent", label: "Kiro Crew was stopped", status: "waiting", detail: "the Mac went to sleep", since: null }, { key: "built", label: "Not built yet", status: "waiting", detail: null, since: null }] };
    const row = checksRow(story, K)?.text ?? "";
    expect(row).toContain('<li class="check check--waiting" data-check="agent" data-status="waiting"><span class="check__mark"></span>Kiro Crew was stopped <small>the Mac went to sleep</small></li>');
    expect(row).toContain('<li class="check check--waiting" data-check="built" data-status="waiting"><span class="check__mark"></span>Not built yet</li>');
    expect(row).not.toContain("check--failed");
  });

  it("draws the ticks for a build's files smaller than the rest", () => {
    const story: Story = { ...sc.hero.story, checks: [{ key: "mark-project", label: "Project written", status: "done", detail: null, since: null }, { key: "built", label: "Built", status: "todo", detail: null, since: null }] };
    const row = checksRow(story, K)?.text ?? "";
    expect(row).toContain('<li class="check check--done check--small" data-check="mark-project" data-status="done">');
    expect(row).toContain('<li class="check check--todo" data-check="built" data-status="todo">');
  });

  it("is left out when there are no ticks", () => {
    expect(checksRow({ ...sc.hero.story, checks: [] }, K)).toBeNull();
  });
});

describe("the mini story", () => {
  it("is seven dots, one per step, classed by status", () => {
    const sc = scene();
    expect(miniStory(sc.hero.story)?.text).toBe('<ol class="mini" aria-hidden="true"><li class="is-done"></li><li class="is-done"></li><li class="is-done"></li><li class="is-active"></li><li class=""></li><li class=""></li><li class=""></li></ol>');
    expect(miniStory(fakeStory(sc.ideas.baleYield))?.text).toContain('<li class="is-failed"></li>');
    expect(miniStory(fakeStory(sc.ideas.cutShort))?.text).toContain('<li class="is-waiting"></li>');
    expect(times(miniStory(fakeStory(sc.ideas.rejected))?.text ?? "", "is-ended")).toBe(5);
    expect(miniStory(undefined)).toBeNull();
  });
});

describe("state pills", () => {
  it("names every state in the page's words and colours the ones that need it", () => {
    const tone = (state: IdeaState, over: Partial<DashIdea> = {}): string => statePill(fakeIdea({ state, ...over })).text;
    expect(tone("delivered")).toBe('<span class="state state--delivered">Delivered</span>');
    expect(tone("build_failed")).toBe('<span class="state state--failed">Could not build</span>');
    expect(tone("publish_failed")).toBe('<span class="state state--failed">Not published</span>');
    expect(tone("building")).toBe('<span class="state state--active">Building</span>');
    expect(tone("rejected")).toBe('<span class="state state--ended">Not approved</span>');
    expect(tone("expired")).toBe('<span class="state state--ended">No answer</span>');
    expect(tone("approved")).toBe('<span class="state ">Approved</span>');
  });

  it("says a build that gets one more try was cut short, not that it failed", () => {
    const idea = fakeIdea({ state: "build_failed", awaitingRetry: true });
    expect(stateLabel(idea)).toBe("Cut short");
    expect(statePill(idea).text).toBe('<span class="state state--waiting">Cut short</span>');
  });
});

describe("small helpers", () => {
  it("joins the parts that are there with a dot between them", () => {
    expect(dotted(["a", null, "", false, undefined, html`<b>c</b>`, 0]).text).toBe("a · <b>c</b> · 0");
    expect(dotted([null, ""]).text).toBe("");
    expect(dotted(["<x>"]).text).toBe("&lt;x&gt;");
  });

  it("groups thousands in a count", () => {
    expect(count(1204)).toBe("1,204");
    expect(count(0)).toBe("0");
    expect(count(Number.NaN)).toBe("0");
  });

  it("builds an address only from an id that looks like one", () => {
    expect(ideaHref("idea_20261010_ab12cd34")).toBe("/ideas/idea_20261010_ab12cd34");
    expect(shotSrc("idea_20261010_ab12cd34", "desktop")).toBe("/shots/idea_20261010_ab12cd34/desktop.png");
    for (const bad of ["", "../secrets", "a/b", "a b", "a?key=1", "-leading", "x".repeat(81), "a%2e", 'a"b']) {
      expect(ideaHref(bad), bad).toBeNull();
      expect(shotSrc(bad, "phone"), bad).toBeNull();
    }
  });

  it("takes the build time from the log when it has it, else from the idea's two times", () => {
    const idea = fakeIdea({ buildStartedAt: boise(10, 1, 0, 40), builtAt: boise(10, 1, 3, 20) });
    const facts = { startedAt: "", by: "build" as const, signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: { at: "", ok: true, seconds: 139, credits: null }, slept: null, sealed: null };
    expect(buildSeconds(idea, facts)).toBe(139);
    expect(buildSeconds(idea, undefined)).toBe(160);
    expect(buildSeconds(idea, { ...facts, finished: null })).toBe(160);
    expect(buildSeconds(fakeIdea({ buildStartedAt: boise(10, 1), builtAt: null }), undefined)).toBeNull();
    expect(buildSeconds(fakeIdea({ buildStartedAt: boise(10, 2), builtAt: boise(10, 1) }), undefined)).toBeNull(); // a second try began after the first finished
    // The Mac slept during the build: the log gives no seconds for it, and the idea's own two times are mostly sleep.
    const slept = { ...facts, slept: { at: boise(10, 7) }, finished: { at: "", ok: true, seconds: null, credits: null } };
    expect(buildSeconds(fakeIdea({ buildStartedAt: boise(10, 1), builtAt: boise(10, 7, 0, 5) }), slept)).toBeNull();
  });

  it("picks the time that goes with an idea's state", () => {
    // Every time is a different hour, so each state can only be right by picking its own.
    const all = { createdAt: boise(9, 1), askedAt: boise(9, 2), answeredAt: boise(9, 3), buildStartedAt: boise(9, 4), builtAt: boise(9, 5), publishedAt: boise(9, 6), deliveredAt: boise(9, 7), updatedAt: boise(9, 8) };
    const at = (state: IdeaState, over: Partial<DashIdea> = {}): string => stateTime(fakeIdea({ ...all, state, ...over }));
    expect(at("heard")).toBe(all.createdAt);
    expect(at("asked")).toBe(all.askedAt);
    expect(at("approved")).toBe(all.answeredAt);
    expect(at("rejected")).toBe(all.answeredAt);
    expect(at("building")).toBe(all.buildStartedAt);
    expect(at("built")).toBe(all.builtAt);
    expect(at("published")).toBe(all.publishedAt);
    expect(at("delivered")).toBe(all.deliveredAt);
    expect(at("delivered", { deliveredAt: null })).toBe(all.publishedAt);
    // No time of its own, or the time is missing: when the idea last changed.
    for (const state of ["expired", "build_failed", "publish_failed"] as const) expect(at(state), state).toBe(all.updatedAt);
    expect(at("asked", { askedAt: null })).toBe(all.updatedAt);
    expect(at("approved", { answeredAt: null })).toBe(all.updatedAt);
    expect(at("building", { buildStartedAt: null })).toBe(all.updatedAt);
    expect(at("built", { builtAt: null })).toBe(all.updatedAt);
    expect(at("published", { publishedAt: null })).toBe(all.updatedAt);
    expect(at("delivered", { deliveredAt: null, publishedAt: null })).toBe(all.updatedAt);
  });
});

describe("the link to a published app", () => {
  it("links an https address in a new tab that learns nothing about this page", () => {
    const idea = scene().ideas.packing;
    const link = openTheApp(idea)?.text ?? "";
    expect(link).toContain('<a class="button" href="https://example.invalid/overnight-apps/packing-checklist/" target="_blank" rel="noopener noreferrer">Open the app');
    expect(link).toContain('<span class="open__address">https://example.invalid/overnight-apps/packing-checklist/</span>');
    expect(openTheApp(idea, false)?.text).not.toContain("open__address");
  });

  it("shows any other address as text, never as a link", () => {
    for (const address of [HOSTILE.address, "http://example.invalid/app/", "//example.invalid/app", "https://sam:pw@example.invalid/"]) {
      const shown = openTheApp(fakeIdea({ publishedUrl: address }))?.text ?? "";
      expect(shown, address).not.toContain("href=");
      expect(shown, address).not.toContain("<a ");
      expect(shown, address).toContain("Published at ");
    }
  });

  it("is left out for an idea that is not published", () => {
    expect(openTheApp(fakeIdea({ publishedUrl: null }))).toBeNull();
    expect(openTheApp(fakeIdea({ publishedUrl: "" }))).toBeNull();
  });
});

describe("the idea card", () => {
  const sc = scene();
  const options = { story: undefined, thumb: false, facts: undefined, level: 3 as const, timeZone: TIME_ZONE, now: NOW };

  it("shows the title, the state, when, the builder and the build time, and links to the idea's page", () => {
    const card = ideaCard(sc.ideas.packing, { ...options, story: sc.stories.get(sc.ideas.packing.id), facts: sc.s.build.get(sc.ideas.packing.id) }).text;
    expect(card.startsWith(`<a class="card idea" href="/ideas/${sc.ideas.packing.id}">`)).toBe(true);
    expect(card).toContain('<h3 class="idea__title">Packing Checklist</h3>');
    expect(card).toContain('<p class="idea__meta"><span class="state state--delivered">Delivered</span> · <span class="nowrap">yesterday, 7:00 AM</span> · Kiro Crew · <span class="nowrap">2 min 40 s</span></p>');
    expect(card).toContain('<ol class="mini" aria-hidden="true">');
    expect(card).not.toContain("<img");
  });

  it("uses a second-level heading on the Ideas page", () => {
    expect(ideaCard(sc.ideas.packing, { ...options, level: 2 }).text).toContain('<h2 class="idea__title">Packing Checklist</h2>');
  });

  it("shows the phone picture only when there is one", () => {
    const card = ideaCard(sc.ideas.packing, { ...options, thumb: true }).text;
    expect(card).toContain(`<img class="idea__shot" alt="" src="/shots/${sc.ideas.packing.id}/phone.png" width="62" height="110" loading="lazy">`);
  });

  it("gives the reason for a failure, and for nothing else", () => {
    expect(ideaCard(sc.ideas.baleYield, options).text).toContain(" · the build ran past its time limit of 45 minutes</p>");
    expect(ideaCard(sc.ideas.notPublished, options).text).toContain(" · the app did not pass its own test</p>");
    // A reason left over on an idea that later went through is not shown.
    expect(ideaCard({ ...sc.ideas.packing, failureReason: "an old reason" }, options).text).not.toContain("an old reason");
  });

  it("tags a rehearsal", () => {
    expect(ideaCard(sc.ideas.rehearsal, options).text).toContain('<span class="tag tag--plain">Rehearsal</span>');
    expect(ideaCard(sc.ideas.packing, options).text).not.toContain("Rehearsal");
  });

  it("shows no build time for a build that failed, even when the log says how long it ran", () => {
    const facts = { startedAt: "", by: "build" as const, signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: { at: "", ok: false, seconds: 2700, credits: null }, slept: null, sealed: null };
    const card = ideaCard(sc.ideas.baleYield, { ...options, facts }).text;
    expect(card).toContain("Kiro Crew · the build ran past its time limit of 45 minutes</p>");
    expect(card).not.toContain("45 min<");
  });

  it("shows no build time for an idea that was never built", () => {
    expect(ideaCard(sc.ideas.choreWheel, options).text).toContain('<span class="nowrap">today, 1:00 AM</span> · Kiro Crew</p>');
    expect(ideaCard(sc.ideas.lunchTurns, options).text).toContain('<span class="nowrap">yesterday, 3:15 PM</span></p>');
  });

  it("makes no link and no picture from an id that does not look like one", () => {
    const card = ideaCard({ ...sc.ideas.packing, id: "../../etc" }, { ...options, thumb: true }).text;
    expect(card.startsWith('<div class="card idea">')).toBe(true);
    expect(card).not.toContain("href=");
    expect(card).not.toContain("<img");
  });
});

// ---------- the shell ----------

describe("the shell", () => {
  const view: View = { title: "Today", main: html`<p id="inside">inside</p>` };
  const page = (over: Parameters<typeof fakeChrome>[0] = {}, v: View = view): string => renderDocument(v, fakeChrome(over)).text;

  it("is a whole page that tells the script the server's time, its zone and how often to look", () => {
    const text = page({ pollMs: 5000 });
    expect(text.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(text).toContain(`<body data-now="${NOW.getTime()}" data-time-zone="America/Boise" data-poll-ms="5000">`);
    expect(text).toContain('<main id="main">\n<p id="inside">inside</p>\n</main>');
    expect(text.trimEnd().endsWith("</html>")).toBe(true);
    expect(page({ pollMs: 2000 })).toContain('data-poll-ms="2000"');
  });

  it("loads its one stylesheet, its one script and its icon from its own assets", () => {
    const text = page();
    expect(text).toContain('<link rel="stylesheet" href="/assets/app.css">');
    expect(text).toContain('<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">');
    expect(text.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="/assets/app.js">']);
    expect(text).not.toMatch(/\sstyle="/);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("names the page in the tab, with DEMO in front for invented data", () => {
    expect(page({ demo: true })).toContain("<title>DEMO · Today · Overnight</title>");
    expect(page({ demo: false })).toContain("<title>Today · Overnight</title>");
    expect(page({ demo: false }, { title: HOSTILE.closing, main: view.main })).toContain("<title>&lt;/script&gt;&lt;script&gt;window.xssProbe=1&lt;/script&gt; · Overnight</title>");
  });

  it("has four tabs and marks the one being looked at", () => {
    const text = page({ current: "nights" });
    expect(text).toContain('<nav class="nav" aria-label="Views"><a href="/">Today</a><a href="/ideas">Ideas</a><a href="/nights" aria-current="page">Nights</a><a href="/settings">Settings</a></nav>');
    expect(times(page({ current: "today" }), 'aria-current="page"')).toBe(1);
    expect(page({ current: "today" })).toContain('<a href="/" aria-current="page">Today</a>');
  });

  it("keeps its three header regions live: the clock, the pills and the banners", () => {
    const text = page();
    expect(liveIds(text)).toEqual(["clock", "pills", "banners"]);
    expect(region(text, "clock")).toBe('<span data-clock="wall">1:02 AM</span>');
    expect(text).toContain('<div id="notice" class="banner banner--stopped" role="status" hidden></div>');
    expect(text).toContain('<footer class="foot">This page only reads. It answers only on this Mac.</footer>');
  });

  it("says whether Overnight is listening", () => {
    expect(region(page({ running: { listener: true, build: null, deliver: null } }), "pills")).toContain('<span class="pill pill--live" data-pill="listening">Listening</span>');
    expect(region(page({ running: { listener: false, build: null, deliver: null } }), "pills")).toContain('<span class="pill pill--off" data-pill="listening">Not listening</span>');
    expect(region(page({ running: { listener: null, build: null, deliver: null } }), "pills")).toContain('<span class="pill pill--unknown" data-pill="listening">Listening: cannot tell</span>');
  });

  it("says Quiet mode while paused, and not otherwise", () => {
    expect(region(page({ paused: true }), "pills")).toContain('<span class="pill pill--paused" data-pill="paused">Quiet mode</span>');
    expect(region(page({ paused: false }), "pills")).not.toContain("data-pill=\"paused\"");
  });

  it("always says which mode it is in: filming, or showing what was said", () => {
    const filming = region(page({ filming: true }), "pills");
    expect(filming).toContain('<span class="pill pill--film" data-pill="filming">FILMING: what was said is hidden</span>');
    expect(filming).not.toContain('data-pill="private"');
    const showing = region(page({ filming: false }), "pills");
    expect(showing).toContain('<span class="pill" data-pill="private">Shows what was said</span>');
    expect(showing).not.toContain('data-pill="filming"');
  });

  it("marks invented data on every page", () => {
    expect(region(page({ demo: true }), "pills")).toContain('<span class="pill pill--demo" data-pill="demo">DEMO DATA: invented</span>');
    expect(region(page({ demo: false }), "pills")).not.toContain('data-pill="demo"');
    expect(region(page({ demo: true, current: "none" }), "pills")).toContain('data-pill="demo"');
  });

  it("says when the database could not be read, and since when the page is old", () => {
    expect(region(page({ problem: "busy", staleSince: boise(11, 1, 1) }), "banners")).toBe('<p class="banner" role="status">Could not read the database just now. Showing what was read at 1:01 AM. Trying again.</p>');
    // "Just now" is for a database that was busy for a moment. One that cannot be read may stay that way.
    expect(region(page({ problem: "unreadable", staleSince: null }), "banners")).toBe('<p class="banner" role="status">Could not read the database. Trying again.</p>');
    expect(region(page({ problem: "unreadable", staleSince: boise(11, 1, 1) }), "banners")).toBe('<p class="banner" role="status">Could not read the database. Showing what was read at 1:01 AM. Trying again.</p>');
    expect(region(page({ problem: "busy", staleSince: null }), "banners")).toBe('<p class="banner" role="status">Could not read the database just now. Trying again.</p>');
  });

  it("shows no banner when all is well, or when there is simply nothing saved yet", () => {
    for (const problem of [null, "missing", "empty"] as const) expect(region(page({ problem }), "banners"), String(problem)).toBe("");
  });

  it("shows a page with no data in it without tabs, and without saying anything about listening or quotes", () => {
    const text = page({ current: "none", paused: true, filming: false, demo: false });
    expect(text).not.toContain("<nav");
    expect(region(text, "pills")).toBe("");
    expect(text).toContain('<a class="brand" href="/">');
    expect(text).toContain('<p id="inside">inside</p>');
    // The warnings stay.
    expect(region(page({ current: "none", filming: true, demo: true }), "pills")).toBe('<span class="pill pill--film" data-pill="filming">FILMING: what was said is hidden</span><span class="pill pill--demo" data-pill="demo">DEMO DATA: invented</span>');
  });
});

// ---------- Today ----------

describe("Today", () => {
  it("is called Today and always has the same six live regions", () => {
    const sc = scene();
    expect(renderToday(sc.s, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c).title).toBe("Today");
    expect(liveIds(todayOf(sc))).toEqual(["lastnight", "story", "lane-heard", "lane-asked", "lane-tonight", "cards"]);
    const bare = renderToday(fakeSnapshot(), null, { over: "Today", before: "No ideas yet", title: null, after: "" }, null, { at: boise(12, 1), paused: false, limit: 2, hold: null, rows: [] }, new Map(), sc.c).main.text;
    expect(liveIds(bare)).toEqual(["lastnight", "story", "lane-heard", "lane-asked", "lane-tonight", "cards"]);
    // A region with nothing in it is really empty, so the stylesheet can hide it.
    expect(bare).toMatch(/<section id="lastnight" class="lastnight" data-live data-rev="[0-9a-f]{12}"><\/section>/);
    expect(bare).toMatch(/<section id="cards" data-live data-rev="[0-9a-f]{12}"><\/section>/);
  });

  it("does not change while only the clock moves, so nothing is drawn again for no reason", () => {
    const sc = scene();
    const later = { ...sc.c, now: new Date(NOW.getTime() + 40_000) };
    expect(renderToday(sc.s, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, later, sc.thumbs).main.text).toBe(todayOf(sc));
  });

  describe("the hero", () => {
    it("says what is happening now, with the title in quotation marks and linked to the idea", () => {
      const sc = scene();
      const story = region(todayOf(sc), "story");
      expect(story).toContain('<p class="hero__over">Tonight<span class="hero__wall" data-clock="wall"></span></p>');
      expect(story).toContain(`<h1 class="hero__now">Kiro Crew is building <a class="hero__title" href="/ideas/${sc.ideas.choreWheel.id}">“Chore Wheel”</a></h1>`);
      expect(story).toContain('<p class="hero__pitch">Spin a wheel to share out the week&#39;s chores. Add names and chores, spin, and see who does what.</p>');
      expect(story).toContain('<ol class="story"');
      expect(story).toContain('<ul class="checks"');
    });

    it("puts a space between the words and the title whichever way they come", () => {
      const sc = scene();
      const now = (line: Partial<typeof sc.line>, hero: typeof sc.hero | null = sc.hero): string => /<h1 class="hero__now">(.*?)<\/h1>/.exec(renderToday(sc.s, hero, { ...sc.line, ...line }, null, sc.queue, sc.stories, sc.c).main.text)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
      expect(now({ before: "Kiro Crew is building", after: "" })).toBe("Kiro Crew is building “Chore Wheel”");
      expect(now({ before: "Kiro Crew is building ", after: "" })).toBe("Kiro Crew is building “Chore Wheel”");
      expect(now({ before: "", after: "was delivered" })).toBe("“Chore Wheel” was delivered");
      expect(now({ before: "", after: " was delivered" })).toBe("“Chore Wheel” was delivered");
      expect(now({ before: "", after: ", twice" })).toBe("“Chore Wheel”, twice");
      expect(now({ before: "Checking", after: "in the sandbox" })).toBe("Checking “Chore Wheel” in the sandbox");
      expect(now({ before: "Listening. No ideas yet", title: null, after: "" }, null)).toBe("Listening. No ideas yet");
    });

    it("does not put a title that filming replaced in quotation marks", () => {
      const sc = scene();
      const hidden = { ...sc.ideas.heard, title: "An idea (hidden while filming)", pitch: "", hidden: true, quote: { shown: false, why: "filming" } as const };
      const text = renderToday(sc.s, { idea: hidden, story: fakeStory(hidden), extras: fakeExtras() }, { over: "Tonight", before: "Heard", title: hidden.title, after: "" }, null, sc.queue, sc.stories, sc.c).main.text;
      expect(region(text, "story")).toContain(`<h1 class="hero__now">Heard <a class="hero__title" href="/ideas/${hidden.id}">An idea (hidden while filming)</a></h1>`);
      expect(region(text, "story")).not.toContain("hero__pitch");
      expect(region(text, "story")).toContain("Hidden while filming");
    });

    it("has a big running clock while something is running, and none otherwise", () => {
      const sc = scene();
      const since = boise(11, 1, 0, 48);
      expect(region(todayOf(sc), "story")).toContain(`<div class="hero__clock"><b><time datetime="${since}" data-since="${since}" data-clock="elapsed">since 1:00 AM</time></b><span>building</span></div>`);
      const idle = renderToday(sc.s, { idea: sc.ideas.lunchTurns, story: fakeStory(sc.ideas.lunchTurns), extras: fakeExtras() }, sc.line, null, sc.queue, sc.stories, sc.c).main.text;
      expect(region(idle, "story")).not.toContain("hero__clock");
    });

    it("shows the app once it is out: the link and the phone picture", () => {
      const sc = scene();
      const packing = sc.ideas.packing;
      const hero = { idea: packing, story: fakeStory(packing), extras: fakeExtras({ shots: { phone: true, desktop: true } }) };
      const story = region(renderToday(sc.s, hero, { over: "This morning", before: "", title: packing.title, after: "was delivered" }, null, sc.queue, sc.stories, sc.c).main.text, "story");
      expect(story).toContain('<a class="button" href="https://example.invalid/overnight-apps/packing-checklist/" target="_blank" rel="noopener noreferrer">Open the app');
      expect(story).toContain(`<img class="hero__shot" src="/shots/${packing.id}/phone.png" alt="The app on a phone screen" width="84" height="150">`);
      const noPicture = region(renderToday(sc.s, { ...hero, extras: fakeExtras() }, sc.line, null, sc.queue, sc.stories, sc.c).main.text, "story");
      expect(noPicture).not.toContain("<img");
    });

    it("shows the story's hint", () => {
      const sc = scene();
      const story = fakeStory(sc.ideas.baleYield, { hint: `To try again, ask Claude Code to run: npx overnight build-now ${sc.ideas.baleYield.id}` });
      const text = renderToday(sc.s, { idea: sc.ideas.baleYield, story, extras: fakeExtras() }, sc.line, null, sc.queue, sc.stories, sc.c).main.text;
      expect(region(text, "story")).toContain(`<p class="hint">To try again, ask Claude Code to run: npx overnight build-now ${sc.ideas.baleYield.id}</p>`);
      expect(region(todayOf(sc), "story")).not.toContain('class="hint"');
    });

    it("shows the seven steps still to come when there is no idea yet", () => {
      const sc = scene();
      const story = region(renderToday(fakeSnapshot(), null, { over: "Today", before: "Listening. No ideas yet", title: null, after: "" }, null, sc.queue, new Map(), sc.c).main.text, "story");
      expect(story).toContain('<h1 class="hero__now">Listening. No ideas yet</h1>');
      expect(story).toContain("When Overnight hears an idea, its story shows here, step by step.");
      expect(Array.from(story.matchAll(/data-step="([a-z]+)" data-status="todo"/g), (match) => match[1])).toEqual(["heard", "asked", "approved", "built", "checked", "published", "delivered"]);
      expect(story).not.toContain("aria-current");
      expect(story).not.toContain('class="checks"');
    });
  });

  describe("the line about last night", () => {
    it("gives the label and the night in one line, and leads to Nights", () => {
      const sc = scene();
      expect(region(todayOf(sc), "lastnight")).toBe('<a href="/nights"><span class="lastnight__label">Tonight</span><span class="lastnight__headline">Building now.</span><span class="lastnight__more">All nights</span></a>');
      const night: Night = { ...sc.nights[1]!, headline: "1 of 2 worked." };
      const text = renderToday(sc.s, sc.hero, sc.line, { night, label: "Last night" }, sc.queue, sc.stories, sc.c).main.text;
      expect(region(text, "lastnight")).toContain('<span class="lastnight__label">Last night</span><span class="lastnight__headline">1 of 2 worked.</span>');
    });
  });

  describe("the Heard lane", () => {
    it("counts the lines since the day began and says when the last one came", () => {
      const sc = scene();
      const lane = region(todayOf(sc), "lane-heard");
      const last = boise(10, 22, 56);
      expect(lane).toContain('<h2>Heard</h2><div class="lane__big">214</div>');
      expect(lane).toContain(`<p class="lane__sub">lines since 7:00 AM · last one <time datetime="${last}" data-since="${last}" data-clock="ago">at 10:56 PM</time></p>`);
    });

    it("says line for one, groups thousands, and leaves out the last one when nothing was ever heard", () => {
      const sc = scene();
      const lane = (linesHeard: number): string => region(renderToday(fakeSnapshot({ linesHeard }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-heard");
      expect(lane(1)).toContain('<div class="lane__big">1</div><p class="lane__sub">line since 7:00 AM</p>');
      expect(lane(1204)).toContain('<div class="lane__big">1,204</div><p class="lane__sub">lines since 7:00 AM</p>');
      expect(lane(0)).toContain('<p class="lane__note">No conversations since 7:00 AM.</p>');
    });

    it("draws each conversation as its time, at most four bars and a tag", () => {
      const sc = scene();
      const lane = region(todayOf(sc), "lane-heard");
      expect(times(lane, '<li class="heard__row">')).toBe(3);
      expect(lane).toContain(`<li class="heard__row"><time datetime="${boise(10, 22, 52)}">10:52 PM</time><div><div class="bars"><i class="bar w5"></i><i class="bar w3"></i><i class="bar w6"></i><i class="bar w2"></i></div><span class="tag">9 lines · not an idea</span></div></li>`);
      expect(lane).toContain('<div class="bars"><i class="bar w6"></i><i class="bar w4"></i></div>');
    });

    it("keeps a bar's width between 1 and 7 whatever number it is given", () => {
      const sc = scene();
      const group: HeardGroup = { id: "c", firstAt: boise(10, 9), lastAt: boise(10, 9, 5), lines: 4, bars: [0, 99, 3.6, Number.NaN], outcome: "not_idea", ideaId: null };
      const lane = region(renderToday(fakeSnapshot({ heard: [group] }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-heard");
      expect(lane).toContain('<div class="bars"><i class="bar w1"></i><i class="bar w7"></i><i class="bar w4"></i><i class="bar w1"></i></div>');
    });

    // Beside the pill "Not listening", lines nobody had checked yet used to be tagged "listening".
    it("says lines are 'not checked yet', not 'listening', unless the listener is seen to be running", () => {
      const sc = scene();
      const group: HeardGroup = { id: "c", firstAt: boise(10, 9), lastAt: boise(10, 9, 5), lines: 36_025, bars: [3], outcome: "listening", ideaId: null };
      const lane = (listener: boolean | null): string => region(renderToday(fakeSnapshot({ heard: [group], running: { listener, build: false, deliver: false } }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-heard");
      expect(lane(true)).toContain('<span class="tag tag--listening">36,025 lines · listening</span>');
      expect(lane(false)).toContain('<span class="tag">36,025 lines · not checked yet</span>');
      expect(lane(null)).toContain('<span class="tag">36,025 lines · not checked yet</span>');
      expect(lane(false)).not.toContain("listening");
    });

    it("tags every outcome in the page's own words", () => {
      const sc = scene();
      const tag = (over: Partial<HeardGroup>, ideas: DashIdea[] = []): string => {
        const group: HeardGroup = { id: "c", firstAt: boise(10, 9), lastAt: boise(10, 9, 5), lines: 12, bars: [3], outcome: "not_idea", ideaId: null, ...over };
        const lane = region(renderToday(fakeSnapshot({ heard: [group], ideas }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-heard");
        return /<\/div>(<(?:span|a) class="tag.*?<\/(?:span|a)>)<\/div><\/li>/.exec(lane)?.[1] ?? "";
      };
      expect(tag({ outcome: "not_idea" })).toBe('<span class="tag">12 lines · not an idea</span>');
      expect(tag({ outcome: "too_short", lines: 1 })).toBe('<span class="tag">1 line · too short</span>');
      expect(tag({ outcome: "too_old" })).toBe('<span class="tag">12 lines · too old</span>');
      expect(tag({ outcome: "skipped" })).toBe('<span class="tag">12 lines · skipped</span>');
      expect(tag({ outcome: "failed" })).toBe('<span class="tag tag--warn">12 lines · could not check</span>');
      expect(tag({ outcome: "listening" })).toBe('<span class="tag tag--listening">12 lines · listening</span>');
      const lunch = sc.ideas.lunchTurns;
      expect(tag({ outcome: "idea", ideaId: lunch.id }, [lunch])).toBe(`<a class="tag tag--idea" href="/ideas/${lunch.id}">Idea: Lunch Turns</a>`);
      expect(tag({ outcome: "idea", ideaId: lunch.id }, [{ ...lunch, title: "An idea (hidden while filming)", hidden: true }])).toBe(`<a class="tag tag--idea" href="/ideas/${lunch.id}">An idea (hidden while filming)</a>`);
      // An idea that is not among the newest 200 any more, or whose row could not be read.
      expect(tag({ outcome: "idea", ideaId: "idea_gone" })).toBe('<span class="tag tag--idea">12 lines · an idea</span>');
      expect(tag({ outcome: "idea", ideaId: null })).toBe('<span class="tag tag--idea">12 lines · an idea</span>');
    });
  });

  describe("the Asked lane", () => {
    it("counts the asks since the day began against the daily limit", () => {
      const sc = scene();
      const lane = region(todayOf(sc), "lane-asked");
      expect(lane).toContain('<h2>Asked</h2><div class="lane__big">2 <small>of 3</small></div><p class="lane__sub">asks on the wrist since 7:00 AM</p>');
    });

    it("lists what was asked since the day began, oldest first, with how each ask ended", () => {
      const sc = scene();
      const lane = region(todayOf(sc), "lane-asked");
      const rows = Array.from(lane.matchAll(/<li class="row"><b><a href="([^"]+)">([^<]+)<\/a><\/b><small>([^<]+)<\/small><\/li>/g), (match) => [match[2], match[3], match[1]]);
      expect(rows).toEqual([
        ["Chore Wheel", "ticked 12:46 PM", `/ideas/${sc.ideas.choreWheel.id}`],
        ["Lunch Turns", "ticked 3:15 PM", `/ideas/${sc.ideas.lunchTurns.id}`],
        ["Trail Snack Planner", "waiting", `/ideas/${sc.ideas.asked.id}`],
      ]);
      // Asked before the day began, or never asked: not on the lane.
      expect(lane).not.toContain("Packing Checklist");
      expect(lane).not.toContain("Recipe Scaler");
    });

    it("says deleted, no answer, and ticked without a time when the time is not known", () => {
      const sc = scene();
      const ideas = [
        fakeIdea({ title: "Sock Sorter", state: "rejected", askedAt: boise(10, 9) }),
        fakeIdea({ title: "Fence Post Counter", state: "expired", askedAt: boise(10, 10), answeredAt: null }),
        fakeIdea({ title: "Coin Flip Jar", state: "built", askedAt: boise(10, 11), answeredAt: null }),
      ];
      const lane = region(renderToday(fakeSnapshot({ ideas, asks: 3 }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-asked");
      expect(Array.from(lane.matchAll(/<small>([^<]+)<\/small><\/li>/g), (match) => match[1])).toEqual(["deleted", "no answer", "ticked"]);
    });

    it("shows the newest six when more were asked", () => {
      const sc = scene();
      const ideas = Array.from({ length: 8 }, (_, index) => fakeIdea({ title: `Idea ${index + 1}`, askedAt: boise(10, 8 + index) }));
      const lane = region(renderToday(fakeSnapshot({ ideas, asks: 8 }), null, sc.line, null, sc.queue, new Map(), fakeContext({ config: fakeConfig({ MAX_ASKS_PER_DAY: "10" }) })).main.text, "lane-asked");
      expect(Array.from(lane.matchAll(/">(Idea \d)<\/a>/g), (match) => match[1])).toEqual(["Idea 3", "Idea 4", "Idea 5", "Idea 6", "Idea 7", "Idea 8"]);
      expect(lane).toContain("8 <small>of 10</small>");
    });

    it("says so when nothing was asked, and why when Overnight is in quiet mode", () => {
      const sc = scene();
      const lane = (paused: boolean): string => region(renderToday(fakeSnapshot({ paused }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text, "lane-asked");
      expect(lane(false)).toContain('<p class="lane__note">Nothing asked yet.</p>');
      expect(lane(true)).toContain('<p class="lane__note lane__note--warn">Quiet mode: nothing is asked.</p>');
      expect(lane(true)).not.toContain("Nothing asked yet.");
      expect(lane(false)).not.toContain("Quiet mode");
    });
  });

  describe("the Tonight's build lane", () => {
    it("gives the time, how many are to build, the nightly limit and the queue in order", () => {
      const sc = scene();
      const lane = region(todayOf(sc), "lane-tonight");
      expect(lane).toContain("<h2>Tonight's build</h2>");
      expect(lane).toContain('<div class="lane__big">1:00 AM</div><p class="lane__sub">2 to build · up to 2 a night</p>');
      const rows = Array.from(lane.matchAll(/<li class="row"><span class="num">(\d)<\/span><b><a href="[^"]+">([^<]+)<\/a><\/b><small>([^<]+)<\/small><\/li>/g), (match) => [match[1], match[2], match[3]]);
      expect(rows).toEqual([["1", "Chore Wheel", "building"], ["2", "Lunch Turns", "next"]]);
    });

    it("says tonight when nothing is being built yet, and which ideas wait for another night", () => {
      const sc = scene();
      const queue = { at: boise(11, 1), paused: false, limit: 1, hold: null, rows: [{ idea: sc.ideas.lunchTurns, when: "tonight" as const }, { idea: sc.ideas.cutShort, when: "later" as const }] };
      const lane = region(renderToday(sc.s, sc.hero, sc.line, null, queue, sc.stories, sc.c).main.text, "lane-tonight");
      expect(Array.from(lane.matchAll(/<small>([^<]+)<\/small><\/li>/g), (match) => match[1])).toEqual(["tonight", "waits for another night"]);
      expect(lane).toContain("2 to build · up to 1 a night");
    });

    it("says nothing will be built while paused, and that nothing waits when the queue is empty", () => {
      const sc = scene();
      const lane = (paused: boolean, rows = sc.queue.rows.slice(0, 0)): string => region(renderToday(sc.s, sc.hero, sc.line, null, { ...sc.queue, paused, rows }, sc.stories, sc.c).main.text, "lane-tonight");
      expect(lane(true)).toContain('<p class="lane__note lane__note--warn">Paused: nothing will be built</p>');
      expect(lane(true)).not.toContain("Nothing is waiting");
      expect(lane(false)).toContain('<p class="lane__note">Nothing is waiting to be built.</p>');
      expect(lane(false)).not.toContain("Paused");
      expect(lane(true, sc.queue.rows)).toContain("Paused: nothing will be built");
      expect(lane(true, sc.queue.rows)).toContain("Chore Wheel");
    });

    // The lane used to read "tonight" for ideas that the month's credits, or a rehearsal folder, kept from being built at all.
    describe("when something stands in the build's way", () => {
      const sc = scene();
      const waiting = [{ idea: sc.ideas.lunchTurns, when: "tonight" as const }, { idea: sc.ideas.cutShort, when: "later" as const }];
      const held: BuildHold = { why: "credits", step: "(step)", line: "(line)", note: "Not tonight: this month's build credits are used up (10.4 of 5 counted)." };
      const late: BuildHold = { why: "late", step: "(step)", line: "(line)", note: "Running late: the Oct 11, 1:00 AM build is waiting for the internet." };
      const lane = (queue: Partial<TonightQueue>): string => region(renderToday(sc.s, sc.hero, sc.line, null, { ...sc.queue, rows: waiting, ...queue }, sc.stories, sc.c).main.text, "lane-tonight");
      const words = (text: string): string[] => Array.from(text.matchAll(/<small>([^<]+)<\/small><\/li>/g), (match) => match[1] ?? "");

      it("says why nothing will be built, and that the ideas wait", () => {
        const text = lane({ hold: held });
        expect(text).toContain('<p class="lane__note lane__note--warn">Not tonight: this month&#39;s build credits are used up (10.4 of 5 counted).</p>');
        expect(words(text)).toEqual(["waiting", "waiting"]);
        // An idea that is being built is being built, whatever holds the rest.
        expect(words(lane({ hold: held, rows: [{ idea: sc.ideas.choreWheel, when: "building" }, ...waiting] }))).toEqual(["building", "waiting", "waiting"]);
        // Nothing waits: the reason still shows, in place of "Nothing is waiting".
        expect(lane({ hold: held, rows: [] })).toContain("Not tonight:");
        expect(lane({ hold: held, rows: [] })).not.toContain("Nothing is waiting");
      });

      it("says a late build is late, and that its ideas are next", () => {
        const text = lane({ hold: late });
        expect(text).toContain('<p class="lane__note lane__note--warn">Running late: the Oct 11, 1:00 AM build is waiting for the internet.</p>');
        expect(words(text)).toEqual(["next", "waits for another night"]);
        // With nothing waiting for it, a late build is not worth a warning.
        expect(lane({ hold: late, rows: [] })).not.toContain("Running late");
        expect(lane({ hold: late, rows: [] })).toContain('<p class="lane__note">Nothing is waiting to be built.</p>');
      });

      it("says paused first, as before", () => {
        const text = lane({ paused: true, hold: held });
        expect(text).toContain("Paused: nothing will be built");
        expect(text).not.toContain("Not tonight");
        expect(words(text)).toEqual(["tonight", "waits for another night"]);
      });

      it("says nothing more when nothing is in the way", () => {
        expect(lane({ hold: null })).not.toContain("lane__note");
        expect(words(lane({ hold: null }))).toEqual(["tonight", "waits for another night"]);
      });
    });
  });

  describe("the cards", () => {
    it("shows the day's other ideas, then up to six earlier ones, and never the hero twice", () => {
      const sc = scene();
      const cards = region(todayOf(sc), "cards");
      const [today = "", earlier = ""] = cards.split('<h2 class="section-title">Earlier</h2>');
      expect(today).toContain('<h2 class="section-title">Also since 7:00 AM</h2>');
      const titles = (text: string): string[] => Array.from(text.matchAll(/<h3 class="idea__title">([^<]+)<\/h3>/g), (match) => match[1] ?? "");
      expect(titles(today)).toEqual(["Recipe Scaler", "Trail Snack Planner", "Lunch Turns"]);
      expect(titles(earlier)).toEqual(["Fence Post Counter", "Sock Sorter", "Bale Yield Calculator", "Packing Checklist", "Reading Log", "Tip Splitter"]);
      expect(cards).not.toContain("Chore Wheel");
      expect(cards).toContain('<p class="more"><a href="/ideas">All ideas</a></p>');
    });

    it("carries pictures only when it is told which ideas have one", () => {
      const sc = scene();
      expect(region(todayOf(sc), "cards")).toContain(`src="/shots/${sc.ideas.packing.id}/phone.png"`);
      expect(times(region(todayOf(sc), "cards"), "<img")).toBe(2);
      expect(region(todayOf(sc, { thumbs: false }), "cards")).not.toContain("<img");
    });

    it("leaves out a group that has nothing in it", () => {
      const sc = scene();
      const onlyEarlier = region(renderToday({ ...sc.s, ideas: [sc.ideas.packing] }, null, sc.line, null, sc.queue, sc.stories, sc.c).main.text, "cards");
      expect(onlyEarlier).not.toContain("Also since");
      expect(onlyEarlier).toContain('<h2 class="section-title">Earlier</h2>');
      const onlyToday = region(renderToday({ ...sc.s, ideas: [sc.ideas.lunchTurns] }, null, sc.line, null, sc.queue, sc.stories, sc.c).main.text, "cards");
      expect(onlyToday).toContain("Also since 7:00 AM");
      expect(onlyToday).not.toContain("Earlier");
    });
  });

  describe("with nothing saved yet", () => {
    it.each(["missing", "empty"] as const)("says so for a %s database, names the folder with ~ and keeps looking", (problem) => {
      const sc = scene();
      const main = renderToday(fakeSnapshot({ problem }), null, sc.line, null, sc.queue, new Map(), sc.c).main.text;
      expect(liveIds(main)).toEqual(["empty"]);
      expect(main).toContain("<h1>Nothing saved yet</h1><p>Overnight has not run with this data folder: ~/.overnight.</p>");
      expect(main).toContain("This page keeps looking and fills in by itself.");
      expect(main).not.toContain(HOME);
    });

    it("still shows what it has when the database was only busy", () => {
      const sc = scene();
      const main = renderToday({ ...sc.s, problem: "busy", staleSince: boise(11, 1, 1) }, sc.hero, sc.line, sc.lastNight, sc.queue, sc.stories, sc.c).main.text;
      expect(liveIds(main)).toContain("story");
      expect(main).toContain("Chore Wheel");
    });
  });
});

// ---------- Ideas ----------

describe("Ideas", () => {
  it("shows every idea as a card, newest first, in one live region", () => {
    const sc = scene();
    const view = renderIdeas(sc.s, sc.stories, sc.thumbs, sc.c);
    expect(view.title).toBe("Ideas");
    expect(view.main.text).toContain('<h1 class="page-title">Ideas</h1>');
    expect(liveIds(view.main.text)).toEqual(["cards"]);
    const cards = region(view.main.text, "cards");
    expect(cards).toContain('<p class="page-sub">14 ideas, newest first</p>');
    expect(Array.from(cards.matchAll(/<h2 class="idea__title">([^<]+)<\/h2>/g), (match) => match[1])).toEqual(sc.s.ideas.map((idea) => idea.title));
    expect(times(cards, '<a class="card idea" href="/ideas/')).toBe(14);
  });

  it("shows a picture for the ideas that have one, the mini story, the reason and the rehearsal tag", () => {
    const sc = scene();
    const cards = region(renderIdeas(sc.s, sc.stories, sc.thumbs, sc.c).main.text, "cards");
    expect(times(cards, '<img class="idea__shot"')).toBe(3);
    expect(times(cards, '<ol class="mini"')).toBe(14);
    expect(cards).toContain("the build ran past its time limit of 45 minutes");
    expect(cards).toContain('<span class="tag tag--plain">Rehearsal</span>');
    expect(cards).toContain('<span class="state state--waiting">Cut short</span>');
    // The build log's own number wins over the idea's two times.
    expect(cards).toContain('Kiro Crew · <span class="nowrap">2 min 40 s</span>');
  });

  it("says so when there are no ideas, and when nothing is saved yet", () => {
    const sc = scene();
    expect(region(renderIdeas(fakeSnapshot(), new Map(), new Set(), sc.c).main.text, "cards")).toBe('<div class="card empty"><p>No ideas yet. When Overnight hears one, it shows up here.</p></div>');
    const nothing = renderIdeas(fakeSnapshot({ problem: "empty" }), new Map(), new Set(), sc.c).main.text;
    expect(liveIds(nothing)).toEqual(["empty"]);
    expect(nothing).toContain("Overnight has not run with this data folder: ~/.overnight.");
  });
});

// ---------- one idea ----------

describe("one idea's page", () => {
  const sc = scene();
  const packing = sc.ideas.packing;
  const full = fakeExtras({
    report: fakeReport(),
    shots: { phone: true, desktop: true },
    brief: { text: `# Packing Checklist\nWork in ${HOME}/.overnight/workspaces/x and nowhere else.`, cut: false },
    notes: { text: `Built in ${HOME}/.overnight/built/x with <b>plain</b> files.`, cut: true },
  });
  const events = fakeEvents(packing, ["heard", "asked", "approved", "building", "built", "published", "delivered"]);
  const page = (idea = packing, extras = full, c = sc.c, story = fakeStory(idea)): string => renderIdea(sc.s, idea, story, extras, events, c).main.text;

  it("is named after the idea and has five live regions and the brief, which is not live", () => {
    expect(renderIdea(sc.s, packing, fakeStory(packing), full, events, sc.c).title).toBe("Packing Checklist");
    expect(liveIds(page())).toEqual(["story", "shots", "facts", "notes", "history"]);
    expect(page()).toMatch(/<section id="brief"><details id="brief-text"/);
    // The same regions when there is nothing to put in them, so the script never has to replace the whole middle.
    expect(liveIds(page(sc.ideas.heard, fakeExtras()))).toEqual(["story", "shots", "facts", "notes", "history"]);
    expect(page(sc.ideas.heard, fakeExtras())).toContain('<section id="brief"></section>');
  });

  it("leads with the state, the title, the pitch and what was said", () => {
    const story = region(page(), "story");
    expect(story).toContain('<p class="hero__tags"><span class="state state--delivered">Delivered</span></p><h1 class="hero__now">Packing Checklist</h1><p class="hero__pitch">A checklist for a weekend trip. Tick things off as they go in the bag.</p>');
    expect(story).toContain('<blockquote class="said"><span class="said__label">What was said</span>“I forget my charger every single time”</blockquote>');
    expect(story).toContain('<ol class="story"');
  });

  it("says the quote is hidden while filming, and says nothing for an idea that never had one", () => {
    const filming = region(page({ ...packing, quote: { shown: false, why: "filming" } }), "story");
    expect(filming).toContain('<p class="said said--hidden"><span class="said__label">What was said</span>Hidden while filming</p>');
    expect(filming).not.toContain("charger");
    const none = region(page(sc.ideas.rehearsal), "story");
    expect(none).not.toContain('class="said');
    expect(none).toContain('<span class="tag tag--plain">Rehearsal</span>');
  });

  it("links to the app when it has a fit address, and shows any other address as text", () => {
    expect(region(page(), "story")).toContain('<a class="button" href="https://example.invalid/overnight-apps/packing-checklist/" target="_blank" rel="noopener noreferrer">');
    const odd = region(page({ ...packing, publishedUrl: HOSTILE.address }), "story");
    expect(odd).toContain("Published at javascript:alert(1) (shown as text, because it is not an https address)");
    expect(odd).not.toContain("href=");
  });

  it("shows a running clock and the hint when the story has them", () => {
    const building = region(renderIdea(sc.s, sc.ideas.choreWheel, sc.hero.story, fakeExtras(), [], sc.c).main.text, "story");
    expect(building).toMatch(/<div class="hero__clock"><b><time [^>]*data-clock="elapsed">since 1:00 AM<\/time><\/b><span>building<\/span><\/div>/);
    expect(building).toContain('<ul class="checks"');
    const hinted = region(page(sc.ideas.baleYield, fakeExtras(), sc.c, fakeStory(sc.ideas.baleYield, { hint: "To try again, ask Claude Code." })), "story");
    expect(hinted).toContain('<p class="hint">To try again, ask Claude Code.</p>');
  });

  it("shows the pictures that exist, and none that do not", () => {
    const both = region(page(), "shots");
    expect(both).toContain(`<figure class="shot shot--phone"><img src="/shots/${packing.id}/phone.png" alt="The app on a phone screen" loading="lazy"><figcaption>Phone</figcaption></figure>`);
    expect(both).toContain(`<figure class="shot shot--desktop"><img src="/shots/${packing.id}/desktop.png" alt="The app on a desktop screen" loading="lazy"><figcaption>Desktop</figcaption></figure>`);
    const phoneOnly = region(page(packing, fakeExtras({ shots: { phone: true, desktop: false } })), "shots");
    expect(times(phoneOnly, "<img")).toBe(1);
    expect(phoneOnly).toContain("phone.png");
    expect(region(page(packing, fakeExtras()), "shots")).toBe("");
  });

  it("lists the facts of the build and the morning", () => {
    const facts = region(page(), "facts");
    const rows = Object.fromEntries(Array.from(facts.matchAll(/<div class="fact[^"]*"><dt>([^<]+)<\/dt><dd>(.*?)<\/dd><\/div>/g), (match) => [match[1], (match[2] ?? "").replace(/<[^>]+>/g, "")]));
    expect(rows).toEqual({
      Builder: "Kiro Crew",
      "Build time": "2 min 40 s",
      "Kiro credits": "4.59 credits",
      "Check time": "6.6 s",
      "Files and size": "3 files · 5.6 KB",
      "Live after": "26 s",
      "Page confirmed live": "yes",
      "Packages installed": "yes",
      "The app built": "yes",
      "Passed our page checks": "yes",
      "Its own test passed": "yes",
    });
  });

  it("says yes, no or that it is not known, each in its own colour", () => {
    const report = fakeReport({ confirmedLive: null, checks: { installOk: true, buildOk: false, contractOk: null, appSmokeOk: null } });
    const facts = region(page(packing, fakeExtras({ report })), "facts");
    expect(facts).toContain('<dt>Page confirmed live</dt><dd><span class="muted">not known</span></dd>');
    expect(facts).toContain('<dt>Packages installed</dt><dd><span class="yes">yes</span></dd>');
    expect(facts).toContain('<dt>The app built</dt><dd><span class="no">no</span></dd>');
    expect(facts).toContain('<dt>Passed our page checks</dt><dd><span class="muted">not checked</span></dd>');
    expect(region(page(packing, fakeExtras({ report: fakeReport({ confirmedLive: false }) })), "facts")).toContain('<dt>Page confirmed live</dt><dd><span class="no">no</span></dd>');
  });

  it("takes the morning's numbers from the report when there is one, whatever the log says", () => {
    const report = fakeReport({ verifyMs: 5200, distFiles: 4, distBytes: 812, liveAfterMs: 21_000 });
    const facts = region(page(packing, fakeExtras({ report })), "facts");
    expect(facts).toContain("<dt>Check time</dt><dd>5.2 s</dd>");
    expect(facts).toContain("<dt>Files and size</dt><dd>4 files · 812 bytes</dd>");
    expect(facts).toContain("<dt>Live after</dt><dd>21 s</dd>");
  });

  it("falls back to the logs for the morning's numbers when there is no report, and to the idea's own times for the build", () => {
    const noReport = region(page(packing, fakeExtras()), "facts");
    expect(noReport).toContain("<dt>Check time</dt><dd>6.6 s</dd>");
    expect(noReport).toContain("<dt>Files and size</dt><dd>3 files · 5.6 KB</dd>");
    expect(noReport).toContain("<dt>Live after</dt><dd>26 s</dd>");
    expect(noReport).not.toContain("Page confirmed live");
    const noLogs = region(renderIdea(fakeSnapshot(), sc.ideas.readingLog, fakeStory(sc.ideas.readingLog), fakeExtras(), [], sc.c).main.text, "facts");
    expect(noLogs).toContain("<dt>Builder</dt><dd>Kiro CLI</dd>");
    expect(noLogs).toContain("<dt>Build time</dt><dd>5 min 10 s</dd>");
    expect(noLogs).not.toContain("Kiro credits");
  });

  it("says when the second builder made it, how often it was tried, and why it failed", () => {
    const fellBack = new Map([[sc.ideas.readingLog.id, { startedAt: "", by: "build" as const, signIn: null, sandboxCheck: null, agentStarted: null, fellBack: { at: boise(9, 1, 3) }, finished: null, slept: null, sealed: null }]]);
    expect(region(renderIdea(fakeSnapshot({ build: fellBack }), sc.ideas.readingLog, fakeStory(sc.ideas.readingLog), fakeExtras(), [], sc.c).main.text, "facts")).toContain("<dt>Builder</dt><dd>Kiro CLI, after the first builder failed</dd>");
    const failed = region(page(sc.ideas.baleYield, fakeExtras()), "facts");
    expect(failed).toContain("<dt>Build tries</dt><dd>2</dd>");
    expect(failed).toContain('<div class="fact fact--wide"><dt>Why it failed</dt><dd>the build ran past its time limit of 45 minutes</dd></div>');
    expect(failed).not.toContain("Build time");
    expect(failed).not.toContain("Ran for");
    // When the log says how long a failed build ran, that is not called its build time.
    const ran = new Map([[sc.ideas.baleYield.id, { startedAt: "", by: "build" as const, signIn: null, sandboxCheck: null, agentStarted: null, fellBack: null, finished: { at: "", ok: false, seconds: 2700, credits: 1.5 }, slept: null, sealed: null }]]);
    const failedWithLog = region(renderIdea(fakeSnapshot({ build: ran }), sc.ideas.baleYield, fakeStory(sc.ideas.baleYield), fakeExtras(), [], sc.c).main.text, "facts");
    expect(failedWithLog).toContain("<dt>Ran for</dt><dd>45 min</dd>");
    expect(failedWithLog).toContain("<dt>Kiro credits</dt><dd>1.5 credits</dd>");
    expect(failedWithLog).not.toContain("Build time");
    expect(region(page(sc.ideas.cutShort, fakeExtras()), "facts")).toContain("<dt>Why it was cut short</dt><dd>the build was stopped</dd>");
    expect(region(page(sc.ideas.heard, fakeExtras()), "facts")).toBe("");
  });

  it("keeps the brief closed, as plain text, with the home folder shown as ~", () => {
    const text = page();
    expect(text).toContain('<section id="brief"><details id="brief-text" class="card doc"><summary>The brief <small>All the build agent was given</small></summary><pre># Packing Checklist\nWork in ~/.overnight/workspaces/x and nowhere else.</pre></details></section>');
    expect(text).not.toMatch(/<details[^>]*\sopen/);
    expect(text).not.toContain(HOME);
  });

  it("labels the build notes as the agent's, escapes them, and says when they were cut", () => {
    const notes = region(page(), "notes");
    expect(notes).toBe('<details id="notes-text" class="card doc"><summary>Build notes <small>Written by the build agent</small></summary><pre>Built in ~/.overnight/built/x with &lt;b&gt;plain&lt;/b&gt; files.</pre><p class="doc__note">Only the first part is shown. The file is longer.</p></details>');
  });

  it("does not show the notes while filming, and shows nothing when there are none", () => {
    expect(region(page(packing, { ...full, notes: "filming" }), "notes")).toBe('<p class="card plain-note">Build notes are hidden while filming.</p>');
    expect(region(page(packing, fakeExtras()), "notes")).toBe("");
  });

  it("lists every change of state, with its note", () => {
    const noted = events.map((event, index) => (index === 1 ? { ...event, note: "asked <on> the wrist" } : event));
    const history = region(renderIdea(sc.s, packing, fakeStory(packing), full, noted, sc.c).main.text, "history");
    expect(history).toContain('<th scope="col">When</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Note</th>');
    expect(times(history, "<tr><td>")).toBe(7);
    expect(history).toContain(`<tr><td><time datetime="${events[0]?.at}">Oct 9, 11:05 AM</time></td><td>New</td><td>Heard</td><td></td></tr>`);
    expect(history).toContain("<td>Heard</td><td>Asked</td><td>asked &lt;on&gt; the wrist</td></tr>");
    expect(history).toContain("<td>Published</td><td>Delivered</td><td></td></tr>");
    expect(region(renderIdea(sc.s, packing, fakeStory(packing), full, [], sc.c).main.text, "history")).toBe("");
  });
});

// ---------- Nights ----------

describe("Nights", () => {
  const sc = scene();
  const main = renderNights(sc.nights, sc.stories, sc.c).main.text;
  const cards = region(main, "nights").split("<article").slice(1);

  it("shows one card per night, newest first, in one live region", () => {
    expect(renderNights(sc.nights, sc.stories, sc.c).title).toBe("Nights");
    expect(main).toContain('<h1 class="page-title">Nights</h1>');
    expect(liveIds(main)).toEqual(["nights"]);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('<h2 class="night__label">Sat, Oct 10 to Sun, Oct 11</h2><p class="night__headline">Building now.</p>');
    expect(cards[1]).toContain('<h2 class="night__label">Fri, Oct 9 to Sat, Oct 10</h2><p class="night__headline">1 of 2 worked.</p>');
  });

  it("adds up the night: built, delivered, failed, time spent building and Kiro credits", () => {
    expect(cards[1]).toContain('<p class="night__stats">1 built · 1 delivered · 1 failed · 2 min 40 s of building · 4.59 Kiro credits</p>');
    // Nothing finished yet: no time and no credits to add up.
    expect(cards[0]).toContain('<p class="night__stats">0 built · 0 delivered · 0 failed</p>');
    const two: Night = { ...sc.nights[1]!, ideas: [{ ...sc.nights[1]!.ideas[0]!, buildSeconds: 100 }, { ...sc.nights[1]!.ideas[1]!, buildSeconds: 80 }], credits: 1 };
    expect(renderNights([two], sc.stories, sc.c).main.text).toContain("3 min of building · 1 Kiro credit</p>");
  });

  // A build that was cut short and gets one more try used to be counted under "failed" and its row read "Could not build".
  it("says a build that was cut short on its own, in the counts and on its row", () => {
    const cutShortRow = { idea: sc.ideas.cutShort, outcome: "build_failed" as const, buildSeconds: 217, credits: null, by: "build" as const, cutShort: true };
    const night: Night = { ...sc.nights[1]!, ideas: [sc.nights[1]!.ideas[0]!, cutShortRow], failed: 0, cutShort: 1, credits: null };
    const text = renderNights([night], sc.stories, sc.c).main.text;
    expect(text).toContain('<p class="night__stats">1 built · 1 delivered · 0 failed · 1 cut short, to be built once more · 6 min 17 s of building</p>');
    expect(text).toContain("<small>Cut short · Kiro Crew · 3 min 37 s</small></li>");
    expect(text).not.toContain("Could not build");
    // Left "building" on that night and found cut off later: the same words, not "Building".
    const cutOff: Night = { ...night, ideas: [{ ...cutShortRow, outcome: "building" }] };
    expect(renderNights([cutOff], sc.stories, sc.c).main.text).toContain("<small>Cut short · Kiro Crew · 3 min 37 s</small></li>");
    // The same idea on a night it really failed in (it is not waiting for another try because of that night).
    const failed: Night = { ...night, ideas: [{ ...cutShortRow, cutShort: false }], failed: 1, cutShort: 0 };
    const failedText = renderNights([failed], sc.stories, sc.c).main.text;
    expect(failedText).toContain("<small>Could not build · Kiro Crew · 3 min 37 s</small></li>");
    expect(failedText).not.toContain("cut short");
  });

  it("says beside a run's times that the Mac went to sleep during it", () => {
    // The lid was closed at 1:04 AM and opened at 7:10 AM: without these words the build would read as a six-hour one.
    const base = sc.nights[1]!;
    const slept: Night = { ...base, buildRun: { ...base.buildRun!, finishedAt: boise(10, 7, 10), slept: true }, deliverRun: { ...base.deliverRun!, slept: true } };
    const text = renderNights([slept], sc.stories, sc.c).main.text;
    expect(text).toContain("<div><dt>Build</dt><dd>1:00 AM to 7:10 AM · sandbox check passed in 7.1 s · cut short: the Mac went to sleep</dd></div>");
    expect(text).toContain("<div><dt>Morning</dt><dd>6:30 AM to 6:31 AM · cut short: the Mac went to sleep</dd></div>");
    // A night nobody slept through says nothing of the kind.
    expect(main).not.toContain("went to sleep");
    // The row of the build that was cut short has no build time made of sleep (story.ts hands over none).
    const row = { idea: sc.ideas.cutShort, outcome: "build_failed" as const, buildSeconds: null, credits: null, by: "build" as const, cutShort: true };
    expect(renderNights([{ ...slept, ideas: [row], failed: 0, cutShort: 1, credits: null }], sc.stories, sc.c).main.text).toContain("<small>Cut short · Kiro Crew</small></li>");
  });

  it("says when the build and the morning ran, and whether the sandbox check passed", () => {
    expect(cards[1]).toContain('<dl class="night__runs"><div><dt>Build</dt><dd>1:00 AM to 1:48 AM · sandbox check passed in 7.1 s</dd></div><div><dt>Morning</dt><dd>6:30 AM to 6:31 AM</dd></div></dl>');
    // A run with no end in the log (still going, or cut off) gives only its start.
    expect(cards[0]).toContain('<dl class="night__runs"><div><dt>Build</dt><dd>started 1:00 AM · sandbox check passed in 7.1 s</dd></div></dl>');
    expect(cards[2]).toContain("<dt>Build</dt><dd>3:00 PM to 3:02 PM</dd>");
    const failed: Night = { ...sc.nights[1]!, buildRun: { ...sc.nights[1]!.buildRun!, sandboxCheck: { at: boise(10, 1), ok: false, ms: 900, reused: false } }, deliverRun: null };
    expect(renderNights([failed], sc.stories, sc.c).main.text).toContain("1:00 AM to 1:48 AM · sandbox check failed</dd>");
    const morningOnly: Night = { ...sc.nights[1]!, buildRun: null };
    expect(renderNights([morningOnly], sc.stories, sc.c).main.text).toContain('<dl class="night__runs"><div><dt>Morning</dt><dd>6:30 AM to 6:31 AM</dd></div></dl>');
    const noRuns: Night = { ...sc.nights[1]!, buildRun: null, deliverRun: null };
    expect(renderNights([noRuns], sc.stories, sc.c).main.text).not.toContain("night__runs");
  });

  // It used to read "6:30 AM to 6:30 AM".
  it("says a run that began and ended in the same minute was under a minute long", () => {
    const quick = (startedAt: string, finishedAt: string): string => {
      const night: Night = { ...sc.nights[1]!, buildRun: null, deliverRun: { ...sc.nights[1]!.deliverRun!, startedAt, finishedAt } };
      return /<dt>Morning<\/dt><dd>([^<]*)<\/dd>/.exec(renderNights([night], sc.stories, sc.c).main.text)?.[1] ?? "";
    };
    expect(quick(boise(10, 6, 30, 2), boise(10, 6, 30, 41))).toBe("6:30 AM, under a minute");
    expect(quick(boise(10, 6, 30, 0), boise(10, 6, 30, 0))).toBe("6:30 AM, under a minute");
    // Under a minute long, but across the turn of one: the two times differ, and say enough.
    expect(quick(boise(10, 6, 30, 50), boise(10, 6, 31, 10))).toBe("6:30 AM to 6:31 AM");
    // The same time on the clock a day later is not "under a minute".
    expect(quick(boise(10, 6, 30, 2), boise(11, 6, 30, 41))).toBe("6:30 AM to 6:30 AM");
  });

  it("tags a night whose own run was started by hand", () => {
    expect(cards[2]).toContain('<h2 class="night__label">Wed, Oct 7 to Thu, Oct 8<span class="tag">rehearsal</span></h2>');
    expect(cards[0]).not.toContain('class="tag"');
    const run: Night = { ...sc.nights[1]!, ideas: [], buildRun: { ...sc.nights[1]!.buildRun!, command: "build-now" } };
    const text = renderNights([run], sc.stories, sc.c).main.text;
    expect(text).toContain('<span class="tag">started by hand (build-now)</span></h2>');
    expect(text).not.toContain("night__ideas");
    const morning: Night = { ...sc.nights[1]!, buildRun: null, deliverRun: { ...sc.nights[1]!.deliverRun!, command: "build-now" } };
    expect(renderNights([morning], sc.stories, sc.c).main.text).toContain('<span class="tag">started by hand (build-now)</span></h2>');
  });

  // One idea built by hand the evening before used to put "started by hand (build-now)" over the nightly job's whole night.
  it("does not tag the nightly job's night for one idea that was built by hand: that idea's row says so", () => {
    const byHand: Night = { ...sc.nights[1]!, ideas: [sc.nights[1]!.ideas[0]!, { ...sc.nights[1]!.ideas[1]!, by: "build-now" }] };
    const text = renderNights([byHand], sc.stories, sc.c).main.text;
    expect(text).toContain('<h2 class="night__label">Fri, Oct 9 to Sat, Oct 10</h2>');
    expect(text).not.toContain("started by hand");
    expect(times(text, "built by hand (build-now)")).toBe(1);
    expect(text).toContain(`Bale Yield Calculator</a></b><span class="tag tag--plain">built by hand (build-now)</span></span>`);
    // On a night that is itself by hand, the heading has said it already.
    const whole: Night = { ...byHand, buildRun: { ...byHand.buildRun!, command: "build-now" } };
    const wholeText = renderNights([whole], sc.stories, sc.c).main.text;
    expect(wholeText).toContain('<span class="tag">started by hand (build-now)</span></h2>');
    expect(wholeText).not.toContain("built by hand");
  });

  it("has a row per idea with its outcome, builder, build time, credits and mini story", () => {
    // The title and its tag are one group, so that on a phone they share a line and the dots and the words get lines of their own.
    expect(cards[1]).toContain(`<li class="row"><span class="row__name"><b><a href="/ideas/${sc.ideas.packing.id}">Packing Checklist</a></b></span><ol class="mini" aria-hidden="true">`);
    expect(cards[1]).toContain("<small>Delivered · Kiro Crew · 2 min 40 s · 4.59 credits</small></li>");
    expect(cards[1]).toContain("<small>Could not build · Kiro Crew</small></li>");
    expect(cards[2]).toContain('Practice Dice Roller</a></b><span class="tag tag--plain">Rehearsal</span></span><ol class="mini"');
  });

  it("says so when there are no nights yet", () => {
    expect(region(renderNights([], new Map(), sc.c).main.text, "nights")).toBe('<div class="card empty"><p>No nights yet. The first night Overnight builds something, it shows up here.</p></div>');
  });
});

// ---------- Settings ----------

describe("Settings", () => {
  const sc = scene();
  const settings = (over: { paused?: boolean; env?: Record<string, string>; filming?: string[] | null; demo?: boolean; port?: number; unreadableRows?: number; buildCredits?: BuildBudget | null } = {}): string => {
    const c = fakeContext({ config: fakeConfig(over.env), filming: { on: over.filming !== undefined && over.filming !== null, showQuoteFor: new Set(over.filming ?? []) } });
    return renderSettings(fakeSnapshot({ paused: over.paused ?? false, unreadableRows: over.unreadableRows ?? 0, buildCredits: over.buildCredits ?? null }), c, { demo: over.demo ?? false, port: over.port ?? 4321 }).main.text;
  };
  const row = (text: string, label: string): string => new RegExp(`<div class="setting"><dt>${label}(?:<small>[A-Z_]+</small>)?</dt><dd>(.*?)</dd></div>`).exec(text)?.[1]?.replace(/<small>/g, " | ").replace(/<[^>]+>/g, "") ?? "(no such row)";

  it("is one live region with a row for every setting there is", () => {
    const view = renderSettings(sc.s, sc.c, { demo: true, port: 4321 });
    expect(view.title).toBe("Settings");
    expect(liveIds(view.main.text)).toEqual(["settings"]);
    const names = Array.from(view.main.text.matchAll(/<dt>[^<]+<small>([A-Z_]+)<\/small><\/dt>/g), (match) => match[1]);
    expect(names).toHaveLength(Object.keys(sc.c.config).length);
    expect([...names].sort()).toEqual(["ASK_CUTOFF", "BUILD_BACKEND", "BUILD_SANDBOX", "BUILD_TIME", "BUILD_TIMEOUT_MIN", "DELIVER_TIME", "GITHUB_PAGES_REPO", "MAX_ASKS_PER_DAY", "MAX_BUILDS_PER_NIGHT", "MAX_BUILD_CREDITS_PER_MONTH", "OVERNIGHT_DATA_DIR", "PAUSED", "TZ", "WRITE_BEE_FACTS"]);
  });

  it("gives each setting in plain words", () => {
    const text = settings();
    expect(row(text, "Data folder")).toBe("~/.overnight | Everything Overnight saves is kept here, outside the repo.");
    expect(row(text, "Time zone")).toBe("America/Boise | Every time on these pages is in this zone.");
    expect(row(text, "Asks on the wrist")).toBe("At most 3 a day");
    expect(row(text, "Quiet hours")).toBe("11:00 PM to 7:00 AM | Nothing buzzes the wrist in these hours.");
    expect(row(text, "Builds start at")).toBe("1:00 AM");
    expect(row(text, "Builds a night")).toBe("At most 2");
    expect(row(text, "Time limit for one build")).toBe("45 minutes");
    expect(row(text, "Kiro credits a month")).toBe("At most 400 | Once this many are counted for the month, nothing more is built until the next one.");
    expect(row(text, "Builder")).toBe("Kiro Crew first | If it fails, Kiro CLI gets one try.");
    expect(row(text, "Where Kiro Crew runs")).toBe("Inside Overnight&#39;s own sandbox");
    expect(row(text, "Morning delivery")).toBe("7:00 AM | Checking and publishing start earlier, at 6:30 AM.");
    expect(row(text, "Apps are published to")).toBe("The GitHub Pages repo overnight-apps | Published apps are public.");
    expect(row(text, "Bee remembers each delivered app")).toBe("Yes");
    expect(text).not.toContain(HOME);
  });

  it("follows the settings when they change", () => {
    const text = settings({ env: { ASK_CUTOFF: "22:30", BUILD_TIME: "00:15", DELIVER_TIME: "12:05", MAX_BUILD_CREDITS_PER_MONTH: "0", BUILD_BACKEND: "kiro-cli", BUILD_SANDBOX: "crew", WRITE_BEE_FACTS: "false", BUILD_TIMEOUT_MIN: "1", MAX_ASKS_PER_DAY: "5", MAX_BUILDS_PER_NIGHT: "4", GITHUB_PAGES_REPO: "night-apps", TZ: "America/Denver" } });
    expect(row(text, "Quiet hours")).toBe("10:30 PM to 12:05 PM | Nothing buzzes the wrist in these hours.");
    expect(row(text, "Builds start at")).toBe("12:15 AM");
    expect(row(text, "Morning delivery")).toContain("12:05 PM | ");
    expect(row(text, "Kiro credits a month")).toBe("At most 0 | At 0, nothing is ever built.");
    expect(row(text, "Builder")).toBe("Kiro CLI first | If it fails, Kiro Crew gets one try.");
    expect(row(text, "Where Kiro Crew runs")).toBe("Inside Kiro Crew&#39;s own sandbox");
    expect(row(text, "Bee remembers each delivered app")).toBe("No");
    expect(row(text, "Time limit for one build")).toBe("1 minute");
    expect(row(text, "Asks on the wrist")).toBe("At most 5 a day");
    expect(row(text, "Builds a night")).toBe("At most 4");
    expect(row(text, "Apps are published to")).toContain("night-apps");
    expect(row(text, "Time zone")).toContain("America/Denver");
  });

  // The page used to show the limit and never what had been counted against it.
  it("says what has been counted against the month's credit limit, as status does", () => {
    const counted = (credits: number, limit: number, estimated = 0): string => {
      const env = { MAX_BUILD_CREDITS_PER_MONTH: String(limit) };
      const budget = buildBudget({ buildCreditsBetween: () => ({ credits, estimated, tries: 2 }) }, fakeConfig(env), NOW);
      return row(settings({ env, buildCredits: budget }), "Kiro credits a month");
    };
    const rule = "Once this many are counted for the month, nothing more is built until the next one.";
    expect(counted(0, 400)).toBe(`At most 400 | 0 of 400 counted this month. ${rule}`);
    expect(counted(123.456, 400)).toBe(`At most 400 | 123.5 of 400 counted this month. ${rule}`);
    expect(counted(10.38, 400, 4.09)).toBe(`At most 400 | 10.4 of 400 counted this month (4.1 of that is an estimate). ${rule}`);
    // Reached: when building starts again, in the settings' zone.
    expect(counted(10.38, 5, 4.09)).toBe("At most 5 | 10.4 of 5 counted this month (4.1 of that is an estimate): nothing more is built until Nov 1, or until this limit is raised.");
    expect(counted(5, 5)).toBe("At most 5 | 5 of 5 counted this month: nothing more is built until Nov 1, or until this limit is raised.");
    // A limit of 0 is a choice: next month changes nothing.
    expect(counted(3.09, 0)).toBe("At most 0 | 3.1 counted this month. At 0, nothing is ever built.");
    // An estimate too small to show is not mentioned.
    expect(counted(1, 400, 0.04)).toBe(`At most 400 | 1 of 400 counted this month. ${rule}`);
    // The ledger could not be read: the limit and the rule, and no number.
    expect(row(settings({ buildCredits: null }), "Kiro credits a month")).toBe(`At most 400 | ${rule}`);
  });

  it("says whether asking and building are on from the database, and what .env starts them as", () => {
    expect(row(settings({ paused: false, env: { PAUSED: "true" } }), "Asking and building")).toBe("On | This is what the database says now. The .env file starts it as paused.");
    expect(row(settings({ paused: true, env: { PAUSED: "false" } }), "Asking and building")).toBe("Paused (quiet mode) | This is what the database says now. The .env file starts it as on.");
  });

  it("says which mode the dashboard itself is in", () => {
    const real = settings({ demo: false, port: 4321 });
    expect(row(real, "Data")).toBe("Real data");
    expect(row(real, "Address")).toBe("http://127.0.0.1:4321 | It answers only on this Mac, and only when opened from its own link.");
    expect(row(real, "What was said")).toBe("Each idea&#39;s short quote is shown | Start the dashboard with --filming to hide it.");
    expect(row(real, "The lines Bee heard")).toBe("Never shown, in any mode | Today shows counts, times and bars only.");
    expect(real).not.toContain("Quotes let through");
    expect(real).not.toContain("Rows left out");
    const demo = settings({ demo: true, port: 4999 });
    expect(row(demo, "Data")).toBe("Invented data (demo) | Every title, quote and number on these pages is made up.");
    expect(row(demo, "Address")).toContain("http://127.0.0.1:4999 | ");
  });

  it("says what filming hides, and which quotes were let through", () => {
    const filming = settings({ filming: [] });
    expect(row(filming, "What was said")).toBe("Hidden (filming mode) | Ideas nobody has approved and the build agent&#39;s notes are hidden too.");
    expect(filming).not.toContain("Quotes let through");
    expect(row(settings({ filming: ["idea_a", "idea_b"] }), "Quotes let through")).toBe("idea_a, idea_b");
  });

  it("says when saved rows were left out", () => {
    expect(row(settings({ unreadableRows: 2 }), "Rows left out")).toBe("2 saved rows | They did not have the shape this page expects, so they are not shown.");
    expect(row(settings({ unreadableRows: 1 }), "Rows left out")).toContain("1 saved row | ");
  });

  it("ends by saying that it changes nothing", () => {
    expect(settings()).toContain('<p class="closing">This page changes nothing. Settings live in the .env file at the top of the repo.</p>');
  });
});

// ---------- the pages with no data ----------

describe("the pages with no data in them", () => {
  it("tells a visitor without the key where the link comes from, with the port it is on", () => {
    const view = renderProblem("needs-key", { port: 4321 });
    expect(view.main.text).toContain("This dashboard opens from its own link. Ask Claude Code for it. It starts with http://127.0.0.1:4321/?key=</p>");
    expect(renderProblem("needs-key", { port: 4999 }).main.text).toContain("http://127.0.0.1:4999/?key=</p>");
    expect(view.title).toBe("Open it from its link");
  });

  it("says there is nothing at an address, and leads back to Today", () => {
    const view = renderProblem("not-found", { port: 4321 });
    expect(view.title).toBe("Nothing here");
    expect(view.main.text).toContain("<h1>Nothing here</h1><p>There is no page at this address.</p>");
    expect(view.main.text).toContain('<a class="button" href="/">Go to Today</a>');
  });

  it("says something went wrong without saying what, and that nothing was changed", () => {
    const view = renderProblem("error", { port: 4321 });
    expect(view.title).toBe("Something went wrong");
    expect(view.main.text).toContain("This page could not be made just now. Nothing was changed.");
  });

  it.each(["needs-key", "not-found", "error"] as const)("has nothing live in %s, so the script leaves it alone", (kind) => {
    const text = renderDocument(renderProblem(kind, { port: 4321 }), fakeChrome({ current: "none" })).text;
    const main = /<main id="main">([\s\S]*)<\/main>/.exec(text)?.[1] ?? "";
    expect(main).toContain("<h1>");
    expect(main).not.toContain("data-live");
  });
});

// ---------- text that is not ours ----------

describe("text that came from speech or from a model", () => {
  const sc = scene();
  const probes = Object.values(HOSTILE).join(" ");
  const bad = (idea: DashIdea): DashIdea => ({
    ...idea,
    title: `${HOSTILE.tag} ${HOSTILE.attribute} ${HOSTILE.backwards}`,
    pitch: `${HOSTILE.image} ${HOSTILE.closing} ${HOSTILE.longWord}`,
    quote: { shown: true, text: probes },
    note: probes,
    failureReason: idea.failureReason === null ? null : probes,
    buildBackend: idea.buildBackend === null ? null : HOSTILE.attribute,
    publishedUrl: idea.publishedUrl === null ? null : HOSTILE.address,
    slug: HOSTILE.tag,
  });
  const ideas = sc.s.ideas.map(bad);
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  const pick = (idea: DashIdea): DashIdea => byId.get(idea.id) ?? idea;
  const stories = new Map(ideas.map((idea) => [idea.id, fakeStory(idea, { hint: probes, checks: [{ key: HOSTILE.attribute, label: probes, status: "failed", detail: probes, since: HOSTILE.attribute }], steps: { asked: { label: probes, detail: probes, at: HOSTILE.attribute }, checked: { detail: probes } }, runningSince: HOSTILE.attribute, runningLabel: probes })]));
  const s = { ...sc.s, ideas, heard: sc.s.heard.map((group) => ({ ...group, lastAt: HOSTILE.attribute })), lastHeardAt: HOSTILE.attribute, dayStart: sc.s.dayStart };
  const hero = pick(sc.ideas.packing);
  const extras = fakeExtras({ report: fakeReport(), shots: { phone: true, desktop: true }, brief: { text: probes, cut: true }, notes: { text: probes, cut: false } });
  const events = fakeEvents(hero, ["heard", "asked"]).map((event) => ({ ...event, note: probes, at: HOSTILE.attribute }));
  const nights: Night[] = sc.nights.map((night) => ({ ...night, label: probes, headline: probes, ideas: night.ideas.map((row) => ({ ...row, idea: pick(row.idea) })) }));
  const story = stories.get(hero.id) ?? fakeStory(hero);
  const c = fakeContext({ filming: { on: true, showQuoteFor: new Set([HOSTILE.attribute, HOSTILE.tag]) } });
  // The time zone is a checked setting, not somebody's words, so it stays as it is.
  const chrome = fakeChrome({ staleSince: HOSTILE.attribute, problem: "busy" });
  const pages: Array<[string, string]> = [
    ["Today", renderDocument(renderToday(s, { idea: hero, story, extras }, { over: "Tonight", before: probes, title: hero.title, after: probes }, { night: nights[0]!, label: "Tonight" }, { ...sc.queue, rows: sc.queue.rows.map((queued) => ({ ...queued, idea: pick(queued.idea) })) }, stories, c, sc.thumbs), chrome).text],
    ["Ideas", renderDocument(renderIdeas(s, stories, sc.thumbs, c), chrome).text],
    ["one idea", renderDocument(renderIdea(s, hero, story, extras, events, c), chrome).text],
    ["Nights", renderDocument(renderNights(nights, stories, c), chrome).text],
    ["Settings", renderDocument(renderSettings(s, c, { demo: true, port: 4321 }), chrome).text],
  ];

  it.each(pages)("never becomes markup on %s", (_name, text) => {
    expect(text).not.toContain("<xss-probe");
    expect(text).not.toContain('" data-xss-probe=');
    expect(text).not.toMatch(/<img[^>]*onerror/);
    expect(text).not.toMatch(/href="\s*javascript/i);
    expect(text).not.toMatch(/\sstyle="/);
    expect(text.match(/<script\b/g)).toHaveLength(1);
    // No tag on the page carries an inline handler.
    for (const tag of text.match(/<[a-z][^>]*>/gi) ?? []) expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
    // The character that turns the rest of a line round is dropped.
    expect(text).not.toContain("‮");
  });

  it("is still there to read, as text", () => {
    const today = pages[0]?.[1] ?? "";
    expect(today).toContain("&lt;xss-probe&gt;Chore&lt;/xss-probe&gt;");
    expect(today).toContain("&quot; data-xss-probe=&quot;1");
    expect(pages[2]?.[1]).toContain("Published at javascript:alert(1) (shown as text");
  });
});
