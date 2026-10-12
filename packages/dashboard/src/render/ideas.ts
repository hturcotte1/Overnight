// Ideas: every idea as a card, newest first (the 200 newest: the database look stops there).
// A card shows the title, the state, when, the builder and the build time, the story as seven
// dots, the reason if it failed, and a small picture of the app once it is out.
import type { RenderContext, Snapshot, Story, View } from "../types.ts";
import { ideaCard, live, nothingSavedYet } from "./components.ts";
import { homeTilde, plural } from "./format.ts";
import { html } from "./html.ts";

/** `thumbs` holds the ids of the ideas that have a phone picture to show. */
export function renderIdeas(s: Snapshot, stories: ReadonlyMap<string, Story>, thumbs: ReadonlySet<string>, c: RenderContext): View {
  if (s.problem === "missing" || s.problem === "empty") return { title: "Ideas", main: nothingSavedYet(homeTilde(c.config.dataDir, c.home)) };
  const cards = s.ideas.map((idea) => ideaCard(idea, { story: stories.get(idea.id), thumb: thumbs.has(idea.id), facts: s.build.get(idea.id), level: 2, timeZone: c.config.timeZone, now: c.now }));
  const body =
    cards.length === 0
      ? html`<div class="card empty"><p>No ideas yet. When Overnight hears one, it shows up here.</p></div>`
      : html`<p class="page-sub">${plural(cards.length, "idea")}, newest first</p><div class="ideas">${cards}</div>`;
  return { title: "Ideas", main: html`<h1 class="page-title">Ideas</h1>
${live("cards", body)}` };
}
