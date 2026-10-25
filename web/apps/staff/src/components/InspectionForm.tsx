import { FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import {
  blankFormState,
  buildValues,
  draftGaps
} from "../domain/inspectionForm";
import type { InspectionFormState } from "../domain/inspectionForm";
import type { AssetRecord, InspectionCreateValues, InspectionType } from "../domain/types";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { InspectionFormFields } from "./InspectionFormFields";
import { assetLabel } from "../utils/identity";

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
  const [assetError, setAssetError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!open) return;
    // A new inspection starts with no asset chosen; the pressures follow the asset.
    setAssetId("");
    setInspectionType("SERVICE");
    setForm(blankFormState(null));
    setError(null);
    setAssetError(null);
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
    setAssetError(null);
  }

  const gaps = draftGaps(form);
  const built = buildValues(form);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    setError(null);
    if (!assetId) {
      setAssetError("Select the asset being inspected.");
      formRef.current?.querySelector<HTMLElement>('[data-field="assetId"]')?.focus();
      return;
    }
    if (!built) {
      setError(`To save a draft, still needed: ${gaps.join(", ")}.`);
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus(), 0);
      return;
    }
    lock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        assetId,
        inspectionType,
        result: built.result,
        pressureTest: built.pressureTest
      });
    } catch (reason: unknown) {
      setError(friendlyApiError(reason, { fallback: "The inspection could not be saved. Try again." }).message);
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus(), 0);
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" noValidate onSubmit={handleSubmit} ref={formRef}>
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
        {error ? <ActionNotice kind="error" title="Inspection not saved">{error}</ActionNotice> : null}
        <RequiredNote />
        <Field error={assetError ?? undefined} label="Asset" name="assetId" required>
          {(props) => (
            <select {...props} aria-label="Inspection asset" value={assetId} onChange={(event) => chooseAsset(event.target.value)}>
              <option value="">Select an asset</option>
              {assetOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {assetLabel(option)} - {option.customer.name}
                </option>
              ))}
            </select>
          )}
        </Field>
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
        <div className="drawer-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel="Saving…" type="submit" variant="primary">Save inspection</ActionButton>
        </div>
      </form>
    </div>
  );
}
