// Where Overnight keeps its data. Always outside the repo (default ~/.overnight), never committed.
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface DataPaths {
  root: string;
  database: string;
  logs: string;
  ideas: string;
  workspaces: string;
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
  for (const dir of [paths.root, paths.logs, paths.ideas, paths.workspaces, paths.reports, paths.screenshots, paths.detectorKiroHome, paths.detectorCwd, paths.pagesClone, paths.deliverRuns, paths.buildTmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to folders it creates; an older folder may be open to others.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not ours to change. The files inside are still created private.
    }
  }
}
