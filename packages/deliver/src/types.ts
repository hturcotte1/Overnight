// The contracts of the deliver step. runDeliver() is written against these, so its tests can
// swap in a fake verifier, a fake publisher and a fake command runner.
import type { BeeGateway, Config, DataPaths, Logger, Store } from "@overnight/core";
import type { Leftovers, TrackOptions } from "./process-watch.ts";

export interface CommandOptions {
  cwd?: string;
  /** When given, this is the program's WHOLE environment (nothing is inherited). Left out, the program inherits ours. */
  env?: Record<string, string>;
  /** After this long the program and everything it started are killed and `timedOut` is true. */
  timeoutMs: number;
  /** When this fires the program and everything it started are killed and `stopped` is true. */
  signal?: AbortSignal;
  /**
   * Ask for everything the program started to be hunted down once it has ended, also what left
   * its process group. What was found is reported in `leftovers`.
   */
  track?: TrackOptions;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the program could not be started at all (or could not be stopped). */
  error?: string;
  /** Set when the program was killed because `signal` fired. */
  stopped?: true;
  /** Set when `track` was asked for. A runner that cannot track leaves it out. */
  leftovers?: Leftovers;
}

/** Run one program to the end. Never rejects. */
export type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

/** Yes/no answers, counts and timings from a verification. Never text from the app or its tools. */
export type VerifyChecks = Record<string, boolean | number | string>;

export type VerifyResult =
  | { ok: true; distDir: string; screenshotPhone: string; screenshotDesktop: string; checks: VerifyChecks }
  | {
      ok: false;
      reason: string;
      checks: VerifyChecks;
      /** True when the verification was cut short by a stop signal: this says nothing about the app. */
      stopped?: true;
    };

export interface VerifyJob {
  ideaId: string;
  /** The folder the build agent worked in. */
  workspace: string;
  /** A throwaway folder that must be missing or empty; on success `distDir` (the checked copy to publish) is inside it. */
  runDir: string;
  /** Fires when Overnight is being stopped: end the current step, kill its programs, return. */
  signal?: AbortSignal;
}

/** Decides whether a built app may be published. Never throws: a problem comes back as { ok: false }. */
export interface Verifier {
  verify(job: VerifyJob): Promise<VerifyResult>;
}

export type PublishResult =
  | {
      /** Pushed, and the page was seen serving exactly this build. */
      ok: true;
      url: string;
      /** How long after the push the page served this build. */
      liveAfterMs: number;
      confirmedLive?: true;
    }
  | {
      /**
       * Pushed, and nothing went wrong, but the page was not seen serving this build before the
       * wait ran out. GitHub Pages usually catches up a little later, so this counts as published;
       * `url` is the link the app has (or will have).
       */
      ok: true;
      url: string;
      liveAfterMs: null;
      confirmedLive: false;
      /** How long the publisher looked for the page after the push. */
      waitedMs: number;
    }
  | {
      ok: false;
      reason: string;
      /** True when the publish was cut short by a stop signal: this says nothing about the app. */
      stopped?: true;
      /** True when the new version has, or may have, reached GitHub although the publish did not finish. */
      pushed?: true;
    };

export interface PublishJob {
  ideaId: string;
  slug: string;
  distDir: string;
  /** Must be new for every publish: the page counts as live once it serves this marker. */
  marker: string;
  /** Fires when Overnight is being stopped. */
  signal?: AbortSignal;
}

/**
 * Puts a checked dist folder on the public web. Never throws. Safe to repeat: publishing an idea
 * that an earlier, interrupted run already pushed simply replaces that version with this one.
 */
export interface Publisher {
  publish(job: PublishJob): Promise<PublishResult>;
}

export interface DeliverDeps {
  store: Store;
  bee: BeeGateway;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  /** The only source of "now" for anything stored or compared. Default: the real clock. */
  now?: () => Date;
  /** Default: the sandboxed verifier. */
  verify?: Verifier;
  /** Default: the GitHub Pages publisher. */
  publish?: Publisher;
  /** Default: really start programs. Handed to the default verifier and publisher. */
  run?: CommandRunner;
  /** How long to wait before asking Bee again after it refused a to-do. Default 5 seconds. */
  retryDelayMs?: number;
  /**
   * The stop signal (the command line fires it on SIGTERM and SIGINT). When it fires, the step in
   * progress is ended and its programs killed, nothing new is started, the idea in progress is
   * left where the next run picks it up, and the call resolves within 10 seconds.
   */
  signal?: AbortSignal;
  /** For tests: how long a Bee call that is in flight when the stop signal fires may still take. Default 6 seconds. */
  stopGraceMs?: number;
}

export interface DeliverSummary {
  /** Ideas whose morning to-do went out in this run. */
  delivered: string[];
  /** Ideas this run could not deliver: verification or publishing failed, or Bee refused the to-do. */
  failed: string[];
  /** Ideas whose "couldn't finish" to-do went out in this run. */
  notified: string[];
  /** True when the run was cut short by the stop signal. What it had not reached waits for the next run. */
  stopped?: true;
  /**
   * Ideas this run pushed whose page was not seen live before the wait ran out. They are recorded
   * as published and announced like any other, so they also appear in `delivered` (or in `failed`
   * if Bee refused the to-do). Left out when there are none.
   */
  notSeenLive?: string[];
}

export interface DeliverOneResult {
  ok: boolean;
  url?: string;
  reason?: string;
  /** True when the delivery was cut short by the stop signal. */
  stopped?: true;
  /** True when this call pushed the app but its page was not seen live before the wait ran out. The link may need a few more minutes. */
  notSeenLive?: true;
}
