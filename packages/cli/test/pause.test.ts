import { describe, expect, it } from "vitest";
import { Store } from "@overnight/core";
import { pause, PAUSED_LINE, resume, RESUMED_LINE } from "../src/commands/pause.ts";
import { capture, fixedNow } from "./helpers.ts";

describe("overnight pause / resume", () => {
  it("flips the stored flag and says what that means", () => {
    const store = new Store(":memory:");
    const out = capture();
    expect(store.isPaused(false)).toBe(false);

    expect(pause({ store, write: out.write, now: fixedNow() })).toBe(0);
    expect(store.isPaused(false)).toBe(true);
    expect(out.lines).toEqual([PAUSED_LINE]);
    expect(PAUSED_LINE).toBe("Paused: Overnight still listens and saves, but will not ask or build.");

    expect(resume({ store, write: out.write, now: fixedNow() })).toBe(0);
    // The stored answer wins even where the setting in .env says "start paused".
    expect(store.isPaused(true)).toBe(false);
    expect(out.lines).toEqual([PAUSED_LINE, RESUMED_LINE]);
  });

  it("is safe to repeat", () => {
    const store = new Store(":memory:");
    const out = capture();
    pause({ store, write: out.write });
    pause({ store, write: out.write });
    expect(store.isPaused(false)).toBe(true);
  });
});
