// Is this Mac plugged in? For one row of `overnight status`, and for nothing else: no run waits
// for mains power. (On battery Overnight holds the Mac awake itself while its lid is open; with
// the lid closed a Mac on battery sleeps whatever any program asks.)
//
// Asked of macOS's own `pmset -g ps`, whose first line reads
//   Now drawing from 'AC Power'        or        Now drawing from 'Battery Power'
// Nothing else it prints is kept.
import { runQuiet } from "./run-quiet.ts";

export type PowerSource = "mains" | "battery" | "unknown";

const PMSET = "/usr/bin/pmset";
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
    const result = await run(PMSET, ["-g", "ps"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: POWER_TIMEOUT_MS, keepOutput: true });
    if (!result.started || result.timedOut || result.exitCode !== 0) return "unknown";
    return parsePowerSource(result.output);
  } catch {
    return "unknown";
  }
}
