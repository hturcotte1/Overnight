// Where Overnight keeps its data. Always outside the repo (default ~/.overnight), never committed.
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface DataPaths {
  root: string;
  database: string;
  logs: string;
  ideas: string;
  workspaces: string;
  /**
   * Finished builds, one folder per idea. A workspace is moved here as soon as its idea is
   * recorded as built, because no build job can reach this folder.
   */
  built: string;
  reports: string;
  screenshots: string;
  /** Kiro's settings and saved sessions for the detector, kept apart from the user's own. */
  detectorKiroHome: string;
  /** An empty folder for the detector to run in, so no project file can reach its prompt. */
  detectorCwd: string;
  /** Our clone of the public apps repo that GitHub Pages serves. */
  pagesClone: string;
  /** Throwaway copies that the deliver step builds and tests in. */
  deliverRuns: string;
  /**
   * The temporary folder handed to build jobs (as TMPDIR). It is the only temporary folder a
   * sandboxed build can read or write, so nothing another program left in a shared one is in reach.
   */
  buildTmp: string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    root: dataDir,
    database: path.join(dataDir, "overnight.db"),
    logs: path.join(dataDir, "logs"),
    ideas: path.join(dataDir, "ideas"),
    workspaces: path.join(dataDir, "workspaces"),
    built: path.join(dataDir, "built"),
    reports: path.join(dataDir, "reports"),
    screenshots: path.join(dataDir, "screenshots"),
    detectorKiroHome: path.join(dataDir, "kiro-detector"),
    detectorCwd: path.join(dataDir, "detector-cwd"),
    pagesClone: path.join(dataDir, "pages"),
    deliverRuns: path.join(dataDir, "tmp", "deliver"),
    buildTmp: path.join(dataDir, "tmp", "build"),
  };
}

/** Create the data folders if missing. Folders are private to the user (0700). */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.logs, paths.ideas, paths.workspaces, paths.built, paths.reports, paths.screenshots, paths.detectorKiroHome, paths.detectorCwd, paths.pagesClone, paths.deliverRuns, paths.buildTmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to folders it creates; an older folder may be open to others.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not ours to change. The files inside are still created private.
    }
  }
}

/** A name that stays inside the folder it is joined to: no slash of either kind, and not "." or "..". */
function isPlainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * Where an idea's finished build is: <data>/built/<ideaId> when that is a real folder (a link
 * there does not count), otherwise <data>/workspaces/<ideaId>, where a build stays until it is
 * recorded as built. The id becomes a folder name, so one that is not a plain name is refused.
 */
export function finishedBuildDir(paths: Pick<DataPaths, "built" | "workspaces">, ideaId: string): string {
  if (!isPlainName(ideaId)) throw new Error("The idea id cannot be used as a folder name.");
  const sealed = path.join(paths.built, ideaId);
  try {
    if (lstatSync(sealed).isDirectory()) return sealed;
  } catch {
    // Not there, or cannot be looked at: the workspace it is.
  }
  return path.join(paths.workspaces, ideaId);
}
