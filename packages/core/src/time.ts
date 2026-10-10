// Time helpers. Everything is stored in UTC; local time (America/Boise by default) is only used
// to decide "which day is it" and "when is 23:00".

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
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

/** The UTC start and end of the local calendar day that contains `at`. */
export function localDayBounds(at: Date, timeZone: string): { start: Date; end: Date } {
  const p = localParts(at, timeZone);
  const start = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { start, end };
}

/** For people: "Oct 9, 6:02 PM" in the given zone. */
export function formatLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}
