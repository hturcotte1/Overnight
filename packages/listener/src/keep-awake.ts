// The code that holds the Mac awake lives in @overnight/core, because the night's build and
// deliver runs use it too. This file hands it on, so the listener's own imports stay as they were.
export { startKeepAwake } from "@overnight/core";
export type { KeepAwake, KeepAwakeChild, SpawnKeepAwake } from "@overnight/core";
