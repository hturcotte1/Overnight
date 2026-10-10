// `overnight pause` and `overnight resume`: the two halves of one switch.
// The switch lives in the database, so a listener that is already running sees it without a restart.
import { nowIso } from "@overnight/core";
import type { Store } from "@overnight/core";
import type { Write } from "../output.ts";

export interface PauseDeps {
  store: Pick<Store, "setPaused">;
  write: Write;
  now?: () => Date;
}

export const PAUSED_LINE = "Paused: Overnight still listens and saves, but will not ask or build.";
export const RESUMED_LINE = "Resumed: Overnight will ask about new ideas and build approved ones again.";

export function pause(deps: PauseDeps): number {
  deps.store.setPaused(true, nowIso(deps.now?.()));
  deps.write(PAUSED_LINE);
  return 0;
}

export function resume(deps: PauseDeps): number {
  deps.store.setPaused(false, nowIso(deps.now?.()));
  deps.write(RESUMED_LINE);
  return 0;
}
