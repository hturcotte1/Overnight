// SYNTHETIC: every brief, note, report and picture in this file is made up. None of it is Bee data.
//
// Reading the files the idea page shows. Some of them were written by a build agent, so each
// kind of trap (a link, a named pipe, a folder, a huge file) is put where a file is expected.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorkspace, retireSealed, sealWorkspace } from "@overnight/builder";
import { dataPaths, finishedBuildDir } from "@overnight/core";
import type { DataPaths } from "@overnight/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasScreenshot, readBrief, readBuildNotes, readReport, readScreenshot, workspaceMarks } from "../src/data/files.ts";
import { isOwnFolder, isPng, readPng, readSmallFile, readTail, sqliteWouldWait } from "../src/data/safe-read.ts";
import { collectIdeaExtras } from "../src/data/snapshot.ts";
import type { DashIdea, FilmingPolicy } from "../src/types.ts";

const ID = "idea_20261009_aa11bb22";
const HOME = "/Users/sam";
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOT_FILMING: FilmingPolicy = { on: false, showQuoteFor: new Set() };
/** An invented idea as the pages see it. */
const IDEA: DashIdea = {
  id: ID, state: "built", title: "Packing Checklist", pitch: "Tick off what to pack.", quote: { shown: false, why: "none" }, hidden: false, confidence: 0.9,
  createdAt: "2026-10-09T18:00:00.000Z", updatedAt: "2026-10-10T13:00:00.000Z", askedAt: null, askExpiresAt: null, answeredAt: null, note: null, slug: null,
  buildBackend: null, buildStartedAt: null, builtAt: null, publishedUrl: null, publishedAt: null, deliveredAt: null, failureReason: null, failureNotifiedAt: null,
  rehearsal: false, buildStarts: 1, awaitingRetry: false, hasMorningTodo: false, hasFact: false,
};

