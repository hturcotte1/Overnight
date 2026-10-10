// The privacy boundary for Bee's live stream.
//
// One raw payload goes in; a small BeeEvent comes out, or a note saying why it was dropped.
// Bee's final "update-conversation" event (state COMPLETED) carries the whole transcript, two
// summaries and people's first names. None of that may leave this package. So nothing is copied
// across by default: each schema below names the few fields we keep, and zod discards the rest.
import { z } from "zod";
import type { BeeEvent } from "@overnight/core";
import { toIsoUtc } from "./time.ts";

const wholeNumber = z.number().int();
const timeValue = z.union([z.string(), z.number()]);
// Ids and states are single tokens. Refusing anything with a space in it means a sentence can
// never ride along in a field we treat as safe to store and log.
const token = z.string().regex(/^\S{1,200}$/);
const stateName = z.string().regex(/^[A-Za-z][A-Za-z_-]{0,39}$/);

const connectLine = z.object({ timestamp: z.number() });

const utterancePayload = z.object({
  conversation_uuid: token,
  utterance: z.object({ id: wholeNumber, text: z.string(), spoken_at: timeValue }),
});

// Only the numeric id is required: it is what every Bee command takes. The other fields fall back
// to null, so one odd value cannot cost us the uuid-to-id mapping.
const conversationPayload = z.object({
  conversation: z.object({
    id: wholeNumber,
    conversation_uuid: token.nullable().catch(null),
    state: stateName.nullable().catch(null),
    start_time: timeValue.nullable().catch(null),
    end_time: timeValue.nullable().catch(null),
  }),
});

const todoDeletedPayload = z.object({ todo: z.object({ id: wholeNumber }) });

// A Map, not a plain object: a type named "constructor" must not find anything here.
const CONVERSATION_KINDS = new Map<string, "new" | "update" | "delete">([
  ["new-conversation", "new"],
  ["update-conversation", "update"],
  ["delete-conversation", "delete"],
]);

export type DropProblem = "not-an-object" | "unknown-type" | "bad-shape" | "empty-text";

export type Sanitised =
  | { ok: true; event: BeeEvent }
  | {
      ok: false;
      /** Bee's event name, or "(none)" / "(unreadable)". Safe to log. */
      eventType: string;
      problem: DropProblem;
      /** Names of the fields that were wrong (never their values), or null. Safe to log. */
      fields: string | null;
    };

/** The dotted names of the fields zod rejected. Field names only: an issue's message is not used. */
export function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => (issue.path.length === 0 ? "(whole reply)" : issue.path.map(String).join(".")));
  return [...new Set(paths)].slice(0, 10).join(", ");
}

// An event name is logged, so it must look like one. Anything else could be arbitrary text.
function safeEventType(value: unknown): string {
  if (value === undefined) return "(none)";
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,48}$/.test(value) ? value : "(unreadable)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turn one raw stream payload into a BeeEvent. Never throws. */
export function sanitiseStreamPayload(data: unknown): Sanitised {
  if (!isRecord(data)) return { ok: false, eventType: "(none)", problem: "not-an-object", fields: null };
  const eventType = safeEventType(data.type);
  const badShape = (error: z.ZodError): Sanitised => ({ ok: false, eventType, problem: "bad-shape", fields: issuePaths(error) });

  // The first line on every stream is { timestamp } with no type: Bee's "you are connected".
  if (data.type === undefined) {
    const parsed = connectLine.safeParse(data);
    return parsed.success ? { ok: true, event: { type: "connected" } } : badShape(parsed.error);
  }

  if (eventType === "new-utterance") {
    const parsed = utterancePayload.safeParse(data);
    if (!parsed.success) return badShape(parsed.error);
    const { utterance, conversation_uuid: conversationUuid } = parsed.data;
    const text = utterance.text.trim();
    if (text === "") return { ok: false, eventType, problem: "empty-text", fields: null };
    const spokenAt = toIsoUtc(utterance.spoken_at);
    if (spokenAt === null) return { ok: false, eventType, problem: "bad-shape", fields: "utterance.spoken_at" };
    return { ok: true, event: { type: "utterance", beeUtteranceId: utterance.id, conversationUuid, text, spokenAt } };
  }

  const kind = CONVERSATION_KINDS.get(eventType);
  if (kind !== undefined) {
    const parsed = conversationPayload.safeParse(data);
    if (!parsed.success) return badShape(parsed.error);
    const conversation = parsed.data.conversation;
    return {
      ok: true,
      event: {
        type: "conversation",
        kind,
        beeId: conversation.id,
        uuid: conversation.conversation_uuid,
        state: conversation.state,
        startTime: toIsoUtc(conversation.start_time),
        endTime: toIsoUtc(conversation.end_time),
      },
    };
  }

  if (eventType === "todo-deleted") {
    const parsed = todoDeletedPayload.safeParse(data);
    return parsed.success ? { ok: true, event: { type: "todo-deleted", todoId: parsed.data.todo.id } } : badShape(parsed.error);
  }

  return { ok: false, eventType, problem: "unknown-type", fields: null };
}
