// How the pages write times, lengths of time, sizes and counts. All pure: the time zone and
// "now" are always handed in, so a pretend clock (the demo) and a test read the same as a real one.
import { localDateKey, parseHhMm } from "@overnight/core";
import type { IdeaState } from "@overnight/core";

/** Shown in place of a time that could not be read, so one bad row never breaks a page. */
const UNKNOWN_TIME = "unknown time";

function toDate(at: string | Date): Date | null {
  const date = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The pieces of a local time, by name ("hour", "minute", "dayPeriod", "month", "day"). */
function localPieces(at: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const pieces: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone, ...options }).formatToParts(at)) pieces[part.type] = part.value;
  return pieces;
}

/**
 * "1:02 AM". Put together from the pieces, with a plain space before AM or PM: left to itself,
 * the same call gives a narrow no-break space on some versions of Node and a plain one on others.
 */
export function clockTime(at: string | Date, timeZone: string): string {
  const date = toDate(at);
  if (date === null) return UNKNOWN_TIME;
  const p = localPieces(date, timeZone, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** The calendar day `days` after the local day of `at`, as YYYY-MM-DD. Days, not hours: a day can be 23 or 25 hours long. */
function dateKeyPlusDays(at: Date, timeZone: string, days: number): string {
  const [year = 0, month = 1, day = 1] = localDateKey(at, timeZone).split("-").map(Number);
  // Date.UTC puts a day number past either end of the month into the right month.
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "Oct 9, 6:02 PM": a moment by its date, which reads the same whatever day it is looked at. */
export function dateTime(at: string | Date, timeZone: string): string {
  const date = toDate(at);
  if (date === null) return UNKNOWN_TIME;
  const p = localPieces(date, timeZone, { month: "short", day: "numeric" });
  return `${p.month} ${p.day}, ${clockTime(date, timeZone)}`;
}

/** "today, 1:02 AM", "yesterday, 7:00 AM", "tomorrow, 1:00 AM", and for any other day "Oct 9, 6:02 PM". */
export function dayTime(at: string | Date, timeZone: string, now: Date): string {
  const date = toDate(at);
  if (date === null) return UNKNOWN_TIME;
  const clock = clockTime(date, timeZone);
  const day = localDateKey(date, timeZone);
  if (day === localDateKey(now, timeZone)) return `today, ${clock}`;
  if (day === dateKeyPlusDays(now, timeZone, -1)) return `yesterday, ${clock}`;
  if (day === dateKeyPlusDays(now, timeZone, 1)) return `tomorrow, ${clock}`;
  return dateTime(date, timeZone);
}

/** A number with at most one decimal, and no ".0". */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * How long something took: "7.1 s", "26 s", "2 min 40 s", "1 h 5 min".
 * Tenths under ten seconds, whole seconds after that, and no seconds once it is past an hour.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  if (ms < 10_000) return `${oneDecimal(ms / 1000)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
  }
  const minutes = Math.round(seconds / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A size the way the Finder says it: "812 bytes", "5.6 KB", "1.2 MB" (1 KB is 1,000 bytes). */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "0 bytes";
  const whole = Math.round(n);
  if (whole < 1000) return whole === 1 ? "1 byte" : `${whole} bytes`;
  let value = whole / 1000;
  for (const unit of ["KB", "MB"]) {
    // 999,960 bytes would round to "1000 KB": move up a unit before that happens.
    if (Math.round(value * 10) / 10 < 1000) return `${oneDecimal(value)} ${unit}`;
    value /= 1000;
  }
  return `${oneDecimal(value)} GB`;
}

/** A sum of credits as `overnight status` writes it: one decimal, and none for a whole number ("10.4", "400"). */
export function credits(n: number): string {
  return Number.isFinite(n) ? oneDecimal(n) : "0";
}

/** "1 line", "214 lines", "1,204 lines", "4.59 Kiro credits". The plural is the word plus "s" unless one is given. */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

/**
 * The first `maxChars` characters of a text, and whether there was more. It counts whole
 * characters, so an emoji is never cut in half. The page says in its own words that text was cut.
 */
export function clip(text: string, maxChars: number): { text: string; cut: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  // A character is one or two units long, so a text this short cannot be over the limit.
  if (text.length <= limit) return { text, cut: false };
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, cut: false };
  return { text: characters.slice(0, limit).join(""), cut: true };
}

/** A character that carries a folder's name on, so the path found is only the start of a longer one. */
const NAME_GOES_ON = /[\p{L}\p{N}_-]/u;

/** A Mac's other full name for any folder on its main disk: "/System/Volumes/Data/Users/sam" is "/Users/sam". */
const DATA_VOLUME = "/System/Volumes/Data";

/** A text as a pattern that finds exactly that text. Only the characters a pattern reads as signs are marked; marking any other is an error in the patterns used here. */
function asPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Show the home folder as "~" wherever its path appears in a text: "/Users/sam/.overnight"
 * becomes "~/.overnight". The folder's name is the account's name, which no page should show.
 *
 * The path is found the way a Mac's disk reads it: capitals do not matter ("/users/Sam"), nor
 * does which of the two ways an accent is stored, and the same folder under the disk's other
 * name ("/System/Volumes/Data/Users/sam") is the home folder too. Build notes are written by an
 * agent, which may spell the folder any of these ways.
 *
 * A longer name that only starts the same way ("/Users/samantha") is another folder and is left
 * alone, and so is the same path deeper inside another one ("/Volumes/Old/Users/sam").
 */
export function homeTilde(text: string, home: string): string {
  const folder = home.replace(/\/+$/, "");
  // An empty home, "/" or a relative one would match far too much.
  if (folder.length < 2 || !folder.startsWith("/")) return text;
  const spellings = [...new Set([folder, folder.normalize("NFC"), folder.normalize("NFD")])].map(asPattern);
  const anywhere = new RegExp(`(?:${asPattern(DATA_VOLUME)})?(?:${spellings.join("|")})`, "giu");
  return text.replace(anywhere, (found: string, at: number) => {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + found.length] ?? "";
    // A full stop after it ends a sentence far more often than it starts ".old", so it does not count.
    const whole = before !== "." && !NAME_GOES_ON.test(before) && !NAME_GOES_ON.test(after);
    return whole ? "~" : found;
  });
}

/** A clock time some minutes earlier, round midnight if need be: "07:00" and 30 give "06:30". Throws on a time that is not HH:MM. */
export function minusMinutes(hhmm: string, minutes: number): string {
  const { hour, minute } = parseHhMm(hhmm);
  const total = (((hour * 60 + minute - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const BACKEND_LABELS: Readonly<Record<string, string>> = { "kiro-crew": "Kiro Crew", "kiro-cli": "Kiro CLI" };

/** The builder's name for people: "Kiro Crew", "Kiro CLI", and "" when no builder is recorded. A name we do not know is given back as it is. */
export function backendLabel(name: string | null): string {
  if (name === null) return "";
  return Object.hasOwn(BACKEND_LABELS, name) ? (BACKEND_LABELS[name] ?? name) : name;
}

/** Why a run stopped what it was doing, when its log says so (cli, sleep-watch.ts): on a build's ticks, and beside a run's times on the Nights page. */
export const MAC_SLEPT = "the Mac went to sleep";

/** Each idea state in the words the pages use. */
export const STATE_LABELS: Readonly<Record<IdeaState, string>> = Object.freeze({
  heard: "Heard",
  asked: "Asked",
  approved: "Approved",
  rejected: "Not approved",
  expired: "No answer",
  building: "Building",
  built: "Built",
  build_failed: "Could not build",
  published: "Published",
  publish_failed: "Not published",
  delivered: "Delivered",
} satisfies Record<IdeaState, string>);
