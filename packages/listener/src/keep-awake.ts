// Holds the Mac awake while the listener runs, using macOS's own `caffeinate`.
// `-s` only works while plugged in; on battery the Mac may still sleep, which is what we want.
// `-w <pid>` makes caffeinate exit by itself if we die without stopping it.
import { spawn } from "node:child_process";
import { errorSummary } from "@overnight/core";
import type { Logger } from "@overnight/core";

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

const spawnDetachedFromOutput: SpawnKeepAwake = (command, args) => spawn(command, args, { stdio: "ignore" });

/** Start caffeinate for `pid`. A failure to start is logged and otherwise ignored: listening matters more. */
export function startKeepAwake(logger: Logger, pid: number = process.pid, spawnChild: SpawnKeepAwake = spawnDetachedFromOutput): KeepAwake {
  let stopping = false;
  let child: KeepAwakeChild | null = null;
  try {
    child = spawnChild(CAFFEINATE, ["-s", "-w", String(pid)]);
    child.on("error", (error) => logger.warn("could not keep the Mac awake", { error: errorSummary(error) }));
    child.on("exit", (code) => {
      if (!stopping) logger.warn("the keep-awake helper stopped by itself", { code });
    });
    logger.info("keeping the Mac awake while plugged in");
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
