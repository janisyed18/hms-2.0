import { useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { createHmsClient } from "../api/hmsClient";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { LOCATION_FIELD_KEYS, LocationFields, emptyLocation, locationFieldLabels, locationValuesFor, validateLocation } from "./LocationFields";
import type { CustomerLocation, CustomerRecord, LocationFormValues } from "../domain/types";

const ORDER = [...LOCATION_FIELD_KEYS];

/** Add or edit one location of a customer, from Customer Details. Saves, then hands back the customer as the server now has it. */
export function LocationEditor({
  customerId,
  location,
  onClose,
  onSaved,
  open
}: {
  customerId: string;
  /** The location being edited, or null to add a new one. */
  location: CustomerLocation | null;
  onClose: () => void;
  onSaved: (customer: CustomerRecord, saved: "added" | "updated") => void;
  open: boolean;
}) {
  const [values, setValues] = useState<LocationFormValues>(emptyLocation);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify(values));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (location?.id ?? "new") : null,
    sourceSignature: JSON.stringify(location ?? null),
    seed: () => {
      setValues(location ? locationValuesFor(location) : emptyLocation());
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The location could not be saved. Check the entered details and try again.",
    fieldMap: { name: "name", scheduling_timezone: "timezone" },
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
    if (!submission.validate(validateLocation(values))) return;
    await submission.run(async () => {
      const client = createHmsClient();
      if (location) await client.updateCustomerLocation(customerId, location.id, values);
      else await client.createCustomerLocation(customerId, values);
      onSaved(await client.getCustomer(customerId), location ? "updated" : "added");
    }, markClean);
  }

  // Portalled out of the profile dialog, whose transform would otherwise anchor this drawer to it.
  return createPortal(
    <div className="drawer-backdrop drawer-backdrop--elevated" role="presentation">
      <FormShell
        closeLabel="Close location form"
        description="Where work happens, who to contact there, what the site requires and when inspections may be booked."
        dirty={dirty}
        errorSummaryTitle="Location could not be saved"
        errors={errors}
        fieldLabels={locationFieldLabels("", "Location")}
        fieldOrder={ORDER}
        formClassName="customer-drawer customer-profile-form"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submission.submitError}
        submitLabel="Save location"
        title={location ? "Edit location" : "Add location"}
      >
        <FormSection>
          <div className="customer-location-fields">
            <LocationFields clearError={clearError} errors={errors} onChange={setValues} value={values} />
          </div>
        </FormSection>
      </FormShell>
    </div>,
    document.body
  );
}
