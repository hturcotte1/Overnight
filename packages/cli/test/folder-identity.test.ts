// Every folder in this file is made up: a small pretend disk for most tests, and a scratch folder
// under the system's temporary folder for the few that ask the real one. The real ~/.overnight is
// never looked at.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderAncestry, locateFolder, sameFolder, sameOrInsideFolder, statFolder } from "../src/folder-identity.ts";
import type { FolderId, StatFolder } from "../src/folder-identity.ts";

/**
 * A pretend disk. `folders` gives every folder that is there its file number; `links` names
 * paths that are links, and the folder each leads to. Like a real disk, ".." after a link is the
 * folder above the link's target, not the folder the link sits in.
 */
function pretendDisk(folders: Record<string, number>, links: Record<string, string> = {}): StatFolder & { asked: string[] } {
  const asked: string[] = [];
  const resolve = (written: string): string | null => {
    let current = "/";
    for (const part of written.split("/").filter((name) => name !== "" && name !== ".")) {
      if (part === "..") {
        current = path.dirname(current);
        continue;
      }
      const next = path.join(current, part);
      const real = links[next] ?? next;
      if (folders[real] === undefined) return null;
      current = real;
    }
    return current;
  };
  const stat = (folder: string): FolderId | null => {
    asked.push(folder);
    const real = resolve(folder);
    return real === null ? null : { dev: 1n, ino: BigInt(folders[real] ?? 0) };
  };
  return Object.assign(stat, { asked });
}

/** A made-up Mac: a home folder with a data folder in it, a second disk spelling of the home, and a link. */
const DISK = { "/": 2, "/Users": 10, "/Users/sam": 11, "/Users/sam/.overnight": 12, "/Users/sam/.overnight/logs": 13, "/Users/sam/scratch": 14, "/Volumes": 20, "/Volumes/Data": 21 };
const LINKS = { "/Volumes/Data/home": "/Users/sam", "/Users/sam/data-link": "/Users/sam/.overnight" };
const id = (ino: number): FolderId => ({ dev: 1n, ino: BigInt(ino) });

describe("where a folder is", () => {
  it("is the folder itself when it is there, with nothing left to make", () => {
    const stat = pretendDisk(DISK, LINKS);
    expect(locateFolder("/Users/sam/.overnight", stat)).toEqual({ anchor: "/Users/sam/.overnight", anchorId: id(12), rest: [] });
    // A link is followed: its numbers are the numbers of the folder it leads to.
    expect(locateFolder("/Users/sam/data-link", stat).anchorId).toEqual(id(12));
  });

  it("is the nearest folder above that is there, and the names still to be made below it", () => {
    const stat = pretendDisk(DISK, LINKS);
    expect(locateFolder("/Users/sam/scratch/run 1/data", stat)).toEqual({ anchor: "/Users/sam/scratch", anchorId: id(14), rest: ["run 1", "data"] });
    expect(locateFolder("/nowhere/at/all", stat)).toEqual({ anchor: "/", anchorId: id(2), rest: ["nowhere", "at", "all"] });
    // Through a link: the anchor is spelled as written, and its numbers are the real folder's.
    expect(locateFolder("/Volumes/Data/home/new", stat)).toEqual({ anchor: "/Volumes/Data/home", anchorId: id(11), rest: ["new"] });
  });

  it("says so, and answers nothing, when not even the top of the disk can be found", () => {
    expect(() => locateFolder("/a/b", () => null)).toThrow('no folder on the way to "/a/b" is there, so it is not known which folder that is');
  });

  it("lets an error from the disk through: not knowing is not a no", () => {
    const refusing: StatFolder = () => {
      throw new Error("made-up disk error");
    };
    expect(() => locateFolder("/a/b", refusing)).toThrow("made-up disk error");
    expect(() => sameOrInsideFolder("/a/b", "/a", refusing)).toThrow("made-up disk error");
    expect(() => sameFolder("/a/b", "/a", refusing)).toThrow("made-up disk error");
  });
});

