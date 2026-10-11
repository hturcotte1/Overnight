// The two text files in crew/ that tell a build agent what to do, and where they live.
//   crew/build-skill.md   how to build one Overnight app (a Kiro Crew skill; also pasted whole
//                         into the Kiro CLI prompt)
//   crew/nightly-job.md   the short message a Kiro Crew build job is given
// Both are our own words. Nothing from an idea is ever put into either.
import path from "node:path";
import { readSmallText } from "./safe-read.ts";

/** The repo root, found from where this file is (packages/builder/src). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
export const BUILD_SKILL_FILE = path.join(REPO_ROOT, "crew", "build-skill.md");
export const JOB_MESSAGE_FILE = path.join(REPO_ROOT, "crew", "nightly-job.md");
/** The name the skill is installed under in Kiro Crew: <crew home>/skills/overnight-build/SKILL.md. */
export const SKILL_NAME = "overnight-build";

export function installedSkillFile(crewHome: string): string {
  return path.join(crewHome, "skills", SKILL_NAME, "SKILL.md");
}

/** Same text, whatever the line endings or the blank lines at either end. */
export function sameText(a: string, b: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  return tidy(a) === tidy(b);
}

/**
 * The skill as plain instructions: the text without the "---" header block that only Kiro Crew
 * reads. (A prompt that starts with "---" could also be mistaken for a command-line option.)
 */
export function skillInstructions(skillText: string): string {
  // A byte-order mark at the very start is not part of the text.
  const text = skillText.charCodeAt(0) === 0xfeff ? skillText.slice(1) : skillText;
  const withoutHeader = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return withoutHeader.trim();
}

/** The Kiro CLI prompt: the skill, then one line saying where the brief is. */
export function kiroCliPrompt(skillText: string, workspace: string): string {
  return `${skillInstructions(skillText)}\n\nThe brief is brief.md in the current folder: ${workspace}.`;
}

/**
 * The Kiro Crew job message: the template with its comment removed, on one line, with the full
 * paths filled in. Throws if the template has lost a placeholder, so a broken template cannot
 * send an agent off without a brief.
 */
export function fillJobMessage(template: string, values: { brief: string; workspace: string; skill: string }): string {
  for (const [name, value] of Object.entries(values)) {
    if (!path.isAbsolute(value)) throw new Error(`The job message needs a full path for ${name}.`);
  }
  const text = template
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text.includes("<BRIEF>") || !text.includes("<WORKSPACE>")) throw new Error("crew/nightly-job.md must contain <BRIEF> and <WORKSPACE>.");
  return text.replaceAll("<BRIEF>", values.brief).replaceAll("<WORKSPACE>", values.workspace).replaceAll("<SKILL>", values.skill);
}

/** Our own two files are a few kilobytes. The installed copy of the skill is read with the same limit. */
const MAX_TEXT_BYTES = 256 * 1024;

/**
 * The text of one of these files, or null when it is missing or is not a plain file of a sane
 * size. Used for the installed skill too, which sits in a folder a Kiro Crew job can write: it
 * is read without following a link and without ever waiting on a pipe (see safe-read.ts).
 */
export function readTextFile(file: string): string | null {
  return readSmallText(file, MAX_TEXT_BYTES);
}
