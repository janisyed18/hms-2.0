// The customer's inspection form: the fields, how they map to the stored measurements
// (schema version 1, see backend/src/hms_backend/app/modules/inspections/
// measurements.py) and what must be filled in before an inspection is submitted.
// The inspector app carries the same definitions in its own copy; a backend test
// keeps the condition keys of the three in step.

import type { InspectionRecord, PressureTestValues } from "./types";

export type PassFail = "PASS" | "FAIL";
export type Instruction = "PASS" | "REPAIR";

export const TEST_DURATION_MINUTES = [1, 5, 10] as const;

export const INSTRUCTION_OPTIONS: ReadonlyArray<{ value: Instruction; label: string }> = [
  { value: "PASS", label: "Pass" },
  { value: "REPAIR", label: "Repair" }
];

export const PASS_FAIL_OPTIONS: ReadonlyArray<{ value: PassFail; label: string }> = [
  { value: "PASS", label: "Pass" },
  { value: "FAIL", label: "Fail" }
];

// A "Pass" answers "no" to the question: no defect was found.
export const CONDITION_CHECKS = [
  { key: "chemical_attack", label: "Chemical attack or damage to outer carcass?" },
  { key: "rust_in_fittings", label: "Excessive rust inside or outside the fittings?" },
  { key: "end_fitting_damage", label: "End fittings show signs of damage or displacement?" },
  { key: "kink_or_dent", label: "Evidence of kink or dent damage?" },
  {
    key: "fitting_seal_damage",
    label: "Fitting ends damaged or deformed in a way that they may not form a good seal?"
  },
  { key: "wire_corrosion", label: "Outer wire shows signs of abrasion or corroding?" },
  { key: "bend_at_fitting", label: "Signs of hose being bent or kinked just before the fitting?" }
] as const;

export type ConditionKey = (typeof CONDITION_CHECKS)[number]["key"];

export interface PressureRating {
  workingPressureKpa: number;
  testPressureKpa: number;
}

export interface InspectionFormState {
  instruction: "" | Instruction;
  certificateResult: "" | PassFail;
  pressureTestResult: "" | PassFail;
  workingPressureKpa: string;
  testPressureKpa: string;
  testMinutes: "" | "1" | "5" | "10";
  ohmsEndA: string;
  ohmsEndB: string;
  ohmsTotal: string;
  conditions: Record<ConditionKey, "" | PassFail>;
  notes: string;
  // The product's rating the pressures were defaulted from (null when it has none).
  rating: PressureRating | null;
}

export const MAX_NOTES_LENGTH = 2000;

function blankConditions(): Record<ConditionKey, "" | PassFail> {
  return Object.fromEntries(CONDITION_CHECKS.map(({ key }) => [key, ""])) as Record<
    ConditionKey,
    "" | PassFail
  >;
}

/** A new form: pressures come from the product rating, everything else is unanswered. */
export function blankFormState(rating: PressureRating | null): InspectionFormState {
  return {
    instruction: "",
    certificateResult: "",
    pressureTestResult: "",
    workingPressureKpa: rating ? String(rating.workingPressureKpa) : "",
    testPressureKpa: rating ? String(rating.testPressureKpa) : "",
    testMinutes: "",
    ohmsEndA: "",
    ohmsEndB: "",
    ohmsTotal: "",
    conditions: blankConditions(),
    notes: "",
    rating
  };
}

