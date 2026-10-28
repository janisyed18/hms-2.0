import { useRef, useState, type FormEvent } from "react";

import type { AssetRecord, InspectionCreateValues, InspectionType } from "../domain/types";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import type { FieldErrors } from "./interaction/useFormErrors";
import { assetLabel } from "../utils/identity";

interface InspectionFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InspectionCreateValues) => Promise<void>;
}

const ORDER = ["assetId"];

export function InspectionForm({
  assetOptions,
  open,
  onClose,
  onSubmit
}: InspectionFormProps) {
  const [assetId, setAssetId] = useState("");
  const [inspectionType, setInspectionType] = useState<InspectionType>("SERVICE");
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([assetId, inspectionType]));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? "new" : null,
    sourceSignature: "",
    seed: () => {
      // A new inspection starts with no asset chosen.
      setAssetId("");
      setInspectionType("SERVICE");
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The inspection could not be created. Try again.",
    formRef,
    isCurrent: seed.isCurrent,
    order: ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!assetId) found.assetId = "Select the asset being inspected.";
    if (!submission.validate(found)) return;
    await submission.run(
      () => onSubmit({
        assetId,
        inspectionType,
        // Nothing is measured before the inspection is started, so a new one carries no
        // result or pressure test; those are recorded in the inspection once it is in progress.
        result: null,
        pressureTest: null
      }),
      markClean
    );
  }

  return (
    <div className="drawer-backdrop">
      <FormShell
        description="Create a draft inspection. Open it and start it to record the pressure test, measurements and condition checks."
        dirty={dirty}
        errorSummaryTitle="Inspection not created"
        errors={errors}
        fieldLabels={{ assetId: "Asset" }}
        fieldOrder={ORDER}
        formClassName="customer-drawer"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Creating…"
        submitError={submission.submitError}
        submitLabel="Create inspection"
        title="Add Inspection"
      >
        <FormSection>
          <Field error={errors.assetId} label="Asset" name="assetId" required>
            {(props) => (
              <select {...props} aria-label="Inspection asset" value={assetId} onChange={(event) => { setAssetId(event.target.value); clearError("assetId"); }}>
                <option value="">Select an asset</option>
                {assetOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {assetLabel(option)} - {option.customer.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Inspection type" name="inspectionType">
            {(props) => (
              <select
                {...props}
                aria-label="Inspection type"
                value={inspectionType}
                onChange={(event) => setInspectionType(event.target.value as InspectionType)}
              >
                <option value="SERVICE">Service</option>
                <option value="NEW_ASSET">New asset</option>
              </select>
            )}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
