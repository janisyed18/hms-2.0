import { useMemo, useRef, useState, type FormEvent } from "react";

import { ActionNotice } from "./interaction/ActionNotice";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type { CertificateIssueValues, InspectionRecord } from "../domain/types";
import { assetLabel } from "../utils/identity";
import { Combobox } from "./interaction/Combobox";

interface CertificateFormProps {
  inspectionOptions: InspectionRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: CertificateIssueValues) => Promise<void>;
}

const ORDER = ["inspectionId", "number"];
const FIELD_LABELS = { inspectionId: "Approved inspection", number: "Certificate number" };

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
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([inspectionId, number, validUntil]));
  const optionIds = useMemo(() => inspectionOptions.map((inspection) => inspection.id), [inspectionOptions]);
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? "issue" : null,
    // A refreshed list of approved inspections re-seeds a form nobody has touched, never one being filled in.
    sourceSignature: JSON.stringify(optionIds),
    seed: () => {
      const firstInspection = inspectionOptions[0];
      setInspectionId(firstInspection?.id ?? "");
      setNumber(defaultCertificateNumber(firstInspection));
      setValidUntil(defaultValidUntil());
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The certificate could not be issued. Nothing was issued; try again.",
    formRef,
    isCurrent: seed.isCurrent,
    order: ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  function chooseInspection(nextId: string) {
    setInspectionId(nextId);
    // Choosing another inspection offers its own certificate number.
    setNumber(defaultCertificateNumber(inspectionOptions.find((inspection) => inspection.id === nextId)));
    clearError("inspectionId");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!inspectionId) found.inspectionId = "Choose the approved inspection to certify.";
    if (isBlank(number)) found.number = "Enter a certificate number.";
    if (!submission.validate(found)) return;
    await submission.run(
      () => onSubmit({ inspectionId, number: number.trim(), validUntil: validUntil || null }),
      markClean
    );
  }

  const nothingToCertify = inspectionOptions.length === 0;
  return (
    <div className="drawer-backdrop">
      <FormShell
        closeLabel="Close certificate form"
        description="Create a versioned certificate from an approved inspection."
        dirty={dirty}
        errorSummaryTitle="Certificate could not be issued"
        errors={errors}
        fieldLabels={FIELD_LABELS}
        fieldOrder={ORDER}
        formClassName="customer-drawer"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Issuing…"
        submitDisabled={nothingToCertify}
        submitError={submission.submitError}
        submitLabel="Issue certificate"
        title="Issue Certificate"
      >
        {nothingToCertify ? (
          <ActionNotice kind="info" title="Nothing to certify">There are no approved inspections waiting for a certificate.</ActionNotice>
        ) : null}
        <FormSection>
          <Field error={errors.inspectionId} label="Approved inspection" name="inspectionId" required>
            {(props) => (
              <Combobox
                {...props}
                aria-label="Approved inspection"
                disabled={nothingToCertify}
                emptyText="No inspections match"
                onChange={(next) => { chooseInspection(next); touch(); }}
                options={inspectionOptions.map((inspection) => ({ value: inspection.id, label: assetLabel(inspection.asset), description: inspection.customer.name, searchText: inspection.asset.assetNumber }))}
                placeholder="Search approved inspections"
                value={inspectionId}
              />
            )}
          </Field>
          <Field error={errors.number} label="Certificate number" name="number" required>
            {(props) => <input {...props} aria-label="Certificate number" disabled={nothingToCertify} value={number} onChange={(event) => { setNumber(event.target.value); clearError("number"); }} />}
          </Field>
          <Field label="Valid until" name="validUntil">
            {(props) => <input {...props} aria-label="Valid until" disabled={nothingToCertify} type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
