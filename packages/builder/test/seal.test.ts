// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// Moving a finished build out of the build jobs' reach, on temp folders.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { finishedBuildDir } from "@overnight/core";
import type { DataPaths } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, retireSealed, sealedDir, sealWorkspace } from "../src/index.ts";
import { leaveBuild, tempDir, testPaths } from "./helpers.ts";

const ID = "idea_20261010_ab12cd34";
const NOW = new Date("2026-10-10T07:40:00.000Z");
const LATER = new Date("2026-10-11T07:12:30.000Z");
const mode = (file: string) => statSync(file).mode & 0o777;

/** A workspace with a finished build in it, as the night flow leaves one. `mark` tells two builds apart. */
function builtWorkspace(paths: DataPaths, mark = "first build", id = ID): string {
  const prepared = prepareWorkspace({ paths, ideaId: id, brief: "# made-up brief\n", now: NOW });
  leaveBuild(prepared.workspace);
  writeFileSync(path.join(prepared.workspace, "dist", "index.html"), `<!doctype html><title>${mark}</title>`);
  return prepared.workspace;
}

describe("sealWorkspace: a finished build is moved out of the build jobs' reach", () => {
  it("moves the workspace to built/<id> in one piece, and nothing is left in workspaces/", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths);

    const sealed = sealWorkspace({ paths, ideaId: ID, now: NOW });
    expect(sealed).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null });
    expect(sealedDir(paths, ID)).toBe(path.join(paths.root, "built", ID));
    expect(existsSync(workspace)).toBe(false);
    expect(readdirSync(paths.workspaces)).toEqual([]);
    expect(readdirSync(path.join(paths.built, ID)).sort()).toEqual(["BUILD_STATUS.json", "brief.md", "dist"]);
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toContain("first build");
  });

  it("is where the morning then looks: core's finishedBuildDir", () => {
    const paths = testPaths();
    builtWorkspace(paths);
    // Not sealed yet (say, the process was killed between recording and moving): the workspace it is.
    expect(finishedBuildDir(paths, ID)).toBe(path.join(paths.workspaces, ID));
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    expect(finishedBuildDir(paths, ID)).toBe(sealedDir(paths, ID));
  });

  it("makes built/ when it is missing, private to the user, and makes an older one private again", () => {
    const paths = testPaths();
    builtWorkspace(paths);
    rmSync(paths.built, { recursive: true });
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    expect(mode(paths.built)).toBe(0o700);

    const open = testPaths();
    builtWorkspace(open);
    chmodSync(open.built, 0o755);
    expect(sealWorkspace({ paths: open, ideaId: ID, now: NOW }).ok).toBe(true);
    expect(mode(open.built)).toBe(0o700);
  });

  it("moves an older sealed build aside first, and never deletes it", () => {
    const paths = testPaths();
    builtWorkspace(paths, "first build");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);

    builtWorkspace(paths, "second build");
    const again = sealWorkspace({ paths, ideaId: ID, now: LATER });
    const old = path.join(paths.built, `${ID}.old-20261011T071230Z`);
    expect(again).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: old });
    expect(readdirSync(paths.built).sort()).toEqual([ID, `${ID}.old-20261011T071230Z`]);
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toContain("second build");
    expect(readFileSync(path.join(old, "dist", "index.html"), "utf8")).toContain("first build");
  });

  it("does not move an older set-aside build out of the way of a newer one made in the same second", () => {
    const paths = testPaths();
    for (const mark of ["one", "two", "three"]) {
      builtWorkspace(paths, mark);
      expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok, mark).toBe(true);
    }
    expect(readdirSync(paths.built).sort()).toEqual([ID, `${ID}.old-20261010T074000Z`, `${ID}.old-20261010T074000Z-2`]);
    expect(readFileSync(path.join(paths.built, `${ID}.old-20261010T074000Z`, "dist", "index.html"), "utf8")).toContain("one");
    expect(readFileSync(path.join(paths.built, `${ID}.old-20261010T074000Z-2`, "dist", "index.html"), "utf8")).toContain("two");
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toContain("three");
  });

  it("leaves other ideas' folders alone", () => {
    const paths = testPaths();
    builtWorkspace(paths, "this one");
    const other = builtWorkspace(paths, "the other one", "idea_20261010_ffff0000");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    expect(readdirSync(paths.workspaces)).toEqual(["idea_20261010_ffff0000"]);
    expect(readFileSync(path.join(other, "dist", "index.html"), "utf8")).toContain("the other one");
  });

  it("refuses a workspace that is a link, and moves nothing", () => {
    const paths = testPaths();
    // A Kiro Crew job can write anywhere below workspaces/: it can move a workspace away and
    // leave a link to somewhere else under its name.
    const elsewhere = tempDir();
    writeFileSync(path.join(elsewhere, "keep.txt"), "not ours to move: made up\n");
    mkdirSync(paths.workspaces, { recursive: true });
    symlinkSync(elsewhere, path.join(paths.workspaces, ID));

    const sealed = sealWorkspace({ paths, ideaId: ID, now: NOW });
    expect(sealed).toEqual({ ok: false, reason: "the workspace is not a plain folder (a link stands in its place?)" });
    expect(lstatSync(path.join(paths.workspaces, ID)).isSymbolicLink()).toBe(true);
    expect(readdirSync(paths.built)).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
  });

  it("refuses when the workspaces folder itself is a link", () => {
    const paths = testPaths();
    const elsewhere = tempDir();
    mkdirSync(path.join(elsewhere, ID));
    writeFileSync(path.join(elsewhere, ID, "keep.txt"), "made up\n");
    rmSync(paths.workspaces, { recursive: true });
    symlinkSync(elsewhere, paths.workspaces);

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: false, reason: "the workspaces folder is not a plain folder" });
    expect(existsSync(path.join(elsewhere, ID, "keep.txt"))).toBe(true);
    expect(readdirSync(paths.built)).toEqual([]);
  });

  it("refuses when built/ is a link to somewhere else, and writes nothing through it", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths);
    const elsewhere = tempDir();
    rmSync(paths.built, { recursive: true });
    symlinkSync(elsewhere, paths.built);

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: false, reason: "the folder for finished builds could not be made ready" });
    expect(retireSealed({ paths, ideaId: ID, now: NOW })).toEqual({ ok: false, reason: "the folder for finished builds could not be made ready" });
    expect(readdirSync(elsewhere)).toEqual([]);
    // The build is still where it was: the morning uses it there.
    expect(existsSync(path.join(workspace, "dist", "index.html"))).toBe(true);
  });

  it("refuses when a link stands where the idea's finished build is kept, and leaves the workspace where it is", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths);
    const elsewhere = tempDir();
    symlinkSync(elsewhere, path.join(paths.built, ID));

    const reason = "a link stands where the idea's finished build is kept";
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: false, reason });
    expect(retireSealed({ paths, ideaId: ID, now: NOW })).toEqual({ ok: false, reason });
    expect(lstatSync(path.join(paths.built, ID)).isSymbolicLink()).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(path.join(workspace, "dist", "index.html"))).toBe(true);
  });

  it("refuses when there is no workspace, and then keeps the finished build the idea already has", () => {
    const paths = testPaths();
    builtWorkspace(paths, "the only build");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);

    // Nothing to seal the second time: the sealed build must not be moved aside for nothing.
    expect(sealWorkspace({ paths, ideaId: ID, now: LATER })).toEqual({ ok: false, reason: "the workspace folder is missing" });
    expect(readdirSync(paths.built)).toEqual([ID]);
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toContain("the only build");

    // The same for a plain file under the workspace's name.
    writeFileSync(path.join(paths.workspaces, ID), "in the way: made up");
    expect(sealWorkspace({ paths, ideaId: ID, now: LATER })).toMatchObject({ ok: false, reason: expect.stringContaining("not a plain folder") });
    expect(readdirSync(paths.built)).toEqual([ID]);
  });

  it("refuses an id that could leave the folders, and makes nothing", () => {
    const paths = testPaths();
    mkdirSync(path.join(paths.root, "escape"));
    for (const bad of ["../escape", "a/b", "", ".", "..", ".hidden", "idea id", "x".repeat(81)]) {
      expect(sealWorkspace({ paths, ideaId: bad, now: NOW }), bad).toEqual({ ok: false, reason: "the idea id cannot be used as a folder name" });
      expect(retireSealed({ paths, ideaId: bad, now: NOW }), bad).toEqual({ ok: false, reason: "the idea id cannot be used as a folder name" });
    }
    expect(readdirSync(paths.built)).toEqual([]);
    expect(readdirSync(path.join(paths.root, "escape"))).toEqual([]);
  });

  it("never throws: whatever is in the way comes back as a reason, with an error code and no path", () => {
    // built/ cannot be made: a file stands where it should be.
    const blocked = testPaths();
    builtWorkspace(blocked);
    rmSync(blocked.built, { recursive: true });
    writeFileSync(blocked.built, "in the way: made up");
    expect(sealWorkspace({ paths: blocked, ideaId: ID, now: NOW })).toEqual({ ok: false, reason: "the folder for finished builds could not be made ready" });

    // The rename itself is refused: nothing may be taken out of a read-only folder.
    const locked = testPaths();
    builtWorkspace(locked);
    chmodSync(locked.workspaces, 0o500);
    try {
      const sealed = sealWorkspace({ paths: locked, ideaId: ID, now: NOW });
      expect(sealed).toEqual({ ok: false, reason: "the workspace could not be moved (EACCES)" });
      expect(JSON.stringify(sealed)).not.toContain(locked.root);
      expect(existsSync(path.join(locked.workspaces, ID, "dist", "index.html"))).toBe(true);
    } finally {
      chmodSync(locked.workspaces, 0o700);
    }

    // The workspaces folder cannot be looked into at all.
    const hidden = testPaths();
    builtWorkspace(hidden);
    chmodSync(hidden.workspaces, 0o000);
    try {
      expect(sealWorkspace({ paths: hidden, ideaId: ID, now: NOW })).toEqual({ ok: false, reason: "the workspace could not be looked at (EACCES)" });
    } finally {
      chmodSync(hidden.workspaces, 0o700);
    }
  });
});

