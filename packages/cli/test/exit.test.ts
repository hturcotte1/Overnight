// How the process ends once a command has finished. Nothing here is Bee data.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { repoRoot } from "../src/context.ts";
import { exitOnceFlushed } from "../src/exit.ts";
import { USAGE } from "../src/usage.ts";

const GRACE_MS = 20;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream like a pipe with a slow reader: each write stays "not handed over" until the test says so. */
function slowPipe(): { stream: Writable; handOver: () => void } {
  const waiting: Array<() => void> = [];
  const stream = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      // Like a real pipe: writing nothing needs no reader, anything else waits for one.
      if (chunk.length === 0) callback();
      else waiting.push(callback);
    },
  });
  return { stream, handOver: () => waiting.shift()?.() };
}

describe("ending the process", () => {
  it("forces the exit, with the command's code, a moment after a command whose output is all delivered", async () => {
    const exit = vi.fn<(code: number) => void>();
    const idle = slowPipe();
    exitOnceFlushed(2, { graceMs: GRACE_MS, streams: [idle.stream], exit });
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("does not start counting while printed output is still waiting for a slow reader", async () => {
    const exit = vi.fn<(code: number) => void>();
    const out = slowPipe();
    out.stream.write("a long JSON array the reader has not taken yet");
    expect(out.stream.writableLength).toBeGreaterThan(0);

    exitOnceFlushed(0, { graceMs: GRACE_MS, streams: [out.stream], exit });
    // Well past the grace time: with the old fixed timer the output would be cut off here.
    await wait(GRACE_MS * 5);
    expect(exit).not.toHaveBeenCalled();

    out.handOver(); // the reader takes the output
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("waits for every stream that still holds output", async () => {
    const exit = vi.fn<(code: number) => void>();
    const out = slowPipe();
    const err = slowPipe();
    out.stream.write("output");
    err.stream.write("a warning");

    exitOnceFlushed(1, { graceMs: GRACE_MS, streams: [out.stream, err.stream], exit });
    out.handOver();
    await wait(GRACE_MS * 5);
    expect(exit).not.toHaveBeenCalled();

    err.handOver();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("the overnight program itself", () => {
  const MAIN = path.join(repoRoot(), "packages", "cli", "src", "main.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });

  it("prints its help and ends by itself, without waiting for the forced exit", () => {
    const started = Date.now();
    expect(run("help")).toBe(USAGE + "\n");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("ends with code 2 for a command it does not know, before opening anything", () => {
    try {
      run("dance");
      throw new Error("expected the command to fail");
    } catch (error) {
      const failed = error as { status?: number | null; stderr?: string };
      expect(failed.status).toBe(2);
      expect(failed.stderr).toContain('"dance" is not an Overnight command.');
    }
  });
});
