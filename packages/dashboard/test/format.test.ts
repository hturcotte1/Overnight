// How the pages write times, lengths of time, sizes and counts. Every name and path here is invented.
import { IDEA_STATES } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { backendLabel, bytes, clip, clockTime, dayTime, duration, homeTilde, minusMinutes, plural, STATE_LABELS } from "../src/render/format.ts";

const BOISE = "America/Boise";

describe("clockTime", () => {
  it("writes a time as people say it, in the given zone", () => {
    // 07:02 UTC on Oct 11 is 1:02 in the morning in Boise (UTC-6 in summer time).
    expect(clockTime("2026-10-11T07:02:00.000Z", BOISE)).toBe("1:02 AM");
    expect(clockTime(new Date("2026-10-11T00:02:00.000Z"), BOISE)).toBe("6:02 PM");
    expect(clockTime("2026-10-11T06:00:00.000Z", BOISE)).toBe("12:00 AM");
    expect(clockTime("2026-10-11T18:00:00.000Z", BOISE)).toBe("12:00 PM");
    expect(clockTime("2026-10-11T07:02:00.000Z", "UTC")).toBe("7:02 AM");
  });

  it("has a plain space before AM and PM, whatever this version of Node would put there", () => {
    expect(clockTime("2026-10-11T07:02:00.000Z", BOISE)).toMatch(/^[0-9:]+ [AP]M$/);
  });

  it("follows the zone's clock changes", () => {
    // Winter time is UTC-7.
    expect(clockTime("2026-12-11T07:02:00.000Z", BOISE)).toBe("12:02 AM");
  });

  it("says so, instead of throwing, when the time cannot be read", () => {
    expect(clockTime("not a time", BOISE)).toBe("unknown time");
    expect(clockTime("", BOISE)).toBe("unknown time");
    expect(clockTime(new Date(Number.NaN), BOISE)).toBe("unknown time");
  });
});

describe("dayTime", () => {
  // 1:02 in the morning on Sunday, Oct 11, in Boise.
  const now = new Date("2026-10-11T07:02:00.000Z");

  it("says today, yesterday and tomorrow by the local calendar, and the date for any other day", () => {
    expect(dayTime("2026-10-11T07:00:00.000Z", BOISE, now)).toBe("today, 1:00 AM");
    expect(dayTime("2026-10-10T13:00:00.000Z", BOISE, now)).toBe("yesterday, 7:00 AM");
    expect(dayTime("2026-10-10T00:02:00.000Z", BOISE, now)).toBe("Oct 9, 6:02 PM");
    expect(dayTime("2026-10-12T13:00:00.000Z", BOISE, now)).toBe("tomorrow, 7:00 AM");
    expect(dayTime("2026-10-13T13:00:00.000Z", BOISE, now)).toBe("Oct 13, 7:00 AM");
    expect(dayTime(new Date("2026-09-30T18:30:00.000Z"), BOISE, now)).toBe("Sep 30, 12:30 PM");
  });

  it("goes by the local day, not the UTC one", () => {
    // 11:30 pm on Oct 10 in Boise is already Oct 11 in UTC, and it is still yesterday at 1:02 am.
    expect(dayTime("2026-10-11T05:30:00.000Z", BOISE, now)).toBe("yesterday, 11:30 PM");
    // 6:30 pm on Oct 11 in Boise is Oct 12 in UTC, and it is still today.
    expect(dayTime("2026-10-12T00:30:00.000Z", BOISE, now)).toBe("today, 6:30 PM");
  });

  it("is right on the 23-hour day when the clocks go forward (Mar 8, 2026)", () => {
    // Half past midnight on Mar 9. Twenty-four hours earlier it was still Mar 7.
    const afterSpring = new Date("2026-03-09T06:30:00.000Z");
    expect(dayTime("2026-03-08T18:00:00.000Z", BOISE, afterSpring)).toBe("yesterday, 12:00 PM");
    expect(dayTime("2026-03-08T07:30:00.000Z", BOISE, afterSpring)).toBe("yesterday, 12:30 AM");
    expect(dayTime("2026-03-08T06:45:00.000Z", BOISE, afterSpring)).toBe("Mar 7, 11:45 PM");
    // The evening before the change: tomorrow's 11:45 pm is only 23 hours and a quarter away.
    const beforeSpring = new Date("2026-03-08T06:30:00.000Z");
    expect(dayTime("2026-03-09T05:45:00.000Z", BOISE, beforeSpring)).toBe("tomorrow, 11:45 PM");
  });

  it("is right on the 25-hour day when the clocks go back (Nov 1, 2026)", () => {
    // Half past eleven at night on Nov 1. Twenty-four hours earlier it was already Nov 1.
    const lateOnTheLongDay = new Date("2026-11-02T06:30:00.000Z");
    expect(dayTime("2026-11-01T05:45:00.000Z", BOISE, lateOnTheLongDay)).toBe("yesterday, 11:45 PM");
    expect(dayTime("2026-11-01T06:15:00.000Z", BOISE, lateOnTheLongDay)).toBe("today, 12:15 AM");
    // 1:30 am happens twice that night. Both are today.
    expect(dayTime("2026-11-01T07:30:00.000Z", BOISE, lateOnTheLongDay)).toBe("today, 1:30 AM");
    expect(dayTime("2026-11-01T08:30:00.000Z", BOISE, lateOnTheLongDay)).toBe("today, 1:30 AM");
    // Just after midnight on Nov 1: tomorrow's 11:50 pm is more than 48 hours away and still tomorrow.
    const earlyOnTheLongDay = new Date("2026-11-01T06:05:00.000Z");
    expect(dayTime("2026-11-03T06:50:00.000Z", BOISE, earlyOnTheLongDay)).toBe("tomorrow, 11:50 PM");
  });

  it("says so, instead of throwing, when the time cannot be read", () => {
    expect(dayTime("not a time", BOISE, now)).toBe("unknown time");
  });
});

