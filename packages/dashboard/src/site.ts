// The site: what the web server is handed (types.ts, `Site`). It puts the other parts together:
// one look at the data (data/snapshot.ts), what that look means (story.ts), and the pages that
// say it (render/). Nothing here writes, and nothing here builds markup: pages come out of the
// views as SafeHtml and go to the server as they are.
//
// Two rules of its own:
//   - A page with no data in it (it needs its link, nothing at this address, something went
//     wrong) never looks at the database, a log or a file. The first of them is what a request
//     without the key gets, so a program that has no key cannot make the dashboard read anything.
//   - A screenshot is only handed out for an idea whose page shows it: one that is in the look
//     and is published or delivered.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Config, DataPaths } from "@overnight/core";
import { hasScreenshot, readReport, readScreenshot } from "./data/files.ts";
import { collectIdeaExtras, createSnapshotSource } from "./data/snapshot.ts";
import { renderIdea } from "./render/idea.ts";
import { renderIdeas } from "./render/ideas.ts";
import { renderDocument } from "./render/layout.ts";
import { renderNights } from "./render/nights.ts";
import { renderProblem } from "./render/problem.ts";
import { renderSettings } from "./render/settings.ts";
import { renderToday } from "./render/today.ts";
import type { SafeHtml } from "./render/html.ts";
import { groupNights, heroIdea, lastNightOf, nowLine, pollMsFor, storyOf, tonightQueue } from "./story.ts";
import { IDEA_ID } from "./types.ts";
import type { Chrome, DashIdea, FilmingPolicy, IdeaExtras, Night, PageRoute, RenderContext, Site, Snapshot, Story, View } from "./types.ts";

export interface SiteOptions {
  config: Config;
  paths: DataPaths;
  filming: FilmingPolicy;
  /** The data was invented by the demo. A database that carries the demo's mark says so by itself. */
  demo: boolean;
  /** The port the dashboard answers on. It is only written into two sentences; nothing is opened here. */
  port: number;
  /** The clock every page goes by. The demo hands in a pretend one. */
  now?: () => Date;
  /** The home folder, shown as "~" wherever a path is. */
  home?: string;
  /** For tests: how long one look at the data is shared by every page (data/snapshot.ts). Left out: one second. */
  reuseMs?: number;
}

/** The states in which an idea's app is out, so its pictures are shown (the same rule as data/snapshot.ts). */
const OUT_STATES: ReadonlySet<string> = new Set(["published", "delivered"]);

/** Remembers what was worked out from one look, for as long as that same look is handed back (one second). */
function oncePerLook<T>(make: (s: Snapshot, now: Date) => T): (s: Snapshot, now: Date) => T {
  let last: { s: Snapshot; value: T } | null = null;
  return (s, now) => {
    if (last === null || last.s !== s) last = { s, value: make(s, now) };
    return last.value;
  };
}

