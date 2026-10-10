// SPEC §5, "Ask only if": the part of that list that depends on the verdict alone.
// The other two conditions (not a near-duplicate, still under the daily limit) need the store,
// so the listener checks those.
import type { DetectorVerdict } from "@overnight/core";

export const MIN_CONFIDENCE = 0.75;

export type GateResult = { pass: true } | { pass: false; reason: string };

// Two decimals, unless rounding would show a number that is not actually below the bar.
function shown(confidence: number): string {
  const rounded = confidence.toFixed(2);
  return Number(rounded) < MIN_CONFIDENCE ? rounded : String(confidence);
}

/** Would this verdict be worth a buzz on the wrist? If not, `reason` says why in plain words. */
export function gateVerdict(verdict: DetectorVerdict): GateResult {
  if (!verdict.is_idea) return { pass: false, reason: "not an idea" };
  // Written as "not at least" so a missing or NaN confidence fails too.
  if (!(verdict.confidence >= MIN_CONFIDENCE)) return { pass: false, reason: `confidence ${shown(verdict.confidence)} is below ${MIN_CONFIDENCE}` };
  if (verdict.likely_media) return { pass: false, reason: "sounds like TV, radio or a podcast" };
  if (!verdict.buildable_as_static_web_app) return { pass: false, reason: "needs more than a static web page" };
  return { pass: true };
}
