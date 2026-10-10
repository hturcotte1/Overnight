// The golden set's arithmetic (SPEC §5). "Positive" means the wrist would have been asked.
import type { Expectation } from "./fixtures.ts";

export const PRECISION_TARGET = 0.85;
export const RECALL_TARGET = 0.7;

export interface Outcome {
  expect: Expectation;
  asked: boolean;
}

export interface Confusion {
  /** Ideas we would ask about. */
  truePositive: number;
  /** Non-ideas we would ask about: a pointless buzz on the wrist. */
  falsePositive: number;
  /** Ideas we would let pass. */
  falseNegative: number;
  /** Non-ideas we would rightly ignore. */
  trueNegative: number;
}

export interface Score {
  confusion: Confusion;
  /** Of the asks, how many were real ideas. Null when nothing was asked. */
  precision: number | null;
  /** Of the real ideas, how many were asked. Null when the set has no ideas. */
  recall: number | null;
  pass: boolean;
}

export function score(outcomes: Outcome[]): Score {
  const confusion: Confusion = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  for (const outcome of outcomes) {
    if (outcome.expect === "idea") confusion[outcome.asked ? "truePositive" : "falseNegative"] += 1;
    else confusion[outcome.asked ? "falsePositive" : "trueNegative"] += 1;
  }
  const asked = confusion.truePositive + confusion.falsePositive;
  const ideas = confusion.truePositive + confusion.falseNegative;
  const precision = asked === 0 ? null : confusion.truePositive / asked;
  const recall = ideas === 0 ? null : confusion.truePositive / ideas;
  // A set that cannot measure one of the two numbers has not shown anything, so it does not pass.
  const pass = precision !== null && recall !== null && precision >= PRECISION_TARGET && recall >= RECALL_TARGET;
  return { confusion, precision, recall, pass };
}

export function formatConfusion(confusion: Confusion): string {
  const cell = (value: number) => String(value).padStart(13);
  return [
    `${"".padEnd(14)}${"expected idea".padStart(13)}  ${"expected not_idea".padStart(17)}`,
    `${"would ask".padEnd(14)}${cell(confusion.truePositive)}  ${String(confusion.falsePositive).padStart(17)}`,
    `${"would not ask".padEnd(14)}${cell(confusion.falseNegative)}  ${String(confusion.trueNegative).padStart(17)}`,
  ].join("\n");
}

export function formatRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}
