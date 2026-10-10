// Synthetic test data. Every payload, name and sentence in this file is made up. None of it is Bee data.
import { describe, expect, it } from "vitest";
import type { BeeEvent, Logger } from "@overnight/core";
import { DEFAULT_STREAM_TYPES, createBeeGateway } from "../src/index.ts";
import type { BeeClientLike } from "../src/index.ts";
import { PRIVATE_TEXT, UUID, captureLogger, completedPayload, conversationPayload, fakeClient, fakeStream, settle, utterancePayload } from "./fakes.ts";

function open(options: { streamTypes?: string[]; onEvent?: (event: BeeEvent) => void } = {}) {
  const feed = fakeStream();
  const { client, streamCalls } = fakeClient(() => null, feed);
  const log = captureLogger();
  const events: BeeEvent[] = [];
  const gateway = createBeeGateway({ client, logger: log.logger, streamTypes: options.streamTypes });
  const stream = gateway.stream(options.onEvent ?? ((event) => void events.push(event)));
  return { feed, stream, events, log, streamCalls };
}

describe("the live stream", () => {
  it("opens one stream for all five event types", () => {
    const { streamCalls } = open();
    expect(streamCalls).toEqual([{ types: ["new-utterance", "new-conversation", "update-conversation", "delete-conversation", "todo-deleted"] }]);
    expect(DEFAULT_STREAM_TYPES).toHaveLength(5);
  });

  it("asks for other event types when told to", () => {
    expect(open({ streamTypes: ["new-utterance"] }).streamCalls).toEqual([{ types: ["new-utterance"] }]);
  });

  it("delivers events in the order they arrive", async () => {
    const { feed, events } = open();
    feed.push({ timestamp: 1760032800000 });
    feed.push(conversationPayload("new-conversation", "CAPTURING"));
    feed.push(utterancePayload(1, "it would be cool if the fridge kept a list"));
    feed.push(utterancePayload(2, "of what is about to go off"));
    feed.push({ type: "todo-deleted", todo: { id: 77, conversationId: null, text: "made-up to-do", completed: false, alarmAt: 1760033000000, appleId: null } });
    feed.push(conversationPayload("delete-conversation", "PROCESSING"));
    await settle();
    expect(events.map((event) => event.type)).toEqual(["connected", "conversation", "utterance", "utterance", "todo-deleted", "conversation"]);
    expect(events[2]).toEqual({ type: "utterance", beeUtteranceId: 1, conversationUuid: UUID, text: "it would be cool if the fridge kept a list", spokenAt: "2026-10-09T18:00:05.000Z" });
    expect(events[4]).toEqual({ type: "todo-deleted", todoId: 77 });
  });

  it("lets none of the COMPLETED event's transcript, summaries or names out, in events or in logs", async () => {
    const { feed, events, log, stream } = open();
    feed.push(completedPayload());
    // The same private text again, in payloads that get dropped rather than mapped.
    feed.push({ type: "update-conversation", conversation: { ...completedPayload().conversation, id: "not a number" } });
    feed.push({ type: "update-conversation-summary", conversation_id: 9001, short_summary: "Walrus umbrellas" });
    feed.end();
    expect(await stream.done).toEqual({ reason: "ended" });

    expect(events).toEqual([{ type: "conversation", kind: "update", beeId: 9001, uuid: UUID, state: "COMPLETED", startTime: "2026-10-09T18:00:00.000Z", endTime: "2026-10-09T18:09:50.000Z" }]);
    const everything = JSON.stringify(events) + log.lines.join("\n");
    for (const secret of PRIVATE_TEXT) expect(everything).not.toContain(secret);
    expect(log.lines.length).toBeGreaterThan(0);
  });

  it("drops unknown and malformed payloads with a log line, and carries on", async () => {
    const { feed, events, log } = open();
    feed.push({ type: "update-conversation-summary", conversation_id: 9001, short_summary: "made-up summary" });
    feed.push({ type: "new-utterance", conversation_uuid: UUID, utterance: { id: "nope", text: "a made-up sentence", spoken_at: "2026-10-09T18:00:05Z" } });
    feed.push("not even an object");
    feed.push(null);
    feed.push(utterancePayload(3, "   "));
    feed.push(utterancePayload(4, "still here"));
    await settle();

    expect(events).toEqual([{ type: "utterance", beeUtteranceId: 4, conversationUuid: UUID, text: "still here", spokenAt: "2026-10-09T18:00:05.000Z" }]);
    const drops = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.message === "Dropped a Bee stream event");
    expect(drops.map((line) => [line.level, line.eventType, line.problem, line.fields])).toEqual([
      ["warn", "update-conversation-summary", "unknown-type", undefined],
      ["warn", "new-utterance", "bad-shape", "utterance.id"],
      ["warn", "(none)", "not-an-object", undefined],
      ["warn", "(none)", "not-an-object", undefined],
      ["debug", "new-utterance", "empty-text", undefined],
    ]);
    const logged = log.lines.join("\n");
    for (const text of ["made-up summary", "a made-up sentence", "not even an object", "still here"]) expect(logged).not.toContain(text);
  });

  it("keeps going when the handler throws, and logs neither the event nor the error's own words", async () => {
    const seen: number[] = [];
    const { feed, log, stream } = open({
      onEvent: (event) => {
        if (event.type !== "utterance") return;
        seen.push(event.beeUtteranceId);
        // The handler is the code that holds what was said, so its error can quote it.
        if (event.beeUtteranceId === 1) throw new RangeError(`could not save the line "${event.text}"`);
      },
    });
    feed.push(utterancePayload(1, "why isn't there a tide clock for the kitchen"));
    feed.push(utterancePayload(2, "second line"));
    await settle();
    expect(seen).toEqual([1, 2]);

    const failures = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: "A Bee event handler failed", eventType: "utterance", errorName: "RangeError" });
    expect(failures[0]).not.toHaveProperty("error");
    expect(log.lines.join("\n")).not.toMatch(/tide clock|could not save/);

    feed.end();
    expect(await stream.done).toEqual({ reason: "ended" });
  });

  it("keeps going when an async handler rejects", async () => {
    const seen: number[] = [];
    const handler = async (event: BeeEvent): Promise<void> => {
      if (event.type !== "utterance") return;
      seen.push(event.beeUtteranceId);
      throw new Error("async trip");
    };
    const { feed, log } = open({ onEvent: (event) => handler(event) as unknown as void });
    feed.push(utterancePayload(1, "first"));
    feed.push(utterancePayload(2, "second"));
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(log.messages().filter((message) => message === "A Bee event handler failed")).toHaveLength(2);
    expect(log.lines.join("\n")).not.toContain("async trip");
  });

  it("logs what kind of thing a handler threw, even when it is not an error or has an odd name", async () => {
    const thrown: unknown[] = ["a made-up sentence somebody said", Object.assign(new Error("made up"), { name: "Marigold said someone should build it" }), null];
    const { feed, log } = open({
      onEvent: () => {
        throw thrown.shift();
      },
    });
    for (let id = 1; id <= 3; id += 1) feed.push(utterancePayload(id, "made-up line"));
    await settle();
    const names = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === "error").map((line) => line.errorName);
    expect(names).toEqual(["string", "Error", "object"]);
    expect(log.lines.join("\n")).not.toMatch(/somebody said|Marigold/);
  });

  it('ends with reason "closed" when the caller closes it', async () => {
    const { feed, stream, events, log } = open();
    feed.push(utterancePayload(1, "before closing"));
    await settle();
    // A second line is already on its way when the caller closes. It must not be delivered.
    feed.push(utterancePayload(2, "too late"));
    stream.close();
    stream.close();
    expect(await stream.done).toEqual({ reason: "closed" });
    expect(feed.state.closeCalls).toBe(1);
    await settle();
    expect(events).toHaveLength(1);
    expect(log.messages().filter((message) => message === "Bee stream over")).toHaveLength(1);
  });

  it('ends with reason "ended" when the server ends it', async () => {
    const { feed, stream } = open();
    feed.push({ timestamp: 1 });
    feed.end();
    expect(await stream.done).toEqual({ reason: "ended" });
  });

  it('ends with reason "error" and the first line only when the bee program dies', async () => {
    const { feed, stream, log } = open();
    feed.fail("Something went wrong on the way.\nUsage: bee stream [--types a,b]\n  more help text");
    expect(await stream.done).toEqual({ reason: "error", message: "Something went wrong on the way." });
    const over = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.message === "Bee stream over");
    expect(over).toMatchObject({ reason: "error", error: "Something went wrong on the way.", delivered: 0, dropped: 0 });
  });

  it("does not pass on an error that looks like data", async () => {
    const { feed, stream } = open();
    feed.fail('{"conversation":{"summary":"Walrus umbrellas"}}');
    expect(await stream.done).toEqual({ reason: "error", message: "no error message" });
  });

  it("reports an error, without rejecting, when the stream cannot even be opened", async () => {
    const { client } = fakeClient(() => null);
    const stream = createBeeGateway({ client }).stream(() => {});
    expect(await stream.done).toEqual({ reason: "error", message: "this fake has no stream" });
    stream.close();
  });
});

