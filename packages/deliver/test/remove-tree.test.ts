// Synthetic test data: every file and folder in this test is made up.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discardTree, GONE_PREFIX, makeRemovable, moveAside, removeTree, sweepGone } from "../src/remove-tree.ts";
import { tempDir, writeTree } from "./helpers.ts";

/** Folders a test locked, unlocked again afterwards so the temp folder can always be cleaned up. */
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already deleted: the point of the test.
    }
  }
});

/** What a build that locks its own folders leaves behind: a folder that cannot even be listed, with files in it. */
function lockedTree(root: string): string {
  const inner = path.join(root, "app", "node_modules", "locked");
  writeTree(root, { "app/package.json": "{}\n", "app/node_modules/locked/deep/file.txt": "x\n", "scratch/tmp/t.txt": "x\n" });
  chmodSync(path.join(inner, "deep"), 0o000);
  chmodSync(inner, 0o000);
  locked.push(inner, path.join(inner, "deep"));
  return inner;
}

describe("removeTree", () => {
  it("deletes an ordinary tree and says so; a tree that is not there counts as gone", () => {
    const root = path.join(tempDir(), "run");
    writeTree(root, { "a/b/c.txt": "x\n" });
    expect(removeTree(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(removeTree(root)).toBe(true);
  });

  it("deletes a tree with folders that were made unlistable, without ever throwing", () => {
    const root = path.join(tempDir(), "run");
    lockedTree(root);
    expect(removeTree(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("never follows a link out of the tree: what the link points at is left alone, permissions included", () => {
    const base = tempDir();
    const outside = path.join(base, "outside");
    writeTree(outside, { "private/keep.txt": "made-up private text\n" });
    chmodSync(path.join(outside, "private"), 0o500);
    locked.push(path.join(outside, "private"));
    const root = path.join(base, "run");
    lockedTree(root);
    symlinkSync(path.join(outside, "private"), path.join(root, "scratch", "link-to-private"));
    symlinkSync(outside, path.join(root, "link-to-outside"));

    makeRemovable(root);
    expect(removeTree(root)).toBe(true);

    expect(readFileSync(path.join(outside, "private", "keep.txt"), "utf8")).toBe("made-up private text\n");
    expect(statSync(path.join(outside, "private")).mode & 0o777).toBe(0o500);
  });
});

describe("moveAside and discardTree", () => {
  it("moveAside renames a folder to a fresh .gone- name next to it, and answers null when there is nothing to move", () => {
    const base = tempDir();
    const box = path.join(base, "build");
    writeTree(box, { "app/x.txt": "x\n" });
    const moved = moveAside(box);
    expect(moved).not.toBeNull();
    expect(path.dirname(moved ?? "")).toBe(base);
    expect(path.basename(moved ?? "")).toMatch(/^\.gone-build-[a-z0-9]+-[0-9a-f]{8}$/);
    expect(existsSync(box)).toBe(false);
    expect(readFileSync(path.join(moved ?? "", "app/x.txt"), "utf8")).toBe("x\n");
    expect(moveAside(box)).toBeNull();
    // A second folder of the same name gets a different new name.
    mkdirSync(box);
    expect(moveAside(box)).not.toBe(moved);
  });

  it("discardTree leaves nothing behind, also for a locked tree", () => {
    const base = tempDir();
    const root = path.join(base, "idea_1");
    lockedTree(root);
    expect(discardTree(root)).toBe(true);
    expect(readdirSync(base)).toEqual([]);
    expect(discardTree(root)).toBe(true);
  });

  it("sweepGone deletes what earlier clean-ups left, and only that", () => {
    const base = tempDir();
    writeTree(base, { [`${GONE_PREFIX}idea_1-abc-12345678/x.txt`]: "x\n", "idea_2/run-1/logs/a.log": "x\n" });
    writeFileSync(path.join(base, `${GONE_PREFIX}stray-file`), "x\n");
    sweepGone(base);
    expect(readdirSync(base)).toEqual(["idea_2"]);
    sweepGone(path.join(base, "no-such-folder"));
  });
});
