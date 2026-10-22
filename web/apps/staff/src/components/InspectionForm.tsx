import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import {
  blankFormState,
  buildValues,
  draftGaps
} from "../domain/inspectionForm";
import type { InspectionFormState } from "../domain/inspectionForm";
import type { AssetRecord, InspectionCreateValues, InspectionType } from "../domain/types";
import { InspectionFormFields } from "./InspectionFormFields";

interface InspectionFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InspectionCreateValues) => Promise<void>;
}

export function InspectionForm({
  assetOptions,
  open,
  onClose,
  onSubmit
}: InspectionFormProps) {
  const [assetId, setAssetId] = useState("");
  const [inspectionType, setInspectionType] = useState<InspectionType>("SERVICE");
  const [form, setForm] = useState<InspectionFormState>(() => blankFormState(null));
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // A new inspection starts with no asset chosen; the pressures follow the asset.
    setAssetId("");
    setInspectionType("SERVICE");
    setForm(blankFormState(null));
    setError(null);
  }, [open]);

  if (!open) {
    return null;
  }

  function chooseAsset(nextAssetId: string) {
    setAssetId(nextAssetId);
    const next = assetOptions.find((option) => option.id === nextAssetId);
    // The rating belongs to the chosen asset's product and bore, so nothing typed for
    // another asset carries over.
    setForm(blankFormState(next?.pressureRating ?? null));
    setError(null);
  }

  const gaps = draftGaps(form);
  const built = buildValues(form);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assetId || !built) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        assetId,
        inspectionType,
        result: built.result,
        pressureTest: built.pressureTest
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The inspection could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Add Inspection</h2>
            <p>Start a draft inspection and capture the pressure test, measurements and condition checks.</p>
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
            onChange={(event) => chooseAsset(event.target.value)}
          >
            <option value="">Select an asset</option>
            {assetOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.assetNumber} - {option.customer.name}
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
        {assetId ? (
          <InspectionFormFields idPrefix="inspection-form" state={form} onChange={setForm} />
        ) : (
          <p className="field-hint">Choose an asset to enter the inspection.</p>
        )}
        {assetId && gaps.length > 0 ? (
          <p className="field-hint" role="status">
            To save a draft, still needed: {gaps.join(", ")}.
          </p>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={isSubmitting || !assetId || !built}
            type="submit"
          >
            {isSubmitting ? "Saving..." : "Save inspection"}
          </button>
        </div>
      </form>
    </div>
  );
}