let scratch: string;
let paths: DataPaths;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight dashboard files "));
  paths = dataPaths(path.join(scratch, "data"));
  for (const folder of [paths.ideas, paths.workspaces, paths.built, paths.reports, paths.screenshots]) mkdirSync(folder, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a file, making its folder first. */
function put(file: string, content: string | Buffer): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** A named pipe with nobody writing to it: a plain read of it would wait for ever. */
function pipeAt(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("mkfifo", [file]);
  return file;
}

/** Run something that must come back at once, and say so if it did not. */
function atOnce<T>(read: () => T): T {
  const started = performance.now();
  const result = read();
  expect(performance.now() - started).toBeLessThan(1000);
  return result;
}

describe("reading a small file", () => {
  it("reads a plain file whole", () => {
    const file = put(path.join(scratch, "a.txt"), "three invented lines\nline two\nline three\n");
    expect(readSmallFile(file, 1024)).toEqual({ text: "three invented lines\nline two\nline three\n", cut: false });
  });

  it("reads a file of exactly the limit whole", () => {
    const file = put(path.join(scratch, "a.txt"), "12345678");
    expect(readSmallFile(file, 8)).toEqual({ text: "12345678", cut: false });
  });

  it("reads only the start of a file that is too large, and says there was more", () => {
    const file = put(path.join(scratch, "big.txt"), "x".repeat(5000));
    expect(readSmallFile(file, 100)).toEqual({ text: "x".repeat(100), cut: true });
  });

  it("reads nothing at all for a limit that is no size", () => {
    const file = put(path.join(scratch, "a.txt"), "some text");
    for (const limit of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) expect(readSmallFile(file, limit)).toEqual({ text: "", cut: true });
    expect(readSmallFile(file, 4.9)).toEqual({ text: "some", cut: true });
  });

  it("never ends a cut text in half a character", () => {
    // "é" is two bytes, "€" three, and the last one four.
    for (const character of ["é", "€", "\u{1F6DE}"]) {
      const file = put(path.join(scratch, "cut.txt"), `ab${character}cd`);
      const bytes = Buffer.byteLength(character);
      for (let limit = 2; limit < 2 + bytes; limit += 1) expect(readSmallFile(file, limit)).toEqual({ text: "ab", cut: true });
      expect(readSmallFile(file, 2 + bytes)).toEqual({ text: `ab${character}`, cut: true });
    }
  });

  it("refuses a link, even one to a real file", () => {
    const real = put(path.join(scratch, "real.txt"), "behind a link");
    symlinkSync(real, path.join(scratch, "link.txt"));
    expect(readSmallFile(path.join(scratch, "link.txt"), 1024)).toBeNull();
  });

  it("refuses a named pipe without waiting for it", () => {
    const pipe = pipeAt(path.join(scratch, "pipe"));
    expect(atOnce(() => readSmallFile(pipe, 1024))).toBeNull();
    expect(atOnce(() => readTail(pipe, 1024))).toBeNull();
    expect(atOnce(() => readPng(pipe, 1024))).toBeNull();
    expect(atOnce(() => isPng(pipe, 1024))).toBe(false);
  });

  it("refuses a folder and a file that is not there", () => {
    expect(readSmallFile(scratch, 1024)).toBeNull();
    expect(readSmallFile(path.join(scratch, "nothing"), 1024)).toBeNull();
    expect(readSmallFile(path.join(scratch, "no folder", "nothing"), 1024)).toBeNull();
  });
});

describe("a file that is swapped between the look and the open", () => {
  // The three readers share one way in, so each is tried with one of the three swaps.
  const PNG = Buffer.concat([PNG_START, Buffer.from("an invented picture")]);

  it("is not read when it became a link", () => {
    const file = put(path.join(scratch, "notes.md"), "plain at the first look");
    const secret = put(path.join(scratch, "secret.md"), "not for the page");
    const swap = (): void => {
      rmSync(file);
      symlinkSync(secret, file);
    };
    expect(readSmallFile(file, 1024, swap)).toBeNull();
  });

  it("is not waited for when it became a named pipe", () => {
    const file = put(path.join(scratch, "build.log"), "plain at the first look\n");
    const swap = (): void => {
      rmSync(file);
      pipeAt(file);
    };
    expect(atOnce(() => readTail(file, 1024, swap))).toBeNull();
  });

  it("is not read when it became a folder", () => {
    const file = put(path.join(scratch, "shot.png"), PNG);
    const swap = (): void => {
      rmSync(file);
      mkdirSync(file);
    };
    expect(readPng(file, 1024, swap)).toBeNull();
  });

  it("is read as usual when nothing was swapped", () => {
    const file = put(path.join(scratch, "notes.md"), "still plain");
    let called = 0;
    expect(readSmallFile(file, 1024, () => void (called += 1))).toEqual({ text: "still plain", cut: false });
    expect(called).toBe(1);
  });
});

describe("reading the end of a log", () => {
  it("gives a short file whole", () => {
    const file = put(path.join(scratch, "a.log"), "one\ntwo\nthree\n");
    expect(readTail(file, 1024)).toBe("one\ntwo\nthree\n");
  });

  it("gives the last lines of a long file and drops the line it started in the middle of", () => {
    const file = put(path.join(scratch, "a.log"), "first line\nsecond line\nthird line\n");
    // The last 20 bytes begin inside "second line".
    expect(readTail(file, 20)).toBe("third line\n");
  });

  it("gives nothing when the end holds no whole line", () => {
    // The end of one very long line, with and without its line break.
    expect(readTail(put(path.join(scratch, "a.log"), `${"x".repeat(500)}\n`), 100)).toBe("");
    expect(readTail(put(path.join(scratch, "b.log"), "x".repeat(500)), 100)).toBe("");
  });

  it("refuses a link, a folder and a missing file", () => {
    const real = put(path.join(scratch, "real.log"), "behind a link\n");
    symlinkSync(real, path.join(scratch, "link.log"));
    expect(readTail(path.join(scratch, "link.log"), 1024)).toBeNull();
    expect(readTail(scratch, 1024)).toBeNull();
    expect(readTail(path.join(scratch, "nothing.log"), 1024)).toBeNull();
  });
});

describe("reading a picture", () => {
  it("reads a PNG whole", () => {
    const picture = Buffer.concat([PNG_START, Buffer.from("the rest of an invented picture")]);
    const file = put(path.join(scratch, "a.png"), picture);
    expect(readPng(file, 1024)?.equals(picture)).toBe(true);
  });

  it("refuses a file that does not start as a PNG does", () => {
    expect(readPng(put(path.join(scratch, "a.png"), "<svg onload=alert(1)>"), 1024)).toBeNull();
    expect(readPng(put(path.join(scratch, "b.png"), PNG_START.subarray(0, 7)), 1024)).toBeNull();
    expect(readPng(put(path.join(scratch, "c.png"), ""), 1024)).toBeNull();
  });

  it("refuses a picture over the limit instead of cutting it", () => {
    const file = put(path.join(scratch, "a.png"), Buffer.concat([PNG_START, Buffer.alloc(200)]));
    expect(readPng(file, 207)).toBeNull();
    expect(readPng(file, 208)).not.toBeNull();
  });

  it("refuses a link to a picture", () => {
    const real = put(path.join(scratch, "real.png"), Buffer.concat([PNG_START, Buffer.alloc(8)]));
    symlinkSync(real, path.join(scratch, "link.png"));
    expect(readPng(path.join(scratch, "link.png"), 1024)).toBeNull();
  });
});

describe("a folder under its own name", () => {
  it("is a real folder, reached by that name", () => {
    mkdirSync(path.join(scratch, "inside"));
    expect(isOwnFolder(scratch, "inside")).toBe(true);
  });

  it("is not a link to a folder, a file, or nothing", () => {
    mkdirSync(path.join(scratch, "elsewhere"));
    symlinkSync(path.join(scratch, "elsewhere"), path.join(scratch, "link"));
    put(path.join(scratch, "file"), "a file");
    expect(isOwnFolder(scratch, "link")).toBe(false);
    expect(isOwnFolder(scratch, "file")).toBe(false);
    expect(isOwnFolder(scratch, "nothing")).toBe(false);
  });

  it("is not a name that leads somewhere else", () => {
    mkdirSync(path.join(scratch, "a", "b"), { recursive: true });
    expect(isOwnFolder(path.join(scratch, "a"), "..")).toBe(false);
    expect(isOwnFolder(path.join(scratch, "a"), ".")).toBe(false);
    expect(isOwnFolder(path.join(scratch, "a"), "")).toBe(false);
    expect(isOwnFolder(scratch, "a/b")).toBe(false);
  });

  it("still counts when the way to its parent goes through a link", () => {
    mkdirSync(path.join(scratch, "real", "inside"), { recursive: true });
    symlinkSync(path.join(scratch, "real"), path.join(scratch, "way-in"));
    expect(isOwnFolder(path.join(scratch, "way-in"), "inside")).toBe(true);
  });
});

describe("the brief", () => {
  it("is read from the idea's own folder, with the home folder shown as ~", () => {
    put(path.join(paths.ideas, ID, "brief.md"), `# Chore Wheel\nBuild it in ${HOME}/.overnight/workspaces/${ID}.\n`);
    expect(readBrief(paths, ID, HOME)).toEqual({ text: `# Chore Wheel\nBuild it in ~/.overnight/workspaces/${ID}.\n`, cut: false });
  });

  it("is cut at 64 KiB, and says so", () => {
    put(path.join(paths.ideas, ID, "brief.md"), "b".repeat(64 * 1024 + 10));
    const brief = readBrief(paths, ID, HOME);
    expect(brief?.cut).toBe(true);
    expect(brief?.text.length).toBe(64 * 1024);
  });

  it("is nothing for an idea with no brief, for a link, and for an id that is not one", () => {
    expect(readBrief(paths, ID, HOME)).toBeNull();
    put(path.join(scratch, "secret.md"), "not a brief");
    mkdirSync(path.join(paths.ideas, ID));
    symlinkSync(path.join(scratch, "secret.md"), path.join(paths.ideas, ID, "brief.md"));
    expect(readBrief(paths, ID, HOME)).toBeNull();
    put(path.join(paths.root, "brief.md"), "one folder up");
    expect(readBrief(paths, "..", HOME)).toBeNull();
    expect(readBrief(paths, "../ideas/x", HOME)).toBeNull();
  });

  it("is nothing when the idea's folder was swapped for a link", () => {
    put(path.join(scratch, "elsewhere", "brief.md"), "somewhere else");
    symlinkSync(path.join(scratch, "elsewhere"), path.join(paths.ideas, ID));
    expect(readBrief(paths, ID, HOME)).toBeNull();
  });
});

describe("the build agent's notes", () => {
  it("are read from the workspace while a build is not finished", () => {
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), `Must-haves: a wheel. Worked in ${HOME}/x.\n`);
    expect(readBuildNotes(paths, ID, HOME)).toEqual({ text: "Must-haves: a wheel. Worked in ~/x.\n", cut: false });
  });

  it("are read from the finished build once there is one", () => {
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), "left over in the workspace");
    put(path.join(paths.built, ID, "BUILD_NOTES.md"), "the finished build's notes");
    expect(readBuildNotes(paths, ID, HOME)).toEqual({ text: "the finished build's notes", cut: false });
  });

  it("are cut at 64 KiB, and say so", () => {
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), "n".repeat(70 * 1024));
    const notes = readBuildNotes(paths, ID, HOME);
    expect(notes?.cut).toBe(true);
    expect(notes?.text.length).toBe(64 * 1024);
  });

  it("are not read through a link, a pipe or a folder put where the notes should be", () => {
    put(path.join(scratch, "secret.md"), "not for the page");
    mkdirSync(path.join(paths.workspaces, ID));
    const notes = path.join(paths.workspaces, ID, "BUILD_NOTES.md");
    symlinkSync(path.join(scratch, "secret.md"), notes);
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    rmSync(notes);
    pipeAt(notes);
    expect(atOnce(() => readBuildNotes(paths, ID, HOME))).toBeNull();
    rmSync(notes);
    mkdirSync(notes);
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
  });

  it("are not read, and no marks are given, when the workspace was swapped for a link", () => {
    // What a build job could do: move its folder away and leave a link to somewhere else in its place.
    put(path.join(scratch, "elsewhere", "BUILD_NOTES.md"), "another folder's notes");
    put(path.join(scratch, "elsewhere", "package.json"), "{}");
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), "the real notes");
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the real notes");
    expect(workspaceMarks(paths, ID)).not.toBeNull();

    renameSync(path.join(paths.workspaces, ID), path.join(paths.workspaces, `${ID}.moved`));
    symlinkSync(path.join(scratch, "elsewhere"), path.join(paths.workspaces, ID));
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    expect(workspaceMarks(paths, ID)).toBeNull();
  });

  it("are nothing for an id that is not one", () => {
    put(path.join(paths.root, "BUILD_NOTES.md"), "one folder up");
    expect(readBuildNotes(paths, "..", HOME)).toBeNull();
    expect(workspaceMarks(paths, "..")).toBeNull();
    // A plain folder name, but not the shape of an idea id.
    put(path.join(paths.workspaces, "idea.with.dots", "BUILD_NOTES.md"), "notes under a name that is no id");
    put(path.join(paths.ideas, "idea.with.dots", "brief.md"), "a brief under a name that is no id");
    expect(readBuildNotes(paths, "idea.with.dots", HOME)).toBeNull();
    expect(workspaceMarks(paths, "idea.with.dots")).toBeNull();
    expect(readBrief(paths, "idea.with.dots", HOME)).toBeNull();
  });
});

