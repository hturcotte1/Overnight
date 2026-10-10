// Nothing in this file is Bee data: it is clock arithmetic on made-up moments.
import { describe, expect, it } from "vitest";
import { quietHoursEnd } from "../src/index.ts";

const BOISE = { askCutoff: "23:00", deliverTime: "07:00", timeZone: "America/Boise" };

/** When quiet hours end if `at` is inside them, or null if it is not. */
const endsAt = (at: string, config = BOISE) => quietHoursEnd(new Date(at), config)?.toISOString() ?? null;

describe("quiet hours", () => {
  describe("with the defaults in Boise: 11 pm until 7 the next morning", () => {
    // Oct 9, 2026 is summer time, UTC-6: 11 pm is 05:00Z the next day and 7 am is 13:00Z.
    const MORNING = "2026-10-10T13:00:00.000Z";

    it("are off through the day and the evening", () => {
      expect(endsAt("2026-10-09T13:00:00.000Z")).toBeNull(); // 7:00 am exactly
      expect(endsAt("2026-10-09T20:00:00.000Z")).toBeNull(); // 2 pm
      expect(endsAt("2026-10-10T04:59:59.999Z")).toBeNull(); // a millisecond before 11 pm
    });

    it("start at the cutoff, cross midnight, and end at the morning delivery", () => {
      expect(endsAt("2026-10-10T05:00:00.000Z")).toBe(MORNING); // 11:00 pm exactly
      expect(endsAt("2026-10-10T05:59:59.999Z")).toBe(MORNING); // the last moment of Oct 9
      expect(endsAt("2026-10-10T06:00:00.000Z")).toBe(MORNING); // midnight
      expect(endsAt("2026-10-10T09:30:00.000Z")).toBe(MORNING); // 3:30 am
      expect(endsAt("2026-10-10T12:59:59.999Z")).toBe(MORNING); // a millisecond before 7 am
      expect(endsAt(MORNING)).toBeNull();
    });
  });

  describe("on the nights the clocks change in Boise", () => {
    it("lasts nine hours when the clocks go back (Nov 1, 2026)", () => {
      // 11 pm on Oct 31 is still summer time (05:00Z). At 2 am the clock goes back to 1 am, so
      // 7 am comes at 14:00Z, an hour later than the night before.
      const MORNING = "2026-11-01T14:00:00.000Z";
      expect(endsAt("2026-11-01T04:59:59.999Z")).toBeNull();
      expect(endsAt("2026-11-01T05:00:00.000Z")).toBe(MORNING);
      expect(endsAt("2026-11-01T07:30:00.000Z")).toBe(MORNING); // 1:30 am, the first time round
      expect(endsAt("2026-11-01T08:30:00.000Z")).toBe(MORNING); // 1:30 am again, an hour later
      expect(endsAt("2026-11-01T13:00:00.000Z")).toBe(MORNING); // 6 am: yesterday this was 7 am
      expect(endsAt("2026-11-01T13:59:59.999Z")).toBe(MORNING);
      expect(endsAt(MORNING)).toBeNull();

      // The next night is on winter time throughout: 11 pm is 06:00Z.
      expect(endsAt("2026-11-02T05:59:59.999Z")).toBeNull();
      expect(endsAt("2026-11-02T06:00:00.000Z")).toBe("2026-11-02T14:00:00.000Z");
    });

    it("lasts seven hours when the clocks go forward (Mar 8, 2026)", () => {
      // 11 pm on Mar 7 is winter time (06:00Z). 2 am becomes 3 am, so 7 am comes at 13:00Z.
      const MORNING = "2026-03-08T13:00:00.000Z";
      expect(endsAt("2026-03-08T05:59:59.999Z")).toBeNull();
      expect(endsAt("2026-03-08T06:00:00.000Z")).toBe(MORNING);
      expect(endsAt("2026-03-08T09:30:00.000Z")).toBe(MORNING); // 3:30 am, just after the jump
      expect(endsAt("2026-03-08T12:59:59.999Z")).toBe(MORNING);
      expect(endsAt(MORNING)).toBeNull();
    });
  });

  describe("with a window that does not cross midnight", () => {
    it("1 am until 7 am", () => {
      const config = { ...BOISE, askCutoff: "01:00" };
      const MORNING = "2026-10-10T13:00:00.000Z";
      expect(endsAt("2026-10-10T05:30:00.000Z", config)).toBeNull(); // 11:30 pm the evening before
      expect(endsAt("2026-10-10T06:59:59.999Z", config)).toBeNull(); // a millisecond before 1 am
      expect(endsAt("2026-10-10T07:00:00.000Z", config)).toBe(MORNING); // 1 am
      expect(endsAt("2026-10-10T10:00:00.000Z", config)).toBe(MORNING); // 4 am
      expect(endsAt(MORNING, config)).toBeNull();
      expect(endsAt("2026-10-10T20:00:00.000Z", config)).toBeNull(); // 2 pm
    });

    it("a lunch break, noon until 1:30 pm", () => {
      const config = { ...BOISE, askCutoff: "12:00", deliverTime: "13:30" };
      expect(endsAt("2026-10-09T17:59:59.999Z", config)).toBeNull();
      expect(endsAt("2026-10-09T18:00:00.000Z", config)).toBe("2026-10-09T19:30:00.000Z");
      expect(endsAt("2026-10-09T19:29:59.999Z", config)).toBe("2026-10-09T19:30:00.000Z");
      expect(endsAt("2026-10-09T19:30:00.000Z", config)).toBeNull();
      expect(endsAt("2026-10-10T06:00:00.000Z", config)).toBeNull(); // midnight
    });

    it("on the day the clocks go back, 1 am until 7 am still ends at 7 am on the new time", () => {
      const config = { ...BOISE, askCutoff: "01:00" };
      // 1 am comes twice on Nov 1 (07:00Z and 08:00Z). Either way 3 am is inside, and 7 am is 14:00Z.
      expect(endsAt("2026-11-01T06:30:00.000Z", config)).toBeNull(); // half past midnight
      expect(endsAt("2026-11-01T10:00:00.000Z", config)).toBe("2026-11-01T14:00:00.000Z"); // 3 am
      expect(endsAt("2026-11-01T14:00:00.000Z", config)).toBeNull();
    });
  });

  it("can cover almost the whole day", () => {
    // Asking allowed only between 7 am and 9 am.
    const config = { ...BOISE, askCutoff: "09:00" };
    expect(endsAt("2026-10-09T13:00:00.000Z", config)).toBeNull(); // 7 am
    expect(endsAt("2026-10-09T14:59:59.999Z", config)).toBeNull();
    expect(endsAt("2026-10-09T15:00:00.000Z", config)).toBe("2026-10-10T13:00:00.000Z"); // 9 am, until tomorrow at 7
    expect(endsAt("2026-10-10T08:00:00.000Z", config)).toBe("2026-10-10T13:00:00.000Z"); // 2 am
  });

  it("are never on when the cutoff and the delivery time are the same", () => {
    const config = { ...BOISE, askCutoff: "07:00" };
    for (const at of ["2026-10-09T12:59:59.999Z", "2026-10-09T13:00:00.000Z", "2026-10-09T13:00:00.001Z", "2026-10-10T06:00:00.000Z", "2026-11-01T08:30:00.000Z"]) {
      expect(endsAt(at, config)).toBeNull();
    }
  });

  it("follows the configured time zone", () => {
    // India is UTC+5:30 all year: 11 pm is 17:30Z and 7 am is 01:30Z.
    const config = { ...BOISE, timeZone: "Asia/Kolkata" };
    expect(endsAt("2026-10-09T17:29:59.999Z", config)).toBeNull();
    expect(endsAt("2026-10-09T17:30:00.000Z", config)).toBe("2026-10-10T01:30:00.000Z");
    expect(endsAt("2026-10-10T01:30:00.000Z", config)).toBeNull();
    // The same instants are mid-afternoon in Boise.
    expect(endsAt("2026-10-09T17:30:00.000Z")).toBeNull();
  });
});
