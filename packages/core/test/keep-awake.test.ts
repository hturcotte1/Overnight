// Nothing here starts a real program: the spawn function is a fake.
import { describe, expect, it } from "vitest";
import { createLogger, startKeepAwake } from "../src/index.ts";
import type { KeepAwakeChild, KeepAwakeMode } from "../src/index.ts";

function fakeChild() {
  const listeners: { error?: (error: Error) => void; exit?: (code: number | null) => void } = {};
  let kills = 0;
  const child: KeepAwakeChild = {
    on(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null) => void)) {
      if (event === "error") listeners.error = listener as (error: Error) => void;
      else listeners.exit = listener as (code: number | null) => void;
      return child;
    },
    kill() {
      kills += 1;
      return true;
    },
  };
  return { child, listeners, kills: () => kills };
}

function collectingLogger() {
  const lines: Array<{ level: string; message: string }> = [];
  return { lines, logger: createLogger({ name: "keep-awake-test", write: (line) => lines.push(JSON.parse(line)) }) };
}

/** Start a hold on fakes, and say what was run and logged. */
function started(mode?: KeepAwakeMode) {
  const { child, kills } = fakeChild();
  const calls: Array<{ command: string; args: string[] }> = [];
  const { logger, lines } = collectingLogger();
  const spawnChild = (command: string, args: string[]) => {
    calls.push({ command, args });
    return child;
  };
  const keepAwake = mode === undefined ? startKeepAwake(logger, 4242, spawnChild) : startKeepAwake(logger, 4242, spawnChild, mode);
  return { keepAwake, calls, kills, lines };
}

describe("keeping the Mac awake", () => {
  it("holds it awake on mains power only, unless asked for more", () => {
    for (const mode of [undefined, "mains"] as const) {
      const { calls, lines } = started(mode);
      expect(calls).toEqual([{ command: "/usr/bin/caffeinate", args: ["-s", "-w", "4242"] }]);
      expect(lines.map((line) => [line.level, line.message])).toEqual([["info", "keeping the Mac awake while plugged in"]]);
    }
  });

  it("holds it awake on battery too when asked to hold it always", () => {
    const { calls, lines } = started("always");
    expect(calls).toEqual([{ command: "/usr/bin/caffeinate", args: ["-i", "-s", "-w", "4242"] }]);
    expect(lines.map((line) => [line.level, line.message])).toEqual([["info", "keeping the Mac awake while this runs"]]);
  });

  it("ties caffeinate to our own process, and kills it once on stop", () => {
    for (const mode of ["mains", "always"] as const) {
      const { keepAwake, calls, kills, lines } = started(mode);
      expect(calls[0]?.args.slice(-2)).toEqual(["-w", "4242"]);
      expect(kills()).toBe(0);
      keepAwake.stop();
      keepAwake.stop();
      expect(kills()).toBe(1);
      expect(lines.filter((line) => line.level !== "info")).toEqual([]);
    }
  });

  it("only warns when caffeinate cannot be started or dies", () => {
    const { logger, lines } = collectingLogger();
    expect(() =>
      startKeepAwake(
        logger,
        4242,
        () => {
          throw new Error("spawn ENOENT");
        },
        "always",
      ).stop(),
    ).not.toThrow();
    // Nothing was started, so nothing claims to be holding the Mac awake.
    expect(lines.filter((line) => line.level === "info")).toEqual([]);

    const { child, listeners } = fakeChild();
    const keepAwake = startKeepAwake(logger, 4242, () => child, "always");
    listeners.error?.(new Error("spawn EACCES"));
    listeners.exit?.(1);
    keepAwake.stop();
    listeners.exit?.(null); // our own kill: nothing to report

    expect(lines.filter((line) => line.level === "warn").map((line) => line.message)).toEqual([
      "could not keep the Mac awake",
      "could not keep the Mac awake",
      "the keep-awake helper stopped by itself",
    ]);
  });
});
