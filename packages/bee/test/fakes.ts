// Synthetic test helpers. Every payload, name and sentence in these tests is made up. None of it is Bee data.
import { createLogger } from "@overnight/core";
import type { Logger } from "@overnight/core";
import type { BeeClientLike } from "../src/index.ts";

type StreamItem = { data: unknown; raw: string };
type RunJson = (args: string[], options?: { signal?: AbortSignal }) => unknown;

/** A logger that keeps every line (debug included), so tests can check what was and wasn't logged. */
export function captureLogger(): { logger: Logger; lines: string[]; messages: () => string[] } {
  const lines: string[] = [];
  const logger = createLogger({ name: "bee-test", minLevel: "debug", write: (line) => void lines.push(line) });
  return { logger, lines, messages: () => lines.map((line) => String((JSON.parse(line) as { message: unknown }).message)) };
}

/** A stream the test feeds by hand. close() behaves like the real library: the iterator throws. */
export function fakeStream() {
  const queue: StreamItem[] = [];
  let finished: { error?: Error } | null = null;
  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  const state = { closeCalls: 0 };

  const events: AsyncIterable<StreamItem> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) {
          if (finished.error) throw finished.error;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    state,
    source: {
      events,
      close: () => {
        state.closeCalls += 1;
        finished ??= { error: new Error("Bee CLI stream exited with code 1.") };
        nudge();
      },
    },
    push: (data: unknown) => {
      queue.push({ data, raw: JSON.stringify(data) });
      nudge();
    },
    /** The server ends the stream normally. */
    end: () => {
      finished ??= {};
      nudge();
    },
    /** The bee program dies with this text on standard error. */
    fail: (message: string) => {
      finished ??= { error: new Error(message) };
      nudge();
    },
  };
}

/** A client whose commands are answered by `runJson`, and whose stream is `stream` (if given). */
export function fakeClient(runJson: RunJson, stream?: ReturnType<typeof fakeStream>) {
  const calls: string[][] = [];
  const streamCalls: Array<{ types?: string[] } | undefined> = [];
  const client: BeeClientLike = {
    runJson: async <T>(args: string[], options?: { signal?: AbortSignal }) => {
      calls.push(args);
      return (await runJson(args, options)) as T;
    },
    sse: {
      streamJson: <T>(options?: { types?: string[] }) => {
        streamCalls.push(options);
        if (!stream) throw new Error("this fake has no stream");
        return stream.source as { events: AsyncIterable<{ data: T; raw: string }>; close(): void };
      },
    },
  };
  return { client, calls, streamCalls };
}

/** What the library throws when a bee command exits 1: a plain Error holding standard error. */
export function beeFailure(stderr: string): Error {
  return new Error(stderr);
}

/** Let queued stream events reach the handler. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------- made-up stream payloads, in the shapes Bee really sends ----------

export const UUID = "0f0e0d0c-1111-4222-8333-444455556666";

export function utterancePayload(id: number, text: string, spokenAt: string | number = "2026-10-09T18:00:05Z") {
  return {
    type: "new-utterance",
    conversation_uuid: UUID,
    utterance: { id, sample_id: `sample-${id}`, start: 0.4, end: 2.1, text, spoken_at: spokenAt },
  };
}

export function conversationPayload(type: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    conversation: {
      id: 9001,
      start_time: "2026-10-09T18:00:00Z",
      end_time: state === "CAPTURING" ? null : "2026-10-09T18:09:50Z",
      conversation_uuid: UUID,
      device_type: "unknown",
      device_id: null,
      summary: null,
      short_summary: null,
      state,
      primary_location: null,
      template: null,
      city: null,
      business: null,
      bookmarked: false,
      ...extra,
    },
  };
}

/** Strings that must never leave the package. Each appears somewhere in completedPayload(). */
export const PRIVATE_TEXT = [
  "Marigold",
  "Thistlewood",
  "walrus-proof umbrella",
  "the lighthouse keeper's sandwich",
  "They talked about umbrellas for walruses",
  "Walrus umbrellas",
  "Seaside Planner",
];

/** The big final event: state COMPLETED, with the transcript, both summaries and first names. */
export function completedPayload() {
  return conversationPayload("update-conversation", "COMPLETED", {
    summary: "They talked about umbrellas for walruses and nothing else.",
    short_summary: "Walrus umbrellas",
    summarization_model: null,
    key: null,
    suggested_links: [],
    suggested_templates: [{ id: "t-1", name: "Seaside Planner", category: "Planning", category_icon_name: "wave" }],
    transcriptions: [
      {
        id: 71,
        model: "made-up-model",
        realtime: false,
        transcription_time: 12,
        utterances: [
          { id: 801, sample_id: "s-1", start: 0, end: 2, text: "someone should build a walrus-proof umbrella", speaker: null, person_id: 4, person_first_name: "Marigold", spoken_at: "2026-10-09T18:00:05Z", chunk_id: 1 },
          { id: 802, sample_id: "s-1", start: 2, end: 4, text: "pass me the lighthouse keeper's sandwich", speaker: null, person_id: 5, person_first_name: "Thistlewood", spoken_at: "2026-10-09T18:00:09Z", chunk_id: 1 },
        ],
        utterance_chunks: [{ id: 1, chunk_text: "someone should build a walrus-proof umbrella pass me the lighthouse keeper's sandwich" }],
      },
    ],
  });
}
