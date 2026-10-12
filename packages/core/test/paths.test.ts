// Every folder here is made up, under the system's temporary folder.
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, ensureDataDirs, finishedBuildDir } from "../src/index.ts";
import type { DataPaths } from "../src/index.ts";

let root: string;
let paths: DataPaths;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "overnight-paths-"));
  paths = dataPaths(path.join(root, "data"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the folder of finished builds", () => {
  it("is built/ in the data folder, made private with the others", () => {
    expect(paths.built).toBe(path.join(root, "data", "built"));
    ensureDataDirs(paths);
    expect(statSync(paths.built).isDirectory()).toBe(true);
    expect(statSync(paths.built).mode & 0o777).toBe(0o700);
  });
});

describe("where an idea's finished build is", () => {
  const id = "idea_20261012_ab12cd34";

  it("is the workspace until the build has been moved", () => {
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.workspaces, id));
    ensureDataDirs(paths);
    mkdirSync(path.join(paths.workspaces, id));
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.workspaces, id));
  });

  it("is built/<id> once that folder is there, even if a workspace is there too", () => {
    ensureDataDirs(paths);
    mkdirSync(path.join(paths.built, id));
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.built, id));
    mkdirSync(path.join(paths.workspaces, id));
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.built, id));
  });

  it("does not count a link in built/, or a file", () => {
    ensureDataDirs(paths);
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(paths.built, id));
    expect(finishedBuildDir(paths, id)).toBe(path.join(paths.workspaces, id));
    writeFileSync(path.join(paths.built, "idea_file"), "made up");
    expect(finishedBuildDir(paths, "idea_file")).toBe(path.join(paths.workspaces, "idea_file"));
  });

  it("only needs the two folders it looks in", () => {
    expect(finishedBuildDir({ built: paths.built, workspaces: paths.workspaces }, id)).toBe(path.join(paths.workspaces, id));
  });

  it("refuses an id that would lead out of the folder", () => {
    ensureDataDirs(paths);
    mkdirSync(path.join(root, "data", "ideas", "x"), { recursive: true });
    for (const bad of ["", ".", "..", "../ideas", "../ideas/x", "a/b", "/etc", "a\\b", "a\0b"]) {
      expect(() => finishedBuildDir(paths, bad), JSON.stringify(bad)).toThrow("cannot be used as a folder name");
    }
    // An older build that was moved aside has a dot in its name, and is still one plain name.
    expect(finishedBuildDir(paths, `${id}.old-20261012T070000Z`)).toBe(path.join(paths.workspaces, `${id}.old-20261012T070000Z`));
  });
});
