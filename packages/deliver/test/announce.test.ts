// Synthetic test data: every title and link in this file is made up. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { factText, failureText, morningAlarmAt, morningText } from "../src/index.ts";

const BOISE = { askCutoff: "23:00", deliverTime: "07:00", timeZone: "America/Boise" };
const MINUTE = 60_000;
/** A Boise wall-clock time on Oct 10, 2026 (summer time, UTC-6) as a Date. */
const boise = (hhmm: string, day = 10) => new Date(`2026-10-${String(day).padStart(2, "0")}T${hhmm}:00-06:00`);

describe("morningAlarmAt", () => {
  it("at 06:30, the normal run, the alarm waits for 07:00", () => {
    expect(morningAlarmAt(boise("06:30"), BOISE)).toEqual(boise("07:00"));
  });

  it("at 09:00, a late run, the alarm rings two minutes from now", () => {
    expect(morningAlarmAt(boise("09:00"), BOISE)).toEqual(boise("09:02"));
  });

  it("during the day and the evening (build-now), the alarm rings two minutes from now", () => {
    expect(morningAlarmAt(boise("15:00"), BOISE)).toEqual(boise("15:02"));
    expect(morningAlarmAt(boise("22:30"), BOISE)).toEqual(boise("22:32"));
    expect(morningAlarmAt(boise("22:57"), BOISE)).toEqual(boise("22:59"));
  });

  it("nothing buzzes at night: anywhere in quiet hours the alarm waits for 07:00, however far away that is", () => {
    expect(morningAlarmAt(boise("23:00"), BOISE)).toEqual(boise("07:00", 11));
    expect(morningAlarmAt(boise("23:59"), BOISE)).toEqual(boise("07:00", 11));
    expect(morningAlarmAt(boise("01:00"), BOISE)).toEqual(boise("07:00"));
    expect(morningAlarmAt(boise("04:59"), BOISE)).toEqual(boise("07:00"));
    expect(morningAlarmAt(boise("05:00"), BOISE)).toEqual(boise("07:00"));
  });

  it("an alarm two minutes out that would land inside quiet hours waits for the morning too", () => {
    expect(morningAlarmAt(boise("22:58"), BOISE)).toEqual(boise("07:00", 11));
    expect(morningAlarmAt(boise("22:59"), BOISE)).toEqual(boise("07:00", 11));
  });

  it("never sets an alarm less than two minutes ahead", () => {
    expect(morningAlarmAt(boise("06:59"), BOISE)).toEqual(boise("07:01"));
    // At 07:00 sharp quiet hours are over and the next 07:00 is tomorrow.
    expect(morningAlarmAt(boise("07:00"), BOISE)).toEqual(boise("07:02"));
  });

  it("follows ASK_CUTOFF, DELIVER_TIME and the time zone from the settings", () => {
    const now = new Date("2026-10-10T12:30:00.000Z");
    expect(morningAlarmAt(now, { askCutoff: "23:00", deliverTime: "08:15", timeZone: "America/Boise" })).toEqual(boise("08:15"));
    // 12:30 UTC is 08:30 in New York: 07:00 there is long past.
    expect(morningAlarmAt(now, { askCutoff: "23:00", deliverTime: "07:00", timeZone: "America/New_York" })).toEqual(new Date(now.getTime() + 2 * MINUTE));
    // An early cutoff makes the evening quiet as well.
    expect(morningAlarmAt(boise("21:30"), { askCutoff: "21:00", deliverTime: "07:00", timeZone: "America/Boise" })).toEqual(boise("07:00", 11));
  });

  it("with no quiet hours set (the same time for both), only a DELIVER_TIME less than two hours away is waited for", () => {
    const none = { askCutoff: "07:00", deliverTime: "07:00", timeZone: "America/Boise" };
    expect(morningAlarmAt(boise("06:30"), none)).toEqual(boise("07:00"));
    expect(morningAlarmAt(boise("05:00"), none)).toEqual(boise("07:00"));
    expect(morningAlarmAt(boise("04:59"), none)).toEqual(boise("05:01"));
    expect(morningAlarmAt(boise("23:59"), none)).toEqual(boise("00:01", 11));
  });

  it("uses winter time once the clocks have changed, also on the night they change", () => {
    // Nov 2, 2026 is after the change: Boise is UTC-7, so 06:30 local is 13:30 UTC.
    expect(morningAlarmAt(new Date("2026-11-02T13:30:00.000Z"), BOISE)).toEqual(new Date("2026-11-02T14:00:00.000Z"));
    // Nov 1, 2026, 00:30 summer time (06:30 UTC): the clocks go back at 02:00; 07:00 winter time is 14:00 UTC.
    expect(morningAlarmAt(new Date("2026-11-01T06:30:00.000Z"), BOISE)).toEqual(new Date("2026-11-01T14:00:00.000Z"));
    // Mar 14, 2027, 01:30 winter time (08:30 UTC): the clocks go forward at 02:00; 07:00 summer time is 13:00 UTC.
    expect(morningAlarmAt(new Date("2027-03-14T08:30:00.000Z"), BOISE)).toEqual(new Date("2027-03-14T13:00:00.000Z"));
  });
});

describe("the words", () => {
  it("the morning to-do is exactly the agreed text", () => {
    expect(morningText("Tip splitter", "https://made-up-owner.github.io/overnight-apps/tip-splitter/")).toBe(
      "☀️ Built overnight: Tip splitter → https://made-up-owner.github.io/overnight-apps/tip-splitter/",
    );
  });

  it("the failure to-do is exactly the agreed text", () => {
    expect(failureText("Tip splitter")).toBe("🌙 Couldn't finish Tip splitter, details on the dashboard");
  });

  it("the fact names the app, the local day and the link", () => {
    const url = "https://made-up-owner.github.io/overnight-apps/tip-splitter/";
    expect(factText("Tip splitter", url, boise("06:35"), "America/Boise")).toBe(`Overnight built "Tip splitter" on Oct 10: ${url}`);
    // 23:30 in Boise is already the next day in UTC; the fact uses the wearer's day.
    expect(factText("Tip splitter", url, boise("23:30"), "America/Boise")).toBe(`Overnight built "Tip splitter" on Oct 10: ${url}`);
  });

  it("keeps a title with stray line breaks on one line", () => {
    expect(morningText("Tip\n  splitter ", "https://x.example/")).toBe("☀️ Built overnight: Tip splitter → https://x.example/");
    expect(failureText(" Tip\tsplitter")).toBe("🌙 Couldn't finish Tip splitter, details on the dashboard");
  });
});
