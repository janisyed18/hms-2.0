import type { ChangeEvent } from "react";

import {
  CONDITION_CHECKS,
  INSTRUCTION_OPTIONS,
  MAX_NOTES_LENGTH,
  PASS_FAIL_OPTIONS,
  TEST_DURATION_MINUTES,
  fieldErrors,
  isPressureOverridden,
  passAllConditions
} from "../domain/inspectionForm";
import type { InspectionFormState } from "../domain/inspectionForm";

interface InspectionFormFieldsProps {
  idPrefix: string;
  state: InspectionFormState;
  onChange: (next: InspectionFormState) => void;
  disabled?: boolean;
}

/**
 * The customer's inspection fields, shared by the create form and the detail view so a
 * reviewer reads exactly what the inspector entered. Nothing is answered by default:
 * the pressures come from the product rating and everything else starts as "Select".
 */
export function InspectionFormFields({
  idPrefix,
  state,
  onChange,
  disabled = false
}: InspectionFormFieldsProps) {
  const errors = fieldErrors(state);
  const overridden = isPressureOverridden(state);
  const set =
    <K extends keyof InspectionFormState>(key: K) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange({ ...state, [key]: event.target.value } as InspectionFormState);

  function pressureHint() {
    if (!state.rating) {
      return "This product has no rating for the hose's bore. Enter the pressures.";
    }
    return overridden
      ? `Overridden. Product rating: ${state.rating.workingPressureKpa} kPa working, ${state.rating.testPressureKpa} kPa test.`
      : `Product rating: ${state.rating.workingPressureKpa} kPa working, ${state.rating.testPressureKpa} kPa test. You can override either value.`;
  }

  return (
    <>
      <label>
        <span>Instruction</span>
        <select
          aria-label="Instruction"
          disabled={disabled}
          value={state.instruction}
          onChange={set("instruction")}
        >
          <option value="">Select</option>
          {INSTRUCTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <fieldset className="inspection-pressure-fields" disabled={disabled}>
        <legend>Pressure test</legend>
        <label>
          <span>Working pressure (kPa)</span>
          <input
            aria-describedby={`${idPrefix}-pressure-hint`}
            aria-invalid={Boolean(errors.workingPressureKpa)}
            aria-label="Working pressure kPa"
            inputMode="numeric"
            value={state.workingPressureKpa}
            onChange={set("workingPressureKpa")}
          />
          {errors.workingPressureKpa ? <small className="form-error">{errors.workingPressureKpa}</small> : null}
        </label>
        <label>
          <span>Test pressure (kPa)</span>
          <input
            aria-describedby={`${idPrefix}-pressure-hint`}
            aria-invalid={Boolean(errors.testPressureKpa)}
            aria-label="Test pressure kPa"
            inputMode="numeric"
            value={state.testPressureKpa}
            onChange={set("testPressureKpa")}
          />
          {errors.testPressureKpa ? <small className="form-error">{errors.testPressureKpa}</small> : null}
        </label>
        <p className="field-hint" id={`${idPrefix}-pressure-hint`}>{pressureHint()}</p>
        <label>
          <span>Test time (min)</span>
          <select aria-label="Test time minutes" value={state.testMinutes} onChange={set("testMinutes")}>
            <option value="">Select</option>
            {TEST_DURATION_MINUTES.map((minutes) => (
              <option key={minutes} value={String(minutes)}>{minutes} min</option>
            ))}
          </select>
        </label>
        <label>
          <span>Pressure test result</span>
          <select
            aria-label="Pressure test result"
            value={state.pressureTestResult}
            onChange={set("pressureTestResult")}
          >
            <option value="">Select</option>
            {PASS_FAIL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="inspection-measurement-fields" disabled={disabled}>
        <legend>Resistance (ohms)</legend>
        {(
          [
            ["ohmsEndA", "Ohms end A"],
            ["ohmsEndB", "Ohms end B"],
            ["ohmsTotal", "Ohms total"]
          ] as const
        ).map(([field, label]) => (
          <label key={field}>
            <span>{label}</span>
            <input
              aria-invalid={Boolean(errors[field])}
              aria-label={label}
              inputMode="decimal"
              value={state[field]}
              onChange={set(field)}
            />
            {errors[field] ? <small className="form-error">{errors[field]}</small> : null}
          </label>
        ))}
      </fieldset>

      <fieldset className="inspection-condition-fields" disabled={disabled}>
        <legend>Hose condition</legend>
        <button
          className="secondary-button compact-action"
          disabled={disabled}
          onClick={() => onChange(passAllConditions(state))}
          type="button"
        >
          Pass all
        </button>
        {CONDITION_CHECKS.map(({ key, label }) => (
          <label key={key}>
            <span>{label}</span>
            <select
              aria-label={label}
              value={state.conditions[key]}
              onChange={(event) =>
                onChange({
                  ...state,
                  conditions: { ...state.conditions, [key]: event.target.value as "" | "PASS" | "FAIL" }
                })
              }
            >
              <option value="">Select</option>
              {PASS_FAIL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      <label>
        <span>Certificate result</span>
        <select
          aria-label="Certificate result"
          disabled={disabled}
          value={state.certificateResult}
          onChange={set("certificateResult")}
        >
          <option value="">Select</option>
          {PASS_FAIL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label>
        <span>Notes</span>
        <textarea
          aria-invalid={Boolean(errors.notes)}
          aria-label="Inspection notes"
          disabled={disabled}
          maxLength={MAX_NOTES_LENGTH + 100}
          rows={3}
          value={state.notes}
          onChange={set("notes")}
        />
        {errors.notes ? <small className="form-error">{errors.notes}</small> : null}
      </label>
    </>
  );
}
