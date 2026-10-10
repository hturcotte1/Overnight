// Spike 2 (second half): does a short recording vanish later?
//
// Usage: node spikes/02-bee-short-recording.ts [conversationId ...]
// With no ids it lists the most recent conversations (shape only) so we can pick one.
// With ids it re-fetches each one and its transcript and reports whether Bee still has it.
// Raw output is saved to ~/.overnight/spikes/02-short-recording.jsonl (never committed).
import { bee, beeJson, firstLine, requireLogin, saveRaw, shape, stamp, wordCount } from "./lib/util.ts";

const ids = process.argv.slice(2);
const client = bee();
await requireLogin(client);

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await run();
    saveRaw("02-short-recording.jsonl", { at: stamp(), label, value });
    return value;
  } catch (error) {
    const message = firstLine(error);
    saveRaw("02-short-recording.jsonl", { at: stamp(), label, error: message });
    console.log(JSON.stringify({ at: stamp(), label, ok: false, error: message }));
    return undefined;
  }
}

if (ids.length === 0) {
  const list = await attempt("conversations.list", () => beeJson(client, ["conversations", "list", "--limit", "5"]));
  if (list !== undefined) console.log(JSON.stringify({ at: stamp(), label: "conversations.list", ok: true, shape: shape(list) }, null, 2));
  const now = await attempt("now", () => beeJson(client, ["now"], 60_000));
  if (now !== undefined) console.log(JSON.stringify({ at: stamp(), label: "now", ok: true, shape: shape(now) }, null, 2));
}

for (const id of ids) {
  const conversation = await attempt(`conversations.get ${id}`, () => beeJson(client, ["conversations", "get", id]));
  if (conversation !== undefined) {
    console.log(JSON.stringify({ at: stamp(), label: `conversations.get ${id}`, ok: true, shape: shape(conversation) }, null, 2));
  }
  const transcript = await attempt(`conversations.transcript ${id}`, () => beeJson(client, ["conversations", "transcript", id]));
  if (transcript !== undefined) {
    const lines = ((transcript as { transcript?: Array<{ text?: unknown }> })?.transcript ?? []).map((line) => line?.text);
    const words = lines.reduce((sum: number, text) => sum + wordCount(text), 0);
    console.log(
      JSON.stringify({ at: stamp(), label: `conversations.transcript ${id}`, ok: true, utterances: lines.length, words, shape: shape(transcript) }, null, 2),
    );
  }
}