function text(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function passFail(value: unknown): "" | PassFail {
  return value === "PASS" || value === "FAIL" ? value : "";
}

function legacyNote(measurements: Record<string, unknown>): string {
  const entries = Object.entries(measurements).filter(
    ([key]) => !["schema_version", "working_pressure_kpa"].includes(key)
  );
  return entries.map(([key, value]) => `${key}=${String(value)}`).join("; ");
}

/** The form as it was saved: what a reload, a reviewer or a draft edit shows. */
export function stateFromInspection(
  inspection: InspectionRecord,
  rating: PressureRating | null
): InspectionFormState {
  const test = inspection.pressureTest;
  const measurements = test?.measurements ?? {};
  const isCurrent = measurements.schema_version === 1;
  const minutes = text(measurements.test_duration_minutes);
  const conditions = blankConditions();
  const saved = (measurements.conditions ?? {}) as Record<string, unknown>;
  for (const { key } of CONDITION_CHECKS) conditions[key] = passFail(saved[key]);
  const ratedWorking = measurements.rated_working_pressure_kpa;
  const ratedTest = measurements.rated_test_pressure_kpa;
  return {
    instruction:
      inspection.result === "PASS" || inspection.result === "REPAIR" ? inspection.result : "",
    certificateResult: passFail(measurements.certificate_result),
    pressureTestResult: test ? (test.passed ? "PASS" : "FAIL") : "",
    // Nothing recorded yet (an inspection just started): the pressures default to the product rating.
    workingPressureKpa: test ? text(measurements.working_pressure_kpa) : rating ? String(rating.workingPressureKpa) : "",
    testPressureKpa: test ? String(test.appliedPressureKpa) : rating ? String(rating.testPressureKpa) : "",
    testMinutes: (["1", "5", "10"] as const).find((option) => option === minutes) ?? "",
    ohmsEndA: text(measurements.ohms_end_a),
    ohmsEndB: text(measurements.ohms_end_b),
    ohmsTotal: text(measurements.ohms_total),
    conditions,
    notes: isCurrent ? text(measurements.notes) : legacyNote(measurements),
    // What the record was defaulted from wins over today's rating, so an override
    // stays visible if the product rating changes later.
    rating:
      typeof ratedWorking === "number" && typeof ratedTest === "number"
        ? { workingPressureKpa: ratedWorking, testPressureKpa: ratedTest }
        : isCurrent
          ? null
          : rating
  };
}

const wholeNumber = /^\d+$/;
const decimal = /^\d+(\.\d+)?$/;

function positiveWhole(value: string): number | null {
  const trimmed = value.trim();
  if (!wholeNumber.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 && parsed <= 10_000_000 ? parsed : null;
}

function nonNegative(value: string): number | null {
  const trimmed = value.trim();
  if (!decimal.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

export function isPressureOverridden(state: InspectionFormState): boolean {
  if (!state.rating) return false;
  const working = positiveWhole(state.workingPressureKpa);
  const test = positiveWhole(state.testPressureKpa);
  return (
    (working !== null && working !== state.rating.workingPressureKpa) ||
    (test !== null && test !== state.rating.testPressureKpa)
  );
}

/** Field-level problems with what has been typed so far (empty fields are not errors). */
export function fieldErrors(state: InspectionFormState): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  if (state.workingPressureKpa.trim() && positiveWhole(state.workingPressureKpa) === null) {
    errors.workingPressureKpa = "Enter a whole number of kPa greater than 0.";
  }
  if (state.testPressureKpa.trim() && positiveWhole(state.testPressureKpa) === null) {
    errors.testPressureKpa = "Enter a whole number of kPa greater than 0.";
  }
  for (const [field, label] of [
    ["ohmsEndA", "Ohms end A"],
    ["ohmsEndB", "Ohms end B"],
    ["ohmsTotal", "Ohms total"]
  ] as const) {
    if (state[field].trim() && nonNegative(state[field]) === null) {
      errors[field] = `${label} must be a number, 0 or more.`;
    }
  }
  if (state.notes.length > MAX_NOTES_LENGTH) {
    errors.notes = `Notes can be at most ${MAX_NOTES_LENGTH} characters.`;
  }
  return errors;
}

/** What is still needed to save a pressure test at all (a draft). */
export function draftGaps(state: InspectionFormState): string[] {
  const gaps: string[] = [];
  if (positiveWhole(state.testPressureKpa) === null) gaps.push("Test pressure");
  if (state.testMinutes === "") gaps.push("Test time");
  if (state.pressureTestResult === "") gaps.push("Pressure test result");
  return gaps;
}

/** What is still needed before the inspection can be submitted for review. */
export function submitGaps(state: InspectionFormState): string[] {
  const gaps = draftGaps(state);
  if (positiveWhole(state.workingPressureKpa) === null) gaps.push("Working pressure");
  if (state.instruction === "") gaps.push("Instruction");
  if (state.certificateResult === "") gaps.push("Certificate result");
  for (const [field, label] of [
    ["ohmsEndA", "Ohms end A"],
    ["ohmsEndB", "Ohms end B"],
    ["ohmsTotal", "Ohms total"]
  ] as const) {
    if (nonNegative(state[field]) === null) gaps.push(label);
  }
  for (const { key, label } of CONDITION_CHECKS) {
    if (state.conditions[key] === "") gaps.push(label.replace(/\?$/, ""));
  }
  return gaps;
}

export interface BuiltValues {
  result: string | null;
  pressureTest: PressureTestValues;
}

/** The API values for the form, or null while the pressure test cannot be saved yet. */
export function buildValues(state: InspectionFormState): BuiltValues | null {
  if (draftGaps(state).length > 0 || Object.keys(fieldErrors(state)).length > 0) return null;
  const answered = CONDITION_CHECKS.filter(({ key }) => state.conditions[key] !== "");
  const measurements: Record<string, unknown> = {
    schema_version: 1,
    rated_working_pressure_kpa: state.rating?.workingPressureKpa ?? null,
    rated_test_pressure_kpa: state.rating?.testPressureKpa ?? null,
    test_duration_minutes: Number(state.testMinutes)
  };
  const working = positiveWhole(state.workingPressureKpa);
  if (working !== null) measurements.working_pressure_kpa = working;
  for (const [field, key] of [
    ["ohmsEndA", "ohms_end_a"],
    ["ohmsEndB", "ohms_end_b"],
    ["ohmsTotal", "ohms_total"]
  ] as const) {
    const value = nonNegative(state[field]);
    if (value !== null) measurements[key] = value;
  }
  if (answered.length > 0) {
    measurements.conditions = Object.fromEntries(
      answered.map(({ key }) => [key, state.conditions[key]])
    );
  }
  if (state.certificateResult !== "") measurements.certificate_result = state.certificateResult;
  if (state.notes.trim()) measurements.notes = state.notes.trim();
  return {
    result: state.instruction || null,
    pressureTest: {
      appliedPressureKpa: positiveWhole(state.testPressureKpa) as number,
      holdTimeSeconds: Number(state.testMinutes) * 60,
      passed: state.pressureTestResult === "PASS",
      measurements
    }
  };
}

/** "Pass all": the customer form's shortcut, applied only when the user asks for it. */
export function passAllConditions(state: InspectionFormState): InspectionFormState {
  return {
    ...state,
    conditions: Object.fromEntries(CONDITION_CHECKS.map(({ key }) => [key, "PASS"])) as Record<
      ConditionKey,
      "" | PassFail
    >
  };
}
