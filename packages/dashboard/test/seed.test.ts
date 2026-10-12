// SYNTHETIC: every word in this test is made up. The "real data folder" in it is a pretend one, in a temporary folder.
//
// The demo's invented data, and above all where it may be written. src/demo is the only part of
// the dashboard that writes, so the refusals tested here (a folder that is not empty; anything
// that is, is inside, or holds the real data folder, also through a link) are the safety of the
// whole package. No test here looks inside the real ~/.overnight: $HOME is pointed at a temporary
// folder, and the one check against the real home folder compares names only.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { renderBrief } from "@overnight/builder";
import { buildLockFile, deliverLockFile, listenLockFile, lockHeld, REHEARSAL_APPROVED_NOTE, REHEARSAL_ASKED_NOTE, REHEARSAL_CONVERSATION_KEY, REHEARSAL_NOTE, rehearsalFolderRefusal, sameOrInsideFolder as cliSameOrInsideFolder, takeLock } from "@overnight/cli";
import { BUILD_STOPPED_REASON, canTransition, dataPaths, finishedBuildDir, IDEA_STATES, isBuildAwaitingRetry, localDateKey, localDayBounds, parseConfig, previousLocalTime, Store } from "@overnight/core";
import type { Config, Idea } from "@overnight/core";
import { reportPath } from "@overnight/deliver";
import type { DeliverReport } from "@overnight/deliver";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CANNOT_TELL,
  DEMO_MARKER_FILE,
  DEMO_MARKER_TEXT,
  DemoFolderError,
  folderInside,
  IS_THE_REAL_FOLDER,
  LEADS_OUTSIDE,
  moveInside,
  NOT_A_DEMO_FOLDER,
  NOT_A_FOLDER,
  NOT_A_FULL_PATH,
  NOT_EMPTY,
  NOT_THERE,
  realDataFolders,
  realFolderProblem,
  writeInside,
} from "../src/demo/folder.ts";
import { folderAncestry, FolderUnknownError, foldersTouch, locateFolder, sameOrInsideFolder, statPath } from "../src/demo/folder-identity.ts";
import type { StatPath } from "../src/demo/folder-identity.ts";
import { LOG_MARK } from "../src/demo/night-files.ts";
import { pretendRunning } from "../src/demo/pretend-running.ts";
import type { DemoReport } from "../src/demo/night-files.ts";
import { drawPng, MAX_PNG_SIDE, PNG_SIGNATURE } from "../src/demo/png.ts";
import type { Rgb } from "../src/demo/png.ts";
import {
  DEMO_CLOCK,
  DEMO_IDEA_KEYS,
  DEMO_STATES,
  HOSTILE_LINKS,
  HOSTILE_STRINGS,
  LINE_SENTINEL,
  NOTES_SENTINEL,
  PITCH_SENTINEL,
  QUOTE_SENTINEL,
  REHEARSAL_NOTES,
  seedDemoData,
  TITLE_SENTINEL,
} from "../src/demo/seed.ts";
import type { DemoIdeaKey } from "../src/demo/seed.ts";
import { LOG_MESSAGES, matchLogMessage } from "../src/log-messages.ts";
import type { LogMessageKey } from "../src/log-messages.ts";
import { IDEA_ID } from "../src/types.ts";

/** 1:02 AM in Boise on an invented night, far from any clock change. */
const NOW = new Date("2026-10-18T07:02:00.000Z");
const SOURCES = fileURLToPath(new URL("../src/demo/", import.meta.url));

const made: string[] = [];
/** A new temporary folder, by its real path (on a Mac the temporary folder is reached through a link). */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "overnight-dashboard-demo-")));
  made.push(dir);
  return dir;
}
/** A new, empty folder to seed, inside a parent of its own. */
function emptyFolder(): string {
  const dir = path.join(scratch(), "data");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function configFor(dataDir: string): Config {
  return parseConfig({ OVERNIGHT_DATA_DIR: dataDir, PAUSED: "false" });
}

afterEach(() => {
  vi.unstubAllEnvs();
});
// Removed when this file is done, not after each test: some tests share one seeded folder.
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Everything under a folder: name, kind, size and who may read it. Links are named, never followed. */
function listing(dir: string, prefix = ""): string[] {
  const rows: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const info = lstatSync(full);
    const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : info.isFile() ? "file" : "other";
    rows.push(`${prefix}${name} ${kind} ${kind === "file" ? info.size : ""} ${(info.mode & 0o777).toString(8)}`);
    if (kind === "folder") rows.push(...listing(full, `${prefix}${name}/`));
  }
  return rows;
}

/** The message a refusal carries, or "no refusal". */
function refusal(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    return error instanceof DemoFolderError ? error.message : `another error: ${String(error)}`;
  }
  return "no refusal";
}

// ---------- the picture writer ----------

