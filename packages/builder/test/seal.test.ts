// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// Moving a finished build out of the build jobs' reach, on temp folders.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { finishedBuildDir } from "@overnight/core";
import type { DataPaths } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, retireSealed, sealedDir, sealWorkspace } from "../src/index.ts";
import { MAKE_ANEW_MAX_FILE_BYTES, MAKE_ANEW_TIME_LIMIT_MS, makeFilesAnew } from "../src/seal.ts";
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
    // Three files: the brief, the status file and the page. Each is made anew (see below).
    expect(sealed).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null, madeAnew: 3, notMadeAnew: 0 });
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
    expect(again).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: old, madeAnew: 3, notMadeAnew: 0 });
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

const AS_BUILT = "<!doctype html><title>as built</title>";
const fileNumber = (file: string): number => lstatSync(file).ino;

describe("sealWorkspace: every file of a finished build is made anew", () => {
  it("a file its build kept open no longer leads to the sealed file", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    // What a program a build left running has: the page, open for writing since before the seal.
    const kept = openSync(path.join(workspace, "dist", "index.html"), "r+");
    try {
      expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toMatchObject({ ok: true, madeAnew: 3, notMadeAnew: 0 });
      // The write itself works: nothing stops a program writing to a file it has open.
      expect(writeSync(kept, "CHANGED AFTER THE SEAL, THROUGH A FILE OPENED BEFORE IT", 0)).toBeGreaterThan(0);
    } finally {
      closeSync(kept);
    }
    // It went to the old file. The sealed one is as the build left it.
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toBe(AS_BUILT);
  });

  it("a hard link its build made in a folder jobs may write no longer leads to the sealed file", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    // A second name for the page, made before the seal in the build jobs' temporary folder,
    // where every later job may write.
    mkdirSync(paths.buildTmp, { recursive: true });
    const kept = path.join(paths.buildTmp, "kept.html");
    linkSync(path.join(workspace, "dist", "index.html"), kept);
    expect(lstatSync(kept).nlink).toBe(2);

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toMatchObject({ ok: true, madeAnew: 3, notMadeAnew: 0 });
    const page = path.join(paths.built, ID, "dist", "index.html");
    // The sealed page is a file of its own now, with one name. (The morning's copy refuses a
    // file with two.)
    expect(lstatSync(page).nlink).toBe(1);
    expect(fileNumber(page)).not.toBe(fileNumber(kept));
    appendFileSync(kept, "CHANGED AFTER THE SEAL, THROUGH THE HARD LINK");
    expect(readFileSync(page, "utf8")).toBe(AS_BUILT);
    // What the link names is the old file, which nothing reads any more.
    expect(readFileSync(kept, "utf8")).toBe(`${AS_BUILT}CHANGED AFTER THE SEAL, THROUGH THE HARD LINK`);
  });

  it("gives each file the same content, permissions and time, and leaves folders and links as they are", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    const made = new Date("2026-01-02T03:04:05.000Z");
    const files: Array<[name: string, content: string | Buffer, permissions: number]> = [
      ["tool.sh", "#!/bin/sh\necho made up\n", 0o755],
      ["notes.txt", "made-up notes\n", 0o600],
      ["LICENSE", "made-up licence\n", 0o444],
      ["empty.txt", "", 0o644],
      ["src/a/b/c.js", "export const madeUp = true;\n", 0o644],
      ["node_modules/pkg/index.js", "module.exports = 'made up';\n", 0o644],
      // Larger than one read, and not text.
      ["dist/picture.bin", Buffer.alloc(3 * 1024 * 1024 + 7, 0xa7), 0o640],
    ];
    for (const [name, content, permissions] of files) {
      const file = path.join(workspace, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      chmodSync(file, permissions);
      utimesSync(file, made, made);
    }
    symlinkSync("tool.sh", path.join(workspace, "tool-link"));
    symlinkSync("src", path.join(workspace, "src-link"));
    symlinkSync("nowhere/at/all", path.join(workspace, "dangling"));
    const numbersBefore = new Map(files.map(([name]) => [name, fileNumber(path.join(workspace, name))]));
    const folderBefore = fileNumber(path.join(workspace, "src", "a"));

    // The seven above, and the brief, the status file and the page.
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null, madeAnew: 10, notMadeAnew: 0 });

    const sealed = path.join(paths.built, ID);
    for (const [name, content, permissions] of files) {
      const file = path.join(sealed, name);
      expect(fileNumber(file), name).not.toBe(numbersBefore.get(name));
      expect(readFileSync(file).equals(Buffer.from(content)), name).toBe(true);
      expect(mode(file), name).toBe(permissions);
      expect(statSync(file).mtime.toISOString(), name).toBe(made.toISOString());
      expect(lstatSync(file).nlink, name).toBe(1);
    }
    // A folder is the same folder, and a link is still a link to the same place: no job can
    // change what a name in built/ leads to, so there is nothing to make anew.
    expect(fileNumber(path.join(sealed, "src", "a"))).toBe(folderBefore);
    for (const [link, target] of [["tool-link", "tool.sh"], ["src-link", "src"], ["dangling", "nowhere/at/all"]] as const) {
      expect(lstatSync(path.join(sealed, link)).isSymbolicLink(), link).toBe(true);
      expect(readlinkSync(path.join(sealed, link)), link).toBe(target);
    }
    // Nothing of the seal's own is left behind: not in the build, not beside it.
    expect(readdirSync(paths.built)).toEqual([ID]);
    expect(readdirSync(sealed).sort()).toEqual(["BUILD_STATUS.json", "LICENSE", "brief.md", "dangling", "dist", "empty.txt", "node_modules", "notes.txt", "src", "src-link", "tool-link", "tool.sh"]);
    expect(readdirSync(path.join(sealed, "dist")).sort()).toEqual(["index.html", "picture.bin"]);
  });

  it("makes anew a file its build left unreadable, and looks into a folder its build left closed", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    // Not a way to keep a file out of the seal: the files are this user's whatever their permissions say.
    const secret = path.join(workspace, "dist", "unreadable.js");
    writeFileSync(secret, "made up: unreadable\n");
    const numbers = [secret];
    for (const folder of ["closed", "read-only"]) {
      mkdirSync(path.join(workspace, folder));
      writeFileSync(path.join(workspace, folder, "inside.js"), `made up: inside ${folder}\n`);
      numbers.push(path.join(workspace, folder, "inside.js"));
    }
    const before = numbers.map((file) => fileNumber(file));
    chmodSync(secret, 0o000);
    chmodSync(path.join(workspace, "closed"), 0o000);
    chmodSync(path.join(workspace, "read-only"), 0o500);

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toMatchObject({ ok: true, madeAnew: 6, notMadeAnew: 0 });
    const sealed = path.join(paths.built, ID);
    const after = [path.join(sealed, "dist", "unreadable.js"), path.join(sealed, "closed", "inside.js"), path.join(sealed, "read-only", "inside.js")];
    for (const [n, file] of after.entries()) expect(fileNumber(file), file).not.toBe(before[n]);
    // The new file is as closed as the old one was. (Opened here only to look.)
    expect(mode(after[0] ?? "")).toBe(0o000);
    chmodSync(after[0] ?? "", 0o600);
    expect(readFileSync(after[0] ?? "", "utf8")).toBe("made up: unreadable\n");
    expect(readFileSync(after[1] ?? "", "utf8")).toBe("made up: inside closed\n");
    // The two folders are left open to their own user.
    expect(mode(path.join(sealed, "closed")) & 0o700).toBe(0o700);
    expect(mode(path.join(sealed, "read-only")) & 0o700).toBe(0o700);
  });

  // macOS's "locked" mark on a file: it can be read, but nothing can be put in its place.
  it.skipIf(process.platform !== "darwin")("says how many files it could not make anew, and still moves the build and makes the rest anew", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    const locked = path.join(workspace, "dist", "locked.js");
    writeFileSync(locked, "made up: locked\n");
    const numberBefore = fileNumber(locked);
    const pageBefore = fileNumber(path.join(workspace, "dist", "index.html"));
    expect(spawnSync("/usr/bin/chflags", ["uchg", locked]).status).toBe(0);
    const sealedFile = path.join(paths.built, ID, "dist", "locked.js");
    try {
      // "ok": the build is where the morning looks for it. The count is what a caller logs.
      expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null, madeAnew: 3, notMadeAnew: 1 });
      expect(fileNumber(sealedFile)).toBe(numberBefore);
      expect(readFileSync(sealedFile, "utf8")).toBe("made up: locked\n");
      expect(fileNumber(path.join(paths.built, ID, "dist", "index.html"))).not.toBe(pageBefore);
      // The copy that could not be put in place is gone again, and so is the folder it was made in.
      expect(readdirSync(paths.built)).toEqual([ID]);
      expect(readdirSync(path.join(paths.built, ID, "dist")).sort()).toEqual(["index.html", "locked.js"]);
    } finally {
      spawnSync("/usr/bin/chflags", ["nouchg", sealedFile]);
      spawnSync("/usr/bin/chflags", ["nouchg", locked]);
    }
  });

  it("still moves the build when the folder for its copies cannot be made, and says that nothing was made anew", () => {
    const paths = testPaths();
    const workspace = builtWorkspace(paths, "as built");
    const pageBefore = fileNumber(path.join(workspace, "dist", "index.html"));
    const inTheWay = path.join(paths.built, `${ID}.sealing`);
    writeFileSync(inTheWay, "in the way: made up");

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toEqual({ ok: true, dir: path.join(paths.built, ID), movedAside: null, madeAnew: 0, notMadeAnew: 1 });
    expect(fileNumber(path.join(paths.built, ID, "dist", "index.html"))).toBe(pageBefore);
    expect(finishedBuildDir(paths, ID)).toBe(path.join(paths.built, ID));
    expect(readFileSync(inTheWay, "utf8")).toBe("in the way: made up");
  });

  it("uses the folder an earlier, killed seal left behind, and leaves what is in it", () => {
    const paths = testPaths();
    builtWorkspace(paths, "as built");
    const left = path.join(paths.built, `${ID}.sealing`);
    mkdirSync(left);
    writeFileSync(path.join(left, "99999-7"), "a half-made copy: made up");

    expect(sealWorkspace({ paths, ideaId: ID, now: NOW })).toMatchObject({ ok: true, madeAnew: 3, notMadeAnew: 0 });
    expect(readdirSync(paths.built).sort()).toEqual([ID, `${ID}.sealing`]);
    expect(readdirSync(left)).toEqual(["99999-7"]);
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toBe(AS_BUILT);
  });

  it("makes the files of the newer build anew when an older one is moved aside first", () => {
    const paths = testPaths();
    builtWorkspace(paths, "first build");
    expect(sealWorkspace({ paths, ideaId: ID, now: NOW }).ok).toBe(true);
    const workspace = builtWorkspace(paths, "second build");
    const kept = path.join(paths.buildTmp, "kept.html");
    mkdirSync(paths.buildTmp, { recursive: true });
    linkSync(path.join(workspace, "dist", "index.html"), kept);
    expect(sealWorkspace({ paths, ideaId: ID, now: LATER })).toMatchObject({ ok: true, madeAnew: 3, notMadeAnew: 0 });
    appendFileSync(kept, " CHANGED");
    expect(readFileSync(path.join(paths.built, ID, "dist", "index.html"), "utf8")).toBe("<!doctype html><title>second build</title>");
  });
});

