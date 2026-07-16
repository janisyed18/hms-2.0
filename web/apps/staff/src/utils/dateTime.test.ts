import { formatDateTime } from "./dateTime";

describe("formatDateTime", () => {
  it("renders API timestamps in the existing staff format", () => {
    expect(formatDateTime("2026-07-16T12:34:56Z")).toBe(
      "2026-07-16 12:34:56"
    );
  });
});
