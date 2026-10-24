import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayLengthMinutes,
  formatTime,
  minutesIntoDay,
  startOfWeek,
  weekdayIndex,
  ymdOf,
  zoneLabel,
  zonedMidnight
} from "../scheduling/zonedTime";

const SYDNEY = "Australia/Sydney";
const originalZone = process.env.TZ;

afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe("zoned calendar arithmetic", () => {
  it("finds local midnight as a UTC instant, with and without daylight saving", () => {
    // AEDT (+11) in January, AEST (+10) in July.
    expect(new Date(zonedMidnight("2027-01-15", SYDNEY)).toISOString()).toBe("2027-01-14T13:00:00.000Z");
    expect(new Date(zonedMidnight("2027-07-15", SYDNEY)).toISOString()).toBe("2027-07-14T14:00:00.000Z");
    expect(new Date(zonedMidnight("2027-07-15", "Australia/Perth")).toISOString()).toBe("2027-07-14T16:00:00.000Z");
  });

  it("knows a daylight-saving day is not 24 hours long", () => {
    expect(dayLengthMinutes("2026-10-04", SYDNEY)).toBe(23 * 60); // clocks go forward
    expect(dayLengthMinutes("2027-04-04", SYDNEY)).toBe(25 * 60); // clocks go back
    expect(dayLengthMinutes("2027-03-01", SYDNEY)).toBe(24 * 60);
  });

  it("measures elapsed time into the day, not clock-face time, across the change", () => {
    // 09:00 local on the 25-hour day is ten elapsed hours after midnight.
    const nineAm = new Date("2027-04-03T23:00:00Z"); // 09:00 AEST (+10) on 4 April
    expect(minutesIntoDay(nineAm, "2027-04-04", SYDNEY)).toBe(10 * 60);
  });

  it("assigns an instant to the local date, not the UTC date", () => {
    expect(ymdOf("2027-03-01T13:30:00Z", SYDNEY)).toBe("2027-03-02");
    expect(ymdOf("2027-03-01T13:30:00Z", "UTC")).toBe("2027-03-01");
  });

  it("does arithmetic on calendar dates", () => {
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2027-12-15", 1)).toBe("2028-01-15");
    expect(weekdayIndex("2027-03-01")).toBe(0); // a Monday
    expect(startOfWeek("2027-03-07")).toBe("2027-03-01"); // Sunday -> its Monday
  });

  it("labels the zone", () => {
    expect(zoneLabel("2027-01-15T00:00:00Z", SYDNEY)).toMatch(/AEDT|GMT\+11/);
    expect(formatTime("2027-03-01T00:00:00Z", SYDNEY)).toBe("11:00 am");
  });

  it.each(["UTC", "Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"])(
    "gives identical answers whatever zone the browser is set to (%s)",
    (browserZone) => {
      process.env.TZ = browserZone;
      expect(formatTime("2027-03-01T00:00:00Z", SYDNEY)).toBe("11:00 am");
      expect(ymdOf("2027-03-01T13:30:00Z", SYDNEY)).toBe("2027-03-02");
      expect(new Date(zonedMidnight("2027-03-02", SYDNEY)).toISOString()).toBe("2027-03-01T13:00:00.000Z");
      expect(dayLengthMinutes("2027-04-04", SYDNEY)).toBe(1500);
    }
  );
});
