// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { BeeError, BUILD_INTERRUPTED_REASON, BUILD_STOPPED_REASON, MAX_BUILD_STARTS, parseConfig, Store } from "@overnight/core";
import type { ListenerState } from "../src/background.ts";
import { clockMinus, collectStatus, status, tonightWords } from "../src/commands/status.ts";
import type { StatusReport } from "../src/commands/status.ts";
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

    // The deliver job starts 30 minutes before DELIVER_TIME, around midnight too.
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
});
