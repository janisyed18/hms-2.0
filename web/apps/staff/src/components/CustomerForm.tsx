import { useRef, useState, type FormEvent } from "react";

import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import { LOCATION_FIELD_KEYS, LocationFields, emptyLocation, locationFieldLabels, validateLocation } from "./LocationFields";
import type { CustomerFormValues, CustomerRecord, LocationFormValues } from "../domain/types";

interface CustomerFormProps {
  customer: CustomerRecord | null;
  open: boolean;
  onClose: () => void;
  /** A new customer is saved with its first location; an existing one saves its own fields only. */
  onSubmit: (values: CustomerFormValues) => Promise<void>;
}

function emptyValues(): CustomerFormValues {
  return { name: "", notes: "", firstLocation: emptyLocation() };
}

const LOCATION_PREFIX = "loc.";
/** Additional locations get their own prefix so their values and errors never collide with the first's. */
const extraPrefix = (id: number) => `loc${id}.`;
const prefixedKeys = (prefix: string) => LOCATION_FIELD_KEYS.map((key) => `${prefix}${key}`);

interface ExtraLocation { id: number; value: LocationFormValues }

export function CustomerForm({ customer, open, onClose, onSubmit }: CustomerFormProps) {
  const [values, setValues] = useState<CustomerFormValues>(emptyValues);
  const [extras, setExtras] = useState<ExtraLocation[]>([]);
  const nextExtraId = useRef(2);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify({ values, extras }));
  const isEdit = customer !== null;
  const order = isEdit ? ["name"] : ["name", ...prefixedKeys(LOCATION_PREFIX), ...extras.flatMap((extra) => prefixedKeys(extraPrefix(extra.id)))];
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (customer?.id ?? "new") : null,
    sourceSignature: JSON.stringify(customer ?? null),
    seed: () => {
      setValues(customer ? { ...emptyValues(), name: customer.name, notes: customer.notes ?? "" } : emptyValues());
      setExtras([]);
      nextExtraId.current = 2;
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The customer could not be saved. Check the entered details and try again.",
    fieldMap: { name: "name" },
    formRef,
    isCurrent: seed.isCurrent,
    order,
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (isBlank(values.name)) found.name = "Enter the customer's name.";
    if (!isEdit) {
      Object.assign(found, validateLocation(values.firstLocation, LOCATION_PREFIX));
      for (const extra of extras) Object.assign(found, validateLocation(extra.value, extraPrefix(extra.id)));
    }
    return found;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!submission.validate(validate())) return;
    await submission.run(
      () => onSubmit({
        ...values,
        name: values.name.trim(),
        notes: values.notes.trim(),
        additionalLocations: extras.map((extra) => extra.value)
      }),
      markClean
    );
  }

  const fieldLabels: Record<string, string> = {
    name: "Name",
    ...locationFieldLabels(LOCATION_PREFIX, "Location"),
    ...Object.assign({}, ...extras.map((extra, index) => locationFieldLabels(extraPrefix(extra.id), `Location ${index + 2}`)))
  };

  function addLocation() {
    const id = nextExtraId.current++;
    setExtras((current) => [...current, { id, value: emptyLocation() }]);
  }

  function removeLocation(id: number) {
    setExtras((current) => current.filter((extra) => extra.id !== id));
  }

  return (
    <div className="drawer-backdrop" role="presentation">
      <FormShell
        description={isEdit ? "Customer name and notes. Locations and contacts are managed from Customer Details." : "A customer needs a name and at least one location. Add further locations here, or later from Customer Details."}
        dirty={dirty}
        errorSummaryTitle="Customer could not be saved"
        errors={errors}
        fieldLabels={fieldLabels}
        fieldOrder={order}
        formClassName="customer-drawer customer-profile-form"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submission.submitError}
        submitLabel="Save customer"
        title={isEdit ? "Edit customer" : "Add customer"}
      >
        <FormSection title="Customer">
          <Field error={errors.name} label="Name" name="name" required>
            {(props) => (
              <input
                {...props}
                aria-label="Name"
                value={values.name}
                onChange={(event) => { setValues((current) => ({ ...current, name: event.target.value })); clearError("name"); }}
              />
            )}
          </Field>
        </FormSection>
        {isEdit ? null : (
          <FormSection description="Where work happens, who to contact there, and what the site requires." title="First location">
            <div className="customer-location-fields">
              <LocationFields
                clearError={clearError}
                errors={errors}
                onChange={(next) => setValues((current) => ({ ...current, firstLocation: next }))}
                prefix={LOCATION_PREFIX}
                value={values.firstLocation}
              />
            </div>
          </FormSection>
        )}
        {isEdit ? null : extras.map((extra, index) => (
          <FormSection key={extra.id} title={`Location ${index + 2}`}>
            <div className="customer-location-fields">
              <LocationFields
                clearError={clearError}
                errors={errors}
                onChange={(next) => setExtras((current) => current.map((item) => (item.id === extra.id ? { ...item, value: next } : item)))}
                prefix={extraPrefix(extra.id)}
                value={extra.value}
              />
            </div>
            <button className="secondary-button" onClick={() => removeLocation(extra.id)} type="button">{`Remove location ${index + 2}`}</button>
          </FormSection>
        ))}
        {isEdit ? null : (
          <button className="secondary-button" onClick={addLocation} type="button">Add another location</button>
        )}
        <FormSection title="Global Customer Notes">
          <Field label="Notes" name="notes">
            {(props) => (
              <textarea
                {...props}
                aria-label="Notes"
                rows={3}
                value={values.notes}
                onChange={(event) => setValues((current) => ({ ...current, notes: event.target.value }))}
              />
            )}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
