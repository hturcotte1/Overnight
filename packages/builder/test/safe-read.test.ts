// All text in this file is made up for the tests. None of it is Bee data.
// Reading a file that an agent may have written: never a link, never a pipe, never too much.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_STATUS_FILE, checkBuildResult, crewSettingsProblem } from "../src/index.ts";
import { judgeProbe } from "../src/probe.ts";
import { readSmallFile, readSmallText } from "../src/safe-read.ts";
import { leaveBuild, tempDir } from "./helpers.ts";

function mkfifo(file: string): void {
  expect(spawnSync("/usr/bin/mkfifo", [file]).status).toBe(0);
}

/**
 * End a helper program and wait until it is really gone. A test that returns while its helper is
 * still renaming files races with its own clean-up: the helper can put a file back into the
 * test's folder while that folder is being removed, and the removal then fails ("ENOTEMPTY").
 */
function ended(helper: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // Gone already, or never started: nothing to wait for.
    if (helper.pid === undefined || helper.exitCode !== null || helper.signalCode !== null) return resolve();
    helper.once("exit", () => resolve());
    helper.once("error", () => resolve());
    helper.kill("SIGKILL");
  });
}

describe("readSmallFile", () => {
  it("reads a plain file, with the size and time of the file it opened", () => {
    const file = path.join(tempDir(), "status.json");
    writeFileSync(file, '{"status":"built"}');
    const at = new Date("2026-10-10T07:00:00.000Z");
    utimesSync(file, at, at);
    expect(readSmallFile(file, 100)).toEqual({ ok: true, text: '{"status":"built"}', size: 18, mtimeMs: at.getTime() });
    expect(readSmallText(file, 100)).toBe('{"status":"built"}');
  });

  it("reads an empty file as empty text, and a file of exactly the limit", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "empty"), "");
    expect(readSmallFile(path.join(dir, "empty"), 10)).toMatchObject({ ok: true, text: "", size: 0 });
    writeFileSync(path.join(dir, "ten"), "0123456789");
    expect(readSmallFile(path.join(dir, "ten"), 10)).toMatchObject({ ok: true, text: "0123456789" });
    expect(readSmallFile(path.join(dir, "ten"), 9)).toEqual({ ok: false, why: "too-large" });
  });

  it("reads a large file in pieces, up to the limit", () => {
    const file = path.join(tempDir(), "records.jsonl");
    const line = `${JSON.stringify({ job_id: "76be9f71", started_at: 1791650167.56, status: "success" })}\n`;
    writeFileSync(file, line.repeat(5_000));
    const read = readSmallFile(file, 4 * 1024 * 1024);
    expect(read.ok && read.text.length).toBe(line.length * 5_000);
    expect(readSmallFile(file, 100_000)).toEqual({ ok: false, why: "too-large" });
  });

  it("says a missing file is missing", () => {
    const dir = tempDir();
    expect(readSmallFile(path.join(dir, "nope.json"), 10)).toEqual({ ok: false, why: "missing" });
    expect(readSmallFile(path.join(dir, "no-folder", "nope.json"), 10)).toEqual({ ok: false, why: "missing" });
    expect(readSmallText(path.join(dir, "nope.json"), 10)).toBeNull();
  });

  it("refuses a symbolic link, a folder and a named pipe", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "real.txt"), "real");
    symlinkSync(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    mkdirSync(path.join(dir, "folder"));
    mkfifo(path.join(dir, "pipe"));
    for (const name of ["link.txt", "folder", "pipe"]) expect(readSmallFile(path.join(dir, name), 100), name).toEqual({ ok: false, why: "not-a-file" });
    // A link that points at nothing is still a link, not a missing file.
    symlinkSync(path.join(dir, "gone"), path.join(dir, "dangling"));
    expect(readSmallFile(path.join(dir, "dangling"), 100)).toEqual({ ok: false, why: "not-a-file" });
  });

  it("never waits on a named pipe, even one with a writer that never writes", async () => {
    const pipe = path.join(tempDir(), "pipe");
    mkfifo(pipe);
    // Something holding the other end open and saying nothing: a plain read would wait for ever.
    const holder = spawn("/bin/sh", ["-c", `exec 3<>"${pipe}"; sleep 30`], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      for (let i = 0; i < 50; i += 1) expect(readSmallFile(pipe, 100)).toEqual({ ok: false, why: "not-a-file" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("never waits when the file is swapped for a pipe between two reads", async () => {
    // The swap the review found: a process an agent left running flips the name between a file
    // and a pipe. Whatever each read sees, it answers at once.
    const dir = tempDir();
    const file = path.join(dir, BUILD_STATUS_FILE);
    const swapper = spawn(
      "/usr/bin/perl",
      ["-e", 'my ($d) = @ARGV; system("/usr/bin/mkfifo", "$d/p"); open(my $f, ">", "$d/f"); print $f "{}"; close($f); while (1) { rename("$d/f", "$d/BUILD_STATUS.json"); rename("$d/BUILD_STATUS.json", "$d/f"); rename("$d/p", "$d/BUILD_STATUS.json"); rename("$d/BUILD_STATUS.json", "$d/p"); }', dir],
      { stdio: "ignore" },
    );
    try {
      const started = Date.now();
      const seen = new Set<string>();
      while (Date.now() - started < 1_500) {
        const read = readSmallFile(file, 1024);
        seen.add(read.ok ? "file" : read.why);
      }
      // It got through thousands of reads without sticking; what it saw depends on timing.
      for (const kind of seen) expect(["file", "missing", "not-a-file"]).toContain(kind);
    } finally {
      await ended(swapper);
    }
  });

  it("refuses a link, a pipe or a folder that takes the file's place between the look and the open", () => {
    const dir = tempDir();
    const elsewhere = path.join(tempDir(), "elsewhere.txt");
    writeFileSync(elsewhere, "FROM-SOMEWHERE-ELSE");
    const swapFor = (make: (file: string) => void) => {
      const file = path.join(dir, `status-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(file, "{}");
      const started = Date.now();
      // The first look sees a plain file. Then it is gone, and something else has its name.
      const read = readSmallFile(file, 1024, () => {
        spawnSync("/bin/rm", [file]);
        make(file);
      });
      // (If the open waited on the pipe, this test would never get here.)
      expect(Date.now() - started).toBeLessThan(2_000);
      return read;
    };
    // A link to a perfectly readable file: not followed.
    expect(swapFor((file) => symlinkSync(elsewhere, file))).toEqual({ ok: false, why: "not-a-file" });
    // A named pipe with nobody writing: not waited on.
    expect(swapFor((file) => mkfifo(file))).toEqual({ ok: false, why: "not-a-file" });
    expect(swapFor((file) => mkdirSync(file))).toEqual({ ok: false, why: "not-a-file" });
    expect(swapFor(() => {})).toEqual({ ok: false, why: "missing" });
    // Swapped for another plain file: that one is read, with its own size and time.
    expect(swapFor((file) => writeFileSync(file, '{"status":"built"}'))).toMatchObject({ ok: true, text: '{"status":"built"}', size: 18 });
  });

  it("never follows a link, even when the file is swapped for one between the look and the open", async () => {
    // The same swap with a link instead of a pipe: the name flips between a plain file and a
    // link to a file somewhere else. Whatever each read sees, it never returns the other file.
    const dir = tempDir();
    const file = path.join(dir, BUILD_STATUS_FILE);
    const elsewhere = path.join(tempDir(), "elsewhere.txt");
    writeFileSync(elsewhere, "FROM-SOMEWHERE-ELSE");
    const swapper = spawn(
      "/usr/bin/perl",
      ["-e", 'my ($d, $t) = @ARGV; symlink($t, "$d/l"); open(my $f, ">", "$d/f"); print $f "{}"; close($f); while (1) { rename("$d/f", "$d/BUILD_STATUS.json"); rename("$d/BUILD_STATUS.json", "$d/f"); rename("$d/l", "$d/BUILD_STATUS.json"); rename("$d/BUILD_STATUS.json", "$d/l"); }', dir, elsewhere],
      { stdio: "ignore" },
    );
    try {
      const started = Date.now();
      let reads = 0;
      let plain = 0;
      while (Date.now() - started < 1_500) {
        const read = readSmallFile(file, 1024);
        reads += 1;
        if (read.ok) {
          expect(read.text).toBe("{}");
          plain += 1;
        } else expect(["missing", "not-a-file"]).toContain(read.why);
      }
      expect(reads).toBeGreaterThan(100);
      expect(plain).toBeGreaterThan(0);
    } finally {
      await ended(swapper);
    }
  });

  it("notices a file that grows past the limit after it was looked at", () => {
    const file = path.join(tempDir(), "grows.txt");
    writeFileSync(file, "x".repeat(90));
    expect(readSmallFile(file, 100).ok).toBe(true);
    appendFileSync(file, "y".repeat(20));
    expect(statSync(file).size).toBe(110);
    expect(readSmallFile(file, 100)).toEqual({ ok: false, why: "too-large" });
  });
});

describe("everything an agent can write is read that way", () => {
  it("BUILD_STATUS.json as a named pipe is unreadable, at once", () => {
    const workspace = tempDir();
    leaveBuild(workspace);
    spawnSync("/bin/rm", [path.join(workspace, BUILD_STATUS_FILE)]);
    mkfifo(path.join(workspace, BUILD_STATUS_FILE));
    const started = Date.now();
    expect(checkBuildResult(workspace, 0)).toEqual({ ok: false, reason: "BUILD_STATUS.json could not be read", neverStarted: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("Kiro Crew's settings file as a named pipe is unreadable, at once", () => {
    const crewHome = tempDir();
    mkfifo(path.join(crewHome, "config.json"));
    const started = Date.now();
    for (const mode of ["crew", "overnight"] as const) expect(crewSettingsProblem(crewHome, mode)).toContain("settings could not be read");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("Kiro Crew's settings file as a link is not followed", () => {
    const crewHome = tempDir();
    const elsewhere = path.join(tempDir(), "config.json");
    writeFileSync(elsewhere, JSON.stringify({ agent: { sandbox: "strict" } }));
    symlinkSync(elsewhere, path.join(crewHome, "config.json"));
    expect(crewSettingsProblem(crewHome, "crew")).toContain("settings could not be read");
  });

  it("the probe's result files as pipes or links fail the check, at once", () => {
    const dir = tempDir();
    const results = {
      "keychain.txt": "0\n",
      "bee.txt": "0\n",
      "database.txt": "",
      "list-documents.txt": "0\n",
      "list-library.txt": "0\n",
      "list-claude.txt": "0\n",
      "processes.txt": "0\n",
      "finished.txt": "1\n",
      "write-home.txt": "0\n",
      "write-repo.txt": "0\n",
      "write-node.txt": "0\n",
      "write-kirocrew.txt": "0\n",
      "write-launch-agents.txt": "0\n",
      "list-built.txt": "0\n",
      "write-built.txt": "0\n",
    };
    for (const [name, text] of Object.entries(results)) writeFileSync(path.join(dir, name), text);
    expect(judgeProbe(dir)).toEqual({ ok: true });

    spawnSync("/bin/rm", [path.join(dir, "keychain.txt")]);
    mkfifo(path.join(dir, "keychain.txt"));
    const started = Date.now();
    expect(judgeProbe(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("its results could not be read") });
    expect(Date.now() - started).toBeLessThan(1_000);

    spawnSync("/bin/rm", [path.join(dir, "keychain.txt")]);
    const zero = path.join(tempDir(), "zero.txt");
    writeFileSync(zero, "0\n");
    symlinkSync(zero, path.join(dir, "keychain.txt"));
    expect(judgeProbe(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("its results could not be read") });

    // The same for the newer result files: a link in place of a count is not a count.
    spawnSync("/bin/rm", [path.join(dir, "keychain.txt")]);
    writeFileSync(path.join(dir, "keychain.txt"), "0\n");
    expect(judgeProbe(dir)).toEqual({ ok: true });
    for (const name of ["list-documents.txt", "processes.txt", "list-built.txt", "write-built.txt"]) {
      spawnSync("/bin/rm", [path.join(dir, name)]);
      symlinkSync(zero, path.join(dir, name));
      expect(judgeProbe(dir), name).toMatchObject({ ok: false, reason: expect.stringContaining("its results could not be read") });
      spawnSync("/bin/rm", [path.join(dir, name)]);
      writeFileSync(path.join(dir, name), "0\n");
    }
    expect(judgeProbe(dir)).toEqual({ ok: true });
  });
});
