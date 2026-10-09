// Shared helpers for the M0 spikes.
// Spikes print the *shape* of what Bee returns (field names and types), never the words
// that were said. Raw output goes to ~/.overnight/spikes/, which is outside the repo.
import { createBeeClient, type BeeClient } from "@beeai/cli/lib";
import { appendFileSync, mkdirSync } from "node:fs";
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

// The library shells out to the `bee` binary. Point it at the copy in node_modules so it
// works even when `bee` is not on PATH (launchd agents do not read shell profiles).
export function bee(): BeeClient {
  return createBeeClient({ command: path.join(repoRoot, "node_modules", ".bin", "bee") });
}

export async function requireLogin(client: BeeClient): Promise<void> {
  if (!(await client.auth.isAuthenticated())) {
    console.error("Bee is not logged in on this Mac yet. Run `bee login` first (needs the phone with the Bee app).");
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
