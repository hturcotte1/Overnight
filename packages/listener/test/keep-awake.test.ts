// Nothing here starts a real program: the spawn function is a fake.
import { createLogger, startKeepAwake as coreStartKeepAwake } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { startKeepAwake } from "../src/keep-awake.ts";
import type { KeepAwakeChild } from "../src/keep-awake.ts";

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

describe("keeping the Mac awake", () => {
  it("is the one in @overnight/core, not a copy of it", () => {
    // The night runs hold the Mac awake with the same code. Two copies would drift apart.
    expect(startKeepAwake).toBe(coreStartKeepAwake);
  });

  it("runs caffeinate tied to our own process, and kills it on stop", () => {
    const { child, kills } = fakeChild();
    const calls: Array<{ command: string; args: string[] }> = [];
    const { logger, lines } = collectingLogger();
    const keepAwake = startKeepAwake(logger, 4242, (command, args) => {
      calls.push({ command, args });
      return child;
    });

    expect(calls).toEqual([{ command: "/usr/bin/caffeinate", args: ["-s", "-w", "4242"] }]);
    expect(kills()).toBe(0);
    keepAwake.stop();
    keepAwake.stop();
    expect(kills()).toBe(1);
    expect(lines.filter((line) => line.level !== "info")).toEqual([]);
  });

  it("only warns when caffeinate cannot be started or dies", () => {
    const { logger, lines } = collectingLogger();
    expect(() =>
      startKeepAwake(logger, 4242, () => {
        throw new Error("spawn ENOENT");
      }).stop(),
    ).not.toThrow();

    const { child, listeners } = fakeChild();
    const keepAwake = startKeepAwake(logger, 4242, () => child);
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
