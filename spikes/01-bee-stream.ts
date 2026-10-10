// Spike 1 and 2: does the Bee live stream deliver utterances from an Apple Watch recording,
// how late do they arrive, and do short recordings (under ~50 words) show up at all?
//
// Usage: node spikes/01-bee-stream.ts [minutes=5]
// Opens one stream per event type (see lib/util.ts for why).
// Prints one line per event: type, field shape, word count and timestamp ages. No transcript text,
// and no speaker names (speakers are only counted).
// Raw events are saved to ~/.overnight/spikes/01-stream.jsonl (never committed). That file holds
// real speech, and the COMPLETED conversation event in it holds the full transcript with names.
import { ages, bee, beeJson, firstLine, listenByType, requireLogin, saveRaw, shape, stamp, wordCount } from "./lib/util.ts";

const TYPES = [
  "connected",
  "new-utterance",
  "new-conversation",
  "update-conversation",
  "update-conversation-summary",
  "delete-conversation",
  "todo-created",
  "todo-updated",
  "todo-deleted",
];

const minutes = Number(process.argv[2] ?? 5);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("Usage: node spikes/01-bee-stream.ts [minutes=5]  (minutes must be above 0)");
  process.exit(2);
}
const client = bee();
await requireLogin(client);

type Heard = { text: string; receivedAt: number; spokenAt?: number };
const heard: Heard[] = [];
const counts: Record<string, number> = {};
const shapesShown: Record<string, number> = {};
const streamsThatDelivered = new Set<string>();
const wordsByConversation: Record<string, number> = {};
let utterancesWithSpeakerField = 0;

const listener = listenByType(client, TYPES, ({ type, stream, data, receivedAt }) => {
  saveRaw("01-stream.jsonl", { receivedAt, type, stream, data });
  counts[type] = (counts[type] ?? 0) + 1;
  if (type !== "connected") streamsThatDelivered.add(stream);

  const utterance = data.utterance as Record<string, unknown> | undefined;
  const conversation = data.conversation as Record<string, unknown> | undefined;
  // Utterances carry only the uuid; conversation events carry both the uuid and the numeric id.
  const conversationRef = String(data.conversation_uuid ?? conversation?.conversation_uuid ?? data.conversation_id ?? conversation?.id ?? "?");
  const words = wordCount(utterance?.text);
  if (utterance) {
    if (utterance.speaker !== undefined) utterancesWithSpeakerField += 1;
    wordsByConversation[conversationRef] = (wordsByConversation[conversationRef] ?? 0) + words;
    if (typeof utterance.text === "string") {
      const spokenAt = typeof utterance.spoken_at === "string" ? Date.parse(utterance.spoken_at) : NaN;
      heard.push({ text: utterance.text, receivedAt, spokenAt: Number.isNaN(spokenAt) ? undefined : spokenAt });
    }
  }

  // Show the field layout the first two times we see each type in each conversation state. (The
  // COMPLETED update-conversation event has a very different layout from the earlier ones.)
  const shapeKey = `${type}:${String(conversation?.state ?? "")}`;
  shapesShown[shapeKey] = (shapesShown[shapeKey] ?? 0) + 1;

  console.log(
    JSON.stringify({
      at: stamp(),
      type,
      stream: stream === type ? undefined : stream,
      conversation: conversationRef,
      conversationId: conversation?.id,
      state: conversation?.state,
      words: words || undefined,
      ages: ages(data, receivedAt),
      shape: shapesShown[shapeKey] <= 2 ? shape(data) : undefined,
    }),
  );
});

console.log(`${stamp()} listening for ${minutes} min on ${TYPES.length} streams. Start a recording on the watch and talk.`);
const timer = setTimeout(() => listener.close(), minutes * 60_000);
// `kill <pid>` ends the listening early but still prints the summary below.
process.once("SIGTERM", () => listener.close());
process.once("SIGINT", () => listener.close());
if ((await listener.done) > 0) process.exitCode = 1;
clearTimeout(timer);

function summary(delays: number[]): unknown {
  if (delays.length === 0) return undefined;
  const sorted = [...delays].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, minSeconds: sorted[0], medianSeconds: Number(median.toFixed(2)), maxSeconds: sorted[sorted.length - 1] };
}

// Latency, measured two ways. First: each new-utterance carries spoken_at (one-second precision).
const bySpokenAt = summary(heard.filter((h) => h.spokenAt !== undefined).map((h) => (h.receivedAt - (h.spokenAt as number)) / 1000));

// Second: match each heard line by exact text against Bee's own record from `bee now`.
// (Two identical lines would both match the first one.)
type Spoken = { text: string; spokenAt: number };
function collectSpoken(value: unknown, out: Spoken[] = []): Spoken[] {
  if (Array.isArray(value)) for (const item of value) collectSpoken(item, out);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const when = record.spoken_at ?? record.start;
    if (typeof record.text === "string" && typeof when === "number") out.push({ text: record.text, spokenAt: when });
    for (const child of Object.values(record)) collectSpoken(child, out);
  }
  return out;
}

let byBeeRecord: unknown = "no utterances heard";
if (heard.length > 0) {
  try {
    const now = await beeJson(client, ["now"], 60_000);
    saveRaw("01-stream.jsonl", { receivedAt: Date.now(), type: "(bee now, after listening)", data: now });
    const spoken = collectSpoken(now);
    const delays = heard
      .map((h) => {
        const match = spoken.find((s) => s.text === h.text);
        return match ? (h.receivedAt - match.spokenAt) / 1000 : undefined;
      })
      .filter((d): d is number => d !== undefined);
    byBeeRecord = summary(delays) ?? { matched: 0, of: heard.length, note: "no heard line matched Bee's record by exact text" };
  } catch (error) {
    byBeeRecord = { error: firstLine(error) };
  }
}

console.log(`${stamp()} done.`);
console.log(
  JSON.stringify(
    {
      eventsByType: counts,
      streamsThatDelivered: [...streamsThatDelivered].sort(),
      utterances: heard.length,
      utterancesWithSpeakerField,
      wordsByConversation,
      latencyFromSpokenAt: bySpokenAt ?? "no utterances heard",
      latencyFromBeeRecord: byBeeRecord,
    },
    null,
    2,
  ),
);