describe("the marks of a build in progress", () => {
  it("say which files are there so far, by looking only", () => {
    const workspace = path.join(paths.workspaces, ID);
    mkdirSync(workspace);
    expect(workspaceMarks(paths, ID)).toEqual({ started: false, projectWritten: false, packagesInstalled: false, appBuilt: false, notesWritten: false });

    put(path.join(workspace, "BUILD_STATUS.json"), '{"status":"building"}');
    expect(workspaceMarks(paths, ID)).toEqual({ started: true, projectWritten: false, packagesInstalled: false, appBuilt: false, notesWritten: false });
    put(path.join(workspace, "package.json"), "{}");
    mkdirSync(path.join(workspace, "node_modules"));
    expect(workspaceMarks(paths, ID)).toEqual({ started: true, projectWritten: true, packagesInstalled: true, appBuilt: false, notesWritten: false });
    put(path.join(workspace, "dist", "index.html"), "<!doctype html>");
    put(path.join(workspace, "BUILD_NOTES.md"), "notes");
    expect(workspaceMarks(paths, ID)).toEqual({ started: true, projectWritten: true, packagesInstalled: true, appBuilt: true, notesWritten: true });
  });

  it("do not count a link or a pipe as a file that was made", () => {
    const workspace = path.join(paths.workspaces, ID);
    mkdirSync(workspace);
    put(path.join(scratch, "real.json"), "{}");
    symlinkSync(path.join(scratch, "real.json"), path.join(workspace, "package.json"));
    pipeAt(path.join(workspace, "BUILD_STATUS.json"));
    mkdirSync(path.join(scratch, "real-dist"));
    put(path.join(scratch, "real-dist", "index.html"), "<!doctype html>");
    symlinkSync(path.join(scratch, "real-dist"), path.join(workspace, "dist"));
    symlinkSync(path.join(scratch, "real-dist"), path.join(workspace, "node_modules"));
    expect(atOnce(() => workspaceMarks(paths, ID))).toEqual({ started: false, projectWritten: false, packagesInstalled: false, appBuilt: false, notesWritten: false });
  });

  it("are nothing when there is no workspace", () => {
    expect(workspaceMarks(paths, ID)).toBeNull();
  });
});

