// Synthetic test data: the measurements in this file are made up.
import { describe, expect, it } from "vitest";
import { CONTRACT_MARKER, judgeContract, parseContractOutput } from "../src/contract.ts";
import type { ContractMeasure, ViewMeasure } from "../src/contract.ts";

const cleanView: ViewMeasure = {
  loaded: true,
  status: 200,
  headingVisible: true,
  visibleTextChars: 169,
  overflowPx: 0,
  requests: 3,
  nonLocalRequests: 0,
  failedRequests: 0,
  consoleErrors: 0,
  pageErrors: 0,
  screenshot: true,
  ms: 900,
};
const clean: ContractMeasure = { phone: cleanView, desktop: cleanView };
const withPhone = (change: Partial<ViewMeasure>): ContractMeasure => ({ phone: { ...cleanView, ...change }, desktop: cleanView });
const judge = (measure: ContractMeasure) => judgeContract(measure, { phoneOverflowAllowedPx: 8 });

describe("parseContractOutput", () => {
  const line = CONTRACT_MARKER + JSON.stringify(clean);

  it("finds the result line among Playwright's own output", () => {
    expect(parseContractOutput(`HARNESS server listening 50123\n\nRunning 1 test using 1 worker\n\n${line}\n  ✓  1 contract.spec.ts (1.9s)\n`)).toEqual(clean);
  });

  it("takes the last result line if there are several", () => {
    const earlier = CONTRACT_MARKER + JSON.stringify(withPhone({ consoleErrors: 9 }));
    expect(parseContractOutput(`${earlier}\n${line}\n`)).toEqual(clean);
  });

  it("gives null when the line is missing, is not JSON, or is not what we print", () => {
    expect(parseContractOutput("1 passed (2.2s)\n")).toBeNull();
    expect(parseContractOutput(`${CONTRACT_MARKER}{not json\n`)).toBeNull();
    expect(parseContractOutput(`${CONTRACT_MARKER}${JSON.stringify({ phone: cleanView })}\n`)).toBeNull();
    expect(parseContractOutput(`${CONTRACT_MARKER}${JSON.stringify({ phone: { ...cleanView, extra: "text from the page" }, desktop: cleanView })}\n`)).toBeNull();
    expect(parseContractOutput(`${CONTRACT_MARKER}${JSON.stringify({ phone: { ...cleanView, consoleErrors: "many" }, desktop: cleanView })}\n`)).toBeNull();
  });
});

describe("judgeContract", () => {
  it("passes a clean page and reports numbers and yes/no only", () => {
    const verdict = judge(clean);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.checks).toMatchObject({ phoneLoaded: true, phoneFits: true, phoneConsoleErrors: 0, phoneRequests: 3, desktopLoaded: true, desktopScreenshot: true });
    for (const value of Object.values(verdict.checks)) expect(["boolean", "number"]).toContain(typeof value);
  });

  it("a page with no heading still passes if it shows other content", () => {
    expect(judge(withPhone({ headingVisible: false })).ok).toBe(true);
  });

  it("fails a page that shows nothing", () => {
    const verdict = judge(withPhone({ headingVisible: false, visibleTextChars: 0 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(["nothing is visible on a phone-sized screen"]);
  });

  it("fails a page that did not load", () => {
    expect(judge(withPhone({ loaded: false, status: 404 })).problems).toEqual(["the page did not load on a phone-sized screen"]);
  });

  it("fails on console errors, failed requests and requests to anywhere else, with counts", () => {
    const verdict = judge(withPhone({ consoleErrors: 2, pageErrors: 1, failedRequests: 1, nonLocalRequests: 3 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      "3 requests to somewhere other than its own files on a phone-sized screen",
      "1 failed request on a phone-sized screen",
      "3 console errors on a phone-sized screen",
    ]);
    expect(verdict.checks).toMatchObject({ phoneNonLocalRequests: 3, phoneFailedRequests: 1, phoneConsoleErrors: 2, phonePageErrors: 1 });
  });

  it("fails a page that is wider than a phone, beyond a few pixels of slack", () => {
    expect(judge(withPhone({ overflowPx: 8 })).ok).toBe(true);
    const verdict = judge(withPhone({ overflowPx: 590 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(["the page is 590 pixels wider than a phone screen"]);
    expect(verdict.checks.phoneFits).toBe(false);
    expect(judge(withPhone({ overflowPx: -1 })).problems).toEqual(["the page's width on a phone could not be measured"]);
  });

  it("says trouble that is the same on both screens only once", () => {
    const broken = { ...cleanView, consoleErrors: 3, failedRequests: 3, nonLocalRequests: 3 };
    expect(judge({ phone: broken, desktop: broken }).problems).toEqual([
      "3 requests to somewhere other than its own files on both screen sizes",
      "3 failed requests on both screen sizes",
      "3 console errors on both screen sizes",
    ]);
    expect(judge({ phone: { ...cleanView, loaded: false }, desktop: { ...cleanView, loaded: false } }).problems).toEqual(["the page did not load on both screen sizes"]);
  });

  it("checks the desktop view too, and needs both screenshots", () => {
    const verdict = judge({ phone: cleanView, desktop: { ...cleanView, consoleErrors: 1, screenshot: false } });
    expect(verdict.problems).toEqual(["1 console error on a desktop-sized screen", "no screenshot could be taken on a desktop-sized screen"]);
  });
});
