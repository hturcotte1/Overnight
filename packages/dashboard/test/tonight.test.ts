// SYNTHETIC: every idea, title and number in this file is made up. None of it is Bee data.
//
// The pages and `overnight status`, side by side on the same data folder at the same moment.
//
// The dashboard used to work out "will be built at 1:00 AM" from the settings alone, while status
// also read the ledger of what builds cost, the night clock's records and the rehearsal ideas. So
// the page promised builds that status said would not happen (found Oct 11, in three states: the
// month's credits used up, a late build waiting for the internet, and a rehearsal folder). Each
// test here makes one such folder with the real Store, asks the cli's own status about it, and
// holds the pages to the same answer.
//
// Of status, only what it found is compared (its report), and the few words of its "Tonight" row
// that say whether anything will be built. How it words the rest is its own business.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectStatus, tonightWords } from "@overnight/cli";
import type { StatusReport } from "@overnight/cli";
import { BUILD_STOPPED_REASON, closedRun, currentSlot, dataPaths, noteChecked, noticedRun, parseConfig, startedRun, Store, waitingRun, writeNightRun } from "@overnight/core";
import type { Config } from "@overnight/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSite } from "../src/site.ts";
import type { Site } from "../src/types.ts";

/** 11:10 PM in Boise on Oct 11, 2026: the evening the three states were found. Tonight's build is at 1:00 AM on Oct 12. */
const NOW = new Date("2026-10-12T05:10:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let folder: string;
let store: Store;

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "overnight dashboard tonight "));
  store = new Store(path.join(folder, "overnight.db"));
  store.setPaused(false, minutesAgo(900));
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

function configWith(env: Record<string, string> = {}): Config {
  return parseConfig({ OVERNIGHT_DATA_DIR: folder, PAUSED: "false", TZ: "America/Boise", ...env });
}

/** An invented idea, approved `approvedMinutesAgo` minutes ago. With "rehearsal", one made the way `overnight rehearse new` makes it. */
function approvedIdea(title: string, approvedMinutesAgo: number, kind: "heard" | "rehearsal" = "heard"): string {
  const idea = store.createIdea(
    { title, pitch: `An invented pitch for ${title}.`, quote: kind === "rehearsal" ? "" : "an invented line nobody said", confidence: 0.9, conversationKey: kind === "rehearsal" ? "rehearsal" : "c_invented", detectorRunId: null },
    minutesAgo(approvedMinutesAgo + 20),
  );
  store.transitionIdea(idea.id, "asked", { todoId: 7000 + approvedMinutesAgo, askedAt: minutesAgo(approvedMinutesAgo + 10) }, minutesAgo(approvedMinutesAgo + 10));
  store.transitionIdea(idea.id, "approved", { answeredAt: minutesAgo(approvedMinutesAgo) }, minutesAgo(approvedMinutesAgo));
  return idea.id;
}

/** What `overnight status` finds in this folder now, and its "Tonight" row. Neither night job is running. */
function statusOf(config: Config): { report: StatusReport; tonight: string } {
  const report = collectStatus({ store, config, now: () => NOW, jobRunning: () => false });
  return { report, tonight: tonightWords(report) };
}

