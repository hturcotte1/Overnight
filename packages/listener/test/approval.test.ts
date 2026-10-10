// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { BeeError } from "@overnight/core";
import type { Idea } from "@overnight/core";
import { describe, expect, it, vi } from "vitest";
import { hearAndDetect, HOUR, ideaVerdict, makeRig, MINUTE, SECOND } from "./helpers.ts";
import type { Rig } from "./helpers.ts";

/** The 11 pm cutoff in Boise on Oct 9, 2026. */
const CUTOFF = "2026-10-10T05:00:00.000Z";

async function askedIdea(rig: Rig, title = "Whose turn to pay", uuid = "conv-a"): Promise<Idea> {
  await hearAndDetect(rig, ideaVerdict({ title }), uuid);
  const idea = rig.store.listIdeas().find((candidate) => candidate.title === title);
  expect(idea?.state).toBe("asked");
  return idea!;
}

describe("tracking the answer: the approval pass", () => {
  it("approves when the to-do was ticked", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.clock.advance(5 * MINUTE);
    rig.bee.todos.set(idea.todoId!, "completed");
    await rig.listener.runApprovalPass();

    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "approved", answeredAt: rig.clock.iso(), note: "ticked in Bee", todoId: idea.todoId });
    expect(rig.store.ideaEvents(idea.id).at(-1)).toMatchObject({ fromState: "asked", toState: "approved", note: "ticked in Bee" });
  });

  it("rejects when the to-do was deleted", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.bee.todos.set(idea.todoId!, "deleted");
    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "rejected", note: "deleted in Bee" });
  });

  it("keeps waiting while the to-do is open, and expires it at the cutoff", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);

    rig.clock.set("2026-10-10T04:59:59.000Z");
    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "asked", note: null });

    rig.clock.set(CUTOFF);
    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "expired", note: "no answer by the cutoff", answeredAt: null });

    // Finished: it is not checked again.
    const checks = rig.bee.statusCalls.length;
    await rig.listener.runApprovalPass();
    expect(rig.bee.statusCalls).toHaveLength(checks);
  });

  it("counts a tick made just before the cutoff, even when it is read after it", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.bee.todos.set(idea.todoId!, "completed");
    rig.clock.set("2026-10-10T05:00:30.000Z");
    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(idea.id)?.state).toBe("approved");
  });

  it("leaves the ask alone when Bee cannot be reached, even past the cutoff", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.bee.todos.set(idea.todoId!, new BeeError("timeout", "bee todos get took longer than 20 s"));
    rig.clock.set("2026-10-10T07:00:00.000Z");
    await rig.listener.runApprovalPass();

    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "asked", note: null });
    expect(rig.logs().find((line) => line.message === "could not check an ask; will try again")).toMatchObject({ level: "warn", ideaId: idea.id, kind: "timeout" });

    // Bee is back and the to-do had been ticked all along.
    rig.bee.todos.set(idea.todoId!, "completed");
    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(idea.id)?.state).toBe("approved");
  });

  it("carries on with the other asks after an error that is not about the login", async () => {
    const rig = makeRig();
    const first = await askedIdea(rig, "Chore wheel", "conv-a");
    rig.clock.advance(HOUR);
    const second = await askedIdea(rig, "Parking spot swap board", "conv-b");
    rig.bee.todos.set(first.todoId!, new Error("something unexpected"));
    rig.bee.todos.set(second.todoId!, "completed");
    await expect(rig.listener.runApprovalPass()).resolves.toBeUndefined();

    expect(rig.store.getIdea(first.id)?.state).toBe("asked");
    expect(rig.store.getIdea(second.id)?.state).toBe("approved");
  });

  it("stops the pass with one clear error when Bee is logged out", async () => {
    const rig = makeRig();
    const first = await askedIdea(rig, "Chore wheel", "conv-a");
    rig.clock.advance(HOUR);
    const second = await askedIdea(rig, "Parking spot swap board", "conv-b");
    rig.bee.todos.set(first.todoId!, new BeeError("logged-out", "Bee is not logged in"));
    rig.bee.todos.set(second.todoId!, "completed");
    await rig.listener.runApprovalPass();

    expect(rig.bee.statusCalls).toEqual([first.todoId]);
    expect(rig.store.getIdea(first.id)?.state).toBe("asked");
    expect(rig.store.getIdea(second.id)?.state).toBe("asked");
    const errors = rig.logs().filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Bee is logged out");
    expect(errors[0]?.message).toContain("node spikes/00-bee-login.ts");
  });

  it("checks right away when the stream says our to-do was deleted", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.bee.todos.set(idea.todoId!, "deleted");
    rig.clock.advance(3 * SECOND);
    rig.listener.handleEvent({ type: "todo-deleted", todoId: idea.todoId! });
    await rig.settle();

    expect(rig.bee.statusCalls).toEqual([idea.todoId]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "rejected", note: "deleted in Bee", answeredAt: rig.clock.iso() });
  });

  it("does not take the stream's word for it: the to-do itself decides", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    // The event arrives but Bee cannot be asked just now. The ask must stay open.
    rig.bee.todos.set(idea.todoId!, new BeeError("timeout", "bee todos get took longer than 20 s"));
    rig.listener.handleEvent({ type: "todo-deleted", todoId: idea.todoId! });
    await rig.settle();
    expect(rig.store.getIdea(idea.id)?.state).toBe("asked");
  });

  it("settles an ask once when the event and the pass both see the answer", async () => {
    const rig = makeRig();
    const idea = await askedIdea(rig);
    rig.bee.todos.set(idea.todoId!, "deleted");
    rig.listener.handleEvent({ type: "todo-deleted", todoId: idea.todoId! });
    await Promise.all([rig.listener.runApprovalPass(), rig.settle()]);

    expect(rig.store.getIdea(idea.id)?.state).toBe("rejected");
    expect(rig.store.ideaEvents(idea.id).filter((event) => event.toState === "rejected")).toHaveLength(1);
    expect(rig.logs().filter((line) => line.level === "error")).toEqual([]);
  });

  it("carries on when recording one answer fails", async () => {
    const rig = makeRig();
    const first = await askedIdea(rig, "Chore wheel", "conv-a");
    rig.clock.advance(HOUR);
    const second = await askedIdea(rig, "Parking spot swap board", "conv-b");
    rig.bee.todos.set(first.todoId!, "completed");
    rig.bee.todos.set(second.todoId!, "completed");
    vi.spyOn(rig.store, "transitionIdea").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(rig.listener.runApprovalPass()).resolves.toBeUndefined();
    expect(rig.store.getIdea(first.id)?.state).toBe("asked");
    expect(rig.store.getIdea(second.id)?.state).toBe("approved");

    await rig.listener.runApprovalPass();
    expect(rig.store.getIdea(first.id)?.state).toBe("approved");
  });
});
