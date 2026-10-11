// Where a rehearsal may run: never on the real data folder.
//
// `overnight rehearse` puts an invented idea, already approved, into a database. In the real one
// it would be picked up by the real nightly jobs: built, published, and put on the wearer's wrist
// through the real Bee. So a rehearsal refuses to start unless
//   - OVERNIGHT_DATA_DIR was given to this very command, in its environment (a value that only
//     comes from the repo's .env file does not count: that file is where the background jobs get
//     THEIR folder from), and
//   - that folder is not the real data folder, nor inside it. The real data folder is the one
//     the background jobs use: ~/.overnight, or what the repo's .env file says.
// Folders are compared as real paths (links followed), and without regard to capitals: on a Mac
// "/Users/x/.Overnight" is the same folder as "/Users/x/.overnight".
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export interface RehearsalFolderFacts {
  /**
   * The data folder this command was given: OVERNIGHT_DATA_DIR as the process got it, read
   * BEFORE the .env file is loaded. Undefined or blank when it was not given.
   */
  given: string | undefined;
  /** The home folder. The default data folder is `.overnight` inside it. */
  home: string;
  /** The text of the repo's .env file, or null when there is none. */
  envFileText: string | null;
  /** Replaced in tests. Default: follow every link, for as much of the path as exists. */
  realPath?: (folder: string) => string;
}

/** Why a rehearsal is not for the real folder. Every refusal ends with it. */
export const REHEARSAL_WHY = "a test idea left in the real database would be picked up by the real nightly jobs";

const EXAMPLE = "OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse ...";

/** "~" and "~/x" the way core's config reads them. */
function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

/**
 * A path with its links followed, as far as it exists: the nearest folder that is there is
 * resolved, and the parts below it (not created yet) are kept as written.
 */
export function nearestRealPath(folder: string): string {
  let existing = path.resolve(folder);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Not there after all, or not ours to look at: compare it as written.
  }
  return path.join(real, ...rest);
}

/**
 * The data folders the background jobs use: the default one, and the one the repo's .env names
 * (a job is given only PATH and HOME, so .env is the only other place its folder can come from).
 */
export function realDataFolders(home: string, envFileText: string | null): string[] {
  const folders = [path.join(home, ".overnight")];
  if (envFileText !== null) {
    const fromFile = (parseEnv(envFileText).OVERNIGHT_DATA_DIR ?? "").trim();
    const expanded = expandHome(fromFile, home);
    if (fromFile !== "" && path.isAbsolute(expanded)) folders.push(path.resolve(expanded));
  }
  return [...new Set(folders)];
}

function sameOrInside(folder: string, parent: string): boolean {
  const a = folder.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Null when a rehearsal may run on the folder given. Otherwise why not, in one sentence. */
export function rehearsalFolderProblem(facts: RehearsalFolderFacts): string | null {
  const realPath = facts.realPath ?? nearestRealPath;
  const given = (facts.given ?? "").trim();
  if (given === "") {
    return `Not started: a rehearsal only runs on a scratch data folder named on the command itself (${EXAMPLE}), because ${REHEARSAL_WHY}.`;
  }
  const expanded = expandHome(given, facts.home);
  if (!path.isAbsolute(expanded)) {
    return `Not started: OVERNIGHT_DATA_DIR must be a full path to a scratch folder (${EXAMPLE}), because ${REHEARSAL_WHY}.`;
  }
  const folder = realPath(path.resolve(expanded));
  for (const real of realDataFolders(facts.home, facts.envFileText)) {
    if (sameOrInside(folder, realPath(real))) {
      return `Not started: OVERNIGHT_DATA_DIR points at the real data folder (${real}), and a rehearsal never runs there, because ${REHEARSAL_WHY}.`;
    }
  }
  return null;
}

/** The repo's .env text, or null when there is no such file. Throws if it is there and cannot be read. */
export function readEnvFileText(repoRoot: string): string | null {
  const file = path.join(repoRoot, ".env");
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("the repo's .env file could not be read, so the real data folder is not known", { cause: error });
  }
}
