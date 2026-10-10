// Spike 8: can `kiro-cli chat --no-interactive`, with no tools, return valid detector JSON for a
// few synthetic transcripts?
//
// Usage: node spikes/08-kiro-detector.ts [model=claude-haiku-4.5]
// - Uses a custom agent with an empty tools list (spikes/kiro/overnight-detector.json).
// - Runs from an empty folder with its own KIRO_HOME, so no project files, steering files or old
//   sessions can leak into the prompt. Both live under ~/.overnight/, outside the repo.
// - Only the synthetic fixtures in fixtures/detector/ are sent. No Bee data.
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditsUsed, runKiro } from "./lib/kiro.ts";
import { saveRaw, spikeDataDir, stamp } from "./lib/util.ts";

const model = process.argv[2] ?? "claude-haiku-4.5";
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "fixtures", "detector");

const kiroHome = path.join(spikeDataDir(), "08-kiro-home");
const cwd = path.join(spikeDataDir(), "08-empty-cwd");
mkdirSync(path.join(kiroHome, "agents"), { recursive: true });
mkdirSync(cwd, { recursive: true });
copyFileSync(path.join(here, "kiro", "overnight-detector.json"), path.join(kiroHome, "agents", "overnight-detector.json"));

const INSTRUCTIONS = `Decide whether someone in the conversation below voiced an idea for a small app or software tool that could be built overnight.

Counts as an idea: someone wishes for or plans a small software tool, app, site, bot or automation ("someone should build...", "I wish there was an app that...", "it'd be cool if...", "why isn't there a...").
Not an idea: complaints with no product in them; talk about existing products; jokes; TV, radio or podcast audio; tasks for a person ("I need to email Sam"); anything that needs hardware, payments, accounts, scraping or other people's personal data.

Reply with exactly one JSON object with these keys and nothing else:
{
  "is_idea": boolean,
  "confidence": number between 0 and 1,
  "title": string of at most 6 words ("" if not an idea),
  "pitch": string of at most 40 words ("" if not an idea),
  "quote": string of at most 25 words copied word for word from the conversation ("" if not an idea),
  "said_by_wearer_guess": boolean,
  "likely_media": boolean (true if this sounds like TV, radio or a podcast),
  "buildable_as_static_web_app": boolean (true only if a static web page with no backend, login, payments or hardware could do it),
  "reason": string of at most 30 words
}

Ideas already heard in the last 14 days (do not repeat these): none.

Conversation (text and times only):
`;

type Verdict = { ok: true; value: Record<string, unknown> } | { ok: false; problem: string };

function words(text: unknown): number {
  return typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

// Hand-rolled check for the spike. The real detector package validates with zod.
function parse(stdout: string, transcript: string): Verdict {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, problem: "no JSON object in the reply" };
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return { ok: false, problem: "reply is not valid JSON" };
  }
  const booleans = ["is_idea", "said_by_wearer_guess", "likely_media", "buildable_as_static_web_app"];
  const strings = ["title", "pitch", "quote", "reason"];
  for (const key of booleans) if (typeof value[key] !== "boolean") return { ok: false, problem: `${key} is not a boolean` };
  for (const key of strings) if (typeof value[key] !== "string") return { ok: false, problem: `${key} is not a string` };
  const confidence = value.confidence;
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) return { ok: false, problem: "confidence is not a number from 0 to 1" };
  if (words(value.title) > 6) return { ok: false, problem: "title is longer than 6 words" };
  if (words(value.pitch) > 40) return { ok: false, problem: "pitch is longer than 40 words" };
  if (words(value.quote) > 25) return { ok: false, problem: "quote is longer than 25 words" };
  const quote = String(value.quote).trim();
  if (value.is_idea && quote && !transcript.toLowerCase().includes(quote.toLowerCase().replace(/[.…]+$/, ""))) {
    return { ok: false, problem: "quote is not copied word for word from the conversation" };
  }
  return { ok: true, value };
}

const before = await creditsUsed(cwd);
const rows: Record<string, unknown>[] = [];

for (const file of readdirSync(fixturesDir).filter((name) => name.endsWith(".txt")).sort()) {
  const raw = readFileSync(path.join(fixturesDir, file), "utf8");
  const expect = raw.match(/^# expect: (\w+)/m)?.[1] ?? "?";
  const transcript = raw.split("\n").filter((line) => !line.startsWith("#")).join("\n").trim();
  const prompt = INSTRUCTIONS + transcript;

  let attempts = 0;
  let verdict: Verdict = { ok: false, problem: "not run" };
  let lastMs = 0;
  let exitCode: number | null = null;
  let timedOut = false;
  // Validate, retry once, then give up on this transcript (never crash the run).
  while (attempts < 2 && !verdict.ok) {
    attempts += 1;
    const run = await runKiro(["chat", "--no-interactive", "--agent", "overnight-detector", "--model", model, prompt], {
      cwd,
      kiroHome,
      timeoutMs: 90_000,
    });
    saveRaw("08-detector.jsonl", { at: stamp(), file, attempt: attempts, exitCode: run.exitCode, timedOut: run.timedOut, ms: run.ms, stdout: run.stdout, stderr: run.stderr.slice(-2000) });
    lastMs = run.ms;
    exitCode = run.exitCode;
    timedOut = run.timedOut;
    verdict = run.error ? { ok: false, problem: run.error } : run.timedOut ? { ok: false, problem: "timed out after 90 s" } : parse(run.stdout, transcript);
  }

  const value = verdict.ok ? verdict.value : undefined;
  const wouldAsk = value ? value.is_idea === true && (value.confidence as number) >= 0.75 && value.likely_media === false && value.buildable_as_static_web_app === true : false;
  const row = {
    file,
    expect,
    validJson: verdict.ok,
    problem: verdict.ok ? undefined : verdict.problem,
    attempts,
    seconds: Number((lastMs / 1000).toFixed(1)),
    exitCode,
    timedOut,
    is_idea: value?.is_idea,
    confidence: value?.confidence,
    likely_media: value?.likely_media,
    buildable: value?.buildable_as_static_web_app,
    title: value?.title,
    wouldAsk,
    correct: verdict.ok ? wouldAsk === (expect === "idea") : false,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const after = await creditsUsed(cwd);
const valid = rows.filter((row) => row.validJson).length;
const correct = rows.filter((row) => row.correct).length;
console.log(
  JSON.stringify(
    {
      model,
      transcripts: rows.length,
      validJson: valid,
      correctDecisions: correct,
      medianSeconds: rows.map((row) => row.seconds as number).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
      creditsBefore: before,
      creditsAfter: after,
      creditsUsed: before !== undefined && after !== undefined ? Number((after - before).toFixed(2)) : "unknown",
    },
    null,
    2,
  ),
);
if (valid < rows.length || correct < rows.length) process.exitCode = 1;
