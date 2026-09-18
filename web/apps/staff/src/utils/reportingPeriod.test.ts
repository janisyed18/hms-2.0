import { describe, expect, it } from "vitest";

import { reportingPeriodForPreset, reportingPeriodFromDates } from "./reportingPeriod";

describe("reportingPeriod", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");

  it("builds exact UTC windows for quick reporting presets", () => {
    expect(reportingPeriodForPreset("last_hour", now)).toMatchObject({
      label: "Last 1 hour",
      startAt: "2026-09-18T11:00:00.000Z",
      endAt: "2026-09-18T12:00:00.000Z"
    });
    expect(reportingPeriodForPreset("last_month", now)).toMatchObject({
      label: "Last 1 month",
      startAt: "2026-08-19T12:00:00.000Z"
    });
  });

  it("treats a custom end date as inclusive while sending a half-open API window", () => {
    expect(reportingPeriodFromDates("2026-09-01", "2026-09-18")).toEqual({
      preset: "custom",
      label: "Sep 1 - Sep 18, 2026",
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-19T00:00:00.000Z",
      startDate: "2026-09-01",
      endDate: "2026-09-18"
    });
  });
});
