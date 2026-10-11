// Keeping Kiro's sign-in fresh for a sandboxed build.
//
// Kiro's sign-in lasts about an hour, and Kiro CLI renews it with a secret it keeps in the macOS
// Keychain. A build runs inside a sandbox that closes the Keychain on purpose (the GitHub login
// is in there), so a build cannot renew the sign-in: Kiro inside the sandbox then says "You are
// not logged in". Found on Oct 10, when a Kiro Crew gateway started inside the sandbox more than
// an hour after the last renewal.
//
// A renewal made OUTSIDE the sandbox is kept where every Kiro program finds it, inside or out.
// So before each build our own code, outside the sandbox, asks Kiro "who am I". That renews a
// sign-in that has run out. One that has not run out is left as it is, and Kiro has no command
// to renew it early; if it has only a few minutes left we wait for it to run out and ask again,
// so the build starts with close to a full hour.
//
// What Kiro prints here names the account. It is looked at in memory for two things (signed in
// or not, and how long the sign-in still lasts) and goes nowhere else.
import { tmpdir } from "node:os";
import type { Logger } from "@overnight/core";
import { abortableSleep } from "./crew-client.ts";
import { findKiroBinary } from "./kiro-cli.ts";
import { createCommandRunner, minimalEnv } from "./run.ts";
import type { CommandRunner } from "./run.ts";
import { MINUTE_MS } from "./types.ts";

export const SIGNED_OUT_REASON = "Kiro is signed out on this Mac (to fix it, run: kiro-cli login)";
/** A build must start with at least this much of the sign-in left. Real builds take 2 to 4 minutes. */
export const MIN_SIGN_IN_LEFT_MS = 10 * MINUTE_MS;
/** `kiro-cli whoami` answers in under a second; a renewal needs one round trip to Kiro. */
export const SIGN_IN_TIMEOUT_MS = 60_000;
/** After the sign-in has run out, this long before asking again. */
const AFTER_EXPIRY_MS = 5_000;

export type SignInRenewal =
  /** Signed in. `leftMs` is how long the sign-in still lasts, or null when Kiro did not say. */
  | { ok: true; leftMs: number | null; waitedMs: number }
  /** Signed out, so no build can work. */
  | { ok: false; reason: string };

export type RenewSignIn = (signal?: AbortSignal) => Promise<SignInRenewal>;

export interface KiroSignInOptions {
  logger: Logger;
  /** Default: ~/.local/bin/kiro-cli, or the app's own copy. */
  kiroBinary?: string;
  run?: CommandRunner;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  minLeftMs?: number;
}

/**
 * How long the sign-in still lasts, from Kiro's detailed output ("... valid_for=3567.288882s").
 * Null when the output does not say: the wording is Kiro's own and may change.
 */
export function signInLeftMs(output: string): number | null {
  const all = [...output.matchAll(/\bvalid_for=([0-9]+(?:\.[0-9]+)?)s\b/g)];
  const last = all.at(-1)?.[1];
  if (last === undefined) return null;
  const seconds = Number(last);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

type Answer = { state: "in"; leftMs: number | null } | { state: "out" } | { state: "unknown" };

/**
 * Returns the function the night flow calls before each build. It never throws. When Kiro cannot
 * be asked at all (not installed, no answer in time) it answers "signed in, time left unknown":
 * the build is then tried anyway, and fails by itself if Kiro really is signed out.
 */
export function createKiroSignInRenewal(options: KiroSignInOptions): RenewSignIn {
  const { logger } = options;
  const run = options.run ?? createCommandRunner();
  const sleep = options.sleep ?? abortableSleep;
  const minLeftMs = options.minLeftMs ?? MIN_SIGN_IN_LEFT_MS;

  const ask = async (signal?: AbortSignal): Promise<Answer> => {
    const binary = options.kiroBinary ?? findKiroBinary();
    if (binary === null) return { state: "unknown" };
    // Outside any sandbox, with nothing of ours in the environment. -vvv makes Kiro say how long
    // the sign-in still lasts.
    const result = await run(binary, ["whoami", "-vvv"], { cwd: tmpdir(), env: minimalEnv(), timeoutMs: SIGN_IN_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    if (result.error !== undefined || result.timedOut) return { state: "unknown" };
    const said = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /not logged in|kiro-cli login/i.test(said)) return { state: "out" };
    return { state: "in", leftMs: signInLeftMs(said) };
  };

  return async (signal) => {
    // Asked afresh each time: the signal can be aborted while we wait.
    const stopping = (): boolean => signal?.aborted === true;
    try {
      let answer = await ask(signal);
      let waitedMs = 0;
      if (answer.state === "in" && answer.leftMs !== null && answer.leftMs < minLeftMs && !stopping()) {
        // Too little left for a build, and it cannot be renewed early: let it run out, then ask
        // again, which renews it.
        waitedMs = answer.leftMs + AFTER_EXPIRY_MS;
        logger.info("Kiro's sign-in is about to run out; waiting for that, then renewing it before the build", { waitSeconds: Math.round(waitedMs / 1000) });
        await sleep(waitedMs, signal);
        if (!stopping()) answer = await ask(signal);
      }
      if (answer.state === "out") {
        logger.error("Kiro is signed out, so nothing can be built", {});
        return { ok: false, reason: SIGNED_OUT_REASON };
      }
      if (answer.state === "unknown") {
        logger.warn("could not ask Kiro whether it is signed in; trying the build anyway", {});
        return { ok: true, leftMs: null, waitedMs };
      }
      logger.info("Kiro's sign-in is ready for the build", { minutesLeft: answer.leftMs === null ? null : Math.round(answer.leftMs / MINUTE_MS), waitedSeconds: Math.round(waitedMs / 1000) });
      return { ok: true, leftMs: answer.leftMs, waitedMs };
    } catch {
      logger.warn("could not ask Kiro whether it is signed in; trying the build anyway", {});
      return { ok: true, leftMs: null, waitedMs: 0 };
    }
  };
}
