// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import type { DetectorVerdict } from "@overnight/core";
import { gateVerdict } from "../src/index.ts";

const GOOD: DetectorVerdict = {
  is_idea: true,
  confidence: 0.9,
  title: "Bin day page",
  pitch: "Shows which bin goes out today.",
  quote: "a page that just told me which bin goes out today",
  said_by_wearer_guess: true,
  likely_media: false,
  buildable_as_static_web_app: true,
  reason: "A sincere wish for a small tool.",
};

describe("gateVerdict", () => {
  it("passes a confident, buildable idea that is not media", () => {
    expect(gateVerdict(GOOD)).toEqual({ pass: true });
    expect(gateVerdict({ ...GOOD, confidence: 0.75 })).toEqual({ pass: true });
    // Who said it is only a guess, so it never blocks an ask.
    expect(gateVerdict({ ...GOOD, said_by_wearer_guess: false })).toEqual({ pass: true });
  });

  it("gives a plain reason for each way to fail", () => {
    expect(gateVerdict({ ...GOOD, is_idea: false })).toEqual({ pass: false, reason: "not an idea" });
    expect(gateVerdict({ ...GOOD, confidence: 0.62 })).toEqual({ pass: false, reason: "confidence 0.62 is below 0.75" });
    expect(gateVerdict({ ...GOOD, likely_media: true })).toEqual({ pass: false, reason: "sounds like TV, radio or a podcast" });
    expect(gateVerdict({ ...GOOD, buildable_as_static_web_app: false })).toEqual({ pass: false, reason: "needs more than a static web page" });
  });

  it("reports the first failing check", () => {
    expect(gateVerdict({ ...GOOD, is_idea: false, confidence: 0.1, likely_media: true, buildable_as_static_web_app: false })).toEqual({ pass: false, reason: "not an idea" });
    expect(gateVerdict({ ...GOOD, confidence: 0.5, likely_media: true })).toEqual({ pass: false, reason: "confidence 0.50 is below 0.75" });
  });

  it("never shows a failing confidence as 0.75", () => {
    expect(gateVerdict({ ...GOOD, confidence: 0.749 })).toEqual({ pass: false, reason: "confidence 0.749 is below 0.75" });
    expect(gateVerdict({ ...GOOD, confidence: Number.NaN }).pass).toBe(false);
  });
});
