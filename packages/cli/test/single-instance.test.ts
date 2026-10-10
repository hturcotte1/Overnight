// The one-listener-per-data-folder lock, against real files in a scratch folder. Nothing here is Bee data.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_LABEL, jobSettingsFile, readListenerState } from "../src/background.ts";
import { listenLockFile, listenLockHeld, takeListenLock } from "../src/single-instance.ts";

const HOLDER = fileURLToPath(new URL("./lock-holder.ts", import.meta.url));

let scratch: string;
let file: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight lock "));
  file = listenLockFile({ root: scratch });
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

/** Start another process that tries to take the lock. Resolves once it has said "held" or "refused". */
function otherProcess(holdMs = 0): Promise<{ child: ChildProcess; said: string; exited: Promise<number | null> }> {
  const child = spawn(process.execPath, [HOLDER, file, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    let said = "";
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      said += String(chunk);
      if (said.includes("\n")) resolve({ child, said: said.trim(), exited });
    });
    // Reached only if it ended without saying anything (a resolved promise ignores this).
    child.stdout?.once("close", () => reject(new Error("the lock holder ended without saying whether it got the lock")));
  });
}

describe("the listen lock", () => {
  it("lives in the data folder", () => {
    expect(file).toBe(path.join(scratch, "listen.lock"));
  });

  it("is given to the first taker and refused to the second, until the first lets go", () => {
    const release = takeListenLock(file, 0);
    expect(release).not.toBeNull();
    expect(takeListenLock(file, 0)).toBeNull();

    release?.();
    release?.(); // letting go twice is harmless
    const again = takeListenLock(file, 0);
    expect(again).not.toBeNull();
    again?.();
  });

  it("keeps a private, empty lock file and leaves nothing else behind", () => {
    const release = takeListenLock(file, 0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    release?.();
    expect(readdirSync(scratch)).toEqual(["listen.lock"]);
    expect(statSync(file).size).toBe(0);
  });

  it("throws, rather than pretending, when the lock file cannot be used", () => {
    expect(() => takeListenLock(path.join(scratch, "no such folder", "listen.lock"), 0)).toThrow();
  });

  it("can be looked at without being taken or created", () => {
    expect(listenLockHeld(file)).toBe(false);
    expect(existsSync(file)).toBe(false);

    const release = takeListenLock(file, 0);
    expect(listenLockHeld(file)).toBe(true);
    release?.();
    expect(listenLockHeld(file)).toBe(false);

    // Looking did not take it: a listener can still start.
    const again = takeListenLock(file, 0);
    expect(again).not.toBeNull();
    again?.();
  });

  it("says it could not tell when the lock file is not a file", () => {
    mkdirSync(file);
    expect(listenLockHeld(file)).toBeNull();
  });

  it("is held against another process, and is free again the moment that process is killed", async () => {
    const other = await otherProcess();
    expect(other.said).toBe("held");

    expect(takeListenLock(file, 0)).toBeNull();
    expect(listenLockHeld(file)).toBe(true);
    // A second listener started as its own process is refused too.
    const second = await otherProcess();
    expect(second.said).toBe("refused");
    expect(await second.exited).toBe(1);

    // Killed outright, with no chance to tidy up: the lock must not be left behind.
    other.child.kill("SIGKILL");
    await other.exited;
    expect(listenLockHeld(file)).toBe(false);
    const release = takeListenLock(file, 0);
    expect(release).not.toBeNull();
    release?.();
  }, 30_000);

  it("waits out a brief hold, so a look from `overnight status` never turns a real start away", async () => {
    const other = await otherProcess(300);
    expect(other.said).toBe("held");
    const release = takeListenLock(file, 8000);
    expect(release).not.toBeNull();
    release?.();
    await other.exited;
  }, 30_000);
});

describe("what status can tell about the listener", () => {
  it("reports whether one is running on this data folder and whether the job's settings file is in place", () => {
    const home = path.join(scratch, "home of someone");
    const paths = { root: path.join(scratch, "data folder") };
    mkdirSync(paths.root, { recursive: true });
    expect(readListenerState(paths, home)).toEqual({ running: false, jobInstalled: false });

    const release = takeListenLock(listenLockFile(paths), 0);
    expect(readListenerState(paths, home)).toEqual({ running: true, jobInstalled: false });
    release?.();

    // An empty stand-in for the settings file the installer writes.
    mkdirSync(path.dirname(jobSettingsFile(home)), { recursive: true });
    writeFileSync(jobSettingsFile(home), "");
    expect(readListenerState(paths, home)).toEqual({ running: false, jobInstalled: true });
  });

  it("looks for the settings file where the installer puts it", () => {
    expect(jobSettingsFile("/Users/someone")).toBe("/Users/someone/Library/LaunchAgents/com.overnight.listen.plist");
    expect(JOB_LABEL).toBe("com.overnight.listen");
  });
});
