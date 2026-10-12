// One idea's own page: its story in full, what was said (or that it is hidden), the pitch, the
// link to the app, both pictures, the facts of its build and its morning, the brief, the build
// agent's notes, and every change of state it went through.
//
// The brief and the notes are shown as plain text, never as Markdown: an agent wrote the notes,
// and plain text cannot do anything. The home folder in them is shown as "~".
import type { IdeaEvent } from "@overnight/core";
import type { DashIdea, IdeaExtras, RenderContext, ReportView, Snapshot, Story, View } from "../types.ts";
import { buildSeconds, checksRow, clockOf, count, dotted, hintLine, live, NOTHING, openTheApp, rehearsalTag, saidBlock, shotSrc, sinceClock, statePill, storySteps } from "./components.ts";
import type { Clock } from "./components.ts";
import { backendLabel, bytes, dayTime, duration, homeTilde, plural, STATE_LABELS } from "./format.ts";
import { html } from "./html.ts";
import type { Renderable, SafeHtml } from "./html.ts";

// ---------- The story, with the idea's own words above it ----------

function storyBody(idea: DashIdea, story: Story, k: Clock): SafeHtml {
  const pitch = idea.pitch === "" ? null : html`<p class="hero__pitch">${idea.pitch}</p>`;
  const clock = story.runningSince === null ? null : html`<div class="hero__clock"><b>${sinceClock(story.runningSince, "elapsed", k)}</b><span>${story.runningLabel}</span></div>`;
  return html`<div class="hero__head"><div class="hero__words"><p class="hero__tags">${statePill(idea)}${rehearsalTag(idea)}</p><h1 class="hero__now">${idea.title}</h1>${pitch}${saidBlock(idea.quote)}${openTheApp(idea)}</div>${clock}</div>${storySteps(story, k)}${checksRow(story, k)}${hintLine(story)}`;
}

// ---------- The pictures ----------

function shotsBody(idea: DashIdea, extras: IdeaExtras): SafeHtml {
  const phone = extras.shots.phone ? shotSrc(idea.id, "phone") : null;
  const desktop = extras.shots.desktop ? shotSrc(idea.id, "desktop") : null;
  if (phone === null && desktop === null) return NOTHING;
  return html`<h2 class="block-title">The app, as it was checked</h2><div class="shots">${
    phone === null ? null : html`<figure class="shot shot--phone"><img src="${phone}" alt="The app on a phone screen" loading="lazy"><figcaption>Phone</figcaption></figure>`
  }${desktop === null ? null : html`<figure class="shot shot--desktop"><img src="${desktop}" alt="The app on a desktop screen" loading="lazy"><figcaption>Desktop</figcaption></figure>`}</div>`;
}

// ---------- The facts ----------