describe("makeFilesAnew: its limits", () => {
  /** A folder shaped like a build, and an empty folder beside it for the copies. */
  function tree() {
    const root = tempDir();
    const dir = path.join(root, "app");
    const scratch = path.join(root, "scratch");
    const names = ["page.html", "src/main.js", "node_modules/pkg/index.js", "node_modules/pkg/lib/deep.js", "tools/node_modules/other.js"];
    for (const name of names) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), `made up: ${name}\n`);
    }
    mkdirSync(scratch);
    const numbers = () => Object.fromEntries(names.map((name) => [name, fileNumber(path.join(dir, name))]));
    return { root, dir, scratch, names, numbers };
  }
  /** Which files are new ones, by name. */
  const renewed = (before: Record<string, number>, after: Record<string, number>): string[] => Object.keys(before).filter((name) => before[name] !== after[name]).sort();

  it("has eight seconds and a gigabyte a file unless told otherwise", () => {
    expect([MAKE_ANEW_TIME_LIMIT_MS, MAKE_ANEW_MAX_FILE_BYTES]).toEqual([8_000, 1024 * 1024 * 1024]);
    const { dir, scratch, names, numbers } = tree();
    const before = numbers();
    expect(makeFilesAnew(dir, scratch)).toEqual({ madeAnew: 5, notMadeAnew: 0 });
    expect(renewed(before, numbers())).toEqual([...names].sort());
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("does installed packages last, so that they are what is left over when the time runs out", () => {
    const { dir, scratch, numbers } = tree();
    const before = numbers();
    // A clock that moves one second each time it is read: once at the start, then once for each file.
    let clock = 0;
    const now = (): number => (clock += 1_000);
    expect(makeFilesAnew(dir, scratch, { now, timeLimitMs: 2_500 })).toEqual({ madeAnew: 2, notMadeAnew: 3 });
    // The two that are not installed packages, wherever in the folder they are.
    expect(renewed(before, numbers())).toEqual(["page.html", "src/main.js"]);
    // No time at all: every file is counted, none is touched.
    expect(makeFilesAnew(dir, scratch, { timeLimitMs: 0 })).toEqual({ madeAnew: 0, notMadeAnew: 5 });
  });

  it("leaves a file larger than the limit as it is, and counts it", () => {
    const { dir, scratch, numbers } = tree();
    writeFileSync(path.join(dir, "page.html"), "x".repeat(41));
    writeFileSync(path.join(dir, "src", "main.js"), "x".repeat(40));
    const before = numbers();
    expect(makeFilesAnew(dir, scratch, { maxFileBytes: 40 })).toEqual({ madeAnew: 4, notMadeAnew: 1 });
    expect(renewed(before, numbers())).not.toContain("page.html");
    expect(renewed(before, numbers())).toContain("src/main.js");
  });

  it("never throws: a folder that is not there, and nowhere to make the copies", () => {
    const { root, dir, scratch, numbers } = tree();
    expect(makeFilesAnew(path.join(root, "missing"), scratch)).toEqual({ madeAnew: 0, notMadeAnew: 1 });
    const before = numbers();
    expect(makeFilesAnew(dir, path.join(root, "no-such-folder"))).toEqual({ madeAnew: 0, notMadeAnew: 5 });
    expect(renewed(before, numbers())).toEqual([]);
  });

  it("makes a few thousand files anew well inside its time", () => {
    const { root, scratch } = tree();
    const dir = path.join(root, "many");
    for (let folder = 0; folder < 20; folder += 1) {
      mkdirSync(path.join(dir, "node_modules", `pkg-${folder}`), { recursive: true });
      for (let file = 0; file < 100; file += 1) writeFileSync(path.join(dir, "node_modules", `pkg-${folder}`, `${file}.js`), `made up ${folder}/${file}\n`);
    }
    const started = Date.now();
    expect(makeFilesAnew(dir, scratch)).toEqual({ madeAnew: 2_000, notMadeAnew: 0 });
    expect(Date.now() - started).toBeLessThan(MAKE_ANEW_TIME_LIMIT_MS);
    expect(readFileSync(path.join(dir, "node_modules", "pkg-19", "99.js"), "utf8")).toBe("made up 19/99\n");
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
