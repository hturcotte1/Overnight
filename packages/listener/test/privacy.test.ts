// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The rule under test: log lines carry ids, counts, states and durations, never what was said.
import { BeeError } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { CURSOR_KEY } from "../src/index.ts";
import { failedRun, ideaVerdict, makeRig, MINUTE, notIdeaVerdict, notReady, SECOND, T0 } from "./helpers.ts";

const SPOKEN = [
  "you know what, someone should build a zebra-striped lunch ledger",
  "that tracks whose turn it is to pay at the noodle place",
  "meanwhile the marmalade delivery is late again this week",
  "and the accordion lessons moved to thursday evenings",
];
const BACKFILLED = "the trombone recital got pushed to the fourteenth";
const PITCH = "A pocket ledger that settles whose turn it is to buy the noodles.";
const QUOTE = "someone should build a zebra-striped lunch ledger";
const MODEL_REASON = "the speaker wishes for a ledger app while discussing noodles";

describe("what reaches the log", () => {
  it("is never the words that were spoken, the title, the quote, the pitch or the model's reasoning", async () => {
    // Debug level, so this covers the lines production would drop too.
    const rig = makeRig();
    rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
    const verdict = ideaVerdict({ title: "Lunch ledger", pitch: PITCH, quote: QUOTE, reason: MODEL_REASON });

    // Heard, a detector that is not ready, a failed detector run, then an idea that is asked
    // about after Bee refused the to-do once.
    rig.listener.handleEvent({ type: "connected" });
    rig.listener.handleEvent({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    rig.hear(SPOKEN[0]!);
    rig.hear(SPOKEN[1]!);
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(notReady(`not ready, was given: ${SPOKEN[0]}`), failedRun(`could not parse: ${SPOKEN[0]}`), verdict);
    rig.bee.createErrors.push(new BeeError("failed", "bee exited with code 1"));
    for (let pass = 0; pass < 4; pass += 1) {
      await rig.listener.runDetectionPass();
      rig.clock.advance(rig.options.retryDelayMs);
    }

    // A second conversation: not an idea, then one too short, then one given up on.
    rig.hear(SPOKEN[2]!, "conv-b");
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push({ ...notIdeaVerdict(), reason: MODEL_REASON });
    await rig.listener.runDetectionPass();
    rig.hear("marmalade again", "conv-b");
    rig.clock.advance(rig.options.quietMs);
    await rig.listener.runDetectionPass();
    rig.hear(SPOKEN[3]!, "conv-b");
    rig.clock.advance(rig.options.quietMs);
    rig.detector.script.push(failedRun(`gave back prose: ${SPOKEN[3]}`), failedRun(`gave back prose: ${SPOKEN[3]}`), failedRun(`gave back prose: ${SPOKEN[3]}`));
    for (let pass = 0; pass < 3; pass += 1) {
      await rig.listener.runDetectionPass();
      rig.clock.advance(rig.options.retryDelayMs);
    }

    // A backfill that breaks on something that is not Bee's own error, and one that adds a line.
    // Then the stream delivers that line late, an approval pass fails and one works.
    rig.bee.changedReplies.push(new SyntaxError(`Unexpected token in: ${BACKFILLED}`));
    await rig.listener.runBackfill();
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 901, text: BACKFILLED, spokenAt: rig.clock.iso() }]);
    await rig.listener.runBackfill();
    rig.hear(BACKFILLED);
    rig.bee.todos.set(9001, new BeeError("failed", "bee exited with code 1"));
    await rig.listener.runApprovalPass();
    rig.bee.todos.set(9001, "completed");
    rig.clock.advance(MINUTE + SECOND);
    await rig.listener.runApprovalPass();

    // The scenario really did all of that.
    expect(rig.store.listIdeas().map((idea) => [idea.title, idea.state])).toEqual([["Lunch ledger", "approved"]]);
    expect(rig.store.countDetectorRuns("failed")).toBe(1);
    expect(rig.store.countUtterances()).toBe(6);
    expect(rig.logText.length).toBeGreaterThan(15);

    const log = rig.logText.join("\n").toLowerCase();
    for (const secret of [...SPOKEN, BACKFILLED, PITCH, QUOTE, MODEL_REASON, "marmalade again"]) {
      expect(log).not.toContain(secret.toLowerCase());
    }
    // No stray fragment either: these words appear only in what was said.
    for (const word of ["zebra", "noodle", "marmalade", "accordion", "trombone"]) expect(log).not.toContain(word);
    // Nor the title: the model words it from what was said, so it could hold a name. Ids only.
    for (const word of ["lunch", "ledger"]) expect(log).not.toContain(word);
    for (const line of rig.logs()) expect(line).not.toHaveProperty("title");
    // The lines about the idea are still there, by id.
    const ideaId = rig.store.listIdeas()[0]!.id;
    expect(rig.logs().filter((line) => line.ideaId === ideaId).map((line) => line.message)).toEqual([
      "idea heard",
      "could not create the ask to-do",
      "asked on the wrist",
      "could not check an ask; will try again",
      "ask approved",
    ]);
    // The scenario reached the branches it was written for.
    const messages = rig.logs().map((line) => line.message);
    for (const expected of ["the detector is not ready; lines are being kept", "detector run failed; will try again", "backfill failed; keeping the old cursor", "backfill done"]) {
      expect(messages).toContain(expected);
    }
    expect(rig.logs().filter((line) => line.message === "line received" && line.why === "already backfilled")).toHaveLength(1);
  });
});