describe("the folders above a folder", () => {
  it("are asked of the disk one step up at a time, the folder's own numbers first, the top of the disk last", () => {
    const stat = pretendDisk(DISK, LINKS);
    expect(folderAncestry("/Users/sam/.overnight", stat)).toEqual([id(12), id(11), id(10), id(2)]);
    expect(stat.asked).toEqual(["/Users/sam/.overnight", "/Users/sam/.overnight/..", "/Users/sam/.overnight/../..", "/Users/sam/.overnight/../../..", "/Users/sam/.overnight/../../../.."]);
    expect(folderAncestry("/", stat)).toEqual([id(2)]);
  });

  it("go by where a link leads, not by where the link sits", () => {
    const stat = pretendDisk(DISK, LINKS);
    // Cutting the last name off "/Volumes/Data/home" would give /Volumes/Data. The folder above the real one is /Users.
    expect(folderAncestry("/Volumes/Data/home", stat)).toEqual([id(11), id(10), id(2)]);
  });

  it("stops with an error past 128 levels, and when a folder on the way is not there", () => {
    let next = 100n;
    const bottomless: StatFolder = () => ({ dev: 1n, ino: (next += 1n) });
    expect(() => folderAncestry("/deep", bottomless)).toThrow('"/deep" is more than 128 folders deep, so it is not known which folder that is');
    // Exactly 128 levels is still answered.
    let level = 0;
    const deepEnough: StatFolder = () => ({ dev: 1n, ino: BigInt(Math.min((level += 1), 128)) });
    expect(folderAncestry("/deep", deepEnough)).toHaveLength(128);
    expect(() => folderAncestry("/Users/sam/gone", pretendDisk(DISK))).toThrow('"/Users/sam/gone" is not there');
  });
});

describe("the same folder, or inside it", () => {
  const stat = pretendDisk(DISK, LINKS);
  const inside = (folder: string, parent: string) => sameOrInsideFolder(folder, parent, stat);

  it("is true for the folder itself and for anything below it, there or not there yet", () => {
    expect(inside("/Users/sam/.overnight", "/Users/sam/.overnight")).toBe(true);
    expect(inside("/Users/sam/.overnight/logs", "/Users/sam/.overnight")).toBe(true);
    expect(inside("/Users/sam/.overnight/rehearsal/deeper", "/Users/sam/.overnight")).toBe(true);
  });

  it("is true however the folder is spelled: through a link to it, or through a link to a folder above it", () => {
    expect(inside("/Users/sam/data-link", "/Users/sam/.overnight")).toBe(true);
    expect(inside("/Users/sam/data-link/not/there/yet", "/Users/sam/.overnight")).toBe(true);
    expect(inside("/Volumes/Data/home/.overnight", "/Users/sam/.overnight")).toBe(true);
    expect(inside("/Volumes/Data/home/.overnight/logs", "/Users/sam/.overnight")).toBe(true);
    // And the other way round: the parent spelled through the link, the folder plainly.
    expect(inside("/Users/sam/.overnight/logs", "/Volumes/Data/home/data-link")).toBe(true);
  });

  it("is false for a folder beside it, above it, or one whose name only starts the same", () => {
    expect(inside("/Users/sam/scratch", "/Users/sam/.overnight")).toBe(false);
    expect(inside("/Users/sam", "/Users/sam/.overnight")).toBe(false);
    expect(inside("/", "/Users/sam/.overnight")).toBe(false);
    expect(inside("/Users/sam/.overnight-rehearsal", "/Users/sam/.overnight")).toBe(false);
    expect(inside("/Users/sam/.overnight2/data", "/Users/sam/.overnight")).toBe(false);
  });

  it("when the parent is not there yet, goes by the folder above both and the names below it, whatever their capitals", () => {
    // The real data folder of a fresh install: named, never made.
    const parent = "/Users/sam/scratch/.overnight";
    expect(inside("/Users/sam/scratch/.overnight", parent)).toBe(true);
    expect(inside("/Users/sam/scratch/.overnight/inner", parent)).toBe(true);
    expect(inside("/Users/sam/scratch/.Overnight", parent)).toBe(true);
    expect(inside("/Volumes/Data/home/scratch/.OVERNIGHT/inner", parent)).toBe(true);
    // The two ways of storing an accented letter are one name on a Mac's disk.
    expect(sameOrInsideFolder("/Users/sam/scratch/café", "/Users/sam/scratch/café", stat)).toBe(true);
    expect(inside("/Users/sam/scratch", parent)).toBe(false);
    expect(inside("/Users/sam/scratch/.overnight2", parent)).toBe(false);
    expect(inside("/Users/sam/scratch/other/.overnight", parent)).toBe(false);
    expect(inside("/Users/sam/.overnight/.overnight", parent)).toBe(false);
  });
});

