// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { ESTIMATED_CREDITS_PER_MINUTE, Store, budgetReachedText, buildBudget, estimatedBuildCredits } from "../src/index.ts";
import type { BuildBudget, BuildCreditsTotal } from "../src/index.ts";

const BOISE = "America/Boise";
// 3 pm on Oct 11, 2026 in Boise. October there runs from 06:00Z on Oct 1 to 06:00Z on Nov 1.
const NOW = new Date("2026-10-11T21:00:00.000Z");
const OCTOBER = { monthStart: "2026-10-01T06:00:00.000Z", monthEnd: "2026-11-01T06:00:00.000Z" };

/** A ledger that answers with fixed totals and remembers what it was asked. */
function ledger(total: Partial<BuildCreditsTotal> = {}) {
  const asked: Array<[string, string]> = [];
  return {
    asked,
    buildCreditsBetween: (start: string, end: string): BuildCreditsTotal => {
      asked.push([start, end]);
      return { credits: 0, estimated: 0, tries: 0, ...total };
    },
  };
}
const config = (maxBuildCreditsPerMonth: number, timeZone = BOISE) => ({ maxBuildCreditsPerMonth, timeZone });

describe("the estimate for a build that gave no figure", () => {
  it("is two credits for each minute the agent ran, to one decimal", () => {
    expect(ESTIMATED_CREDITS_PER_MINUTE).toBe(2);
    expect(estimatedBuildCredits(60_000)).toBe(2);
    expect(estimatedBuildCredits(90_000)).toBe(3);
    expect(estimatedBuildCredits(250_000)).toBe(8.3);
    expect(estimatedBuildCredits(45 * 60_000)).toBe(90);
  });

  it("is never less than 0.1, whatever it is handed", () => {
    for (const agentMs of [0, 1, 1_000, 2_999, -60_000, Number.NaN, Number.NEGATIVE_INFINITY]) expect(estimatedBuildCredits(agentMs), String(agentMs)).toBe(0.1);
    expect(estimatedBuildCredits(6_000)).toBe(0.2);
  });
});

describe("the month's build budget", () => {
  it("counts the calendar month in the time zone, and reports what the ledger holds", () => {
    const store = ledger({ credits: 12.3, estimated: 4.1, tries: 5 });
    expect(buildBudget(store, config(400), NOW)).toEqual({ ...OCTOBER, counted: 12.3, estimated: 4.1, tries: 5, limit: 400, reached: false });
    expect(store.asked).toEqual([[OCTOBER.monthStart, OCTOBER.monthEnd]]);
  });

  it("goes by the zone's month, not UTC's", () => {
    const store = ledger();
    // 1 am on Oct 1 in Tokyo is still Sep 30 in UTC. And 11:30 pm on Sep 30 in Boise is already Oct 1 in UTC.
    expect(buildBudget(store, config(400, "Asia/Tokyo"), new Date("2026-09-30T16:00:00.000Z"))).toMatchObject({ monthStart: "2026-09-30T15:00:00.000Z", monthEnd: "2026-10-31T15:00:00.000Z" });
    expect(buildBudget(store, config(400), new Date("2026-10-01T05:30:00.000Z"))).toMatchObject({ monthStart: "2026-09-01T06:00:00.000Z", monthEnd: OCTOBER.monthStart });
  });

  it("is reached at exactly the limit, and not a hair before", () => {
    expect(buildBudget(ledger({ credits: 399.999 }), config(400), NOW).reached).toBe(false);
    expect(buildBudget(ledger({ credits: 400 }), config(400), NOW).reached).toBe(true);
    expect(buildBudget(ledger({ credits: 412.3 }), config(400), NOW).reached).toBe(true);
    expect(buildBudget(ledger({ credits: 0.1 }), config(1), NOW).reached).toBe(false);
  });

  it("is always reached when the limit is 0: never build", () => {
    expect(buildBudget(ledger(), config(0), NOW)).toMatchObject({ counted: 0, limit: 0, reached: true });
  });

  it("does not count last month's builds, or next month's", () => {
    const store = new Store(":memory:");
    const { key } = store.resolveConversation({ uuid: "u-1" }, "2026-09-30T18:00:00.000Z");
    const idea = store.createIdea({ title: "Tip splitter", pitch: "Split a bill.", quote: "we should make a tip splitter", confidence: 0.9, conversationKey: key, detectorRunId: null }, "2026-09-30T18:00:00.000Z");
    const cost = (at: string, credits: number, measured: boolean) => store.recordBuildCost({ ideaId: idea.id, at, backend: measured ? "kiro-crew" : "kiro-cli", credits, measured });
    cost("2026-09-15T08:00:00.000Z", 300, true); // September
    cost("2026-10-01T05:59:59.999Z", 50, true); // the last moment of September in Boise
    cost("2026-10-01T06:00:00.000Z", 3.2, true); // the first moment of October
    cost("2026-10-11T07:20:00.000Z", 1.4, false);
    cost("2026-11-01T06:00:00.000Z", 9, true); // November

    expect(buildBudget(store, config(400), NOW)).toEqual({ ...OCTOBER, counted: 4.6, estimated: 1.4, tries: 2, limit: 400, reached: false });
    expect(buildBudget(store, config(4), NOW).reached).toBe(true);
    // The same ledger a month earlier: September was nearly spent.
    expect(buildBudget(store, config(400), new Date("2026-09-20T12:00:00.000Z"))).toMatchObject({ counted: 350, tries: 2, reached: false });
    store.close();
  });

  it("does not hide a ledger that cannot be read: what to do then is the caller's choice", () => {
    const broken = {
      buildCreditsBetween: (): BuildCreditsTotal => {
        throw new Error("no such table: build_costs");
      },
    };
    expect(() => buildBudget(broken, config(400), NOW)).toThrow("build_costs");
  });
});

