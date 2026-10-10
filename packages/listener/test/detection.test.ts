// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it, vi } from "vitest";
import { CURSOR_KEY } from "../src/index.ts";
import { failedRun, HOUR, ideaVerdict, IDEA_LINES, makeRig, MINUTE, notIdeaVerdict, notReady, SECOND, T0 } from "./helpers.ts";

describe("noticing: the detection pass", () => {
  it("waits for the conversation to go quiet", async () => {
    const rig = makeRig();
    for (const line of IDEA_LINES) rig.hear(line);

    rig.clock.advance(rig.options.quietMs - SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(0);
    expect(rig.store.countDetectorRuns()).toBe(0);

    // A new line starts the wait again.
    rig.hear("and it should remember who paid last time");
    rig.clock.advance(rig.options.quietMs - SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(0);

    rig.clock.advance(SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);
    expect(rig.detector.textsOf(0)).toEqual([...IDEA_LINES, "and it should remember who paid last time"]);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
  });

  it("shows the detector text and times only", async () => {
    const rig = makeRig();
    const spokenAt = rig.clock.iso();
    rig.hear("i keep forgetting when the library books are due");
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs[0]).toEqual({ utterances: [{ text: "i keep forgetting when the library books are due", spokenAt }], recentTitles: [] });
  });

  it("sends only the lines heard since its last run", async () => {
    const rig = makeRig();
    rig.hear("the dog needs a walk before it rains this afternoon");
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();

    // Same conversation, a second recording a few minutes later.
    rig.hear("i wish there was a page that told me when to water each plant");
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();

    expect(rig.detector.textsOf(0)).toEqual(["the dog needs a walk before it rains this afternoon"]);
    expect(rig.detector.textsOf(1)).toEqual(["i wish there was a page that told me when to water each plant"]);

    // Nothing new: nothing to do.
    rig.clock.advance(10 * MINUTE);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(2);
    expect(rig.store.countDetectorRuns("not_idea")).toBe(2);
  });

  it("records a batch that is too short without calling the detector", async () => {
    const rig = makeRig();
    rig.hear("okay see you then"); // four words; the default minimum is six
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();

    expect(rig.detector.inputs).toHaveLength(0);
    expect(rig.store.countDetectorRuns("skipped")).toBe(1);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
    expect(rig.logs().find((line) => line.message === "detector run")).toMatchObject({ outcome: "skipped", why: "too short", lines: 1, words: 4 });
  });

  it("sends a batch of exactly the minimum length", async () => {
    const rig = makeRig();
    rig.hear("someone should build a chore wheel"); // six words
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);
  });

  it("records lines that are too old without sending them", async () => {
    const rig = makeRig();
    for (const line of IDEA_LINES) rig.hear(line);
    // The listener was off for the rest of the day and finds these lines when it starts again.
    rig.clock.advance(7 * HOUR);
    await rig.listener.runDetectionPass();

    expect(rig.detector.inputs).toHaveLength(0);
    expect(rig.store.countDetectorRuns("skipped")).toBe(1);
    expect(rig.store.listIdeas()).toEqual([]);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
    expect(rig.logs().find((line) => line.message === "detector run")).toMatchObject({ outcome: "skipped", why: "too old", lines: 2 });
  });

  it("still reads a line the watch delivered hours after it was spoken", async () => {
    const rig = makeRig();
    // Spoken at seven in the morning, delivered at two in the afternoon.
    const spokenAt = new Date(Date.parse(T0) - 7 * HOUR).toISOString();
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 81, conversationUuid: "conv-a", text: "someone should build a tiny app that tracks whose turn it is", spokenAt });
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(ideaVerdict());
    await rig.listener.runDetectionPass();

    expect(rig.detector.inputs[0]?.utterances).toEqual([{ text: "someone should build a tiny app that tracks whose turn it is", spokenAt }]);
    expect(rig.store.countDetectorRuns("skipped")).toBe(0);
    expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]);
  });

  it("but not a backfilled line that was spoken that long ago", async () => {
    // A longer look back than usual, so that the backfill fetches the old line at all.
    const rig = makeRig({ options: { backfillDefaultLookbackMs: 8 * HOUR } });
    rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [
      { beeUtteranceId: 901, text: "someone should build a tiny app that tracks whose turn it is", spokenAt: new Date(Date.parse(T0) - 7 * HOUR).toISOString() },
      { beeUtteranceId: 902, text: "and this was said only a few minutes ago today", spokenAt: new Date(Date.parse(T0) - 5 * MINUTE).toISOString() },
    ]);
    await rig.listener.runBackfill();
    expect(rig.store.countUtterances()).toBe(2);

    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.textsOf(0)).toEqual(["and this was said only a few minutes ago today"]);
    expect(rig.store.countDetectorRuns("skipped")).toBe(1);
  });

  it("sends the newest lines of a long batch and covers all of it", async () => {
    const rig = makeRig({ options: { maxWordsPerRun: 12 } });
    rig.hear("first we talked about the weather for a long while"); // 10 words
    rig.hear("then about the neighbours and their very loud dog"); // 9 words
    rig.hear("and someone should build a parking spot swap board"); // 9 words
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();

    // 9 words fit; 9 + 9 would be over 12.
    expect(rig.detector.textsOf(0)).toEqual(["and someone should build a parking spot swap board"]);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
    expect(rig.logs().find((line) => line.message === "detector run")).toMatchObject({ outcome: "not_idea", lines: 3, words: 28, sentWords: 9 });
  });

  it("tries a failed run again on later passes, then gives up and covers the lines", async () => {
    const rig = makeRig();
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(failedRun(), failedRun(), failedRun("timed out after 90 s"));

    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);

    // Not on the very next pass: a failure gets a minute to clear first.
    rig.clock.advance(rig.options.retryDelayMs - SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);

    rig.clock.advance(SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(2);
    expect(rig.store.countDetectorRuns()).toBe(0);
    expect(rig.store.conversationsAwaitingDetection()).toHaveLength(1);

    rig.clock.advance(rig.options.retryDelayMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(3);
    expect(rig.store.countDetectorRuns("failed")).toBe(1);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
    expect(rig.store.listIdeas()).toEqual([]);

    // Covered now, so no fourth call.
    rig.clock.advance(rig.options.retryDelayMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(3);
  });

  it("uses the answer when a retry works", async () => {
    const rig = makeRig();
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(failedRun(), ideaVerdict());

    await rig.listener.runDetectionPass();
    expect(rig.store.listIdeas()).toEqual([]);
    rig.clock.advance(rig.options.retryDelayMs);
    await rig.listener.runDetectionPass();
    expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]);
    expect(rig.store.countDetectorRuns()).toBe(1);

    // The failure count went with the batch: a later batch gets its full three tries.
    rig.hear("separately, did anyone book the campsite for next weekend");
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(failedRun(), failedRun());
    await rig.listener.runDetectionPass();
    rig.clock.advance(rig.options.retryDelayMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(4);
    expect(rig.store.countDetectorRuns("failed")).toBe(0);
  });

  it("keeps to three tries when a line spoken earlier joins the batch between them", async () => {
    const rig = makeRig();
    rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
    rig.listener.handleEvent({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    rig.clock.advance(MINUTE);
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(failedRun(), failedRun(), failedRun(), failedRun(), failedRun(), failedRun());
    const nextPass = async () => {
      await rig.listener.runDetectionPass();
      rig.clock.advance(rig.options.quietMs);
    };
    await nextPass();
    await nextPass();
    expect(rig.detector.inputs).toHaveLength(2);

    // A backfill now brings a line spoken thirty seconds before the first one we had.
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 901, text: "here is a thought i had on the drive in", spokenAt: new Date(Date.parse(T0) + 30 * SECOND).toISOString() }]);
    await rig.listener.runBackfill();
    rig.clock.advance(rig.options.quietMs);

    for (let pass = 0; pass < 4; pass += 1) await nextPass();
    // The earlier line now leads the batch, and the batch is still the one that has had two tries.
    expect(rig.detector.textsOf(2)).toEqual(["here is a thought i had on the drive in", ...IDEA_LINES]);
    expect(rig.detector.inputs).toHaveLength(3);
    expect(rig.store.countDetectorRuns("failed")).toBe(1);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
  });

  describe("when the detector says it is not ready", () => {
    const notReadyLines = (rig: ReturnType<typeof makeRig>) => rig.logs().filter((line) => line.message === "the detector is not ready; lines are being kept");

    it("records no run, uses up no try, and reads the lines once it is ready", async () => {
      const rig = makeRig();
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      // Far more "not ready" answers than the three tries a batch gets.
      rig.detector.script.push(...Array.from({ length: 8 }, () => notReady()));
      for (let pass = 0; pass < 8; pass += 1) {
        await rig.listener.runDetectionPass();
        rig.clock.advance(rig.options.retryDelayMs);
      }
      expect(rig.detector.inputs).toHaveLength(8);
      expect(rig.store.countDetectorRuns()).toBe(0);
      expect(rig.store.conversationsAwaitingDetection()).toHaveLength(1);

      // Ready now, and it fails twice for real: those are the first two of the three tries.
      rig.detector.script.push(failedRun(), failedRun(), ideaVerdict());
      for (let pass = 0; pass < 3; pass += 1) {
        await rig.listener.runDetectionPass();
        rig.clock.advance(rig.options.retryDelayMs);
      }
      expect(rig.store.countDetectorRuns("failed")).toBe(0);
      expect(rig.store.countDetectorRuns("idea")).toBe(1);
      expect(rig.detector.textsOf(10)).toEqual(IDEA_LINES);
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]);
    });

    it("asks it again no sooner than a minute later, for any conversation", async () => {
      const rig = makeRig();
      rig.hear("someone should build a carpool rota for the swim team", "conv-a");
      rig.hear("i wish there was a site to split the cabin costs", "conv-b");
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(notReady(), notReady());

      // One answer speaks for both conversations: the second is not even sent.
      await rig.listener.runDetectionPass();
      expect(rig.detector.inputs).toHaveLength(1);

      // The passes that follow every ten seconds leave the detector alone.
      for (let pass = 0; pass < 5; pass += 1) {
        rig.clock.advance(10 * SECOND);
        await rig.listener.runDetectionPass();
      }
      expect(rig.detector.inputs).toHaveLength(1);

      rig.clock.advance(rig.options.retryDelayMs - 50 * SECOND);
      await rig.listener.runDetectionPass();
      expect(rig.detector.inputs).toHaveLength(2);
      expect(rig.store.countDetectorRuns()).toBe(0);

      // Ready: both conversations are read on the same pass.
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(rig.detector.inputs).toHaveLength(4);
      expect(rig.store.countDetectorRuns("not_idea")).toBe(2);
    });

    it("says so at most once every ten minutes", async () => {
      const rig = makeRig();
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(...Array.from({ length: 100 }, () => notReady()));

      // Nine and a half minutes of passes, ten seconds apart.
      for (let pass = 0; pass < 57; pass += 1) {
        await rig.listener.runDetectionPass();
        rig.clock.advance(10 * SECOND);
      }
      expect(notReadyLines(rig)).toHaveLength(1);
      expect(notReadyLines(rig)[0]).toMatchObject({ level: "warn", linesWaiting: 2 });

      rig.clock.advance(MINUTE);
      await rig.listener.runDetectionPass();
      expect(notReadyLines(rig)).toHaveLength(2);
      // And nothing else was logged about those calls: no failure, no reason.
      expect(rig.logs().filter((line) => line.level === "warn" || line.level === "error")).toHaveLength(2);
    });

    it("never writes the waiting lines off as too old, however long it takes", async () => {
      const rig = makeRig();
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(notReady(), notReady(), notReady());
      await rig.listener.runDetectionPass();

      // The next day. Other lines have come in since; some waited, one is brand new.
      rig.clock.advance(5 * HOUR);
      rig.hear("and it should remember who paid last time");
      rig.clock.advance(rig.options.quietMs);
      await rig.listener.runDetectionPass();
      rig.clock.advance(20 * HOUR);
      rig.hear("anyway i still think that would be handy");
      rig.clock.advance(rig.options.quietMs);
      await rig.listener.runDetectionPass();
      expect(rig.store.countDetectorRuns()).toBe(0);

      rig.clock.advance(rig.options.retryDelayMs);
      rig.detector.script.push(ideaVerdict());
      await rig.listener.runDetectionPass();
      expect(rig.detector.textsOf(3)).toEqual([...IDEA_LINES, "and it should remember who paid last time", "anyway i still think that would be handy"]);
      expect(rig.store.countDetectorRuns("skipped")).toBe(0);
      expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
    });

    it("keeps lines that turn quiet while it waits to ask the detector again", async () => {
      const rig = makeRig();
      rig.hear("someone should build a carpool rota for the swim team", "conv-a");
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(notReady());
      await rig.listener.runDetectionPass();

      // A second conversation goes quiet during the wait, so the detector never saw it.
      rig.hear("i wish there was a site to split the cabin costs", "conv-b");
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(notReady());
      await rig.listener.runDetectionPass();
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass(); // inside the wait: kept without a call
      expect(rig.detector.inputs).toHaveLength(2);

      rig.clock.advance(7 * HOUR);
      await rig.listener.runDetectionPass();
      expect(rig.detector.inputs).toHaveLength(4);
      expect(rig.store.countDetectorRuns("skipped")).toBe(0);
      expect(rig.store.countDetectorRuns("not_idea")).toBe(2);
    });

    it("still applies the too-old rule to lines that were already too old", async () => {
      const rig = makeRig();
      rig.hear("this was said long before the detector had its trouble");
      rig.clock.advance(7 * HOUR);
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(notReady());
      await rig.listener.runDetectionPass();

      expect(rig.store.countDetectorRuns("skipped")).toBe(1);
      expect(rig.detector.textsOf(0)).toEqual(IDEA_LINES);
    });
  });

  it("treats a detector that throws as one more failed run", async () => {
    const rig = makeRig({ options: { detectorMaxAttempts: 2 } });
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(new Error("kiro went away"), new Error("kiro went away"));

    await expect(rig.listener.runDetectionPass()).resolves.toBeUndefined();
    expect(rig.store.conversationsAwaitingDetection()).toHaveLength(1);
    rig.clock.advance(rig.options.retryDelayMs);
    await expect(rig.listener.runDetectionPass()).resolves.toBeUndefined();
    expect(rig.store.countDetectorRuns("failed")).toBe(1);
  });

  it("stops paying for a batch whose result cannot be saved", async () => {
    const rig = makeRig({ options: { detectorMaxAttempts: 2 } });
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    const record = vi.spyOn(rig.store, "recordDetectorRun").mockImplementation(() => {
      throw new Error("database is locked");
    });

    for (let pass = 0; pass < 5; pass += 1) {
      await rig.listener.runDetectionPass();
      rig.clock.advance(rig.options.retryDelayMs);
    }
    // Two tries, as allowed. After that it only tries to save the failure, without the detector.
    expect(rig.detector.inputs).toHaveLength(2);

    record.mockRestore();
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(2);
    expect(rig.store.countDetectorRuns("failed")).toBe(1);
    expect(rig.store.conversationsAwaitingDetection()).toEqual([]);
  });

  it("records a run but makes no idea when the detector says it is not one", async () => {
    const rig = makeRig();
    rig.hear("the meeting moved to three so lunch has to be early");
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(notIdeaVerdict());
    await rig.listener.runDetectionPass();

    expect(rig.store.countDetectorRuns("not_idea")).toBe(1);
    expect(rig.store.listIdeas()).toEqual([]);
    expect(rig.bee.createCalls).toEqual([]);
  });

  it("tells the detector the titles of the last 14 days of ideas", async () => {
    const rig = makeRig();
    const { key } = rig.store.resolveConversation({ uuid: "conv-old" }, rig.clock.iso());
    const blank = { pitch: "", quote: "", confidence: 0.9, conversationKey: key, detectorRunId: null };
    rig.store.createIdea({ ...blank, title: "Too long ago" }, rig.clock.iso());
    rig.clock.advance(15 * 24 * HOUR);
    rig.store.createIdea({ ...blank, title: "Plant watering tracker" }, rig.clock.iso());
    rig.clock.advance(24 * HOUR);

    rig.hear("i still think that plant thing would be really useful");
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs[0]?.recentTitles).toEqual(["Plant watering tracker"]);
  });

  it("handles each quiet conversation by itself, and leaves the busy one alone", async () => {
    const rig = makeRig();
    rig.hear("someone should build a carpool rota for the swim team", "conv-a");
    rig.clock.advance(SECOND);
    rig.hear("i wish there was a site to split the cabin costs", "conv-b");
    rig.clock.advance(rig.options.quietMs);
    rig.hear("this one is still going on right now", "conv-c");
    rig.detector.script.push(ideaVerdict({ title: "Swim team carpool rota" }), ideaVerdict({ title: "Cabin cost splitter" }));
    await rig.listener.runDetectionPass();

    // Quiet longest goes first.
    expect(rig.detector.textsOf(0)).toEqual(["someone should build a carpool rota for the swim team"]);
    expect(rig.detector.textsOf(1)).toEqual(["i wish there was a site to split the cabin costs"]);
    // Both were made in the same instant of the test clock, so the store may list them either way round.
    const heard = rig.store.listIdeas().map((idea) => `${idea.title}: ${idea.state}`);
    expect(heard.sort()).toEqual(["Cabin cost splitter: asked", "Swim team carpool rota: asked"]);
    expect(rig.store.conversationsAwaitingDetection()).toHaveLength(1);
  });

  it("waits again if a line arrives while another conversation is with the detector", async () => {
    const rig = makeRig();
    rig.hear("someone should build a carpool rota for the swim team", "conv-a");
    rig.clock.advance(SECOND);
    rig.hear("i wish there was a site to split", "conv-b");
    rig.clock.advance(rig.options.quietMs);
    // While conv-a is being read, conv-b carries on talking.
    rig.detector.duringCall = () => {
      rig.detector.duringCall = null;
      rig.hear("the cabin costs between the four of us", "conv-b");
    };
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);

    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    expect(rig.detector.textsOf(1)).toEqual(["i wish there was a site to split", "the cabin costs between the four of us"]);
  });

  it("carries on with the other conversations when one of them goes wrong", async () => {
    const rig = makeRig();
    rig.hear("someone should build a carpool rota for the swim team", "conv-a");
    rig.hear("i wish there was a site to split the cabin costs", "conv-b");
    rig.clock.advance(rig.options.quietMs);
    vi.spyOn(rig.store, "pendingUtterances").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(rig.listener.runDetectionPass()).resolves.toBeUndefined();
    expect(rig.detector.inputs).toHaveLength(1);
    expect(rig.logs().some((line) => line.level === "error" && line.message === "detection failed for one conversation")).toBe(true);
  });

  it("logs a failed pass and works again on the next one", async () => {
    const rig = makeRig();
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    vi.spyOn(rig.store, "conversationsAwaitingDetection").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(rig.listener.runDetectionPass()).resolves.toBeUndefined();
    expect(rig.logs().find((line) => line.level === "error")).toMatchObject({ message: "detection pass failed", error: "database is locked" });

    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);
  });

  it("does not run two passes at once", async () => {
    // No wait between tries, so only the single-flight guard stands between the two calls.
    const rig = makeRig({ options: { retryDelayMs: 0 } });
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(ideaVerdict());
    await Promise.all([rig.listener.runDetectionPass(), rig.listener.runDetectionPass()]);
    expect(rig.detector.inputs).toHaveLength(1);
    expect(rig.bee.createCalls).toHaveLength(1);
  });
});
