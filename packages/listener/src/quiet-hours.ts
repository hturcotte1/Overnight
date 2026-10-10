// Quiet hours: from the ask cutoff until the morning delivery nobody is asked anything. Pure.
import { nextLocalTime } from "@overnight/core";
import type { Config } from "@overnight/core";

export type QuietHoursConfig = Pick<Config, "askCutoff" | "deliverTime" | "timeZone">;

/**
 * If `now` falls in quiet hours, the moment they end; otherwise null.
 *
 * Quiet hours run on the local clock from askCutoff (included) to deliverTime (not included).
 * With the defaults that is 23:00 until 07:00 the next morning, but the window need not cross
 * midnight. The same time for both means there are no quiet hours.
 */
export function quietHoursEnd(now: Date, config: QuietHoursConfig): Date | null {
  if (config.askCutoff === config.deliverTime) return null;
  // Both are strictly after `now`, so at the cutoff itself the next start is tomorrow's.
  const nextStart = nextLocalTime(now, config.askCutoff, config.timeZone);
  const nextEnd = nextLocalTime(now, config.deliverTime, config.timeZone);
  // Whichever comes next says which side of it we are on: an end means we are inside. Working
  // from real instants, not clock digits, is what keeps this right on the days the clocks change.
  return nextEnd.getTime() < nextStart.getTime() ? nextEnd : null;
}
