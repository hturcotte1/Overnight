// "Is it running?", asked by only looking at a lock file. The holder in these tests is another
// process that takes the lock with the cli's own takeLock, exactly as `overnight listen`, `build`
// and `deliver` do. Every folder is a scratch folder; nothing here is Bee data.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLockFile, deliverLockFile, listenLockFile, takeLock } from "@overnight/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peekLock, readRunning } from "../src/data/locks.ts";

const HOLDER = fileURLToPath(new URL("./lock-holder.ts", import.meta.url));
const PIPE_CHILD = fileURLToPath(new URL("./pipe-child.ts", import.meta.url));

/** What `peekLock` says about a file, asked in a process of its own that is ended after five seconds if it has not answered. */
function peekElsewhere(lockFile: string): string {
  const ran = spawnSync(process.execPath, [PIPE_CHILD, "lock", lockFile], { timeout: 5000, encoding: "utf8" });
  return ran.status === 0 ? ran.stdout.trim() : `no answer (${ran.signal ?? ran.status})`;
}

let scratch: string;
let file: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard locks "));
  file = buildLockFile({ root: scratch });
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

/** Start another process that takes the lock. Resolves once it has said "held" or "refused". */
function holder(lockFile: string, holdMs = 0): Promise<{ child: ChildProcess; said: string; exited: Promise<void> }> {
  const child = spawn(process.execPath, [HOLDER, lockFile, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return new Promise((resolve, reject) => {
    let said = "";
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      said += String(chunk);
      if (said.includes("\n")) resolve({ child, said: said.trim(), exited });
    });
    child.stdout?.once("close", () => reject(new Error("the lock holder ended without saying whether it got the lock")));
  });
}

/** Every file in the scratch folder with its size and the time it was last changed. */
function listing(): string[] {
  return readdirSync(scratch)
    .sort()
    .map((name) => {
      const info = statSync(path.join(scratch, name));
      return `${name} ${info.size} ${info.mtimeMs}`;
    });
}

describe("looking at a lock", () => {
  it("says nothing is running when there is no lock file, and makes none", () => {
    expect(peekLock(file)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("says nothing is running when the folder is not there either", () => {
    expect(peekLock(path.join(scratch, "no such folder", "build.lock"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("says a lock that was taken and given back is free", () => {
    takeLock(file)?.();
    expect(peekLock(file)).toBe(false);
  });

  it("says a lock held by another process is held, and free again once that process lets go", async () => {
    const other = await holder(file, 400);
    expect(other.said).toBe("held");
    expect(peekLock(file)).toBe(true);
    await other.exited;
    expect(peekLock(file)).toBe(false);
  });

  it("says a lock is free after its holder was killed outright", async () => {
    const other = await holder(file);
    expect(peekLock(file)).toBe(true);
    other.child.kill("SIGKILL");
    await other.exited;
    expect(peekLock(file)).toBe(false);
    // And the next real start gets it.
    const release = takeLock(file);
    expect(release).not.toBeNull();
    release?.();
  });

  it("creates nothing and changes no file, held or free", async () => {
    const other = await holder(file);
    // Taken after the holder started: the holder itself makes a small journal file.
    const whileHeld = listing();
    for (let n = 0; n < 50; n += 1) expect(peekLock(file)).toBe(true);
    expect(listing()).toEqual(whileHeld);

    other.child.kill("SIGKILL");
    await other.exited;
    const afterKill = listing();
    for (let n = 0; n < 50; n += 1) expect(peekLock(file)).toBe(false);
    expect(listing()).toEqual(afterKill);
  });

  it("never turns a real start away, however often it looks", async () => {
    let looking = true;
    let looks = 0;
    const loop = (async () => {
      while (looking) {
        peekLock(file);
        looks += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const said: string[] = [];
    for (let n = 0; n < 12; n += 1) {
      const starter = await holder(file, 20);
      said.push(starter.said);
      await starter.exited;
    }
    looking = false;
    await loop;
    expect(said).toEqual(Array.from({ length: 12 }, () => "held"));
    expect(looks).toBeGreaterThan(100);
  }, 30_000);

  it("says it cannot tell, rather than guess, for a lock file it may not open", () => {
    writeFileSync(file, "");
    chmodSync(file, 0o000);
    try {
      expect(peekLock(file)).toBeNull();
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("says it cannot tell for a file that is not a lock at all", () => {
    writeFileSync(file, "this is not a database, and it is long enough to be looked at as one: ".repeat(40));
    expect(peekLock(file)).toBeNull();
  });

  // Opening a named pipe waits until someone writes into it. The look used to wait with it, for ever, and every page with the look.
  it("says it cannot tell, at once, when a named pipe stands where the lock file should be", () => {
    execFileSync("mkfifo", [file]);
    expect(peekElsewhere(file)).toBe("null");
    expect(readdirSync(scratch)).toEqual([path.basename(file)]);
  }, 15_000);

  it("says it cannot tell, at once, when a named pipe stands where SQLite keeps the lock's journal", () => {
    // A real lock file, taken and given back. Beside it, under the name SQLite reads when it opens the lock: a pipe.
    takeLock(file)?.();
    execFileSync("mkfifo", [`${file}-journal`]);
    expect(peekElsewhere(file)).toBe("null");
    // The same lock with nothing odd beside it is simply free.
    rmSync(`${file}-journal`);
    expect(peekElsewhere(file)).toBe("false");
  }, 15_000);

  it("says it cannot tell for a folder under the lock's name, and follows a link to a real lock", () => {
    const real = path.join(scratch, "the real lock");
    takeLock(real)?.();
    symlinkSync(real, file);
    expect(peekLock(file)).toBe(false);
    rmSync(file);
    mkdirSync(file);
    expect(peekLock(file)).toBeNull();
  });
});

describe("which programs are running", () => {
  it("looks at the three locks by the names the cli gives them", async () => {
    expect(readRunning(scratch)).toEqual({ listener: false, build: false, deliver: false });

    const listening = await holder(listenLockFile({ root: scratch }));
    expect(readRunning(scratch)).toEqual({ listener: true, build: false, deliver: false });

    const delivering = await holder(deliverLockFile({ root: scratch }));
    expect(readRunning(scratch)).toEqual({ listener: true, build: false, deliver: true });

    listening.child.kill("SIGKILL");
    await listening.exited;
    const building = await holder(buildLockFile({ root: scratch }));
    expect(readRunning(scratch)).toEqual({ listener: false, build: true, deliver: true });

    for (const other of [delivering, building]) {
      other.child.kill("SIGKILL");
      await other.exited;
    }
    expect(readRunning(scratch)).toEqual({ listener: false, build: false, deliver: false });
  });

  it("answers for a data folder that does not exist", () => {
    expect(readRunning(path.join(scratch, "nothing here"))).toEqual({ listener: false, build: false, deliver: false });
  });
});
