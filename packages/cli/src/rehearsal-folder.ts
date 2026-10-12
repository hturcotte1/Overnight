// Where a rehearsal may run: never on the real data folder.
//
// `overnight rehearse` puts an invented idea, already approved, into a database. In the real one
// it would be picked up by the real nightly jobs: built, published, and put on the wearer's wrist
// through the real Bee. So a rehearsal refuses to start unless
//   - OVERNIGHT_DATA_DIR was given to this very command, in its environment (a value that only
//     comes from the repo's .env file does not count: that file is where the background jobs get
//     THEIR folder from), and
//   - that folder is not a real data folder, nor inside one. The real data folders are the ones
//     the background jobs use: ~/.overnight, what the repo's .env file says, and whichever
//     folder each installed job's own settings file names.
// Folders are compared by what the disk says they are (device and file number), not by how they
// are spelled: a link, other capitals, or one of macOS's other names for the same place
// (/System/Volumes/Data/..., /.vol/...) all lead to the same folder (see folder-identity.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { sameOrInsideFolder } from "./folder-identity.ts";
import type { StatFolder } from "./folder-identity.ts";

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
  /**
   * The data folders the installed background jobs name in their settings files
   * (background.ts: installedJobFolders). They count as real too. Left out: none.
   */
  jobFolders?: readonly string[];
  /** Replaced in tests. Default: ask the disk (folder-identity.ts). */
  stat?: StatFolder;
}

/** Why a rehearsal is not for the real folder. Every refusal ends with it. */
export const REHEARSAL_WHY = "a test idea left in the real database would be picked up by the real nightly jobs";

/**
 * The example in a refusal. It only shows the shape of the command: any folder that is not a real
 * data folder is taken. A folder under /private/tmp, like this one, has not held a real build
 * yet. Inside both build sandboxes harmless commands could read a brief and write in the
 * workspace and in the build's temporary folder there (measured Oct 12), and that is all that is
 * known. The rehearsals that were run for real used a folder of their own in the home folder
 * (README, "Rehearsing"), and spikes/11-hardening-proof.ts takes no other kind.
 */
const EXAMPLE = "OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse ...";

/** "~" and "~/x" the way core's config reads them. */
function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

/**
 * The data folders the background jobs use: the default one, the one the repo's .env names (a
 * job is given only PATH and HOME, so .env is where its folder comes from), and the ones the
 * installed jobs' own settings files name. Those can differ from .env: a job keeps writing its
 * log where it was installed, whatever .env says by now.
 */
export function realDataFolders(home: string, envFileText: string | null, jobFolders: readonly string[] = []): string[] {
  const folders = [path.join(home, ".overnight")];
  if (envFileText !== null) {
    const fromFile = (parseEnv(envFileText).OVERNIGHT_DATA_DIR ?? "").trim();
    const expanded = expandHome(fromFile, home);
    if (fromFile !== "" && path.isAbsolute(expanded)) folders.push(path.resolve(expanded));
  }
  for (const folder of jobFolders) {
    if (path.isAbsolute(folder)) folders.push(path.resolve(folder));
  }
  return [...new Set(folders)];
}

/**
 * Null when a rehearsal may run on the folder given. Otherwise why not, in one sentence.
 * Throws when a folder cannot be looked at: the caller turns that into a refusal, because not
 * knowing which folder is the real one is a reason to refuse.
 */
export function rehearsalFolderProblem(facts: RehearsalFolderFacts): string | null {
  const given = (facts.given ?? "").trim();
  if (given === "") {
    return `Not started: a rehearsal only runs on a scratch data folder named on the command itself (${EXAMPLE}), because ${REHEARSAL_WHY}.`;
  }
  const expanded = expandHome(given, facts.home);
  if (!path.isAbsolute(expanded)) {
    return `Not started: OVERNIGHT_DATA_DIR must be a full path to a scratch folder (${EXAMPLE}), because ${REHEARSAL_WHY}.`;
  }
  const folder = path.resolve(expanded);
  for (const real of realDataFolders(facts.home, facts.envFileText, facts.jobFolders)) {
    if (sameOrInsideFolder(folder, real, facts.stat)) {
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