/** Read a PNG back: its size, its pieces by name, and a way to ask for a pixel. Checks every checksum on the way. */
function readPng(png: Buffer): { width: number; height: number; names: string[]; pixel(x: number, y: number): number[] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const names: string[] = [];
  const pieces = new Map<string, Buffer>();
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const name = png.toString("latin1", offset + 4, offset + 8);
    expect(png.readUInt32BE(offset + 8 + length), `the checksum of ${name}`).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    names.push(name);
    pieces.set(name, png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const header = pieces.get("IHDR") ?? Buffer.alloc(13);
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  expect([...header.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
  const pixels = inflateSync(pieces.get("IDAT") ?? Buffer.alloc(0));
  const stride = 1 + width * 3;
  expect(pixels.length).toBe(stride * height);
  for (let y = 0; y < height; y += 1) expect(pixels[y * stride]).toBe(0);
  return { width, height, names, pixel: (x, y) => [...pixels.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)] };
}

describe("drawPng", () => {
  const paper: Rgb = [246, 244, 238];
  const blue: Rgb = [79, 110, 247];
  const sun: Rgb = [245, 181, 38];

  it("writes a picture a PNG reader can read: the signature, a header, the pixels and an end, each with its checksum", () => {
    const png = readPng(drawPng(7, 5, paper, []));
    expect(png.names).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([png.width, png.height]).toEqual([7, 5]);
    expect(png.pixel(0, 0)).toEqual(paper);
    expect(png.pixel(6, 4)).toEqual(paper);
    expect([...PNG_SIGNATURE]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("paints rectangles on the background, a later one over an earlier one", () => {
    const png = readPng(
      drawPng(10, 8, paper, [
        { x: 2, y: 1, w: 4, h: 3, rgb: blue },
        { x: 4, y: 2, w: 4, h: 4, rgb: sun },
      ]),
    );
    expect(png.pixel(2, 1)).toEqual(blue);
    expect(png.pixel(5, 1)).toEqual(blue);
    expect(png.pixel(3, 3)).toEqual(blue);
    expect(png.pixel(4, 2)).toEqual(sun);
    expect(png.pixel(7, 5)).toEqual(sun);
    // Just outside each edge it is still paper.
    for (const [x, y] of [[1, 1], [6, 1], [2, 0], [3, 4], [8, 3], [4, 6]] as const) expect(png.pixel(x, y), `${x},${y}`).toEqual(paper);
  });

  it("cuts a rectangle at the edge of the picture, and never lets it run on into the next line", () => {
    const png = readPng(
      drawPng(6, 4, paper, [
        { x: -3, y: -2, w: 5, h: 3, rgb: blue },
        { x: 4, y: 3, w: 50, h: 50, rgb: sun },
        { x: 20, y: 20, w: 5, h: 5, rgb: sun },
        { x: 2, y: 2, w: 0, h: 9, rgb: sun },
        { x: 2, y: 2, w: -4, h: 2, rgb: sun },
      ]),
    );
    expect(png.pixel(0, 0)).toEqual(blue);
    expect(png.pixel(1, 0)).toEqual(blue);
    expect(png.pixel(2, 0)).toEqual(paper);
    expect(png.pixel(0, 1)).toEqual(paper);
    expect(png.pixel(4, 3)).toEqual(sun);
    expect(png.pixel(5, 3)).toEqual(sun);
    expect(png.pixel(3, 3)).toEqual(paper);
    expect(png.pixel(0, 3)).toEqual(paper);
    expect(png.pixel(2, 2)).toEqual(paper);
    // A rectangle that is wholly below the picture, or wholly to one side, paints nothing and breaks nothing.
    const missed = readPng(
      drawPng(6, 4, paper, [
        { x: 2, y: 20, w: 2, h: 2, rgb: sun },
        { x: 2, y: -9, w: 2, h: 3, rgb: sun },
        { x: -9, y: 1, w: 3, h: 2, rgb: sun },
        { x: 1, y: 1, w: 5000, h: 5000, rgb: blue },
      ]),
    );
    expect([missed.pixel(2, 0), missed.pixel(0, 1), missed.pixel(0, 3), missed.pixel(1, 1), missed.pixel(2, 3), missed.pixel(5, 3)]).toEqual([paper, paper, paper, blue, blue, blue]);
  });

  it("refuses a size or a colour that makes no picture", () => {
    for (const [width, height] of [[0, 5], [5, 0], [-1, 5], [1.5, 5], [5, Number.NaN], [MAX_PNG_SIDE + 1, 5], [5, MAX_PNG_SIDE + 1]] as const) {
      expect(() => drawPng(width, height, paper, []), `${width} by ${height}`).toThrow(RangeError);
    }
    expect(() => drawPng(4, 4, [0, 0, 256], [])).toThrow(RangeError);
    expect(() => drawPng(4, 4, [0, -1, 0], [])).toThrow(RangeError);
    expect(() => drawPng(4, 4, [0, 0.5, 0], [])).toThrow(RangeError);
    expect(() => drawPng(4, 4, [0, 0] as unknown as Rgb, [])).toThrow(RangeError);
    expect(() => drawPng(4, 4, paper, [{ x: 0, y: 0, w: 2, h: 2, rgb: [0, 0, 300] }])).toThrow(RangeError);
    expect(() => drawPng(4, 4, paper, [{ x: 0.5, y: 0, w: 2, h: 2, rgb: blue }])).toThrow(RangeError);
    expect(() => drawPng(4, 4, paper, [{ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 2, rgb: blue }])).toThrow(RangeError);
    expect(readPng(drawPng(MAX_PNG_SIDE, 1, paper, [])).width).toBe(MAX_PNG_SIDE);
  });
});

// ---------- where the demo may write ----------

/** A pretend home folder with a pretend real data folder in it, and $HOME pointed at it. */
function pretendHome(): { home: string; real: string; before: () => string[] } {
  const home = path.join(scratch(), "home");
  const real = path.join(home, ".overnight");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  vi.stubEnv("HOME", home);
  const start = listing(home);
  return { home, real, before: () => start };
}

describe("which folder a path is, by the disk's numbers for it", () => {
  /**
   * An invented disk with no links on it. Each folder has a number; `aliases` are other full names
   * for a folder (as /System/Volumes/Data/... is on a Mac), which no rule about spelling finds.
   */
  function inventedDisk(folders: readonly string[], files: readonly string[], aliases: Readonly<Record<string, string>>): StatPath {
    const numbers = new Map<string, bigint>();
    [...folders, ...files].forEach((name, index) => numbers.set(name, BigInt(index + 2)));
    const canonical = (target: string): string => {
      let at = "/";
      for (const name of target.split("/")) {
        if (name === "" || name === ".") continue;
        at = name === ".." ? path.dirname(at) : path.join(at, name);
        at = aliases[at] ?? at;
      }
      return at;
    };
    return (target) => {
      const at = canonical(target);
      if (at === "/") return { dev: 1n, ino: 1n, isFolder: true };
      const ino = numbers.get(at);
      return ino === undefined ? null : { dev: 1n, ino, isFolder: folders.includes(at) };
    };
  }
  const disk = inventedDisk(["/home", "/home/sam", "/home/sam/.overnight", "/home/sam/.overnight/logs", "/home/sam/demo", "/other"], ["/home/sam/a-file"], { "/other/names/data": "/home/sam/.overnight", "/by-number/7": "/home/sam/.overnight/logs" });

  it("takes two names for one folder as that folder, and what is inside it as inside it", () => {
    const real = "/home/sam/.overnight";
    for (const folder of [real, "/other/names/data", "/other/names/data/logs", "/other/names/data/new/deeper", "/by-number/7", "/by-number/7/new", "/home/sam/.overnight/logs/.."]) {
      expect(sameOrInsideFolder(folder, real, disk), folder).toBe(true);
      expect(foldersTouch(folder, real, disk), folder).toBe(true);
    }
    for (const folder of ["/home/sam/demo", "/home/sam/demo/.overnight", "/home/sam/.overnight-demo", "/other", "/other/names", "/home/sam/a-file"]) {
      expect(sameOrInsideFolder(folder, real, disk), folder).toBe(false);
    }
    // Round it: the folders above it, by any name, hold it.
    for (const folder of ["/", "/home", "/home/sam"]) expect(foldersTouch(folder, real, disk), folder).toBe(true);
    for (const folder of ["/home/sam/demo", "/other", "/other/new"]) expect(foldersTouch(folder, real, disk), folder).toBe(false);
  });

  it("places a folder that is not made yet by the nearest folder that is there, and by the names below it without regard to capitals", () => {
    expect(locateFolder("/home/sam/new/deeper", disk)).toEqual({ anchor: "/home/sam", anchorId: { dev: 1n, ino: 3n }, rest: ["new", "deeper"] });
    // Something that is there but is no folder is placed by the folder it sits in.
    expect(locateFolder("/home/sam/a-file", disk)).toEqual({ anchor: "/home/sam", anchorId: { dev: 1n, ino: 3n }, rest: ["a-file"] });
    expect(folderAncestry("/by-number/7", disk).map((id) => id.ino)).toEqual([5n, 4n, 3n, 2n, 1n]);
    const notMadeYet = "/home/sam/demo/.overnight";
    expect(sameOrInsideFolder("/home/sam/demo/.OVERNIGHT/Inside", notMadeYet, disk)).toBe(true);
    expect(sameOrInsideFolder("/home/sam/demo/.overnight-2", notMadeYet, disk)).toBe(false);
    expect(sameOrInsideFolder("/home/sam/demo", notMadeYet, disk)).toBe(false);
    expect(foldersTouch("/home/sam/demo", notMadeYet, disk)).toBe(true);
  });

  it("never answers no for something it could not look at, and never names the path in its error", () => {
    const refusing: StatPath = (target) => {
      if (target.includes("locked")) throw new FolderUnknownError("EACCES");
      return disk(target);
    };
    expect(() => sameOrInsideFolder("/home/sam/locked/demo", "/home/sam/.overnight", refusing)).toThrow(FolderUnknownError);
    const parent = scratch();
    symlinkSync(path.join(parent, "round"), path.join(parent, "round"));
    let message = "";
    try {
      statPath(path.join(parent, "round", "x"));
    } catch (error) {
      message = String(error);
    }
    expect(message).toBe("FolderUnknownError: it is not known which folder that is (ELOOP)");
    expect(statPath(path.join(parent, "nothing-here"))).toBeNull();
    expect(statPath(parent)?.isFolder).toBe(true);
  });

  it("gives the same answers as the cli's own check of a rehearsal folder, which this one is written after", () => {
    const top = scratch();
    mkdirSync(path.join(top, "home", ".overnight", "inside"), { recursive: true });
    mkdirSync(path.join(top, "beside"));
    symlinkSync(path.join(top, "home", ".overnight"), path.join(top, "to-the-folder"));
    symlinkSync(path.join(top, "home"), path.join(top, "to-home"));
    const real = path.join(top, "home", ".overnight");
    const spellings = [real, path.join(real, "inside"), path.join(real, "new", "deeper"), path.join(top, "to-the-folder"), path.join(top, "to-the-folder", "inside"), path.join(top, "to-home", ".overnight"), path.join(top, "to-home", ".OVERNIGHT", "new"), path.join(top, "home"), path.join(top, "beside"), path.join(top, "beside", "new"), top];
    if (process.platform === "darwin") {
      const numbers = statSync(real, { bigint: true });
      spellings.push(path.join("/System/Volumes/Data", real), path.join("/System/Volumes/Data", real, "inside"), `/.vol/${numbers.dev}/${numbers.ino}`, `/.vol/${numbers.dev}/${numbers.ino}/inside/new`);
    }
    for (const folder of spellings) {
      for (const parent of [real, path.join(top, "home", "not-made-yet"), path.join(top, "beside")]) {
        expect(sameOrInsideFolder(folder, parent), `${folder} in ${parent}`).toBe(cliSameOrInsideFolder(folder, parent));
      }
    }
  });
});

describe("where the demo may write", () => {
  it("knows the real data folder by both names of the home folder: what $HOME says and what the system says", () => {
    const { real } = pretendHome();
    const systemHome = userInfo().homedir;
    expect(realDataFolders()).toEqual([real, path.join(systemHome, ".overnight")]);
    // Names only: nothing on disk is looked at for a plain match, so this never touches the real folder.
    expect(realFolderProblem(path.join(systemHome, ".overnight"))).toBe(IS_THE_REAL_FOLDER);
    expect(realFolderProblem(path.join(systemHome, ".overnight", "demo"))).toBe(IS_THE_REAL_FOLDER);
    expect(realFolderProblem(path.join(systemHome, ".OVERNIGHT", "Demo"))).toBe(IS_THE_REAL_FOLDER);
    expect(realFolderProblem(systemHome)).toBe(IS_THE_REAL_FOLDER);
    expect(realFolderProblem("/")).toBe(IS_THE_REAL_FOLDER);
  });

  it("refuses the real data folder itself, even when it is empty", () => {
    const { home, real, before } = pretendHome();
    expect(refusal(() => seedDemoData(real, { now: NOW, config: configFor(real) }))).toBe(IS_THE_REAL_FOLDER);
    expect(refusal(() => seedDemoData(`${real}/`, { now: NOW, config: configFor(real) }))).toBe(IS_THE_REAL_FOLDER);
    expect(refusal(() => seedDemoData(path.join(home, "x", "..", ".overnight"), { now: NOW, config: configFor(real) }))).toBe(IS_THE_REAL_FOLDER);
    expect(listing(home)).toEqual(before());
  });

  it("refuses an empty folder inside the real data folder, however deep", () => {
    const { home, real } = pretendHome();
    const inside = path.join(real, "tmp", "demo");
    mkdirSync(inside, { recursive: true });
    const before = listing(home);
    expect(refusal(() => seedDemoData(inside, { now: NOW, config: configFor(inside) }))).toBe(IS_THE_REAL_FOLDER);
    expect(refusal(() => seedDemoData(path.join(real, "not-made-yet"), { now: NOW, config: configFor(inside) }))).toBe(IS_THE_REAL_FOLDER);
    expect(listing(home)).toEqual(before);
  });

  it("refuses it under other capitals, which on a Mac name the same folder", () => {
    const { home, before } = pretendHome();
    expect(refusal(() => seedDemoData(path.join(home, ".OverNight"), { now: NOW, config: configFor(home) }))).toBe(IS_THE_REAL_FOLDER);
    expect(refusal(() => seedDemoData(path.join(home.toUpperCase(), ".overnight", "Demo"), { now: NOW, config: configFor(home) }))).toBe(IS_THE_REAL_FOLDER);
    expect(listing(home)).toEqual(before());
  });

  it("goes by the names alone where nothing is there to look at, capitals and all", () => {
    const real = ["/no-such-place/Home/.overnight"];
    for (const dir of ["/no-such-place/Home/.overnight", "/no-such-place/home/.OVERNIGHT", "/NO-SUCH-PLACE/HOME/.Overnight/Demo/deeper", "/no-such-place/home", "/no-such-place"]) expect(realFolderProblem(dir, real), dir).toBe(IS_THE_REAL_FOLDER);
    for (const dir of ["/no-such-place/home/.overnight-demo", "/no-such-place/home/overnight", "/no-such-place/home/demo/.overnight", "/no-such-place-2"]) expect(realFolderProblem(dir, real), dir).toBeNull();
  });

  it("refuses a path that is written as inside the real data folder, even where a link there leads out of it", () => {
    const { home, real } = pretendHome();
    const outside = path.join(scratch(), "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(real, "way-out"));
    const before = listing(home);
    expect(refusal(() => seedDemoData(path.join(real, "way-out"), { now: NOW, config: configFor(outside) }))).toBe(IS_THE_REAL_FOLDER);
    expect(readdirSync(outside)).toEqual([]);
    expect(listing(home)).toEqual(before);
  });

  it("refuses a folder that holds the real data folder, even an empty one where the real folder is not made yet", () => {
    const home = path.join(scratch(), "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    expect(readdirSync(home)).toEqual([]);
    expect(refusal(() => seedDemoData(home, { now: NOW, config: configFor(home) }))).toBe(IS_THE_REAL_FOLDER);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a link that leads to the real data folder, or into it", () => {
    const { home, real, before } = pretendHome();
    mkdirSync(path.join(real, "inside"));
    const start = listing(home);
    expect(start).not.toEqual(before());
    const links = scratch();
    symlinkSync(real, path.join(links, "to-the-folder"));
    symlinkSync(path.join(real, "inside"), path.join(links, "into-the-folder"));
    // A link in the middle of the path: the name after it looks harmless as written.
    symlinkSync(home, path.join(links, "to-home"));
    symlinkSync(path.join(links, "to-the-folder"), path.join(links, "to-a-link"));
    for (const dir of [path.join(links, "to-the-folder"), path.join(links, "into-the-folder"), path.join(links, "to-home", ".overnight", "inside"), path.join(links, "to-a-link"), path.join(links, "to-a-link", "inside")]) {
      expect(realFolderProblem(dir), dir).toBe(IS_THE_REAL_FOLDER);
      expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(links) })), dir).toBe(IS_THE_REAL_FOLDER);
    }
    expect(listing(home)).toEqual(start);
  });

  it("refuses the folder the real data folder really is, when ~/.overnight is itself a link", () => {
    const home = path.join(scratch(), "home");
    mkdirSync(home);
    const elsewhere = path.join(scratch(), "moved-data");
    mkdirSync(path.join(elsewhere, "inside"), { recursive: true });
    symlinkSync(elsewhere, path.join(home, ".overnight"));
    vi.stubEnv("HOME", home);
    const before = listing(elsewhere);
    for (const dir of [elsewhere, path.join(elsewhere, "inside"), path.join(home, ".overnight"), path.join(home, ".overnight", "inside")]) {
      expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(elsewhere) })), dir).toBe(IS_THE_REAL_FOLDER);
    }
    expect(listing(elsewhere)).toEqual(before);
    // A folder beside it is still fine.
    const beside = path.join(path.dirname(elsewhere), "beside");
    mkdirSync(beside);
    expect(refusal(() => seedDemoData(beside, { now: NOW, config: configFor(beside) }))).toBe("no refusal");
  });

  // Neither of these names is a link, and neither is spelled like the real folder, so comparing
  // names (as written, or with links followed) let them through: the seed filled an empty folder
  // inside the real data folder when it was named this way.
  it.runIf(process.platform === "darwin")("refuses the real data folder by the Mac's other two names for it: under /System/Volumes/Data, and as /.vol/<device>/<file number>", () => {
    const { home, real } = pretendHome();
    mkdirSync(path.join(real, "inside"));
    const before = listing(home);
    const numbers = statSync(real, { bigint: true });
    const inner = statSync(path.join(real, "inside"), { bigint: true });
    const homeNumbers = statSync(home, { bigint: true });
    const underData = path.join("/System/Volumes/Data", real);
    const byNumber = `/.vol/${numbers.dev}/${numbers.ino}`;
    const dirs = [underData, path.join(underData, "inside"), path.join(underData, "not-made-yet", "deeper"), byNumber, `${byNumber}/inside`, `${byNumber}/not-made-yet`, `/.vol/${inner.dev}/${inner.ino}`];
    // Where the disk takes capitals as the same name (a Mac's usual disk), so does the check.
    if (existsSync(path.join(home, ".OVERNIGHT"))) dirs.push(path.join("/System/Volumes/Data", home, ".OVERNIGHT"), path.join("/System/Volumes/Data", home.toUpperCase(), ".Overnight", "Inside"));
    for (const dir of dirs) {
      expect(realFolderProblem(dir), dir).toBe(IS_THE_REAL_FOLDER);
      expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(dir) })), dir).toBe(IS_THE_REAL_FOLDER);
    }
    // A folder that holds the real one is refused by these names too.
    expect(realFolderProblem(path.join("/System/Volumes/Data", home))).toBe(IS_THE_REAL_FOLDER);
    expect(realFolderProblem(`/.vol/${homeNumbers.dev}/${homeNumbers.ino}`)).toBe(IS_THE_REAL_FOLDER);
    expect(listing(home)).toEqual(before);

    // The same on a Mac where the real data folder has never been made: it is known by the home folder above it.
    rmSync(real, { recursive: true });
    for (const dir of [path.join("/System/Volumes/Data", home, ".overnight"), `/.vol/${homeNumbers.dev}/${homeNumbers.ino}/.overnight`, `/.vol/${homeNumbers.dev}/${homeNumbers.ino}/.Overnight/inside`]) {
      expect(realFolderProblem(dir), dir).toBe(IS_THE_REAL_FOLDER);
    }
    expect(readdirSync(home)).toEqual([]);

    // A folder that has nothing to do with it is still fine by either name, and the seed fills it.
    expect(realFolderProblem(`/.vol/${homeNumbers.dev}/${homeNumbers.ino}/.overnight-demo`)).toBeNull();
    const own = emptyFolder();
    const ownUnderData = path.join("/System/Volumes/Data", own);
    expect(realFolderProblem(ownUnderData)).toBeNull();
    expect(refusal(() => seedDemoData(ownUnderData, { now: NOW, config: configFor(ownUnderData) }))).toBe("no refusal");
    expect(readdirSync(own)).toContain("overnight.db");
  });

  it.runIf(process.platform === "darwin")("refuses the folder ~/.overnight leads to by those names as well, when ~/.overnight is itself a link", () => {
    const home = path.join(scratch(), "home");
    mkdirSync(home);
    const elsewhere = path.join(scratch(), "moved-data");
    mkdirSync(path.join(elsewhere, "inside"), { recursive: true });
    symlinkSync(elsewhere, path.join(home, ".overnight"));
    vi.stubEnv("HOME", home);
    const before = listing(elsewhere);
    const numbers = statSync(elsewhere, { bigint: true });
    for (const dir of [path.join("/System/Volumes/Data", elsewhere), path.join("/System/Volumes/Data", elsewhere, "inside"), `/.vol/${numbers.dev}/${numbers.ino}`, `/.vol/${numbers.dev}/${numbers.ino}/inside`]) {
      expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(elsewhere) })), dir).toBe(IS_THE_REAL_FOLDER);
    }
    expect(listing(elsewhere)).toEqual(before);
  });

  it("refuses, rather than guesses, when the disk cannot say which folder a path is", () => {
    pretendHome();
    // A link that leads round to itself: nothing can be asked of it.
    const parent = scratch();
    symlinkSync(path.join(parent, "round"), path.join(parent, "round"));
    const before = listing(parent);
    expect(realFolderProblem(path.join(parent, "round", "demo"))).toBe(CANNOT_TELL);
    expect(refusal(() => seedDemoData(path.join(parent, "round", "demo"), { now: NOW, config: configFor(parent) }))).toBe(CANNOT_TELL);
    expect(CANNOT_TELL).not.toContain(parent);
    expect(listing(parent)).toEqual(before);
  });

  it("refuses a folder that is not empty, and leaves it as it was", () => {
    pretendHome();
    const dir = emptyFolder();
    writeFileSync(path.join(dir, ".DS_Store"), "x");
    const before = listing(dir);
    expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(dir) }))).toBe(NOT_EMPTY);
    expect(listing(dir)).toEqual(before);

    const withFolder = emptyFolder();
    mkdirSync(path.join(withFolder, "logs"));
    expect(refusal(() => seedDemoData(withFolder, { now: NOW, config: configFor(withFolder) }))).toBe(NOT_EMPTY);
    expect(readdirSync(withFolder)).toEqual(["logs"]);
  });

  it("refuses to seed the same folder twice", () => {
    pretendHome();
    const dir = emptyFolder();
    seedDemoData(dir, { now: NOW, config: configFor(dir) });
    const before = listing(dir);
    expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(dir) }))).toBe(NOT_EMPTY);
    expect(listing(dir)).toEqual(before);
  });

  it("refuses a folder that is not there, a file, and a path that is not a full one, and makes nothing", () => {
    pretendHome();
    const parent = scratch();
    expect(refusal(() => seedDemoData(path.join(parent, "missing"), { now: NOW, config: configFor(parent) }))).toBe(NOT_THERE);
    writeFileSync(path.join(parent, "a-file"), "");
    expect(refusal(() => seedDemoData(path.join(parent, "a-file"), { now: NOW, config: configFor(parent) }))).toBe(NOT_A_FOLDER);
    symlinkSync(path.join(parent, "nowhere"), path.join(parent, "dangling"));
    expect(refusal(() => seedDemoData(path.join(parent, "dangling"), { now: NOW, config: configFor(parent) }))).toBe(NOT_THERE);
    for (const dir of ["", "data", "./data", "~/demo", "data\0"]) expect(refusal(() => seedDemoData(dir, { now: NOW, config: configFor(parent) })), dir).toBe(NOT_A_FULL_PATH);
    expect(refusal(() => seedDemoData(undefined as unknown as string, { now: NOW, config: configFor(parent) }))).toBe(NOT_A_FULL_PATH);
    expect(readdirSync(parent).sort()).toEqual(["a-file", "dangling"]);
    expect(existsSync("data")).toBe(false);
  });

  it("refuses a time that is not one, before it writes anything", () => {
    pretendHome();
    const dir = emptyFolder();
    expect(() => seedDemoData(dir, { now: new Date(Number.NaN), config: configFor(dir) })).toThrow(TypeError);
    expect(() => seedDemoData(dir, { now: "2026-10-18" as unknown as Date, config: configFor(dir) })).toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("follows a link to an empty folder of its own, and writes there", () => {
    pretendHome();
    const target = emptyFolder();
    const link = path.join(scratch(), "link");
    symlinkSync(target, link);
    seedDemoData(link, { now: NOW, config: configFor(link) });
    expect(readdirSync(target)).toContain("overnight.db");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("never names the folder it was given in a refusal", () => {
    const { real } = pretendHome();
    const message = refusal(() => seedDemoData(real, { now: NOW, config: configFor(real) }));
    expect(message).not.toContain(real);
    expect(message).toContain("~/.overnight");
  });

  it("writes below the folder one name at a time, and refuses a link or a file standing where a folder should be", () => {
    const root = emptyFolder();
    const outside = scratch();
    expect(writeInside(root, ["a", "b", "note.txt"], "hello")).toBe(path.join(root, "a", "b", "note.txt"));
    expect(readFileSync(path.join(root, "a", "b", "note.txt"), "utf8")).toBe("hello");
    expect(lstatSync(path.join(root, "a")).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(root, "a", "b", "note.txt")).mode & 0o777).toBe(0o600);

    symlinkSync(outside, path.join(root, "link"));
    expect(refusal(() => writeInside(root, ["link", "note.txt"], "x"))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => writeInside(root, ["link", "deeper", "note.txt"], "x"))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => folderInside(root, "link", "deeper"))).toBe(LEADS_OUTSIDE);
    // A link where the file itself should be: not written through, whether it points at something or at nothing.
    writeFileSync(path.join(outside, "victim.txt"), "untouched");
    symlinkSync(path.join(outside, "victim.txt"), path.join(root, "a", "to-a-file"));
    symlinkSync(path.join(outside, "not-there.txt"), path.join(root, "a", "to-nothing"));
    expect(refusal(() => writeInside(root, ["a", "to-a-file"], "x"))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => writeInside(root, ["a", "to-nothing"], "x"))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => writeInside(root, ["a", "b", "note.txt", "under-a-file"], "x"))).toBe(LEADS_OUTSIDE);
    for (const name of ["..", ".", "", "x/y", "x\\y", "x\0"]) {
      expect(refusal(() => writeInside(root, [name, "note.txt"], "x")), name).toBe(LEADS_OUTSIDE);
      expect(refusal(() => writeInside(root, ["a", name], "x")), name).toBe(LEADS_OUTSIDE);
    }
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
    expect(readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("untouched");
    expect(readdirSync(path.dirname(root))).toEqual(["data"]);
  });

  it("moves a folder only between two places inside, and never onto something that is already there", () => {
    const root = emptyFolder();
    const outside = scratch();
    writeInside(root, ["workspaces", "one", "brief.md"], "x");
    moveInside(root, ["workspaces", "one"], ["built", "one"]);
    expect(readdirSync(path.join(root, "built", "one"))).toEqual(["brief.md"]);
    expect(readdirSync(path.join(root, "workspaces"))).toEqual([]);

    writeInside(root, ["workspaces", "one", "brief.md"], "second");
    expect(refusal(() => moveInside(root, ["workspaces", "one"], ["built", "one"]))).toBe(LEADS_OUTSIDE);
    symlinkSync(path.join(outside, "nowhere"), path.join(root, "built", "dangling"));
    expect(refusal(() => moveInside(root, ["workspaces", "one"], ["built", "dangling"]))).toBe(LEADS_OUTSIDE);
    symlinkSync(outside, path.join(root, "away"));
    expect(refusal(() => moveInside(root, ["workspaces", "one"], ["away", "one"]))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => moveInside(root, ["away"], ["built", "two"]))).toBe(LEADS_OUTSIDE);
    expect(refusal(() => moveInside(root, ["workspaces", "missing"], ["built", "two"]))).toBe(LEADS_OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(path.join(root, "workspaces", "one", "brief.md"), "utf8")).toBe("second");
  });
});