function fact(label: string, value: Renderable, wide = false): SafeHtml {
  return html`<div class="fact${wide ? " fact--wide" : ""}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

/** Yes, no, or that nobody knows. */
function yesNo(value: boolean | null, unknown: string): SafeHtml {
  if (value === true) return html`<span class="yes">yes</span>`;
  if (value === false) return html`<span class="no">no</span>`;
  return html`<span class="muted">${unknown}</span>`;
}

function reportFacts(report: ReportView | null): SafeHtml[] {
  if (report === null) return [];
  return [
    fact("Page confirmed live", yesNo(report.confirmedLive, "not known")),
    fact("Packages installed", yesNo(report.checks.installOk, "not checked")),
    fact("The app built", yesNo(report.checks.buildOk, "not checked")),
    fact("Passed our page checks", yesNo(report.checks.contractOk, "not checked")),
    fact("Its own test passed", yesNo(report.checks.appSmokeOk, "not checked")),
  ];
}

function factsBody(s: Snapshot, idea: DashIdea, extras: IdeaExtras): SafeHtml {
  const build = s.build.get(idea.id);
  const deliver = s.deliver.get(idea.id);
  const report = extras.report;
  const rows: SafeHtml[] = [];

  const builder = backendLabel(idea.buildBackend);
  if (builder !== "") rows.push(fact("Builder", build?.fellBack ? `${builder}, after the first builder failed` : builder));
  const seconds = buildSeconds(idea, build);
  // A build that did not finish has no build time, but the log may say how long it ran before it stopped.
  if (seconds !== null) rows.push(fact(idea.builtAt !== null ? "Build time" : "Ran for", duration(seconds * 1000)));
  const credits = build?.finished?.credits ?? null;
  if (credits !== null) rows.push(fact("Kiro credits", plural(credits, "credit")));
  if (idea.buildStarts > 1) rows.push(fact("Build tries", count(idea.buildStarts)));

  const checkMs = report?.verifyMs ?? deliver?.checked?.ms ?? null;
  if (checkMs !== null) rows.push(fact("Check time", duration(checkMs)));
  const files = report?.distFiles ?? deliver?.checked?.files ?? null;
  const size = report?.distBytes ?? deliver?.checked?.bytes ?? null;
  if (files !== null || size !== null) rows.push(fact("Files and size", dotted([files === null ? null : plural(files, "file"), size === null ? null : bytes(size)])));
  const liveAfter = report?.liveAfterMs ?? deliver?.live?.liveAfterMs ?? null;
  if (liveAfter !== null) rows.push(fact("Live after", duration(liveAfter)));
  rows.push(...reportFacts(report));

  if (idea.failureReason !== null && idea.failureReason !== "") rows.push(fact(idea.awaitingRetry ? "Why it was cut short" : "Why it failed", idea.failureReason, true));
  if (rows.length === 0) return NOTHING;
  return html`<h2 class="block-title">Facts</h2><dl class="facts">${rows}</dl>`;
}

// ---------- The brief and the notes ----------

function docText(doc: { text: string; cut: boolean }, home: string): SafeHtml {
  return html`<pre>${homeTilde(doc.text, home)}</pre>${doc.cut ? html`<p class="doc__note">Only the first part is shown. The file is longer.</p>` : null}`;
}

function briefBody(extras: IdeaExtras, home: string): SafeHtml {
  if (extras.brief === null) return NOTHING;
  return html`<details id="brief-text" class="card doc"><summary>The brief <small>All the build agent was given</small></summary>${docText(extras.brief, home)}</details>`;
}

function notesBody(extras: IdeaExtras, home: string): SafeHtml {
  if (extras.notes === null) return NOTHING;
  if (extras.notes === "filming") return html`<p class="card plain-note">Build notes are hidden while filming.</p>`;
  return html`<details id="notes-text" class="card doc"><summary>Build notes <small>Written by the build agent</small></summary>${docText(extras.notes, home)}</details>`;
}

// ---------- The history ----------

function historyBody(events: readonly IdeaEvent[], c: RenderContext): SafeHtml {
  if (events.length === 0) return NOTHING;
  const rows = events.map(
    (event) =>
      html`<tr><td><time datetime="${event.at}">${dayTime(event.at, c.config.timeZone, c.now)}</time></td><td>${event.fromState === null ? "New" : (STATE_LABELS[event.fromState] ?? "Unknown")}</td><td>${STATE_LABELS[event.toState] ?? "Unknown"}</td><td>${event.note}</td></tr>`,
  );
  return html`<div class="card history-card"><h2 class="block-title">History</h2><table class="history"><thead><tr><th scope="col">When</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Note</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- The view ----------

export function renderIdea(s: Snapshot, idea: DashIdea, story: Story, extras: IdeaExtras, events: readonly IdeaEvent[], c: RenderContext): View {
  const k = clockOf(s, c);
  const main = html`${live("story", storyBody(idea, story, k), "card hero")}
<div class="split">
${live("shots", shotsBody(idea, extras), "card")}
${live("facts", factsBody(s, idea, extras), "card")}
</div>
<section id="brief">${briefBody(extras, c.home)}</section>
${live("notes", notesBody(extras, c.home))}
${live("history", historyBody(events, c))}`;
  return { title: idea.title, main };
}
