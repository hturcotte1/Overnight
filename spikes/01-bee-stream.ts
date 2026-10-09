// Spike 1 and 2: does the Bee live stream deliver utterances from an Apple Watch recording,
// how late do they arrive, and do short recordings (under ~50 words) show up at all?
//
// Usage: node spikes/01-bee-stream.ts [minutes=5]
// Prints one line per event: kind, field shape, word count and timestamp ages. No transcript text.
// Raw events are saved to ~/.overnight/spikes/01-stream.jsonl (never committed).
import { ages, bee, requireLogin, saveRaw, shape, stamp, wordCount } from "./lib/util.ts";

const TYPES = [
  "new-utterance",
  "new-conversation",
  "update-conversation",
  "todo-created",
  "todo-updated",
  "todo-deleted",
];

const minutes = Number(process.argv[2] ?? 5);
const client = bee();
await requireLogin(client);

const stream = client.sse.streamJson<Record<string, unknown>>({ types: TYPES });
// Closing kills the `bee stream` child, which the library reports as a non-zero exit.
let closedByUs = false;
const timer = setTimeout(() => {
  closedByUs = true;
  stream.close();
}, minutes * 60_000);
console.log(`${stamp()} listening for ${minutes} min. Start a recording on the watch and talk.`);

const counts: Record<string, number> = {};
const wordsByConversation: Record<string, number> = {};
let events = 0;

try {
  for await (const { data } of stream.events) {
    const receivedAt = Date.now();
    events += 1;
    saveRaw("01-stream.jsonl", { receivedAt, data });

    const kind = Object.keys(data).sort().join("+") || "(empty)";
    counts[kind] = (counts[kind] ?? 0) + 1;

    const utterance = data.utterance as Record<string, unknown> | undefined;
    const words = wordCount(utterance?.text);
    const conversationId = String(
      (data.conversation_id ?? utterance?.conversation_id ?? (data.conversation as Record<string, unknown> | undefined)?.id) ?? "?",
    );
    if (words > 0) wordsByConversation[conversationId] = (wordsByConversation[conversationId] ?? 0) + words;

    console.log(
      JSON.stringify({
        at: stamp(),
        keys: kind,
        conversation: conversationId,
        words: words || undefined,
        ages: ages(data, receivedAt),
        shape: counts[kind] === 1 ? shape(data) : undefined,
      }),
    );
  }
} catch (error) {
  if (!closedByUs) {
    console.error(`${stamp()} stream ended with an error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}

console.log(`${stamp()} done. ${events} events.`);
console.log(JSON.stringify({ eventsByKeys: counts, wordsByConversation }, null, 2));