// ---------- the scene ----------

interface Seeded {
  dir: string;
  config: Config;
  ids: Record<DemoIdeaKey, string>;
  ideas: Record<DemoIdeaKey, Idea>;
  store: Store;
}

/** Seed a new folder and read every idea back with the real Store. The caller closes `store`. */
function seeded(options: { hostile?: boolean; sentinels?: boolean } = {}, dir = emptyFolder()): Seeded {
  const config = configFor(dir);
  const ids = seedDemoData(dir, { now: NOW, config, ...options }).ideaIds;
  const store = new Store(path.join(dir, "overnight.db"));
  const ideas = Object.fromEntries(DEMO_IDEA_KEYS.map((key) => [key, store.getIdea(ids[key])])) as Record<DemoIdeaKey, Idea>;
  return { dir, config, ids, ideas, store };
}

function logLines(dir: string, log: "build" | "deliver"): Array<Record<string, unknown> & { at: string; level: string; name: string; message: string }> {
  return readFileSync(path.join(dir, "logs", `${log}.log`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown> & { at: string; level: string; name: string; message: string });
}

/** Every text file the seed wrote under a folder, as one string. */
function textUnder(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (lstatSync(full).isDirectory()) text += textUnder(full);
    else if (/\.(md|json|log|txt|html)$/.test(name)) text += readFileSync(full, "utf8");
  }
  return text;
}

