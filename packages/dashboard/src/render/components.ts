// The pieces every page is put together from: the live region, the seven-step story, the night's
// ticks, the seven-dot mini story, the idea card, state pills, running clocks and the icons.
//
// All of it is pure (a piece is made from what it is handed, never from a file or the clock) and
// all of it goes through the html`` template, so a title or a quote can never become markup.
// The ids, the data- attributes and the class names are a promise to public/app.js, to
// public/app.css and to the browser tests: change them in all of those places or in none.
import { createHash } from "node:crypto";
import { IDEA_ID } from "../types.ts";
import type { BuildFacts, Check, DashIdea, RenderContext, Said, Snapshot, StepKey, StepStatus, Story, StoryStep } from "../types.ts";
import { backendLabel, clockTime, dayTime, duration, STATE_LABELS } from "./format.ts";
import { html, safeHref } from "./html.ts";
import type { Renderable, SafeHtml } from "./html.ts";

// ---------- Live regions ----------

/**
 * A part of the page the script keeps fresh. `data-rev` is a fingerprint of what is inside: the
 * script swaps a region in only when its fingerprint differs from the one on screen, so nothing
 * flickers while nothing has changed. A region with nothing in it is hidden by the stylesheet,
 * so every page always carries the same set of regions.
 */
export function live(id: string, body: SafeHtml, className?: string): SafeHtml {
  const rev = createHash("sha1").update(body.text).digest("hex").slice(0, 12);
  if (className === undefined) return html`<section id="${id}" data-live data-rev="${rev}">${body}</section>`;
  return html`<section id="${id}" class="${className}" data-live data-rev="${rev}">${body}</section>`;
}

// ---------- Small helpers ----------

/** Nothing at all: the body of a live region that has nothing to show. */
export const NOTHING: SafeHtml = html``;

const WHOLE_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A count with its thousands grouped: "1,204". */
export function count(n: number): string {
  return Number.isFinite(n) ? WHOLE_NUMBER.format(n) : "0";
}

/** The parts that are there, with " · " between them. */
export function dotted(parts: readonly Renderable[]): SafeHtml {
  const there = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return html`${there.map((part, index) => (index === 0 ? part : html` · ${part}`))}`;
}

/** The address of an idea's own page, or null for an id no address may be built from. */
export function ideaHref(ideaId: string): string | null {
  return IDEA_ID.test(ideaId) ? `/ideas/${ideaId}` : null;
}

/** The address of one of an idea's two pictures, or null for an id no address may be built from. */
export function shotSrc(ideaId: string, which: "phone" | "desktop"): string | null {
  return IDEA_ID.test(ideaId) ? `/shots/${ideaId}/${which}.png` : null;
}

// ---------- Times ----------

/** What a piece needs to write a time: the zone, "now", and where the page's day began. */
export interface Clock {
  timeZone: string;
  now: Date;
  /** The latest DELIVER_TIME at or before now (Snapshot.dayStart). */
  dayStart: string;
}

export function clockOf(s: Pick<Snapshot, "dayStart">, c: Pick<RenderContext, "now" | "config">): Clock {
  return { timeZone: c.config.timeZone, now: c.now, dayStart: s.dayStart };
}

/**
 * A time in as few words as stay clear: "12:41 PM" for anything in the page's current day (so at
 * 1:00 AM yesterday afternoon still reads "12:41 PM") or on today's date, and "yesterday, 7:00 AM"
 * or "Oct 9, 6:02 PM" for anything older.
 */
export function shortTime(at: string, k: Clock): string {
  const full = dayTime(at, k.timeZone, k.now);
  // dayTime starts with "today, " for a time on today's date: that is its contract (format.ts).
  const todaysDate = full.startsWith("today, ");
  const inThePagesDay = Date.parse(at) >= Date.parse(k.dayStart);
  return todaysDate || inThePagesDay ? clockTime(at, k.timeZone) : full;
}

/**
 * A running clock. The script turns it into "1:12" (elapsed) or "12 s ago" (ago) and keeps it
 * ticking. The words written here never change while the fact does not ("since 1:00 AM"), so a
 * clock does not make its region look changed on every look.
 */
