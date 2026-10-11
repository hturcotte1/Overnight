// Synthetic test data: every file in this test is made up.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyPlainTree, DIST_REFUSE_NAMES } from "../src/index.ts";
import { tempDir, writeTree } from "./helpers.ts";

const ROOMY = { maxFiles: 2_000, maxBytes: 50 * 1024 * 1024 };

function workspace(files: Record<string, string>): { source: string; target: string; outside: string } {
  const root = tempDir();
  const source = path.join(root, "workspace");
  writeTree(source, files);
  return { source, target: path.join(root, "copy"), outside: root };
}

describe("copyPlainTree", () => {
  it("copies plain files and folders, byte for byte", () => {
    const { source, target } = workspace({ "package.json": '{ "name": "made-up" }\n', "src/main.ts": "export {};\n", "src/deep/er/style.css": "body { margin: 0 }\n" });
    const result = copyPlainTree(source, target, "The app's folder", ROOMY);
    expect(result).toEqual({ ok: true, files: 3, bytes: 22 + 11 + 19 });
    expect(readFileSync(path.join(target, "src/deep/er/style.css"), "utf8")).toBe("body { margin: 0 }\n");
    expect(readdirSync(target).sort()).toEqual(["package.json", "src"]);
  });

  it("leaves out node_modules, dist, .git and test-results wherever they are", () => {
    const { source, target } = workspace({
      "package.json": "{}\n",
      "node_modules/vite/index.js": "x\n",
      "dist/index.html": "<h1>old build</h1>\n",
      ".git/config": "[core]\n",
      "test-results/.last-run.json": "{}\n",
      "src/node_modules/inner.js": "x\n",
      "src/app.ts": "export {};\n",
    });
    // A link inside a skipped folder is never looked at (node_modules/.bin is full of them).
    mkdirSync(path.join(source, "node_modules/.bin"), { recursive: true });
    symlinkSync("../vite/index.js", path.join(source, "node_modules/.bin/vite"));

    const result = copyPlainTree(source, target, "The app's folder", { ...ROOMY, skipNames: ["node_modules", "dist", ".git", "test-results"] });

    expect(result).toMatchObject({ ok: true, files: 2 });
    expect(readdirSync(target).sort()).toEqual(["package.json", "src"]);
    expect(readdirSync(path.join(target, "src"))).toEqual(["app.ts"]);
  });

  it("refuses a symbolic link to a file, and copies nothing it points at", () => {
    const { source, target, outside } = workspace({ "index.html": "<h1>hi</h1>\n" });
    writeFileSync(path.join(outside, "private.txt"), "made-up private text\n");
    symlinkSync(path.join(outside, "private.txt"), path.join(source, "leak.txt"));

    const result = copyPlainTree(source, target, "The built app (dist)", ROOMY);

    expect(result).toMatchObject({ ok: false, problem: "link", reason: "The built app (dist) contains a symbolic link, which is not allowed." });
    expect(existsSync(path.join(target, "leak.txt"))).toBe(false);
  });

  it("refuses a symbolic link to a folder, and a link that points nowhere", () => {
    const first = workspace({ "index.html": "x\n" });
    mkdirSync(path.join(first.outside, "elsewhere"));
    symlinkSync(path.join(first.outside, "elsewhere"), path.join(first.source, "assets"));
    expect(copyPlainTree(first.source, first.target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "link" });

    const second = workspace({ "index.html": "x\n" });
    symlinkSync("/no/such/place", path.join(second.source, "dangling"));
    expect(copyPlainTree(second.source, second.target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "link" });
  });

  it("refuses a link nested deep inside the tree", () => {
    const { source, target } = workspace({ "a/b/c/file.txt": "x\n" });
    symlinkSync("/etc/hosts", path.join(source, "a/b/c/hosts"));
    expect(copyPlainTree(source, target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "link" });
  });

  it("refuses when the folder itself is a symbolic link", () => {
    const { source, outside } = workspace({ "index.html": "x\n" });
    const link = path.join(outside, "link-to-workspace");
    symlinkSync(source, link);
    expect(copyPlainTree(link, path.join(outside, "copy"), "The app's folder", ROOMY)).toMatchObject({ ok: false, problem: "link", reason: "The app's folder is a symbolic link, which is not allowed." });
  });

  it("refuses a hard link", () => {
    const { source, target, outside } = workspace({ "index.html": "x\n" });
    writeFileSync(path.join(outside, "private.txt"), "made-up private text\n");
    linkSync(path.join(outside, "private.txt"), path.join(source, "copy-of-private.txt"));
    expect(copyPlainTree(source, target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "hard-link" });
  });

  it("refuses anything that is not a plain file or folder", () => {
    const { source, target } = workspace({ "index.html": "x\n" });
    execFileSync("/usr/bin/mkfifo", [path.join(source, "pipe")]);
    expect(copyPlainTree(source, target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "special", reason: "dist contains something that is not a plain file or folder." });
  });

  it("stops at the file cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) files[`f${i}.txt`] = "x\n";
    const { source, target } = workspace(files);
    expect(copyPlainTree(source, target, "The app's folder", { maxFiles: 5, maxBytes: 1_000 })).toMatchObject({ ok: false, problem: "too-many-files", reason: "The app's folder has more than 5 files." });
    const exact = workspace(files);
    expect(copyPlainTree(exact.source, exact.target, "The app's folder", { maxFiles: 6, maxBytes: 1_000 })).toMatchObject({ ok: true, files: 6 });
  });

  it("stops at the size cap, counted over all files", () => {
    const { source, target } = workspace({ "a.bin": "a".repeat(600_000), "b.bin": "b".repeat(600_000) });
    expect(copyPlainTree(source, target, "The built app (dist)", { maxFiles: 10, maxBytes: 1024 * 1024 })).toMatchObject({ ok: false, problem: "too-big", reason: "The built app (dist) is larger than 1 MB." });
    const roomy = workspace({ "a.bin": "a".repeat(600_000), "b.bin": "b".repeat(400_000) });
    expect(copyPlainTree(roomy.source, roomy.target, "dist", { maxFiles: 10, maxBytes: 1024 * 1024 })).toEqual({ ok: true, files: 2, bytes: 1_000_000 });
  });

  it("files left out do not count toward the caps", () => {
    const files: Record<string, string> = { "package.json": "{}\n" };
    for (let i = 0; i < 20; i += 1) files[`node_modules/pkg/f${i}.js`] = "x".repeat(1000);
    const { source, target } = workspace(files);
    expect(copyPlainTree(source, target, "The app's folder", { maxFiles: 3, maxBytes: 100, skipNames: ["node_modules"] })).toEqual({ ok: true, files: 1, bytes: 3 });
  });

  it("refuses names on the refuse list, such as a .git folder inside dist", () => {
    const { source, target } = workspace({ "index.html": "x\n", "assets/.git/config": "[core]\n" });
    expect(copyPlainTree(source, target, "The built app (dist)", { ...ROOMY, refuseNames: [".git"] })).toMatchObject({ ok: false, problem: "refused-name" });
  });

  it("treats upper and lower case as the same name, as this Mac's disk does, and spells the name its own way in the reason", () => {
    for (const [file, refused] of [
      [".GIT/config", ".git"],
      [".Git/HEAD", ".git"],
      ["assets/.GitIgnore", ".gitignore"],
      [".GITATTRIBUTES", ".gitattributes"],
      ["deep/er/.gitmodules", ".gitmodules"],
    ] as const) {
      const { source, target } = workspace({ "index.html": "x\n", [file]: "made-up\n" });
      const result = copyPlainTree(source, target, "The built app (dist)", { ...ROOMY, refuseNames: DIST_REFUSE_NAMES });
      expect(result, file).toMatchObject({ ok: false, problem: "refused-name", reason: `The built app (dist) contains an entry named "${refused}", which is not allowed.` });
    }
    const skipped = workspace({ "package.json": "{}\n", "Node_Modules/x/index.js": "x\n", "DIST/index.html": "old\n" });
    expect(copyPlainTree(skipped.source, skipped.target, "The app's folder", { ...ROOMY, skipNames: ["node_modules", "dist"] })).toEqual({ ok: true, files: 1, bytes: 3 });
  });

  it("refuses every name that changes what git does with a published folder", () => {
    expect([...DIST_REFUSE_NAMES].sort()).toEqual([".git", ".gitattributes", ".gitignore", ".gitmodules"]);
    for (const name of DIST_REFUSE_NAMES) {
      const { source, target } = workspace({ "index.html": "x\n", [name]: "overnight.json\n" });
      expect(copyPlainTree(source, target, "The built app (dist)", { ...ROOMY, refuseNames: DIST_REFUSE_NAMES }), name).toMatchObject({ ok: false, problem: "refused-name" });
    }
    // Names that only look similar are ordinary files.
    const fine = workspace({ "index.html": "x\n", "gitignore.txt": "x\n", "notes.gitignore.md": "x\n" });
    expect(copyPlainTree(fine.source, fine.target, "The built app (dist)", { ...ROOMY, refuseNames: DIST_REFUSE_NAMES })).toMatchObject({ ok: true, files: 3 });
  });

  it("never copies through a folder that is swapped for a link part-way: it gets the real file, or it stops", () => {
    // The trick: wait until the copy is inside a folder, then put a link to another folder in its place.
    const { source, target, outside } = workspace({ "a/1.txt": "one\n", "b/2.txt": "the real two\n", "b/3.txt": "the real three\n", "c/4.txt": "four\n" });
    writeTree(path.join(outside, "elsewhere"), { "2.txt": "DECOY: made-up private text\n", "3.txt": "DECOY: made-up private text\n" });
    let swapped = false;
    const result = copyPlainTree(source, target, "The app's folder", {
      ...ROOMY,
      onEntry: (entry) => {
        if (entry !== "b/2.txt" || swapped) return;
        swapped = true;
        renameSync(path.join(source, "b"), path.join(outside, "the-real-b"));
        symlinkSync(path.join(outside, "elsewhere"), path.join(source, "b"));
      },
    });
    expect(swapped).toBe(true);
    const copied = (name: string) => (existsSync(path.join(target, name)) ? readFileSync(path.join(target, name), "utf8") : null);
    // Whatever happened, nothing from the other folder was copied.
    for (const name of ["b/2.txt", "b/3.txt"]) expect(copied(name) ?? "").not.toContain("DECOY");
    if (process.platform === "darwin") {
      // Reached by its number, the folder it started on is the folder it finished: the swap changed nothing.
      expect(result).toEqual({ ok: true, files: 4, bytes: 4 + 13 + 15 + 5 });
      expect(copied("b/2.txt")).toBe("the real two\n");
      expect(copied("b/3.txt")).toBe("the real three\n");
    } else {
      expect(result).toMatchObject({ ok: false, problem: "changed" });
    }
  });

  it("stops when a file is swapped for a link while the copy is under way", () => {
    const { source, target, outside } = workspace({ "a.txt": "x\n", "b.txt": "real\n" });
    writeFileSync(path.join(outside, "private.txt"), "DECOY: made-up private text\n");
    const result = copyPlainTree(source, target, "dist", {
      ...ROOMY,
      onEntry: (entry) => {
        if (entry !== "a.txt") return;
        unlinkSync(path.join(source, "b.txt"));
        symlinkSync(path.join(outside, "private.txt"), path.join(source, "b.txt"));
      },
    });
    expect(result).toMatchObject({ ok: false, problem: "link" });
    expect(existsSync(path.join(target, "b.txt"))).toBe(false);
  });

  it("says so when the folder is missing or is a file", () => {
    const root = tempDir();
    expect(copyPlainTree(path.join(root, "nope"), path.join(root, "copy"), "The built app (dist)", ROOMY)).toMatchObject({ ok: false, problem: "missing", reason: "The built app (dist) does not exist." });
    writeFileSync(path.join(root, "a-file"), "x\n");
    expect(copyPlainTree(path.join(root, "a-file"), path.join(root, "copy2"), "dist", ROOMY)).toMatchObject({ ok: false, problem: "special" });
  });

  it("will not copy into a folder that already has something in it", () => {
    const { source, target } = workspace({ "index.html": "x\n" });
    writeTree(target, { "old.txt": "left over\n" });
    expect(copyPlainTree(source, target, "dist", ROOMY)).toMatchObject({ ok: false, problem: "target-not-empty" });
    expect(readdirSync(target)).toEqual(["old.txt"]);
  });

  it("keeps the 'may be run' permission only when asked, and never anything wider", () => {
    const { source, target, outside } = workspace({ "build.sh": "#!/bin/sh\n", "open.txt": "x\n" });
    chmodSync(path.join(source, "build.sh"), 0o777);
    chmodSync(path.join(source, "open.txt"), 0o666);

    copyPlainTree(source, target, "The app's folder", { ...ROOMY, keepExecutable: true });
    expect(statSync(path.join(target, "build.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(target, "open.txt")).mode & 0o777).toBe(0o644);

    const published = path.join(outside, "published");
    copyPlainTree(source, published, "dist", ROOMY);
    expect(statSync(path.join(published, "build.sh")).mode & 0o777).toBe(0o644);
  });
});
