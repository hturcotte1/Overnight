// Bee sends times in two forms: ISO strings on the live stream, epoch milliseconds from commands.
// Everything leaves this package as an ISO 8601 string in UTC.
//
// Only those two forms are read. JavaScript's own date parser is far more generous: it turns "5"
// into May 2001 and reads "10/09/2026 6:00 PM" in this Mac's time zone. A wrong time is worse
// than a missing one, because the detector's quiet timer orders lines by it.

// The largest time a JavaScript Date can hold, in milliseconds since 1970.
const MAX_DATE_MS = 8.64e15;

// Below this a number cannot be a time from Bee in either unit: as seconds it is before 2001.
const SMALLEST_EPOCH = 1e9;
// From here up a number is milliseconds (1e11 ms is 1973). Below it, seconds (1e11 s is year 5138).
const SMALLEST_EPOCH_MS = 1e11;

// A date, then optionally a time, then optionally a zone: "Z", "+05:30" or "+0530".
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Milliseconds since 1970 for a number from Bee, or null if it cannot be a time.
 * Bee's commands send milliseconds. A value small enough to be seconds is read as seconds, the
 * way Bee's own CLI does it.
 */
export function toEpochMs(value: number): number | null {
  if (!Number.isFinite(value) || value < SMALLEST_EPOCH) return null;
  const ms = value < SMALLEST_EPOCH_MS ? value * 1000 : value;
  return ms <= MAX_DATE_MS ? ms : null;
}

/** An ISO UTC string for a time from Bee, or null if it is missing or unreadable. */
export function toIsoUtc(value: unknown): string | null {
  if (typeof value === "number") {
    const ms = toEpochMs(value);
    return ms === null ? null : new Date(ms).toISOString();
  }
  if (typeof value !== "string") return null;
  const match = ISO_TIME.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, time, zone] = match;

  // JavaScript rolls 30 February over into March. A date that is not on the calendar is unreadable.
  const calendarDay = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const onTheCalendar =
    calendarDay.getUTCFullYear() === Number(year) && calendarDay.getUTCMonth() === Number(month) - 1 && calendarDay.getUTCDate() === Number(day);
  if (!onTheCalendar) return null;

  // Every time we have seen from Bee names its zone. If one ever arrives without, JavaScript
  // would read it as this Mac's local time; Bee's clocks are UTC, so read it as UTC instead.
  const zoneWithColon = zone === undefined ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${year}-${month}-${day}T${time ?? "00:00"}${zoneWithColon}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