describe("duration", () => {
  it("gives tenths of a second under ten seconds", () => {
    expect(duration(7_100)).toBe("7.1 s");
    expect(duration(6_640)).toBe("6.6 s");
    expect(duration(250)).toBe("0.3 s");
    expect(duration(6_000)).toBe("6 s");
    expect(duration(9_949)).toBe("9.9 s");
  });

  it("gives whole seconds from ten seconds up", () => {
    expect(duration(9_950)).toBe("10 s");
    expect(duration(26_400)).toBe("26 s");
    expect(duration(59_400)).toBe("59 s");
  });

  it("gives minutes and seconds from a minute up", () => {
    expect(duration(59_600)).toBe("1 min");
    expect(duration(160_000)).toBe("2 min 40 s");
    expect(duration(139_000)).toBe("2 min 19 s");
    expect(duration(180_000)).toBe("3 min");
    expect(duration(45 * 60_000)).toBe("45 min");
  });

  it("gives hours and minutes from an hour up", () => {
    expect(duration(3_599_600)).toBe("1 h");
    expect(duration(65 * 60_000)).toBe("1 h 5 min");
    expect(duration(7_170_000)).toBe("2 h");
  });

  it("writes nothing odd for zero, a negative number or a number that is not one", () => {
    expect(duration(0)).toBe("0 s");
    expect(duration(40)).toBe("0 s");
    expect(duration(-5_000)).toBe("0 s");
    expect(duration(Number.NaN)).toBe("0 s");
    expect(duration(Number.POSITIVE_INFINITY)).toBe("0 s");
  });
});

describe("bytes", () => {
  it("counts bytes under a thousand", () => {
    expect(bytes(0)).toBe("0 bytes");
    expect(bytes(1)).toBe("1 byte");
    expect(bytes(812)).toBe("812 bytes");
    expect(bytes(999)).toBe("999 bytes");
  });

  it("goes up through KB, MB and GB in thousands, with at most one decimal", () => {
    expect(bytes(1_000)).toBe("1 KB");
    expect(bytes(5_602)).toBe("5.6 KB");
    expect(bytes(999_949)).toBe("999.9 KB");
    expect(bytes(1_234_567)).toBe("1.2 MB");
    expect(bytes(15 * 1024 * 1024)).toBe("15.7 MB");
    expect(bytes(2_500_000_000)).toBe("2.5 GB");
  });

  it("never writes 1000 of a unit", () => {
    expect(bytes(999_960)).toBe("1 MB");
    expect(bytes(999_960_000)).toBe("1 GB");
  });

  it("writes nothing odd for a negative number or a number that is not one", () => {
    expect(bytes(-3)).toBe("0 bytes");
    expect(bytes(Number.NaN)).toBe("0 bytes");
  });
});