// The builder keeps more in <data>/built than finished builds (builder, seal.ts and probe.ts):
//   .overnight-probe-marker   a file of the sandbox check's, so the folder is never empty
//   <id>.old-<time>           an older finished build of an idea, moved aside before it was built again
//   <id>.sealing              a folder of half-made copies, left only by a move that was killed midway
// None of them is an idea, and none of them is ever read for one. The folders here are made by the
// builder's own functions, so the names are the real ones.
describe("what else the builder keeps among the finished builds", () => {
  const MARKER = ".overnight-probe-marker";
  const FIRST = new Date("2026-10-10T07:03:20.000Z");
  const AGAIN = new Date("2026-10-11T07:00:40.000Z");
  const ALL_MARKS = { started: true, projectWritten: true, packagesInstalled: true, appBuilt: true, notesWritten: true };
  const NO_MARKS = { started: false, projectWritten: false, packagesInstalled: false, appBuilt: false, notesWritten: false };

  /** A whole invented build in the workspace: every file the marks look for, and notes that say which build it is. */
  function buildIn(workspace: string, which: string): void {
    put(path.join(workspace, "BUILD_STATUS.json"), '{"status":"built"}');
    put(path.join(workspace, "package.json"), "{}");
    mkdirSync(path.join(workspace, "node_modules"));
    put(path.join(workspace, "dist", "index.html"), "<!doctype html>");
    put(path.join(workspace, "BUILD_NOTES.md"), `the notes of ${which}`);
  }

  /** The first build of the idea, finished and moved out of the build jobs' reach by the builder itself. */
  function firstBuildSealed(): void {
    const prepared = prepareWorkspace({ paths, ideaId: ID, brief: "the brief", now: FIRST });
    buildIn(prepared.workspace, "the first build");
    expect(sealWorkspace({ paths, ideaId: ID, now: FIRST })).toMatchObject({ ok: true, movedAside: null, notMadeAnew: 0 });
    // What the sandbox check leaves beside it.
    put(path.join(paths.built, MARKER), "Overnight keeps this file here for its build sandbox check. It is safe to delete.\n");
  }

  /** The name the builder gave the older build when it moved it aside. */
  function asideIn(folder: string): string {
    const names = readdirSync(folder).filter((name) => name.startsWith(`${ID}.old-`));
    expect(names).toHaveLength(1);
    return names[0] ?? "";
  }

  it("has the sandbox check's file under the name the builder gives it", () => {
    const probe = readFileSync(fileURLToPath(new URL("../../builder/src/probe.ts", import.meta.url)), "utf8");
    expect(probe).toContain(`BUILT_MARKER_FILE = "${MARKER}"`);
    const seal = readFileSync(fileURLToPath(new URL("../../builder/src/seal.ts", import.meta.url)), "utf8");
    expect(seal).toContain("`${ideaId}.sealing`");
  });

  it("reads a finished build from its own folder, with the sandbox check's file lying beside it", () => {
    firstBuildSealed();
    expect(readdirSync(paths.built).sort()).toEqual([MARKER, ID].sort());
    expect(finishedBuildDir(paths, ID)).toBe(path.join(paths.built, ID));
    expect(readBuildNotes(paths, ID, HOME)).toEqual({ text: "the notes of the first build", cut: false });
    expect(workspaceMarks(paths, ID)).toEqual(ALL_MARKS);
  });

  it("never reads the older build that was moved aside: an idea being built again shows the new build, from its first file on", () => {
    firstBuildSealed();
    // Built again: the builder moves the finished build aside, then makes an empty workspace.
    expect(retireSealed({ paths, ideaId: ID, now: AGAIN })).toMatchObject({ ok: true });
    const aside = asideIn(paths.built);
    expect(aside).toMatch(/^idea_20261009_aa11bb22\.old-\d{8}T\d{6}Z$/);
    expect(existsSync(path.join(paths.built, aside, "BUILD_NOTES.md"))).toBe(true);
    // Between the two steps there is no build folder at all: nothing is shown, and nothing is taken from the folder moved aside.
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    expect(workspaceMarks(paths, ID)).toBeNull();

    const prepared = prepareWorkspace({ paths, ideaId: ID, brief: "the brief", now: AGAIN });
    expect(workspaceMarks(paths, ID)).toEqual(NO_MARKS);
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    put(path.join(prepared.workspace, "BUILD_STATUS.json"), '{"status":"building"}');
    expect(workspaceMarks(paths, ID)).toEqual({ ...NO_MARKS, started: true });
    put(path.join(prepared.workspace, "BUILD_NOTES.md"), "the notes of the second build");
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the notes of the second build");
    expect(collectIdeaExtras(paths, { ...IDEA, state: "building" }, HOME, NOT_FILMING)).toMatchObject({ notes: { text: "the notes of the second build" }, marks: { started: true, projectWritten: false, notesWritten: true } });

    // The second build is finished and moved in its turn. Both older things are still there, and neither is read.
    buildIn(prepared.workspace, "the second build");
    expect(sealWorkspace({ paths, ideaId: ID, now: AGAIN })).toMatchObject({ ok: true });
    expect(readdirSync(paths.built).sort()).toEqual([MARKER, ID, aside].sort());
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the notes of the second build");
  });

  it("does not take a second try's folder that was moved aside in the workspaces for the build either", () => {
    // The first builder failed and the other one started afresh: the builder moves the first try's folder aside there too.
    const first = prepareWorkspace({ paths, ideaId: ID, brief: "the brief", now: FIRST });
    buildIn(first.workspace, "the first try");
    const second = prepareWorkspace({ paths, ideaId: ID, brief: "the brief", now: AGAIN });
    expect(second.movedAside).not.toBeNull();
    expect(asideIn(paths.workspaces)).toMatch(/\.old-/);
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    expect(workspaceMarks(paths, ID)).toEqual(NO_MARKS);
  });

  it("reads a finished build as usual when a move that was killed midway left its folder of half-made copies behind", () => {
    firstBuildSealed();
    // What such a move leaves: the build in its place, every file whole, and beside it a folder with a copy or two in it.
    put(path.join(paths.built, `${ID}.sealing`, "1"), "half of a copy of the notes");
    put(path.join(paths.built, `${ID}.sealing`, "BUILD_NOTES.md"), "not the notes: a copy that was never put in place");
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the notes of the first build");
    expect(workspaceMarks(paths, ID)).toEqual(ALL_MARKS);
    expect(JSON.stringify(collectIdeaExtras(paths, { ...IDEA, state: "built" }, HOME, NOT_FILMING))).not.toContain("never put in place");
    // And when the build itself has been moved aside since, the copies are still not taken for it.
    expect(retireSealed({ paths, ideaId: ID, now: AGAIN })).toMatchObject({ ok: true });
    expect(readBuildNotes(paths, ID, HOME)).toBeNull();
    expect(workspaceMarks(paths, ID)).toBeNull();
  });

  it("builds no path from any of those names, however they are asked for", () => {
    firstBuildSealed();
    retireSealed({ paths, ideaId: ID, now: AGAIN });
    const aside = asideIn(paths.built);
    put(path.join(paths.built, `${ID}.sealing`, "BUILD_NOTES.md"), "a copy");
    // Reports, briefs and pictures under the same names, in case anything ever went looking for them.
    for (const name of [aside, `${ID}.sealing`, MARKER]) {
      put(path.join(paths.ideas, name, "brief.md"), "a brief under a name that is no idea's");
      put(path.join(paths.reports, `${name}.json`), JSON.stringify({ ideaId: name, confirmedLive: true }));
      put(path.join(paths.screenshots, `${name}.png`), Buffer.concat([PNG_START, Buffer.from("a picture")]));
    }
    for (const name of [aside, `${ID}.sealing`, MARKER, `${ID}.old-20261011T070040Z-2`, `built/${ID}`, `../built/${ID}`]) {
      expect(readBuildNotes(paths, name, HOME), name).toBeNull();
      expect(workspaceMarks(paths, name), name).toBeNull();
      expect(readBrief(paths, name, HOME), name).toBeNull();
      expect(readReport(paths, name), name).toBeNull();
      expect(readScreenshot(paths, name, "phone"), name).toBeNull();
      expect(hasScreenshot(paths, name, "phone"), name).toBe(false);
      expect(collectIdeaExtras(paths, { ...IDEA, id: name, state: "delivered" }, HOME, NOT_FILMING), name).toEqual({ report: null, brief: null, notes: null, shots: { phone: false, desktop: false }, marks: null });
    }
  });

  it("falls back to the workspace, and reads nothing through it, when a file or a link stands where a finished build should be", () => {
    // Not something the builder does (no build job can write in built/): whoever did, the page is not broken by it.
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), "the workspace's notes");
    put(path.join(paths.built, ID), "a file under a build's name");
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the workspace's notes");
    rmSync(path.join(paths.built, ID));
    put(path.join(scratch, "elsewhere", "BUILD_NOTES.md"), "another folder's notes");
    symlinkSync(path.join(scratch, "elsewhere"), path.join(paths.built, ID));
    expect(readBuildNotes(paths, ID, HOME)?.text).toBe("the workspace's notes");
    // The sandbox check's file as a folder, a pipe or a link changes nothing either.
    rmSync(path.join(paths.built, ID));
    pipeAt(path.join(paths.built, MARKER));
    expect(atOnce(() => readBuildNotes(paths, ID, HOME))?.text).toBe("the workspace's notes");
    expect(atOnce(() => workspaceMarks(paths, ID))).toEqual({ ...NO_MARKS, notesWritten: true });
  });
});

