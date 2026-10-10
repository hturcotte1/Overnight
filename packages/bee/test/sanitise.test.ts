// Synthetic test data. Every payload, name and sentence in this file is made up. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { sanitiseStreamPayload } from "../src/sanitise.ts";
import { toIsoUtc } from "../src/time.ts";
import { PRIVATE_TEXT, UUID, completedPayload, conversationPayload, utterancePayload } from "./fakes.ts";

const eventOf = (payload: unknown) => {
  const result = sanitiseStreamPayload(payload);
  if (!result.ok) throw new Error(`dropped: ${result.problem}`);
  return result.event;
};

describe("stream payloads that become events", () => {
  it("treats the first line, { timestamp } with no type, as the connect message", () => {
    expect(eventOf({ timestamp: 1760032800000 })).toEqual({ type: "connected" });
  });

  it("maps new-utterance and keeps only the four fields we use", () => {
    expect(eventOf(utterancePayload(501, "someone should build a chore wheel"))).toEqual({
      type: "utterance",
      beeUtteranceId: 501,
      conversationUuid: UUID,
      text: "someone should build a chore wheel",
      spokenAt: "2026-10-09T18:00:05.000Z",
    });
  });

  it("turns spoken_at into UTC whatever form it arrives in", () => {
    const spokenAt = (value: string | number) => {
      const event = eventOf(utterancePayload(1, "hello", value));
      return event.type === "utterance" ? event.spokenAt : null;
    };
    expect(spokenAt("2026-10-09T12:00:05-06:00")).toBe("2026-10-09T18:00:05.000Z");
    expect(spokenAt("2026-10-09T18:00:05.250Z")).toBe("2026-10-09T18:00:05.250Z");
    expect(spokenAt(Date.UTC(2026, 9, 9, 18, 0, 5))).toBe("2026-10-09T18:00:05.000Z");
    // No zone at all: read as UTC, not as this Mac's local time.
    expect(spokenAt("2026-10-09T18:00:05")).toBe("2026-10-09T18:00:05.000Z");
  });

  it("maps the three conversation events to their kinds", () => {
    expect(eventOf(conversationPayload("new-conversation", "CAPTURING"))).toEqual({
      type: "conversation",
      kind: "new",
      beeId: 9001,
      uuid: UUID,
      state: "CAPTURING",
      startTime: "2026-10-09T18:00:00.000Z",
      endTime: null,
    });
    expect(eventOf(conversationPayload("update-conversation", "PROCESSING"))).toMatchObject({ kind: "update", state: "PROCESSING", endTime: "2026-10-09T18:09:50.000Z" });
    expect(eventOf(conversationPayload("delete-conversation", "PROCESSING"))).toMatchObject({ kind: "delete", beeId: 9001, uuid: UUID });
  });

  it("strips the transcript, summaries and first names from the COMPLETED event", () => {
    const event = eventOf(completedPayload());
    expect(event).toEqual({
      type: "conversation",
      kind: "update",
      beeId: 9001,
      uuid: UUID,
      state: "COMPLETED",
      startTime: "2026-10-09T18:00:00.000Z",
      endTime: "2026-10-09T18:09:50.000Z",
    });
    const serialised = JSON.stringify(event);
    for (const secret of PRIVATE_TEXT) expect(serialised).not.toContain(secret);
    expect(Object.keys(event).sort()).toEqual(["beeId", "endTime", "kind", "startTime", "state", "type", "uuid"]);
  });

  it("keeps a conversation event whose optional fields are missing or odd", () => {
    expect(eventOf({ type: "update-conversation", conversation: { id: 12 } })).toEqual({
      type: "conversation",
      kind: "update",
      beeId: 12,
      uuid: null,
      state: null,
      startTime: null,
      endTime: null,
    });
    // A sentence where a state or an id should be is not passed on.
    const odd = eventOf({ type: "update-conversation", conversation: { id: 12, state: "she said the secret word", conversation_uuid: "two words", start_time: "soon", end_time: {} } });
    expect(odd).toMatchObject({ beeId: 12, uuid: null, state: null, startTime: null, endTime: null });
    expect(JSON.stringify(odd)).not.toContain("secret");
  });

  it("gives no time, not a wrong one, for text that JavaScript would guess a date from", () => {
    // JavaScript's own parser reads the first as a day in March 2001 and the second as one in May 2001.
    const guessed = eventOf({ type: "new-conversation", conversation: { id: 12, start_time: "Marigold 12", end_time: "5" } });
    expect(guessed).toMatchObject({ beeId: 12, startTime: null, endTime: null });
    expect(sanitiseStreamPayload(utterancePayload(1, "hello", "Marigold 12"))).toMatchObject({ ok: false, problem: "bad-shape", fields: "utterance.spoken_at" });
  });

  it("maps todo-deleted to the to-do's id only", () => {
    const payload = { type: "todo-deleted", todo: { id: 4242, conversationId: null, text: "💡 Build tonight? Chore wheel", completed: false, alarmAt: 1760033000000, appleId: null } };
    expect(eventOf(payload)).toEqual({ type: "todo-deleted", todoId: 4242 });
  });
});

