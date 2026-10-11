// Did the build agent finish? Both backends decide it the same way, from files in the workspace:
//   1. BUILD_STATUS.json parses and says "built",
//   2. it was written after this build started (the times written INSIDE it are the agent's
//      guesses; only the file's own modification time counts),
//   3. dist/index.html exists.
// The agent's exit code, its final message and Kiro Crew's "success" are never used: Crew records
// "success" whenever a session ends. This is still only "the agent says it is done"; the deliver
// step rebuilds from a clean copy and runs its own checks before anything is published.
//
// The reasons made here are fixed sentences. What the agent wrote in the file is never copied
// into a reason or a log line.
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readSmallFile } from "./safe-read.ts";

export const BUILD_STATUS_FILE = "BUILD_STATUS.json";
/** A real one is under 300 bytes. Anything much larger is not ours to parse. */
const MAX_STATUS_BYTES = 64 * 1024;

const statusSchema = z.object({
  status: z.string(),
  build_ok: z.boolean().optional(),
  smoke_test: z.string().optional(),
});

export type BuildCheck =
  | { ok: true; smokeTest: "passed" | "failed" | "not_run" | "unknown" }
  | {
      ok: false;
      reason: string;
      /** True when there is no fresh status file at all: the agent never got going. */
      neverStarted: boolean;
    };

export const NO_STATUS_FILE = "the builder left no BUILD_STATUS.json, so it did not finish";
export const STALE_STATUS_FILE = "BUILD_STATUS.json is older than this build, so the builder did not finish";
export const UNREADABLE_STATUS_FILE = "BUILD_STATUS.json could not be read";
export const REPORTED_FAILED = "the builder reported that the build failed (its notes are in BUILD_NOTES.md in the workspace)";
export const STOPPED_EARLY = "the builder stopped before it finished";
export const NO_DIST = "the builder said it was done, but dist/index.html is missing";
export const WORKSPACE_REPLACED = "the workspace folder was moved or replaced during the build";

function isPlainFile(file: string): boolean {
  try {
    // lstat, not stat: a link planted by the agent is not followed.
    const info = lstatSync(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function isPlainDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Still the folder we made: a plain folder under its own name, not a link to somewhere else. */
function isOwnFolder(workspace: string): boolean {
  try {
    return lstatSync(workspace).isDirectory() && realpathSync(workspace) === workspace;
  } catch {
    return false;
  }
}

/**
 * Check a workspace after a build. `workspace` is its full real path, as prepareWorkspace gave
 * it; `startedAtMs` is when the build was started (or triggered).
 */
export function checkBuildResult(workspace: string, startedAtMs: number): BuildCheck {
  // An agent can move its own folder away and put a link in its place. What is behind such a
  // link is not what this build made, whatever it says.
  if (!isOwnFolder(workspace)) return { ok: false, reason: WORKSPACE_REPLACED, neverStarted: false };

  // The agent wrote this file, and what it started may still be running: read it without ever
  // following a link or waiting on a pipe, and take its time from the file that was opened.
  const file = readSmallFile(path.join(workspace, BUILD_STATUS_FILE), MAX_STATUS_BYTES);
  if (!file.ok) return file.why === "missing" ? { ok: false, reason: NO_STATUS_FILE, neverStarted: true } : { ok: false, reason: UNREADABLE_STATUS_FILE, neverStarted: false };
  if (file.mtimeMs < startedAtMs) return { ok: false, reason: STALE_STATUS_FILE, neverStarted: true };

  let parsed;
  try {
    parsed = statusSchema.safeParse(JSON.parse(file.text));
  } catch {
    return { ok: false, reason: UNREADABLE_STATUS_FILE, neverStarted: false };
  }
  if (!parsed.success) return { ok: false, reason: UNREADABLE_STATUS_FILE, neverStarted: false };

  const { status, smoke_test: smoke } = parsed.data;
  if (status === "building") return { ok: false, reason: STOPPED_EARLY, neverStarted: false };
  if (status !== "built") return { ok: false, reason: REPORTED_FAILED, neverStarted: false };
  if (!isPlainDir(path.join(workspace, "dist")) || !isPlainFile(path.join(workspace, "dist", "index.html"))) {
    return { ok: false, reason: NO_DIST, neverStarted: false };
  }
  return { ok: true, smokeTest: smoke === "passed" || smoke === "failed" || smoke === "not_run" ? smoke : "unknown" };
}
