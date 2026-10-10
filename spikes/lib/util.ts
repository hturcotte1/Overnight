// Shared helpers for the M0 spikes.
// Spikes print the *shape* of what Bee returns (field names and types), never the words
// that were said. Raw output goes to ~/.overnight/spikes/, which is outside the repo.
import { createBeeClient, type BeeClient } from "@beeai/cli/lib";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function spikeDataDir(): string {
  const base = process.env.OVERNIGHT_DATA_DIR || path.join(homedir(), ".overnight");
  const dir = path.join(base, "spikes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The library only spawns a `bee` program found on PATH. Point it straight at the platform
// binary inside node_modules instead: that works without PATH (launchd agents do not read shell
// profiles), and it skips the Node shim in bin/bee.js, which does not pass kill signals on to the
// real process.
export function beeBinary(): string {
  const platform = { darwin: "mac", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch as string];
  if (!platform || !arch) throw new Error(`Bee CLI has no binary for ${process.platform} ${process.arch}`);
  const name = platform === "windows" ? "bee.exe" : "bee";
  return path.join(repoRoot, "node_modules", "@beeai", "cli", "dist", "platforms", `${platform}-${arch}`, name);
}

export function bee(): BeeClient {
  return createBeeClient({ command: beeBinary() });
}

// Every Bee call gets a time limit. The library's api.* helpers take no options (so no timeout
// can be passed to them), which is why the spikes call the CLI through this instead.
export async function beeJson<T = unknown>(client: BeeClient, args: string[], timeoutMs = 30_000): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await client.runJson<T>(args, { signal });
  } catch (error) {
    if (signal.aborted) throw new Error(`bee ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs / 1000} s`);
    throw error;
  }
}

export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
}

export async function requireLogin(client: BeeClient): Promise<void> {
  if (!existsSync(beeBinary())) {
    console.error(`Bee CLI binary not found at ${beeBinary()}. Run \`npm install\` first.`);
    process.exit(2);
  }
  try {
    // `bee me` returns the account holder's profile. We only care that it succeeds; never print it.
    await beeJson(client, ["me"]);
  } catch (error) {
    const reason = firstLine(error);
    console.error(
      /not logged in/i.test(reason)
        ? "Bee is not logged in on this Mac yet. Run `node spikes/00-bee-login.ts` first (needs the phone with the Bee app)."
        : `Could not check the Bee login: ${reason}`,
    );
    process.exit(2);
  }
}

export function saveRaw(file: string, value: unknown): string {
  const target = path.join(spikeDataDir(), file);
  appendFileSync(target, JSON.stringify(value) + "\n", { mode: 0o600 });
  return target;
}

// Describe a value without revealing its content: {text: "string(42)", id: "number"}.
export function shape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : [`array(${value.length}) of`, shape(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    if (depth > 5) return "object";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shape(v, depth + 1)]),
    );
  }
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

export function wordCount(text: unknown): number {
  return typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

// Find every field that looks like a timestamp and say how long ago it was.
export function ages(value: unknown, now = Date.now(), prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      if (!Array.isArray(v)) Object.assign(out, ages(v, now, key));
      continue;
    }
    if (!/time|date|_at$|At$|start|end|created|updated/i.test(k)) continue;
    let ms: number | undefined;
    if (typeof v === "number") ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined;
    else if (typeof v === "string" && !Number.isNaN(Date.parse(v))) ms = Date.parse(v);
    if (ms !== undefined) out[key] = `${((now - ms) / 1000).toFixed(1)}s ago`;
  }
  return out;
}

export function stamp(): string {
  return new Date().toISOString();
}

// `type` is the event's own name when the payload carries one; `stream` is the stream it came in on.
export type TypedEvent = { type: string; stream: string; data: Record<string, unknown>; receivedAt: number };

// Bee's docs say `bee stream --json` drops each event's name, which would make todo-created,
// todo-updated and todo-deleted all look like {todo: {...}}. So the spikes open one stream per
// event type. Running this showed that real payloads do carry a top-level `type` field, so the
// product itself should need only one stream.
// `done` resolves to the number of streams that ended without us closing them.
export function listenByType(
  client: BeeClient,
  types: string[],
  onEvent: (event: TypedEvent) => void,
): { close: () => void; done: Promise<number> } {
  let closed = false;
  let failures = 0;
  const streams = types.map((type) => ({ type, stream: client.sse.streamJson<Record<string, unknown>>({ types: [type] }) }));
  const loops = streams.map(async ({ type, stream }) => {
    try {
      for await (const { data } of stream.events) {
        // Every stream opens with a connect message that holds only { timestamp }. It is not an
        // event of the stream's type.
        const label = typeof data.type === "string" ? data.type : Object.keys(data).join() === "timestamp" ? "connected" : type;
        onEvent({ type: label, stream: type, data, receivedAt: Date.now() });
      }
      if (!closed) {
        failures += 1;
        console.error(`${stamp()} [${type}] stream ended by the server.`);
      }
    } catch (error) {
      // Closing kills the child process, which the library reports as a non-zero exit.
      if (!closed) {
        failures += 1;
        console.error(`${stamp()} [${type}] stream error: ${firstLine(error)}`);
      }
    }
  });
  return {
    close: () => {
      closed = true;
      for (const { stream } of streams) stream.close();
    },
    done: Promise.all(loops).then(() => failures),
  };
}
