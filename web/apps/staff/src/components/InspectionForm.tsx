import { useRef, useState, type FormEvent } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useRemoteOptions } from "../hooks/useRemoteOptions";
import type { InspectionCreateValues, InspectionType } from "../domain/types";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import type { FieldErrors } from "./interaction/useFormErrors";
import { assetLabel } from "../utils/identity";
import { Combobox } from "./interaction/Combobox";
import { Select } from "./interaction/Select";

interface InspectionFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InspectionCreateValues) => Promise<void>;
}

const ORDER = ["assetId", "inspectionType"];

export function InspectionForm({
  open,
  onClose,
  onSubmit
}: InspectionFormProps) {
  const [assetId, setAssetId] = useState("");
  const [inspectionType, setInspectionType] = useState<InspectionType | "">("");
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([assetId, inspectionType]));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? "new" : null,
    sourceSignature: "",
    seed: () => {
      // A new inspection starts with no asset chosen.
      setAssetId("");
      setChosenAsset(null);
      setInspectionType("");
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
  // Assets are searched on the server, so one beyond the first page can still be inspected.
  const assetSearch = useRemoteOptions(
    (text) => createHmsClient().listAssets({ search: text, newWorkOnly: true, sort: "asset_number", limit: 25 }).then((result) => result.items),
    open
  );
  const [chosenAsset, setChosenAsset] = useState<{ value: string; label: string; description?: string } | null>(null);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!assetId) found.assetId = "Select the asset being inspected.";
    if (!inspectionType) found.inspectionType = "Select the inspection type.";
    if (!submission.validate(found)) return;
    await submission.run(
      () => onSubmit({
        assetId,
        inspectionType: inspectionType as InspectionType,
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
        fieldLabels={{ assetId: "Asset", inspectionType: "Inspection type" }}
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
        submitLabel="Save inspection"
        title="Create inspection"
      >
        <FormSection>
          <Field error={errors.assetId} label="Asset" name="assetId" required>
            {(props) => (
              <Combobox
                {...props}
                aria-label="Inspection asset"
                emptyText="No assets match"
                onChange={(next) => {
                  const found = assetSearch.items.find((option) => option.id === next);
                  setChosenAsset(found ? { value: found.id, label: assetLabel(found), description: found.customer.name } : null);
                  setAssetId(next); clearError("assetId"); touch();
                }}
                loading={assetSearch.loading}
                onSearch={assetSearch.search}
                selectedOption={chosenAsset}
                options={assetSearch.items.map((option) => ({ value: option.id, label: assetLabel(option), description: option.customer.name, searchText: `${option.assetNumber} ${option.assetName ?? ""}` }))}
                placeholder="Search assets"
                value={assetId}
              />
            )}
          </Field>
          <Field error={errors.inspectionType} label="Inspection type" name="inspectionType" required>
            {(props) => (
              <Select
                {...props}
                aria-label="Inspection type"
                onChange={(next) => { setInspectionType(next as InspectionType); clearError("inspectionType"); touch(); }}
                options={[{ value: "SERVICE", label: "Service" }, { value: "NEW_ASSET", label: "New asset" }]}
                placeholder="Select an inspection type"
                value={inspectionType}
              />
            )}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
