// What stands in for Bee, and for the publisher, during `overnight rehearse run`.
//
// A rehearsal builds, checks and (unless told not to) publishes for real, but it never tells Bee
// anything: nothing may land on the wearer's wrist or in their Bee account because of a test.
// The stand-in below has the shape of the Bee gateway and none of its reach. It starts no
// program and opens no connection. Whatever the deliver step would have sent, it writes as one
// line to <data folder>/rehearsal-bee.log (private to the user) and answers as Bee would have.
//
// This file must never import @overnight/bee. A test checks that the real gateway is never made
// on the rehearsal path.
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { BeeGateway, DataPaths } from "@overnight/core";
import type { StandInPublisher } from "./commands/deliver.ts";

export const REHEARSAL_BEE_LOG = "rehearsal-bee.log";

/** Where the stand-ins write what would have been sent: <data folder>/rehearsal-bee.log. */
export function rehearsalBeeLogFile(paths: Pick<DataPaths, "root">): string {
  return path.join(paths.root, REHEARSAL_BEE_LOG);
}

/** The id the stand-in answers with for a to-do or a fact it did not create. No real Bee id is 0. */
export const STAND_IN_ID = 0;
/** Where a rehearsal with --no-publish says the app is. ".invalid" can never be a real site. */
export const STAND_IN_SITE = "https://rehearsal.invalid";

/**
 * Add one line to the log. The file is created private (0600) and made private again if it is
 * not, and a symbolic link in its place is refused rather than written through.
 */
function note(file: string, now: () => Date, row: Record<string, unknown>): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify({ at: now().toISOString(), ...row })}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface StandInOptions {
  /** The log file: rehearsalBeeLogFile(paths). */
  file: string;
  now?: () => Date;
}

/**
 * A Bee gateway that reaches nothing. Creating a to-do or a fact only writes what would have been
 * sent to the log; reading answers as an empty, logged-in Bee would; the live stream is refused.
 */
export function createStandInBee(options: StandInOptions): BeeGateway & { dispose: () => void } {
  const now = options.now ?? (() => new Date());
  return {
    loginState: async () => "logged-in",
    stream: () => {
      throw new Error("A rehearsal has no Bee to listen to: its Bee is a stand-in.");
    },
    changedSince: async () => ({ nextCursor: null, conversationIds: [] }),
    transcriptSince: async () => null,
    todoStatus: async () => "open",
    createTodo: async (text, alarmAt) => {
      note(options.file, now, { wouldCreate: "todo", text, alarmAt: alarmAt.toISOString() });
      return { id: STAND_IN_ID };
    },
    createFact: async (text) => {
      note(options.file, now, { wouldCreate: "fact", text });
      return { id: STAND_IN_ID };
    },
    dispose: () => {},
  };
}

/** A publisher that publishes nothing: it notes which app it was handed and answers with a link that cannot exist. */
export function createStandInPublisher(options: StandInOptions): StandInPublisher {
  const now = options.now ?? (() => new Date());
  return {
    publish: async (job) => {
      note(options.file, now, { wouldPublish: job.slug });
      return { ok: true, url: `${STAND_IN_SITE}/${job.slug}/`, liveAfterMs: 0 };
    },
  };
}