export function sinceClock(at: string, kind: "elapsed" | "ago", k: Clock): SafeHtml {
  const words = kind === "elapsed" ? `since ${shortTime(at, k)}` : `at ${shortTime(at, k)}`;
  return html`<time datetime="${at}" data-since="${at}" data-clock="${kind}">${words}</time>`;
}

// ---------- Icons (templates with no values in them) ----------

const STEP_ICONS: Readonly<Record<StepKey, SafeHtml>> = {
  heard: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>`,
  asked: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9.5 7l.6-3.5h3.8l.6 3.5M9.5 17l.6 3.5h3.8l.6-3.5"/></svg>`,
  approved: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  built: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.3A8.3 8.3 0 0 1 9.7 4a8.5 8.5 0 1 0 10.3 10.3z"/></svg>`,
  checked: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.5-3 7.6-7 9.5-4-1.9-7-5-7-9.5V6l7-3z"/><path d="M9 12l2.2 2.2L15 10.4"/></svg>`,
  published: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/></svg>`,
  delivered: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>`,
};

/** The moon beside the name. */
export const MOON_ICON: SafeHtml = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.8 8.8 0 1 0 10.7 10.7z"/></svg>`;
/** An arrow up and out, for a link that opens in a new tab. */
export const OUT_ICON: SafeHtml = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3L4 12"/></svg>`;
const TICK_ICON: SafeHtml = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.6 2.6L12 5.6"/></svg>`;
const CROSS_ICON: SafeHtml = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>`;

// ---------- What was said ----------

/** The words under the Heard step: the quote, or that it is hidden. Nothing when the idea never had one. */
function saidLine(said: Said | null): SafeHtml | null {
  if (said === null) return null;
  if (said.shown) return html`<p class="step__detail">“${said.text}”</p>`;
  if (said.why === "filming") return html`<p class="step__detail step__hidden">Hidden while filming</p>`;
  return null;
}

/** The quote in full, for the idea's own page. Nothing when the idea never had one. */
export function saidBlock(said: Said): SafeHtml | null {
  if (said.shown) return html`<blockquote class="said"><span class="said__label">What was said</span>“${said.text}”</blockquote>`;
  if (said.why === "filming") return html`<p class="said said--hidden"><span class="said__label">What was said</span>Hidden while filming</p>`;
  return null;
}

/**
 * The link to a published app. Only an https address becomes a link, and it opens in a new tab
 * that learns nothing about this page. Any other address is shown as text.
 */
export function openTheApp(idea: DashIdea, withAddress = true): SafeHtml | null {
  if (idea.publishedUrl === null || idea.publishedUrl === "") return null;
  const href = safeHref(idea.publishedUrl);
  if (href === null) return html`<p class="address">Published at ${idea.publishedUrl} (shown as text, because it is not an https address)</p>`;
  return html`<p class="open"><a class="button" href="${href}" target="_blank" rel="noopener noreferrer">Open the app${OUT_ICON}</a>${withAddress ? html`<span class="open__address">${href}</span>` : null}</p>`;
}

// ---------- The seven-step story ----------

function stepItem(step: StoryStep, next: StoryStep | undefined, k: Clock): SafeHtml {
  // On a phone the line runs down from a finished step to the next one that has been reached.
  const lineGoesOn = step.status === "done" && next !== undefined && (next.status === "done" || next.status === "active");
  const current = step.status === "active" ? html` aria-current="step"` : null;
  // A step still to come has no time of its own. What it waits for ("at 6:30 AM") goes where the time would be.
  const waitsFor = step.at === null && step.status === "todo" && step.detail !== null;
  const time = step.at !== null ? html`<time class="step__time" datetime="${step.at}">${shortTime(step.at, k)}</time>` : waitsFor ? html`<span class="step__time">${step.detail}</span>` : null;
  const detail = step.detail !== null && !waitsFor ? html`<p class="step__detail">${step.detail}</p>` : null;
  return html`<li class="step step--${step.status}${lineGoesOn ? " step--out" : ""}" data-step="${step.key}" data-status="${step.status}"${current}><span class="step__dot">${STEP_ICONS[step.key] ?? null}</span><div class="step__text"><b class="step__label">${step.label}</b>${time}${saidLine(step.said)}${detail}</div></li>`;
}

/** The seven steps of one idea, Heard to Delivered. */
export function storySteps(story: Story, k: Clock): SafeHtml {
  return html`<ol class="story" data-idea="${story.ideaId}">${story.steps.map((step, index) => stepItem(step, story.steps[index + 1], k))}</ol>`;
}

const PLACEHOLDER_STEPS: ReadonlyArray<{ key: StepKey; label: string }> = [
  { key: "heard", label: "Heard" },
  { key: "asked", label: "Asked" },
  { key: "approved", label: "Approved" },
  { key: "built", label: "Built" },
  { key: "checked", label: "Checked" },
  { key: "published", label: "Published" },
  { key: "delivered", label: "Delivered" },
];

/** The seven steps with nothing done yet: what an idea's story will look like, shown before there is an idea. */
export function storyToCome(k: Clock): SafeHtml {
  const steps: StoryStep[] = PLACEHOLDER_STEPS.map((step) => ({ ...step, status: "todo", at: null, detail: null, said: null }));
  return html`<ol class="story">${steps.map((step, index) => stepItem(step, steps[index + 1], k))}</ol>`;
}

// ---------- The night's ticks ----------

/** The story's small ticks, for the files a build in progress has made so far, carry a key that starts like this. */
const SMALL_TICK = "mark-";

function checkItem(check: Check, k: Clock): SafeHtml {
  const mark = check.status === "done" ? TICK_ICON : check.status === "failed" ? CROSS_ICON : null;
  const size = check.key.startsWith(SMALL_TICK) ? " check--small" : "";
  const clock = check.since !== null ? sinceClock(check.since, "elapsed", k) : null;
  const small = check.detail !== null || clock !== null ? html` <small>${dotted([check.detail, clock])}</small>` : null;
  return html`<li class="check check--${check.status}${size}" data-check="${check.key}" data-status="${check.status}"><span class="check__mark">${mark}</span>${check.label}${small}</li>`;
}

/** The row of ticks under a story (sign-in fresh, sandbox check passed, building ...). Nothing when there are none. */
export function checksRow(story: Story, k: Clock): SafeHtml | null {
  if (story.checks.length === 0) return null;
  return html`<ul class="checks" aria-label="The night, step by step" data-idea="${story.ideaId}">${story.checks.map((check) => checkItem(check, k))}</ul>`;
}

/** The one line that says how to try again, when the story has one. */
export function hintLine(story: Story): SafeHtml | null {
  return story.hint === null ? null : html`<p class="hint">${story.hint}</p>`;
}

// ---------- The mini story: seven dots ----------

const MINI_CLASSES: Readonly<Record<StepStatus, string>> = { done: "is-done", active: "is-active", failed: "is-failed", waiting: "is-waiting", ended: "is-ended", todo: "" };

/** The same seven steps as seven dots, for a card. The state pill beside it says the same in words. */
export function miniStory(story: Story | undefined): SafeHtml | null {
  if (story === undefined) return null;
  return html`<ol class="mini" aria-hidden="true">${story.steps.map((step) => html`<li class="${MINI_CLASSES[step.status] ?? ""}"></li>`)}</ol>`;
}

// ---------- Pills and tags ----------

/** How an idea's state pill is coloured. */
function stateTone(idea: DashIdea): string {
  if (idea.awaitingRetry) return "state--waiting";
  switch (idea.state) {
    case "delivered":
      return "state--delivered";
    case "build_failed":
    case "publish_failed":
      return "state--failed";
    case "building":
      return "state--active";
    case "rejected":
    case "expired":
      return "state--ended";
    default:
      return "";
  }
}

/** An idea's state in the page's words. A build that was cut short and gets one more try says so. */
export function stateLabel(idea: DashIdea): string {
  return idea.awaitingRetry ? "Cut short" : (STATE_LABELS[idea.state] ?? "Unknown");
}

export function statePill(idea: DashIdea): SafeHtml {
  return html`<span class="state ${stateTone(idea)}">${stateLabel(idea)}</span>`;
}

/** The mark on an idea that `overnight rehearse` invented. */
export function rehearsalTag(idea: DashIdea): SafeHtml | null {
  return idea.rehearsal ? html`<span class="tag tag--plain">Rehearsal</span>` : null;
}

// ---------- The idea card ----------

/** The time that goes with an idea's state: when it was delivered, when it was approved, and so on. */
export function stateTime(idea: DashIdea): string {
  switch (idea.state) {
    case "heard":
      return idea.createdAt;
    case "asked":
      return idea.askedAt ?? idea.updatedAt;
    case "approved":
    case "rejected":
      return idea.answeredAt ?? idea.updatedAt;
    case "building":
      return idea.buildStartedAt ?? idea.updatedAt;
    case "built":
      return idea.builtAt ?? idea.updatedAt;
    case "published":
      return idea.publishedAt ?? idea.updatedAt;
    case "delivered":
      return idea.deliveredAt ?? idea.publishedAt ?? idea.updatedAt;
    default:
      return idea.updatedAt;
  }
}

/** How long the build took, in seconds: from the build log when it has it, else from the idea's own two times. */
export function buildSeconds(idea: DashIdea, facts: BuildFacts | undefined): number | null {
  const logged = facts?.finished?.seconds;
  if (typeof logged === "number" && Number.isFinite(logged) && logged >= 0) return logged;
  if (idea.buildStartedAt === null || idea.builtAt === null) return null;
  const ms = Date.parse(idea.builtAt) - Date.parse(idea.buildStartedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

/** Our own short words (a time, a length of time) that read badly when a line breaks inside them. */
function unbroken(words: string): SafeHtml {
  return html`<span class="nowrap">${words}</span>`;
}

/** "Kiro Crew · 2 min 40 s" for an idea that was built; nothing before that. */
export function builderWords(idea: DashIdea, seconds: number | null): SafeHtml | null {
  const builder = backendLabel(idea.buildBackend);
  const took = seconds === null || idea.builtAt === null ? null : unbroken(duration(seconds * 1000));
  return builder === "" && took === null ? null : dotted([builder, took]);
}

export interface CardOptions {
  story: Story | undefined;
  /** Is there a phone picture of the published app to show? */
  thumb: boolean;
  facts: BuildFacts | undefined;
  /** The heading level of the title: 2 on the Ideas page, 3 under a section title. */
  level: 2 | 3;
  timeZone: string;
  now: Date;
}

/** One idea as a card: title, state, when, builder and build time, the mini story, the reason if it failed. */
export function ideaCard(idea: DashIdea, o: CardOptions): SafeHtml {
  const title = o.level === 2 ? html`<h2 class="idea__title">${idea.title}</h2>` : html`<h3 class="idea__title">${idea.title}</h3>`;
  const failed = idea.state === "build_failed" || idea.state === "publish_failed";
  const meta = dotted([statePill(idea), rehearsalTag(idea), unbroken(dayTime(stateTime(idea), o.timeZone, o.now)), builderWords(idea, buildSeconds(idea, o.facts)), failed ? idea.failureReason : null]);
  const src = o.thumb ? shotSrc(idea.id, "phone") : null;
  const picture = src === null ? null : html`<img class="idea__shot" alt="" src="${src}" width="62" height="110" loading="lazy">`;
  const inside = html`<div class="idea__text">${title}<p class="idea__meta">${meta}</p>${miniStory(o.story)}</div>${picture}`;
  const href = ideaHref(idea.id);
  return href === null ? html`<div class="card idea">${inside}</div>` : html`<a class="card idea" href="${href}">${inside}</a>`;
}

// ---------- Nothing saved yet ----------

/** What a page shows when Overnight has never run with this data folder. The folder is given with the home folder as "~". */
export function nothingSavedYet(folder: string): SafeHtml {
  return live(
    "empty",
    html`<div class="card empty"><h1>Nothing saved yet</h1><p>Overnight has not run with this data folder: ${folder}.</p><p>This page keeps looking and fills in by itself.</p></div>`,
  );
}
