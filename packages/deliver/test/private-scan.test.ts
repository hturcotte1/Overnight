// Synthetic test data: the computer name, account name, paths and files in this file are made up.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localPrivateStrings, scanForPrivateStrings, usablePrivateStrings } from "../src/private-scan.ts";
import { tempDir, writeTree } from "./helpers.ts";

const NEEDLES = ["Zebras-MacBook-Pro.local", "Zebras-MacBook-Pro", "/Users/zebra", "/zebra/"];

describe("scanForPrivateStrings", () => {
  it("finds nothing in an ordinary built app", () => {
    const dir = tempDir();
    writeTree(dir, { "index.html": "<h1>Tip splitter</h1>\n", "assets/app-Ab12.js": "console.log('a zebra walks into /Users/shared')\n", "assets/logo.png": "\u0089PNG made-up" });
    expect(scanForPrivateStrings(dir, NEEDLES)).toEqual({ filesWithHits: 0, filesScanned: 3 });
  });

  it("finds the computer's name, the home folder's path and the account name in a path, wherever they are", () => {
    const dir = tempDir();
    writeTree(dir, {
      "index.html": "<h1>fine</h1>\n",
      "assets/app.js": 'const banner = "built on Zebras-MacBook-Pro";\n',
      "assets/app.js.map": '{"sources":["/Users/zebra/.overnight/tmp/deliver/idea_1/run-1/build/app/src/main.ts"]}\n',
      "deep/er/data.bin": Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("file:///Volumes/x/zebra/y"), Buffer.from([0])]).toString("latin1"),
      "clean.css": "body{}\n",
    });
    // (data.bin is written as text here, so its bytes differ, but the made-up path in it survives.)
    expect(scanForPrivateStrings(dir, NEEDLES)).toEqual({ filesWithHits: 3, filesScanned: 5 });
  });

  it("also looks at file and folder names", () => {
    const dir = tempDir();
    writeTree(dir, { "index.html": "x\n", "Zebras-MacBook-Pro/readme.txt": "x\n", "assets/report-Zebras-MacBook-Pro.txt": "x\n" });
    expect(scanForPrivateStrings(dir, NEEDLES).filesWithHits).toBe(2);
  });

  it("is exact about upper and lower case, and never follows a link", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(path.join(outside, "private.txt"), "Zebras-MacBook-Pro\n");
    writeTree(dir, { "index.html": "zebras-macbook-pro and /users/zebra\n" });
    symlinkSync(path.join(outside, "private.txt"), path.join(dir, "link.txt"));
    expect(scanForPrivateStrings(dir, NEEDLES)).toEqual({ filesWithHits: 0, filesScanned: 1 });
  });

  it("throws when the folder cannot be read, so that a failed scan is never taken for a clean one", () => {
    expect(() => scanForPrivateStrings(path.join(tempDir(), "missing"), NEEDLES)).toThrow();
  });

  it("with nothing to look for, finds nothing", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "assets"));
    writeTree(dir, { "index.html": "anything\n" });
    expect(scanForPrivateStrings(dir, [])).toEqual({ filesWithHits: 0, filesScanned: 1 });
  });
});

describe("usablePrivateStrings", () => {
  it("drops blanks, repeats, anything too short to be told from an ordinary word, and factory names", () => {
    expect(usablePrivateStrings(["Zebras-MacBook-Pro.local", "Zebras-MacBook-Pro", "Zebras-MacBook-Pro", "", null, undefined, "  ", "abc", "/z/", "/Users/zebra"])).toEqual([
      "Zebras-MacBook-Pro.local",
      "Zebras-MacBook-Pro",
      "/Users/zebra",
    ]);
    // A Mac that still has its factory name names nobody, and an app may well mention one.
    expect(usablePrivateStrings(["MacBook-Pro", "MacBook Pro", "macbook-pro.local", "Mac-mini", "iMac", "MacBook-Air-2.local", "localhost", "Mac-Studio.lan"])).toEqual([]);
    expect(usablePrivateStrings(["Zebras-iMac", "MacBook-Pro-von-Zebra"])).toEqual(["Zebras-iMac", "MacBook-Pro-von-Zebra"]);
  });
});

describe("localPrivateStrings", () => {
  it("answers with strings long enough to search for, among them the home folder's path, and never throws", async () => {
    const strings = await localPrivateStrings();
    expect(Array.isArray(strings)).toBe(true);
    for (const value of strings) expect(value.length).toBeGreaterThanOrEqual(4);
    // The values themselves name this Mac and its owner, so the test only looks at their shape.
    expect(strings.some((value) => value.startsWith("/") && !value.endsWith("/"))).toBe(true);
    expect(await localPrivateStrings()).toBe(strings);
  });
});
