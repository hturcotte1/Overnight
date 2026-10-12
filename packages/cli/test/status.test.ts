// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import {
  BeeError,
  BUILD_INTERRUPTED_REASON,
  BUILD_STOPPED_REASON,
  budgetReachedText,
  clockMinus as coreClockMinus,
  closedRun,
  currentSlot,
  MAX_BUILD_STARTS,
  noteChecked,
  noticedRun,
  parseConfig,
  startedRun,
  Store,
  waitingRun,
  writeNightRun,
} from "@overnight/core";
import type { ClockedJob, NightRun, NightWait } from "@overnight/core";
import type { JobTrigger, ListenerState, NightJobsState } from "../src/background.ts";
import { REHEARSAL_CONVERSATION_KEY } from "../src/commands/rehearse.ts";
import { clockMinus, collectStatus, dayWords, nightClockWords, status, tonightWords } from "../src/commands/status.ts";
import type { StatusDeps, StatusReport } from "../src/commands/status.ts";
import type { PowerSource } from "../src/power.ts";
import { addIdea, at, capture, fixedNow, moveIdea, SAMPLE_IDEAS, testConfig } from "./helpers.ts";

const config = testConfig();
const SPOKEN = ["someone should build a tiny app for whose turn it is", "yeah that would settle it", "anyway what time is the game"];

function populated(): Store {
  const store = new Store(":memory:");
  const { key } = store.resolveConversation({ uuid: "u-lunch" }, at(-600));
  const ids = SPOKEN.map((text, index) => store.insertUtterance({ beeUtteranceId: index + 1, conversationKey: key, text, spokenAt: at(-600 + index), receivedAt: at(-590 + index), source: "stream" }).id as number);
  store.recordDetectorRun({ conversationKey: key, ranAt: at(-400), utteranceIds: ids.slice(0, 2), wordCount: 16, outcome: "idea" });
  store.recordDetectorRun({ conversationKey: key, ranAt: at(-300), utteranceIds: [], wordCount: 0, outcome: "not_idea" });
  store.recordDetectorRun({ conversationKey: key, ranAt: at(-200), utteranceIds: [], wordCount: 0, outcome: "failed", reason: "no reply in time" });

  const asked = addIdea(store, SAMPLE_IDEAS.turns, at(-390));
  moveIdea(store, asked, ["asked"], at(-380));
  const approved = addIdea(store, SAMPLE_IDEAS.plants, at(-350));
  moveIdea(store, approved, ["asked", "approved"], at(-340));
  addIdea(store, SAMPLE_IDEAS.chores, at(-100));
  // Asked the evening before (10 pm in Boise): must not count toward today.
  const old = addIdea(store, { title: "Sock sorter", pitch: "Pairs socks.", quote: "why is there no sock sorter" }, at(-14 * 3600));
  moveIdea(store, old, ["asked", "expired"], at(-14 * 3600 + 5));
  return store;
}

