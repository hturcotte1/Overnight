// Time helpers. Everything is stored in UTC; local time (America/Boise by default) is only used
// to decide "which day is it" and "when is 23:00".

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

// Making a formatter is the slow part of every helper here, so one is kept per time zone.
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The local calendar day at `at`, as YYYY-MM-DD. */
export function localDateKey(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The UTC instant at which the wall clock in `timeZone` reads the given local time. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Start from "the same digits in UTC", then correct by the zone's offset. Twice, because the
  // offset at the first guess can differ from the offset at the answer around a clock change.
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wanted - shown;
  }
  return new Date(guess);
}

export function parseHhMm(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`"${value}" is not a time like 23:00`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The first moment strictly after `after` when the local clock reads `hhmm`. */
export function nextLocalTime(after: Date, hhmm: string, timeZone: string): Date {
  const { hour, minute } = parseHhMm(hhmm);
  const p = localParts(after, timeZone);
  for (let addDays = 0; addDays <= 2; addDays += 1) {
    // Date.UTC normalises day overflow (for example day 32), which keeps this simple.
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
    const candidate = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`Could not find the next ${hhmm} after ${after.toISOString()} in ${timeZone}`);
}

/**
 * The last moment at or before `at` when the local clock read `hhmm`, and the local day
 * (YYYY-MM-DD) it is on. The day is the calendar day that was asked for, which is what makes it
 * safe to use as a name: on the night the clocks go back, the second 01:00 belongs to the same
 * day as the first, and a time the clocks skip (02:30 on a spring night) still has its day.
 */
export function previousLocalTime(at: Date, hhmm: string, timeZone: string): { at: Date; day: string } {
  const { hour, minute } = parseHhMm(hhmm);
  const p = localParts(at, timeZone);
  // Tomorrow's is tried first. It is nearly always still to come, but not where the clocks skip
  // midnight (Havana, Santiago, the Azores): 00:30 on that day is taken as the moment half an hour
  // before the skip, which the clocks there still call 11:30 pm on the day before.
  for (let backDays = -1; backDays <= 2; backDays += 1) {
    // Date.UTC normalises day underflow (for example day 0), which keeps this simple.
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day - backDays));
    const candidate = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() <= at.getTime()) return { at: candidate, day: day.toISOString().slice(0, 10) };
  }
  throw new Error(`Could not find the last ${hhmm} before ${at.toISOString()} in ${timeZone}`);
}

/** The UTC start and end of the local calendar day that contains `at`. */
export function localDayBounds(at: Date, timeZone: string): { start: Date; end: Date } {
  const p = localParts(at, timeZone);
  const start = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { start, end };
}

/** The UTC start and end of the local calendar month that contains `at`. */
export function localMonthBounds(at: Date, timeZone: string): { start: Date; end: Date } {
  const p = localParts(at, timeZone);
  const start = zonedTimeToUtc(p.year, p.month, 1, 0, 0, timeZone);
  // Month 13 becomes January of the next year, the same way a day past the month's end does.
  const next = new Date(Date.UTC(p.year, p.month, 1));
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, 0, 0, timeZone);
  return { start, end };
}

/** For people: "Oct 9, 6:02 PM" in the given zone. */
export function formatLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}