describe("the sentence for a month that is used up", () => {
  const budget = (changes: Partial<BuildBudget> = {}): BuildBudget => ({ ...OCTOBER, counted: 412.3, estimated: 4.1, tries: 120, limit: 400, reached: true, ...changes });

  it("says how much was counted, when building starts again, and which setting to raise", () => {
    expect(budgetReachedText(budget(), BOISE)).toBe("this month's build credits are used up (412.3 of 400 counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised");
  });

  it("shows numbers to one decimal, and whole numbers plain", () => {
    expect(budgetReachedText(budget({ counted: 400 }), BOISE)).toContain("(400 of 400 counted)");
    expect(budgetReachedText(budget({ counted: 412.349 }), BOISE)).toContain("(412.3 of 400 counted)");
    expect(budgetReachedText(budget({ counted: 412.951 }), BOISE)).toContain("(413 of 400 counted)");
    expect(budgetReachedText(budget({ counted: 1.004, limit: 1 }), BOISE)).toContain("(1 of 1 counted)");
  });

  it("names the first day of next month in the time zone", () => {
    const december = { monthStart: "2026-12-01T07:00:00.000Z", monthEnd: "2027-01-01T07:00:00.000Z" };
    expect(budgetReachedText(budget(december), BOISE)).toContain("wait until Jan 1,");
    // In Tokyo, October ends at 15:00Z on Oct 31, which is Nov 1 there.
    expect(budgetReachedText(budget({ monthStart: "2026-09-30T15:00:00.000Z", monthEnd: "2026-10-31T15:00:00.000Z" }), "Asia/Tokyo")).toContain("wait until Nov 1,");
  });

  it("does not promise next month when the limit is 0", () => {
    expect(budgetReachedText(budget({ counted: 0, estimated: 0, tries: 0, limit: 0 }), BOISE)).toBe("MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built: approved ideas wait until it is raised");
  });

  it("ends without a full stop, to go inside a longer line", () => {
    for (const text of [budgetReachedText(budget(), BOISE), budgetReachedText(budget({ limit: 0 }), BOISE)]) expect(text.endsWith(".")).toBe(false);
  });
});
