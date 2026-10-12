// The detector's golden-set eval (SPEC §5): every synthetic transcript in fixtures/detector/ goes
// through the real detector (real Kiro, a few credits' worth of cents), and the result is a
// confusion matrix with precision and recall.
//
// Usage: node packages/detector/src/eval.ts [--model claude-haiku-4.5] [--concurrency 4] [--verbose]
//        npm run eval:detector -- --model claude-haiku-4.5
//
// It prints one line per fixture and never the transcript. Exit code 1 if the targets are missed
// or any fixture could not be evaluated.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger, dataPaths, errorSummary, loadConfig } from "@overnight/core";
import type { DataPaths } from "@overnight/core";
import { createKiroDetector, DEFAULT_MODEL } from "./detector.ts";
import { loadFixtures } from "./fixtures.ts";
import type { Expectation, FixtureResult } from "./fixtures.ts";
import { gateVerdict } from "./gate.ts";
import { formatConfusion, formatRatio, PRECISION_TARGET, RECALL_TARGET, score } from "./metrics.ts";
import type { Outcome } from "./metrics.ts";

const MAX_CONCURRENCY = 4;
const USAGE = `Usage: node packages/detector/src/eval.ts [--model ${DEFAULT_MODEL}] [--concurrency ${MAX_CONCURRENCY}] [--verbose]`;

const argsSchema = z.object({
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a model name")
    .default(DEFAULT_MODEL),
  concurrency: z.coerce.number().int().min(1).max(MAX_CONCURRENCY).default(MAX_CONCURRENCY),
  /** Also print why each failed attempt failed (our own words, never the reply). */
  verbose: z.boolean().default(false),
});

function readArgs(argv: string[]): z.infer<typeof argsSchema> {
  const given: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--verbose") {
      given.verbose = true;
      continue;
    }
    const value = argv[i + 1];
    if ((flag !== "--model" && flag !== "--concurrency") || value === undefined) throw new Error(USAGE);
    given[flag.slice(2)] = value;
    i += 1;
  }
  const parsed = argsSchema.safeParse(given);
  if (!parsed.success) throw new Error(`${parsed.error.issues.map((issue) => `--${issue.path.join(".")}: ${issue.message}`).join("; ")}\n${USAGE}`);
  return parsed.data;
}

interface Row {
  file: string;
  expect: Expectation | "?";
  /** What the detector plus the gate decided, or why there is no decision. */
  got: "idea" | "not_idea" | "ERROR" | "REFUSED";
  confidence: number | null;
  seconds: number | null;
  note: string;
  outcome: Outcome | null;
}

function formatRow(row: Row, fileWidth: number): string {
  const mark = row.outcome === null ? "" : (row.got === "idea") === (row.expect === "idea") ? "ok" : "WRONG";
  return [
    row.file.padEnd(fileWidth),
    row.expect.padEnd(8),
    row.got.padEnd(8),
    (row.confidence === null ? "-" : row.confidence.toFixed(2)).padStart(4),
    (row.seconds === null ? "-" : row.seconds.toFixed(1)).padStart(5),
    mark.padEnd(5),
    row.note,
  ]
    .join("  ")
    .trimEnd();
}

/** Run `work` over the items, at most `limit` at a time, and report each result in list order. */
async function runLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>, report: (result: R) => void): Promise<R[]> {
  const results = new Array<R | undefined>(items.length).fill(undefined);
  const done = new Array<boolean>(items.length).fill(false);
  let next = 0;
  let reported = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
      done[index] = true;
      while (reported < items.length && done[reported]) {
        report(results[reported] as R);
        reported += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results as R[];
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const fixtures = loadFixtures(path.join(repoRoot, "fixtures", "detector"));
  if (fixtures.length === 0) throw new Error("No fixtures found in fixtures/detector/.");

  // The eval gets its own Kiro folders inside the data folder, so its saved sessions never mix
  // with the listener's and the two can run at the same time. The data folder is found the way
  // every `overnight` command finds it: the environment first, then `.env` in the repo.
  const base = dataPaths(loadConfig(repoRoot).dataDir);
  const evalDir = path.join(base.root, "tmp", "detector-eval");
  const paths: DataPaths = { ...base, detectorKiroHome: path.join(evalDir, "kiro-home"), detectorCwd: path.join(evalDir, "cwd") };
  const logger = createLogger({ name: "detector-eval", minLevel: args.verbose ? "debug" : "warn", write: (line) => void process.stderr.write(line + "\n") });
  const detector = createKiroDetector({ paths, logger, model: args.model });
  await detector.ensureSetup();

  console.log(`Detector golden set: ${fixtures.length} fixtures, model ${args.model}, ${args.concurrency} at a time`);
  console.log("");
  const fileWidth = Math.max(4, ...fixtures.map((item) => item.file.length));
  console.log(["file".padEnd(fileWidth), "expected", "got".padEnd(8), "conf", " secs", "".padEnd(5), "why not asked"].join("  "));

  const evaluate = async (item: FixtureResult): Promise<Row> => {
    if (!item.ok) return { file: item.file, expect: "?", got: "REFUSED", confidence: null, seconds: null, note: item.problem, outcome: null };
    const { fixture } = item;
    const result = await detector.detect({ utterances: fixture.utterances, recentTitles: [] });
    const seconds = result.ms / 1000;
    if (!result.ok) return { file: fixture.file, expect: fixture.expect, got: "ERROR", confidence: null, seconds, note: result.reason, outcome: null };
    const gate = gateVerdict(result.verdict);
    const retried = result.attempts > 1 ? ` (${result.attempts} attempts)` : "";
    return {
      file: fixture.file,
      expect: fixture.expect,
      got: gate.pass ? "idea" : "not_idea",
      confidence: result.verdict.confidence,
      seconds,
      note: (gate.pass ? "" : gate.reason) + retried,
      outcome: { expect: fixture.expect, asked: gate.pass },
    };
  };

  const rows = await runLimited(fixtures, args.concurrency, evaluate, (row) => console.log(formatRow(row, fileWidth)));

  const outcomes = rows.flatMap((row) => (row.outcome ? [row.outcome] : []));
  const notEvaluated = rows.length - outcomes.length;
  const result = score(outcomes);
  const ideas = outcomes.filter((outcome) => outcome.expect === "idea").length;

  console.log("");
  console.log(formatConfusion(result.confusion));
  console.log("");
  console.log(`evaluated ${outcomes.length} of ${rows.length} fixtures (${ideas} ideas, ${outcomes.length - ideas} non-ideas)`);
  console.log(`precision ${formatRatio(result.precision)} (target >= ${PRECISION_TARGET.toFixed(2)})`);
  console.log(`recall    ${formatRatio(result.recall)} (target >= ${RECALL_TARGET.toFixed(2)})`);
  if (rows.length < 40) console.log(`note: SPEC §5 asks for a golden set of at least 40 fixtures; this run had ${rows.length}.`);
  if (notEvaluated > 0) console.log(`${notEvaluated} fixture(s) could not be evaluated.`);

  const pass = result.pass && notEvaluated === 0;
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(errorSummary(error));
  process.exitCode = 1;
}