describe("overnight status", () => {
  it("reports an empty store", async () => {
    const out = capture();
    expect(await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow() })).toBe(0);
    expect(out.lines).toEqual([
      "Overnight status",
      "  Mode              live: asks about new ideas and builds approved ones. Back to quiet mode with: npx overnight pause",
      "  Data folder       /tmp/overnight-cli-test",
      "  Time zone         America/Boise",
      "  Utterances saved  0",
      "  Detector runs     0",
      "  Ideas             0",
      "  Asks today        0 of 3",
      "  Builds today      0 of 2",
      "  Build credits     0 of 400 used this month",
      "  Waiting to build  0 approved ideas",
      // The made-up "now" is noon on Oct 9 in Boise: the next 01:00 and the next 06:30 are tomorrow's.
      "  Next build        Oct 10, 1:00 AM (kiro-crew first)",
      "  Next deliver      Oct 10, 6:30 AM, for the link on the wrist at 07:00",
      "  Build sandbox     overnight (the Kiro Crew gateway runs inside Overnight's own sandbox, proved by a probe each night)",
      "  Tonight           nothing to build so far: no approved idea is waiting",
      "  Full check        npx overnight preflight",
    ]);
  });

  it("reports a populated store: counts and times only", async () => {
    const store = populated();
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toEqual([
      "Overnight status",
      "  Mode                  live: asks about new ideas and builds approved ones. Back to quiet mode with: npx overnight pause",
      "  Data folder           /tmp/overnight-cli-test",
      "  Time zone             America/Boise",
      "  Utterances saved      3",
      "  Newest utterance      arrived Oct 9, 11:50 AM",
      "  Waiting for detector  1 line in 1 conversation",
      "  Detector runs         3 (idea 1, not an idea 1, failed 1)",
      "  Ideas                 4 (heard 1, asked 1, approved 1, expired 1)",
      "  Asks today            2 of 3",
      "  Builds today          0 of 2",
      "  Build credits         0 of 400 used this month",
      "  Waiting to build      1 approved idea",
      "  Next build            Oct 10, 1:00 AM (kiro-crew first)",
      "  Next deliver          Oct 10, 6:30 AM, for the link on the wrist at 07:00",
      "  Build sandbox         overnight (the Kiro Crew gateway runs inside Overnight's own sandbox, proved by a probe each night)",
      "  Tonight               1 approved idea will be built at the next build",
      "  Full check            npx overnight preflight",
    ]);
  });

  it("never prints what was said, in either format", async () => {
    const store = populated();
    for (const json of [false, true]) {
      const out = capture();
      await status({ store, config, write: out.write, now: fixedNow() }, { json });
      for (const secret of [...SPOKEN, ...Object.values(SAMPLE_IDEAS).flatMap((sample) => [sample.title, sample.pitch, sample.quote])]) {
        expect(out.text()).not.toContain(secret);
      }
    }
  });

  it("shows paused, from the stored flag or from the setting", async () => {
    const store = new Store(":memory:");
    store.setPaused(true, at(0));
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines[1]).toBe("  Mode              paused (quiet mode): listening and saving, not asking or building. Turn asking on with: npx overnight resume");

    const byDefault = collectStatus({ store: new Store(":memory:"), config: testConfig({ PAUSED: "true" }), now: fixedNow() });
    expect(byDefault.paused).toBe(true);
  });

  it("is paused on a fresh data folder with no settings at all, and tells the operator nothing that would go live by accident", async () => {
    // No PAUSED setting and nothing stored: the product default, as on a first start.
    const fresh = parseConfig({ OVERNIGHT_DATA_DIR: "/tmp/overnight-cli-test" });
    for (const jobInstalled of [false, true]) {
      const out = capture();
      await status({ store: new Store(":memory:"), config: fresh, write: out.write, now: fixedNow(), listenerState: () => ({ running: false, jobInstalled }) });
      expect(out.lines[1]).toBe("  Mode              paused (quiet mode): listening and saving, not asking or building. Turn asking on with: npx overnight resume");
      // The only command on the screen that turns asking on is the one named for it. (The other
      // one named, preflight, only looks.)
      expect(out.text().match(/npx overnight \w+/g)).toEqual(["npx overnight resume", "npx overnight preflight"]);
      expect(out.lines).toContain("  Tonight           nothing will be built: Overnight is paused");
    }
    const json = capture();
    await status({ store: new Store(":memory:"), config: fresh, write: json.write, now: fixedNow() }, { json: true });
    expect(JSON.parse(json.text())).toMatchObject({ paused: true });
  });

  it("prints the same facts as JSON with --json", async () => {
    const out = capture();
    await status({ store: populated(), config: testConfig({ MAX_ASKS_PER_DAY: "5" }), write: out.write, now: fixedNow() }, { json: true });
    expect(JSON.parse(out.text())).toEqual({
      paused: false,
      dataDir: "/tmp/overnight-cli-test",
      timeZone: "America/Boise",
      utterances: 3,
      // When the last of the three lines reached this Mac, in UTC.
      newestUtteranceAt: at(-588),
      awaitingDetection: { utterances: 1, conversations: 1 },
      detectorRuns: { idea: 1, not_idea: 1, skipped: 0, failed: 1 },
      ideas: { heard: 1, asked: 1, approved: 1, expired: 1 },
      asksToday: 2,
      maxAsksPerDay: 5,
      // What scripts/install-agents.sh reads to schedule the night jobs.
      buildTime: "01:00",
      deliverTime: "07:00",
      buildBackend: "kiro-crew",
      // "overnight" unless BUILD_SANDBOX says "crew". The installer starts the gateway by it.
      buildSandbox: "overnight",
      buildsToday: 0,
      maxBuildsPerNight: 2,
      waitingToBuild: 1,
      waitingForSecondTry: 0,
      lastDelivered: null,
      // 01:00 and 06:30 on Oct 10 in Boise (UTC-6), in UTC.
      nextBuildAt: "2026-10-10T07:00:00.000Z",
      nextDeliverAt: "2026-10-10T12:30:00.000Z",
      nextBuildTakes: 1,
      // October in Boise, in UTC. Nothing has been built, so nothing is counted against the month's 400.
      buildCredits: { monthStart: "2026-10-01T06:00:00.000Z", monthEnd: "2026-11-01T06:00:00.000Z", counted: 0, estimated: 0, tries: 0, limit: 400, reached: false },
      rehearsalIdeas: 0,
      // Neither night job has ever asked the clock on this data folder. scripts/install-agents.sh
      // reads nightClock.build.checkedAt and nightClock.deliver.checkedAt.
      nightClock: {
        tickSeconds: 60,
        build: { slotAt: "2026-10-09T07:00:00.000Z", slotDay: "2026-10-09", state: "no-record", waiting: null, nextSlotAt: "2026-10-10T07:00:00.000Z", checkedAt: null, lastRun: null, recordAhead: null, fresh: false },
        deliver: { slotAt: "2026-10-09T12:30:00.000Z", slotDay: "2026-10-09", state: "no-record", waiting: null, nextSlotAt: "2026-10-10T12:30:00.000Z", checkedAt: null, lastRun: null, recordAhead: null, fresh: false },
      },
    });
  });

  it("shows when the newest line arrived, in local time, and leaves the line out when nothing is saved", async () => {
    const store = populated();
    const { key } = store.resolveConversation({ uuid: "u-evening" }, at(7 * 3600));
    // Spoken at 6:59 pm in Boise, arrived at 7:00 pm.
    store.insertUtterance({ beeUtteranceId: 99, conversationKey: key, text: "one more made-up line", spokenAt: at(7 * 3600 - 40), receivedAt: at(7 * 3600), source: "stream" });
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow(at(8 * 3600)) });
    expect(out.lines).toContain("  Newest utterance      arrived Oct 9, 7:00 PM");
    expect(collectStatus({ store, config, now: fixedNow() }).newestUtteranceAt).toBe(at(7 * 3600));

    const empty = capture();
    await status({ store: new Store(":memory:"), config, write: empty.write, now: fixedNow() }, { json: true });
    expect(JSON.parse(empty.text())).toMatchObject({ utterances: 0, newestUtteranceAt: null });
    expect(empty.text()).not.toContain("listener");
  });

  it("says in one plain line whether the listener is running and whether the background job is installed", async () => {
    const line = async (state: ListenerState) => {
      const out = capture();
      await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow(), listenerState: () => state });
      expect(out.lines[1]).toMatch(/^ {2}Mode {2,}live/);
      return out.lines[2];
    };
    expect(await line({ running: true, jobInstalled: true })).toBe("  Listener          running (background job installed)");
    expect(await line({ running: true, jobInstalled: false })).toBe("  Listener          running, started by hand (background job not installed)");
    expect(await line({ running: false, jobInstalled: true })).toBe("  Listener          NOT running, although the background job is installed. See why with: scripts/install-agents.sh status");
    // The job is named: a bare "install" means every job, the night's too.
    expect(await line({ running: false, jobInstalled: false })).toBe("  Listener          not running (background job not installed). Start it with: scripts/install-agents.sh install listen");
    expect(await line({ running: null, jobInstalled: true })).toBe("  Listener          could not tell whether it is running (background job installed). Check with: scripts/install-agents.sh status");

    const json = capture();
    await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), listenerState: () => ({ running: true, jobInstalled: false }) }, { json: true });
    expect(JSON.parse(json.text())).toMatchObject({ paused: false, listener: { running: true, jobInstalled: false } });
  });

  it("counts the builds started today, and the approved ideas still waiting for one", async () => {
    const store = new Store(":memory:");
    // Started at 1:00 am today in Boise (07:00Z): counts. One started at 1:00 am yesterday does not.
    const tonight = addIdea(store, SAMPLE_IDEAS.turns, at(-20 * 3600));
    moveIdea(store, tonight, ["asked", "approved"], at(-19 * 3600));
    store.transitionIdea(tonight.id, "building", { slug: "whose-turn-to-pay", buildStartedAt: at(-11 * 3600) }, at(-11 * 3600));
    const lastNight = addIdea(store, SAMPLE_IDEAS.plants, at(-40 * 3600));
    moveIdea(store, lastNight, ["asked", "approved"], at(-39 * 3600));
    store.transitionIdea(lastNight.id, "building", { slug: "plant-watering-tracker" }, at(-35 * 3600));
    const waiting = addIdea(store, SAMPLE_IDEAS.chores, at(-3600));
    moveIdea(store, waiting, ["asked", "approved"], at(-3000));

    const report = collectStatus({ store, config: testConfig({ MAX_BUILDS_PER_NIGHT: "4" }), now: fixedNow() });
    expect(report).toMatchObject({ buildsToday: 1, maxBuildsPerNight: 4, waitingToBuild: 1, lastDelivered: null });

    const out = capture();
    await status({ store, config: testConfig({ MAX_BUILDS_PER_NIGHT: "4" }), write: out.write, now: fixedNow() });
    expect(out.lines).toContain("  Builds today      1 of 4");
    expect(out.lines).toContain("  Waiting to build  1 approved idea");
    expect(out.text()).not.toContain("Last delivered");
  });

  it("counts an idea whose build was cut short as waiting for its second try, by core's rule, and says so in plain words", async () => {
    const store = new Store(":memory:");
    const approve = (sample: { title: string; pitch: string; quote: string }, heardAt: number) => moveIdea(store, addIdea(store, sample, at(heardAt)), ["asked", "approved"], at(heardAt + 60));
    /** One build of the idea that ended badly, two days ago (so it uses up nothing of today's or tomorrow's limit). */
    const failBuild = (id: string, reason: string, when: number) => {
      store.transitionIdea(id, "building", { buildStartedAt: at(when) }, at(when));
      store.transitionIdea(id, "build_failed", { failureReason: reason, note: reason }, at(when + 60));
    };
    const twoDaysAgo = -48 * 3600;

    // 1. Approved, never built: waiting, the ordinary way.
    approve(SAMPLE_IDEAS.chores, -3600);
    // 2. Stopped once (the job was restarted mid-build): gets its second try.
    const stopped = approve(SAMPLE_IDEAS.turns, twoDaysAgo - 7200);
    failBuild(stopped.id, BUILD_STOPPED_REASON, twoDaysAgo);
    // 3. Found interrupted once (a crash, a restart): gets its second try too.
    const interrupted = approve(SAMPLE_IDEAS.plants, twoDaysAgo - 7000);
    failBuild(interrupted.id, BUILD_INTERRUPTED_REASON, twoDaysAgo + 600);
    // 4. Failed for a reason of its own: never retried by itself.
    const failed = approve({ title: "Sock sorter", pitch: "Pairs socks.", quote: "why is there no sock sorter" }, twoDaysAgo - 6000);
    failBuild(failed.id, "Kiro Crew: the agent did not produce an app", twoDaysAgo + 1200);
    // 5. Cut short on both of its starts: it has used them up.
    const twice = approve({ title: "Tip splitter", pitch: "Splits a tip.", quote: "someone make a tip splitter" }, twoDaysAgo - 5000);
    failBuild(twice.id, BUILD_STOPPED_REASON, twoDaysAgo + 1800);
    failBuild(twice.id, BUILD_INTERRUPTED_REASON, twoDaysAgo + 2400);
    expect(store.countBuildStarts(twice.id)).toBe(MAX_BUILD_STARTS);
    // 6. Stopped once, but the wearer has already been told it could not be finished.
    const told = approve({ title: "Dice roller", pitch: "Rolls dice.", quote: "I wish I had dice" }, twoDaysAgo - 4000);
    failBuild(told.id, BUILD_STOPPED_REASON, twoDaysAgo + 3000);
    store.updateIdea(told.id, { failureNotifiedAt: at(-3600) }, at(-3600));

    const settings = testConfig({ MAX_BUILDS_PER_NIGHT: "2" });
    const report = collectStatus({ store, config: settings, now: fixedNow() });
    expect(report.ideas).toMatchObject({ approved: 1, build_failed: 5 });
    // The approved one, the stopped one and the interrupted one. Not the three whose build is over for good.
    expect(report).toMatchObject({ waitingToBuild: 3, waitingForSecondTry: 2, buildsToday: 0, nextBuildTakes: 2 });

    const out = capture();
    await status({ store, config: settings, write: out.write, now: fixedNow(), nightJobs: () => ({ build: true, deliver: true, crew: true }), gatewayAnswers: async () => true });
    const row = (label: string) => out.lines.find((line) => line.startsWith(`  ${label}`))?.replace(/^ {2}\S.*? {2,}/, "");
    expect(row("Waiting to build")).toBe("3 ideas: 1 approved, 2 whose build was cut off and will be tried once more");
    expect(row("Tonight")).toBe("2 approved ideas will be built at the next build, 1 more waits for another night (counting 2 second tries after a build that was cut off)");
    // Counts only: no title of any of them.
    expect(out.text()).not.toContain("Sock sorter");
  });

  it("goes back to the ordinary words once the second try has been made", async () => {
    const store = new Store(":memory:");
    const idea = moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, at(-50 * 3600)), ["asked", "approved"], at(-49 * 3600));
    store.transitionIdea(idea.id, "building", { buildStartedAt: at(-48 * 3600) }, at(-48 * 3600));
    store.transitionIdea(idea.id, "build_failed", { failureReason: BUILD_STOPPED_REASON }, at(-47 * 3600));
    expect(collectStatus({ store, config, now: fixedNow() })).toMatchObject({ waitingToBuild: 1, waitingForSecondTry: 1 });
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toContain("  Waiting to build  1 idea whose build was cut off and will be tried once more");
    expect(tonightWords({ ...collectStatus({ store, config, now: fixedNow() }), nightJobs: { build: true, deliver: true, crew: true }, gatewayAnswers: true })).toBe(
      "1 approved idea will be built at the next build (counting 1 second try after a build that was cut off)",
    );
    // The second try, two nights ago as well, this time all the way.
    store.transitionIdea(idea.id, "building", { buildStartedAt: at(-46 * 3600), failureReason: null }, at(-46 * 3600));
    store.transitionIdea(idea.id, "built", { builtAt: at(-45 * 3600) }, at(-45 * 3600));
    expect(collectStatus({ store, config, now: fixedNow() })).toMatchObject({ waitingToBuild: 0, waitingForSecondTry: 0, nextBuildTakes: 0 });
  });

  it("shows the newest delivery: when, in local time, and its link", async () => {
    const store = new Store(":memory:");
    const deliver = (sample: (typeof SAMPLE_IDEAS)[keyof typeof SAMPLE_IDEAS], slug: string, heardAt: number, deliveredAt: number) => {
      const idea = moveIdea(store, addIdea(store, sample, at(heardAt)), ["asked", "approved", "building", "built"], at(heardAt + 60));
      const url = `https://example.invalid/apps/${slug}/`;
      store.transitionIdea(idea.id, "published", { slug, publishedUrl: url, publishedAt: at(deliveredAt - 30) }, at(deliveredAt - 30));
      return store.transitionIdea(idea.id, "delivered", { deliveredAt: at(deliveredAt) }, at(deliveredAt));
    };
    // Heard first but delivered last: the newest delivery is not the newest idea.
    const newest = deliver(SAMPLE_IDEAS.turns, "whose-turn-to-pay", -60 * 3600, -5.5 * 3600);
    deliver(SAMPLE_IDEAS.plants, "plant-watering-tracker", -50 * 3600, -29.5 * 3600);

    expect(collectStatus({ store, config, now: fixedNow() }).lastDelivered).toEqual({ ideaId: newest.id, url: "https://example.invalid/apps/whose-turn-to-pay/", at: at(-5.5 * 3600) });
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines).toContain("  Last delivered    Oct 9, 6:30 AM  https://example.invalid/apps/whose-turn-to-pay/");
    // The link is public and made by us. The title, the pitch and the quote still never appear.
    for (const secret of Object.values(SAMPLE_IDEAS).flatMap((sample) => [sample.title, sample.pitch, sample.quote])) expect(out.text()).not.toContain(secret);
  });

  it("gives the installer the build time, the deliver time and the time zone, as set", async () => {
    const out = capture();
    await status({ store: new Store(":memory:"), config: testConfig({ BUILD_TIME: "02:15", DELIVER_TIME: "06:45", TZ: "America/Denver", BUILD_BACKEND: "kiro-cli" }), write: out.write, now: fixedNow() }, { json: true });
    expect(JSON.parse(out.text())).toMatchObject({ buildTime: "02:15", deliverTime: "06:45", timeZone: "America/Denver", buildBackend: "kiro-cli" });

    const plainRun = capture();
    await status({ store: new Store(":memory:"), config: testConfig({ BUILD_TIME: "02:15", DELIVER_TIME: "06:45", BUILD_BACKEND: "kiro-cli" }), write: plainRun.write, now: fixedNow() });
    expect(plainRun.lines).toContain("  Next build        Oct 10, 2:15 AM (kiro-cli first)");
    expect(plainRun.lines).toContain("  Next deliver      Oct 10, 6:15 AM, for the link on the wrist at 06:45");
  });

  it("gives the next build and the next deliver in local time, whichever side of them the clock is on", async () => {
    const at0030 = collectStatus({ store: new Store(":memory:"), config, now: fixedNow("2026-10-10T06:30:00.000Z") });
    // Half past midnight in Boise: tonight's build is half an hour away, the same morning's deliver six hours.
    expect(at0030).toMatchObject({ nextBuildAt: "2026-10-10T07:00:00.000Z", nextDeliverAt: "2026-10-10T12:30:00.000Z" });
    // 6:45 am: this morning's deliver has started, so the next one is tomorrow's. So is the next build.
    const at0645 = collectStatus({ store: new Store(":memory:"), config, now: fixedNow("2026-10-10T12:45:00.000Z") });
    expect(at0645).toMatchObject({ nextBuildAt: "2026-10-11T07:00:00.000Z", nextDeliverAt: "2026-10-11T12:30:00.000Z" });

    // The deliver job starts 30 minutes before DELIVER_TIME, around midnight too. (The sum itself
    // lives with the night clock in core now; it is still offered from here.)
    expect(clockMinus).toBe(coreClockMinus);
    expect(clockMinus("07:00", 30)).toBe("06:30");
    expect(clockMinus("00:10", 30)).toBe("23:40");
    expect(clockMinus("00:00", 30)).toBe("23:30");
    expect(clockMinus("09:08", 0)).toBe("09:08");
    const early = collectStatus({ store: new Store(":memory:"), config: testConfig({ DELIVER_TIME: "00:10" }), now: fixedNow() });
    // 23:40 the same day (Oct 9, noon now), which is 05:40 UTC on the 10th.
    expect(early.nextDeliverAt).toBe("2026-10-10T05:40:00.000Z");

    // The day the clocks go back (Nov 1, 2026): 01:00 comes round twice, and the first one is meant.
    const fallBack = collectStatus({ store: new Store(":memory:"), config, now: fixedNow("2026-11-01T05:00:00.000Z") });
    expect(new Date(fallBack.nextBuildAt).getTime()).toBeGreaterThan(Date.parse("2026-11-01T05:00:00.000Z"));
    expect(Date.parse(fallBack.nextBuildAt) - Date.parse("2026-11-01T05:00:00.000Z")).toBeLessThanOrEqual(3 * 3600_000);
  });

  it("says in plain words whether anything will be built tonight, and what is in the way", () => {
    const base: StatusReport = { ...collectStatus({ store: new Store(":memory:"), config, now: fixedNow() }), nightJobs: { build: true, deliver: true, crew: true }, gatewayAnswers: true };
    const words = (changes: Partial<StatusReport>) => tonightWords({ ...base, ...changes });

    expect(words({})).toBe("nothing to build so far: no approved idea is waiting");
    expect(words({ waitingToBuild: 1, nextBuildTakes: 1 })).toBe("1 approved idea will be built at the next build");
    expect(words({ waitingToBuild: 3, nextBuildTakes: 2 })).toBe("2 approved ideas will be built at the next build, 1 more waits for another night");
    expect(words({ waitingToBuild: 5, nextBuildTakes: 2 })).toBe("2 approved ideas will be built at the next build, 3 more wait for another night");
    // Paused beats everything: nothing is built, whatever is waiting.
    expect(words({ paused: true, waitingToBuild: 2, nextBuildTakes: 2 })).toBe("nothing will be built: Overnight is paused");
    expect(words({ waitingToBuild: 2, nextBuildTakes: 2, nightJobs: { build: false, deliver: true, crew: true } })).toBe(
      "nothing will be built: the build job is not installed. Put it in place with: scripts/install-agents.sh install build",
    );
    expect(words({ waitingToBuild: 2, nextBuildTakes: 0 })).toBe("nothing more will be built that day: its limit of 2 is used up. 2 approved ideas wait for the night after");
    expect(words({ waitingToBuild: 2, waitingForSecondTry: 1, nextBuildTakes: 0 })).toBe(
      "nothing more will be built that day: its limit of 2 is used up. 2 approved ideas wait for the night after (counting 1 second try after a build that was cut off)",
    );
    expect(words({ waitingToBuild: 1, nextBuildTakes: 0 })).toBe("nothing more will be built that day: its limit of 2 is used up. 1 approved idea waits for the night after");
    // Things that do not stop the build, but change how the night goes.
    expect(words({ waitingToBuild: 1, nextBuildTakes: 1, gatewayAnswers: false })).toBe(
      "1 approved idea will be built at the next build. But the Kiro Crew gateway does not answer, so the fallback builder (Kiro CLI) would do the building",
    );
    expect(words({ waitingToBuild: 1, nextBuildTakes: 1, gatewayAnswers: false, buildBackend: "kiro-cli", nightJobs: { build: true, deliver: false, crew: true } })).toBe(
      "1 approved idea will be built at the next build. But the Kiro Crew gateway does not answer, so there is no fallback builder, and the deliver job is not installed, so nothing would be published in the morning",
    );
    // Not known is not a problem to report: a caller that cannot look says nothing about it.
    expect(words({ waitingToBuild: 1, nextBuildTakes: 1, gatewayAnswers: null, nightJobs: undefined })).toBe("1 approved idea will be built at the next build");
    // Nothing about mains power: on battery Overnight holds the Mac awake itself, and builds all the same.
    expect(words({ waitingToBuild: 1, nextBuildTakes: 1, power: "battery" })).toBe("1 approved idea will be built at the next build");
  });

  it("puts what stops the night first: paused, a rehearsal folder, jobs that belong elsewhere, no build job, nothing waiting, the month's credits, the day's limit", () => {
    const base: StatusReport = { ...collectStatus({ store: new Store(":memory:"), config, now: fixedNow() }), nightJobs: { build: true, deliver: true, crew: true }, gatewayAnswers: true };
    const usedUp = { ...base.buildCredits, counted: 412.3, reached: true };
    /** Everything wrong at once. Each line below takes one more thing away, and the next reason shows. */
    const all: Partial<StatusReport> = { paused: true, rehearsalIdeas: 1, jobsBelongHere: false, nightJobs: { build: false, deliver: true, crew: true }, waitingToBuild: 0, nextBuildTakes: 0, buildCredits: usedUp };
    const words = (changes: Partial<StatusReport>) => tonightWords({ ...base, ...all, ...changes });

    expect(words({})).toBe("nothing will be built: Overnight is paused");
    expect(words({ paused: false })).toBe("nothing will be built: this data folder holds a rehearsal idea, and the night's commands do not run here");
    expect(words({ paused: false, rehearsalIdeas: 3 })).toBe("nothing will be built: this data folder holds 3 rehearsal ideas, and the night's commands do not run here");
    expect(words({ paused: false, rehearsalIdeas: 0 })).toBe("nothing is built on this data folder by the night jobs: they are installed for another one");
    // Not known, or known to be this folder's: not a reason.
    for (const jobsBelongHere of [true, null, undefined]) {
      expect(words({ paused: false, rehearsalIdeas: 0, jobsBelongHere })).toBe("nothing will be built: the build job is not installed. Put it in place with: scripts/install-agents.sh install build");
    }
    const installed = { paused: false, rehearsalIdeas: 0, jobsBelongHere: true, nightJobs: { build: true, deliver: true, crew: true } };
    expect(words(installed)).toBe("nothing to build so far: no approved idea is waiting");
    expect(words({ ...installed, waitingToBuild: 2 })).toBe("nothing will be built: this month's build credits are used up (see Build credits)");
    // A limit of 0 is a setting, not a month that ran out.
    expect(words({ ...installed, waitingToBuild: 2, buildCredits: { ...usedUp, counted: 0, limit: 0 } })).toBe("nothing will be built: MAX_BUILD_CREDITS_PER_MONTH in .env is 0 (see Build credits)");
    expect(words({ ...installed, waitingToBuild: 2, buildCredits: base.buildCredits })).toBe("nothing more will be built that day: its limit of 2 is used up. 2 approved ideas wait for the night after");
    expect(words({ ...installed, waitingToBuild: 2, nextBuildTakes: 2, buildCredits: base.buildCredits })).toBe("2 approved ideas will be built at the next build");
  });

  it("counts what the next build takes against the day it runs in, not today", async () => {
    const store = new Store(":memory:");
    const approve = (sample: (typeof SAMPLE_IDEAS)[keyof typeof SAMPLE_IDEAS], heardAt: number) => moveIdea(store, addIdea(store, sample, at(heardAt)), ["asked", "approved"], at(heardAt + 60));
    // Two builds were started at 1 am today (Oct 9). They used up Oct 9's limit, not Oct 10's.
    for (const [sample, slug, heardAt] of [[SAMPLE_IDEAS.turns, "whose-turn-to-pay", -20 * 3600], [SAMPLE_IDEAS.plants, "plant-watering-tracker", -19 * 3600]] as const) {
      const idea = approve(sample, heardAt);
      store.transitionIdea(idea.id, "building", { slug, buildStartedAt: at(-11 * 3600) }, at(-11 * 3600));
    }
    approve(SAMPLE_IDEAS.chores, -3600);
    // Noon on Oct 9: the next build is at 1 am on Oct 10, a day with no builds yet.
    expect(collectStatus({ store, config, now: fixedNow() })).toMatchObject({ buildsToday: 2, maxBuildsPerNight: 2, waitingToBuild: 1, nextBuildAt: "2026-10-10T07:00:00.000Z", nextBuildTakes: 1 });
    // A build time later the same day falls in the day whose limit is already used up.
    expect(collectStatus({ store, config: testConfig({ BUILD_TIME: "13:00" }), now: fixedNow() })).toMatchObject({ nextBuildAt: "2026-10-09T19:00:00.000Z", nextBuildTakes: 0 });
    // A higher limit leaves room again.
    expect(collectStatus({ store, config: testConfig({ BUILD_TIME: "13:00", MAX_BUILDS_PER_NIGHT: "3" }), now: fixedNow() })).toMatchObject({ nextBuildTakes: 1 });
  });

  it("says who fences in the Kiro Crew gateway, from the settings", async () => {
    const line = async (settings: Record<string, string>) => {
      const out = capture();
      const json = capture();
      expect(await status({ store: new Store(":memory:"), config: testConfig(settings), write: out.write, now: fixedNow() })).toBe(0);
      await status({ store: new Store(":memory:"), config: testConfig(settings), write: json.write, now: fixedNow() }, { json: true });
      return { shown: out.lines.find((row) => row.startsWith("  Build sandbox")), json: (JSON.parse(json.text()) as { buildSandbox: unknown }).buildSandbox };
    };
    // The weaker mode says what it leaves open, so nobody takes it for the stronger one.
    expect(await line({ BUILD_SANDBOX: "crew" })).toEqual({
      shown: "  Build sandbox     crew (Kiro Crew's own sandbox, at its strict level: it leaves the GitHub login, the Bee login and the transcripts within a build job's reach)",
      json: "crew",
    });
    const overnight = { shown: "  Build sandbox     overnight (the Kiro Crew gateway runs inside Overnight's own sandbox, proved by a probe each night)", json: "overnight" };
    expect(await line({ BUILD_SANDBOX: "overnight" })).toEqual(overnight);
    // Nothing set: Overnight's own sandbox (SPEC §6, the owner's decision of Oct 10).
    expect(await line({})).toEqual(overnight);
    // A value that is neither never gets this far: the settings refuse it, naming it.
    expect(() => testConfig({ BUILD_SANDBOX: "strict" })).toThrow("BUILD_SANDBOX");
  });

  it("says whether the Kiro Crew gateway answers, when it is given a way to find out", async () => {
    const run = async (gatewayAnswers: (() => Promise<boolean>) | undefined) => {
      const out = capture();
      const json = capture();
      expect(await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow(), gatewayAnswers })).toBe(0);
      await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), gatewayAnswers }, { json: true });
      return { shown: out.lines.find((row) => row.startsWith("  Kiro Crew gateway")), json: JSON.parse(json.text()) as Record<string, unknown>, all: out.lines };
    };
    expect((await run(async () => true)).shown).toBe("  Kiro Crew gateway  answers");
    expect((await run(async () => true)).json).toMatchObject({ gatewayAnswers: true });
    const down = await run(async () => false);
    expect(down.shown).toBe("  Kiro Crew gateway  does NOT answer. See why with: scripts/install-agents.sh status crew");
    expect(down.json).toMatchObject({ gatewayAnswers: false });

    // The look itself fails: say so, and still show the rest.
    const broken = await run(() => Promise.reject(new Error("made-up: the look fell over")));
    expect(broken.shown).toBe("  Kiro Crew gateway  could not tell whether it answers");
    expect(broken.json).toMatchObject({ gatewayAnswers: null, utterances: 0 });
    expect(broken.all).toContain("  Utterances saved   0");
    expect(broken.all.join("\n")).not.toContain("made-up");

    // Left out, it is not mentioned at all, and neither are the night jobs.
    const without = await run(undefined);
    expect(without.shown).toBeUndefined();
    expect(without.json).not.toHaveProperty("gatewayAnswers");
    expect(without.json).not.toHaveProperty("nightJobs");
  });

  it("says in one plain line which night jobs are installed", async () => {
    const line = async (nightJobs: { build: boolean; deliver: boolean; crew: boolean }) => {
      const out = capture();
      await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow(), nightJobs: () => nightJobs });
      return out.lines.find((row) => row.startsWith("  Night jobs"));
    };
    expect(await line({ build: true, deliver: true, crew: true })).toBe("  Night jobs        build, deliver and Kiro Crew gateway installed");
    // Each missing job gets its own command, with its name: a bare "scripts/install-agents.sh install"
    // would also stop and restart the listener. The gateway comes first: the build needs it.
    expect(await line({ build: false, deliver: false, crew: false })).toBe(
      "  Night jobs        not installed. Put them in place with: scripts/install-agents.sh install crew   then: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver",
    );
    expect(await line({ build: true, deliver: true, crew: false })).toBe("  Night jobs        not installed: Kiro Crew gateway. Put it in place with: scripts/install-agents.sh install crew");
    expect(await line({ build: false, deliver: false, crew: true })).toBe(
      "  Night jobs        not installed: build, deliver. Put them in place with: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver",
    );
    expect(await line({ build: true, deliver: false, crew: true })).toBe("  Night jobs        not installed: deliver. Put it in place with: scripts/install-agents.sh install deliver");

    const json = capture();
    await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), nightJobs: () => ({ build: true, deliver: false, crew: true }) }, { json: true });
    expect(JSON.parse(json.text())).toMatchObject({ nightJobs: { build: true, deliver: false, crew: true } });
  });

  it("never tells the operator to run the installer without naming a job", async () => {
    const out = capture();
    await status({
      store: new Store(":memory:"),
      config,
      write: out.write,
      now: fixedNow(),
      listenerState: () => ({ running: false, jobInstalled: false }),
      nightJobs: () => ({ build: false, deliver: false, crew: false }),
      gatewayAnswers: async () => false,
    });
    expect(out.text()).toContain("scripts/install-agents.sh install ");
    expect(out.text()).not.toMatch(/install-agents\.sh install(?! (listen|crew|build|deliver)\b)/);
  });

  it("asks Bee about the login only with --check", async () => {
    const plainRun = capture();
    await status({ store: new Store(":memory:"), config, write: plainRun.write, now: fixedNow() });
    expect(plainRun.text()).not.toContain("Bee login");

    let calls = 0;
    const checked = capture();
    const beeLoginState = async () => {
      calls += 1;
      return "logged-in" as const;
    };
    await status({ store: new Store(":memory:"), config, write: checked.write, now: fixedNow() }, { beeLoginState });
    expect(calls).toBe(1);
    expect(checked.lines.at(-2)).toBe("  Bee login         logged in");
    expect(checked.lines.at(-3)).toMatch(/^ {2}Tonight {2,}nothing to build so far/);
  });

  it("still reports everything else when the Bee check fails", async () => {
    const out = capture();
    const beeLoginState = async () => {
      throw new BeeError("timeout", "Bee did not answer within 15 seconds.");
    };
    expect(await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow() }, { beeLoginState })).toBe(0);
    expect(out.text()).toContain("Utterances saved  0");
    expect(out.lines.slice(-3)).toEqual(["  Bee login         could not tell (Bee did not answer)", "  Full check        npx overnight preflight", "  (Bee check failed: Bee did not answer within 15 seconds.)"]);
  });

  it("counts the ideas a rehearsal made, which make this a rehearsal folder", async () => {
    const store = populated();
    expect(collectStatus({ store, config, now: fixedNow() }).rehearsalIdeas).toBe(0);
    for (const title of ["Made-up one", "Made-up two"]) store.createIdea({ title, pitch: "p", quote: "", confidence: 1, conversationKey: REHEARSAL_CONVERSATION_KEY, detectorRunId: null }, at(-60));
    expect(collectStatus({ store, config, now: fixedNow() }).rehearsalIdeas).toBe(2);
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow() });
    expect(out.lines.find((line) => line.startsWith("  Tonight"))).toBe("  Tonight               nothing will be built: this data folder holds 2 rehearsal ideas, and the night's commands do not run here");
  });
});

