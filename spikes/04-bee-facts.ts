// Spike 4: do `bee facts list`, `search` and `create` work?
//
// Usage: node spikes/04-bee-facts.ts            (read only: list + search)
//        node spikes/04-bee-facts.ts --create   (also writes ONE clearly labelled test fact)
// Prints shapes and counts only. Raw output goes to ~/.overnight/spikes/04-facts.jsonl (never committed).
import { bee, requireLogin, saveRaw, shape, stamp } from "./lib/util.ts";

const create = process.argv.includes("--create");
const client = bee();
await requireLogin(client);

async function step(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    saveRaw("04-facts.jsonl", { at: stamp(), label, value });
    console.log(JSON.stringify({ at: stamp(), label, ok: true, shape: shape(value) }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveRaw("04-facts.jsonl", { at: stamp(), label, error: message });
    console.log(JSON.stringify({ at: stamp(), label, ok: false, error: message.slice(0, 300) }));
    process.exitCode = 1;
  }
}

await step("facts.list", () => client.api.facts.list({ limit: 5 }));
await step("facts.list --unconfirmed", () => client.api.facts.list({ limit: 5, unconfirmed: true }));
// The library has no facts search helper, so call the CLI command through runJson.
await step("facts.search", () => client.runJson(["facts", "search", "--query", "prefers", "--limit", "5"]));

if (create) {
  await step("facts.create", () => client.api.facts.create("Overnight test fact (safe to delete)."));
  await step("facts.list after create", () => client.api.facts.list({ limit: 5 }));
  await step("facts.list --unconfirmed after create", () => client.api.facts.list({ limit: 5, unconfirmed: true }));
}
