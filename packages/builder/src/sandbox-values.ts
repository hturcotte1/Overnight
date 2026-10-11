// The values a sandbox profile is started with: `sandbox-exec -f <profile> -D NAME=<real path> ...`.
//
// A profile says itself which values it wants: every (param "NAME") in it. scripts/install-agents.sh
// reads the gateway's profile the same way when it writes the gateway's background job, so the
// gateway and our own sandboxed commands are always started with the same names, whatever the
// profile is changed to ask for. A name nobody here can fill, or a path that is not a real one,
// means nothing is started: sandbox-exec refuses a profile with a missing value, and a rule
// written with a linked path would silently match nothing.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** The names a profile may ask for. The installer fills exactly these (WORKSPACE: Kiro CLI builds only). */
export const SANDBOX_VALUE_NAMES = ["HOME", "DATA_DIR", "REPO", "NODE_DIR", "NPM_CACHE", "KIRO_HOME", "CREW_HOME", "TMPDIR", "WORKSPACE"] as const;
export type SandboxValueName = (typeof SANDBOX_VALUE_NAMES)[number];
export type SandboxValues = Partial<Record<SandboxValueName, string | null>>;

/**
 * The names a profile wants values for: every (param "NAME") in it, once each, in the order they
 * first appear. Comments (from ";" to the end of a line) are not looked at.
 */
export function profileParams(profileText: string): string[] {
  const names: string[] = [];
  for (const line of profileText.split("\n")) {
    for (const match of line.replace(/;.*$/, "").matchAll(/\(param "([^"]*)"\)/g)) {
      const name = match[1] ?? "";
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The real path of something that exists (every link followed), or null. */
export function realPath(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * A full path with every link in it followed, even when its last parts do not exist yet (a fresh
 * Mac has no npm cache). Null when it is not a full path, or when a link is still left in the
 * answer (a link that points nowhere).
 */
export function realPathAllowMissing(file: string): string | null {
  if (!path.isAbsolute(file)) return null;
  let existing = path.resolve(file);
  const rest: string[] = [];
  while (existing !== path.dirname(existing) && !existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const real = realPath(existing);
  if (real === null) return null;
  let seen = real;
  for (const part of rest) {
    seen = path.join(seen, part);
    try {
      if (lstatSync(seen).isSymbolicLink()) return null;
    } catch {
      // not there: nothing to follow
    }
  }
  return seen;
}

/**
 * The `-D NAME=value` arguments for a profile: one pair for each name the profile asks for, in
 * the profile's own order. Null when the profile cannot be read, asks for nothing (then it is
 * not one of ours), or asks for a name there is no real path for.
 */
export function sandboxDefines(profileFile: string, values: SandboxValues): string[] | null {
  let names: string[];
  try {
    names = profileParams(readFileSync(profileFile, "utf8"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const defines: string[] = [];
  for (const name of names) {
    const value = (values as Record<string, string | null | undefined>)[name];
    if (typeof value !== "string" || !path.isAbsolute(value)) return null;
    defines.push("-D", `${name}=${value}`);
  }
  return defines;
}
