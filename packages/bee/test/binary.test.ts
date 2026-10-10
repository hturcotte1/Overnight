// Synthetic test data. Nothing in this file is Bee data, and nothing here runs the bee program.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BeeError } from "@overnight/core";
import { beeBinaryInPackage, defaultBeeBinary } from "../src/index.ts";
import { findBeePackage } from "../src/binary.ts";

describe("where the bee program lives", () => {
  it("knows the folder for each computer Bee ships a program for", () => {
    expect(beeBinaryInPackage("darwin", "arm64")).toBe(path.join("dist", "platforms", "mac-arm64", "bee"));
    expect(beeBinaryInPackage("darwin", "x64")).toBe(path.join("dist", "platforms", "mac-x64", "bee"));
    expect(beeBinaryInPackage("linux", "x64")).toBe(path.join("dist", "platforms", "linux-x64", "bee"));
    expect(beeBinaryInPackage("win32", "x64")).toBe(path.join("dist", "platforms", "windows-x64", "bee.exe"));
  });

  it("says clearly when this kind of computer is not supported", () => {
    for (const [platform, arch] of [["freebsd", "x64"], ["darwin", "ppc64"], ["constructor", "arm64"]] as const) {
      expect(() => beeBinaryInPackage(platform, arch)).toThrow(BeeError);
      expect(() => beeBinaryInPackage(platform, arch)).toThrow(/not available for this computer/);
    }
  });

  it("finds the installed program by its full path, without using PATH", () => {
    const binary = defaultBeeBinary();
    expect(path.isAbsolute(binary)).toBe(true);
    expect(existsSync(binary)).toBe(true);
    expect(binary).toContain(path.join("node_modules", "@beeai", "cli", "dist", "platforms"));
    expect(binary).not.toContain(path.join("node_modules", ".bin"));
  });

  it("looks upward for node_modules/@beeai/cli and stops at the top", () => {
    const root = mkdtempSync(path.join(tmpdir(), "overnight-bee-test-"));
    try {
      const deep = path.join(root, "packages", "bee", "src");
      const cli = path.join(root, "node_modules", "@beeai", "cli");
      mkdirSync(deep, { recursive: true });
      expect(findBeePackage(deep)).not.toBe(cli);
      mkdirSync(cli, { recursive: true });
      writeFileSync(path.join(cli, "package.json"), "{}");
      expect(findBeePackage(deep)).toBe(cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
