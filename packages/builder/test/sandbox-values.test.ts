// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// The values a sandbox profile is started with: read out of the profile itself, the same way
// scripts/install-agents.sh reads them for the gateway's background job.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE } from "../src/index.ts";
import { profileParams, realPath, realPathAllowMissing, SANDBOX_VALUE_NAMES, sandboxDefines } from "../src/sandbox-values.ts";
import { tempDir } from "./helpers.ts";

describe("the names a profile asks for", () => {
  it("are every (param \"NAME\") in it, once each, in the order they first appear", () => {
    const text = '(version 1)\n(define home (param "HOME"))\n(define data (param "DATA_DIR"))\n(deny file-read* (subpath (param "HOME")) (subpath (param "REPO")))\n';
    expect(profileParams(text)).toEqual(["HOME", "DATA_DIR", "REPO"]);
  });

  it("are not looked for in comments", () => {
    const text = ';; A profile of ours may only ask for (param "TMPDIR") and friends\n(version 1)\n(define home (param "HOME")) ; not (param "WORKSPACE")\n';
    expect(profileParams(text)).toEqual(["HOME"]);
    expect(profileParams(";; nothing at all\n(version 1)\n(allow default)\n")).toEqual([]);
  });

  it("of the two shipped profiles are all names the installer and the builder can fill", () => {
    for (const file of [CREW_GATEWAY_SANDBOX_PROFILE, KIRO_CLI_SANDBOX_PROFILE]) {
      const names = profileParams(readFileSync(file, "utf8"));
      expect(names.length).toBeGreaterThan(3);
      for (const name of names) expect(SANDBOX_VALUE_NAMES, `${path.basename(file)}: ${name}`).toContain(name);
    }
    // Only a Kiro CLI build has one workspace of its own; the gateway serves every build.
    expect(profileParams(readFileSync(CREW_GATEWAY_SANDBOX_PROFILE, "utf8"))).not.toContain("WORKSPACE");
    expect(profileParams(readFileSync(KIRO_CLI_SANDBOX_PROFILE, "utf8"))).toContain("WORKSPACE");
  });
});

describe("the -D arguments for a profile", () => {
  const profile = (text: string): string => {
    const file = path.join(tempDir(), "made-up.sb");
    writeFileSync(file, text);
    return file;
  };

  it("are one pair for each name the profile asks for, in the profile's order, and nothing it does not ask for", () => {
    const file = profile('(version 1)\n(deny file-read* (subpath (param "DATA_DIR")) (subpath (param "HOME")))\n');
    expect(sandboxDefines(file, { HOME: "/Users/someone", DATA_DIR: "/Users/someone/.overnight", REPO: "/not/asked/for", TMPDIR: "/nor/this" })).toEqual(["-D", "DATA_DIR=/Users/someone/.overnight", "-D", "HOME=/Users/someone"]);
  });

  it("are refused as a whole when one value is missing, null or not a full path", () => {
    const file = profile('(version 1)\n(deny file-read* (subpath (param "HOME")) (subpath (param "NODE_DIR")))\n');
    expect(sandboxDefines(file, { HOME: "/Users/someone" })).toBeNull();
    expect(sandboxDefines(file, { HOME: "/Users/someone", NODE_DIR: null })).toBeNull();
    expect(sandboxDefines(file, { HOME: "/Users/someone", NODE_DIR: "relative/node" })).toBeNull();
    expect(sandboxDefines(file, { HOME: "/Users/someone", NODE_DIR: "/opt/node" })).toEqual(["-D", "HOME=/Users/someone", "-D", "NODE_DIR=/opt/node"]);
  });

  it("are refused for a name nobody here can fill, a profile that asks for nothing, and a profile that is not there", () => {
    expect(sandboxDefines(profile('(version 1)\n(deny file-read* (subpath (param "SOMETHING_ELSE")))\n'), { HOME: "/Users/someone" })).toBeNull();
    // A profile with no values names nothing to protect: it cannot be one of ours.
    expect(sandboxDefines(profile("(version 1)\n(allow default)\n"), { HOME: "/Users/someone" })).toBeNull();
    expect(sandboxDefines(path.join(tempDir(), "missing.sb"), { HOME: "/Users/someone" })).toBeNull();
  });
});

describe("real paths", () => {
  it("follow every link, and are null for something that is not there", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "real", "inner"), { recursive: true });
    symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    expect(realPath(path.join(dir, "link", "inner"))).toBe(path.join(dir, "real", "inner"));
    expect(realPath(path.join(dir, "nothing"))).toBeNull();
  });

  it("can be worked out for a folder that does not exist yet, from the nearest folder that does", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "real"));
    symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    // A fresh Mac has no npm cache: the name is kept, and the links before it are followed.
    expect(realPathAllowMissing(path.join(dir, "link", ".npm"))).toBe(path.join(dir, "real", ".npm"));
    expect(realPathAllowMissing(path.join(dir, "link", "a", "b"))).toBe(path.join(dir, "real", "a", "b"));
    expect(realPathAllowMissing(path.join(dir, "link"))).toBe(path.join(dir, "real"));
    expect(realPathAllowMissing(`${path.join(dir, "real")}/`)).toBe(path.join(dir, "real"));
  });

  it("are refused for a path that is not full, and for one that ends in a link to nowhere", () => {
    const dir = tempDir();
    symlinkSync(path.join(dir, "gone"), path.join(dir, "dangling"));
    expect(realPathAllowMissing("relative/path")).toBeNull();
    // A link left in the answer would make every rule written with it match nothing.
    expect(realPathAllowMissing(path.join(dir, "dangling"))).toBeNull();
    expect(realPathAllowMissing(path.join(dir, "dangling", "below"))).toBeNull();
  });
});