// ---------- the night clock, the month's credits, the power row, and jobs that belong elsewhere ----------

/** 10:00 am in Boise on Oct 12. That night's build time was 07:00Z (1:00 am), the delivery's 12:30Z (6:30 am). */
const MORNING = "2026-10-12T16:00:00.000Z";
const ALL_JOBS: NightJobsState = { build: true, deliver: true, crew: true };
const ON_TIMER: Record<ClockedJob, JobTrigger | null> = { build: "timer", deliver: "timer" };

/** The rows of the printed status, by label. */
async function rows(store: Store, deps: Partial<StatusDeps> = {}, now: string = MORNING): Promise<Map<string, string>> {
  const out = capture();
  expect(await status({ store, config, write: out.write, now: fixedNow(now), ...deps })).toBe(0);
  const found = new Map<string, string>();
  for (const line of out.lines.slice(1)) {
    const parts = /^ {2}(\S.*?) {2,}(.*)$/.exec(line);
    if (parts !== null) found.set(parts[1] ?? "", parts[2] ?? "");
  }
  return found;
}

/** A job's record for the slot that came at or before `noticedAt`, taken through the steps named. */
function nightRecord(job: ClockedJob, noticedAt: string, steps: { waiting?: NightWait; startedAt?: string; closedAt?: string; closedAs?: NonNullable<NightRun["closedAs"]> } = {}): NightRun {
  const noticed = new Date(noticedAt);
  let run = noticedRun(currentSlot(job, noticed, config), noticed);
  if (steps.waiting !== undefined) run = waitingRun(run, steps.waiting);
  if (steps.startedAt !== undefined) run = startedRun(run, new Date(steps.startedAt));
  if (steps.closedAs !== undefined) run = closedRun(run, steps.closedAs, new Date(steps.closedAt ?? steps.startedAt ?? noticedAt));
  return run;
}

