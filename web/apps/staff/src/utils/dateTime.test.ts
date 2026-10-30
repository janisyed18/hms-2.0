import { formatDateTime } from "./dateTime";

describe("formatDateTime", () => {
  it("shows a system timestamp in UTC and says so, whatever zone the machine is in", () => {
    // CLDR spells the month "Jul" or "July" by version; the rest is what is under test.
    expect(formatDateTime("2026-07-16T12:34:56Z")).toMatch(/^Thu, 16 July? 2026, 12:34 pm UTC$/);
  });
});
