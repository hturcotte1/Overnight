// A last look, outside the sandbox, at what is about to become public.
//
// Sandboxed build code cannot read the home folder, but it still knows a few things that name
// this Mac or its owner: the folder it runs in sits under the home folder (so it knows the account
// name), and the computer's name often holds a first name. A sloppy build tool can write such a
// thing into dist (an absolute path in a source map, a "built on <computer>" banner), and dist is
// published. So the checked copy of dist is searched for those few strings, and a hit stops the
// publish.
//
// This catches accidents. It cannot catch code that hides the same text on purpose (encoded,
// split up); the sandbox rules are what limit how much such code can learn in the first place.
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";

/** Shorter strings than this are not searched for: they would match ordinary words. */
const MIN_LENGTH = 4;
const SCUTIL = "/usr/sbin/scutil";
const SCUTIL_TIMEOUT_MS = 5_000;

/** Factory names say nothing about the owner, and an app may well mention a MacBook. */
const IMPERSONAL = /^(?:localhost|macbook|macbook[- ]?(?:pro|air)|imac|imac[- ]?pro|mac[- ]?(?:mini|studio|pro)|macintosh)(?:[- ]\d+)?(?:\.local|\.lan)?$/i;

function scutil(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(SCUTIL, ["--get", key], { timeout: SCUTIL_TIMEOUT_MS, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin" } }, (error, stdout) => resolve(error ? null : stdout.trim()));
    } catch {
      resolve(null);
    }
  });
}

/** Tidy a list of candidate strings: no blanks, no short or impersonal ones, no repeats. */
export function usablePrivateStrings(candidates: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (value.length < MIN_LENGTH || IMPERSONAL.test(value)) continue;
    out.add(value);
  }
  return [...out];
}

let cached: Promise<string[]> | null = null;

/**
 * The strings that name this Mac or its owner: the host name (long and short), the computer's
 * name as shown in Sharing, the home folder's path and the account name as part of a path. Never
 * throws. The values are never logged: callers only ever say that one of them was found.
 */
export function localPrivateStrings(): Promise<string[]> {
  cached ??= (async () => {
    const candidates: Array<string | null> = [];
    const safely = (read: () => string) => {
      try {
        candidates.push(read());
      } catch {
        // That one could not be read on this Mac: search for the others.
      }
    };
    safely(() => hostname());
    safely(() => hostname().split(".")[0] ?? "");
    safely(() => homedir());
    // The account name only where it is part of a path. On its own it is too often an ordinary
    // word (this Mac's is a unit of measurement an app may well mention), and sandboxed code only
    // ever sees it inside paths anyway.
    safely(() => `/${userInfo().username}/`);
    for (const key of ["ComputerName", "LocalHostName", "HostName"]) candidates.push(await scutil(key));
    return usablePrivateStrings(candidates);
  })();
  return cached;
}

export interface PrivateScanResult {
  /** How many files (by content or by name) held one of the strings. */
  filesWithHits: number;
  filesScanned: number;
}

/**
 * Search every file under `dir` (content and name) for any of `needles`, as exact text. `dir` must
 * be a plain copy we made ourselves (see plain-copy.ts): links are skipped, not followed.
 * Throws only if the folder cannot be read; says how many files matched, never which or where.
 */
export function scanForPrivateStrings(dir: string, needles: readonly string[]): PrivateScanResult {
  const wanted = needles.filter((needle) => needle.length >= MIN_LENGTH).map((needle) => ({ text: needle, bytes: Buffer.from(needle, "utf8") }));
  let filesWithHits = 0;
  let filesScanned = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const name of readdirSync(current)) {
      const file = path.join(current, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        stack.push(file);
        if (wanted.some((needle) => name.includes(needle.text))) filesWithHits += 1;
        continue;
      }
      if (!stat.isFile()) continue;
      filesScanned += 1;
      const data = readFileSync(file);
      if (wanted.some((needle) => name.includes(needle.text) || data.includes(needle.bytes))) filesWithHits += 1;
    }
  }
  return { filesWithHits, filesScanned };
}
