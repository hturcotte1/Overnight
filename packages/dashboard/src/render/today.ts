// Today: the one line about last night, one idea's story as the hero, three lanes (Heard, Asked,
// Tonight's build) and the other ideas as cards.
//
// A "day" here starts at the latest DELIVER_TIME, so at 1:00 AM the page still shows yesterday's
// listening. That is why the labels say "since 7:00 AM" and never "today".
//
// Nothing a conversation said is on this page except an idea's short quote under its Heard step.
// The Heard lane is counts, times and grey bars.
import type { DashIdea, HeardGroup, IdeaExtras, Night, RenderContext, Snapshot, Story, TonightQueue, View } from "../types.ts";
import { checksRow, clockOf, count, hintLine, ideaCard, ideaHref, live, NOTHING, nothingSavedYet, openTheApp, shotSrc, sinceClock, storySteps, storyToCome } from "./components.ts";
import type { Clock } from "./components.ts";
import { clockTime, homeTilde, plural } from "./format.ts";
import { html } from "./html.ts";
import type { SafeHtml } from "./html.ts";

/** What story.ts's nowLine gives: the small word above the headline, and the headline in three parts. */
export interface NowLine { over: "Tonight" | "This morning" | "Today"; before: string; title: string | null; after: string }

const NO_THUMBS: ReadonlySet<string> = new Set();
/** How many of a conversation's bars the Heard lane draws. The tag beside them gives the real count. */
const MAX_BARS = 4;
const MAX_ASKED_ROWS = 6;
const MAX_TODAY_CARDS = 12;
const MAX_EARLIER_CARDS = 6;

// ---------- The line about last night ----------

function lastNightLine(lastNight: { night: Night; label: "Last night" | "Tonight" } | null): SafeHtml {
  if (lastNight === null) return NOTHING;
  return html`<a href="/nights"><span class="lastnight__label">${lastNight.label}</span><span class="lastnight__headline">${lastNight.night.headline}</span><span class="lastnight__more">All nights</span></a>`;
}

// ---------- The hero ----------

/**
 * The headline: the words before the title, the title, the words after it ("Kiro Crew is
 * building", "Chore Wheel", "" or "", "Chore Wheel", "was delivered"). The title is put in
 * quotation marks and links to the idea's page. A title that filming replaced is not a name, so
 * it gets no marks. A space is added where two parts would otherwise run together.
 */