describe("one folder under two names", () => {
  const stat = pretendDisk(DISK, LINKS);

  it("is the same folder when the disk says so, and when what is still to be made has the same names", () => {
    expect(sameFolder("/Users/sam/.overnight", "/Users/sam/data-link", stat)).toBe(true);
    expect(sameFolder("/Volumes/Data/home/.overnight", "/Users/sam/.overnight", stat)).toBe(true);
    expect(sameFolder("/Volumes/Data/home/scratch/new/data", "/Users/sam/scratch/New/Data", stat)).toBe(true);
  });

  it("goes by the device as well as the file number: two disks can each have a folder numbered the same", () => {
    // A second disk mounted at /Volumes/Other, whose top folder has the number the home folder has on the first.
    const twoDisks: StatFolder = (folder) => {
      const real = path.normalize(folder);
      if (real === "/") return { dev: 1n, ino: 2n };
      if (real === "/Users" || real === "/Volumes") return { dev: 1n, ino: real === "/Users" ? 10n : 20n };
      if (real === "/Users/sam") return { dev: 1n, ino: 11n };
      if (real === "/Volumes/Other") return { dev: 2n, ino: 11n };
      return null;
    };
    expect(sameFolder("/Users/sam", "/Volumes/Other", twoDisks)).toBe(false);
    expect(sameOrInsideFolder("/Volumes/Other/data", "/Users/sam", twoDisks)).toBe(false);
    expect(sameOrInsideFolder("/Volumes/Other/.overnight", "/Users/sam/.overnight", twoDisks)).toBe(false);
    expect(sameFolder("/Users/sam/x", "/Users/sam/X", twoDisks)).toBe(true);
  });

  it("is not the same folder as one inside it, above it or beside it", () => {
    expect(sameFolder("/Users/sam/.overnight", "/Users/sam/.overnight/logs", stat)).toBe(false);
    expect(sameFolder("/Users/sam/.overnight/new", "/Users/sam/.overnight", stat)).toBe(false);
    expect(sameFolder("/Users/sam/scratch/a", "/Users/sam/scratch/b", stat)).toBe(false);
    expect(sameFolder("/Users/sam/scratch/a", "/Users/sam/scratch/a/b", stat)).toBe(false);
    expect(sameFolder("/Users/sam/scratch", "/Users/sam/.overnight", stat)).toBe(false);
  });
});

describe("asked of the real disk", () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "overnight folder identity "));
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("gives a folder's numbers, the same through a link, and nothing for what is not there", () => {
    const real = path.join(scratch, "a real folder");
    mkdirSync(real);
    const link = path.join(scratch, "a link");
    symlinkSync(real, link);
    const numbers = statSync(real, { bigint: true });
    expect(statFolder(real)).toEqual({ dev: numbers.dev, ino: numbers.ino });
    expect(statFolder(link)).toEqual(statFolder(real));
    expect(statFolder(path.join(scratch, "not there"))).toBeNull();
    // A file in the way (ENOTDIR): nothing is there either.
    writeFileSync(path.join(scratch, "a file"), "made up\n");
    expect(statFolder(path.join(scratch, "a file", "below"))).toBeNull();
    // A link that leads round to itself cannot be looked at: an error, not a "not there".
    const loop = path.join(scratch, "a loop");
    symlinkSync(loop, loop);
    expect(() => statFolder(loop)).toThrow(/could not be looked at \(ELOOP\), so it is not known which folder that is/);
    expect(() => sameOrInsideFolder(path.join(loop, "x"), real)).toThrow("could not be looked at");
  });

  it("knows a folder through a link, in other capitals where the disk does not tell them apart, and below a link", () => {
    const real = path.join(scratch, "home of someone", ".overnight");
    mkdirSync(real, { recursive: true });
    const link = path.join(scratch, "link to home");
    symlinkSync(path.join(scratch, "home of someone"), link);
    expect(sameFolder(path.join(link, ".overnight"), real)).toBe(true);
    expect(sameOrInsideFolder(path.join(link, ".overnight", "new", "deeper"), real)).toBe(true);
    expect(sameOrInsideFolder(path.join(scratch, "home of someone", ".overnight-2"), real)).toBe(false);
    // Only where the disk itself takes the two spellings as one folder (a Mac's default).
    const capitals = path.join(scratch, "HOME OF SOMEONE", ".Overnight");
    if (statFolder(capitals) !== null) expect(sameFolder(capitals, real)).toBe(true);
  });

  // macOS has two more names for every folder. Neither is a link, so following links never finds them.
  it.runIf(process.platform === "darwin")("knows a folder by macOS's other two names for it: under /System/Volumes/Data, and as /.vol/<device>/<file number>", () => {
    const real = realpathSync(mkdtempSync(path.join(scratch, "real data ")));
    const numbers = statSync(real, { bigint: true });
    const underData = path.join("/System/Volumes/Data", real);
    const byNumber = `/.vol/${numbers.dev}/${numbers.ino}`;
    for (const spelled of [underData, byNumber]) {
      expect(statFolder(spelled), spelled).toEqual({ dev: numbers.dev, ino: numbers.ino });
      expect(sameFolder(spelled, real), spelled).toBe(true);
      expect(sameOrInsideFolder(spelled, real), spelled).toBe(true);
      expect(sameOrInsideFolder(path.join(spelled, "inner", "not there yet"), real), spelled).toBe(true);
      expect(sameOrInsideFolder(real, spelled), spelled).toBe(true);
    }
    // The folder above it is not inside it, by that other name either.
    expect(sameOrInsideFolder(path.dirname(underData), real)).toBe(false);
  });
});