describe("plural", () => {
  it("adds an s unless there is exactly one", () => {
    expect(plural(1, "line")).toBe("1 line");
    expect(plural(0, "idea")).toBe("0 ideas");
    expect(plural(214, "line")).toBe("214 lines");
  });

  it("takes the plural word when adding an s is wrong", () => {
    expect(plural(2, "night watch", "night watches")).toBe("2 night watches");
    expect(plural(1, "night watch", "night watches")).toBe("1 night watch");
  });

  it("groups thousands and keeps at most two decimals", () => {
    expect(plural(1_204, "line")).toBe("1,204 lines");
    expect(plural(4.59, "Kiro credit")).toBe("4.59 Kiro credits");
    expect(plural(3.0949, "Kiro credit")).toBe("3.09 Kiro credits");
  });
});

describe("clip", () => {
  it("leaves a short text alone", () => {
    expect(clip("Chore Wheel", 40)).toEqual({ text: "Chore Wheel", cut: false });
    expect(clip("abc", 3)).toEqual({ text: "abc", cut: false });
    expect(clip("", 0)).toEqual({ text: "", cut: false });
  });

  it("cuts a long one and says so", () => {
    expect(clip("Bale Yield Calculator", 10)).toEqual({ text: "Bale Yield", cut: true });
    expect(clip("abc", 0)).toEqual({ text: "", cut: true });
    expect(clip("abc", -4)).toEqual({ text: "", cut: true });
  });

  it("counts whole characters, so an emoji is never cut in half", () => {
    // Each of these faces is two units long in a JavaScript string.
    expect(clip("ab😀cd", 3)).toEqual({ text: "ab😀", cut: true });
    expect(clip("😀😀😀", 3)).toEqual({ text: "😀😀😀", cut: false });
    expect(clip("😀😀😀", 2)).toEqual({ text: "😀😀", cut: true });
  });

  it("handles a very long text", () => {
    const long = "word ".repeat(40_000);
    const clipped = clip(long, 300);
    expect(clipped.cut).toBe(true);
    expect(clipped.text).toHaveLength(300);
  });
});

