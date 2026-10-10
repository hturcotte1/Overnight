// Kiro saves every chat as two files in <KIRO_HOME>/sessions/cli/: between them, the whole prompt
// (so the transcript) and the reply. The detector never resumes a chat, so for us they are only a
// second copy of what was heard, outside SQLite, that would grow for ever. This removes old ones.
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Where Kiro CLI keeps the saved chats of the KIRO_HOME it was given. */
export function savedSessionsDir(kiroHome: string): string {
  return path.join(kiroHome, "sessions", "cli");
}

/**
 * Delete the saved chats last written more than `maxAgeMs` before `nowMs`. Returns how many
 * files went. Only plain files directly in the sessions folder are touched. Never throws: a
 * missing folder or a file that will not go is left for next time.
 */
export async function pruneSavedSessions(kiroHome: string, nowMs: number, maxAgeMs: number = SESSION_MAX_AGE_MS): Promise<number> {
  const dir = savedSessionsDir(kiroHome);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || nowMs - info.mtimeMs <= maxAgeMs) continue;
      await unlink(file);
      removed += 1;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
