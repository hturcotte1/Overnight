// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { BeeError } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { CURSOR_KEY } from "../src/index.ts";
import { runBackfillOnce } from "../src/backfill.ts";
import { HOUR, makeRig, MINUTE, SECOND, T0 } from "./helpers.ts";
import type { Rig } from "./helpers.ts";

const t = (seconds: number) => new Date(Date.parse(T0) + seconds * SECOND).toISOString();

/** A rig that has backfilled before, with one conversation the stream has told us about. */
function rigWithCursor(): Rig {
  const rig = makeRig();
  rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
  rig.listener.handleEvent({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
  return rig;
}

const allLines = (rig: Rig, beeId: number) => {
  const conversation = rig.store.findConversationByBeeId(beeId);
  return conversation ? rig.store.utterancesNear(conversation.key, T0, 24 * HOUR) : [];
};

describe("backfill", () => {
  it("takes only a starting point the first time", async () => {
    const rig = makeRig();
    // With no cursor Bee answers with about a day of history. None of it is processed.
    rig.bee.changedReplies.push({ nextCursor: "cursor-1", conversationIds: [4100, 4200] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 901, text: "yesterday's talk about the fence", spokenAt: T0 }]);
    await rig.listener.runBackfill();

    expect(rig.bee.changedCalls).toEqual([null]);
    expect(rig.bee.transcriptCalls).toEqual([]);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
    expect(rig.store.countUtterances()).toBe(0);
  });

  it("adds the lines the stream missed and skips the ones it already has", async () => {
    const rig = rigWithCursor();
    rig.hear("we should plan the camping trip soon"); // spoken at 0 s
    rig.clock.advance(5 * SECOND);
    rig.hear("i can bring the big tent"); // spoken at 5 s
    // The stream drops here. Two more lines are spoken, and one from earlier is repeated word for word.
    rig.clock.advance(55 * SECOND);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [
      { beeUtteranceId: 901, text: "We should plan the camping trip soon.", spokenAt: t(0) },
      { beeUtteranceId: 902, text: "I can bring the big tent", spokenAt: t(7) }, // two seconds off, same line
      { beeUtteranceId: 903, text: "someone should build a packing list we can all tick off", spokenAt: t(20) },
      { beeUtteranceId: 904, text: "so nobody brings three stoves again", spokenAt: t(26) },
      { beeUtteranceId: 905, text: "i can bring the big tent", spokenAt: t(40) }, // said again later: a new line
    ]);
    await rig.listener.runBackfill();

    expect(rig.bee.changedCalls).toEqual(["cursor-1"]);
    // From a minute before the newest line we had.
    expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: Date.parse(t(5)) - MINUTE }]);
    expect(allLines(rig, 4100).map((line) => [line.source, line.beeUtteranceId, line.text])).toEqual([
      ["stream", 5000, "we should plan the camping trip soon"],
      ["stream", 5001, "i can bring the big tent"],
      ["backfill", 903, "someone should build a packing list we can all tick off"],
      ["backfill", 904, "so nobody brings three stoves again"],
      ["backfill", 905, "i can bring the big tent"],
    ]);
    expect(allLines(rig, 4100).at(-1)).toMatchObject({ spokenAt: t(40), receivedAt: rig.clock.iso(), detectorRunId: null });
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2");
    expect(rig.logs().find((line) => line.message === "backfill done")).toMatchObject({ conversations: 1, added: 3, repeats: 2, gone: 0 });
  });

  it("treats a line with a few words transcribed differently as the same line", async () => {
    const rig = rigWithCursor();
    rig.hear("i think the garden needs water again by friday morning");
    rig.clock.advance(MINUTE);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [
      { beeUtteranceId: 901, text: "I think the garden needs water again by Friday evening.", spokenAt: t(1) },
      { beeUtteranceId: 902, text: "the hose is behind the shed", spokenAt: t(2) }, // close in time, different words
    ]);
    await rig.listener.runBackfill();
    expect(allLines(rig, 4100).map((line) => line.text)).toEqual(["i think the garden needs water again by friday morning", "the hose is behind the shed"]);
  });

  it("fetches the last six hours of a conversation it has no lines for", async () => {
    const rig = rigWithCursor();
    rig.clock.advance(10 * MINUTE);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4700] });
    rig.bee.transcripts.set(4700, [{ beeUtteranceId: 950, text: "i wish there was a page for whose turn it is to drive", spokenAt: t(300) }]);
    await rig.listener.runBackfill();

    expect(rig.bee.transcriptCalls).toEqual([{ id: 4700, sinceMs: rig.clock.now().getTime() - 6 * HOUR }]);
    expect(rig.store.findConversationByBeeId(4700)).toMatchObject({ beeId: 4700, uuid: null });
    expect(allLines(rig, 4700).map((line) => line.source)).toEqual(["backfill"]);
  });

  it("joins a backfilled conversation with its stream lines once Bee names both ids", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4700] });
    rig.bee.transcripts.set(4700, [{ beeUtteranceId: 950, text: "we never did fix the gate latch", spokenAt: t(10) }]);
    await rig.listener.runBackfill();
    rig.clock.advance(30 * SECOND);
    rig.hear("i will pick up a new latch on saturday", "conv-b");
    rig.listener.handleEvent({ type: "conversation", kind: "update", beeId: 4700, uuid: "conv-b", state: "CAPTURING", startTime: T0, endTime: null });

    expect(allLines(rig, 4700).map((line) => line.text)).toEqual(["we never did fix the gate latch", "i will pick up a new latch on saturday"]);
  });

  it("recognises lines it already holds under the conversation's other id", async () => {
    const rig = rigWithCursor();
    // The stream named this conversation by uuid. Bee has not yet said which number goes with it,
    // so the backfill, which only knows the number, starts a second row for it.
    rig.hear("we never did fix the gate latch", "conv-b"); // spoken at 0 s
    rig.clock.advance(5 * SECOND);
    rig.hear("i will pick up a new latch on saturday", "conv-b"); // spoken at 5 s
    rig.clock.advance(MINUTE);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4700] });
    rig.bee.transcripts.set(4700, [
      { beeUtteranceId: 950, text: "We never did fix the gate latch.", spokenAt: t(1) },
      { beeUtteranceId: 951, text: "I will pick up a new latch on Saturday.", spokenAt: t(5) },
      { beeUtteranceId: 952, text: "someone should build a list of jobs around the house", spokenAt: t(30) },
    ]);
    await rig.listener.runBackfill();

    expect(rig.store.countUtterances()).toBe(3);
    expect(rig.logs().find((line) => line.message === "backfill done")).toMatchObject({ added: 1, repeats: 2 });

    // Bee names both ids: the rows join, and every line is there once.
    rig.listener.handleEvent({ type: "conversation", kind: "update", beeId: 4700, uuid: "conv-b", state: "CAPTURING", startTime: T0, endTime: null });
    expect(allLines(rig, 4700).map((line) => [line.source, line.text])).toEqual([
      ["stream", "we never did fix the gate latch"],
      ["stream", "i will pick up a new latch on saturday"],
      ["backfill", "someone should build a list of jobs around the house"],
    ]);
  });

  it("skips a conversation Bee no longer has, and still moves on", async () => {
    const rig = rigWithCursor();
    rig.hear("a short one that bee threw away");
    rig.clock.advance(7 * MINUTE);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100, 4700] });
    rig.bee.transcripts.set(4100, null);
    rig.bee.transcripts.set(4700, [{ beeUtteranceId: 950, text: "the other conversation is still there", spokenAt: t(400) }]);
    await rig.listener.runBackfill();

    // Our own copy of the vanished conversation is untouched.
    expect(allLines(rig, 4100).map((line) => line.text)).toEqual(["a short one that bee threw away"]);
    expect(allLines(rig, 4700)).toHaveLength(1);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2");
    expect(rig.logs().find((line) => line.message === "backfill done")).toMatchObject({ gone: 1, added: 1 });
  });

  it("keeps the old cursor when Bee cannot say what changed", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push(new BeeError("timeout", "bee changed took longer than 30 s"));
    await expect(rig.listener.runBackfill()).resolves.toBeUndefined();

    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
    expect(rig.logs().find((line) => line.level === "warn")).toMatchObject({ message: "backfill failed; keeping the old cursor", kind: "timeout" });
  });

  it("logs only the type of an error that is not Bee's own, never its message", async () => {
    // These two replies hold whole transcripts, and a parse error can quote what it choked on.
    const rig = rigWithCursor();
    rig.bee.changedReplies.push(new SyntaxError("Unexpected token in: the plumber is coming on tuesday"), { nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, new TypeError("cannot read the walrus said it was time to go"));
    await rig.listener.runBackfill();
    await rig.listener.runBackfill();

    const warnings = rig.logs().filter((line) => line.level === "warn");
    expect(warnings.map((line) => [line.message, line.kind, line.errorName])).toEqual([
      ["backfill failed; keeping the old cursor", "unexpected", "SyntaxError"],
      ["backfill failed; keeping the old cursor", "unexpected", "TypeError"],
    ]);
    for (const line of warnings) expect(line).not.toHaveProperty("error");
    const log = rig.logText.join("\n");
    for (const word of ["plumber", "tuesday", "walrus"]) expect(log).not.toContain(word);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
  });

  it("stops after the Bee call in progress when told to, writes nothing more, and counts that as not caught up", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100, 4700] }, { nextCursor: "cursor-2", conversationIds: [4100, 4700] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 901, text: "the first conversation came through fine", spokenAt: t(10) }]);
    rig.bee.transcripts.set(4700, [{ beeUtteranceId: 950, text: "the second one was never asked for", spokenAt: t(20) }]);
    rig.clock.advance(MINUTE);
    // "Stop" arrives while the first transcript is being fetched.
    let stop = false;
    const fetch = rig.bee.transcriptSince.bind(rig.bee);
    rig.bee.transcriptSince = async (id, sinceMs) => {
      stop = true;
      return fetch(id, sinceMs);
    };
    const caughtUp = await runBackfillOnce(rig.ctx, null, () => stop);

    expect(caughtUp).toBe(false);
    expect(rig.bee.transcriptCalls.map((call) => call.id)).toEqual([4100]);
    expect(rig.store.countUtterances()).toBe(0);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");

    // Nothing is lost by that: the next run starts from the same cursor and fetches both.
    stop = false;
    rig.bee.transcriptSince = fetch;
    expect(await runBackfillOnce(rig.ctx)).toBe(true);
    expect(rig.store.countUtterances()).toBe(2);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2");
  });

  it("fetches no transcript if told to stop while Bee was still saying what changed", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100, 4700] });
    expect(await runBackfillOnce(rig.ctx, null, () => true)).toBe(false);
    expect(rig.bee.changedCalls).toEqual(["cursor-1"]);
    expect(rig.bee.transcriptCalls).toEqual([]);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
    // No row was started for a conversation it never got to.
    expect(rig.store.findConversationByBeeId(4700)).toBeNull();
  });

  it("does not even save the starting point if told to stop during the very first run", async () => {
    const rig = makeRig();
    rig.bee.changedReplies.push({ nextCursor: "cursor-1", conversationIds: [] });
    expect(await runBackfillOnce(rig.ctx, null, () => true)).toBe(false);
    expect(rig.store.getValue(CURSOR_KEY)).toBeNull();
  });

  it("keeps the old cursor when one transcript fails, then finishes the job next time without repeats", async () => {
    const rig = rigWithCursor();
    rig.clock.advance(MINUTE);
    const first = [{ beeUtteranceId: 901, text: "the first conversation came through fine", spokenAt: t(10) }];
    const second = [{ beeUtteranceId: 950, text: "the second one took two tries", spokenAt: t(20) }];
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100, 4700] }, { nextCursor: "cursor-2", conversationIds: [4100, 4700] });
    rig.bee.transcripts.set(4100, first);
    rig.bee.transcripts.set(4700, new BeeError("failed", "bee exited with code 1"));
    await rig.listener.runBackfill();

    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
    expect(rig.store.countUtterances()).toBe(1);

    rig.bee.transcripts.set(4700, second);
    await rig.listener.runBackfill();
    expect(rig.bee.changedCalls).toEqual(["cursor-1", "cursor-1"]);
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2");
    expect(rig.store.countUtterances()).toBe(2);
  });

  it("keeps the old cursor when Bee sends no new one", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push({ nextCursor: null, conversationIds: [] });
    await rig.listener.runBackfill();
    expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
  });

  it("says whether it caught up, so a failed one can be tried again", async () => {
    const fresh = makeRig();
    fresh.bee.changedReplies.push({ nextCursor: "cursor-1", conversationIds: [4100] });
    expect(await runBackfillOnce(fresh.ctx)).toBe(true); // the first run: nothing more to fetch

    const rig = rigWithCursor();
    rig.bee.changedReplies.push(new BeeError("failed", "bee exited with code 1"), { nextCursor: null, conversationIds: [] }, { nextCursor: "cursor-2", conversationIds: [] });
    expect(await runBackfillOnce(rig.ctx)).toBe(false);
    expect(await runBackfillOnce(rig.ctx)).toBe(true);
    expect(await runBackfillOnce(rig.ctx)).toBe(true);
  });

  it("drops a line whose time cannot be read", async () => {
    const rig = rigWithCursor();
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 901, text: "when was this even said", spokenAt: "" }]);
    // The fake filters by time like Bee does, so hand this one over unfiltered.
    rig.bee.transcriptSince = async () => rig.bee.transcripts.get(4100) as never;
    await rig.listener.runBackfill();
    expect(rig.store.countUtterances()).toBe(0);
    expect(rig.logs().find((line) => line.message === "backfill done")).toMatchObject({ unreadable: 1 });
  });

  it("hands backfilled lines to the next detection pass, in spoken order with the rest", async () => {
    const rig = rigWithCursor();
    rig.hear("we should plan the camping trip soon");
    rig.clock.advance(MINUTE);
    rig.hear("anyway that is the plan for the weekend"); // spoken at 60 s, after the stream came back
    rig.clock.advance(30 * SECOND);
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 903, text: "someone should build a packing list we can all tick off", spokenAt: t(20) }]);
    await rig.listener.runBackfill();

    // The stream lines have now been quiet for long enough, but the backfilled line counts as
    // just received, so the wait starts over from the backfill.
    rig.clock.advance(rig.options.quietMs - 30 * SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(0);
    rig.clock.advance(30 * SECOND);
    await rig.listener.runDetectionPass();
    expect(rig.detector.textsOf(0)).toEqual([
      "we should plan the camping trip soon",
      "someone should build a packing list we can all tick off",
      "anyway that is the plan for the weekend",
    ]);
  });

  describe("how far back it fetches after a gap", () => {
    // The stream drops at 10 s and is back at 200 s. A line spoken at 60 s was missed, and a
    // live line (spoken at 195 s) reaches us before the backfill gets going.
    function afterAGap(): Rig {
      const rig = rigWithCursor();
      rig.hear("before the gap we talked about the fence");
      rig.clock.advance(195 * SECOND);
      const spokenAt = rig.clock.iso();
      rig.clock.advance(5 * SECOND);
      rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 5100, conversationUuid: "conv-a", text: "after the gap we are on to dinner plans", spokenAt });
      rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
      rig.bee.transcripts.set(4100, [
        { beeUtteranceId: 901, text: "before the gap we talked about the fence", spokenAt: t(0) },
        { beeUtteranceId: 902, text: "someone should build a fence cost calculator", spokenAt: t(60) },
        { beeUtteranceId: 903, text: "after the gap we are on to dinner plans", spokenAt: t(195) },
      ]);
      return rig;
    }

    it("starts from the last line received before the gap, not from a line that arrived after it", async () => {
      const rig = afterAGap();
      const caughtUp = await runBackfillOnce(rig.ctx, new Date(t(10)));

      expect(caughtUp).toBe(true);
      expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: Date.parse(t(0)) - MINUTE }]);
      expect(allLines(rig, 4100).map((line) => [line.source, line.text])).toEqual([
        ["stream", "before the gap we talked about the fence"],
        ["backfill", "someone should build a fence cost calculator"],
        ["stream", "after the gap we are on to dinner plans"],
      ]);
    });

    it("with no gap known, starts from the newest line", async () => {
      const rig = afterAGap();
      await runBackfillOnce(rig.ctx, null);
      expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: Date.parse(t(195)) - MINUTE }]);
    });

    it("fetches six hours back when every line it has arrived after the gap", async () => {
      const rig = afterAGap();
      await runBackfillOnce(rig.ctx, new Date(Date.parse(T0) - MINUTE));
      expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: rig.clock.now().getTime() - 6 * HOUR }]);
      // The lines it already had are recognised; only the missed one is added.
      expect(allLines(rig, 4100)).toHaveLength(3);
    });
  });
});