describe("retireSealed: before an idea is built again", () => {
  it("does nothing when the idea has no finished build, and says where one would go", () => {
    const paths = testPaths();
    expect(retireSealed({ paths, ideaId: ID, now: NOW })).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null });
    expect(readdirSync(paths.built)).toEqual([]);
  });

  it("moves the finished build aside under a name with the time in it, and keeps every file", () => {
    const paths = testPaths();
    builtWorkspace(paths, "yesterday's app");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);

    const retired = retireSealed({ paths, ideaId: ID, now: LATER });
    const old = path.join(paths.built, `${ID}.old-20261011T071230Z`);
    expect(retired).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: old });
    expect(existsSync(path.join(paths.built, ID))).toBe(false);
    expect(readdirSync(old).sort()).toEqual(["BUILD_STATUS.json", "brief.md", "dist"]);
    expect(readFileSync(path.join(old, "dist", "index.html"), "utf8")).toContain("yesterday's app");
    // The morning no longer finds it under the idea's name.
    expect(finishedBuildDir(paths, ID)).toBe(path.join(paths.workspaces, ID));
    // Asked again, there is nothing left to move.
    expect(retireSealed({ paths, ideaId: ID, now: LATER })).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null });
  });

  it("moves a stray plain file aside too: nothing may stand where the next build goes", () => {
    const paths = testPaths();
    writeFileSync(path.join(paths.built, ID), "in the way: made up");
    const retired = retireSealed({ paths, ideaId: ID, now: NOW });
    expect(retired).toMatchObject({ ok: true, movedAside: path.join(paths.built, `${ID}.old-20261010T074000Z`) });
    expect(readFileSync(path.join(paths.built, `${ID}.old-20261010T074000Z`), "utf8")).toBe("in the way: made up");
  });

  it("skips a name that is taken, and writes over nothing", () => {
    const paths = testPaths();
    builtWorkspace(paths);
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    const stamp = "20261011T071230Z";
    mkdirSync(path.join(paths.built, `${ID}.old-${stamp}`));
    const retired = retireSealed({ paths, ideaId: ID, now: LATER });
    expect(retired).toMatchObject({ ok: true, movedAside: path.join(paths.built, `${ID}.old-${stamp}-2`) });
    expect(readdirSync(path.join(paths.built, `${ID}.old-${stamp}`))).toEqual([]);
  });

  // macOS's "locked" mark on a folder makes a rename fail whatever the folder's permissions are.
  it.skipIf(process.platform !== "darwin")("never throws when the older build cannot be moved: the reason has an error code and no path", () => {
    const paths = testPaths();
    builtWorkspace(paths, "locked build");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    const sealed = path.join(paths.built, ID);
    expect(spawnSync("/usr/bin/chflags", ["uchg", sealed]).status).toBe(0);
    try {
      const retired = retireSealed({ paths, ideaId: ID, now: LATER });
      expect(retired).toEqual({ ok: false, reason: "the older finished build could not be moved aside (EPERM)" });
      // A workspace cannot be sealed over it either, and is left where it is. (The night flow
      // never gets this far: it does not start a build whose older copy could not be moved.)
      const workspace = builtWorkspace(paths, "newer build");
      expect(sealWorkspace({ paths, ideaId: ID, now: LATER })).toEqual(retired);
      expect(existsSync(path.join(workspace, "dist", "index.html"))).toBe(true);
      expect(readFileSync(path.join(sealed, "dist", "index.html"), "utf8")).toContain("locked build");
    } finally {
      spawnSync("/usr/bin/chflags", ["nouchg", sealed]);
    }
  });
});
