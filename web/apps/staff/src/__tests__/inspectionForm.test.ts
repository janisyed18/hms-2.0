import { describe, expect, it } from "vitest";

import {
  CONDITION_CHECKS,
  blankFormState,
  buildValues,
  draftGaps,
  fieldErrors,
  isPressureOverridden,
  passAllConditions,
  stateFromInspection,
  submitGaps
} from "../domain/inspectionForm";
import type { InspectionFormState } from "../domain/inspectionForm";
import type { InspectionRecord } from "../domain/types";

const rating = { workingPressureKpa: 1500, testPressureKpa: 2250 };

function filled(overrides: Partial<InspectionFormState> = {}): InspectionFormState {
  return {
    ...passAllConditions(blankFormState(rating)),
    instruction: "PASS",
    certificateResult: "PASS",
    pressureTestResult: "PASS",
    testMinutes: "5",
    ohmsEndA: "0.1",
    ohmsEndB: "0.2",
    ohmsTotal: "0.3",
    notes: "No leaks.",
    ...overrides
  };
}

function recordFrom(state: InspectionFormState): InspectionRecord {
  const built = buildValues(state)!;
  return {
    id: "i1",
    result: built.result,
    pressureTest: {
      id: "p1",
      appliedPressureKpa: built.pressureTest.appliedPressureKpa,
      holdTimeSeconds: built.pressureTest.holdTimeSeconds,
      passed: built.pressureTest.passed,
      measurements: built.pressureTest.measurements
    }
  } as unknown as InspectionRecord;
}

describe("inspection form defaults", () => {
  it("prefills the pressures from the product rating and nothing else", () => {
    const state = blankFormState(rating);
    expect(state.workingPressureKpa).toBe("1500");
    expect(state.testPressureKpa).toBe("2250");
    expect(state.testMinutes).toBe("");
    expect(state.instruction).toBe("");
    expect(state.certificateResult).toBe("");
    expect(state.pressureTestResult).toBe("");
    expect(Object.values(state.conditions).every((value) => value === "")).toBe(true);
  });

  it("invents no pressure when the product has no rating", () => {
    const state = blankFormState(null);
    expect(state.workingPressureKpa).toBe("");
    expect(state.testPressureKpa).toBe("");
  });

  it("notices an override of either rated pressure", () => {
    expect(isPressureOverridden(blankFormState(rating))).toBe(false);
    expect(isPressureOverridden({ ...blankFormState(rating), testPressureKpa: "2400" })).toBe(true);
    expect(isPressureOverridden({ ...blankFormState(rating), workingPressureKpa: "1400" })).toBe(true);
    expect(isPressureOverridden(blankFormState(null))).toBe(false);
  });
});