/** The words a person reads in one live region of a page. */
function wordsOf(site: Site, route: Parameters<Site["page"]>[0], regionId: string): string {
  const page = site.page(route).html.text;
  const start = page.indexOf(`<section id="${regionId}"`);
  if (start === -1) throw new Error(`no region #${regionId}`);
  return page
    .slice(start, page.indexOf("</section>", start))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pagesOf(config: Config): { lane: string; hero: string; idea: (id: string) => string; credits: string } {
  const site = createSite({ config, paths: dataPaths(config.dataDir), filming: { on: false, showQuoteFor: new Set() }, demo: false, port: 4321, now: () => NOW, home: "/Users/sam", reuseMs: 0 });
  const settings = wordsOf(site, { kind: "settings" }, "settings");
  return {
    lane: wordsOf(site, { kind: "today" }, "lane-tonight"),
    hero: wordsOf(site, { kind: "today" }, "story"),
    idea: (id) => wordsOf(site, { kind: "idea", id }, "story"),
    credits: /Kiro credits a month MAX_BUILD_CREDITS_PER_MONTH (.*?) Builder BUILD_BACKEND/.exec(settings)?.[1] ?? "(no credits row)",
  };
}

describe("what the pages say about tonight, beside what status says", () => {
  it("promises tonight's build when nothing is in the way, as status does", () => {
    const first = approvedIdea("Invented Budget App", 120);
    const second = approvedIdea("Invented Tally App", 60);
    const config = configWith();
    const status = statusOf(config);
    expect(status.tonight).toContain("2 approved ideas will be built");
    expect(status.report).toMatchObject({ nextBuildAt: "2026-10-12T07:00:00.000Z", nextBuildTakes: 2, rehearsalIdeas: 0, buildCredits: { counted: 0, limit: 400, reached: false } });
    expect(status.report.nightClock.build.state).not.toBe("due");

    const pages = pagesOf(config);
    expect(pages.lane).toBe("Tonight's build 1:00 AM 2 to build · up to 2 a night 1 Invented Budget App tonight 2 Invented Tally App tonight");
    expect(pages.hero).toContain("“Invented Budget App” will be built at 1:00 AM");
    for (const id of [first, second]) expect(pages.idea(id)).toContain("Built at 1:00 AM Checked Published Delivered");
    expect(pages.credits).toBe("At most 400 0 of 400 counted this month. Once this many are counted for the month, nothing more is built until the next one.");
  });

  it("does not promise a build when the month's credits are used up", () => {
    const first = approvedIdea("Invented Budget App", 120);
    const second = approvedIdea("Invented Tally App", 60);
    store.recordBuildCost({ ideaId: first, at: minutesAgo(600), backend: "kiro-crew", credits: 6.29, measured: true });
    store.recordBuildCost({ ideaId: first, at: minutesAgo(500), backend: "kiro-cli", credits: 4.09, measured: false });
    const config = configWith({ MAX_BUILD_CREDITS_PER_MONTH: "5" });
    const status = statusOf(config);
    expect(status.tonight).toContain("nothing will be built");
    expect(status.report.buildCredits).toMatchObject({ counted: 10.38, estimated: 4.09, limit: 5, reached: true, monthEnd: "2026-11-01T06:00:00.000Z" });

    const pages = pagesOf(config);
    expect(pages.lane).toBe(
      "Tonight's build 1:00 AM 2 to build · up to 2 a night Not tonight: this month's build credits are used up (10.4 of 5 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised. 1 Invented Budget App waiting 2 Invented Tally App waiting",
    );
    expect(pages.hero).toContain("“Invented Budget App” is approved. This month's build credits are used up");
    expect(pages.hero).not.toContain("will be built at");
    for (const id of [first, second]) {
      expect(pages.idea(id)).toContain("Built Not tonight: this month's build credits are used up Checked Published Delivered");
      expect(pages.idea(id)).not.toContain("at 1:00 AM");
    }
    // Settings shows what has been counted, in status's own numbers.
    expect(pages.credits).toBe("At most 5 10.4 of 5 counted this month (4.1 of that is an estimate): nothing more is built until Nov 1, or until this limit is raised.");

    // The same ledger under the usual limit: the promise is back.
    expect(statusOf(configWith()).tonight).toContain("2 approved ideas will be built");
    expect(pagesOf(configWith()).hero).toContain("“Invented Budget App” will be built at 1:00 AM");
    expect(pagesOf(configWith()).credits).toContain("10.4 of 400 counted this month (4.1 of that is an estimate). Once this many");
  });

  it("does not promise a build while the limit is 0", () => {
    const first = approvedIdea("Invented Budget App", 120);
    const config = configWith({ MAX_BUILD_CREDITS_PER_MONTH: "0" });
    expect(statusOf(config).tonight).toContain("nothing will be built");
    expect(statusOf(config).report.buildCredits).toMatchObject({ limit: 0, reached: true });
    const pages = pagesOf(config);
    expect(pages.lane).toContain("Not tonight: MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built: approved ideas wait until it is raised. 1 Invented Budget App waiting");
    expect(pages.idea(first)).toContain("Built Not tonight: the monthly credit limit is 0 Checked");
    expect(pages.credits).toBe("At most 0 0 counted this month. At 0, nothing is ever built.");
  });

  it("says a late build is late and what it waits for, instead of tonight's time", () => {
    const first = approvedIdea("Invented Budget App", 120);
    approvedIdea("Invented Tally App", 60);
    const config = configWith();
    // The night before, the build ran on time. Today's 1:00 AM build never started: the job found it due with the internet away, and asked the clock again a moment ago.
    const lastNight = new Date("2026-10-10T07:00:20.000Z");
    writeNightRun(store, "build", closedRun(startedRun(noticedRun(currentSlot("build", lastNight, config), lastNight), lastNight), "done", new Date("2026-10-10T07:04:00.000Z")), new Date("2026-10-10T07:04:00.000Z"));
    const found = new Date(NOW.getTime() - 5 * 60_000);
    writeNightRun(store, "build", waitingRun(noticedRun(currentSlot("build", found, config), found), "offline"), found);
    noteChecked(store, "build", new Date(NOW.getTime() - 20_000));
    // Status finds the Oct 11, 1:00 AM build due, not started, and waiting for the internet.
    expect(statusOf(config).report.nightClock.build).toMatchObject({ state: "due", waiting: "offline", slotAt: "2026-10-11T07:00:00.000Z", slotDay: "2026-10-11" });

    const pages = pagesOf(config);
    expect(pages.lane).toBe("Tonight's build 1:00 AM 2 to build · up to 2 a night Running late: the Oct 11, 1:00 AM build is waiting for the internet. 1 Invented Budget App next 2 Invented Tally App next");
    expect(pages.hero).toContain("“Invented Budget App” will be built as soon as the Mac is online");
    expect(pages.idea(first)).toContain("Built as soon as the Mac is online Checked Published Delivered");
    expect(pages.idea(first)).not.toContain("at 1:00 AM");

    // Asleep at 1:00 AM, with no reason stored yet: late, and not a word about the internet.
    writeNightRun(store, "build", noticedRun(currentSlot("build", found, config), found), found);
    expect(statusOf(config).report.nightClock.build).toMatchObject({ state: "due", waiting: null, slotAt: "2026-10-11T07:00:00.000Z" });
    const asleep = pagesOf(config);
    expect(asleep.lane).toContain("Running late: the Oct 11, 1:00 AM build has not started yet. 1 Invented Budget App next");
    expect(asleep.hero).toContain("“Invented Budget App” is approved. The build is running late");
    expect(asleep.idea(first)).toContain("Built Running late Checked");

    // Once the run has started and ended, tonight's build is the next one again.
    writeNightRun(store, "build", closedRun(startedRun(noticedRun(currentSlot("build", found, config), found), found), "done", NOW), NOW);
    expect(statusOf(config).report.nightClock.build).toMatchObject({ state: "done", waiting: null });
    expect(pagesOf(config).hero).toContain("“Invented Budget App” will be built at 1:00 AM");
  });

  it("says nothing about a nightly build on a folder that holds a rehearsal idea", () => {
    const first = approvedIdea("Invented Dice Cup", 120, "rehearsal");
    const second = approvedIdea("Invented Coin Flip", 60, "rehearsal");
    // The second was built by hand and cut short: it is due one more try.
    store.transitionIdea(second, "building", { slug: "invented-coin-flip", buildBackend: "kiro-crew", buildStartedAt: minutesAgo(30) }, minutesAgo(30));
    store.transitionIdea(second, "build_failed", { failureReason: BUILD_STOPPED_REASON, note: BUILD_STOPPED_REASON }, minutesAgo(29));
    const config = configWith();
    expect(statusOf(config).tonight).toContain("nothing will be built");
    expect(statusOf(config).report.rehearsalIdeas).toBe(2);

    const pages = pagesOf(config);
    expect(pages.lane).toBe(
      "Tonight's build 1:00 AM 2 to build · up to 2 a night Rehearsal folder: the nightly build does not run here. A rehearsal idea is built by hand, with rehearse run. 1 Invented Dice Cup waiting 2 Invented Coin Flip waiting",
    );
    expect(pages.idea(first)).toContain("Built Rehearsal folder: no nightly build Checked Published Delivered");
    expect(pages.idea(second)).toContain("Cut short. No nightly build runs on a rehearsal folder: it is built once more by hand, with rehearse run.");
    for (const text of [pages.hero, pages.idea(first), pages.idea(second)]) {
      expect(text).not.toContain("at 1:00 AM");
      expect(text).not.toContain("at the next nightly build");
    }
  });
});