describe("the live stream with a logger that throws", () => {
  /** A logger whose every call fails, the way a full disk or a broken collector would make it. */
  const brokenLogger = (): { logger: Logger; calls: () => number } => {
    let calls = 0;
    const broken = (): never => {
      calls += 1;
      throw new Error("made-up: disk full");
    };
    return { logger: { debug: broken, info: broken, warn: broken, error: broken, child: broken }, calls: () => calls };
  };

  function openBroken(onEvent: (event: BeeEvent) => void = () => {}) {
    const feed = fakeStream();
    const { client } = fakeClient(() => null, feed);
    const { logger, calls } = brokenLogger();
    // If stream() threw here, the bee program it had already started would never be stopped.
    const stream = createBeeGateway({ client, logger }).stream(onEvent);
    return { feed, stream, calls };
  }

  it("still opens, delivers events and says \"ended\" when the server ends it", async () => {
    const events: BeeEvent[] = [];
    const { feed, stream, calls } = openBroken((event) => {
      events.push(event);
      throw new Error("the handler tripped as well");
    });
    feed.push({ type: "update-conversation-summary", conversation_id: 9001, short_summary: "made-up summary" });
    feed.push(utterancePayload(1, "made-up line"));
    feed.push(utterancePayload(2, "another made-up line"));
    feed.end();
    expect(await stream.done).toEqual({ reason: "ended" });
    expect(events.map((event) => event.type)).toEqual(["utterance", "utterance"]);
    // Opened, one dropped event, two failed handlers, over: the logger was really being called.
    expect(calls()).toBe(5);
  });

  it("still says \"closed\", and close() does not throw", async () => {
    const { feed, stream } = openBroken();
    expect(() => stream.close()).not.toThrow();
    expect(await stream.done).toEqual({ reason: "closed" });
    expect(feed.state.closeCalls).toBe(1);
  });

  it("still says \"error\" when the bee program dies, and when the stream cannot be opened", async () => {
    const { feed, stream } = openBroken();
    feed.fail("Something went wrong on the way.");
    expect(await stream.done).toEqual({ reason: "error", message: "Something went wrong on the way." });

    const { client } = fakeClient(() => null);
    const unopened = createBeeGateway({ client, logger: brokenLogger().logger }).stream(() => {});
    expect(await unopened.done).toEqual({ reason: "error", message: "this fake has no stream" });
  });
});