describe("the demo's scene", () => {
  let scene: Seeded;
  beforeAll(() => {
    scene = seeded();
    return () => scene.store.close();
  });

  it("says on its first line that everything in it is made up", () => {
    expect(readFileSync(path.join(SOURCES, "seed.ts"), "utf8").split("\n")[0]).toBe("// SYNTHETIC data: every title, pitch, quote and line here is made up. None of it is Bee data.");
    for (const file of ["night-files.ts", "night-script.ts"]) expect(readFileSync(path.join(SOURCES, file), "utf8").split("\n")[0], file).toMatch(/^\/\/ SYNTHETIC data: .* made up\. None of it is Bee data\.$/);
    expect(readFileSync(path.join(scene.dir, DEMO_MARKER_FILE), "utf8")).toBe(DEMO_MARKER_TEXT);
    expect(DEMO_MARKER_TEXT.split("\n")[0]).toMatch(/^SYNTHETIC data: .*None of it is Bee data\.$/);
  });

  it("holds an idea in every one of the eleven states, each where the scene says", () => {
    expect(Object.keys(scene.ids)).toEqual(DEMO_IDEA_KEYS);
    for (const key of DEMO_IDEA_KEYS) {
      expect(scene.ids[key], key).toMatch(IDEA_ID);
      expect(scene.ideas[key].state, key).toBe(DEMO_STATES[key]);
    }
    expect(new Set(Object.values(scene.ids)).size).toBe(DEMO_IDEA_KEYS.length);
    expect([...new Set(DEMO_IDEA_KEYS.map((key) => scene.ideas[key].state))].sort()).toEqual([...IDEA_STATES].sort());
    expect(scene.store.listIdeas()).toHaveLength(DEMO_IDEA_KEYS.length);
  });

  it("is a database the real Store opens, marked as invented, with asking and building switched on", () => {
    expect(scene.store.getValue("dashboard_demo")).toBe("true");
    expect(scene.store.isPaused(true)).toBe(false);
    expect(scene.store.countUtterances()).toBeGreaterThan(400);
  });

  it("reached every state by steps the state machine allows, in the order of the clock, and never after now", () => {
    for (const key of DEMO_IDEA_KEYS) {
      const events = scene.store.ideaEvents(scene.ids[key]);
      expect(events[0]?.fromState, key).toBeNull();
      expect(events[0]?.toState, key).toBe("heard");
      for (let i = 1; i < events.length; i += 1) {
        const [before, after] = [events[i - 1], events[i]];
        if (before === undefined || after === undefined) throw new Error("an event is missing");
        expect(after.fromState, `${key} step ${i}`).toBe(before.toState);
        expect(canTransition(before.toState, after.toState), `${key}: ${before.toState} to ${after.toState}`).toBe(true);
        expect(after.at >= before.at, `${key} step ${i} is not earlier than the one before`).toBe(true);
      }
      expect(events.at(-1)?.toState, key).toBe(scene.ideas[key].state);
      expect(events.every((event) => event.at <= NOW.toISOString()), key).toBe(true);
      expect(scene.ideas[key].updatedAt <= NOW.toISOString(), key).toBe(true);
    }
  });

  it("was written in the order things happened, like a real database", () => {
    const db = new Database(path.join(scene.dir, "overnight.db"), { readonly: true, fileMustExist: true });
    try {
      const inOrder = (rows: Array<{ at: string }>): boolean => rows.every((row, i) => i === 0 || row.at >= (rows[i - 1]?.at ?? ""));
      expect(inOrder(db.prepare("SELECT received_at AS at FROM utterances ORDER BY id").all() as Array<{ at: string }>)).toBe(true);
      expect(inOrder(db.prepare("SELECT at FROM idea_events ORDER BY id").all() as Array<{ at: string }>)).toBe(true);
      expect(inOrder(db.prepare("SELECT ran_at AS at FROM detector_runs ORDER BY id").all() as Array<{ at: string }>)).toBe(true);
      expect(inOrder(db.prepare("SELECT created_at AS at FROM ideas ORDER BY rowid").all() as Array<{ at: string }>)).toBe(true);
      // The newest line of all is the last one written: the page reads "last heard" from the last row.
      const last = db.prepare("SELECT received_at AS at FROM utterances ORDER BY id DESC LIMIT 1").get() as { at: string };
      expect(last.at).toBe(scene.store.newestUtteranceReceivedAt());
    } finally {
      db.close();
    }
  });

  it("tells tonight as the page shows it: Chore Wheel building for 72 seconds, Lunch Turns approved and next", () => {
    const { choreWheel, lunchTurns, recipeDoubler, plantWateringDays } = scene.ideas;
    expect(choreWheel.title).toBe("Chore Wheel");
    expect(choreWheel.quote).toBe("it would be cool if a wheel just picked who does the dishes");
    expect(choreWheel.buildBackend).toBe("kiro-crew");
    expect(NOW.getTime() - Date.parse(choreWheel.buildStartedAt ?? "")).toBe(72_000);
    expect(scene.store.ideaEvents(choreWheel.id).at(-1)?.at).toBe(choreWheel.buildStartedAt);
    expect(lunchTurns.title).toBe("Lunch Turns");
    expect(lunchTurns.note).toBe("ticked in Bee");

    // The line for tonight, as the real builder sorts it: oldest approval first, a second try in the same line.
    const waiting = [choreWheel, lunchTurns, recipeDoubler].map((idea) => idea.answeredAt ?? "");
    expect([...waiting].sort()).toEqual(waiting);
    expect(waiting.every((at) => at !== "")).toBe(true);
    const today = localDayBounds(NOW, scene.config.timeZone);
    expect(scene.store.countBuildsStartedBetween(today.start.toISOString(), today.end.toISOString())).toBe(1);

    // An ask made within an hour of the cutoff is still open, and runs until the next cutoff.
    expect(Date.parse(plantWateringDays.askExpiresAt ?? "")).toBeGreaterThan(NOW.getTime());
  });

  it("has one build that was stopped and waits for its second try, and one that failed and was told", () => {
    const { recipeDoubler, baleYieldCalculator, gameNightScores } = scene.ideas;
    expect(recipeDoubler.failureReason).toBe(BUILD_STOPPED_REASON);
    expect(isBuildAwaitingRetry(recipeDoubler, scene.store.countBuildStarts(recipeDoubler.id))).toBe(true);
    expect(baleYieldCalculator.failureReason).toBe(`Kiro Crew: the build ran past its time limit of ${scene.config.buildTimeoutMin} minutes. Kiro CLI: the builder reported that the build failed (its notes are in BUILD_NOTES.md in the workspace)`);
    expect(baleYieldCalculator.failureNotifiedAt).not.toBeNull();
    expect(isBuildAwaitingRetry(baleYieldCalculator, scene.store.countBuildStarts(baleYieldCalculator.id))).toBe(false);
    expect(gameNightScores.failureNotifiedAt).not.toBeNull();
    expect(scene.ideas.readingLog.buildBackend).toBe("kiro-cli");
    expect(scene.ideas.packingChecklist.note).toBe("built with Kiro Crew in 160 s");
    expect(scene.ideas.packingChecklist.factId).not.toBeNull();
    expect(scene.ideas.carpoolTextAlerts.note).toBe("needs more than a static web page");
  });

  it("counts a day as the page does: 214 lines in six conversations since 7:00 AM, three asks, six detector runs", () => {
    const dayStart = previousLocalTime(NOW, scene.config.deliverTime, scene.config.timeZone).at.toISOString();
    const db = new Database(path.join(scene.dir, "overnight.db"), { readonly: true, fileMustExist: true });
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM utterances WHERE spoken_at >= ?").get(dayStart) as { n: number }).n).toBe(214);
      const talks = db.prepare("SELECT COUNT(*) AS lines, SUM(detector_run_id IS NULL) AS waiting FROM utterances WHERE spoken_at >= ? GROUP BY conversation_key ORDER BY MAX(spoken_at)").all(dayStart) as Array<{ lines: number; waiting: number }>;
      expect(talks.map((talk) => talk.lines)).toEqual([38, 3, 64, 58, 9, 42]);
      expect(talks.every((talk) => talk.waiting === 0)).toBe(true);
      const runs = db.prepare("SELECT outcome, reason FROM detector_runs WHERE ran_at >= ? ORDER BY id").all(dayStart) as Array<{ outcome: string; reason: string | null }>;
      expect(runs.map((run) => run.outcome)).toEqual(["failed", "skipped", "idea", "idea", "not_idea", "idea"]);
      // The exact words the listener records: the page tells "too short" from any other skip by them.
      expect(runs[1]?.reason).toBe("too short");
      // A conversation that short has fewer words than the listener would send to the detector.
      const words = db.prepare("SELECT text FROM utterances WHERE conversation_key = (SELECT conversation_key FROM detector_runs WHERE reason = 'too short')").all() as Array<{ text: string }>;
      expect(words.flatMap((row) => row.text.split(/\s+/)).length).toBeLessThan(6);
    } finally {
      db.close();
    }
    expect(scene.store.countAsksBetween(dayStart, NOW.toISOString())).toBe(3);
    // The last line was heard a little over two and a half hours before now.
    expect(NOW.getTime() - Date.parse(scene.store.newestUtteranceReceivedAt() ?? "")).toBeGreaterThan(2 * 3_600_000);
  });

  it("takes each quote from the conversation it was heard in: one of its own lines, word for word", () => {
    const db = new Database(path.join(scene.dir, "overnight.db"), { readonly: true, fileMustExist: true });
    try {
      for (const key of DEMO_IDEA_KEYS) {
        const idea = scene.ideas[key];
        if (idea.conversationKey === REHEARSAL_CONVERSATION_KEY) continue;
        const said = db.prepare("SELECT COUNT(*) AS n FROM utterances WHERE conversation_key = ? AND text = ? AND detector_run_id = ?").get(idea.conversationKey, idea.quote, idea.detectorRunId) as { n: number };
        expect(said.n, key).toBe(1);
        expect(idea.quote.split(/\s+/).length, key).toBeLessThanOrEqual(25);
        expect(idea.title.split(/\s+/).length, key).toBeLessThanOrEqual(6);
      }
    } finally {
      db.close();
    }
  });

  it("keeps to the limits the real programs keep: no more asks in a day than the setting, and room for a build tonight", () => {
    const asksByDay = new Map<string, number>();
    for (const key of DEMO_IDEA_KEYS) {
      if (scene.ideas[key].conversationKey === REHEARSAL_CONVERSATION_KEY) continue;
      for (const event of scene.store.ideaEvents(scene.ids[key])) {
        if (event.toState !== "asked") continue;
        const day = localDateKey(new Date(event.at), scene.config.timeZone);
        asksByDay.set(day, (asksByDay.get(day) ?? 0) + 1);
      }
    }
    expect(Math.max(...asksByDay.values())).toBe(scene.config.maxAsksPerDay);
    expect([...asksByDay.values()].every((asks) => asks <= scene.config.maxAsksPerDay)).toBe(true);
  });

  it("makes its rehearsal ideas the way `overnight rehearse new` does, so the commands that talk to Bee refuse the folder", () => {
    expect(REHEARSAL_NOTES).toEqual({ heard: REHEARSAL_NOTE, asked: REHEARSAL_ASKED_NOTE, approved: REHEARSAL_APPROVED_NOTE });
    for (const key of ["practiceDiceRoller", "practiceTallyCounter"] as const) {
      const idea = scene.ideas[key];
      expect(idea.conversationKey, key).toBe(REHEARSAL_CONVERSATION_KEY);
      expect(idea.quote, key).toBe("");
      const events = scene.store.ideaEvents(idea.id);
      expect(events.slice(0, 3).map((event) => event.note), key).toEqual([REHEARSAL_NOTE, REHEARSAL_ASKED_NOTE, REHEARSAL_APPROVED_NOTE]);
      // Dated the day before it was made: ten minutes between "heard" and "approved", as the command leaves it.
      expect(Date.parse(events[2]?.at ?? "") - Date.parse(events[0]?.at ?? ""), key).toBe(600_000);
    }
    expect(DEMO_IDEA_KEYS.filter((key) => scene.ideas[key].conversationKey === REHEARSAL_CONVERSATION_KEY)).toEqual(["practiceDiceRoller", "practiceTallyCounter"]);
    for (const command of ["listen", "deliver", "build-now"]) expect(rehearsalFolderRefusal(scene.store, command), command).toContain("Not started: this data folder holds 2 rehearsal ideas");
  });

  it("gives every published idea a link that can never be a real site", () => {
    const published = DEMO_IDEA_KEYS.filter((key) => scene.ideas[key].publishedUrl !== null);
    expect(published).toEqual(["practiceDiceRoller", "readingLog", "packingChecklist"]);
    for (const key of published) {
      const url = new URL(scene.ideas[key].publishedUrl ?? "");
      expect(url.protocol, key).toBe("https:");
      expect(url.hostname, key).toBe("example.invalid");
    }
    expect(scene.ideas.packingChecklist.publishedUrl).toBe("https://example.invalid/overnight-apps/packing-checklist/");
    expect(textUnder(scene.dir)).not.toMatch(/https?:\/\/(?!example\.invalid\/)/);
  });

  it("draws two pictures for every idea whose morning check got that far, where the verifier saves them", () => {
    const paths = dataPaths(scene.dir);
    const checked: DemoIdeaKey[] = ["practiceDiceRoller", "readingLog", "gameNightScores", "packingChecklist"];
    for (const key of checked) {
      const phone = readPng(readFileSync(path.join(paths.screenshots, `${scene.ids[key]}.png`)));
      const desktop = readPng(readFileSync(path.join(paths.screenshots, `${scene.ids[key]}-desktop.png`)));
      expect([phone.width, phone.height], key).toEqual([390, 844]);
      expect([desktop.width, desktop.height], key).toEqual([1280, 800]);
      // Not one flat colour: there is something drawn on it.
      expect(phone.pixel(195, 30), key).not.toEqual(phone.pixel(195, 500));
    }
    expect(readdirSync(paths.screenshots)).toHaveLength(checked.length * 2);
    for (const name of readdirSync(paths.screenshots)) expect(readFileSync(path.join(paths.screenshots, name)).subarray(0, 8).equals(PNG_SIGNATURE), name).toBe(true);
  });

  it("leaves each build's files where the real programs keep them: the real brief, the notes in the finished build", () => {
    const paths = dataPaths(scene.dir);
    expect([paths.logs, paths.ideas, paths.workspaces, paths.built, paths.reports, paths.screenshots, paths.database]).toEqual(["logs", "ideas", "workspaces", "built", "reports", "screenshots", "overnight.db"].map((name) => path.join(scene.dir, name)));
    const builtOnce: DemoIdeaKey[] = DEMO_IDEA_KEYS.filter((key) => scene.ideas[key].slug !== null);
    expect(builtOnce.sort()).toEqual(["baleYieldCalculator", "choreWheel", "gameNightScores", "packingChecklist", "practiceDiceRoller", "practiceTallyCounter", "readingLog", "recipeDoubler"]);
    for (const key of builtOnce) {
      const idea = scene.ideas[key];
      expect(readFileSync(path.join(paths.ideas, idea.id, "brief.md"), "utf8"), key).toBe(renderBrief({ id: idea.id, title: idea.title, pitch: idea.pitch }));
    }
    expect(readdirSync(paths.ideas).sort()).toEqual(builtOnce.map((key) => scene.ids[key]).sort());

    // A finished build has been moved to built/<id>; one that never finished is still in workspaces/<id>.
    const finished: DemoIdeaKey[] = ["practiceDiceRoller", "practiceTallyCounter", "readingLog", "gameNightScores", "packingChecklist"];
    expect(readdirSync(paths.built).sort()).toEqual(finished.map((key) => scene.ids[key]).sort());
    for (const key of finished) {
      const folder = finishedBuildDir(paths, scene.ids[key]);
      expect(folder, key).toBe(path.join(paths.built, scene.ids[key]));
      expect(readdirSync(folder).sort(), key).toEqual(["BUILD_NOTES.md", "BUILD_STATUS.json", "brief.md", "dist", "node_modules", "package.json"]);
      const notes = readFileSync(path.join(folder, "BUILD_NOTES.md"), "utf8").split("\n");
      expect(notes[0], key).toBe(`# Build notes: ${scene.ideas[key].title}`);
      expect(notes[2], key).toBe("(Invented for the Overnight dashboard's demo. No build agent wrote this, and nothing was built.)");
      expect(JSON.parse(readFileSync(path.join(folder, "BUILD_STATUS.json"), "utf8")), key).toEqual({ status: "built", build_ok: true, smoke_test: "passed" });
      expect(existsSync(path.join(paths.workspaces, scene.ids[key])), key).toBe(false);
    }
    // 72 seconds into tonight's build: the agent has started and written the project, and no more.
    expect(readdirSync(path.join(paths.workspaces, scene.ids.choreWheel)).sort()).toEqual(["BUILD_STATUS.json", "brief.md", "package.json"]);
    expect(finishedBuildDir(paths, scene.ids.choreWheel)).toBe(path.join(paths.workspaces, scene.ids.choreWheel));
    // The build that failed says so in its notes, in the workspace, where its failure reason points.
    expect(readFileSync(path.join(paths.workspaces, scene.ids.baleYieldCalculator, "BUILD_NOTES.md"), "utf8")).toContain("Status: failed.");
    expect(JSON.parse(readFileSync(path.join(paths.workspaces, scene.ids.baleYieldCalculator, "BUILD_STATUS.json"), "utf8"))).toMatchObject({ status: "failed" });
    // A second builder never works on top of the first one's files: those were moved aside.
    expect(readdirSync(paths.workspaces).filter((name) => name.includes(".old-")).map((name) => name.replace(/\.old-\d{8}T\d{6}Z$/, "")).sort()).toEqual([scene.ids.baleYieldCalculator, scene.ids.readingLog].sort());
    expect(textUnder(scene.dir)).not.toContain("SENTINEL");
  });

  it("writes each morning's report in the deliver step's own shape, at the deliver step's own place", () => {
    const paths = dataPaths(scene.dir);
    // The two shapes are held together by the compiler: each must fit where the other is wanted.
    const fits = (report: DemoReport): DeliverReport => report;
    const fitsBack = (report: DeliverReport): DemoReport => report;
    expect(typeof fits).toBe(typeof fitsBack);

    const reported: DemoIdeaKey[] = ["practiceDiceRoller", "readingLog", "gameNightScores", "packingChecklist"];
    expect(readdirSync(paths.reports).sort()).toEqual(reported.map((key) => `${scene.ids[key]}.json`).sort());
    for (const key of reported) {
      const idea = scene.ideas[key];
      const report = fits(JSON.parse(readFileSync(reportPath(paths, idea.id), "utf8")) as DemoReport);
      expect(Object.keys(report), key).toEqual(["ideaId", "slug", "title", "pitch", "backend", "state", "ok", "url", "confirmedLive", "failureReason", "note", "checks", "timings", "sizes", "screenshots", "morningTodoId", "factId", "startedAt", "publishedAt", "deliveredAt", "updatedAt"]);
      // The report is the idea as the database has it.
      expect({ ...report, checks: 0, timings: 0, sizes: 0, screenshots: 0, startedAt: 0, updatedAt: 0, confirmedLive: 0 }, key).toEqual({
        ideaId: idea.id, slug: idea.slug, title: idea.title, pitch: idea.pitch, backend: idea.buildBackend, state: idea.state, ok: idea.state !== "publish_failed", url: idea.publishedUrl,
        failureReason: idea.failureReason, note: idea.note, morningTodoId: idea.morningTodoId, factId: idea.factId, publishedAt: idea.publishedAt, deliveredAt: idea.deliveredAt,
        checks: 0, timings: 0, sizes: 0, screenshots: 0, startedAt: 0, updatedAt: 0, confirmedLive: 0,
      });
      expect(report.screenshots, key).toEqual({ phone: path.join(paths.screenshots, `${idea.id}.png`), desktop: path.join(paths.screenshots, `${idea.id}-desktop.png`) });
      expect(report.sizes.distFiles, key).toBe(report.checks.distFiles);
    }
    const packing = JSON.parse(readFileSync(reportPath(paths, scene.ids.packingChecklist), "utf8")) as DemoReport;
    expect(packing).toMatchObject({ confirmedLive: true, timings: { verifyMs: 6600, publishMs: 28_500, liveAfterMs: 26_000 }, sizes: { distFiles: 3, distBytes: 5940 }, checks: { installOk: true, buildOk: true, contractOk: true, appSmokeOk: true } });
    const gameNight = JSON.parse(readFileSync(reportPath(paths, scene.ids.gameNightScores), "utf8")) as DemoReport;
    expect(gameNight).toMatchObject({ ok: false, confirmedLive: null, timings: { verifyMs: 9200, publishMs: null, liveAfterMs: null }, checks: { installOk: true, buildOk: true, contractOk: true, failedStep: "app-smoke" } });
    // The step it failed at was never passed, so the report does not say it was.
    expect(gameNight.checks).not.toHaveProperty("appSmokeOk");
  });

  it("writes every line of the two logs with core's logger, oldest first, and only words the dashboard's table knows", () => {
    const known = (log: "build" | "deliver"): LogMessageKey[] => (Object.keys(LOG_MESSAGES) as LogMessageKey[]).filter((key) => LOG_MESSAGES[key].log === log);
    // The lines of nights that went wrong in ways this scene does not tell.
    const notInTheScene: LogMessageKey[] = ["nightPaused", "signInWaiting", "signedOut", "signInUnknown", "sandboxFailed", "sealedPartly", "notSealed", "buildSlept", "deliverSlept", "notSeenLive"];
    for (const log of ["build", "deliver"] as const) {
      const lines = logLines(scene.dir, log);
      expect(lines[0], log).toEqual({ at: lines[0]?.at, level: "info", name: "demo", message: LOG_MARK });
      expect(lines.slice(1).every((line) => line.name === log), log).toBe(true);
      expect(lines.every((line, i) => i === 0 || line.at >= (lines[i - 1]?.at ?? "")), `${log}.log is in the order of the clock`).toBe(true);
      expect(lines.every((line) => line.at <= NOW.toISOString()), log).toBe(true);
      const seen = new Set(lines.map((line) => matchLogMessage(log, line.message)));
      expect([...seen].filter((key) => key !== null).sort(), log).toEqual(known(log).filter((key) => !notInTheScene.includes(key)).sort());
      // A few lines the dashboard does not know are there too, as in a real log: it must pass them by.
      expect(seen.has(null), log).toBe(true);
    }
    // As loud as the real programs log them: a failure is a warning, the rest is information.
    const levels = new Map([...logLines(scene.dir, "build"), ...logLines(scene.dir, "deliver")].map((line) => [line.message, line.level]));
    expect(["build failed; trying the other backend once", "build failed", "a built app did not pass verification"].map((message) => levels.get(message))).toEqual(["warn", "warn", "warn"]);
    expect(["build started", "build finished", "verified a built app", "told the wearer about a built app"].map((message) => levels.get(message))).toEqual(["info", "info", "info", "info"]);
    // The lines that name a command are written the way the cli writes them.
    const messages = new Set([...logLines(scene.dir, "build"), ...logLines(scene.dir, "deliver")].map((line) => line.message));
    for (const message of ["overnight rehearse: build starting", "overnight rehearse: build finished", "overnight build-now: build starting", "overnight build-now: build finished", "overnight rehearse: deliver starting", "overnight rehearse: deliver finished"]) expect(messages.has(message), message).toBe(true);
    expect([...messages].find((message) => message.startsWith("build sandbox check passed"))).toMatch(/^build sandbox check passed: the Keychain, Bee, .* cannot write where our programs are$/);
  });

  it("logs tonight's build as it stands at 1:02 AM: started, sign-in fresh, sandbox checked, the agent at work", () => {
    const tonight = logLines(scene.dir, "build").slice(-6);
    const secondsBeforeNow = tonight.map((line) => (NOW.getTime() - Date.parse(line.at)) / 1000);
    expect(tonight.map((line) => matchLogMessage("build", line.message))).toEqual(["buildRunStart", "nightStart", "ideaStart", "signInReady", "sandboxPassed", "crewStarted"]);
    expect(secondsBeforeNow).toEqual([72.4, 72.1, 72, 70.8, 63.6, 62.5]);
    // The start line carries the folder's path, as the real one does. The dashboard must drop it.
    expect(tonight[0]).toMatchObject({ dataDir: scene.dir, primary: "kiro-crew", fallback: "kiro-cli" });
    expect(tonight[1]).toMatchObject({ approved: 2, retries: 1, limit: scene.config.maxBuildsPerNight, building: 2 });
    expect(tonight[2]).toMatchObject({ ideaId: scene.ids.choreWheel, backend: "kiro-crew" });
    expect(tonight[3]).toMatchObject({ minutesLeft: 47 });
    expect(tonight[4]).toMatchObject({ ms: 7100 });
    expect(tonight[5]).toMatchObject({ ideaId: scene.ids.choreWheel });
  });

  it("logs last night as the Nights page tells it: one built in 2 min 40 s for 4.59 credits, one failed, one delivered, one told", () => {
    const build = logLines(scene.dir, "build");
    const deliver = logLines(scene.dir, "deliver");
    const about = (lines: typeof build, key: DemoIdeaKey) => lines.filter((line) => line.ideaId === scene.ids[key]).map((line) => matchLogMessage(line.name === "build" ? "build" : "deliver", line.message));
    expect(build.find((line) => line.message === "build finished" && line.ideaId === scene.ids.packingChecklist)).toMatchObject({ backend: "kiro-crew", seconds: 160, credits: 4.59 });
    expect(about(build, "baleYieldCalculator")).toEqual(["ideaStart", "crewStarted", "fallback", "cliStarted", "ideaFailed"]);
    expect(about(build, "readingLog")).toEqual(["ideaStart", "crewStarted", "fallback", "cliStarted", "ideaBuilt", "sealed"]);
    // The second builder gives no credits figure, so its line has none.
    expect(build.find((line) => line.message === "build finished" && line.ideaId === scene.ids.readingLog)).not.toHaveProperty("credits");
    expect(about(build, "recipeDoubler")).toEqual(["handRunStart", "ideaStart", "crewStarted", "ideaFailed", "handRunEnd"]);
    expect(about(deliver, "packingChecklist")).toEqual(["verified", "pushed", "live", null, "told", "fact"]);
    expect(deliver.find((line) => line.message === "verified a built app" && line.ideaId === scene.ids.packingChecklist)).toMatchObject({ files: 3, bytes: 5940, ms: 6600 });
    expect(deliver.find((line) => line.message === "the new version is live" && line.ideaId === scene.ids.packingChecklist)).toMatchObject({ liveAfterMs: 26_000 });
    expect(about(deliver, "baleYieldCalculator")).toEqual(["toldFailure"]);
    expect(about(deliver, "gameNightScores")).toEqual(["notVerified", null, "toldFailure"]);
    expect(about(deliver, "practiceDiceRoller")).toEqual(["handDeliverStart", "verified", "pushed", "live", null, "handDeliverEnd"]);
    expect(about(deliver, "practiceTallyCounter")).toEqual(["handDeliverStart", "handDeliverEnd"]);
    // Each log line about an idea's change of state carries the time of that change.
    expect(build.find((line) => line.message === "build finished" && line.ideaId === scene.ids.packingChecklist)?.at).toBe(scene.ideas.packingChecklist.builtAt);
    expect(deliver.find((line) => line.message === "told the wearer about a built app" && line.ideaId === scene.ids.packingChecklist)?.at).toBe(scene.ideas.packingChecklist.deliveredAt);
    expect(deliver.find((line) => line.message === "the new version is live" && line.ideaId === scene.ids.readingLog)?.at).toBe(scene.ideas.readingLog.publishedAt);
  });

  it("says of every finished build that it was moved out of the build jobs' reach, right after it was built", () => {
    // The builder's own two lines, in its order (builder, night.ts): "build finished", then where the build was put.
    const build = logLines(scene.dir, "build");
    const moved = "finished build moved out of the builders' reach";
    expect(matchLogMessage("build", moved)).toBe("sealed");
    const finished = build.filter((line) => line.message === "build finished");
    expect(finished.length).toBeGreaterThanOrEqual(5);
    for (const line of finished) {
      const next = build[build.indexOf(line) + 1];
      expect(next, String(line.ideaId)).toMatchObject({ level: "info", name: "build", message: moved, ideaId: line.ideaId, at: line.at });
      expect(next?.filesMadeAnew, String(line.ideaId)).toBeGreaterThan(0);
      // And the folder is where the line says: among the finished builds, under the idea's own id.
      expect(finishedBuildDir(dataPaths(scene.dir), String(line.ideaId))).toBe(path.join(scene.dir, "built", String(line.ideaId)));
    }
    // A build that did not finish was moved nowhere, and no line says it was.
    expect(build.filter((line) => line.message === moved)).toHaveLength(finished.length);
    for (const key of ["baleYieldCalculator", "recipeDoubler", "choreWheel"] as const) expect(existsSync(path.join(scene.dir, "built", scene.ids[key])), key).toBe(false);
  });

  it("is the same scene every time, apart from the ids", () => {
    const again = seeded();
    try {
      const told = (s: Seeded) => DEMO_IDEA_KEYS.map((key) => ({ ...s.ideas[key], id: key, conversationKey: "", events: s.store.ideaEvents(s.ids[key]).map((event) => ({ ...event, ideaId: key })) }));
      expect(told(again)).toEqual(told(scene));
      const withoutIds = (dir: string, ids: Record<DemoIdeaKey, string>) => DEMO_IDEA_KEYS.reduce((text, key) => text.replaceAll(ids[key], key), readFileSync(path.join(dir, "logs", "build.log"), "utf8")).replaceAll(dir, "");
      expect(withoutIds(again.dir, again.ids)).toBe(withoutIds(scene.dir, scene.ids));
    } finally {
      again.store.close();
    }
  });

  it("moves with the time it is told from", () => {
    const later = new Date(NOW.getTime() + 5 * 3_600_000 + 17_000);
    const dir = emptyFolder();
    const ids = seedDemoData(dir, { now: later, config: configFor(dir) }).ideaIds;
    const store = new Store(path.join(dir, "overnight.db"));
    try {
      for (const key of DEMO_IDEA_KEYS) {
        const [here, there] = [store.getIdea(ids[key]), scene.ideas[key]];
        expect(Date.parse(here?.updatedAt ?? "") - Date.parse(there.updatedAt), key).toBe(later.getTime() - NOW.getTime());
        expect(Date.parse(here?.createdAt ?? "") - Date.parse(there.createdAt), key).toBe(later.getTime() - NOW.getTime());
      }
    } finally {
      store.close();
    }
    expect(DEMO_CLOCK).toBe("01:02");
  });
});

