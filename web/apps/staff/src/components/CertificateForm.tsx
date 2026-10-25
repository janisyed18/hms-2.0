import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
import type { CertificateIssueValues, InspectionRecord } from "../domain/types";
import { assetLabel } from "../utils/identity";

interface CertificateFormProps {
  inspectionOptions: InspectionRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: CertificateIssueValues) => Promise<void>;
}

function defaultCertificateNumber(inspection: InspectionRecord | undefined) {
  if (!inspection) {
    return "";
  }
  return `CERT-${inspection.asset.assetNumber}-1`;
}

function defaultValidUntil() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export function CertificateForm({
  inspectionOptions,
  open,
  onClose,
  onSubmit
}: CertificateFormProps) {
  const [inspectionId, setInspectionId] = useState("");
  const [number, setNumber] = useState("");
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);

  const selectedInspection = useMemo(
    () => inspectionOptions.find((inspection) => inspection.id === inspectionId),
    [inspectionId, inspectionOptions]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstInspection = inspectionOptions[0];
    setInspectionId(firstInspection?.id ?? "");
    setNumber(defaultCertificateNumber(firstInspection));
    setValidUntil(defaultValidUntil());
    setSubmitError(null);
    clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectionOptions, open]);

  useEffect(() => {
    if (!selectedInspection) {
      return;
    }
    setNumber(defaultCertificateNumber(selectedInspection));
  }, [selectedInspection]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const found: FieldErrors = {};
    if (!inspectionId) found.inspectionId = "Choose the approved inspection to certify.";
    if (isBlank(number)) found.number = "Enter a certificate number.";
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, ["inspectionId", "number"], found);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        inspectionId,
        number: number.trim(),
        validUntil: validUntil || null
      });
    } catch (reason) {
      // Nothing was issued, so the drawer stays open with what was chosen and offers a retry.
      const friendly = friendlyApiError(reason, { fallback: "The certificate could not be issued. Nothing was issued; try again." });
      setSubmitError(friendly.message);
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus(), 0);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" noValidate onSubmit={handleSubmit} ref={formRef}>
        <div className="drawer-header">
          <div>
            <h2>Issue Certificate</h2>
            <p>Create a versioned certificate from an approved inspection.</p>
          </div>
          <button
            aria-label="Close certificate form"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        {submitError ? <ActionNotice kind="error" title="Certificate could not be issued">{submitError}</ActionNotice> : null}
        {inspectionOptions.length === 0 ? (
          <ActionNotice kind="info" title="Nothing to certify">There are no approved inspections waiting for a certificate.</ActionNotice>
        ) : null}
        <RequiredNote />
        <Field error={errors.inspectionId} label="Approved inspection" name="inspectionId" required>
          {(props) => (
            <select {...props} aria-label="Approved inspection" disabled={inspectionOptions.length === 0} value={inspectionId} onChange={(event) => { setInspectionId(event.target.value); clearError("inspectionId"); }}>
              {inspectionOptions.map((inspection) => (
                <option key={inspection.id} value={inspection.id}>
                  {assetLabel(inspection.asset)} - {inspection.customer.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field error={errors.number} label="Certificate number" name="number" required>
          {(props) => <input {...props} aria-label="Certificate number" disabled={inspectionOptions.length === 0} value={number} onChange={(event) => { setNumber(event.target.value); clearError("number"); }} />}
        </Field>
        <Field label="Valid until" name="validUntil">
          {(props) => <input {...props} aria-label="Valid until" disabled={inspectionOptions.length === 0} type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />}
        </Field>
        <div className="drawer-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton disabled={inspectionOptions.length === 0} pending={isSubmitting} pendingLabel="Issuing…" type="submit" variant="primary">Issue certificate</ActionButton>
        </div>
      </form>
    </div>
  );
}