/** A data folder on which both night jobs are on the clock: installed yesterday afternoon, and awake a moment ago. */
function onTheClock(lastCheck: string | null = "2026-10-12T15:59:30.000Z"): Store {
  const store = new Store(":memory:");
  for (const job of ["build", "deliver"] as const) {
    writeNightRun(store, job, nightRecord(job, "2026-10-11T20:00:00.000Z", { closedAs: "first-check" }), new Date("2026-10-11T20:00:00.000Z"));
    if (lastCheck !== null) noteChecked(store, job, new Date(lastCheck));
  }
  return store;
}

const clockDeps: Partial<StatusDeps> = { nightJobs: () => ALL_JOBS, jobTriggers: () => ON_TIMER, jobRunning: () => false };

describe("overnight status: this month's build credits", () => {
  /** An idea to hang ledger rows on. Every row belongs to one. */
  const withCosts = (costs: Array<{ at: string; credits: number; measured: boolean }>): Store => {
    const store = new Store(":memory:");
    const idea = addIdea(store, SAMPLE_IDEAS.turns, at(-3600));
    for (const cost of costs) store.recordBuildCost({ ideaId: idea.id, backend: cost.measured ? "kiro-crew" : "kiro-cli", ...cost });
    return store;
  };

  it("says what has been counted against the month's limit, and how much of that is an estimate", async () => {
    const store = withCosts([
      { at: "2026-10-03T07:10:00.000Z", credits: 8.2, measured: true },
      { at: "2026-10-12T07:10:00.000Z", credits: 4.1, measured: false },
      // September's, and one dated the first instant of November in Boise: neither is this month's.
      { at: "2026-09-30T07:10:00.000Z", credits: 90, measured: true },
      { at: "2026-11-01T06:00:00.000Z", credits: 90, measured: true },
    ]);
    expect((await rows(store)).get("Build credits")).toBe("12.3 of 400 used this month (4.1 of that is an estimate)");
    expect(collectStatus({ store, config, now: fixedNow(MORNING) }).buildCredits).toEqual({ monthStart: "2026-10-01T06:00:00.000Z", monthEnd: "2026-11-01T06:00:00.000Z", counted: 12.3, estimated: 4.1, tries: 2, limit: 400, reached: false });
    // All of it measured: nothing to add.
    expect((await rows(withCosts([{ at: "2026-10-03T07:10:00.000Z", credits: 37, measured: true }]))).get("Build credits")).toBe("37 of 400 used this month");
    expect((await rows(new Store(":memory:"))).get("Build credits")).toBe("0 of 400 used this month");
  });

  it("says that nothing more is built once the limit is reached, until when, and what would change that", async () => {
    const store = withCosts([
      { at: "2026-10-03T07:10:00.000Z", credits: 400, measured: true },
      { at: "2026-10-12T07:10:00.000Z", credits: 12.3, measured: true },
    ]);
    moveIdea(store, addIdea(store, SAMPLE_IDEAS.plants, at(-900)), ["asked", "approved"], at(-800));
    const shown = await rows(store, clockDeps);
    expect(shown.get("Build credits")).toBe("412.3 of 400 used this month: nothing more is built until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
    expect(shown.get("Tonight")).toBe("nothing will be built: this month's build credits are used up (see Build credits)");
    // The same day and the same numbers as the sentence the builder logs and prints.
    const budget = collectStatus({ store, config, now: fixedNow(MORNING) }).buildCredits;
    expect(budget.reached).toBe(true);
    expect(budgetReachedText(budget, config.timeZone)).toBe("this month's build credits are used up (412.3 of 400 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");

    // Exactly at the limit is reached too, and an estimate among it is still said.
    const exactly = withCosts([
      { at: "2026-10-03T07:10:00.000Z", credits: 399, measured: true },
      { at: "2026-10-04T07:10:00.000Z", credits: 1, measured: false },
    ]);
    expect((await rows(exactly)).get("Build credits")).toBe("400 of 400 used this month (1 of that is an estimate): nothing more is built until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
  });

  it("says a limit of 0 for what it is: a setting, not a month that ran out", async () => {
    const zero = testConfig({ MAX_BUILD_CREDITS_PER_MONTH: "0" });
    const store = withCosts([{ at: "2026-10-03T07:10:00.000Z", credits: 12.3, measured: true }]);
    moveIdea(store, addIdea(store, SAMPLE_IDEAS.plants, at(-900)), ["asked", "approved"], at(-800));
    const out = capture();
    await status({ store, config: zero, write: out.write, now: fixedNow(MORNING), nightJobs: () => ALL_JOBS });
    const row = (label: string) => out.lines.find((line) => line.startsWith(`  ${label}`))?.replace(/^ {2}\S.*? {2,}/, "");
    expect(row("Build credits")).toBe("12.3 used this month. MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built until it is raised");
    expect(row("Tonight")).toBe("nothing will be built: MAX_BUILD_CREDITS_PER_MONTH in .env is 0 (see Build credits)");
    expect(out.text()).not.toContain("Nov 1");
  });
});

describe("overnight status: the last night and the next, by the night clock", () => {
  it("says nothing about a last build or a last deliver before either job has ever run", async () => {
    // Both jobs were installed this morning, after their times: today's slots count as handled without a run.
    const store = onTheClock();
    for (const job of ["build", "deliver"] as const) writeNightRun(store, job, nightRecord(job, "2026-10-12T15:00:00.000Z", { closedAs: "first-check" }), new Date(MORNING));
    const shown = await rows(store, clockDeps);
    expect(shown.has("Last build")).toBe(false);
    expect(shown.has("Last deliver")).toBe(false);
    // Nothing is due: the next times are the settings' own, as they always were.
    expect(shown.get("Next build")).toBe("Oct 13, 1:00 AM (kiro-crew first)");
    expect(shown.get("Next deliver")).toBe("Oct 13, 6:30 AM, for the link on the wrist at 07:00");
  });

  it("shows when each job last started, and whether that was on time, late or cut short", async () => {
    const store = onTheClock();
    const write = (job: ClockedJob, run: NightRun) => writeNightRun(store, job, run, new Date(MORNING));
    write("build", nightRecord("build", "2026-10-12T07:00:20.000Z", { startedAt: "2026-10-12T07:00:20.000Z", closedAs: "done", closedAt: "2026-10-12T07:12:00.000Z" }));
    write("deliver", nightRecord("deliver", "2026-10-12T12:30:10.000Z", { startedAt: "2026-10-12T12:30:10.000Z", closedAs: "done", closedAt: "2026-10-12T12:31:00.000Z" }));
    let shown = await rows(store, clockDeps);
    expect(shown.get("Last build")).toBe("Oct 12, 1:00 AM, on time");
    expect(shown.get("Last deliver")).toBe("Oct 12, 6:30 AM, on time");

    // The Mac was asleep until 3:00 am, and waited its minute: 121 minutes late.
    write("build", nightRecord("build", "2026-10-12T09:01:00.000Z", { startedAt: "2026-10-12T09:01:00.000Z", closedAs: "done", closedAt: "2026-10-12T09:12:00.000Z" }));
    write("deliver", nightRecord("deliver", "2026-10-12T12:30:10.000Z", { startedAt: "2026-10-12T12:30:10.000Z", closedAs: "cut-short", closedAt: "2026-10-12T12:30:40.000Z" }));
    shown = await rows(store, clockDeps);
    expect(shown.get("Last build")).toBe("Oct 12, 3:01 AM, 121 minutes late");
    expect(shown.get("Last deliver")).toBe("Oct 12, 6:30 AM, on time, cut short");

    // Up to two minutes after its time is on time. From two whole minutes on it is late.
    write("build", nightRecord("build", "2026-10-12T07:01:59.000Z", { startedAt: "2026-10-12T07:01:59.000Z", closedAs: "done" }));
    expect((await rows(store, clockDeps)).get("Last build")).toBe("Oct 12, 1:01 AM, on time");
    write("build", nightRecord("build", "2026-10-12T07:02:00.000Z", { startedAt: "2026-10-12T07:02:00.000Z", closedAs: "cut-short" }));
    expect((await rows(store, clockDeps)).get("Last build")).toBe("Oct 12, 1:02 AM, 2 minutes late, cut short");

    // The night after, with nothing run yet: the last run is still that one.
    expect((await rows(store, clockDeps, "2026-10-13T08:00:00.000Z")).get("Last build")).toBe("Oct 12, 1:02 AM, 2 minutes late, cut short");
  });

  it("says a build or a deliver that is running is running, and since when", async () => {
    const store = onTheClock();
    writeNightRun(store, "build", nightRecord("build", "2026-10-12T15:40:00.000Z", { startedAt: "2026-10-12T15:41:00.000Z" }), new Date(MORNING));
    const running: Partial<StatusDeps> = { ...clockDeps, jobRunning: (job) => job === "build" };
    let shown = await rows(store, running);
    expect(shown.get("Last build")).toBe("Oct 12, 9:41 AM, 521 minutes late, still running");
    expect(shown.get("Next build")).toBe("running now, since Oct 12, 9:41 AM");
    // The deliver job is not running: its row is the ordinary one.
    expect(shown.get("Next deliver")).toMatch(/^as soon as the Mac has been awake/);

    // Its lock is free after all: the run died. The job's next check closes it as cut short, and nothing is "running".
    shown = await rows(store, clockDeps);
    expect(shown.get("Last build")).toBe("Oct 12, 9:41 AM, 521 minutes late, cut short");
    expect(shown.get("Next build")).toBe("Oct 13, 1:00 AM (kiro-crew first)");
  });

  it("says a run that is due and has not started is due, and what it is waiting for", async () => {
    // Installed yesterday, asleep all night: at 10:00 am both jobs' slots are open.
    const store = onTheClock();
    let shown = await rows(store, clockDeps);
    expect(shown.get("Next build")).toBe("as soon as the Mac has been awake for a minute or two: the Oct 12, 1:00 AM build has not run yet (kiro-crew first)");
    expect(shown.get("Next deliver")).toBe("as soon as the Mac has been awake for a minute or two: the Oct 12, 6:30 AM deliver has not run yet");

    // Awake, and no real internet: both have found themselves due and stored why they wait.
    writeNightRun(store, "build", nightRecord("build", "2026-10-12T15:58:00.000Z", { waiting: "offline" }), new Date(MORNING));
    writeNightRun(store, "deliver", nightRecord("deliver", "2026-10-12T15:58:00.000Z", { waiting: "offline" }), new Date(MORNING));
    shown = await rows(store, clockDeps);
    expect(shown.get("Next build")).toBe("waiting for the internet: the Oct 12, 1:00 AM build has not run yet (kiro-crew first)");
    expect(shown.get("Next deliver")).toBe("waiting for the internet: the Oct 12, 6:30 AM deliver has not run yet");

    // The delivery waits for a late build, whether that build is running or about to start.
    for (const waiting of ["build-running", "build-not-started"] as const) {
      writeNightRun(store, "deliver", nightRecord("deliver", "2026-10-12T15:58:00.000Z", { waiting }), new Date(MORNING));
      expect((await rows(store, clockDeps)).get("Next deliver"), waiting).toBe("waiting for the build to finish first: the Oct 12, 6:30 AM deliver has not run yet");
    }
  });

  it("keeps to the settings' own next times when nothing wakes the job on this data folder", async () => {
    const store = onTheClock();
    const usual = { build: "Oct 13, 1:00 AM (kiro-crew first)", deliver: "Oct 13, 6:30 AM, for the link on the wrist at 07:00" };
    const both = async (deps: Partial<StatusDeps>) => {
      const shown = await rows(store, deps);
      return { build: shown.get("Next build"), deliver: shown.get("Next deliver") };
    };
    // Still on macOS's calendar: that job does not catch a slot up by Overnight's clock.
    expect(await both({ ...clockDeps, jobTriggers: () => ({ build: "calendar", deliver: "calendar" }) })).toEqual(usual);
    // Not installed, or its settings file could not be read.
    expect(await both({ ...clockDeps, jobTriggers: () => ({ build: null, deliver: null }) })).toEqual(usual);
    // Installed for another data folder.
    expect(await both({ ...clockDeps, jobsBelongHere: () => false })).toEqual(usual);
    // One of each: only the job on the timer is said to be due.
    expect(await both({ ...clockDeps, jobTriggers: () => ({ build: "timer", deliver: "calendar" }) })).toEqual({ build: expect.stringMatching(/^as soon as the Mac has been awake/), deliver: usual.deliver });
    // A caller that cannot look at the jobs goes by the record alone.
    expect((await both({})).build).toMatch(/^as soon as the Mac has been awake/);
  });
});

describe("overnight status: the night clock row", () => {
  const clockRow = async (store: Store, deps: Partial<StatusDeps> = {}, now: string = MORNING) => (await rows(store, { ...clockDeps, ...deps }, now)).get("Night clock");

  it("says both jobs check the time every minute when they do", async () => {
    expect(await clockRow(onTheClock())).toBe("build and deliver check the time every minute, in America/Boise");
    // Exactly three minutes ago still counts as a moment ago.
    expect(await clockRow(onTheClock("2026-10-12T15:57:00.000Z"))).toBe("build and deliver check the time every minute, in America/Boise");
    // Only one of the two is installed: the Night jobs row says which is missing.
    expect(await clockRow(onTheClock(), { nightJobs: () => ({ build: true, deliver: false, crew: true }) })).toBe("the build job checks the time every minute, in America/Boise");
  });

  it("says which job is still on macOS's calendar, and how to move it", async () => {
    const store = onTheClock();
    expect(await clockRow(store, { jobTriggers: () => ({ build: "calendar", deliver: "timer" }) })).toBe(
      "the build job is still on macOS's calendar, which ran an hour late on Oct 11. Move it to Overnight's own clock with: scripts/install-agents.sh install build",
    );
    expect(await clockRow(store, { jobTriggers: () => ({ build: "timer", deliver: "calendar" }) })).toBe(
      "the deliver job is still on macOS's calendar, which ran an hour late on Oct 11. Move it to Overnight's own clock with: scripts/install-agents.sh install deliver",
    );
    expect(await clockRow(store, { jobTriggers: () => ({ build: "calendar", deliver: "calendar" }) })).toBe(
      "the build and deliver jobs are still on macOS's calendar, which ran an hour late on Oct 11. Move them to Overnight's own clock with: scripts/install-agents.sh install build   then: scripts/install-agents.sh install deliver",
    );
  });

  it("says when a job has stopped checking the time, or never has, and where to look", async () => {
    // Both last asked the clock at 11:02 pm.
    const stale = onTheClock("2026-10-12T05:02:00.000Z");
    expect(await clockRow(stale)).toBe(
      "the build job last checked the time Oct 11, 11:02 PM. If the Mac has been awake for a few minutes since, see why with: scripts/install-agents.sh status build   Also: the deliver job last checked the time Oct 11, 11:02 PM. If the Mac has been awake for a few minutes since, see why with: scripts/install-agents.sh status deliver",
    );
    // One millisecond more than three minutes ago is not a moment ago.
    expect(await clockRow(onTheClock("2026-10-12T15:56:59.999Z"))).toContain("the build job last checked the time Oct 12, 9:56 AM.");
    // A job that is running does not ask the clock meanwhile: its lock says it is alive.
    expect(await clockRow(stale, { jobRunning: (job) => job === "build" })).toBe(
      "the deliver job last checked the time Oct 11, 11:02 PM. If the Mac has been awake for a few minutes since, see why with: scripts/install-agents.sh status deliver",
    );
    // Not being able to tell is not "running".
    expect(await clockRow(stale, { jobRunning: () => null })).toContain("the build job last checked the time");

    expect(await clockRow(onTheClock(null), { nightJobs: () => ({ build: true, deliver: false, crew: true }) })).toBe(
      "the build job has never checked the time. If the Mac has been awake for a few minutes since it was installed, see why with: scripts/install-agents.sh status build",
    );
  });

  it("says when a clock's record is dated ahead, so nothing runs until then, and how to start it from now", async () => {
    const store = onTheClock();
    // The Mac's clock once read January 5: the build's record is from then.
    writeNightRun(store, "build", nightRecord("build", "2027-01-05T08:00:00.000Z", { closedAs: "first-check" }), new Date(MORNING));
    expect(await clockRow(store)).toBe("the build clock's record is dated ahead (Jan 5, 2027), so nothing runs until then. Start it from now with: scripts/install-agents.sh install build");
    expect(collectStatus({ store, config, now: fixedNow(MORNING) }).nightClock.build.recordAhead).toBe("2027-01-05");
    // A day ahead in the same year: the year goes without saying.
    writeNightRun(store, "deliver", nightRecord("deliver", "2026-10-14T13:00:00.000Z", { closedAs: "first-check" }), new Date(MORNING));
    expect(await clockRow(store)).toContain("   Also: the deliver clock's record is dated ahead (Oct 14), so nothing runs until then. Start it from now with: scripts/install-agents.sh install deliver");
    expect(dayWords("2027-01-05", "2026-10-12")).toBe("Jan 5, 2027");
    expect(dayWords("2026-10-14", "2026-10-12")).toBe("Oct 14");
    expect(dayWords("not a day", "2026-10-12")).toBe("not a day");
  });

  it("says when an installed job's settings file could not be read, and names every problem when there are two kinds", async () => {
    const store = onTheClock("2026-10-12T05:02:00.000Z");
    expect(await clockRow(store, { jobTriggers: () => ({ build: "calendar", deliver: null }) })).toBe(
      "the build job is still on macOS's calendar, which ran an hour late on Oct 11. Move it to Overnight's own clock with: scripts/install-agents.sh install build   Also: the deliver job's settings file could not be read. See why with: scripts/install-agents.sh status deliver",
    );
    expect(await clockRow(store, { jobTriggers: () => ({ build: "timer", deliver: "calendar" }) })).toBe(
      "the deliver job is still on macOS's calendar, which ran an hour late on Oct 11. Move it to Overnight's own clock with: scripts/install-agents.sh install deliver   Also: the build job last checked the time Oct 11, 11:02 PM. If the Mac has been awake for a few minutes since, see why with: scripts/install-agents.sh status build",
    );
  });

  it("is left out when neither job is installed, when they were installed for another data folder, and when the caller cannot look", async () => {
    const store = onTheClock();
    expect(await clockRow(store, { nightJobs: () => ({ build: false, deliver: false, crew: true }) })).toBeUndefined();
    expect(await clockRow(store, { jobsBelongHere: () => false })).toBeUndefined();
    expect((await rows(store, { nightJobs: () => ALL_JOBS })).has("Night clock")).toBe(false);
    expect((await rows(store, { jobTriggers: () => ON_TIMER })).has("Night clock")).toBe(false);
    expect(nightClockWords(collectStatus({ store, config, now: fixedNow(MORNING) }))).toBeNull();
    // It sits between the night jobs and the gateway.
    const out = capture();
    await status({ store, config, write: out.write, now: fixedNow(MORNING), ...clockDeps, gatewayAnswers: async () => true, powerSource: async () => "mains" });
    const labels = out.lines.slice(1).map((line) => /^ {2}(\S.*?) {2,}/.exec(line)?.[1]);
    expect(labels).toEqual(["Mode", "Data folder", "Time zone", "Utterances saved", "Detector runs", "Ideas", "Asks today", "Builds today", "Build credits", "Waiting to build", "Next build", "Next deliver", "Night jobs", "Night clock", "Kiro Crew gateway", "Build sandbox", "Power", "Tonight", "Full check"]);
  });

  it("puts every row in its place when all of them show", async () => {
    const store = populated();
    const delivered = moveIdea(store, addIdea(store, { title: "Made-up timer", pitch: "Counts down.", quote: "a made-up line" }, at(-9000)), ["asked", "approved", "building", "built", "published", "delivered"], at(-8000));
    store.updateIdea(delivered.id, { publishedUrl: "https://example.invalid/apps/made-up-timer/" }, at(-7000));
    for (const job of ["build", "deliver"] as const) {
      writeNightRun(store, job, nightRecord(job, at(-3 * 3600), { startedAt: at(-3 * 3600), closedAs: "done" }), new Date(at(0)));
      noteChecked(store, job, new Date(at(-30)));
    }
    const out = capture();
    await status(
      { store, config, write: out.write, now: fixedNow(), listenerState: () => ({ running: true, jobInstalled: true }), ...clockDeps, gatewayAnswers: async () => true, powerSource: async () => "mains", jobsBelongHere: () => true },
      { beeLoginState: async () => "logged-in" },
    );
    const labels = out.lines.slice(1).map((line) => /^ {2}(\S.*?) {2,}/.exec(line)?.[1]);
    expect(labels).toEqual([
      "Mode",
      "Listener",
      "Data folder",
      "Time zone",
      "Utterances saved",
      "Newest utterance",
      "Waiting for detector",
      "Detector runs",
      "Ideas",
      "Asks today",
      "Builds today",
      "Build credits",
      "Waiting to build",
      "Last delivered",
      "Last build",
      "Last deliver",
      "Next build",
      "Next deliver",
      "Night jobs",
      "Night clock",
      "Kiro Crew gateway",
      "Build sandbox",
      "Power",
      "Tonight",
      "Bee login",
      "Full check",
    ]);
  });
});

describe("overnight status: power", () => {
  const power = async (powerSource: (() => Promise<PowerSource>) | undefined) => {
    const out = capture();
    const json = capture();
    await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow(), powerSource });
    await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), powerSource }, { json: true });
    return { row: out.lines.find((line) => line.startsWith("  Power"))?.replace(/^ {2}Power {2,}/, ""), json: JSON.parse(json.text()) as Record<string, unknown>, all: out.text() };
  };

  it("says mains or battery, and on battery what that means: awake while the lid is open, nothing with it closed", async () => {
    expect((await power(async () => "mains")).row).toBe("mains power");
    expect((await power(async () => "mains")).json).toMatchObject({ power: "mains" });
    const battery = await power(async () => "battery");
    expect(battery.row).toBe("battery: Overnight keeps the Mac awake while the lid is open. With the lid closed nothing runs until it is opened");
    expect(battery.json).toMatchObject({ power: "battery" });
    // No run waits for mains power, and no row says one does.
    expect(battery.all).not.toMatch(/plugged in|waits? (for|until).*(mains|plugged)/);
  });

  it("says it could not tell when the reading is not one of the two, or the look itself fails, and still shows the rest", async () => {
    expect((await power(async () => "unknown")).row).toBe("could not tell");
    const failed = await power(() => Promise.reject(new Error("made-up: pmset fell over")));
    expect(failed.row).toBe("could not tell");
    expect(failed.json).toMatchObject({ power: "unknown", utterances: 0 });
    expect(failed.all).not.toContain("made-up");
  });

  it("is left out when the caller cannot look", async () => {
    const without = await power(undefined);
    expect(without.row).toBeUndefined();
    expect(without.json).not.toHaveProperty("power");
  });
});