describe("homeTilde", () => {
  const home = "/Users/sam";

  it("shows the home folder as ~ wherever its path appears", () => {
    expect(homeTilde("/Users/sam/.overnight", home)).toBe("~/.overnight");
    expect(homeTilde("/Users/sam", home)).toBe("~");
    expect(homeTilde("built in /Users/sam/.overnight/workspaces/abc, then copied to /Users/sam/.overnight/built/abc", home)).toBe("built in ~/.overnight/workspaces/abc, then copied to ~/.overnight/built/abc");
    expect(homeTilde("cd '/Users/sam/.overnight' (/Users/sam)", home)).toBe("cd '~/.overnight' (~)");
  });

  it("also at the end of a sentence", () => {
    expect(homeTilde("The folder is /Users/sam.", home)).toBe("The folder is ~.");
  });

  it("leaves another folder alone when its name only starts the same way, or holds the path deeper inside", () => {
    expect(homeTilde("/Users/samantha/notes", home)).toBe("/Users/samantha/notes");
    expect(homeTilde("/Users/sam-old/notes", home)).toBe("/Users/sam-old/notes");
    expect(homeTilde("/Users/sam2", home)).toBe("/Users/sam2");
    expect(homeTilde("/Volumes/Old/Users/sam/notes", home)).toBe("/Volumes/Old/Users/sam/notes");
    expect(homeTilde("../Users/sam/notes", home)).toBe("../Users/sam/notes");
  });

  // An agent writes the build notes, and may name the folder by any of the names the Mac has for it.
  it("finds the home folder under the disk's other name for it, /System/Volumes/Data", () => {
    expect(homeTilde("cd /System/Volumes/Data/Users/sam/.overnight/x", home)).toBe("cd ~/.overnight/x");
    expect(homeTilde("/System/Volumes/Data/Users/sam", home)).toBe("~");
    expect(homeTilde("from /System/Volumes/Data/Users/sam/a to /Users/sam/b.", home)).toBe("from ~/a to ~/b.");
    // Another folder there is still another folder.
    expect(homeTilde("/System/Volumes/Data/Users/samantha/x", home)).toBe("/System/Volumes/Data/Users/samantha/x");
    expect(homeTilde("/System/Volumes/Data/Users/shared", home)).toBe("/System/Volumes/Data/Users/shared");
  });

  it("finds it in other capitals, which on a Mac's disk name the same folder", () => {
    expect(homeTilde("cd /users/Sam/.overnight/x", home)).toBe("cd ~/.overnight/x");
    expect(homeTilde("/USERS/SAM", home)).toBe("~");
    expect(homeTilde("/system/volumes/data/USERS/sam/x", home)).toBe("~/x");
    expect(homeTilde("/Users/SAMANTHA/notes", home)).toBe("/Users/SAMANTHA/notes");
    expect(homeTilde("/Volumes/Old/USERS/SAM/notes", home)).toBe("/Volumes/Old/USERS/SAM/notes");
  });

  it("finds it whichever way an accent in its name is stored", () => {
    const oneLetter = "/Users/jos\u00e9";
    const letterAndAccent = "/Users/jose\u0301";
    expect(homeTilde(`${letterAndAccent}/notes`, oneLetter)).toBe("~/notes");
    expect(homeTilde(`${oneLetter}/notes`, letterAndAccent)).toBe("~/notes");
    expect(homeTilde("/Users/JOS\u00c9/notes", letterAndAccent)).toBe("~/notes");
  });

  it("takes a home folder whose name holds signs a pattern would read as its own", () => {
    for (const odd of ["/Users/sam.b", "/Users/a+b (old)", "/Users/overnight-test-x1", "/Users/[sam]", "/Users/s$m^", "/Users/sam|x\\y"]) {
      expect(homeTilde(`in ${odd}/notes and ${odd}`, odd), odd).toBe("in ~/notes and ~");
    }
    // The dot in a name stands for a dot, not for any letter.
    expect(homeTilde("/Users/samXb/notes", "/Users/sam.b")).toBe("/Users/samXb/notes");
  });

  it("does not mind a slash at the end of the home folder", () => {
    expect(homeTilde("/Users/sam/.overnight", "/Users/sam/")).toBe("~/.overnight");
  });

  it("changes nothing when the home folder is empty, the top folder or not a full path", () => {
    const text = "/Users/sam/.overnight and a/b";
    expect(homeTilde(text, "")).toBe(text);
    expect(homeTilde(text, "/")).toBe(text);
    expect(homeTilde(text, "a")).toBe(text);
    expect(homeTilde(text, "Users/sam")).toBe(text);
  });

  it("leaves a text without the path as it is", () => {
    expect(homeTilde("nothing to hide here", home)).toBe("nothing to hide here");
    expect(homeTilde("", home)).toBe("");
  });
});

describe("minusMinutes", () => {
  it("gives the clock time that many minutes earlier", () => {
    expect(minusMinutes("07:00", 30)).toBe("06:30");
    expect(minusMinutes("07:15", 0)).toBe("07:15");
    expect(minusMinutes("23:00", 61)).toBe("21:59");
  });

  it("goes round midnight", () => {
    expect(minusMinutes("00:10", 30)).toBe("23:40");
    expect(minusMinutes("00:00", 1440)).toBe("00:00");
  });

  it("throws on a time that is not HH:MM, as core does", () => {
    expect(() => minusMinutes("7:00", 30)).toThrow(/not a time like/);
    expect(() => minusMinutes("soon", 30)).toThrow();
  });
});

describe("backendLabel", () => {
  it("names the two builders, and gives nothing when none is recorded", () => {
    expect(backendLabel("kiro-crew")).toBe("Kiro Crew");
    expect(backendLabel("kiro-cli")).toBe("Kiro CLI");
    expect(backendLabel(null)).toBe("");
  });

  it("gives back a name it does not know, and is not fooled by the names every object has", () => {
    expect(backendLabel("another-builder")).toBe("another-builder");
    expect(backendLabel("constructor")).toBe("constructor");
    expect(backendLabel("toString")).toBe("toString");
  });
});

describe("STATE_LABELS", () => {
  it("has the page's words for every idea state, and only for those", () => {
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...IDEA_STATES].sort());
    expect(IDEA_STATES.map((state) => STATE_LABELS[state])).toEqual(["Heard", "Asked", "Approved", "Not approved", "No answer", "Building", "Built", "Could not build", "Published", "Not published", "Delivered"]);
  });

  it("cannot be changed by a page", () => {
    expect(Object.isFrozen(STATE_LABELS)).toBe(true);
  });
});