describe("every file the seed writes", () => {
  it("is inside the folder it was handed: nothing beside it, nothing in the home folder, nothing where the settings point", () => {
    const { home, before } = pretendHome();
    const parent = scratch();
    const dir = path.join(parent, "data");
    mkdirSync(dir, { mode: 0o700 });
    // The settings name a different folder. A seed that went by them would write there.
    const settingsFolder = path.join(scratch(), "where-the-settings-point");
    mkdirSync(settingsFolder);
    const config = configFor(settingsFolder);
    expect(config.dataDir).toBe(settingsFolder);
    const here = listing(process.cwd());

    seedDemoData(dir, { now: NOW, config });

    expect(readdirSync(parent)).toEqual(["data"]);
    expect(readdirSync(settingsFolder)).toEqual([]);
    expect(listing(home)).toEqual(before());
    expect(listing(process.cwd())).toEqual(here);
    expect(readdirSync(dir).sort()).toEqual([DEMO_MARKER_FILE, "built", "ideas", "logs", "overnight.db", "reports", "screenshots", "workspaces"]);
  });

  it("is a plain file or a folder, private to the user, with no link among them and no database left open", () => {
    const { dir, store } = seeded();
    store.close();
    const rows = listing(dir);
    expect(rows.length).toBeGreaterThan(60);
    for (const row of rows) {
      const [name, kind, , mode] = row.split(" ");
      expect(kind === "file" || kind === "folder", row).toBe(true);
      expect(mode, row).toBe(kind === "file" ? "600" : "700");
      expect(name, row).not.toMatch(/-(wal|shm|journal)$/);
    }
  });

  it("cannot be read by anyone else even when the folder it was handed could be", () => {
    const dir = emptyFolder();
    chmodSync(dir, 0o755);
    seedDemoData(dir, { now: NOW, config: configFor(dir) });
    for (const row of listing(dir)) expect(row.endsWith(row.includes(" file ") ? " 600" : " 700"), row).toBe(true);
  });
});

