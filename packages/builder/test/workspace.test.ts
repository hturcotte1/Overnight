// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_STATUS_FILE, checkBuildResult, prepareWorkspace } from "../src/index.ts";
import { leaveBuild, testPaths } from "./helpers.ts";

const ID = "idea_20261010_ab12cd34";
const NOW = new Date("2026-10-10T07:00:05.000Z");
const mode = (file: string) => statSync(file).mode & 0o777;

describe("prepareWorkspace", () => {
  it("makes a private, empty workspace that holds only the brief", () => {
    const paths = testPaths();
    const prepared = prepareWorkspace({ paths, ideaId: ID, brief: "# made-up brief\n", now: NOW });

    expect(prepared.workspace).toBe(path.join(paths.workspaces, ID));
    expect(prepared.briefPath).toBe(path.join(paths.workspaces, ID, "brief.md"));
    expect(prepared.movedAside).toBeNull();
    expect(readdirSync(prepared.workspace)).toEqual(["brief.md"]);
    expect(readFileSync(prepared.briefPath, "utf8")).toBe("# made-up brief\n");
    expect(mode(prepared.workspace)).toBe(0o700);
    expect(mode(prepared.briefPath)).toBe(0o600);
  });

  it("keeps a copy of the brief with the idea, for the dashboard", () => {
    const paths = testPaths();
    prepareWorkspace({ paths, ideaId: ID, brief: "# made-up brief\n", now: NOW });
    const copy = path.join(paths.ideas, ID, "brief.md");
    expect(readFileSync(copy, "utf8")).toBe("# made-up brief\n");
    expect(mode(copy)).toBe(0o600);
    expect(mode(path.dirname(copy))).toBe(0o700);
  });

  it("moves an earlier try aside instead of deleting it or building on top of it", () => {
    const paths = testPaths();
    const first = prepareWorkspace({ paths, ideaId: ID, brief: "first brief", now: NOW });
    leaveBuild(first.workspace);
    writeFileSync(path.join(first.workspace, "half-built.txt"), "left by the first try");

    const second = prepareWorkspace({ paths, ideaId: ID, brief: "second brief", now: new Date("2026-10-10T07:20:00.000Z") });
    expect(second.workspace).toBe(first.workspace);
    expect(readdirSync(second.workspace)).toEqual(["brief.md"]);
    expect(readFileSync(second.briefPath, "utf8")).toBe("second brief");

    const old = path.join(paths.workspaces, `${ID}.old-20261010T072000Z`);
    expect(second.movedAside).toBe(old);
    expect(readdirSync(old).sort()).toEqual(["BUILD_STATUS.json", "brief.md", "dist", "half-built.txt"]);
    expect(readFileSync(path.join(old, "brief.md"), "utf8")).toBe("first brief");
    // The copy with the idea is the newest brief.
    expect(readFileSync(path.join(paths.ideas, ID, "brief.md"), "utf8")).toBe("second brief");
  });

  it("does not overwrite an older set-aside folder made in the same second", () => {
    const paths = testPaths();
    prepareWorkspace({ paths, ideaId: ID, brief: "one", now: NOW });
    prepareWorkspace({ paths, ideaId: ID, brief: "two", now: NOW });
    const third = prepareWorkspace({ paths, ideaId: ID, brief: "three", now: NOW });
    expect(third.movedAside).toBe(path.join(paths.workspaces, `${ID}.old-20261010T070005Z-2`));
    expect(readdirSync(paths.workspaces).sort()).toEqual([ID, `${ID}.old-20261010T070005Z`, `${ID}.old-20261010T070005Z-2`]);
    expect(readFileSync(path.join(paths.workspaces, `${ID}.old-20261010T070005Z`, "brief.md"), "utf8")).toBe("one");
  });

  it("refuses an id that could leave the workspaces folder", () => {
    const paths = testPaths();
    for (const bad of ["../escape", "a/b", "", ".hidden", "idea id", "x".repeat(81)]) {
      expect(() => prepareWorkspace({ paths, ideaId: bad, brief: "b", now: NOW }), bad).toThrow(/folder name/);
    }
    expect(readdirSync(paths.workspaces)).toEqual([]);
    expect(existsSync(path.join(paths.root, "escape"))).toBe(false);
  });
});

