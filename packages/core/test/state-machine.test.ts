import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, IDEA_STATES, InvalidTransitionError, isTerminal, nextStates } from "../src/index.ts";

describe("idea state machine", () => {
  it("follows the happy path from heard to delivered", () => {
    const path = ["heard", "asked", "approved", "building", "built", "published", "delivered"] as const;
    for (let i = 0; i < path.length - 1; i += 1) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it("lets an ask end three ways", () => {
    expect(nextStates("asked")).toEqual(["approved", "rejected", "expired"]);
  });

  it("never builds without approval", () => {
    for (const state of IDEA_STATES) {
      if (state === "approved" || state === "build_failed") continue;
      expect(canTransition(state, "building")).toBe(false);
    }
  });

  it("refuses a jump and says which one", () => {
    expect(() => assertTransition("heard", "approved")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("heard", "approved")).toThrow('from "heard" to "approved"');
  });

  it("treats rejected, expired and delivered as finished", () => {
    expect(IDEA_STATES.filter(isTerminal)).toEqual(["rejected", "expired", "delivered"]);
  });
});
