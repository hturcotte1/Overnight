// Nights: one card per night, newest first. A night runs from noon to noon and is named by its
// morning ("Sat, Oct 10 to Sun, Oct 11"). Each card gives the night in one line, the counts, when
// the build and the morning's work ran (while the logs still have them), and one row per idea.
import type { BuildRun, DeliverRun, Night, RenderContext, Story, View } from "../types.ts";
import { count, dotted, ideaHref, live, miniStory, rehearsalTag } from "./components.ts";
import { backendLabel, clockTime, duration, plural, STATE_LABELS } from "./format.ts";
import { html } from "./html.ts";
import type { SafeHtml } from "./html.ts";

const MINUTE_MS = 60_000;

/**
 * "1:00 AM to 1:03 AM", or only the start when the log has no end for the run. A run that began
 * and ended within the same minute would read "6:30 AM to 6:30 AM", so it says how short it was.
 */
function runTimes(run: BuildRun | DeliverRun, timeZone: string): string {
  const start = clockTime(run.startedAt, timeZone);
  if (run.finishedAt === null) return `started ${start}`;
  const end = clockTime(run.finishedAt, timeZone);
  const took = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return end === start && took >= 0 && took < MINUTE_MS ? `${start}, under a minute` : `${start} to ${end}`;
}

function sandboxWords(run: BuildRun): string | null {
  if (run.sandboxCheck === null) return null;
  if (!run.sandboxCheck.ok) return "sandbox check failed";
  return run.sandboxCheck.ms === null ? "sandbox check passed" : `sandbox check passed in ${duration(run.sandboxCheck.ms)}`;
}

function runs(night: Night, timeZone: string): SafeHtml | null {
  const build = night.buildRun === null ? null : html`<div><dt>Build</dt><dd>${dotted([runTimes(night.buildRun, timeZone), sandboxWords(night.buildRun)])}</dd></div>`;
  const morning = night.deliverRun === null ? null : html`<div><dt>Morning</dt><dd>${runTimes(night.deliverRun, timeZone)}</dd></div>`;
  return build === null && morning === null ? null : html`<dl class="night__runs">${build}${morning}</dl>`;
}

/**
 * Marks a night whose own run was started by hand instead of by the nightly job. One idea built
 * by hand the evening before does not make the nightly job's night a by-hand one: that idea's own
 * row says so instead.
 */
function byHandTags(night: Night): SafeHtml[] {
  const commands = new Set([night.buildRun?.command, night.deliverRun?.command]);
  const tags: SafeHtml[] = [];
  if (commands.has("build-now")) tags.push(html`<span class="tag">started by hand (build-now)</span>`);
  if (commands.has("rehearse")) tags.push(html`<span class="tag">rehearsal</span>`);
  return tags;
}

function ideaRow(row: Night["ideas"][number], night: Night, stories: ReadonlyMap<string, Story>): SafeHtml {
  const href = ideaHref(row.idea.id);
  const title = href === null ? html`<b>${row.idea.title}</b>` : html`<b><a href="${href}">${row.idea.title}</a></b>`;
  // Built by hand on a night that was the nightly job's: said here, on the one row it is true of.
  const nightIsByHand = night.buildRun?.command === "build-now" || night.deliverRun?.command === "build-now";
  const byHand = row.by === "build-now" && !nightIsByHand ? html`<span class="tag tag--plain">built by hand (build-now)</span>` : null;
  const words = dotted([
    // A build that was cut short and gets one more try has not failed, whatever state it was left in.
    row.cutShort ? "Cut short" : (STATE_LABELS[row.outcome] ?? "Unknown"),
    backendLabel(row.idea.buildBackend),
    row.buildSeconds === null ? null : duration(row.buildSeconds * 1000),
    row.credits === null ? null : plural(row.credits, "credit"),
  ]);
  return html`<li class="row"><span class="row__name">${title}${rehearsalTag(row.idea)}${byHand}</span>${miniStory(stories.get(row.idea.id))}<small>${words}</small></li>`;
}

function nightCard(night: Night, stories: ReadonlyMap<string, Story>, c: RenderContext): SafeHtml {
  const seconds = night.ideas.reduce((sum, row) => sum + (row.buildSeconds ?? 0), 0);
  const stats = dotted([
    `${count(night.built)} built`,
    `${count(night.delivered)} delivered`,
    `${count(night.failed)} failed`,
    // Said on its own, and only when there is one: cut short is not failed.
    night.cutShort > 0 ? `${count(night.cutShort)} cut short, to be built once more` : null,
    seconds > 0 ? `${duration(seconds * 1000)} of building` : null,
    night.credits === null ? null : plural(night.credits, "Kiro credit"),
  ]);
  const ideas = night.ideas.length === 0 ? null : html`<ul class="rows night__ideas">${night.ideas.map((row) => ideaRow(row, night, stories))}</ul>`;
  return html`<article class="card"><h2 class="night__label">${night.label}${byHandTags(night)}</h2><p class="night__headline">${night.headline}</p><p class="night__stats">${stats}</p>${runs(night, c.config.timeZone)}${ideas}</article>`;
}

export function renderNights(nights: readonly Night[], stories: ReadonlyMap<string, Story>, c: RenderContext): View {
  const body =
    nights.length === 0
      ? html`<div class="card empty"><p>No nights yet. The first night Overnight builds something, it shows up here.</p></div>`
      : html`<div class="nights">${nights.map((night) => nightCard(night, stories, c))}</div>`;
  return { title: "Nights", main: html`<h1 class="page-title">Nights</h1>
${live("nights", body)}` };
}
