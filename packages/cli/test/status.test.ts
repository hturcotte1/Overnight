// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { BeeError, parseConfig, Store } from "@overnight/core";
import type { ListenerState } from "../src/background.ts";
import { collectStatus, status } from "../src/commands/status.ts";
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
      // The only command on the screen that turns asking on is the one named for it.
      expect(out.text().match(/npx overnight \w+/g)).toEqual(["npx overnight resume"]);
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
    expect(await line({ running: false, jobInstalled: false })).toBe("  Listener          not running (background job not installed). Start it with: scripts/install-agents.sh install");
    expect(await line({ running: null, jobInstalled: true })).toBe("  Listener          could not tell whether it is running (background job installed). Check with: scripts/install-agents.sh status");

    const json = capture();
    await status({ store: new Store(":memory:"), config, write: json.write, now: fixedNow(), listenerState: () => ({ running: true, jobInstalled: false }) }, { json: true });
    expect(JSON.parse(json.text())).toMatchObject({ paused: false, listener: { running: true, jobInstalled: false } });
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
    expect(checked.lines.at(-1)).toBe("  Bee login         logged in");
  });

  it("still reports everything else when the Bee check fails", async () => {
    const out = capture();
    const beeLoginState = async () => {
      throw new BeeError("timeout", "Bee did not answer within 15 seconds.");
    };
    expect(await status({ store: new Store(":memory:"), config, write: out.write, now: fixedNow() }, { beeLoginState })).toBe(0);
    expect(out.text()).toContain("Utterances saved  0");
    expect(out.lines.slice(-2)).toEqual(["  Bee login         could not tell (Bee did not answer)", "  (Bee check failed: Bee did not answer within 15 seconds.)"]);
  });
});
