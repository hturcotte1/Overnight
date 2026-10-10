import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, errorSummary } from "../src/index.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "overnight-logger-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("logger", () => {
  it("writes one JSON line per event with its name, level and fields", () => {
    const lines: string[] = [];
    const log = createLogger({ name: "listener", write: (line) => lines.push(line), now: () => new Date("2026-10-09T18:00:00Z") });
    log.info("stream opened", { types: 5 });
    log.child({ ideaId: "idea_1" }).warn("could not ask", { kind: "timeout" });
    log.debug("dropped below the minimum level");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { at: "2026-10-09T18:00:00.000Z", level: "info", name: "listener", message: "stream opened", types: 5 },
      { at: "2026-10-09T18:00:00.000Z", level: "warn", name: "listener", message: "could not ask", ideaId: "idea_1", kind: "timeout" },
    ]);
  });

  it("appends to a private file and starts a new one when the old one is too large", () => {
    const file = path.join(scratch(), "logs", "listen.log");
    createLogger({ name: "a", file, write: () => {} }).info("first");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, "x".repeat(2000));
    createLogger({ name: "a", file, write: () => {}, maxFileBytes: 1000 }).info("after rotation");
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("after rotation");
    expect(readFileSync(file, "utf8")).not.toContain("xxxx");
  });

  it("starts a new file while running, not only at start-up", () => {
    const file = path.join(scratch(), "logs", "listen.log");
    const log = createLogger({ name: "a", file, write: () => {}, maxFileBytes: 2000 });
    for (let i = 0; i < 200; i += 1) log.info("a line that is long enough to add up quickly", { i });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThan(4000);
  });

  it("keeps only the first line of an error message", () => {
    expect(errorSummary(new Error("first line\nsecond line with more"))).toBe("first line");
    expect(errorSummary("plain text")).toBe("plain text");
  });
});
