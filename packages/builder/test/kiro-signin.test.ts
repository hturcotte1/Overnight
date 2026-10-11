import { describe, expect, it } from "vitest";
import { createKiroSignInRenewal, MIN_SIGN_IN_LEFT_MS, SIGNED_OUT_REASON, signInLeftMs } from "../src/kiro-signin.ts";
import type { CommandResult, CommandRunner, RunOptions } from "../src/run.ts";

// Everything here is made up: no Kiro program is started.
const said = (stdout: string, exitCode = 0): CommandResult => ({ stdout, stderr: "", exitCode, timedOut: false });
const signedIn = (seconds: number): CommandResult => said(`someone@made-up.example\nDEBUG identity cache miss occurred; added new identity (took 1ms) valid_for=${seconds}s\n`);
const quiet = { debug() {}, info() {}, warn() {}, error() {} } as never;

function rig(replies: CommandResult[]) {
  const calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  const sleeps: number[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return replies.shift() ?? said("", 1);
  };
  const renew = createKiroSignInRenewal({ logger: quiet, kiroBinary: "/made-up/kiro-cli", run, sleep: async (ms) => void sleeps.push(ms) });
  return { renew, calls, sleeps };
}

describe("signInLeftMs", () => {
  it("reads how long the sign-in still lasts, from the last such line", () => {
    expect(signInLeftMs("x valid_for=10s\ny valid_for=3567.288882s z")).toBe(3567289);
    expect(signInLeftMs("valid_for=0s")).toBe(0);
  });

  it("is null when Kiro's output does not say", () => {
    expect(signInLeftMs("")).toBeNull();
    expect(signInLeftMs("valid_for=soon")).toBeNull();
    expect(signInLeftMs("invalid_for=12s")).toBeNull();
  });
});

describe("createKiroSignInRenewal", () => {
  it("asks Kiro who am I, outside any sandbox, with nothing of ours in the environment", async () => {
    process.env.OVERNIGHT_TEST_SECRET = "made-up-secret";
    try {
      const { renew, calls, sleeps } = rig([signedIn(3500)]);
      expect(await renew()).toEqual({ ok: true, leftMs: 3_500_000, waitedMs: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("/made-up/kiro-cli");
      expect(calls[0]?.args).toEqual(["whoami", "-vvv"]);
      expect(Object.keys(calls[0]?.options.env ?? {}).sort()).toEqual(["HOME", "NO_COLOR", "PATH", "TMPDIR"]);
      expect(calls[0]?.options.env?.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(sleeps).toEqual([]);
    } finally {
      delete process.env.OVERNIGHT_TEST_SECRET;
    }
  });

  it("waits for a sign-in that is about to run out, then asks again so the build starts with a fresh one", async () => {
    const { renew, calls, sleeps } = rig([signedIn(120), signedIn(3599)]);
    expect(await renew()).toEqual({ ok: true, leftMs: 3_599_000, waitedMs: 125_000 });
    expect(sleeps).toEqual([125_000]);
    expect(calls).toHaveLength(2);
  });

  it("does not wait when there is enough left for a build", async () => {
    const enough = MIN_SIGN_IN_LEFT_MS / 1000;
    const { renew, calls, sleeps } = rig([signedIn(enough)]);
    expect((await renew()).ok).toBe(true);
    expect(sleeps).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("says signed out, in our own words, when Kiro says so or exits badly", async () => {
    expect(await rig([said("error: You are not logged in, please log in with kiro-cli login", 1)]).renew()).toEqual({ ok: false, reason: SIGNED_OUT_REASON });
    expect(await rig([said("something else", 3)]).renew()).toEqual({ ok: false, reason: SIGNED_OUT_REASON });
    // Signed out after the wait counts too.
    expect(await rig([signedIn(1), said("Not logged in", 1)]).renew()).toEqual({ ok: false, reason: SIGNED_OUT_REASON });
  });

  it("lets the build be tried when Kiro cannot be asked, or does not say how long is left", async () => {
    expect(await rig([{ stdout: "", stderr: "", exitCode: null, timedOut: true }]).renew()).toEqual({ ok: true, leftMs: null, waitedMs: 0 });
    expect(await rig([{ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "could not start" }]).renew()).toEqual({ ok: true, leftMs: null, waitedMs: 0 });
    expect(await rig([said("someone@made-up.example")]).renew()).toEqual({ ok: true, leftMs: null, waitedMs: 0 });
  });

  it("never throws, and does not ask again once it is being stopped", async () => {
    const throwing = createKiroSignInRenewal({
      logger: quiet,
      kiroBinary: "/made-up/kiro-cli",
      run: async () => {
        throw new Error("made up");
      },
    });
    expect(await throwing()).toEqual({ ok: true, leftMs: null, waitedMs: 0 });

    const stop = new AbortController();
    const calls: string[][] = [];
    const renew = createKiroSignInRenewal({
      logger: quiet,
      kiroBinary: "/made-up/kiro-cli",
      run: async (_command, args) => {
        calls.push(args);
        return signedIn(30);
      },
      sleep: async () => stop.abort(),
    });
    expect((await renew(stop.signal)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
