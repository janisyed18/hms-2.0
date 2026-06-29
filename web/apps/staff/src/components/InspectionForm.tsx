import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import type {
  AssetRecord,
  InspectionCreateValues,
  InspectionType,
  PressureTestValues
} from "../domain/types";

interface InspectionFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InspectionCreateValues) => Promise<void>;
}

function measurementsFromNote(note: string): Record<string, unknown> | null {
  const trimmed = note.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex > 0) {
    return {
      [trimmed.slice(0, separatorIndex).trim()]: trimmed
        .slice(separatorIndex + 1)
        .trim()
    };
  }
  return { note: trimmed };
}

export function InspectionForm({
  assetOptions,
  open,
  onClose,
  onSubmit
}: InspectionFormProps) {
  const [assetId, setAssetId] = useState("");
  const [inspectionType, setInspectionType] = useState<InspectionType>("SERVICE");
  const [result, setResult] = useState("REVIEW");
  const [appliedPressureKpa, setAppliedPressureKpa] = useState("1500");
  const [holdTimeSeconds, setHoldTimeSeconds] = useState("300");
  const [passed, setPassed] = useState(true);
  const [measurementNote, setMeasurementNote] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setAssetId(assetOptions[0]?.id ?? "");
    setInspectionType("SERVICE");
    setResult("REVIEW");
    setAppliedPressureKpa("1500");
    setHoldTimeSeconds("300");
    setPassed(true);
    setMeasurementNote("");
  }, [assetOptions, open]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pressureTest: PressureTestValues = {
      appliedPressureKpa: Number(appliedPressureKpa),
      holdTimeSeconds: Number(holdTimeSeconds),
      passed,
      measurements: measurementsFromNote(measurementNote)
    };
    setSubmitting(true);
    await onSubmit({
      assetId,
      inspectionType,
      result: result || null,
      pressureTest
    });
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Add Inspection</h2>
            <p>Start a draft inspection and capture pressure-test results.</p>
          </div>
          <button
            aria-label="Close form"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Asset</span>
          <select
            aria-label="Inspection asset"
            required
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
          >
            {assetOptions.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.assetNumber} - {asset.customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Inspection type</span>
          <select
            aria-label="Inspection type"
            value={inspectionType}
            onChange={(event) =>
              setInspectionType(event.target.value as InspectionType)
            }
          >
            <option value="SERVICE">Service</option>
            <option value="NEW_ASSET">New asset</option>
          </select>
        </label>
        <label>
          <span>Result</span>
          <select
            aria-label="Inspection result"
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value="REVIEW">Review</option>
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
          </select>
        </label>
        <label>
          <span>Applied pressure kPa</span>
          <input
            aria-label="Applied pressure kPa"
            inputMode="numeric"
            min="0"
            required
            type="number"
            value={appliedPressureKpa}
            onChange={(event) => setAppliedPressureKpa(event.target.value)}
          />
        </label>
        <label>
          <span>Hold time seconds</span>
          <input
            aria-label="Hold time seconds"
            inputMode="numeric"
            min="0"
            required
            type="number"
            value={holdTimeSeconds}
            onChange={(event) => setHoldTimeSeconds(event.target.value)}
          />
        </label>
        <label className="checkbox-field">
          <input
            aria-label="Pressure test passed"
            checked={passed}
            type="checkbox"
            onChange={(event) => setPassed(event.target.checked)}
          />
          <span>Pressure test passed</span>
        </label>
        <label>
          <span>Measurement notes</span>
          <input
            aria-label="Measurement notes"
            placeholder="leak=none"
            value={measurementNote}
            onChange={(event) => setMeasurementNote(event.target.value)}
          />
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Saving..." : "Save inspection"}
          </button>
        </div>
      </form>
    </div>
  );
}
