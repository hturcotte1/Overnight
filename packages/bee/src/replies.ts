// Reads the replies of the bee commands we use and keeps only what the product needs.
//
// Several replies are much bigger than what we take from them: `bee changed` and
// `bee conversations transcript` include full transcripts and speaker names. zod discards every
// field a schema does not name, and nothing here logs or returns a raw reply.
import { z } from "zod";
import { BeeError } from "@overnight/core";
import type { BackfillUtterance, ChangedSince } from "@overnight/core";
import { issuePaths } from "./sanitise.ts";
import { toEpochMs, toIsoUtc } from "./time.ts";

const wholeNumber = z.number().int();

function parseReply<T>(label: string, schema: z.ZodType<T>, reply: unknown): T {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) {
    throw new BeeError("bad-response", `bee ${label} returned a reply we could not read (${issuePaths(parsed.error)}).`);
  }
  return parsed.data;
}

// Bee has answered to-do commands both ways: a bare to-do, and one wrapped as { todo: {...} }.
function unwrapTodo(reply: unknown): unknown {
  if (typeof reply !== "object" || reply === null || !("todo" in reply)) return reply;
  return typeof reply.todo === "object" && reply.todo !== null ? reply.todo : reply;
}

const createdTodo = z.object({ id: wholeNumber });
const todoState = z.object({ completed: z.boolean() });

export function parseCreatedTodo(reply: unknown): { id: number } {
  return { id: parseReply("todos create", createdTodo, unwrapTodo(reply)).id };
}

export function parseTodoCompleted(reply: unknown): boolean {
  return parseReply("todos get", todoState, unwrapTodo(reply)).completed;
}

// `bee todos list` as seen on 2026-10-09: { todos: [{ id, text, completed, created_at (epoch ms),
// alarm_at, corrections }], next_cursor, timezone }, newest first, completed ones included.
const todoList = z.object({ todos: z.array(z.unknown()) });
const listedTodo = z.object({ id: wholeNumber, text: z.string(), completed: z.boolean(), created_at: z.number() });

// Bee may tidy the text it stores. Spaces at the ends and the way an accent is encoded do not
// make it a different to-do.
const sameText = (a: string, b: string): boolean => a.normalize("NFC").trim() === b.normalize("NFC").trim();

/**
 * The id of the open to-do that has exactly this text and was created at or after `notBeforeMs`,
 * or null if there is none. With several, the newest.
 *
 * This is how createTodo finds a to-do whose "created" reply never reached us. The list holds the
 * text of every recent to-do, Bee's own included, so only the one id leaves this function.
 */
export function findOpenTodo(reply: unknown, text: string, notBeforeMs: number): number | null {
  const parsed = parseReply("todos list", todoList, reply);
  let newest: { id: number; createdMs: number } | null = null;
  for (const item of parsed.todos) {
    const todo = listedTodo.safeParse(item);
    if (!todo.success || todo.data.completed || !sameText(todo.data.text, text)) continue;
    const createdMs = toEpochMs(todo.data.created_at);
    if (createdMs === null || createdMs < notBeforeMs) continue;
    if (newest === null || createdMs > newest.createdMs) newest = { id: todo.data.id, createdMs };
  }
  return newest?.id ?? null;
}

const changedReply = z.object({
  meta: z.object({ next_cursor: z.string().min(1).nullish() }).nullish(),
  conversations: z.array(z.unknown()).nullish(),
});
const changedConversation = z.object({ id: wholeNumber });

/** `skipped` counts conversations without a readable id. One of those must not hide the others. */
export function parseChanged(reply: unknown): ChangedSince & { skipped: number } {
  const parsed = parseReply("changed", changedReply, reply);
  const ids = new Set<number>();
  let skipped = 0;
  for (const item of parsed.conversations ?? []) {
    const conversation = changedConversation.safeParse(item);
    if (conversation.success) ids.add(conversation.data.id);
    else skipped += 1;
  }
  return { nextCursor: parsed.meta?.next_cursor ?? null, conversationIds: [...ids], skipped };
}

const transcriptReply = z.object({ transcript: z.array(z.unknown()) });
// `speaker` is deliberately absent: it is a person's first name.
const transcriptLine = z.object({
  id: wholeNumber.nullable().catch(null),
  text: z.string(),
  spoken_at: z.union([z.string(), z.number()]),
});

/**
 * Lines spoken at or after `sinceMs`, oldest first. `skipped` counts lines with no text or no
 * usable time. We filter by time ourselves as well as asking Bee to, so the promise in the
 * BeeGateway interface holds whatever `--since` turns out to mean on Bee's side.
 */
export function parseTranscript(reply: unknown, sinceMs: number): { lines: BackfillUtterance[]; skipped: number } {
  const parsed = parseReply("conversations transcript", transcriptReply, reply);
  const lines: BackfillUtterance[] = [];
  let skipped = 0;
  for (const item of parsed.transcript) {
    const line = transcriptLine.safeParse(item);
    const text = line.success ? line.data.text.trim() : "";
    const spokenAt = line.success ? toIsoUtc(line.data.spoken_at) : null;
    if (!line.success || text === "" || spokenAt === null) {
      skipped += 1;
      continue;
    }
    if (Date.parse(spokenAt) < sinceMs) continue;
    lines.push({ beeUtteranceId: line.data.id, text, spokenAt });
  }
  lines.sort((a, b) => Date.parse(a.spokenAt) - Date.parse(b.spokenAt));
  return { lines, skipped };
}
