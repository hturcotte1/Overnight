// Spike 4: do `bee facts list`, `search` and `create` work?
//
// Usage: node spikes/04-bee-facts.ts            (read only: list + search)
//        node spikes/04-bee-facts.ts --create   (also writes ONE clearly labelled test fact)
// Prints shapes and counts only. Raw output goes to ~/.overnight/spikes/04-facts.jsonl (never committed).
import { bee, beeJson, firstLine, requireLogin, saveRaw, shape, stamp } from "./lib/util.ts";

const create = process.argv.includes("--create");
const client = bee();
await requireLogin(client);

async function step(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    saveRaw("04-facts.jsonl", { at: stamp(), label, value });
    console.log(JSON.stringify({ at: stamp(), label, ok: true, shape: shape(value) }, null, 2));
  } catch (error) {
    const message = firstLine(error);
    saveRaw("04-facts.jsonl", { at: stamp(), label, error: message });
    console.log(JSON.stringify({ at: stamp(), label, ok: false, error: message }));
    process.exitCode = 1;
  }
}

const list = ["facts", "list", "--limit", "5"];
await step("facts.list", () => beeJson(client, list));
await step("facts.list --unconfirmed", () => beeJson(client, [...list, "--unconfirmed"]));
await step("facts.search", () => beeJson(client, ["facts", "search", "--query", "prefers", "--limit", "5"]));

if (create) {
  await step("facts.create", () => beeJson(client, ["facts", "create", "--text", "Overnight test fact (safe to delete)."]));
  await step("facts.list after create", () => beeJson(client, list));
  await step("facts.list --unconfirmed after create", () => beeJson(client, [...list, "--unconfirmed"]));
}