describe("how the stream's output is decoded", () => {
  /** A client whose stream comes with a child process, as the real library's does. */
  function clientWithProcess(stdout: { setEncoding?: (encoding: "utf8") => unknown } | null | undefined) {
    const feed = fakeStream();
    // Cast as a whole: the fake's events are typed `unknown`, the library's by the caller.
    const client = {
      runJson: async () => null,
      sse: { streamJson: () => ({ ...feed.source, process: { exited: Promise.resolve(0), stdout } }) },
    } as unknown as BeeClientLike;
    return { feed, client };
  }

  it("tells the bee program's output pipe that it carries UTF-8, before reading anything", async () => {
    const order: string[] = [];
    const { feed, client } = clientWithProcess({ setEncoding: (encoding) => void order.push(`setEncoding ${encoding}`) });
    const stream = createBeeGateway({ client }).stream((event) => void order.push(event.type));
    feed.push({ timestamp: 1760032800000 });
    feed.end();
    await stream.done;
    expect(order).toEqual(["setEncoding utf8", "connected"]);
  });

  it("carries on when the pipe is missing, cannot be told, or refuses", async () => {
    const refuses = {
      setEncoding: () => {
        throw new Error("made-up: not that kind of pipe");
      },
    };
    for (const stdout of [null, undefined, {}, refuses]) {
      const { feed, client } = clientWithProcess(stdout);
      const events: BeeEvent[] = [];
      const stream = createBeeGateway({ client }).stream((event) => void events.push(event));
      feed.push(utterancePayload(1, "made-up line"));
      feed.end();
      expect(await stream.done).toEqual({ reason: "ended" });
      expect(events).toHaveLength(1);
    }
  });
});
