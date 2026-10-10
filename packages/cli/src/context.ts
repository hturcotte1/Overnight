// What every command needs before it can do anything: the settings, the data folders and the
// database. Opened in one place so the commands themselves stay free of set-up.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPaths, ensureDataDirs, loadConfig, Store } from "@overnight/core";
import type { Config, DataPaths } from "@overnight/core";

export interface Context {
  config: Config;
  paths: DataPaths;
  store: Store;
}

/**
 * The repo root, worked out from where this file lives (packages/cli/src). The background job
 * and `npx overnight` can start in any folder, so the current folder is never trusted for this.
 */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Throws ConfigError if a setting is bad. The caller closes `store` when it is done. */
export function openContext(root: string = repoRoot()): Context {
  const config = loadConfig(root);
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  return { config, paths, store: new Store(paths.database) };
}
