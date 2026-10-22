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

interface InspectionFieldsProps {
  state: InspectionFormState;
  onChange: (next: InspectionFormState) => void;
  /** Read-only: the inspection has already been submitted for review. */
  disabled?: boolean;
}

/**
 * The customer's inspection fields. Nothing is answered by default: the pressures come
 * from the product rating (and can be overridden) and everything else starts unanswered.
 */
export function InspectionFields({ state, onChange, disabled = false }: InspectionFieldsProps) {
  const errors = fieldErrors(state);
  const overridden = isPressureOverridden(state);
  const set =
    <K extends keyof InspectionFormState>(key: K) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange({ ...state, [key]: event.target.value } as InspectionFormState);
  const hint = !state.rating
    ? "This product has no rating for the hose's bore. Enter the pressures."
    : overridden
      ? `Overridden. Product rating: ${state.rating.workingPressureKpa} kPa working, ${state.rating.testPressureKpa} kPa test.`
      : `Product rating: ${state.rating.workingPressureKpa} kPa working, ${state.rating.testPressureKpa} kPa test. You can override either value.`;

  return (
    <fieldset className="capture-form capture-form--fields capture-fieldset" disabled={disabled}>
      <label>
        <span>Instruction</span>
        <select aria-label="Instruction" value={state.instruction} onChange={set("instruction")}>
          <option value="">Select</option>
          {INSTRUCTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <fieldset className="capture-group">
        <legend>Pressure test</legend>
        <label>
          <span>Working pressure</span>
          <input
            aria-describedby="pressure-hint"
            aria-invalid={Boolean(errors.workingPressureKpa)}
            aria-label="Working pressure kPa"
            inputMode="numeric"
            value={state.workingPressureKpa}
            onChange={set("workingPressureKpa")}
          />
          <small>kPa</small>
          {errors.workingPressureKpa ? <em role="alert">{errors.workingPressureKpa}</em> : null}
        </label>
        <label>
          <span>Test pressure</span>
          <input
            aria-describedby="pressure-hint"
            aria-invalid={Boolean(errors.testPressureKpa)}
            aria-label="Test pressure kPa"
            inputMode="numeric"
            value={state.testPressureKpa}
            onChange={set("testPressureKpa")}
          />
          <small>kPa</small>
          {errors.testPressureKpa ? <em role="alert">{errors.testPressureKpa}</em> : null}
        </label>
        <p className="capture-hint" id="pressure-hint">{hint}</p>
        <label>
          <span>Test time</span>
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

      <fieldset className="capture-group">
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
            {errors[field] ? <em role="alert">{errors[field]}</em> : null}
          </label>
        ))}
      </fieldset>

      <fieldset className="capture-group">
        <legend>Hose condition</legend>
        <button
          className="secondary-action"
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
          value={state.certificateResult}
          onChange={set("certificateResult")}
        >
          <option value="">Select</option>
          {PASS_FAIL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="notes-field">
        <span>Notes</span>
        <textarea
          aria-invalid={Boolean(errors.notes)}
          aria-label="Notes"
          maxLength={MAX_NOTES_LENGTH + 100}
          onChange={set("notes")}
          placeholder="Inspection observations"
          value={state.notes}
        />
        {errors.notes ? <em role="alert">{errors.notes}</em> : null}
      </label>
    </fieldset>
  );
}
