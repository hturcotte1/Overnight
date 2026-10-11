// The report: one JSON file per idea (<data>/reports/<id>.json) that the dashboard reads.
// It may hold the idea's title and pitch, never the quote or any other transcript text.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataPaths } from "@overnight/core";
import { z } from "zod";
import type { VerifyChecks } from "./types.ts";

export interface DeliverReport {
  ideaId: string;
  slug: string | null;
  title: string;
  pitch: string;
  /** Which builder made the app: "kiro-crew" or "kiro-cli". */
  backend: string | null;
  /** The idea's state when this report was last written. */
  state: string;
  ok: boolean;
  url: string | null;
  /**
   * Whether the published page was seen serving this build.
   * - true: yes, `timings.liveAfterMs` after the push.
   * - false: it was pushed, but not seen live before the wait ran out (`timings.liveAfterMs` is
   *   null). The idea still counts as published and the wearer was told as usual.
   * - null: nothing was published.
   */
  confirmedLive: boolean | null;
  failureReason: string | null;
  /** Why the idea is where it is, as the store has it. No transcript text. */
  note: string | null;
  /** Yes/no answers, counts and timings from the verification. */
  checks: VerifyChecks;
  timings: { verifyMs: number | null; publishMs: number | null; liveAfterMs: number | null };
  sizes: { sourceFiles: number | null; sourceBytes: number | null; distFiles: number | null; distBytes: number | null };
  screenshots: { phone: string | null; desktop: string | null };
  morningTodoId: number | null;
  factId: number | null;
  startedAt: string;
  publishedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

/** The parts of an earlier report that a later step carries over. Anything else is rebuilt from the store. */
const carriedSchema = z
  .object({
    checks: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
    timings: z.object({ verifyMs: nullableNumber, publishMs: nullableNumber, liveAfterMs: nullableNumber }),
    screenshots: z.object({ phone: nullableString, desktop: nullableString }),
    startedAt: z.string(),
    confirmedLive: z.boolean().nullable(),
  })
  .partial();

export type CarriedReport = z.infer<typeof carriedSchema>;

export function reportPath(paths: DataPaths, ideaId: string): string {
  return path.join(paths.reports, `${ideaId}.json`);
}

/** What an earlier step of the same delivery wrote, or nothing if there is no readable report. */
export function readCarriedReport(paths: DataPaths, ideaId: string): CarriedReport {
  try {
    const parsed = carriedSchema.safeParse(JSON.parse(readFileSync(reportPath(paths, ideaId), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Write the report whole. The file is swapped in with a rename, so a reader never sees half of it. */
export function writeReport(paths: DataPaths, report: DeliverReport): void {
  mkdirSync(paths.reports, { recursive: true, mode: 0o700 });
  const file = reportPath(paths, report.ideaId);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The sizes the verifier measured, picked out of its checks. */
export function sizesFromChecks(checks: VerifyChecks): DeliverReport["sizes"] {
  return {
    sourceFiles: numberOrNull(checks.sourceFiles),
    sourceBytes: numberOrNull(checks.sourceBytes),
    distFiles: numberOrNull(checks.distFiles),
    distBytes: numberOrNull(checks.distBytes),
  };
}