describe("checkBuildResult: did the agent finish?", () => {
  const before = () => Date.now() - 60_000;

  function workspace(): string {
    const paths = testPaths();
    return prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW }).workspace;
  }

  it("passes when BUILD_STATUS.json says built, is fresh, and dist/index.html exists", () => {
    const dir = workspace();
    leaveBuild(dir);
    expect(checkBuildResult(dir, before())).toEqual({ ok: true, smokeTest: "passed" });
  });

  it("fails with no status file", () => {
    expect(checkBuildResult(workspace(), before())).toMatchObject({ ok: false, neverStarted: true, reason: expect.stringContaining("left no BUILD_STATUS.json") });
  });

  it("fails when the status file is older than the build", () => {
    const dir = workspace();
    leaveBuild(dir);
    expect(checkBuildResult(dir, Date.now() + 60_000)).toMatchObject({ ok: false, neverStarted: true, reason: expect.stringContaining("older than this build") });
  });

  it("fails when the agent says failed, or never got past building", () => {
    const failed = workspace();
    leaveBuild(failed, { status: "failed" });
    expect(checkBuildResult(failed, before())).toMatchObject({ ok: false, neverStarted: false, reason: expect.stringContaining("reported that the build failed") });

    const building = workspace();
    leaveBuild(building, { status: "building" });
    expect(checkBuildResult(building, before())).toMatchObject({ ok: false, reason: "the builder stopped before it finished" });
  });

  it("fails when the file is not what the skill writes", () => {
    for (const raw of ["not json", "[]", '{"status": 7}', '"built"', ""]) {
      const dir = workspace();
      leaveBuild(dir, { raw, dist: true });
      expect(checkBuildResult(dir, before()), raw).toMatchObject({ ok: false, reason: "BUILD_STATUS.json could not be read" });
    }
  });

  it("fails when the agent says built but there is no dist/index.html", () => {
    const dir = workspace();
    leaveBuild(dir, { status: "built", dist: false });
    expect(checkBuildResult(dir, before())).toMatchObject({ ok: false, reason: expect.stringContaining("dist/index.html is missing") });

    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.html"), "");
    expect(checkBuildResult(dir, before())).toMatchObject({ ok: false, reason: expect.stringContaining("dist/index.html is missing") });
  });

  it("never puts what the agent wrote into the reason", () => {
    const dir = workspace();
    leaveBuild(dir, { raw: JSON.stringify({ status: "failed", reason: "SECRET-LOOKING agent text" }) });
    expect(JSON.stringify(checkBuildResult(dir, before()))).not.toContain("SECRET-LOOKING");
  });

  it("does not follow a link planted where the status file or dist should be", async () => {
    const { symlinkSync } = await import("node:fs");
    const paths = testPaths();
    const dir = prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW }).workspace;
    const outside = path.join(paths.root, "outside");
    mkdirSync(outside);
    leaveBuild(outside);

    symlinkSync(path.join(outside, BUILD_STATUS_FILE), path.join(dir, BUILD_STATUS_FILE));
    expect(checkBuildResult(dir, before())).toMatchObject({ ok: false, reason: "BUILD_STATUS.json could not be read" });

    const linkedDist = prepareWorkspace({ paths, ideaId: "idea_other", brief: "b", now: NOW }).workspace;
    leaveBuild(linkedDist, { dist: false });
    symlinkSync(path.join(outside, "dist"), path.join(linkedDist, "dist"));
    expect(checkBuildResult(linkedDist, before())).toMatchObject({ ok: false, reason: expect.stringContaining("dist/index.html is missing") });
  });
});

describe("checkBuildResult: is it still the folder we made?", () => {
  const before = () => Date.now() - 60_000;

  it("fails when the workspace was moved away and a link put in its place", () => {
    // What a stand-in agent did in the review: mv "$W" elsewhere && ln -s <a folder that says "built"> "$W".
    const paths = testPaths();
    const dir = prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW }).workspace;
    const stolen = path.join(paths.root, "stolen");
    const decoy = path.join(paths.root, "decoy");
    mkdirSync(decoy);
    leaveBuild(decoy);
    renameSync(dir, stolen);
    symlinkSync(decoy, dir);

    // Followed blindly it would look like a finished build.
    expect(existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
    expect(checkBuildResult(dir, before())).toEqual({ ok: false, reason: "the workspace folder was moved or replaced during the build", neverStarted: false });
  });

  it("fails when the workspace is gone, or is a file", () => {
    const paths = testPaths();
    const dir = prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW }).workspace;
    rmSync(dir, { recursive: true });
    expect(checkBuildResult(dir, before())).toMatchObject({ ok: false, reason: "the workspace folder was moved or replaced during the build" });
    writeFileSync(dir, "in the way");
    expect(checkBuildResult(dir, before())).toMatchObject({ ok: false, reason: "the workspace folder was moved or replaced during the build" });
  });

  it("fails when a folder on the way to the workspace is a link (the path given is not the real one)", () => {
    const paths = testPaths();
    const dir = prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW }).workspace;
    leaveBuild(dir);
    const alias = path.join(paths.root, "alias");
    symlinkSync(paths.workspaces, alias);
    expect(checkBuildResult(path.join(alias, ID), before())).toMatchObject({ ok: false, reason: "the workspace folder was moved or replaced during the build" });
    // By its real path the same folder is fine.
    expect(checkBuildResult(dir, before())).toEqual({ ok: true, smokeTest: "passed" });
  });

  it("does not read a status file that is far too large, a folder, or a named pipe", () => {
    const large = prepareWorkspace({ paths: testPaths(), ideaId: ID, brief: "b", now: NOW }).workspace;
    leaveBuild(large, { raw: JSON.stringify({ status: "built", padding: "x".repeat(70 * 1024) }) });
    expect(checkBuildResult(large, before())).toMatchObject({ ok: false, reason: "BUILD_STATUS.json could not be read", neverStarted: false });

    const folder = prepareWorkspace({ paths: testPaths(), ideaId: ID, brief: "b", now: NOW }).workspace;
    mkdirSync(path.join(folder, BUILD_STATUS_FILE));
    expect(checkBuildResult(folder, before())).toMatchObject({ ok: false, reason: "BUILD_STATUS.json could not be read" });
  });
});

describe("prepareWorkspace: the folders it writes into", () => {
  it("refuses to work through a link put where the workspaces folder should be", () => {
    const paths = testPaths();
    const elsewhere = path.join(paths.root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(paths.workspaces, { recursive: true });
    symlinkSync(elsewhere, paths.workspaces);
    expect(() => prepareWorkspace({ paths, ideaId: ID, brief: "b", now: NOW })).toThrow(/not a plain folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("moves a link aside like any earlier try, and never writes through it", () => {
    const paths = testPaths();
    const elsewhere = path.join(paths.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(paths.workspaces, ID));
    const prepared = prepareWorkspace({ paths, ideaId: ID, brief: "fresh brief", now: NOW });
    expect(readdirSync(prepared.workspace)).toEqual(["brief.md"]);
    expect(lstatSync(prepared.workspace).isDirectory()).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(prepared.movedAside ?? "").isSymbolicLink()).toBe(true);
  });
});