describe("the deliver step's report", () => {
  const report = {
    ideaId: ID,
    slug: "packing-checklist",
    title: "TITLE-NOT-FOR-THE-VIEW",
    pitch: "PITCH-NOT-FOR-THE-VIEW",
    backend: "kiro-crew",
    state: "delivered",
    ok: true,
    url: "https://example.invalid/overnight-apps/packing-checklist/",
    confirmedLive: true,
    failureReason: null,
    note: "NOTE-NOT-FOR-THE-VIEW",
    checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true, screenshotsSaved: true, distFiles: 3, totalMs: 6600 },
    timings: { verifyMs: 6700, publishMs: 31000, liveAfterMs: 26000 },
    sizes: { sourceFiles: 9, sourceBytes: 20000, distFiles: 3, distBytes: 5602 },
    screenshots: { phone: "/Users/sam/.overnight/screenshots/x.png", desktop: null },
    morningTodoId: 7,
    factId: 8,
    startedAt: "2026-10-10T12:30:00.000Z",
    publishedAt: "2026-10-10T12:31:00.000Z",
    deliveredAt: "2026-10-10T12:31:05.000Z",
    updatedAt: "2026-10-10T12:31:05.000Z",
  };
  const file = (): string => path.join(paths.reports, `${ID}.json`);

  it("gives the numbers and the yes/no answers, and nothing else", () => {
    put(file(), JSON.stringify(report, null, 2));
    const view = readReport(paths, ID);
    expect(view).toEqual({
      confirmedLive: true,
      failedStep: null,
      verifyMs: 6700,
      publishMs: 31000,
      liveAfterMs: 26000,
      distFiles: 3,
      distBytes: 5602,
      checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true },
    });
    expect(JSON.stringify(view)).not.toMatch(/NOT-FOR-THE-VIEW|example\.invalid|\/Users\//);
  });

  it("gives the step a failed check stopped at, as the short word it is", () => {
    put(file(), JSON.stringify({ ...report, ok: false, confirmedLive: null, checks: { installOk: true, buildOk: false, failedStep: "build" }, timings: { verifyMs: 4100, publishMs: null, liveAfterMs: null } }));
    expect(readReport(paths, ID)).toEqual({
      confirmedLive: null,
      failedStep: "build",
      verifyMs: 4100,
      publishMs: null,
      liveAfterMs: null,
      distFiles: 3,
      distBytes: 5602,
      checks: { installOk: true, buildOk: false, contractOk: null, appSmokeOk: null },
    });
  });

  it("drops a failed step that is not a short lower-case word", () => {
    for (const failedStep of ["<img src=x onerror=1>", "Build", "a".repeat(21), 7]) {
      put(file(), JSON.stringify({ ...report, checks: { failedStep } }));
      expect(readReport(paths, ID)?.failedStep).toBeNull();
    }
  });

  it("reads what it can of a report with parts missing or of the wrong kind", () => {
    put(file(), JSON.stringify({ ideaId: ID, confirmedLive: "yes", checks: "none", timings: { verifyMs: "fast", publishMs: -5, liveAfterMs: 12 }, sizes: null }));
    expect(readReport(paths, ID)).toEqual({
      confirmedLive: null,
      failedStep: null,
      verifyMs: null,
      publishMs: null,
      liveAfterMs: 12,
      distFiles: null,
      distBytes: null,
      checks: { installOk: null, buildOk: null, contractOk: null, appSmokeOk: null },
    });
  });

  it("is nothing for a report about another idea, for junk, for a missing file and for a link", () => {
    put(file(), JSON.stringify({ ...report, ideaId: "idea_20261009_cc33dd44" }));
    expect(readReport(paths, ID)).toBeNull();
    put(file(), "{ not json");
    expect(readReport(paths, ID)).toBeNull();
    put(file(), JSON.stringify(["a", "list"]));
    expect(readReport(paths, ID)).toBeNull();
    rmSync(file());
    expect(readReport(paths, ID)).toBeNull();
    put(path.join(scratch, "real.json"), JSON.stringify(report));
    symlinkSync(path.join(scratch, "real.json"), file());
    expect(readReport(paths, ID)).toBeNull();
    expect(readReport(paths, "../reports/x")).toBeNull();
    // A report-shaped file outside the reports folder, asked for by a name that would lead to it.
    put(path.join(paths.root, "outside.json"), JSON.stringify({ ...report, ideaId: "../outside" }));
    expect(readReport(paths, "../outside")).toBeNull();
  });

  it("is nothing for a report over 256 KiB: half a report is no report", () => {
    put(file(), JSON.stringify({ ...report, note: "n".repeat(256 * 1024) }));
    expect(readReport(paths, ID)).toBeNull();
  });
});

