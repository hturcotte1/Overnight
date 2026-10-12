import { describe, expect, it } from "vitest";
import { localDateKey, localDayBounds, localMonthBounds, nextLocalTime, parseHhMm, previousLocalTime, zonedTimeToUtc } from "../src/index.ts";

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

describe("the last time the local clock read a time", () => {
  const last = (at: string, hhmm: string, zone = BOISE) => {
    const found = previousLocalTime(new Date(at), hhmm, zone);
    return [found.at.toISOString(), found.day];
  };

  it("counts the exact moment, and is yesterday's one minute before", () => {
    expect(last("2026-10-12T07:00:00Z", "01:00")).toEqual(["2026-10-12T07:00:00.000Z", "2026-10-12"]);
    expect(last("2026-10-12T07:00:00.001Z", "01:00")).toEqual(["2026-10-12T07:00:00.000Z", "2026-10-12"]);
    expect(last("2026-10-12T06:59:00Z", "01:00")).toEqual(["2026-10-11T07:00:00.000Z", "2026-10-11"]);
  });

  it("names the day the time is on, which is not always the day it is now", () => {
    // 12:05 am on Oct 12 in Boise: the last 23:40 was on Oct 11.
    expect(last("2026-10-12T06:05:00Z", "23:40")).toEqual(["2026-10-12T05:40:00.000Z", "2026-10-11"]);
    // A zone ahead of UTC: 12:30 am on Oct 12 in Tokyo is still Oct 11 in UTC.
    expect(last("2026-10-11T15:30:00Z", "00:15", "Asia/Tokyo")).toEqual(["2026-10-11T15:15:00.000Z", "2026-10-12"]);
  });

  it("treats both 01:00s as one on the night the clocks go back (Nov 1, 2026)", () => {
    // The first 01:00 is 07:00Z. The second, an hour later, is the same day's time, not a new one.
    expect(last("2026-11-01T07:00:00Z", "01:00")).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01"]);
    expect(last("2026-11-01T08:00:00Z", "01:00")).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01"]);
    // It stays so until the next day's 01:00, which is 25 hours after the first.
    expect(last("2026-11-02T07:59:59Z", "01:00")).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01"]);
    expect(last("2026-11-02T08:00:00Z", "01:00")).toEqual(["2026-11-02T08:00:00.000Z", "2026-11-02"]);
  });

  it("still finds a time the clocks skip (02:30 on Mar 14, 2027)", () => {
    // 02:30 does not exist that night: the clock goes from 01:59 to 03:00. It is taken as 08:30Z.
    expect(last("2027-03-14T08:29:00Z", "02:30")).toEqual(["2027-03-13T09:30:00.000Z", "2027-03-13"]);
    expect(last("2027-03-14T08:30:00Z", "02:30")).toEqual(["2027-03-14T08:30:00.000Z", "2027-03-14"]);
    expect(last("2027-03-15T08:29:00Z", "02:30")).toEqual(["2027-03-14T08:30:00.000Z", "2027-03-14"]);
    expect(last("2027-03-15T08:30:00Z", "02:30")).toEqual(["2027-03-15T08:30:00.000Z", "2027-03-15"]);
  });

  it("gives every day its own time, in order, even where the clocks skip midnight", () => {
    // Havana, Mar 8, 2026: midnight becomes 1 am, so 00:30 does not exist that day. It is taken
    // as 04:30Z, which the clocks there still call 11:30 pm on Mar 7. It is Mar 8's time all the same.
    const named = new Map<string, string>();
    let before = "";
    for (let ms = Date.parse("2026-03-06T06:00:00Z"); ms <= Date.parse("2026-03-10T12:00:00Z"); ms += 5 * 60_000) {
      const found = previousLocalTime(new Date(ms), "00:30", "America/Havana");
      expect(found.at.getTime()).toBeLessThanOrEqual(ms);
      expect(found.day >= before).toBe(true);
      before = found.day;
      // One day, one moment: the same name never comes with two different times.
      expect(named.get(found.day) ?? found.at.toISOString()).toBe(found.at.toISOString());
      named.set(found.day, found.at.toISOString());
    }
    expect([...named]).toEqual([
      ["2026-03-06", "2026-03-06T05:30:00.000Z"],
      ["2026-03-07", "2026-03-07T05:30:00.000Z"],
      ["2026-03-08", "2026-03-08T04:30:00.000Z"],
      ["2026-03-09", "2026-03-09T04:30:00.000Z"],
      ["2026-03-10", "2026-03-10T04:30:00.000Z"],
    ]);
  });

  it("finds a time the clocks skip at midnight at its own moment, not when the local day turns", () => {
    // Havana, Mar 14, 2027: midnight becomes 1 am. 00:30 is taken as 04:30Z, when the clocks
    // there still say 11:30 pm on Mar 13. It is Mar 14's time from that moment on.
    const HAVANA = "America/Havana";
    expect(last("2027-03-14T04:29:59Z", "00:30", HAVANA)).toEqual(["2027-03-13T05:30:00.000Z", "2027-03-13"]);
    expect(last("2027-03-14T04:30:00Z", "00:30", HAVANA)).toEqual(["2027-03-14T04:30:00.000Z", "2027-03-14"]);
    expect(last("2027-03-14T04:59:00Z", "00:30", HAVANA)).toEqual(["2027-03-14T04:30:00.000Z", "2027-03-14"]);
    expect(last("2027-03-14T05:00:00Z", "00:30", HAVANA)).toEqual(["2027-03-14T04:30:00.000Z", "2027-03-14"]);
    expect(last("2027-03-14T04:00:00Z", "00:00", HAVANA)).toEqual(["2027-03-14T04:00:00.000Z", "2027-03-14"]);
    // The same in the two other places that skip midnight.
    expect(last("2026-09-06T03:30:00Z", "00:30", "America/Santiago")).toEqual(["2026-09-06T03:30:00.000Z", "2026-09-06"]);
    expect(last("2027-03-28T00:30:00Z", "00:30", "Atlantic/Azores")).toEqual(["2027-03-28T00:30:00.000Z", "2027-03-28"]);
  });

  it("moves on to a day's time at the moment nextLocalTime gave for it, also where the clocks skip midnight", () => {
    const nights: Array<[zone: string, from: string]> = [
      ["America/Havana", "2027-03-13T00:00:00Z"],
      ["America/Santiago", "2026-09-05T00:00:00Z"],
      ["Atlantic/Azores", "2027-03-27T00:00:00Z"],
      [BOISE, "2027-03-13T00:00:00Z"],
      [BOISE, "2026-10-31T00:00:00Z"],
    ];
    for (const [zone, from] of nights) {
      for (const hhmm of ["00:00", "00:30", "01:00", "02:30", "23:30"]) {
        const start = Date.parse(from);
        let before = previousLocalTime(new Date(start), hhmm, zone);
        let promised = nextLocalTime(new Date(start), hhmm, zone);
        for (let ms = start + 5 * 60_000; ms <= start + 3 * 86_400_000; ms += 5 * 60_000) {
          const found = previousLocalTime(new Date(ms), hhmm, zone);
          const where = `${zone} ${hhmm} at ${new Date(ms).toISOString()}`;
          if (found.day === before.day) {
            expect(found.at.toISOString(), where).toBe(before.at.toISOString());
          } else {
            // A new day's time: it came just now, and it is the one that was promised.
            expect(found.at.toISOString(), where).toBe(new Date(ms).toISOString());
            expect(found.at.toISOString(), where).toBe(promised.toISOString());
          }
          before = found;
          promised = nextLocalTime(new Date(ms), hhmm, zone);
        }
      }
    }
  });

  it("rejects a time that is not HH:MM", () => {
    expect(() => previousLocalTime(new Date("2026-10-12T07:00:00Z"), "1am", BOISE)).toThrow("1am");
  });
});