describe("stream payloads that are dropped", () => {
  it("drops an utterance with nothing in it", () => {
    for (const text of ["", "   ", "\n\t"]) {
      expect(sanitiseStreamPayload(utterancePayload(7, text))).toEqual({ ok: false, eventType: "new-utterance", problem: "empty-text", fields: null });
    }
  });

  it("drops event types we don't handle, by name", () => {
    expect(sanitiseStreamPayload({ type: "update-conversation-summary", conversation_id: 9001, short_summary: "Walrus umbrellas" })).toEqual({
      ok: false,
      eventType: "update-conversation-summary",
      problem: "unknown-type",
      fields: null,
    });
  });

  it("is not fooled by a type named after something built into JavaScript", () => {
    for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(sanitiseStreamPayload({ type, conversation: { id: 1 } })).toMatchObject({ ok: false, problem: "unknown-type" });
    }
  });

  it("drops malformed payloads and names the fields, never the values", () => {
    expect(sanitiseStreamPayload({ type: "new-utterance", conversation_uuid: UUID, utterance: { id: "five-oh-one", text: "a walrus-proof umbrella" } })).toEqual({
      ok: false,
      eventType: "new-utterance",
      problem: "bad-shape",
      fields: "utterance.id, utterance.spoken_at",
    });
    expect(sanitiseStreamPayload({ type: "new-utterance", utterance: { id: 1, text: "hello", spoken_at: "not a time" }, conversation_uuid: UUID })).toMatchObject({ problem: "bad-shape", fields: "utterance.spoken_at" });
    expect(sanitiseStreamPayload({ type: "new-utterance", conversation_uuid: UUID })).toMatchObject({ problem: "bad-shape", fields: "utterance" });
    expect(sanitiseStreamPayload({ type: "new-conversation", conversation: { conversation_uuid: UUID } })).toMatchObject({ problem: "bad-shape", fields: "conversation.id" });
    expect(sanitiseStreamPayload({ type: "delete-conversation" })).toMatchObject({ problem: "bad-shape", fields: "conversation" });
    expect(sanitiseStreamPayload({ type: "todo-deleted", todo: { id: 1.5 } })).toMatchObject({ problem: "bad-shape", fields: "todo.id" });
    expect(sanitiseStreamPayload({ note: "no type and no timestamp" })).toEqual({ ok: false, eventType: "(none)", problem: "bad-shape", fields: "timestamp" });
  });

  it("drops things that are not objects, without throwing", () => {
    for (const payload of [null, undefined, 42, "someone said this", true, [], [utterancePayload(1, "hello")]]) {
      expect(sanitiseStreamPayload(payload)).toEqual({ ok: false, eventType: "(none)", problem: "not-an-object", fields: null });
    }
  });

  it("never repeats a type that does not look like an event name", () => {
    for (const type of ["Marigold said someone should build it", "new-utterance\nMarigold", 17, { name: "Marigold" }, "x".repeat(80)]) {
      const result = sanitiseStreamPayload({ type, utterance: { text: "Marigold" } });
      expect(result).toEqual({ ok: false, eventType: "(unreadable)", problem: "unknown-type", fields: null });
    }
  });
});