describe("the screenshots", () => {
  const picture = Buffer.concat([PNG_START, Buffer.from("an invented picture")]);

  it("are found under the names the verifier saves them by", () => {
    expect(hasScreenshot(paths, ID, "phone")).toBe(false);
    expect(readScreenshot(paths, ID, "phone")).toBeNull();
    put(path.join(paths.screenshots, `${ID}.png`), picture);
    expect(hasScreenshot(paths, ID, "phone")).toBe(true);
    expect(hasScreenshot(paths, ID, "desktop")).toBe(false);
    expect(readScreenshot(paths, ID, "phone")?.equals(picture)).toBe(true);
    expect(readScreenshot(paths, ID, "desktop")).toBeNull();

    const desktop = Buffer.concat([picture, Buffer.from(" of a desktop")]);
    put(path.join(paths.screenshots, `${ID}-desktop.png`), desktop);
    expect(hasScreenshot(paths, ID, "desktop")).toBe(true);
    expect(readScreenshot(paths, ID, "desktop")?.equals(desktop)).toBe(true);
  });

  it("are not read through a link, from a file that is no PNG, or for an id that is not one", () => {
    put(path.join(scratch, "real.png"), picture);
    symlinkSync(path.join(scratch, "real.png"), path.join(paths.screenshots, `${ID}.png`));
    expect(hasScreenshot(paths, ID, "phone")).toBe(false);
    expect(readScreenshot(paths, ID, "phone")).toBeNull();

    put(path.join(paths.screenshots, `${ID}-desktop.png`), "<html>not a picture</html>");
    expect(readScreenshot(paths, ID, "desktop")).toBeNull();
    // And the page is not told there is a picture to ask for: it used to be, and showed a broken one.
    expect(hasScreenshot(paths, ID, "desktop")).toBe(false);

    put(path.join(paths.root, "x.png"), picture);
    expect(readScreenshot(paths, "../x", "phone")).toBeNull();
    expect(hasScreenshot(paths, "../x", "phone")).toBe(false);
  });
});

