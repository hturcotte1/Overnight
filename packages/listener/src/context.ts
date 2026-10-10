// What every part of the listener is handed. All of it is passed in, so tests can use fakes
// and a clock they control.
import { BeeError } from "@overnight/core";
import type { BeeGateway, Config, Detector, Logger, Store } from "@overnight/core";
import type { ListenerOptions } from "./options.ts";

export interface ListenerContext {
  store: Store;
  bee: BeeGateway;
  detector: Detector;
  config: Config;
  logger: Logger;
  /** The only source of "now" for anything stored or compared. */
  now: () => Date;
  options: ListenerOptions;
  /**
   * Called by a pass when a Bee call says "logged out". The run loop then stops the passes and
   * goes back to waiting for a login, instead of each pass finding out again every few seconds.
   */
  onLoggedOut: () => void;
}

/** The kind of a Bee failure, for logs and notes. Anything that is not a BeeError is "unexpected". */
export function beeErrorKind(error: unknown): BeeError["kind"] | "unexpected" {
  return error instanceof BeeError ? error.kind : "unexpected";
}