function headline(line: NowLine, idea: DashIdea | null): SafeHtml {
  if (line.title === null) return html`${line.before}${line.after}`;
  const before = line.before === "" || /\s$/u.test(line.before) ? line.before : `${line.before} `;
  const after = /^[\p{L}\p{N}(]/u.test(line.after) ? ` ${line.after}` : line.after;
  const name = idea?.hidden === true ? line.title : `“${line.title}”`;
  const href = idea === null ? null : ideaHref(idea.id);
  const title = href === null ? html`<span class="hero__title">${name}</span>` : html`<a class="hero__title" href="${href}">${name}</a>`;
  return html`${before}${title}${after}`;
}

function heroBody(hero: { idea: DashIdea; story: Story; extras: IdeaExtras } | null, line: NowLine, k: Clock): SafeHtml {
  // The wall clock is filled in by the script. It is left empty here so that the minute going by does not make the story look changed.
  const over = html`<p class="hero__over">${line.over}<span class="hero__wall" data-clock="wall"></span></p>`;
  const now = html`<h1 class="hero__now">${headline(line, hero?.idea ?? null)}</h1>`;
  if (hero === null) {
    return html`<div class="hero__head"><div class="hero__words">${over}${now}<p class="hero__pitch">When Overnight hears an idea, its story shows here, step by step.</p></div></div>${storyToCome(k)}`;
  }
  const { idea, story, extras } = hero;
  const pitch = idea.pitch === "" ? null : html`<p class="hero__pitch">${idea.pitch}</p>`;
  const clock = story.runningSince === null ? null : html`<div class="hero__clock"><b>${sinceClock(story.runningSince, "elapsed", k)}</b><span>${story.runningLabel}</span></div>`;
  // Once the app is out, the hero shows it: the link, and the phone picture the morning check took.
  const src = extras.shots.phone ? shotSrc(idea.id, "phone") : null;
  const picture = src === null ? null : html`<img class="hero__shot" src="${src}" alt="The app on a phone screen" width="84" height="150">`;
  return html`<div class="hero__head"><div class="hero__words">${over}${now}${pitch}${openTheApp(idea, false)}</div>${clock}${picture}</div>${storySteps(story, k)}${checksRow(story, k)}${hintLine(story)}`;
}

// ---------- Heard ----------

const BAR_CLASSES = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"] as const;

function bar(width: number): SafeHtml {
  const index = Math.min(7, Math.max(1, Math.round(Number.isFinite(width) ? width : 1))) - 1;
  return html`<i class="bar ${BAR_CLASSES[index] ?? "w1"}"></i>`;
}

/**
 * What Overnight made of one conversation, as a tag. Our own words only: the detector's reason is never shown.
 * `listening`: is the listener running? Lines nobody has checked yet are "listening" only while it is.
 */
function heardTag(group: HeardGroup, ideas: ReadonlyMap<string, DashIdea>, listening: boolean): SafeHtml {
  const lines = plural(group.lines, "line");
  switch (group.outcome) {
    case "idea": {
      const idea = group.ideaId === null ? undefined : ideas.get(group.ideaId);
      if (idea === undefined) return html`<span class="tag tag--idea">${lines} · an idea</span>`;
      const words = idea.hidden ? idea.title : `Idea: ${idea.title}`;
      const href = ideaHref(idea.id);
      return href === null ? html`<span class="tag tag--idea">${words}</span>` : html`<a class="tag tag--idea" href="${href}">${words}</a>`;
    }
    case "not_idea":
      return html`<span class="tag">${lines} · not an idea</span>`;
    case "too_short":
      return html`<span class="tag">${lines} · too short</span>`;
    case "too_old":
      return html`<span class="tag">${lines} · too old</span>`;
    case "skipped":
      return html`<span class="tag">${lines} · skipped</span>`;
    case "failed":
      return html`<span class="tag tag--warn">${lines} · could not check</span>`;
    default:
      // Lines not looked at yet. With the listener stopped nobody is listening, whatever the pill above says.
      return listening ? html`<span class="tag tag--listening">${lines} · listening</span>` : html`<span class="tag">${lines} · not checked yet</span>`;
  }
}

function heardLane(s: Snapshot, k: Clock): SafeHtml {
  const since = clockTime(s.dayStart, k.timeZone);
  const last = s.lastHeardAt === null ? null : html` · last one ${sinceClock(s.lastHeardAt, "ago", k)}`;
  const ideas = new Map(s.ideas.map((idea) => [idea.id, idea]));
  const rows = s.heard.map(
    (group) => html`<li class="heard__row"><time datetime="${group.lastAt}">${clockTime(group.lastAt, k.timeZone)}</time><div><div class="bars">${group.bars.slice(0, MAX_BARS).map(bar)}</div>${heardTag(group, ideas, s.running.listener === true)}</div></li>`,
  );
  const list = rows.length === 0 ? html`<p class="lane__note">No conversations since ${since}.</p>` : html`<ul class="heard">${rows}</ul>`;
  return html`<h2>Heard</h2><div class="lane__big">${count(s.linesHeard)}</div><p class="lane__sub">${s.linesHeard === 1 ? "line" : "lines"} since ${since}${last}</p>${list}`;
}

// ---------- Asked ----------

/** How an ask ended, in the fewest words: ticked (with the time), deleted, no answer, or still waiting. */
function answerWords(idea: DashIdea, k: Clock): string {
  if (idea.state === "asked") return "waiting";
  if (idea.state === "rejected") return "deleted";
  if (idea.state === "expired") return "no answer";
  return idea.answeredAt === null ? "ticked" : `ticked ${clockTime(idea.answeredAt, k.timeZone)}`;
}

function titleLink(idea: DashIdea): SafeHtml {
  const href = ideaHref(idea.id);
  return href === null ? html`<b>${idea.title}</b>` : html`<b><a href="${href}">${idea.title}</a></b>`;
}

function askedLane(s: Snapshot, c: RenderContext, k: Clock): SafeHtml {
  const dayStart = Date.parse(s.dayStart);
  const asked = s.ideas
    .filter((idea) => idea.askedAt !== null && Date.parse(idea.askedAt) >= dayStart)
    .sort((a, b) => Date.parse(a.askedAt ?? "") - Date.parse(b.askedAt ?? ""))
    .slice(-MAX_ASKED_ROWS);
  const rows = asked.map((idea) => html`<li class="row">${titleLink(idea)}<small>${answerWords(idea, k)}</small></li>`);
  const quiet = s.paused ? html`<p class="lane__note lane__note--warn">Quiet mode: nothing is asked.</p>` : null;
  const list = rows.length === 0 ? (quiet === null ? html`<p class="lane__note">Nothing asked yet.</p>` : null) : html`<ul class="rows">${rows}</ul>`;
  return html`<h2>Asked</h2><div class="lane__big">${count(s.asks)} <small>of ${count(c.config.maxAsksPerDay)}</small></div><p class="lane__sub">asks on the wrist since ${clockTime(s.dayStart, k.timeZone)}</p>${quiet}${list}`;
}

// ---------- Tonight's build ----------

function tonightLane(queue: TonightQueue, k: Clock): SafeHtml {
  const building = queue.rows.some((row) => row.when === "building");
  // A build that is running late still takes its rows, and soon. Anything else in the way means the rows wait, for as long as it lasts.
  const late = !queue.paused && queue.hold?.why === "late";
  const held = !queue.paused && queue.hold !== null && !late;
  const words = (when: "building" | "tonight" | "later"): string => (when === "building" ? "building" : held ? "waiting" : when === "later" ? "waits for another night" : building || late ? "next" : "tonight");
  const rows = queue.rows.map((row, index) => html`<li class="row"><span class="num">${index + 1}</span>${titleLink(row.idea)}<small>${words(row.when)}</small></li>`);
  // Why nothing will be built, or not at its time. That a build is late is only worth saying while something waits for it.
  const why = queue.paused ? "Paused: nothing will be built" : held || (late && rows.length > 0) ? (queue.hold?.note ?? null) : null;
  const note = why === null ? null : html`<p class="lane__note lane__note--warn">${why}</p>`;
  const list = rows.length === 0 ? (note === null ? html`<p class="lane__note">Nothing is waiting to be built.</p>` : null) : html`<ul class="rows">${rows}</ul>`;
  return html`<h2>Tonight's build</h2><div class="lane__big">${clockTime(queue.at, k.timeZone)}</div><p class="lane__sub">${count(queue.rows.length)} to build · up to ${count(queue.limit)} a night</p>${note}${list}`;
}

// ---------- The other ideas ----------

function cards(s: Snapshot, heroId: string | null, stories: ReadonlyMap<string, Story>, thumbs: ReadonlySet<string>, c: RenderContext): SafeHtml {
  const dayStart = Date.parse(s.dayStart);
  const others = s.ideas.filter((idea) => idea.id !== heroId);
  const today = others.filter((idea) => Date.parse(idea.createdAt) >= dayStart).slice(0, MAX_TODAY_CARDS);
  const earlier = others.filter((idea) => !(Date.parse(idea.createdAt) >= dayStart)).slice(0, MAX_EARLIER_CARDS);
  const card = (idea: DashIdea): SafeHtml => ideaCard(idea, { story: stories.get(idea.id), thumb: thumbs.has(idea.id), facts: s.build.get(idea.id), level: 3, timeZone: c.config.timeZone, now: c.now });
  const group = (title: string, ideas: readonly DashIdea[]): SafeHtml | null => (ideas.length === 0 ? null : html`<h2 class="section-title">${title}</h2><div class="ideas">${ideas.map(card)}</div>`);
  if (today.length === 0 && earlier.length === 0) return NOTHING;
  return html`${group(`Also since ${clockTime(s.dayStart, c.config.timeZone)}`, today)}${group("Earlier", earlier)}<p class="more"><a href="/ideas">All ideas</a></p>`;
}

// ---------- The view ----------

/**
 * Today. `thumbs` (ids of ideas that have a phone picture) is optional: without it the cards
 * carry no pictures.
 */
export function renderToday(
  s: Snapshot,
  hero: { idea: DashIdea; story: Story; extras: IdeaExtras } | null,
  line: NowLine,
  lastNight: { night: Night; label: "Last night" | "Tonight" } | null,
  queue: TonightQueue,
  stories: ReadonlyMap<string, Story>,
  c: RenderContext,
  thumbs: ReadonlySet<string> = NO_THUMBS,
): View {
  if (s.problem === "missing" || s.problem === "empty") return { title: "Today", main: nothingSavedYet(homeTilde(c.config.dataDir, c.home)) };
  const k = clockOf(s, c);
  const main = html`${live("lastnight", lastNightLine(lastNight), "lastnight")}
${live("story", heroBody(hero, line, k), "card hero")}
<div class="lanes">
${live("lane-heard", heardLane(s, k), "card lane")}
${live("lane-asked", askedLane(s, c, k), "card lane")}
${live("lane-tonight", tonightLane(queue, k), "card lane")}
</div>
${live("cards", cards(s, hero?.idea.id ?? null, stories, thumbs, c))}`;
  return { title: "Today", main };
}
