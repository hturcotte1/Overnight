// Synthetic test data. Every reply, name and sentence in this file is made up. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { BeeError } from "@overnight/core";
import { DEFAULT_TIMEOUT_MS, createBeeGateway } from "../src/index.ts";
import type { BeeClientLike } from "../src/index.ts";
import { beeFailure, captureLogger, fakeClient } from "./fakes.ts";

type Reply = (args: string[], options?: { signal?: AbortSignal }) => unknown;

function gatewayWith(reply: Reply, timeoutMs?: number) {
  const { client, calls } = fakeClient(reply);
  const log = captureLogger();
  return { bee: createBeeGateway({ client, logger: log.logger, timeoutMs }), calls, log };
}

const fails = (stderr: string): Reply => () => {
  throw beeFailure(stderr);
};

/** Like a real command that hangs: it only ever finishes by being aborted. */
const hangsUntilAborted: Reply = (_args, options) =>
  new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })));
  });

async function thrownBy(promise: Promise<unknown>): Promise<BeeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BeeError) return error;
    throw new Error(`expected a BeeError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected the call to fail");
}

const ALARM = new Date("2026-10-09T18:02:00.000Z");

// What the real bee program prints (seen on 2026-10-09) when it cannot reach Bee at all, and when
// a connection it had made is cut off.
const NEVER_CONNECTED = "Unable to connect. Is the computer able to access the url?";
const CUT_OFF = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

/** What Node throws when the program cannot be started. `spawnargs` holds the arguments, as it really does. */
const cannotStart: Reply = (args) => {
  throw Object.assign(new Error("spawn /made/up/path/bee ENOENT"), { errno: -2, code: "ENOENT", syscall: "spawn /made/up/path/bee", path: "/made/up/path/bee", spawnargs: args });
};

const logged = (log: ReturnType<typeof captureLogger>) => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);

// ---------- a made-up `bee todos list` reply, in the shape the real one has ----------

const ASK = "💡 Build tonight? Chore wheel";
const CREATE_ARGS = ["todos", "create", "--text", ASK, "--alarm-at", "2026-10-09T18:02:00.000Z"];
const LIST_ARGS = ["todos", "list", "--limit", "20"];

const listed = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ id, text, completed: false, created_at: Date.now(), alarm_at: null, corrections: [], ...extra });
const listOf = (...todos: unknown[]) => ({ todos, next_cursor: null, timezone: "America/Boise" });

/** A Bee that answers `todos create` one way and `todos list` another. */
const createThenList = (create: Reply, list: Reply): Reply => (args, options) => (args[1] === "create" ? create(args, options) : list(args, options));

describe("loginState", () => {
  it('runs "bee me" and says logged-in without passing on the name in the reply', async () => {
    const { bee, calls, log } = gatewayWith(() => ({ id: 3, first_name: "Peregrine", last_name: "Quillfeather", timezone: "America/Boise" }));
    expect(await bee.loginState()).toBe("logged-in");
    expect(calls).toEqual([["me"]]);
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|Quillfeather/);
  });

  it("says logged-out only when Bee says so", async () => {
    expect(await gatewayWith(fails("Not logged in. Run 'bee login' first.")).bee.loginState()).toBe("logged-out");
  });

  it("says unknown for a timeout or any other failure", async () => {
    expect(await gatewayWith(hangsUntilAborted, 20).bee.loginState()).toBe("unknown");
    expect(await gatewayWith(fails(NEVER_CONNECTED)).bee.loginState()).toBe("unknown");
    expect(await gatewayWith(fails(CUT_OFF)).bee.loginState()).toBe("unknown");
    expect(await gatewayWith(fails("Request failed with status 503")).bee.loginState()).toBe("unknown");
    expect(await gatewayWith(fails("Failed to parse Bee CLI JSON output: Unexpected token")).bee.loginState()).toBe("unknown");
    expect(await gatewayWith(cannotStart).bee.loginState()).toBe("unknown");
  });

  // Nobody has seen what Bee really says to a login it no longer accepts: finding out would mean
  // breaking the login. These are the forms the bee program's source can produce.
  it("takes a login that Bee's server rejects for logged-out", async () => {
    for (const stderr of ["Request failed with status 401", "Unauthorized", "401 Unauthorized", "unauthorized: made-up reason\nbee me [--json]"]) {
      expect(await gatewayWith(fails(stderr)).bee.loginState()).toBe("logged-out");
    }
  });

  it("is not fooled by other numbers and other refusals", async () => {
    for (const stderr of ["Request failed with status 4010", "Request failed with status 403", "Request failed with status 500 (made-up ref 1401)", "made-up first line\nUnauthorized"]) {
      expect(await gatewayWith(fails(stderr)).bee.loginState()).toBe("unknown");
    }
  });

  it("reads a rejected login that way only when checking the login", async () => {
    expect((await thrownBy(gatewayWith(fails("Request failed with status 401")).bee.todoStatus(11))).kind).toBe("failed");
    expect((await thrownBy(gatewayWith(fails("Unauthorized")).bee.todoStatus(11))).kind).toBe("bad-response");
  });

  it("logs the kind of failure and never the error's text", async () => {
    // Bee's library uses standard output as the error when standard error is empty.
    const { bee, log } = gatewayWith(fails("Name: Peregrine Quillfeather"));
    expect(await bee.loginState()).toBe("unknown");
    const warning = logged(log).find((line) => line.message === "Could not check the Bee login");
    expect(warning).toMatchObject({ level: "warn", kind: "bad-response" });
    expect(warning).not.toHaveProperty("error");
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|Quillfeather/);
  });
});

describe("createTodo", () => {
  it("passes the text and a UTC alarm time as separate arguments", async () => {
    const { bee, calls } = gatewayWith(() => ({ id: 11 }));
    await bee.createTodo("💡 Build tonight? Chore wheel", ALARM);
    expect(calls).toEqual([["todos", "create", "--text", "💡 Build tonight? Chore wheel", "--alarm-at", "2026-10-09T18:02:00.000Z"]]);
  });

  it("accepts the bare reply", async () => {
    const reply = { id: 11, text: "💡 Build tonight? Chore wheel", alarm_at: 1760032920000, completed: false, created_at: 1760032800000, corrections: [], timezone: "America/Boise" };
    expect(await gatewayWith(() => reply).bee.createTodo("💡 Build tonight? Chore wheel", ALARM)).toEqual({ id: 11 });
  });

  it("accepts the wrapped reply", async () => {
    expect(await gatewayWith(() => ({ todo: { id: 12, text: "made up", completed: false } })).bee.createTodo("made up", ALARM)).toEqual({ id: 12 });
  });

  it("throws bad-response, naming the field, when the reply has no usable id", async () => {
    for (const reply of [{}, { todo: {} }, { id: "eleven" }, null, "ok"]) {
      const error = await thrownBy(gatewayWith(() => reply).bee.createTodo("made up", ALARM));
      expect(error.kind).toBe("bad-response");
      expect(error.message).toMatch(/^bee todos create returned a reply we could not read \((id|\(whole reply\))\)\.$/);
    }
  });

  it("never logs the to-do's text", async () => {
    const { bee, log } = gatewayWith(() => ({ id: 11 }));
    await bee.createTodo("💡 Build tonight? Glow-in-the-dark seed catalogue", ALARM);
    expect(log.lines.join("\n")).not.toContain("seed catalogue");
    expect(log.lines.join("\n")).toContain('"todoId":11');
  });

  it("refuses empty text and an invalid time before calling Bee", async () => {
    const { bee, calls } = gatewayWith(() => ({ id: 1 }));
    expect((await thrownBy(bee.createTodo("  ", ALARM))).kind).toBe("failed");
    expect((await thrownBy(bee.createTodo("made up", new Date("not a date")))).kind).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("refuses text with a NUL character before calling Bee, without repeating the text", async () => {
    const { bee, calls, log } = gatewayWith(() => ({ id: 1 }));
    const error = await thrownBy(bee.createTodo("made-up title\u0000tail", ALARM));
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("createTodo cannot send text with a NUL character in it.");
    expect(calls).toEqual([]);
    expect(log.lines.join("\n")).not.toContain("made-up title");
  });

  it("still returns the to-do when the logger throws", async () => {
    const { client } = fakeClient(() => ({ id: 11 }));
    const broken = () => {
      throw new Error("made-up: disk full");
    };
    const logger = { debug: broken, info: broken, warn: broken, error: broken, child: broken };
    expect(await createBeeGateway({ client, logger }).createTodo("made up", ALARM)).toEqual({ id: 11 });
  });
});

describe("createTodo, when the create fails but Bee may have made the to-do", () => {
  const found = listOf(listed(78, "a made-up to-do of Bee's own"), listed(77, ASK), listed(60, ASK, { completed: true, created_at: Date.now() - 86_400_000 }));

  it("looks the to-do up after a timeout and returns it", async () => {
    const { bee, calls, log } = gatewayWith(createThenList(hangsUntilAborted, () => found), 20);
    expect(await bee.createTodo(ASK, ALARM)).toEqual({ id: 77 });
    expect(calls).toEqual([CREATE_ARGS, LIST_ARGS]);
    expect(logged(log).find((line) => line.message === "Bee to-do found after a failed create")).toMatchObject({ level: "info", todoId: 77, kind: "timeout" });
    // The list holds the text of every recent to-do. None of it may reach the log.
    expect(log.lines.join("\n")).not.toMatch(/Chore wheel|Bee's own/);
  });

  it("looks after every failure that may have reached Bee, and never calls such a failure \"failed\"", async () => {
    const maybeCreated: Array<[string, Reply, BeeError["kind"]]> = [
      ["the time limit", hangsUntilAborted, "timeout"],
      ["a connection cut off part-way", fails(CUT_OFF), "bad-response"],
      ["a server error", fails("Request failed with status 503"), "bad-response"],
      ["an error text we have never seen", fails("Something made-up went wrong"), "bad-response"],
      ["the program ending without a word", fails("Bee CLI exited with code 1."), "bad-response"],
      ["output that is not JSON", fails("Failed to parse Bee CLI JSON output: Unexpected token 'N'"), "bad-response"],
      ["a reply with no id", () => ({ text: ASK }), "bad-response"],
      ["an empty reply", () => null, "bad-response"],
      ["a broken pipe while reading the reply", () => { throw Object.assign(new Error("read EPIPE"), { code: "EPIPE", syscall: "read" }); }, "bad-response"],
      ["the program being stopped by someone else", () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }); }, "timeout"],
    ];
    for (const [what, create, kind] of maybeCreated) {
      const there = gatewayWith(createThenList(create, () => found), 20);
      expect(await there.bee.createTodo(ASK, ALARM), what).toEqual({ id: 77 });
      expect(there.calls, what).toEqual([CREATE_ARGS, LIST_ARGS]);

      const notThere = gatewayWith(createThenList(create, () => listOf()), 20);
      const error = await thrownBy(notThere.bee.createTodo(ASK, ALARM));
      expect(error.kind, what).toBe(kind);
      expect(notThere.calls, what).toEqual([CREATE_ARGS, LIST_ARGS]);
    }
  });

  it("does not look, and says \"failed\" or \"logged-out\", when nothing can have been created", async () => {
    const refused: Array<[string, Reply, BeeError["kind"]]> = [
      ["no login", fails('Not logged in. Run "bee login" first.'), "logged-out"],
      ["Bee's server turning the request down", fails("Request failed with status 400\nbee todos create --text <text> [--alarm-at <iso>] [--json]"), "failed"],
      ["no connection at all", fails(NEVER_CONNECTED), "failed"],
      ["a bee program that cannot be started", cannotStart, "failed"],
    ];
    for (const [what, create, kind] of refused) {
      const { bee, calls } = gatewayWith(createThenList(create, () => found));
      expect((await thrownBy(bee.createTodo(ASK, ALARM))).kind, what).toBe(kind);
      expect(calls, what).toEqual([CREATE_ARGS]);
    }
  });

  it("throws the original error when the to-do is not in the list", async () => {
    const now = Date.now();
    const lists = [
      listOf(),
      listOf(listed(78, "a made-up to-do of Bee's own"), listed(79, `${ASK} again`)),
      // Ours, but already ticked: an old ask, not this one.
      listOf(listed(77, ASK, { completed: true })),
      // Ours, but made three minutes before we started: an old ask, not this one.
      listOf(listed(77, ASK, { created_at: now - 180_000 })),
      // Entries we cannot read are passed over, not guessed at.
      listOf(listed(77, ASK, { id: "seventy-seven" }), listed(77, ASK, { created_at: "just now" }), listed(77, ASK, { created_at: 12 }), { text: ASK }, null, "💡"),
    ];
    for (const list of lists) {
      const { bee, calls } = gatewayWith(createThenList(hangsUntilAborted, () => list), 20);
      const error = await thrownBy(bee.createTodo(ASK, ALARM));
      expect(error.kind).toBe("timeout");
      expect(error.message).toBe("bee todos create timed out after 0.02 s");
      expect(calls).toEqual([CREATE_ARGS, LIST_ARGS]);
    }
  });

  it("throws the original error when the list cannot be had", async () => {
    const original = "bee todos create failed: Request failed with status 503";
    const lists: Reply[] = [hangsUntilAborted, fails(NEVER_CONNECTED), fails('Not logged in. Run "bee login" first.'), cannotStart, () => null, () => ({ todos: "lots" }), () => [listed(77, ASK)]];
    for (const list of lists) {
      const { bee, calls, log } = gatewayWith(createThenList(fails("Request failed with status 503"), list), 20);
      const error = await thrownBy(bee.createTodo(ASK, ALARM));
      expect(error.kind).toBe("bad-response");
      expect(error.message).toBe(original);
      expect(calls).toEqual([CREATE_ARGS, LIST_ARGS]);
      expect(logged(log).find((line) => line.message === "Could not look for the Bee to-do after a failed create")).toMatchObject({ level: "warn", kind: "bad-response" });
    }
  });

  it("takes the newest when the text is there more than once", async () => {
    const now = Date.now();
    const list = listOf(listed(80, ASK, { created_at: now - 60_000 }), listed(81, ASK, { created_at: now - 20_000 }), listed(79, ASK, { created_at: now - 600_000 }));
    expect(await gatewayWith(createThenList(hangsUntilAborted, () => list), 20).bee.createTodo(ASK, ALARM)).toEqual({ id: 81 });
  });

  it("allows for Bee's clock being up to two minutes behind ours, and no more", async () => {
    const at = (msAgo: number) => listOf(listed(77, ASK, { created_at: Date.now() - msAgo }));
    expect(await gatewayWith(createThenList(hangsUntilAborted, () => at(110_000)), 20).bee.createTodo(ASK, ALARM)).toEqual({ id: 77 });
    expect((await thrownBy(gatewayWith(createThenList(hangsUntilAborted, () => at(125_000)), 20).bee.createTodo(ASK, ALARM))).kind).toBe("timeout");
  });

  it("knows its own text again after Bee has tidied it, and reads a created time in seconds", async () => {
    // Spaces at the ends gone, and the accent stored as a letter plus a separate mark.
    const sent = "  💡 Build tonight? Café tab splitter  ";
    const stored = sent.trim().normalize("NFD");
    expect(stored).not.toBe(sent.trim());
    const tidied = listOf(listed(77, stored, { created_at: Math.ceil(Date.now() / 1000) }));
    const { bee, calls } = gatewayWith(createThenList(hangsUntilAborted, () => tidied), 20);
    expect(await bee.createTodo(sent, ALARM)).toEqual({ id: 77 });
    expect(calls[0]).toEqual(["todos", "create", "--text", sent, "--alarm-at", "2026-10-09T18:02:00.000Z"]);
  });

  it("does not take a to-do with different text for ours", async () => {
    const near = listOf(listed(77, ASK.toLowerCase()), listed(78, `${ASK}!`), listed(79, ASK.replace("Chore", "Chore  ")));
    expect((await thrownBy(gatewayWith(createThenList(hangsUntilAborted, () => near), 20).bee.createTodo(ASK, ALARM))).kind).toBe("timeout");
  });
});

describe("createFact", () => {
  const FACT = "Overnight built “Chore wheel” on Oct 10: https://example.invalid/chore-wheel/";
  const FACT_ARGS = ["facts", "create", "--text", FACT];
  // The shape the real program printed in spike 4, with made-up values.
  const bare = { id: 501, text: FACT, tags: ["general"], created_at: 1760032800000, confirmed: true, user_id: 31337, timezone: "America/Boise" };

  it("passes the text as one separate argument", async () => {
    const { bee, calls } = gatewayWith(() => bare);
    await bee.createFact(FACT);
    expect(calls).toEqual([FACT_ARGS]);
  });

  it("accepts the bare reply and the wrapped one, and returns only the id", async () => {
    expect(await gatewayWith(() => bare).bee.createFact(FACT)).toEqual({ id: 501 });
    expect(await gatewayWith(() => ({ fact: { ...bare, id: 502 } })).bee.createFact(FACT)).toEqual({ id: 502 });
    expect(await gatewayWith(() => ({ id: 503 })).bee.createFact(FACT)).toEqual({ id: 503 });
  });

  it("throws bad-response, naming the field, when the reply has no usable id", async () => {
    for (const reply of [{}, { fact: {} }, { id: "five hundred" }, { id: 5.5 }, null, "ok", [bare]]) {
      const error = await thrownBy(gatewayWith(() => reply).bee.createFact(FACT));
      expect(error.kind).toBe("bad-response");
      expect(error.message).toMatch(/^bee facts create returned a reply we could not read \((id|\(whole reply\))\)\.$/);
    }
  });

  it("never logs the fact's text, or anything else from the reply", async () => {
    const { bee, log } = gatewayWith(() => bare);
    await bee.createFact(FACT);
    expect(log.lines.join("\n")).not.toMatch(/Chore wheel|example\.invalid|31337/);
    expect(logged(log).find((line) => line.message === "Bee fact created")).toMatchObject({ level: "info", factId: 501 });
  });

  it("refuses empty text before calling Bee", async () => {
    const { bee, calls } = gatewayWith(() => bare);
    for (const text of ["", "   ", "\n\t"]) {
      const error = await thrownBy(bee.createFact(text));
      expect(error.kind).toBe("failed");
      expect(error.message).toBe("createFact needs some text.");
    }
    expect(calls).toEqual([]);
  });

  it("refuses text with a NUL character before calling Bee, without repeating the text", async () => {
    const { bee, calls, log } = gatewayWith(() => bare);
    const error = await thrownBy(bee.createFact("made-up fact\u0000tail"));
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("createFact cannot send text with a NUL character in it.");
    expect(calls).toEqual([]);
    expect(log.lines.join("\n")).not.toContain("made-up fact");
  });

  it('says "failed" or "logged-out" only when nothing can have been created', async () => {
    const refused: Array<[string, Reply, BeeError["kind"]]> = [
      ["no login", fails('Not logged in. Run "bee login" first.'), "logged-out"],
      ["Bee's server turning the request down", fails("Request failed with status 400\nbee facts create --text <text> [--json]"), "failed"],
      ["no connection at all", fails(NEVER_CONNECTED), "failed"],
      ["a bee program that cannot be started", cannotStart, "failed"],
    ];
    for (const [what, reply, kind] of refused) {
      const { bee, calls } = gatewayWith(reply);
      expect((await thrownBy(bee.createFact(FACT))).kind, what).toBe(kind);
      expect(calls, what).toEqual([FACT_ARGS]);
    }
  });

  it('says "timeout" or "bad-response" when the fact may exist, and does not go looking for it', async () => {
    const maybeCreated: Array<[string, Reply, BeeError["kind"]]> = [
      ["the time limit", hangsUntilAborted, "timeout"],
      ["a connection cut off part-way", fails(CUT_OFF), "bad-response"],
      ["a server error", fails("Request failed with status 503"), "bad-response"],
      ["an error text we have never seen", fails("Something made-up went wrong"), "bad-response"],
      ["output that is not JSON", fails("Failed to parse Bee CLI JSON output: Unexpected token 'N'"), "bad-response"],
      ["a reply with no id", () => ({ text: FACT }), "bad-response"],
    ];
    for (const [what, reply, kind] of maybeCreated) {
      const { bee, calls } = gatewayWith(reply, 20);
      expect((await thrownBy(bee.createFact(FACT))).kind, what).toBe(kind);
      // One command and no second one: a to-do is looked up after an unclear failure, a fact is not.
      expect(calls, what).toEqual([FACT_ARGS]);
    }
  });

  it("names the command, not the text, in its errors", async () => {
    const timedOut = await thrownBy(gatewayWith(hangsUntilAborted, 20).bee.createFact(FACT));
    expect(timedOut.message).toBe("bee facts create timed out after 0.02 s");
    const unknown = await thrownBy(gatewayWith(fails(`Could not store: ${FACT}`)).bee.createFact(FACT));
    expect(unknown.message).toBe("bee facts create failed with an unrecognised error");
  });

  it("still returns the fact when the logger throws", async () => {
    const { client } = fakeClient(() => bare);
    const broken = () => {
      throw new Error("made-up: disk full");
    };
    const logger = { debug: broken, info: broken, warn: broken, error: broken, child: broken };
    expect(await createBeeGateway({ client, logger }).createFact(FACT)).toEqual({ id: 501 });
  });
});

describe("todoStatus", () => {
  it('runs "bee todos get <id>"', async () => {
    const { bee, calls } = gatewayWith(() => ({ id: 11, completed: false }));
    await bee.todoStatus(11);
    expect(calls).toEqual([["todos", "get", "11"]]);
  });

  it("reads completed and open, bare or wrapped", async () => {
    expect(await gatewayWith(() => ({ id: 11, text: "made up", completed: true })).bee.todoStatus(11)).toBe("completed");
    expect(await gatewayWith(() => ({ id: 11, text: "made up", completed: false })).bee.todoStatus(11)).toBe("open");
    expect(await gatewayWith(() => ({ todo: { id: 11, completed: true } })).bee.todoStatus(11)).toBe("completed");
  });

  it('says deleted only for "Todo not found"', async () => {
    expect(await gatewayWith(fails("Todo not found.")).bee.todoStatus(11)).toBe("deleted");
  });

  it("throws for every other failure, and never guesses deleted", async () => {
    const cases: Array<[Reply, BeeError["kind"]]> = [
      [fails(NEVER_CONNECTED), "failed"],
      [fails(CUT_OFF), "bad-response"],
      [fails("Request failed with status 503"), "bad-response"],
      [fails("Conversation not found"), "bad-response"],
      [fails("Not logged in."), "logged-out"],
      [cannotStart, "failed"],
      [fails("Failed to parse Bee CLI JSON output: Unexpected token 'T', \"Todo not f\"... is not valid JSON"), "bad-response"],
      [() => ({ id: 11 }), "bad-response"],
      [() => null, "bad-response"],
    ];
    for (const [reply, kind] of cases) expect((await thrownBy(gatewayWith(reply).bee.todoStatus(11))).kind).toBe(kind);
  });

  it("refuses an id that is not a whole number, without calling Bee", async () => {
    const { bee, calls } = gatewayWith(fails("Todo not found."));
    expect((await thrownBy(bee.todoStatus(Number.NaN))).kind).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("changedSince", () => {
  const reply = {
    meta: { next_cursor: "cursor-two", since: 1760000000000, until: 1760032800000, updated: true, timezone: "America/Boise" },
    facts: [{ id: 1, text: "Peregrine likes dark mode", tags: ["general"], created_at: 1760000000000, confirmed: false }],
    todos: [{ id: 5, text: "made-up to-do", alarm_at: 1760032920000, completed: false, created_at: 1760032800000 }],
    dailies: [],
    conversations: [
      { id: 9001, state: "COMPLETED", summary: "A made-up summary about kites", transcriptions: [{ id: 1, realtime: false, utterances: [{ id: 2, text: "a made-up line about kites", speaker: "Peregrine", spoken_at: 1760032805000 }] }] },
      { id: 9002, state: "CAPTURING" },
      { id: 9001, state: "COMPLETED" },
      { state: "no id here" },
    ],
    journals: [],
  };

  it("with no cursor, runs plain \"bee changed\"", async () => {
    const { bee, calls } = gatewayWith(() => reply);
    await bee.changedSince(null);
    expect(calls).toEqual([["changed"]]);
  });

  it("treats an empty cursor as no cursor", async () => {
    const { bee, calls } = gatewayWith(() => reply);
    await bee.changedSince("");
    expect(calls).toEqual([["changed"]]);
  });

  it("with a cursor, passes it as a separate argument", async () => {
    const { bee, calls } = gatewayWith(() => reply);
    await bee.changedSince("cursor-one");
    expect(calls).toEqual([["changed", "--cursor", "cursor-one"]]);
  });

  it("returns only the next cursor and the conversation ids", async () => {
    const { bee, log } = gatewayWith(() => reply);
    const changed = await bee.changedSince("cursor-one");
    expect(changed).toEqual({ nextCursor: "cursor-two", conversationIds: [9001, 9002] });
    expect(JSON.stringify(changed) + log.lines.join("\n")).not.toMatch(/kites|Peregrine|dark mode|made-up to-do/);
  });

  it("gives a null cursor when Bee sends none", async () => {
    expect(await gatewayWith(() => ({ conversations: [] })).bee.changedSince(null)).toEqual({ nextCursor: null, conversationIds: [] });
    expect(await gatewayWith(() => ({ meta: { next_cursor: null } })).bee.changedSince(null)).toEqual({ nextCursor: null, conversationIds: [] });
  });

  it("throws bad-response for a reply it cannot read", async () => {
    for (const bad of [null, [], { conversations: "lots" }, { meta: { next_cursor: 17 } }]) {
      expect((await thrownBy(gatewayWith(() => bad).bee.changedSince(null))).kind).toBe("bad-response");
    }
  });
});

describe("transcriptSince", () => {
  const reply = {
    conversationId: 9001,
    note: "made-up note",
    transcript: [
      { id: 30, realtime: false, start: 9, end: 11, spoken_at: "2026-10-09T18:00:20Z", text: "an ISO line", speaker: "Peregrine", created_at: 1760032830000 },
      { id: 31, realtime: false, start: 0, end: 2, spoken_at: Date.UTC(2026, 9, 9, 18, 0, 10), text: "  an epoch line  ", speaker: "Unknown", created_at: 1760032830000 },
      { id: 32, realtime: false, spoken_at: Date.UTC(2026, 9, 9, 18, 0, 30), text: "   ", speaker: "Peregrine" },
      { id: 33, realtime: false, spoken_at: "sometime", text: "no usable time", speaker: "Peregrine" },
      { id: 34, realtime: false, text: "no time at all", speaker: "Peregrine" },
      { realtime: false, spoken_at: Date.UTC(2026, 9, 9, 18, 0, 40), text: "no id", speaker: "Peregrine" },
      "not a line",
    ],
  };
  const SINCE = Date.UTC(2026, 9, 9, 18, 0, 0);

  it("passes the id and a whole number of milliseconds as separate arguments", async () => {
    const { bee, calls } = gatewayWith(() => reply);
    await bee.transcriptSince(9001, SINCE + 0.75);
    expect(calls).toEqual([["conversations", "transcript", "9001", "--since", String(SINCE)]]);
  });

  it("maps lines with either time format, oldest first, and drops the speaker", async () => {
    const { bee, log } = gatewayWith(() => reply);
    const lines = await bee.transcriptSince(9001, SINCE);
    expect(lines).toEqual([
      { beeUtteranceId: 31, text: "an epoch line", spokenAt: "2026-10-09T18:00:10.000Z" },
      { beeUtteranceId: 30, text: "an ISO line", spokenAt: "2026-10-09T18:00:20.000Z" },
      { beeUtteranceId: null, text: "no id", spokenAt: "2026-10-09T18:00:40.000Z" },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Peregrine|Unknown|made-up note/);
    expect(log.lines.join("\n")).not.toMatch(/Peregrine|an ISO line|an epoch line|made-up note/);
  });

  it("leaves out lines spoken before the time asked for, even if Bee sends them", async () => {
    const lines = await gatewayWith(() => reply).bee.transcriptSince(9001, Date.UTC(2026, 9, 9, 18, 0, 20));
    expect(lines?.map((line) => line.beeUtteranceId)).toEqual([30, null]);
  });

  it("returns an empty list for an empty transcript", async () => {
    expect(await gatewayWith(() => ({ conversationId: 9001, transcript: [], note: "" })).bee.transcriptSince(9001, SINCE)).toEqual([]);
  });

  it('returns null for "Conversation not found"', async () => {
    expect(await gatewayWith(fails("Conversation not found")).bee.transcriptSince(9001, SINCE)).toBeNull();
  });

  it("throws for every other failure", async () => {
    expect((await thrownBy(gatewayWith(fails(NEVER_CONNECTED)).bee.transcriptSince(9001, SINCE))).kind).toBe("failed");
    expect((await thrownBy(gatewayWith(fails(CUT_OFF)).bee.transcriptSince(9001, SINCE))).kind).toBe("bad-response");
    expect((await thrownBy(gatewayWith(fails("Todo not found.")).bee.transcriptSince(9001, SINCE))).kind).toBe("bad-response");
    expect((await thrownBy(gatewayWith(() => ({ conversationId: 9001 })).bee.transcriptSince(9001, SINCE))).kind).toBe("bad-response");
    expect((await thrownBy(gatewayWith(() => reply).bee.transcriptSince(9001, Number.NaN))).kind).toBe("failed");
  });
});

describe("time limits", () => {
  it("turns an aborted command into a timeout error that names the command", async () => {
    const { bee } = gatewayWith(hangsUntilAborted, 20);
    const error = await thrownBy(bee.todoStatus(11));
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("bee todos get timed out after 0.02 s");
  });

  it("applies to every command", async () => {
    const { bee } = gatewayWith(hangsUntilAborted, 20);
    const errors = await Promise.all([thrownBy(bee.createTodo("made up", ALARM)), thrownBy(bee.changedSince(null)), thrownBy(bee.transcriptSince(9001, 0))]);
    expect(errors.map((error) => error.kind)).toEqual(["timeout", "timeout", "timeout"]);
    expect(errors.map((error) => error.message)).toEqual([
      "bee todos create timed out after 0.02 s",
      "bee changed timed out after 0.02 s",
      "bee conversations transcript timed out after 0.02 s",
    ]);
  });

  it("gives every command a signal, and still stops waiting if a client ignores it", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const { bee } = gatewayWith((_args, options) => {
      signals.push(options?.signal);
      return new Promise(() => {});
    }, 20);
    expect((await thrownBy(bee.todoStatus(11))).kind).toBe("timeout");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("leaves no stray rejection behind when a client throws instead of returning a promise", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client: BeeClientLike = {
        runJson: () => {
          throw new Error("thrown straight away");
        },
        sse: { streamJson: () => ({ events: (async function* () {})(), close: () => {} }) },
      };
      const error = await thrownBy(createBeeGateway({ client, timeoutMs: 20 }).todoStatus(11));
      expect(error.message).toBe("bee todos get failed with an unrecognised error");
      // Wait past the time limit: its timer still fires, and nothing must be left unhandled.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stops what is in flight when the gateway is disposed of, and says why", async () => {
    const { bee, calls } = gatewayWith(createThenList(hangsUntilAborted, hangsUntilAborted), 5000);
    const pending = [thrownBy(bee.createTodo(ASK, ALARM)), thrownBy(bee.changedSince(null))];
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    bee.dispose();
    const errors = await Promise.all(pending);
    expect(Date.now() - started).toBeLessThan(1000);
    // "timeout" is the kind that tells createTodo's caller the to-do may exist. It is not called
    // a time limit, because it was not one.
    expect(errors.map((error) => error.kind)).toEqual(["timeout", "timeout"]);
    expect(errors.map((error) => error.message)).toEqual([
      "bee todos create was stopped before it answered, because Overnight is stopping.",
      "bee changed was stopped before it answered, because Overnight is stopping.",
    ]);
    // Nothing new is started once we are stopping: not the look-up after the create, not a later command.
    expect(calls).toEqual([CREATE_ARGS, ["changed"]]);
    expect((await thrownBy(bee.todoStatus(11))).message).toBe("bee todos get was stopped before it answered, because Overnight is stopping.");
    expect(calls).toHaveLength(2);
    expect(() => bee.dispose()).not.toThrow();
  });

  it("listens for the process's exit once, however many gateways there are", () => {
    const { client } = fakeClient(() => null);
    const before = process.listenerCount("exit");
    for (let i = 0; i < 50; i += 1) createBeeGateway({ client });
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("defaults to 30 seconds and refuses a limit that makes no sense", () => {
    const { client } = fakeClient(() => null);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    // A limit Node's timer would refuse must be refused here, once, not by every command later.
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1500.5, 2 ** 31, 2 ** 32]) {
      expect(() => createBeeGateway({ client, timeoutMs }), String(timeoutMs)).toThrow(/timeoutMs must be a whole number of milliseconds/);
    }
    for (const timeoutMs of [1, 1500, 2 ** 31 - 1]) expect(() => createBeeGateway({ client, timeoutMs }), String(timeoutMs)).not.toThrow();
  });
});

describe("failures", () => {
  it("maps Bee's \"Not logged in\" to logged-out for every command", async () => {
    const { bee } = gatewayWith(fails("Not logged in. Run 'bee login' first."));
    const errors = await Promise.all([thrownBy(bee.createTodo("made up", ALARM)), thrownBy(bee.todoStatus(11)), thrownBy(bee.changedSince(null)), thrownBy(bee.transcriptSince(9001, 0))]);
    expect(errors.map((error) => error.kind)).toEqual(["logged-out", "logged-out", "logged-out", "logged-out"]);
  });

  it("keeps only the first line of any other error", async () => {
    const error = await thrownBy(gatewayWith(fails("Request failed with status 503\nUsage: bee changed [--cursor <cursor>]\n  more help")).bee.changedSince(null));
    expect(error.kind).toBe("bad-response");
    expect(error.message).toBe("bee changed failed: Request failed with status 503");
  });

  it("says \"failed\" only with proof that nothing happened, and \"bad-response\" for everything else", async () => {
    const kindFor = async (stderr: string) => (await thrownBy(gatewayWith(fails(stderr)).bee.changedSince(null))).kind;
    // Bee's server turned it down, or no connection was ever made.
    for (const stderr of ["Request failed with status 400", "Request failed with status 404", "Request failed with status 429", NEVER_CONNECTED]) expect(await kindFor(stderr), stderr).toBe("failed");
    // Everything else may have reached Bee, including anything we have never seen before.
    for (const stderr of [CUT_OFF, "Request failed with status 500", "Request failed with status 4", "Request failed with status 4000", "made-up: Request failed with status 400", "Bee servers are currently experiencing issues. Please try again later.", "Bee CLI exited with code 1.", "fetch failed", ""]) {
      expect(await kindFor(stderr), stderr).toBe("bad-response");
    }
  });

  it("does not pass on an error that looks like data, or a piece of unreadable output", async () => {
    const dataLike = await thrownBy(gatewayWith(fails('{"first_name":"Peregrine"}')).bee.changedSince(null));
    expect(dataLike.message).toBe("bee changed failed with an unrecognised error");
    const notJson = await thrownBy(gatewayWith(fails('Failed to parse Bee CLI JSON output: Unexpected token \'P\', "Peregrine s"... is not valid JSON')).bee.changedSince(null));
    expect(notJson.kind).toBe("bad-response");
    expect(notJson.message).not.toContain("Peregrine");
  });

  it("never repeats an error it does not recognise, whatever the command", async () => {
    // With nothing on standard error, Bee's library takes the first thing on standard output for
    // the error message. These are invented sentences of the kind somebody might have said.
    const said = ["Peregrine said we should build a chore wheel tonight", "Name: Peregrine Quillfeather", "the made-up dentist is on Juniper Street at four", "Error: Peregrine could not be reached", "Peregrine: Request failed with status 400", "x".repeat(500)];
    for (const line of said) {
      const { bee, log } = gatewayWith(fails(`${line}\nsecond made-up line`));
      const errors = await Promise.all([thrownBy(bee.createTodo("made up", ALARM)), thrownBy(bee.todoStatus(11)), thrownBy(bee.changedSince(null)), thrownBy(bee.transcriptSince(9001, 0))]);
      expect(errors.map((error) => error.kind)).toEqual(["bad-response", "bad-response", "bad-response", "bad-response"]);
      expect(errors.map((error) => error.message)).toEqual([
        "bee todos create failed with an unrecognised error",
        "bee todos get failed with an unrecognised error",
        "bee changed failed with an unrecognised error",
        "bee conversations transcript failed with an unrecognised error",
      ]);
      expect(await bee.loginState()).toBe("unknown");
      expect(log.lines.join("\n")).not.toMatch(/Peregrine|Quillfeather|chore wheel|Juniper|xxxx/);
    }
  });

  it("passes on Bee's own error sentences in fixed words, without the rest of the line", async () => {
    const messageFor = async (stderr: string) => (await thrownBy(gatewayWith(fails(stderr)).bee.changedSince(null))).message;
    const sentences: Array<[string, string]> = [
      ["Request failed with status 503 for Peregrine", "Request failed with status 503"],
      [NEVER_CONNECTED, NEVER_CONNECTED],
      [CUT_OFF, "The socket connection was closed unexpectedly."],
      ["Todo not found.", "Todo not found."],
      ["Conversation not found", "Conversation not found."],
      ["changed does not accept arguments: Peregrine", "The command does not accept arguments."],
      ["Unknown option: --peregrine", "Unknown option."],
      ["Unknown command: peregrine", "Unknown command."],
    ];
    for (const [stderr, passedOn] of sentences) expect(await messageFor(stderr), stderr).toBe(`bee changed failed: ${passedOn}`);
    // A sentence only counts at the start of the line, and a status only with three digits.
    for (const stderr of ["Peregrine says Todo not found.", "Peregrine does not accept arguments", "Request failed with status 5030", "unknown command"]) {
      expect(await messageFor(stderr), stderr).toBe("bee changed failed with an unrecognised error");
    }
  });

  it("says so plainly when the bee program cannot be started", async () => {
    const error = await thrownBy(gatewayWith(cannotStart).bee.todoStatus(11));
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("bee todos get failed: the bee program could not be started (ENOENT).");
  });

  it("passes on the code of an error from Node itself, never its message", async () => {
    // Node quotes the argument it objects to, and an argument can be to-do text or a cursor. The
    // quoted text here even reads like two of Bee's own messages.
    const nodeSays = (message: string, extra: Record<string, unknown>): Reply => () => {
      throw Object.assign(new TypeError(message), extra);
    };
    const quoted = "The argument 'args[3]' must be a string without null bytes. Received 'Peregrine is not logged in, todo not found\\x00'";

    const refusedArgument = await thrownBy(gatewayWith(nodeSays(quoted, { code: "ERR_INVALID_ARG_VALUE" })).bee.todoStatus(11));
    expect(refusedArgument.kind).toBe("failed");
    expect(refusedArgument.message).toBe("bee todos get failed: the bee program could not be started (ERR_INVALID_ARG_VALUE).");

    const tooLong = await thrownBy(gatewayWith(nodeSays("spawn E2BIG", { code: "E2BIG", syscall: "spawn" })).bee.changedSince("made-up-cursor"));
    expect(tooLong.message).toBe("bee changed failed: the bee program could not be started (E2BIG).");

    // The program was running when this went wrong, so the request may have reached Bee.
    const whileRunning = await thrownBy(gatewayWith(nodeSays("read EIO: Peregrine said so", { code: "EIO", syscall: "read" })).bee.changedSince(null));
    expect(whileRunning.kind).toBe("bad-response");
    expect(whileRunning.message).toBe("bee changed broke off before its reply could be read (EIO).");

    const oddCode = await thrownBy(gatewayWith(nodeSays("Peregrine", { code: "Peregrine said so" })).bee.changedSince(null));
    expect(oddCode.kind).toBe("bad-response");
    expect(oddCode.message).toBe("bee changed broke off before its reply could be read (UNKNOWN).");
  });

  it("never writes a flag as --flag=value", async () => {
    const { bee, calls } = gatewayWith((args) => (args[0] === "todos" ? { id: 1, completed: false } : args[0] === "changed" ? { meta: { next_cursor: "c" }, conversations: [] } : { transcript: [] }));
    await bee.loginState();
    await bee.createTodo("made up", ALARM);
    await bee.todoStatus(1);
    await bee.changedSince("cursor-one");
    await bee.transcriptSince(9001, 0);
    expect(calls).toHaveLength(5);
    // And the look-up after a create that may or may not have worked.
    const lookedUp = gatewayWith(createThenList(fails(CUT_OFF), () => listOf(listed(77, ASK))));
    await lookedUp.bee.createTodo(ASK, ALARM);
    expect(lookedUp.calls).toHaveLength(2);
    for (const args of [...calls, ...lookedUp.calls]) for (const arg of args) expect(arg).not.toMatch(/^--[a-z-]+=/);
  });
});