describe("is there a picture to show?", () => {
  const picture = Buffer.concat([PNG_START, Buffer.from("an invented picture")]);
  const shot = (): string => path.join(paths.screenshots, `${ID}.png`);

  // `hasScreenshot` used to go by the name alone. The page then asked for a picture that `readScreenshot` refused.
  it("says yes only for a file that `readScreenshot` will hand out", () => {
    const cases: Array<[string, string | Buffer, boolean]> = [
      ["a picture", picture, true],
      ["an empty file", "", false],
      ["a text file", "this is not a picture\n", false],
      ["half a signature", PNG_START.subarray(0, 7), false],
      ["only a signature", PNG_START, true],
    ];
    for (const [what, content, expected] of cases) {
      put(shot(), content);
      expect(hasScreenshot(paths, ID, "phone"), what).toBe(expected);
      expect(readScreenshot(paths, ID, "phone") !== null, what).toBe(expected);
    }
  });

  it("says no at once for a named pipe, a folder and a file that is too large to be handed out", () => {
    pipeAt(shot());
    expect(atOnce(() => hasScreenshot(paths, ID, "phone"))).toBe(false);
    rmSync(shot());
    mkdirSync(shot());
    expect(hasScreenshot(paths, ID, "phone")).toBe(false);
    const file = put(path.join(scratch, "big.png"), Buffer.concat([PNG_START, Buffer.alloc(200)]));
    expect(isPng(file, 207)).toBe(false);
    expect(isPng(file, 208)).toBe(true);
    expect(readPng(file, 207)).toBeNull();
  });

  it("is not fooled by a file that is swapped for a link between the look and the open", () => {
    const file = put(path.join(scratch, "shot.png"), picture);
    const other = put(path.join(scratch, "other.png"), picture);
    const swap = (): void => {
      rmSync(file);
      symlinkSync(other, file);
    };
    expect(isPng(file, 1024, swap)).toBe(false);
  });
});

