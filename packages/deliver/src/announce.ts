// The words that go to the wrist, and when their alarm rings. Pure: no clock, no Bee, no store.
import { nextLocalTime } from "@overnight/core";
import type { Config } from "@overnight/core";

export const MORNING_PREFIX = "☀️ Built overnight: ";
export const FAILURE_PREFIX = "🌙 Couldn't finish ";

/** Outside quiet hours: if DELIVER_TIME is this close, the to-do's alarm waits for it; otherwise it rings almost at once. */
export const MORNING_WINDOW_MS = 2 * 60 * 60 * 1000;
/** The shortest notice an alarm is given, the same two minutes the ask uses. */
export const ALARM_LEAD_MS = 2 * 60 * 1000;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function morningText(title: string, url: string): string {
  return `${MORNING_PREFIX}${oneLine(title)} → ${url}`;
}

export function failureText(title: string): string {
  return `${FAILURE_PREFIX}${oneLine(title)}, details on the dashboard`;
}

/** What Bee is told to remember, for example: Overnight built "Tip splitter" on Oct 10: https://… */
export function factText(title: string, url: string, at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at);
  return `Overnight built "${oneLine(title)}" on ${day}: ${url}`;
}

/**
 * If `at` falls in quiet hours (ASK_CUTOFF, included, to DELIVER_TIME, not included, on the local
 * clock), the moment they end; otherwise null. The same rule the listener asks by (its
 * quiet-hours.ts): whichever of the two times comes next says which side of it we are on, which
 * also keeps this right on the days the clocks change. The same time for both means no quiet hours.
 */
function quietHoursEnd(at: Date, config: Pick<Config, "askCutoff" | "deliverTime" | "timeZone">): Date | null {
  if (config.askCutoff === config.deliverTime) return null;
  const nextStart = nextLocalTime(at, config.askCutoff, config.timeZone);
  const nextEnd = nextLocalTime(at, config.deliverTime, config.timeZone);
  return nextEnd.getTime() < nextStart.getTime() ? nextEnd : null;
}

/**
 * When a to-do created at `now` should buzz.
 * - The normal run is half an hour before DELIVER_TIME, so the alarm waits for DELIVER_TIME.
 * - Nothing buzzes at night (SPEC section 2): a run at any time in quiet hours, or so close to
 *   them that an alarm two minutes out would land inside, also waits for DELIVER_TIME. That
 *   includes `overnight build-now` used late in the evening.
 * - A late run, or `overnight build-now` during the day, has no morning to wait for: its alarm
 *   rings two minutes from now.
 */
export function morningAlarmAt(now: Date, config: Pick<Config, "askCutoff" | "deliverTime" | "timeZone">): Date {
  const soonest = new Date(now.getTime() + ALARM_LEAD_MS);
  const nextDeliverTime = nextLocalTime(now, config.deliverTime, config.timeZone);
  const atNight = quietHoursEnd(now, config) !== null || quietHoursEnd(soonest, config) !== null;
  if (!atNight && nextDeliverTime.getTime() - now.getTime() > MORNING_WINDOW_MS) return soonest;
  return nextDeliverTime.getTime() < soonest.getTime() ? soonest : nextDeliverTime;
}