describe("the seed's two test options", () => {
  it("with sentinels: marks every quote, every heard line, every notes file, and the title and pitch of every idea nobody approved", () => {
    const { dir, ideas, store } = seeded({ sentinels: true });
    try {
      const notApproved: DemoIdeaKey[] = ["coinFlipDecider", "stretchBreakBell", "carpoolTextAlerts", "plantWateringDays"];
      expect(DEMO_IDEA_KEYS.filter((key) => ["heard", "asked", "rejected", "expired"].includes(DEMO_STATES[key]))).toEqual(notApproved);
      DEMO_IDEA_KEYS.forEach((key, place) => {
        const idea = ideas[key];
        const number = place + 1;
        // A rehearsal idea was never said by anyone, so it has no quote to mark.
        if (key.startsWith("practice")) expect(idea.quote, key).toBe("");
        else expect(idea.quote, key).toMatch(new RegExp(`^${QUOTE_SENTINEL}${number} \\S`));
        if (notApproved.includes(key)) {
          expect(idea.title, key).toMatch(new RegExp(`^${TITLE_SENTINEL}${number} \\S`));
          expect(idea.pitch, key).toMatch(new RegExp(`^${PITCH_SENTINEL}${number} \\S`));
        } else {
          expect(`${idea.title} ${idea.pitch}`, key).not.toContain("SENTINEL");
        }
        expect(`${idea.note} ${idea.failureReason} ${idea.slug}`, key).not.toContain("SENTINEL");
      });

      const db = new Database(path.join(dir, "overnight.db"), { readonly: true, fileMustExist: true });
      try {
        const lines = (db.prepare("SELECT text FROM utterances ORDER BY id").all() as Array<{ text: string }>).map((row) => row.text);
        expect(lines.length).toBe(store.countUtterances());
        lines.forEach((line, i) => expect(line.startsWith(`${LINE_SENTINEL}${i + 1} `), `line ${i + 1}`).toBe(true));
      } finally {
        db.close();
      }

      const paths = dataPaths(dir);
      const notes = [paths.built, paths.workspaces].flatMap((folder) => readdirSync(folder).map((name) => path.join(folder, name, "BUILD_NOTES.md"))).filter((file) => existsSync(file));
      expect(notes).toHaveLength(6);
      for (const file of notes) expect(readFileSync(file, "utf8"), file).toContain(`\n${NOTES_SENTINEL}\n`);
      // No quote and no heard line is copied into a log, a report or a brief.
      const elsewhere = textUnder(paths.logs) + textUnder(paths.reports) + textUnder(paths.ideas);
      expect(elsewhere).not.toContain(QUOTE_SENTINEL);
      expect(elsewhere).not.toContain(LINE_SENTINEL);
      expect(elsewhere).not.toContain(NOTES_SENTINEL);
    } finally {
      store.close();
    }
  });

  it("with hostile: ends every free text with the attack strings, and still tells the whole scene", () => {
    expect(HOSTILE_STRINGS).toEqual(["<xss-probe>", '" data-xss-probe="1', "'><img src=x onerror=1>", "</script>", "‮desrever‬", "W".repeat(300)]);
    const { dir, ids, ideas, store } = seeded({ hostile: true });
    try {
      const carriesAll = (text: string | null): boolean => HOSTILE_STRINGS.every((attack) => (text ?? "").includes(attack));
      for (const key of DEMO_IDEA_KEYS) {
        const idea = ideas[key];
        expect(idea.state, key).toBe(DEMO_STATES[key]);
        for (const field of ["title", "pitch", "quote", "note"] as const) {
          // The one idea with no note is the one that is asked and not answered: the listener clears it.
          if (field === "note" && key === "plantWateringDays") expect(idea.note).toBeNull();
          else expect(carriesAll(idea[field]), `${key}.${field}`).toBe(true);
        }
        if (idea.slug !== null) expect(carriesAll(idea.slug) && carriesAll(idea.buildBackend), `${key}: folder name and builder`).toBe(true);
        for (const event of store.ideaEvents(idea.id)) if (event.note !== null) expect(carriesAll(event.note), `${key}: the note of "${event.toState}"`).toBe(true);
      }
      expect(carriesAll(ideas.baleYieldCalculator.failureReason)).toBe(true);
      expect(carriesAll(ideas.gameNightScores.failureReason)).toBe(true);
      // The one text that is kept word for word: the retry rule goes by it, and the page must still show that case.
      expect(ideas.recipeDoubler.failureReason).toBe(BUILD_STOPPED_REASON);
      expect(isBuildAwaitingRetry(ideas.recipeDoubler, store.countBuildStarts(ids.recipeDoubler))).toBe(true);

      expect(ideas.packingChecklist.publishedUrl).toBe("javascript:alert(1)");
      expect(DEMO_IDEA_KEYS.filter((key) => ideas[key].publishedUrl !== null).map((key) => [key, ideas[key].publishedUrl])).toEqual([
        ["practiceDiceRoller", HOSTILE_LINKS.practiceDiceRoller],
        ["readingLog", HOSTILE_LINKS.readingLog],
        ["packingChecklist", HOSTILE_LINKS.packingChecklist],
      ]);

      const db = new Database(path.join(dir, "overnight.db"), { readonly: true, fileMustExist: true });
      try {
        expect((db.prepare("SELECT text FROM utterances").all() as Array<{ text: string }>).every((row) => carriesAll(row.text))).toBe(true);
        // The two reasons the page goes by stay as the listener writes them; any other is free text.
        expect((db.prepare("SELECT reason FROM detector_runs WHERE outcome = 'skipped'").all() as Array<{ reason: string }>).map((row) => row.reason)).toEqual(["too short"]);
        expect((db.prepare("SELECT reason FROM detector_runs WHERE outcome = 'failed'").all() as Array<{ reason: string }>).every((row) => carriesAll(row.reason))).toBe(true);
      } finally {
        db.close();
      }

      const paths = dataPaths(dir);
      expect(carriesAll(readFileSync(path.join(finishedBuildDir(paths, ids.packingChecklist), "BUILD_NOTES.md"), "utf8"))).toBe(true);
      expect(readFileSync(path.join(paths.ideas, ids.packingChecklist, "brief.md"), "utf8")).toContain("<xss-probe>");
      const report = JSON.parse(readFileSync(reportPath(paths, ids.gameNightScores), "utf8")) as DemoReport;
      expect(carriesAll(String(report.checks.failedStep)) && carriesAll(report.title) && carriesAll(report.failureReason)).toBe(true);

      // In the logs: free text where real lines have it, a step's name, a reason for skipping, and an idea "id" that is markup.
      const build = logLines(dir, "build");
      const deliver = logLines(dir, "deliver");
      // (Both nightly runs that have ended carry the two lines.)
      expect(build.filter((line) => line.message === "build started" && line.ideaId === '"><xss-probe>')).toHaveLength(2);
      expect(build.filter((line) => line.message === "overnight build finished" && carriesAll(String(line.skipped)))).toHaveLength(2);
      expect(build.filter((line) => line.message === "build failed" && carriesAll(String(line.reason)))).toHaveLength(1);
      expect(deliver.filter((line) => line.message === "a built app did not pass verification" && carriesAll(String(line.step)))).toHaveLength(1);
      // Every line that names a real idea still names it plainly, so the night's ticks are all still there to draw.
      const real = new Set(Object.values(ids));
      expect(build.filter((line) => typeof line.ideaId === "string" && !real.has(line.ideaId))).toHaveLength(2);
      expect(deliver.every((line) => line.ideaId === undefined || real.has(String(line.ideaId)))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("without hostile: no attack string anywhere", () => {
    const { dir, ideas, store } = seeded();
    store.close();
    const everything = textUnder(dir) + JSON.stringify(ideas);
    for (const attack of HOSTILE_STRINGS) expect(everything.includes(attack), attack).toBe(false);
    expect(everything).not.toContain("javascript:");
  });

  it("takes both options at once", () => {
    const { ideas, store } = seeded({ hostile: true, sentinels: true });
    store.close();
    expect(ideas.choreWheel.quote.startsWith(`${QUOTE_SENTINEL}${DEMO_IDEA_KEYS.indexOf("choreWheel") + 1} `)).toBe(true);
    expect(ideas.choreWheel.quote).toContain("<xss-probe>");
    expect(ideas.plantWateringDays.title.startsWith(TITLE_SENTINEL)).toBe(true);
    expect(ideas.plantWateringDays.title).toContain("</script>");
  });
});

// ---------- looking as if the programs were running ----------

describe("pretendRunning", () => {
  /** Which of the three locks the real programs would find taken, asked the way `overnight status` asks. */
  function taken(dir: string): Record<"listener" | "build" | "deliver", boolean | null> {
    const paths = dataPaths(dir);
    return { listener: lockHeld(listenLockFile(paths)), build: lockHeld(buildLockFile(paths)), deliver: lockHeld(deliverLockFile(paths)) };
  }

  it("holds the very locks the real programs hold, until it is told to let go", () => {
    const { dir, store } = seeded();
    store.close();
    const database = readFileSync(path.join(dir, "overnight.db"));
    expect(taken(dir)).toEqual({ listener: false, build: false, deliver: false });

    const letGo = pretendRunning(dir, ["listener", "build"]);
    expect(taken(dir)).toEqual({ listener: true, build: true, deliver: false });
    // A real program that wants the lock is turned away, as by a real listener.
    expect(takeLock(listenLockFile(dataPaths(dir)), 0)).toBeNull();
    expect(readdirSync(dir).filter((name) => name.endsWith(".lock")).sort()).toEqual(["build.lock", "listen.lock"]);
    for (const name of ["build.lock", "listen.lock"]) expect(lstatSync(path.join(dir, name)).mode & 0o777, name).toBe(0o600);

    letGo();
    expect(taken(dir)).toEqual({ listener: false, build: false, deliver: false });
    const real = takeLock(listenLockFile(dataPaths(dir)), 0);
    expect(real).not.toBeNull();
    real?.();
    // Letting go twice is fine, and none of it touched the database.
    letGo();
    expect(readFileSync(path.join(dir, "overnight.db")).equals(database)).toBe(true);

    const all = pretendRunning(dir, ["deliver", "deliver", "listener", "build"]);
    expect(taken(dir)).toEqual({ listener: true, build: true, deliver: true });
    all();
  });

  it("never holds a lock in a folder the seed did not fill, least of all the real data folder", () => {
    const empty = emptyFolder();
    expect(refusal(() => pretendRunning(empty, ["listener"]))).toBe(NOT_A_DEMO_FOLDER);
    expect(readdirSync(empty)).toEqual([]);

    // A whole demo folder moved to where the real data folder is: refused, and the real listener could still start there.
    const { dir, store } = seeded();
    store.close();
    const home = path.join(scratch(), "home");
    mkdirSync(home);
    const real = path.join(home, ".overnight");
    mkdirSync(real);
    for (const name of readdirSync(dir)) writeFileSync(path.join(real, name), lstatSync(path.join(dir, name)).isFile() ? readFileSync(path.join(dir, name)) : "");
    vi.stubEnv("HOME", home);
    const link = path.join(scratch(), "link");
    symlinkSync(real, link);
    const before = listing(real);
    for (const folder of [real, link, path.join(home, ".OVERNIGHT")]) expect(refusal(() => pretendRunning(folder, ["listener", "build", "deliver"])), folder).toBe(IS_THE_REAL_FOLDER);
    expect(listing(real)).toEqual(before);
    const listener = takeLock(path.join(real, "listen.lock"), 0);
    expect(listener).not.toBeNull();
    listener?.();
  });

  it("holds all the locks it was asked for or none: one that is already taken, or not one of the three, leaves nothing held", () => {
    const { dir, store } = seeded();
    store.close();
    const paths = dataPaths(dir);
    const someoneElse = takeLock(buildLockFile(paths), 0);
    expect(someoneElse).not.toBeNull();
    expect(() => pretendRunning(dir, ["listener", "build"])).toThrow(/SQLITE_BUSY|locked/i);
    expect(lockHeld(listenLockFile(paths))).toBe(false);
    someoneElse?.();

    for (const name of ["dashboard", "constructor", "__proto__", "listen.lock", "../x"]) {
      expect(() => pretendRunning(dir, ["listener", name as "build"]), name).toThrow("and nothing else");
    }
    expect(taken(dir)).toEqual({ listener: false, build: false, deliver: false });
    expect(readdirSync(dir).filter((name) => name.includes("lock")).sort()).toEqual(["build.lock", "listen.lock"]);
  });

  it("does not open a link standing where a lock file should be", () => {
    const { dir, store } = seeded();
    store.close();
    const outside = scratch();
    symlinkSync(path.join(outside, "listen.lock"), path.join(dir, "listen.lock"));
    expect(refusal(() => pretendRunning(dir, ["build", "listener"]))).toBe(LEADS_OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);
    expect(lockHeld(buildLockFile(dataPaths(dir)))).toBe(false);
  });
});
