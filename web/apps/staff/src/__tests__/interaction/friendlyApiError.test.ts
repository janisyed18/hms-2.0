import { describe, expect, it } from "vitest";

import { HmsApiError } from "../../api/hmsClient";
import { friendlyApiError, safeServerMessage } from "../../components/interaction/friendlyApiError";

const api = (status: number, message: string, details: unknown = null) => new HmsApiError(status, "code", message, details);

describe("friendlyApiError", () => {
  it.each([
    [403, /do not have permission/i],
    [404, /no longer exists/i],
    [413, /too large/i],
    [500, /unavailable/i],
    [503, /unavailable/i],
    [401, /session has ended/i]
  ])("explains a %i in plain words", (status, pattern) => {
    expect(friendlyApiError(api(status, "ignored by this category")).message).toMatch(pattern);
  });

  it("treats 404 and 409 as 'refresh before retrying' and 412 as a stale edit", () => {
    expect(friendlyApiError(api(404, "x")).needsRefresh).toBe(true);
    const conflict = friendlyApiError(api(409, "Serial number is already assigned to another asset."));
    expect(conflict.needsRefresh).toBe(true);
    expect(conflict.message).toContain("Serial number is already assigned to another asset.");
    expect(conflict.message).toMatch(/refresh to review the latest version/i);
    expect(friendlyApiError(api(412, "Precondition failed")).kind).toBe("conflict");
  });

  it("uses a business message for validation, but only when it is safe to show", () => {
    expect(friendlyApiError(api(422, "The serial number is already in use.")).message).toBe("The serial number is already in use.");
    const unsafe = friendlyApiError(api(422, 'Traceback (most recent call last): File "app.py", line 3'), { fallback: "Could not save." });
    expect(unsafe.message).toBe("Could not save.");
  });

  it("never passes SQL, stack traces, AWS details or exception names through", () => {
    for (const raw of [
      "psycopg.errors.UniqueViolation: duplicate key value violates unique constraint",
      "sqlalchemy.exc.IntegrityError: (asyncpg.exceptions.UniqueViolationError)",
      "INSERT INTO assets (id) VALUES ($1) RETURNING id",
      "arn:aws:iam::123456789012:role/hms-dev not authorized",
      "KeyError: 'asset' at /app/hms_backend/api/records.py:2210",
      "Internal server error"
    ]) {
      expect(safeServerMessage(raw)).toBeNull();
      for (const status of [400, 409, 422, 500]) {
        expect(friendlyApiError(api(status, raw), { fallback: "Try again." }).message).not.toContain(raw);
      }
    }
  });

  it("maps field-level validation to the form's own field names, without raw backend text", () => {
    const result = friendlyApiError(
      api(422, "HMS API request failed: 422", [
        { loc: ["body", "customer_serial_no"], msg: "Field required", type: "missing" },
        { loc: ["body", "asset_name"], msg: "String should have at least 1 character", type: "string_too_short" },
        { loc: ["body", "unknown_field"], msg: "nope" }
      ]),
      { fieldMap: { customer_serial_no: "serialNumber", asset_name: "assetName" } }
    );
    expect(result.fieldErrors).toEqual({ serialNumber: "This field is required.", assetName: "This value is too short." });
    expect(result.message).toMatch(/highlighted fields/i);
  });

  it("tells the user how long to wait after a 429, when the server said", () => {
    expect(friendlyApiError(api(429, "Too many", { retryAfterSeconds: 42 })).message).toBe("Too many requests. Try again in 42 seconds.");
    expect(friendlyApiError(api(429, "Too many", { retryAfterSeconds: 1 })).message).toBe("Too many requests. Try again in 1 second.");
    expect(friendlyApiError(api(429, "Too many")).message).toMatch(/wait a moment/i);
    expect(friendlyApiError(api(429, "Too many", { retryAfterSeconds: 42 })).retryAfterSeconds).toBe(42);
  });

  it("describes a network failure and falls back for anything unexpected", () => {
    expect(friendlyApiError(new TypeError("Failed to fetch")).message).toMatch(/could not be reached/i);
    expect(friendlyApiError(new Error("boom"), { fallback: "Could not save." }).message).toBe("Could not save.");
    expect(friendlyApiError("weird", { fallback: "Could not save." }).message).toBe("Could not save.");
  });
});