describe("toIsoUtc", () => {
  it("gives null for anything that is not a usable time", () => {
    for (const value of [null, undefined, "", "  ", "yesterday", Number.NaN, Number.POSITIVE_INFINITY, 9e15 * 10, {}, true]) expect(toIsoUtc(value)).toBeNull();
  });

  it("reads epoch milliseconds and ISO strings", () => {
    expect(toIsoUtc(1760032805000)).toBe("2025-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09 18:00:05")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09T18:00:05+00:00")).toBe("2026-10-09T18:00:05.000Z");
  });

  it("reads only ISO dates and times, not everything JavaScript would guess at", () => {
    const notIso = ["5", "Marigold 12", "10/09/2026 6:00 PM", "Oct 9, 2026", "Fri, 09 Oct 2026 18:00:05 GMT", "2026", "2026-10", "20261009T180005Z", "2026-10-09T18", "2026-10-09T18:00:05 UTC", "2026-10-09T18:00:05+5", "1760032805000"];
    for (const value of notIso) expect(toIsoUtc(value), value).toBeNull();
    // The right shape, but not a real date or time. JavaScript would roll 30 February into March.
    const notOnTheCalendar = ["2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "2026-13-01T10:00:00Z", "2026-00-10T10:00:00Z", "2026-10-00T10:00:00Z", "2026-10-32T10:00:00Z", "2026-10-09T25:00:00Z", "2026-10-09T18:61:00Z", "0026-10-09T18:00:05Z"];
    for (const value of notOnTheCalendar) expect(toIsoUtc(value), value).toBeNull();
  });

  it("reads the zone however it is written, and takes UTC when there is none", () => {
    expect(toIsoUtc("2026-10-09T18:00:05Z")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09T12:00:05-06:00")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09T12:00:05-0600")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09T23:30:05+05:30")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09T18:00:05.123456Z")).toBe("2026-10-09T18:00:05.123Z");
    expect(toIsoUtc("2026-10-09T18:00:05.25")).toBe("2026-10-09T18:00:05.250Z");
    expect(toIsoUtc("2026-10-09T18:00")).toBe("2026-10-09T18:00:00.000Z");
    expect(toIsoUtc("  2026-10-09T18:00:05  ")).toBe("2026-10-09T18:00:05.000Z");
    expect(toIsoUtc("2026-10-09")).toBe("2026-10-09T00:00:00.000Z");
    expect(toIsoUtc("2028-02-29T10:00:00Z")).toBe("2028-02-29T10:00:00.000Z");
  });

  it("reads a number as milliseconds, or as seconds when it is too small to be milliseconds", () => {
    expect(toIsoUtc(1760032805)).toBe("2025-10-09T18:00:05.000Z");
    expect(toIsoUtc(1760032805.5)).toBe("2025-10-09T18:00:05.500Z");
    expect(toIsoUtc(1e11)).toBe("1973-03-03T09:46:40.000Z");
    expect(toIsoUtc(1e11 - 1)).toBe("5138-11-16T09:46:39.000Z");
    expect(toIsoUtc(1e9)).toBe("2001-09-09T01:46:40.000Z");
    // Too small to be a time from Bee in either unit. A 1970 date would be a wrong time, not a missing one.
    for (const value of [0, 1, 12, 1760, 999_999_999, -1760032805000, -1]) expect(toIsoUtc(value), String(value)).toBeNull();
  });
});
