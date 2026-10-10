// Where the real `bee` program lives.
//
// The Bee library runs a program called `bee` and, left alone, looks it up on PATH. Background
// jobs (launchd) have no PATH, and the `node_modules/.bin/bee` launcher is a Node script that
// needs `node` on PATH too. So we hand the library the full path of the platform binary that
// ships inside the @beeai/cli package.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BeeError } from "@overnight/core";

// Node's names for the operating system and processor, and the names Bee's folders use.
const PLATFORMS = new Map([
  ["darwin", "mac"],
  ["linux", "linux"],
  ["win32", "windows"],
]);
const ARCHS = new Map([
  ["arm64", "arm64"],
  ["x64", "x64"],
]);

/** The binary's path inside the @beeai/cli package, for example "dist/platforms/mac-arm64/bee". */
export function beeBinaryInPackage(platform: string, arch: string): string {
  const os = PLATFORMS.get(platform);
  const cpu = ARCHS.get(arch);
  if (os === undefined || cpu === undefined) {
    throw new BeeError("failed", `The Bee program is not available for this computer (${platform} ${arch}).`);
  }
  return path.join("dist", "platforms", `${os}-${cpu}`, os === "windows" ? "bee.exe" : "bee");
}

/** The nearest node_modules/@beeai/cli at or above `fromDir`, the way Node itself would find it. */
export function findBeePackage(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", "@beeai", "cli");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The absolute path of the `bee` program for this computer. Found from this file's own location,
 * never from PATH. Throws a BeeError that says what is missing if it is not installed.
 */
export function defaultBeeBinary(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = findBeePackage(here);
  if (packageDir === null) {
    throw new BeeError("failed", "The @beeai/cli package is not installed. Run `npm install` in the Overnight folder.");
  }
  const binary = path.join(packageDir, beeBinaryInPackage(process.platform, process.arch));
  if (!existsSync(binary)) {
    throw new BeeError("failed", `The Bee program is missing at ${binary}. Run \`npm install\` in the Overnight folder.`);
  }
  return binary;
}
