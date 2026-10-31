import { describe, expect, it } from "vitest";

import { formatDay, formatRange, formatWithZone, resolveZone, viewerZone, zoneNote } from "../scheduling/zonedTime";

// Instants are written in UTC and the zone is always passed, so none of this depends on the machine's own zone.
const SYDNEY = "Australia/Sydney";
const WINTER = "2027-08-30T00:00:00Z"; // 10:00 am AEST (UTC+10)
const SUMMER = "2027-01-30T00:00:00Z"; // 11:00 am AEDT (UTC+11)

describe("a time is shown in a known zone, and the zone is named", () => {
  it("standard time: 10:00 am in Sydney, AEST", () => {
    expect(formatWithZone(WINTER, SYDNEY)).toBe("Mon, 30 Aug 2027, 10:00 am AEST");
    expect(zoneNote(WINTER, SYDNEY)).toBe("Australia/Sydney · AEST");
  });

  it("daylight time: the same UTC clock is an hour later, AEDT", () => {
    expect(formatWithZone(SUMMER, SYDNEY)).toBe("Sat, 30 Jan 2027, 11:00 am AEDT");
    expect(zoneNote(SUMMER, SYDNEY)).toBe("Australia/Sydney · AEDT");
  });

  it("converts once: the same instant reads differently only because the zone differs", () => {
    expect(formatWithZone(WINTER, "UTC")).toBe("Mon, 30 Aug 2027, 12:00 am UTC");
    expect(formatWithZone(WINTER, "Australia/Perth")).toContain("8:00 am");
    // Passing a time that is already "local" through the same zone does not shift it again.
    expect(formatWithZone(new Date(WINTER), SYDNEY)).toBe(formatWithZone(WINTER, SYDNEY));
  });

  it("the day follows the zone, not UTC: late evening UTC is already tomorrow in Sydney", () => {
    expect(formatDay("2027-08-29T20:00:00Z", SYDNEY)).toBe("Mon, 30 Aug 2027");
    expect(formatDay("2027-08-29T20:00:00Z", "UTC")).toBe("Sun, 29 Aug 2027");
  });

  it("a record with no zone is shown in UTC and labelled UTC, never in a guessed region", () => {
    for (const none of [null, undefined, "", "   "]) {
      expect(resolveZone(none)).toBe("UTC");
      expect(formatWithZone(WINTER, none)).toBe("Mon, 30 Aug 2027, 12:00 am UTC");
      expect(zoneNote(WINTER, none)).toBe("UTC");
    }
  });

  it("the clock change itself: 1:59 am AEST and 3:00 am AEDT are one minute apart", () => {
    // Sydney clocks go forward at 2:00 am on Sunday 3 October 2027.
    expect(formatWithZone("2027-10-02T15:59:00Z", SYDNEY)).toBe("Sun, 3 Oct 2027, 1:59 am AEST");
    expect(formatWithZone("2027-10-02T16:00:00Z", SYDNEY)).toBe("Sun, 3 Oct 2027, 3:00 am AEDT");
    // …and back on Sunday 4 April 2027: the 2:30 am hour happens twice and is told apart by its zone.
    expect(formatWithZone("2027-04-03T15:30:00Z", SYDNEY)).toBe("Sun, 4 Apr 2027, 2:30 am AEDT");
    expect(formatWithZone("2027-04-03T16:30:00Z", SYDNEY)).toBe("Sun, 4 Apr 2027, 2:30 am AEST");
  });

  it("a range names its zone once, and each end when a clock change falls inside it", () => {
    expect(formatRange(WINTER, "2027-08-30T01:00:00Z", SYDNEY)).toBe("10:00 am – 11:00 am");
    expect(formatRange("2027-10-02T15:30:00Z", "2027-10-02T16:30:00Z", SYDNEY)).toBe("1:30 am AEST – 3:30 am AEDT");
  });

  it("the viewer's own zone is a real zone name, for the places that have no site", () => {
    expect(viewerZone()).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$|^UTC$/);
  });
});
