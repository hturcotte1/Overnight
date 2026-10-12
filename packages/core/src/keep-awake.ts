// Holds the Mac awake while one of our programs runs, using macOS's own `caffeinate`.
// Two ways to hold it:
//   "mains"   `-s` only. It works while plugged in; on battery the Mac may still sleep.
//   "always"  `-i -s`. `-i` also stops the Mac falling asleep by itself on battery. Nothing keeps
//             a Mac awake on battery once its lid is closed.
// `-w <pid>` makes caffeinate exit by itself if we die without stopping it.
import { spawn } from "node:child_process";
import { errorSummary } from "./logger.ts";
import type { Logger } from "./logger.ts";

const CAFFEINATE = "/usr/bin/caffeinate";

export interface KeepAwakeChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type SpawnKeepAwake = (command: string, args: string[]) => KeepAwakeChild;

export interface KeepAwake {
  stop(): void;
}

export type KeepAwakeMode = "mains" | "always";

const MODES: Record<KeepAwakeMode, { flags: string[]; started: string }> = {
  mains: { flags: ["-s"], started: "keeping the Mac awake while plugged in" },
  always: { flags: ["-i", "-s"], started: "keeping the Mac awake while this runs" },
};

const spawnDetachedFromOutput: SpawnKeepAwake = (command, args) => spawn(command, args, { stdio: "ignore" });

/** Start caffeinate for `pid`. A failure to start is logged and otherwise ignored: the work matters more. */
export function startKeepAwake(logger: Logger, pid: number = process.pid, spawnChild: SpawnKeepAwake = spawnDetachedFromOutput, mode: KeepAwakeMode = "mains"): KeepAwake {
  let stopping = false;
  let child: KeepAwakeChild | null = null;
  try {
    child = spawnChild(CAFFEINATE, [...MODES[mode].flags, "-w", String(pid)]);
    child.on("error", (error) => logger.warn("could not keep the Mac awake", { error: errorSummary(error) }));
    child.on("exit", (code) => {
      if (!stopping) logger.warn("the keep-awake helper stopped by itself", { code });
    });
    logger.info(MODES[mode].started);
  } catch (error) {
    logger.warn("could not keep the Mac awake", { error: errorSummary(error) });
  }
  return {
    stop() {
      stopping = true;
      child?.kill();
      child = null;
    },
  };
}
