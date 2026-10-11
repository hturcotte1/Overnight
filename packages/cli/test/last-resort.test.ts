// All text in this file is made up for the tests. No error here is ever thrown uncaught for
// real: the watch listens to an emitter of the test's own, and "ending the process" is a note.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@overnight/core";
import { describeFault, FAULT_KINDS, LAST_RESORT_EXIT_CODE, LAST_RESORT_LINE, watchLastResort } from "../src/last-resort.ts";
import { collectingLogger } from "./night-fakes.ts";

const SECRET = "made-up words that must never reach a log";

function setUp(options: { letGo?: Array<() => void>; logger?: ReturnType<typeof collectingLogger>["logger"] | (() => ReturnType<typeof collectingLogger>["logger"]) } = {}) {
  const source = new EventEmitter();
  const exits: number[] = [];
  const log = collectingLogger("build");
  const said: string[] = [];
  const order: string[] = [];
  const watch = watchLastResort({
    command: "overnight made-up",
    logger: options.logger ?? log.logger,
    letGo: options.letGo ?? [() => void order.push("abort"), () => void order.push("release")],
    writeError: (line) => void said.push(line),
    source,
    exitNow: (code) => {
      order.push(`exit ${code}`);
      exits.push(code);
    },
  });
  const handlers = () => FAULT_KINDS.reduce((count, kind) => count + source.listenerCount(kind), 0);
  return { source, exits, log, said, order, watch, handlers };
}

describe("an error nobody caught", () => {
  it("is handled for both kinds: one error line, everything let go in order, then exit 1", () => {
    expect(FAULT_KINDS).toEqual(["uncaughtException", "unhandledRejection"]);
    expect(LAST_RESORT_EXIT_CODE).toBe(1);
    for (const kind of FAULT_KINDS) {
      const t = setUp();
      expect(t.handlers()).toBe(2);
      t.source.emit(kind, new RangeError(SECRET));
      expect(t.order, kind).toEqual(["abort", "release", "exit 1"]);
      expect(t.log.lines).toHaveLength(1);
      expect(t.log.lines[0]).toMatchObject({ level: "error", name: "build", message: `overnight made-up: ${LAST_RESORT_LINE}`, kind, error: "RangeError" });
      expect(t.said).toEqual([`"overnight made-up" ended on an error nobody caught (${kind}). Its lock was released; the one line about it is in its log.`]);
      expect(t.log.text() + t.said.join("\n")).not.toContain(SECRET);
      t.watch.close();
      t.watch.close();
      expect(t.handlers()).toBe(0);
    }
  });

  it("still lets go of the rest, and still exits, when one step or the log itself throws", () => {
    const order: string[] = [];
    const t = setUp({
      logger: () => {
        throw new Error("made-up: the log could not be written");
      },
      letGo: [
        () => {
          order.push("first");
          throw new Error("made-up: could not abort");
        },
        () => void order.push("second"),
      ],
    });
    expect(() => t.source.emit("uncaughtException", new Error(SECRET))).not.toThrow();
    expect(order).toEqual(["first", "second"]);
    expect(t.exits).toEqual([1]);
  });

  it("uses the log of the step that is running when it is given a function", () => {
    const build = collectingLogger("build");
    const deliver = collectingLogger("deliver");
    let current = build.logger;
    const t = setUp({ logger: () => current });
    current = deliver.logger;
    t.source.emit("unhandledRejection", new Error(SECRET));
    expect(build.lines).toEqual([]);
    expect(deliver.lines).toMatchObject([{ level: "error", name: "deliver", kind: "unhandledRejection" }]);
  });

  it("deals with the first one only: a second error while the process is ending changes nothing", () => {
    const t = setUp();
    t.source.emit("uncaughtException", new Error(SECRET));
    t.source.emit("unhandledRejection", new Error(SECRET));
    expect(t.exits).toEqual([1]);
    expect(t.log.lines).toHaveLength(1);
  });

  it("listens to this process, and ends it for real, unless a test says otherwise", () => {
    // Only looked at, never fired: one handler on each of the two events, taken off again.
    const before = FAULT_KINDS.map((kind) => process.listenerCount(kind));
    const watch = watchLastResort({ command: "overnight made-up", logger: collectingLogger().logger, letGo: [] });
    expect(FAULT_KINDS.map((kind) => process.listenerCount(kind))).toEqual(before.map((count) => count + 1));
    watch.close();
    expect(FAULT_KINDS.map((kind) => process.listenerCount(kind))).toEqual(before);
  });
});

describe("what is said about such an error", () => {
  it("is its class name, its code and the place it was thrown at, and never its message", () => {
    const plain = describeFault(new Error(SECRET));
    expect(plain.error).toBe("Error");
    expect(plain.code).toBeUndefined();
    expect(plain.where).toMatch(/last-resort\.test\.ts:\d+:\d+$/);

    // One of our own error classes: its name is set after the stack was made, and is still the name said.
    expect(describeFault(new ConfigError(SECRET))).toMatchObject({ error: "ConfigError" });
    const coded = describeFault(Object.assign(new Error(SECRET), { code: "ENOENT", path: `/made-up/${SECRET}` }));
    expect(coded).toMatchObject({ error: "Error", code: "ENOENT" });
    expect(Object.keys(coded).sort()).toEqual(["code", "error", "where"]);

    for (const described of [plain, coded]) expect(JSON.stringify(described)).not.toContain(SECRET);
  });

  it("does not take a line of the message for the place, however much it looks like one", () => {
    const sly = new Error(`first line\n    at /made-up/${SECRET.replaceAll(" ", "-")}:1:1\nlast line`);
    const described = describeFault(sly);
    expect(JSON.stringify(described)).not.toContain("made-up-words");
    expect(described.where).toMatch(/last-resort\.test\.ts:\d+:\d+$/);

    // A message changed after the stack was written out cannot be told from the stack lines any
    // more, so no place is given at all. (Node writes the stack out the first time it is read.)
    const changed = new Error("the first message\n    at /made-up/place:1:1");
    expect(changed.stack).toContain("the first message");
    changed.message = "another message";
    expect(describeFault(changed)).toEqual({ error: "Error" });
  });

  it("says something safe about a name, a code or a thrown thing that is not what it should be", () => {
    const odd = new Error("x");
    odd.name = `Bad name with ${SECRET}`;
    expect(describeFault(Object.assign(odd, { code: `not a code: ${SECRET}` }))).toMatchObject({ error: "Error" });
    expect(describeFault(Object.assign(new Error("x"), { code: 42 })).code).toBeUndefined();
    expect(describeFault(SECRET)).toEqual({ error: "not an Error (string)" });
    expect(describeFault(null)).toEqual({ error: "not an Error (null)" });
    expect(describeFault(undefined)).toEqual({ error: "not an Error (undefined)" });
    expect(describeFault({ message: SECRET })).toEqual({ error: "not an Error (object)" });
    const noStack = new Error(SECRET);
    noStack.stack = undefined;
    expect(describeFault(noStack)).toEqual({ error: "Error" });
  });
});