describe("the bounds of a local month", () => {
  const bounds = (at: string, zone = BOISE) => {
    const { start, end } = localMonthBounds(new Date(at), zone);
    return [start.toISOString(), end.toISOString()];
  };

  it("gives October 2026 in Boise, from its first moment to its last", () => {
    const october = ["2026-10-01T06:00:00.000Z", "2026-11-01T06:00:00.000Z"];
    expect(bounds("2026-10-11T21:00:00Z")).toEqual(october);
    expect(bounds("2026-10-01T06:00:00Z")).toEqual(october);
    expect(bounds("2026-11-01T05:59:59Z")).toEqual(october);
    expect(bounds("2026-10-01T05:59:59Z")).toEqual(["2026-09-01T06:00:00.000Z", "2026-10-01T06:00:00.000Z"]);
  });

  it("goes from December into January of the next year", () => {
    expect(bounds("2026-12-15T00:00:00Z")).toEqual(["2026-12-01T07:00:00.000Z", "2027-01-01T07:00:00.000Z"]);
  });

  it("follows the clock change inside a month", () => {
    // November starts in summer time and ends in winter time, so it is an hour longer.
    expect(bounds("2026-11-15T00:00:00Z")).toEqual(["2026-11-01T06:00:00.000Z", "2026-12-01T07:00:00.000Z"]);
  });

  it("works in a zone ahead of UTC", () => {
    // 1 am on Oct 1 in Tokyo is still Sep 30 in UTC.
    expect(bounds("2026-09-30T16:00:00Z", "Asia/Tokyo")).toEqual(["2026-09-30T15:00:00.000Z", "2026-10-31T15:00:00.000Z"]);
  });
});
