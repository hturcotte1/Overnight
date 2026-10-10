import { describe, expect, it } from "vitest";
import { localDateKey, localDayBounds, nextLocalTime, parseHhMm, zonedTimeToUtc } from "../src/index.ts";

const BOISE = "America/Boise";

describe("time helpers", () => {
  it("knows the local day in Boise", () => {
    // 05:30 UTC on Oct 10 is still 11:30 pm on Oct 9 in Boise (UTC-6 in summer time).
    expect(localDateKey(new Date("2026-10-10T05:30:00Z"), BOISE)).toBe("2026-10-09");
    expect(localDateKey(new Date("2026-10-10T06:30:00Z"), BOISE)).toBe("2026-10-10");
  });

  it("converts a Boise wall-clock time to UTC in summer and winter", () => {
    expect(zonedTimeToUtc(2026, 10, 9, 23, 0, BOISE).toISOString()).toBe("2026-10-10T05:00:00.000Z");
    expect(zonedTimeToUtc(2026, 12, 9, 23, 0, BOISE).toISOString()).toBe("2026-12-10T06:00:00.000Z");
  });

  it("finds the next 23:00", () => {
    expect(nextLocalTime(new Date("2026-10-09T20:00:00Z"), "23:00", BOISE).toISOString()).toBe("2026-10-10T05:00:00.000Z");
    // Exactly at the cutoff counts as "already passed": the next one is tomorrow.
    expect(nextLocalTime(new Date("2026-10-10T05:00:00Z"), "23:00", BOISE).toISOString()).toBe("2026-10-11T05:00:00.000Z");
  });

  it("handles the night the clocks go back (Nov 1, 2026)", () => {
    const next = nextLocalTime(new Date("2026-11-01T05:30:00Z"), "23:00", BOISE);
    expect(next.toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  it("gives the bounds of a local day, 25 hours long when the clocks go back", () => {
    const { start, end } = localDayBounds(new Date("2026-11-01T18:00:00Z"), BOISE);
    expect(start.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T07:00:00.000Z");
  });

  it("rejects times that are not HH:MM", () => {
    expect(parseHhMm("07:05")).toEqual({ hour: 7, minute: 5 });
    for (const bad of ["7:05", "24:00", "23:60", "noon", ""]) expect(() => parseHhMm(bad)).toThrow();
  });
});