describe("serialising the form", () => {
  it("stores every field under the documented schema, with the duration in seconds", () => {
    const built = buildValues(filled({ workingPressureKpa: "1400" }))!;
    expect(built.result).toBe("PASS");
    expect(built.pressureTest).toMatchObject({
      appliedPressureKpa: 2250,
      holdTimeSeconds: 300,
      passed: true
    });
    expect(built.pressureTest.measurements).toEqual({
      schema_version: 1,
      working_pressure_kpa: 1400,
      rated_working_pressure_kpa: 1500,
      rated_test_pressure_kpa: 2250,
      test_duration_minutes: 5,
      ohms_end_a: 0.1,
      ohms_end_b: 0.2,
      ohms_total: 0.3,
      conditions: Object.fromEntries(CONDITION_CHECKS.map(({ key }) => [key, "PASS"])),
      certificate_result: "PASS",
      notes: "No leaks."
    });
  });

  it.each([
    ["1", 60],
    ["5", 300],
    ["10", 600]
  ] as const)("maps %s minutes to %s seconds", (minutes, seconds) => {
    expect(buildValues(filled({ testMinutes: minutes }))!.pressureTest.holdTimeSeconds).toBe(seconds);
  });

  it("keeps the instruction, certificate result and pressure test result separate", () => {
    const built = buildValues(
      filled({ instruction: "REPAIR", certificateResult: "FAIL", pressureTestResult: "PASS" })
    )!;
    expect(built.result).toBe("REPAIR");
    expect(built.pressureTest.passed).toBe(true);
    expect(built.pressureTest.measurements).toMatchObject({ certificate_result: "FAIL" });
  });

  it("carries each condition answer exactly, including a failed one", () => {
    const state = filled();
    state.conditions.kink_or_dent = "FAIL";
    const saved = buildValues(state)!.pressureTest.measurements as {
      conditions: Record<string, string>;
    };
    expect(saved.conditions.kink_or_dent).toBe("FAIL");
    expect(saved.conditions.chemical_attack).toBe("PASS");
    expect(Object.keys(saved.conditions)).toHaveLength(7);
  });

  it("saves only what has been answered so a draft is not padded with guesses", () => {
    const state = { ...blankFormState(rating), testMinutes: "5" as const, pressureTestResult: "PASS" as const };
    const saved = buildValues(state)!.pressureTest.measurements!;
    expect(saved).not.toHaveProperty("conditions");
    expect(saved).not.toHaveProperty("certificate_result");
    expect(saved).not.toHaveProperty("ohms_end_a");
    expect(buildValues(state)!.result).toBeNull();
  });

  it("records a missing rating as null, not zero", () => {
    const state = { ...filled(), rating: null };
    const saved = buildValues(state)!.pressureTest.measurements!;
    expect(saved.rated_working_pressure_kpa).toBeNull();
    expect(saved.rated_test_pressure_kpa).toBeNull();
  });

  it("round-trips through save and reload", () => {
    const state = filled({ instruction: "REPAIR", certificateResult: "FAIL" });
    state.conditions.wire_corrosion = "FAIL";
    expect(stateFromInspection(recordFrom(state), null)).toEqual(state);
  });

  it("keeps an override visible after reload even if the product rating changes", () => {
    const state = filled({ testPressureKpa: "2400" });
    const reloaded = stateFromInspection(recordFrom(state), { workingPressureKpa: 1, testPressureKpa: 2 });
    expect(reloaded.rating).toEqual(rating);
    expect(isPressureOverridden(reloaded)).toBe(true);
  });
});

describe("what must be filled in", () => {
  it("needs a test pressure, test time and pressure test result to save a draft", () => {
    expect(draftGaps(blankFormState(rating))).toEqual(["Test time", "Pressure test result"]);
    expect(draftGaps(blankFormState(null))).toContain("Test pressure");
    expect(buildValues(blankFormState(rating))).toBeNull();
  });

  it("needs every field of the customer form to submit", () => {
    expect(submitGaps(filled())).toEqual([]);
    const gaps = submitGaps(blankFormState(rating));
    expect(gaps).toEqual(
      expect.arrayContaining([
        "Test time",
        "Instruction",
        "Certificate result",
        "Ohms end A",
        "Ohms end B",
        "Ohms total",
        "Evidence of kink or dent damage"
      ])
    );
    expect(gaps).toHaveLength(3 + 3 + 2 + 7 - 1);
  });

  it("rejects bad numbers", () => {
    expect(fieldErrors({ ...filled(), ohmsEndA: "-1", testPressureKpa: "abc" })).toMatchObject({
      ohmsEndA: expect.any(String),
      testPressureKpa: expect.any(String)
    });
    expect(buildValues({ ...filled(), ohmsEndA: "-1" })).toBeNull();
    expect(fieldErrors({ ...filled(), notes: "x".repeat(2001) }).notes).toBeDefined();
    expect(fieldErrors(filled())).toEqual({});
  });
});

describe("Pass all", () => {
  it("answers every condition Pass and leaves the rest alone", () => {
    const state = passAllConditions({ ...blankFormState(rating), notes: "keep" });
    expect(Object.values(state.conditions).every((value) => value === "PASS")).toBe(true);
    expect(state.notes).toBe("keep");
    expect(state.certificateResult).toBe("");
  });
});