export function createSite(o: SiteOptions): Site {
  const { config, paths, filming } = o;
  const clock = o.now ?? (() => new Date());
  const home = o.home ?? homedir();
  const source = createSnapshotSource({ config, paths, filming, now: clock, reuseMs: o.reuseMs });

  // ---------- What one look means ----------

  const storyWith = (s: Snapshot, idea: DashIdea, extras: Pick<IdeaExtras, "report" | "marks"> | null, now: Date): Story =>
    storyOf(idea, s.events.get(idea.id) ?? [], s.build.get(idea.id) ?? null, s.deliver.get(idea.id) ?? null, extras, {
      now,
      running: s.running,
      paused: s.paused,
      nextBuildAt: s.nextBuildAt,
      nextDeliverAt: s.nextDeliverAt,
      config,
    });

  /**
   * Every idea's story, for the cards and the rows (seven dots each). A card needs no file,
   * with one exception: whether an app failed in the morning's check or at publishing is in its
   * report, and the dots must say the same as the idea's own page does.
   */
  const storiesOf = oncePerLook((s, now): ReadonlyMap<string, Story> => {
    const stories = new Map<string, Story>();
    for (const idea of s.ideas) stories.set(idea.id, storyWith(s, idea, idea.state === "publish_failed" ? { report: readReport(paths, idea.id), marks: null } : null, now));
    return stories;
  });

  /** The ideas that have a phone picture to show on their card. */
  const thumbsOf = oncePerLook((s): ReadonlySet<string> => new Set(s.ideas.filter((idea) => OUT_STATES.has(idea.state) && hasScreenshot(paths, idea.id, "phone")).map((idea) => idea.id)));

  const nightsOf = oncePerLook((s): Night[] => groupNights(s, config));

  /** The idea that leads Today, with its files: its story shows the night's ticks, the cards' stories do not. */
  const heroOf = oncePerLook((s, now): { idea: DashIdea; story: Story; extras: IdeaExtras } | null => {
    const idea = heroIdea(s);
    if (idea === null) return null;
    const extras = collectIdeaExtras(paths, idea, home, filming);
    return { idea, story: storyWith(s, idea, extras, now), extras };
  });

  // ---------- The shell ----------

  const chromeFor = (current: Chrome["current"], s: Snapshot, now: Date): Chrome => ({
    current,
    running: s.running,
    paused: s.paused,
    filming: filming.on,
    demo: o.demo || s.demoMark,
    problem: s.problem,
    staleSince: s.staleSince,
    nowMs: now.getTime(),
    timeZone: config.timeZone,
    pollMs: pollMsFor(s, now),
  });

  /**
   * The version mark of a page: a fingerprint of everything on it except the clock. While nothing
   * but the time has moved the mark stays the same, the script's next look gets "304, nothing
   * new", and the page keeps its own clocks ticking.
   */
  const versionOf = (view: View, chrome: Chrome): string => {
    const { nowMs: _clock, ...shell } = chrome;
    return `"${createHash("sha1").update(view.main.text).update("\n").update(JSON.stringify(shell)).digest("hex")}"`;
  };

  /** A whole page with no data in it. It does not look at the database, the logs or any file. */
  const problem = (kind: "needs-key" | "not-found" | "error"): SafeHtml =>
    renderDocument(renderProblem(kind, { port: o.port }), {
      current: "none",
      running: { listener: null, build: null, deliver: null },
      paused: false,
      filming: filming.on,
      demo: o.demo,
      problem: null,
      staleSince: null,
      nowMs: clock().getTime(),
      timeZone: config.timeZone,
      pollMs: 5000,
    });

  // ---------- The pages ----------

  function viewFor(route: PageRoute, s: Snapshot, now: Date): { view: View; current: Chrome["current"] } | null {
    const c: RenderContext = { now, config, home, filming };
    switch (route.kind) {
      case "today": {
        const hero = heroOf(s, now);
        return { current: "today", view: renderToday(s, hero, nowLine(s, hero?.idea ?? null, config), lastNightOf(nightsOf(s, now), now, config), tonightQueue(s, config), storiesOf(s, now), c, thumbsOf(s, now)) };
      }
      case "ideas":
        return { current: "ideas", view: renderIdeas(s, storiesOf(s, now), thumbsOf(s, now), c) };
      case "idea": {
        const idea = s.ideas.find((candidate) => candidate.id === route.id);
        if (idea === undefined) return null;
        const extras = collectIdeaExtras(paths, idea, home, filming);
        return { current: "ideas", view: renderIdea(s, idea, storyWith(s, idea, extras, now), extras, s.events.get(idea.id) ?? [], c) };
      }
      case "nights":
        return { current: "nights", view: renderNights(nightsOf(s, now), storiesOf(s, now), c) };
      case "settings":
        return { current: "settings", view: renderSettings(s, c, { demo: o.demo || s.demoMark, port: o.port }) };
    }
  }

  return {
    page(route) {
      const s = source.get();
      const now = clock();
      const made = viewFor(route, s, now);
      if (made === null) return { status: 404, html: problem("not-found"), etag: "" };
      const chrome = chromeFor(made.current, s, now);
      return { status: 200, html: renderDocument(made.view, chrome), etag: versionOf(made.view, chrome) };
    },
    problem,
    shot(ideaId, which) {
      if (!IDEA_ID.test(ideaId) || (which !== "phone" && which !== "desktop")) return null;
      const idea = source.get().ideas.find((candidate) => candidate.id === ideaId);
      if (idea === undefined || !OUT_STATES.has(idea.state)) return null;
      return readScreenshot(paths, ideaId, which);
    },
  };
}
