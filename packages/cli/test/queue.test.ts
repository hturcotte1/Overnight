// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { Store } from "@overnight/core";
import { approvedQueue, PAUSED_QUEUE_NOTE, queue } from "../src/commands/queue.ts";
import { addIdea, at, capture, moveIdea, SAMPLE_IDEAS, testConfig } from "./helpers.ts";

const config = testConfig();

/** Five approved ideas. Heard in the order a, b, c, d, e; approved in the order e, c, a, d, b. */
function fiveApproved(store: Store) {
  const names = ["a", "b", "c", "d", "e"] as const;
  const heard = Object.fromEntries(names.map((name, index) => [name, addIdea(store, { title: `Idea ${name}`, pitch: `Pitch ${name}.`, quote: `quote ${name}` }, at(index * 10))])) as Record<(typeof names)[number], ReturnType<typeof addIdea>>;
  (["e", "c", "a", "d", "b"] as const).forEach((name, index) => moveIdea(store, heard[name], ["asked", "approved"], at(1000 + index * 1000)));
  return heard;
}

describe("overnight queue --approved --json", () => {
  it("prints an empty JSON array when nothing is approved", () => {
    const store = new Store(":memory:");
    addIdea(store, SAMPLE_IDEAS.turns, at(0));
    const out = capture();
    const err = capture();
    expect(queue({ store, config, write: out.write, writeError: err.write })).toBe(0);
    expect(JSON.parse(out.text())).toEqual([]);
    expect(err.lines).toEqual([]);
  });

  it("lists only approved ideas, the longest-approved first, with exactly the agreed fields", () => {
    const store = new Store(":memory:");
    // Heard in this order: turns, plants, chores. Approved in the opposite order.
    const turns = addIdea(store, SAMPLE_IDEAS.turns, at(0));
    const plants = addIdea(store, SAMPLE_IDEAS.plants, at(100));
    const chores = addIdea(store, SAMPLE_IDEAS.chores, at(200));
    const rejected = addIdea(store, { title: "Sock sorter", pitch: "Pairs socks.", quote: "why is there no sock sorter" }, at(300));
    const stillAsked = addIdea(store, { title: "Recipe scaler", pitch: "Scales a recipe.", quote: "someone should build a recipe scaler" }, at(400));
    moveIdea(store, chores, ["asked", "approved"], at(1000));
    moveIdea(store, turns, ["asked", "approved"], at(2000));
    moveIdea(store, rejected, ["asked", "rejected"], at(3000));
    moveIdea(store, stillAsked, ["asked"], at(4000));
    // Approved and then picked up by a build: no longer waiting.
    moveIdea(store, plants, ["asked", "approved", "building"], at(5000));

    const out = capture();
    expect(queue({ store, config, write: out.write })).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.text())).toEqual([
      { id: chores.id, ...SAMPLE_IDEAS.chores, approvedAt: at(1060) },
      { id: turns.id, ...SAMPLE_IDEAS.turns, approvedAt: at(2060) },
    ]);
  });

  it("takes the approval time from the timeline when the idea itself does not carry one", () => {
    const store = new Store(":memory:");
    const idea = addIdea(store, SAMPLE_IDEAS.turns, at(0));
    store.transitionIdea(idea.id, "asked", { todoId: 7 }, at(10));
    store.transitionIdea(idea.id, "approved", {}, at(90));
    expect(approvedQueue(store)).toEqual([{ id: idea.id, ...SAMPLE_IDEAS.turns, approvedAt: at(90) }]);
  });

  it("keeps the order heard for two ideas approved at the same moment", () => {
    const store = new Store(":memory:");
    const first = addIdea(store, SAMPLE_IDEAS.turns, at(0));
    const second = addIdea(store, SAMPLE_IDEAS.plants, at(10));
    for (const idea of [second, first]) {
      store.transitionIdea(idea.id, "asked", { todoId: idea === first ? 1 : 2 }, at(20));
      store.transitionIdea(idea.id, "approved", { answeredAt: at(500) }, at(500));
    }
    expect(approvedQueue(store).map((idea) => idea.id)).toEqual([first.id, second.id]);
  });

  it("hands over nothing while paused, and everything again after resume", () => {
    const store = new Store(":memory:");
    const idea = addIdea(store, SAMPLE_IDEAS.turns, at(0));
    moveIdea(store, idea, ["asked", "approved"], at(100));
    const read = () => {
      const out = capture();
      const err = capture();
      expect(queue({ store, config, write: out.write, writeError: err.write })).toBe(0);
      // Standard output is one JSON array and nothing else, paused or not.
      expect(out.lines).toHaveLength(1);
      return { ideas: JSON.parse(out.text()) as Array<{ id: string }>, notes: err.lines };
    };

    expect(read().ideas.map((queued) => queued.id)).toEqual([idea.id]);

    store.setPaused(true, at(200));
    expect(read()).toEqual({ ideas: [], notes: [PAUSED_QUEUE_NOTE] });
    expect(PAUSED_QUEUE_NOTE).toBe("Overnight is paused: nothing is queued for building.");
    // The idea is still approved: pausing puts nothing off for good.
    expect(store.getIdea(idea.id)?.state).toBe("approved");

    store.setPaused(false, at(300));
    expect(read()).toEqual({ ideas: [expect.objectContaining({ id: idea.id })], notes: [] });
  });

  it("is empty when the setting says 'start paused' and nobody has resumed", () => {
    const store = new Store(":memory:");
    moveIdea(store, addIdea(store, SAMPLE_IDEAS.turns, at(0)), ["asked", "approved"], at(100));
    const out = capture();
    // No writeError given: the note is optional, the empty array is not.
    expect(queue({ store, config: testConfig({ PAUSED: "true" }), write: out.write })).toBe(0);
    expect(JSON.parse(out.text())).toEqual([]);

    store.setPaused(false, at(200));
    const resumed = capture();
    queue({ store, config: testConfig({ PAUSED: "true" }), write: resumed.write });
    expect(JSON.parse(resumed.text())).toHaveLength(1);
  });

  it("hands over at most MAX_BUILDS_PER_NIGHT ideas: the ones approved longest ago", () => {
    const store = new Store(":memory:");
    const heard = fiveApproved(store);
    const idsWithLimit = (limit: string) => {
      const out = capture();
      queue({ store, config: testConfig({ MAX_BUILDS_PER_NIGHT: limit }), write: out.write });
      return (JSON.parse(out.text()) as Array<{ id: string }>).map((queued) => queued.id);
    };

    // The default limit is 2.
    const out = capture();
    queue({ store, config, write: out.write });
    expect((JSON.parse(out.text()) as Array<{ id: string }>).map((queued) => queued.id)).toEqual([heard.e.id, heard.c.id]);

    expect(idsWithLimit("2")).toEqual([heard.e.id, heard.c.id]);
    expect(idsWithLimit("4")).toEqual([heard.e.id, heard.c.id, heard.a.id, heard.d.id]);
    expect(idsWithLimit("10")).toEqual([heard.e.id, heard.c.id, heard.a.id, heard.d.id, heard.b.id]);
    expect(idsWithLimit("0")).toEqual([]);

    // Once the first two are picked up by a build, the next two come up.
    moveIdea(store, store.getIdea(heard.e.id) ?? heard.e, ["building"], at(9000));
    moveIdea(store, store.getIdea(heard.c.id) ?? heard.c, ["building"], at(9000));
    expect(idsWithLimit("2")).toEqual([heard.a.id, heard.d.id]);
  });
});