describe("overnight status on a data folder the installed jobs do not use", () => {
  const elsewhere = async (listener: ListenerState, nightJobs: NightJobsState = ALL_JOBS, jobsBelongHere: boolean | null = false) =>
    rows(onTheClock(), { ...clockDeps, listenerState: () => listener, nightJobs: () => nightJobs, jobsBelongHere: () => jobsBelongHere });

  it("does not call a listener the job did not start the job's, or the job's absence here a fault", async () => {
    expect((await elsewhere({ running: true, jobInstalled: true })).get("Listener")).toBe("running on this data folder, started by hand (the installed background job listens on another data folder)");
    expect((await elsewhere({ running: false, jobInstalled: true })).get("Listener")).toBe("not running on this data folder (the installed background job listens on another data folder)");
    expect((await elsewhere({ running: null, jobInstalled: true })).get("Listener")).toBe("could not tell whether one is running on this data folder (the installed background job listens on another data folder)");
    // No listener job is installed at all: the ordinary words.
    expect((await elsewhere({ running: false, jobInstalled: false })).get("Listener")).toBe("not running (background job not installed). Start it with: scripts/install-agents.sh install listen");
  });

  it("says the night jobs are installed for another data folder, leaves the night clock row out, and says nothing is built here by them", async () => {
    const shown = await elsewhere({ running: false, jobInstalled: true });
    expect(shown.get("Night jobs")).toBe("installed for another data folder: none of them runs on this one");
    expect(shown.has("Night clock")).toBe(false);
    expect(shown.get("Tonight")).toBe("nothing is built on this data folder by the night jobs: they are installed for another one");
    // Some of them installed: still for another folder. None of them installed: the ordinary words.
    expect((await elsewhere({ running: false, jobInstalled: true }, { build: true, deliver: false, crew: false })).get("Night jobs")).toBe("installed for another data folder: none of them runs on this one");
    expect((await elsewhere({ running: false, jobInstalled: true }, { build: false, deliver: false, crew: false })).get("Night jobs")).toMatch(/^not installed\. Put them in place with:/);
  });

  it("changes nothing when the jobs are this folder's, or when that cannot be told", async () => {
    for (const jobsBelongHere of [true, null]) {
      const shown = await elsewhere({ running: true, jobInstalled: true }, ALL_JOBS, jobsBelongHere);
      expect(shown.get("Listener")).toBe("running (background job installed)");
      expect(shown.get("Night jobs")).toBe("build, deliver and Kiro Crew gateway installed");
      expect(shown.get("Night clock")).toBe("build and deliver check the time every minute, in America/Boise");
    }
    const json = capture();
    await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), jobsBelongHere: () => false }, { json: true });
    expect(JSON.parse(json.text())).toMatchObject({ jobsBelongHere: false });
    const unknown = capture();
    await status({ store: new Store(":memory:"), config, write: unknown.write, now: fixedNow(), jobsBelongHere: () => null }, { json: true });
    expect(JSON.parse(unknown.text())).toMatchObject({ jobsBelongHere: null });
    const left = capture();
    await status({ store: new Store(":memory:"), config, write: left.write, now: fixedNow() }, { json: true });
    expect(JSON.parse(left.text())).not.toHaveProperty("jobsBelongHere");
  });
});
