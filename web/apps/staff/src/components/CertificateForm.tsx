import { useMemo, useRef, useState, type FormEvent } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useRemoteOptions } from "../hooks/useRemoteOptions";

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
  /** Inspections that already have a certificate, so they are not offered again. */
  issuedInspectionIds?: string[];
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
  issuedInspectionIds = [],
  open,
  onClose,
  onSubmit
}: CertificateFormProps) {
  const [inspectionId, setInspectionId] = useState("");
  const [number, setNumber] = useState("");
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([inspectionId, number, validUntil]));
  const [chosen, setChosen] = useState<InspectionRecord | null>(null);
  const issued = useMemo(() => new Set(issuedInspectionIds), [issuedInspectionIds]);
  // Approved inspections are searched on the server, so one beyond the first page is still reachable.
  const search = useRemoteOptions(
    (text) => createHmsClient()
      .listInspections({ status: "APPROVED", search: text, sort: "-approved_at", limit: 25 })
      .then((result) => result.items.filter((inspection) => !issued.has(inspection.id))),
    open
  );
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? "issue" : null,
    sourceSignature: "",
    seed: () => {
      // Nothing is chosen for the person: the asset, customer and number follow an explicit choice.
      setInspectionId("");
      setChosen(null);
      setNumber("");
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
    const inspection = search.items.find((item) => item.id === nextId) ?? null;
    setInspectionId(nextId);
    setChosen(inspection);
    // Choosing an inspection offers its own certificate number.
    setNumber(defaultCertificateNumber(inspection ?? undefined));
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
        submitError={submission.submitError}
        submitLabel="Issue certificate"
        title="Issue Certificate"
      >
        <FormSection>
          <Field error={errors.inspectionId} label="Approved inspection" name="inspectionId" required>
            {(props) => (
              <Combobox
                {...props}
                aria-label="Approved inspection"
                emptyText="No approved inspections match"
                loading={search.loading}
                onChange={(next) => { chooseInspection(next); touch(); }}
                onSearch={search.search}
                options={search.items.map((inspection) => ({ value: inspection.id, label: assetLabel(inspection.asset), description: inspection.customer.name, searchText: inspection.asset.assetNumber }))}
                placeholder="Select an approved inspection"
                selectedOption={chosen ? { value: chosen.id, label: assetLabel(chosen.asset), description: chosen.customer.name } : null}
                value={inspectionId}
              />
            )}
          </Field>
          <Field error={errors.number} label="Certificate number" name="number" required>
            {(props) => <input {...props} aria-label="Certificate number" value={number} onChange={(event) => { setNumber(event.target.value); clearError("number"); }} />}
          </Field>
          <Field hint="Starts one year from today. Change it if this certificate needs a different validity." label="Valid until" name="validUntil">
            {(props) => <input {...props} aria-label="Valid until" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
