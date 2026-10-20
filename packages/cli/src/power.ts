// Two small questions about this Mac: is it plugged in, and is its lid closed?
//
// The first is one row of `overnight status`. Both together are the one thing about power that
// holds a night run up: on battery with the lid closed nothing is started (night-tick.ts). No run
// waits for mains power as such. On battery Overnight holds the Mac awake itself while its lid is
// open; with the lid closed a Mac on battery sleeps whatever any program asks, and a run started
// in one of the moments it wakes by itself would be cut short by the sleep that follows.
//
// Power is asked of macOS's own `pmset -g ps`, whose first line reads
//   Now drawing from 'AC Power'        or        Now drawing from 'Battery Power'
// The lid is asked of macOS's own `ioreg -r -k AppleClamshellState -d 4`, which prints the line
//   "AppleClamshellState" = No         or        "AppleClamshellState" = Yes
// among many others ("clamshell" is the hardware's word for the lid; Yes is closed). A Mac
// without a lid has no such line. Nothing else either program prints is kept.
import { runQuiet } from "./run-quiet.ts";

export type PowerSource = "mains" | "battery" | "unknown";

const PMSET = "/usr/bin/pmset";
const IOREG = "/usr/sbin/ioreg";
/** macOS's own programs only: nothing from the user's PATH is ever started for these two questions. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const POWER_TIMEOUT_MS = 5_000;

/** What `pmset -g ps` printed, as one of three words. Anything that is not one of the two known lines is "unknown". */
export function parsePowerSource(text: string): PowerSource {
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1];
  if (source === "AC Power") return "mains";
  if (source === "Battery Power") return "battery";
  return "unknown";
}

/** One reading. Never throws: a pmset that will not start, fails or takes too long is "unknown". */
export async function readPowerSource(run: typeof runQuiet = runQuiet): Promise<PowerSource> {
  try {
    const result = await run(PMSET, ["-g", "ps"], { env: { PATH: SYSTEM_PATH }, timeoutMs: POWER_TIMEOUT_MS, keepOutput: true });
    if (!result.started || result.timedOut || result.exitCode !== 0) return "unknown";
    return parsePowerSource(result.output);
  } catch {
    return "unknown";
  }
}

/**
 * What `ioreg -r -k AppleClamshellState -d 4` printed: true for a closed lid, false for an open
 * one, null when it does not say. It goes by whole lines of the form `"AppleClamshellState" = Yes`
 * (or No), after ioreg's own indentation. No such line (a Mac without a lid, or something else
 * entirely) is null, and so are lines that disagree with each other.
 */
export function parseLidClosed(text: string): boolean | null {
  const answers = new Set(Array.from(text.matchAll(/^[ \t|]*"AppleClamshellState" = (Yes|No)[ \t]*$/gm), (line) => line[1]));
  if (answers.size !== 1) return null;
  return answers.has("Yes");
}

/**
 * One reading: is the lid closed? Null when that cannot be told. Never throws: an ioreg that will
 * not start, fails or takes too long is null, and so is a Mac that has no lid.
 */
export async function readLidClosed(run: typeof runQuiet = runQuiet): Promise<boolean | null> {
  try {
    const result = await run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"], { env: { PATH: SYSTEM_PATH }, timeoutMs: POWER_TIMEOUT_MS, keepOutput: true });
    if (!result.started || result.timedOut || result.exitCode !== 0) return null;
    return parseLidClosed(result.output);
  } catch {
    return null;
  }
}

/**
 * Is this Mac on battery with its lid closed? Yes only when both readings say so in plain words.
 * "Could not tell" on either side is a no: a reading that cannot be made must never hold a run up.
 */
export function isLidClosedOnBattery(power: PowerSource, lidClosed: boolean | null): boolean {
  return power === "battery" && lidClosed === true;
}
