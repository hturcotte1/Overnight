// The monthly ceiling on what builds may cost: MAX_BUILD_CREDITS_PER_MONTH, per data folder, by
// the calendar month in TZ.
//
// It counts what Overnight saw, not Kiro's bill: one ledger row per build try that started an
// agent (Store.recordBuildCost), with the builder's own figure when there is one and an estimate
// when there is not. It is asked before each idea and never during one, so a single build can
// take the month over the line. The detector's credits are not counted.
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { localMonthBounds } from "./time.ts";

/** What a build is taken to cost when the builder gave no figure of its own, per minute its agent ran. */
export const ESTIMATED_CREDITS_PER_MINUTE = 2;

/** The estimate for an agent that ran `agentMs`: to one decimal, and never less than 0.1. */
export function estimatedBuildCredits(agentMs: number): number {
  const minutes = Number.isFinite(agentMs) && agentMs > 0 ? agentMs / 60_000 : 0;
  return Math.max(0.1, Math.round(minutes * ESTIMATED_CREDITS_PER_MINUTE * 10) / 10);
}

export interface BuildBudget {
  /** The month being counted, as UTC instants: start included, end excluded. */
  monthStart: string;
  monthEnd: string;
  /** Credits counted this month, measured and estimated together. */
  counted: number;
  /** The part of `counted` that is an estimate. */
  estimated: number;
  /** How many build tries were counted. */
  tries: number;
  /** MAX_BUILD_CREDITS_PER_MONTH. */
  limit: number;
  /** True when nothing more may be built this month. Always true when the limit is 0. */
  reached: boolean;
}

/** Where this month's building stands at `now`. Throws if the ledger cannot be read; what to do then is the caller's choice. */
export function buildBudget(store: Pick<Store, "buildCreditsBetween">, config: Pick<Config, "maxBuildCreditsPerMonth" | "timeZone">, now: Date): BuildBudget {
  const month = localMonthBounds(now, config.timeZone);
  const monthStart = month.start.toISOString();
  const monthEnd = month.end.toISOString();
  const total = store.buildCreditsBetween(monthStart, monthEnd);
  const limit = config.maxBuildCreditsPerMonth;
  return { monthStart, monthEnd, counted: total.credits, estimated: total.estimated, tries: total.tries, limit, reached: total.credits >= limit };
}

/** A number of credits for people: one decimal, and none for a whole number ("412.3", "400"). */
function creditsText(credits: number): string {
  return String(Math.round(credits * 10) / 10);
}

/** Why nothing is being built, for a budget that is reached. One clause with no full stop, to go inside a longer line. */
export function budgetReachedText(budget: BuildBudget, timeZone: string): string {
  // A limit of 0 is a choice, not a month that ran out: next month changes nothing.
  if (budget.limit === 0) return "MAX_BUILD_CREDITS_PER_MONTH in .env is 0, so nothing is built: approved ideas wait until it is raised";
  const nextMonth = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(budget.monthEnd));
  return `this month's build credits are used up (${creditsText(budget.counted)} of ${creditsText(budget.limit)} counted): approved ideas wait until ${nextMonth}, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised`;
}
