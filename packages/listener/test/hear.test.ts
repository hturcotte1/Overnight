// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it, vi } from "vitest";
import { CURSOR_KEY } from "../src/index.ts";
import { hearAndDetect, ideaVerdict, makeRig, MINUTE, SECOND, T0 } from "./helpers.ts";

const t = (seconds: number) => new Date(Date.parse(T0) + seconds * SECOND).toISOString();

describe("hearing: stream events", () => {
  it("saves a line the moment it arrives", () => {
    const rig = makeRig();
    rig.clock.advance(4 * SECOND);
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 71, conversationUuid: "conv-a", text: "the bins go out on thursday", spokenAt: T0 });

    const waiting = rig.store.conversationsAwaitingDetection();
    expect(waiting).toHaveLength(1);
    const [saved] = rig.store.pendingUtterances(waiting[0]!.conversationKey);
    expect(saved).toMatchObject({ beeUtteranceId: 71, text: "the bins go out on thursday", spokenAt: T0, receivedAt: rig.clock.iso(), source: "stream", detectorRunId: null });
  });

  it("ignores a line it already has", () => {
    const rig = makeRig();
    const event = { type: "utterance", beeUtteranceId: 72, conversationUuid: "conv-a", text: "did you feed the cat", spokenAt: T0 } as const;
    rig.listener.handleEvent(event);
    rig.listener.handleEvent(event);
    rig.listener.handleEvent({ ...event, beeUtteranceId: 73, text: "i fed her at seven" });
    expect(rig.store.countUtterances()).toBe(2);
  });

  it("does not store a line again when the stream delivers it after a backfill fetched it", async () => {
    const rig = makeRig();
    rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
    rig.clock.advance(MINUTE);
    // The backfill only knows the conversation's number; the stream will name it by uuid.
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4700] });
    rig.bee.transcripts.set(4700, [
      { beeUtteranceId: 950, text: "Someone should build a packing list we can all tick off.", spokenAt: t(10) },
      { beeUtteranceId: 951, text: "So nobody brings three stoves again.", spokenAt: t(16) },
    ]);
    await rig.listener.runBackfill();
    expect(rig.store.countUtterances()).toBe(2);

    // The stream catches up: the same two lines, with its own ids and its own idea of the second.
    const late = (beeUtteranceId: number, text: string, spokenAt: string) => rig.listener.handleEvent({ type: "utterance", beeUtteranceId, conversationUuid: "conv-b", text, spokenAt });
    late(7001, "someone should build a packing list we can all tick off", t(11));
    late(7002, "so nobody brings three stoves again", t(14));
    expect(rig.store.countUtterances()).toBe(2);
    expect(rig.logs().filter((line) => line.message === "line received").map((line) => [line.saved, line.why])).toEqual([
      [false, "already backfilled"],
      [false, "already backfilled"],
    ]);

    // Different words at the same moment are a line of their own, and so are the same words said later.
    late(7003, "the hose is behind the shed", t(11));
    late(7004, "so nobody brings three stoves again", t(45));
    expect(rig.store.countUtterances()).toBe(4);
  });

  it("stores two stream lines that read alike: only a backfilled copy makes a line a repeat", () => {
    const rig = makeRig();
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 76, conversationUuid: "conv-a", text: "no no no", spokenAt: T0 });
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 77, conversationUuid: "conv-a", text: "no no no", spokenAt: T0 });
    expect(rig.store.countUtterances()).toBe(2);
  });

  it("stores every time in the same full format, whatever precision Bee sent", () => {
    const rig = makeRig();
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 74, conversationUuid: "conv-a", text: "one second precision", spokenAt: "2026-10-09T19:59:58Z" });
    rig.listener.handleEvent({ type: "utterance", beeUtteranceId: 75, conversationUuid: "conv-a", text: "no usable time at all", spokenAt: "garbled" });
    const key = rig.store.conversationsAwaitingDetection()[0]!.conversationKey;
    expect(rig.store.pendingUtterances(key).map((line) => line.spokenAt)).toEqual(["2026-10-09T19:59:58.000Z", rig.clock.iso()]);
  });

  it("joins the two ids Bee uses for one conversation", () => {
    const rig = makeRig();
    rig.hear("we are out of coffee filters again");
    rig.listener.handleEvent({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    rig.listener.handleEvent({ type: "conversation", kind: "update", beeId: 4100, uuid: "conv-a", state: "PROCESSING", startTime: T0, endTime: "2026-10-09T20:09:00.000Z" });

    const conversation = rig.store.findConversationByBeeId(4100);
    expect(conversation).toMatchObject({ uuid: "conv-a", beeId: 4100, state: "PROCESSING", endTime: "2026-10-09T20:09:00.000Z", deleted: false });
    expect(rig.store.pendingUtterances(conversation!.key)).toHaveLength(1);
  });

  it("keeps the lines and the idea when Bee deletes the conversation", async () => {
    const rig = makeRig();
    rig.listener.handleEvent({ type: "conversation", kind: "new", beeId: 4200, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    await hearAndDetect(rig, ideaVerdict());
    const [idea] = rig.store.listIdeas();
    expect(idea?.state).toBe("asked");

    rig.clock.advance(4 * MINUTE);
    rig.listener.handleEvent({ type: "conversation", kind: "delete", beeId: 4200, uuid: "conv-a", state: "PROCESSING", startTime: T0, endTime: rig.clock.iso() });

    expect(rig.store.findConversationByBeeId(4200)?.deleted).toBe(true);
    expect(rig.store.countUtterances()).toBe(2);
    expect(rig.store.getIdea(idea!.id)?.state).toBe("asked");
  });

  it("still runs the detector on lines whose conversation Bee deleted first", async () => {
    const rig = makeRig();
    rig.hear("someone should build a page that picks who does the dishes tonight");
    rig.listener.handleEvent({ type: "conversation", kind: "delete", beeId: 4300, uuid: "conv-a", state: "PROCESSING", startTime: T0, endTime: T0 });
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(ideaVerdict({ title: "Dishes picker" }));
    await rig.listener.runDetectionPass();
    expect(rig.detector.inputs).toHaveLength(1);
    expect(rig.store.listIdeas().map((idea) => idea.title)).toEqual(["Dishes picker"]);
  });

  it("never throws, whatever the store does", () => {
    const rig = makeRig();
    vi.spyOn(rig.store, "insertUtterance").mockImplementation(() => {
      throw new Error("disk is full");
    });
    expect(() => rig.hear("this line cannot be saved")).not.toThrow();
    expect(() => rig.listener.handleEvent({ type: "connected" })).not.toThrow();
    expect(() => rig.listener.handleEvent(null as never)).not.toThrow();
    const errors = rig.logs().filter((line) => line.level === "error");
    expect(errors.map((line) => line.message)).toEqual(["could not handle a Bee event", "could not handle a Bee event"]);
    expect(errors[0]).toMatchObject({ type: "utterance", error: "disk is full" });
  });

  it("ignores deleted to-dos that are not ours", async () => {
    const rig = makeRig();
    rig.listener.handleEvent({ type: "todo-deleted", todoId: 31337 });
    await rig.settle();
    expect(rig.bee.statusCalls).toEqual([]);
  });
});