describe("the files SQLite is handed", () => {
  it("are looked at first: a named pipe, a folder or a device under the name, or beside it, would keep SQLite waiting", () => {
    const db = put(path.join(scratch, "overnight.db"), "a plain file");
    expect(sqliteWouldWait(db)).toBe(false);
    expect(sqliteWouldWait(path.join(scratch, "not there"))).toBe(false);
    for (const ending of ["-wal", "-shm", "-journal"]) {
      pipeAt(db + ending);
      expect(atOnce(() => sqliteWouldWait(db)), ending).toBe(true);
      rmSync(db + ending);
    }
    expect(sqliteWouldWait(db)).toBe(false);
    expect(atOnce(() => sqliteWouldWait(pipeAt(path.join(scratch, "pipe"))))).toBe(true);
    expect(sqliteWouldWait(scratch)).toBe(true);
    expect(sqliteWouldWait("/dev/null")).toBe(true);
    // A link is followed, as SQLite follows it: to a plain file it is fine, to a pipe it is not.
    symlinkSync(db, path.join(scratch, "to-the-file"));
    symlinkSync(path.join(scratch, "pipe"), path.join(scratch, "to-the-pipe"));
    expect(sqliteWouldWait(path.join(scratch, "to-the-file"))).toBe(false);
    expect(atOnce(() => sqliteWouldWait(path.join(scratch, "to-the-pipe")))).toBe(true);
  });
});

describe("the files that go with one idea", () => {
  /** An invented idea as the pages see it. */
  function idea(state: DashIdea["state"], more: Partial<DashIdea> = {}): DashIdea {
    return {
      id: ID, state, title: "Packing Checklist", pitch: "Tick off what to pack.", quote: { shown: false, why: "none" }, hidden: false, confidence: 0.9,
      createdAt: "2026-10-09T18:00:00.000Z", updatedAt: "2026-10-10T13:00:00.000Z", askedAt: null, askExpiresAt: null, answeredAt: null, note: null, slug: null,
      buildBackend: null, buildStartedAt: null, builtAt: null, publishedUrl: null, publishedAt: null, deliveredAt: null, failureReason: null, failureNotifiedAt: null,
      rehearsal: false, buildStarts: 1, awaitingRetry: false, hasMorningTodo: false, hasFact: false, ...more,
    };
  }
  const picture = Buffer.concat([PNG_START, Buffer.from("an invented picture")]);

  beforeEach(() => {
    put(path.join(paths.ideas, ID, "brief.md"), "the brief");
    put(path.join(paths.workspaces, ID, "BUILD_NOTES.md"), "the notes");
    put(path.join(paths.workspaces, ID, "package.json"), "{}");
    put(path.join(paths.reports, `${ID}.json`), JSON.stringify({ ideaId: ID, confirmedLive: true, timings: { liveAfterMs: 26000 } }));
    put(path.join(paths.screenshots, `${ID}.png`), picture);
    put(path.join(paths.screenshots, `${ID}-desktop.png`), picture);
  });

  it("gives a delivered idea its report, brief, notes and both pictures", () => {
    const extras = collectIdeaExtras(paths, idea("delivered"), HOME, NOT_FILMING);
    expect(extras.report?.liveAfterMs).toBe(26000);
    expect(extras.brief).toEqual({ text: "the brief", cut: false });
    expect(extras.notes).toEqual({ text: "the notes", cut: false });
    expect(extras.shots).toEqual({ phone: true, desktop: true });
    expect(extras.marks).toBeNull();
  });

  it("says which pictures are there", () => {
    rmSync(path.join(paths.screenshots, `${ID}-desktop.png`));
    expect(collectIdeaExtras(paths, idea("published"), HOME, NOT_FILMING).shots).toEqual({ phone: true, desktop: false });
  });

  it("does not show an earlier try's report or pictures for an idea that is being built again", () => {
    for (const state of ["approved", "building", "built", "build_failed"] as const) {
      const extras = collectIdeaExtras(paths, idea(state), HOME, NOT_FILMING);
      expect(extras.report).toBeNull();
      expect(extras.shots).toEqual({ phone: false, desktop: false });
    }
    // A failed delivery wrote its report just now, but its pictures may be an earlier try's.
    const failed = collectIdeaExtras(paths, idea("publish_failed"), HOME, NOT_FILMING);
    expect(failed.report).not.toBeNull();
    expect(failed.shots).toEqual({ phone: false, desktop: false });
  });

  it("looks for the marks of a build only while it is building", () => {
    expect(collectIdeaExtras(paths, idea("building"), HOME, NOT_FILMING).marks).toEqual({ started: false, projectWritten: true, packagesInstalled: false, appBuilt: false, notesWritten: true });
    expect(collectIdeaExtras(paths, idea("built"), HOME, NOT_FILMING).marks).toBeNull();
  });

  it("does not send the build agent's notes while filming, even for an idea whose quote is let through", () => {
    const extras = collectIdeaExtras(paths, idea("delivered"), HOME, { on: true, showQuoteFor: new Set([ID]) });
    expect(extras.notes).toBe("filming");
    expect(extras.brief).toEqual({ text: "the brief", cut: false });
    expect(JSON.stringify(extras)).not.toContain("the notes");
  });

  it("gives no brief for an idea whose title is hidden", () => {
    expect(collectIdeaExtras(paths, idea("asked", { hidden: true }), HOME, { on: true, showQuoteFor: new Set() }).brief).toBeNull();
  });
});
