import { useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";

import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type { CustomerFormValues, CustomerRecord } from "../domain/types";

const ppeRequirements = [
  "High Vis",
  "Long Sleeve",
  "Long Pants",
  "Safety Boots",
  "Hard Hat",
  "Safety Glasses",
  "Gloves",
  "Ear Protection"
];

const additionalRequirements = [
  "2-way radio",
  "Vehicle flashing lights",
  "Vehicle Site Approval",
  "Mobile phone restrictions"
];

interface CustomerFormProps {
  customer: CustomerRecord | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (values: CustomerFormValues) => Promise<void>;
}

function emptyValues(): CustomerFormValues {
  return {
    name: "",
    notes: "",
    locations: [{
      name: "",
      siteContactName: "",
      siteContactMobile: "",
      siteContactEmail: "",
      ppeRequirements: [],
      additionalRequirements: []
    }]
  };
}

function valuesFor(customer: CustomerRecord | null): CustomerFormValues {
  if (!customer) {
    return emptyValues();
  }
  return {
    name: customer.name,
    notes: customer.notes ?? "",
    locations: customer.locations.length
      ? customer.locations.map((location) => ({
        id: location.id,
        name: location.name,
        siteContactName: location.siteContactName ?? "",
        siteContactMobile: location.siteContactMobile ?? "",
        siteContactEmail: location.siteContactEmail ?? "",
        ppeRequirements: location.ppeRequirements,
        additionalRequirements: location.additionalRequirements,
        schedulingTimezone: location.schedulingTimezone,
        schedulingOpenTime: location.schedulingOpenTime,
        schedulingCloseTime: location.schedulingCloseTime,
        schedulingWeekdays: location.schedulingWeekdays,
        schedulingBlackoutDates: location.schedulingBlackoutDates
      }))
      : emptyValues().locations
  };
}

const FIELD_MAP = { name: "name" };

/** Field keys, in form order: "name", then per location "loc0.name", "loc0.contactName"... */
function fieldOrder(locationCount: number): string[] {
  const order = ["name"];
  for (let index = 0; index < locationCount; index += 1) {
    order.push(`loc${index}.name`, `loc${index}.contactName`, `loc${index}.contactMobile`, `loc${index}.contactEmail`);
  }
  return order;
}

export function CustomerForm({ customer, open, onClose, onSubmit }: CustomerFormProps) {
  const [values, setValues] = useState<CustomerFormValues>(emptyValues);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify(values));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (customer?.id ?? "new") : null,
    sourceSignature: JSON.stringify(customer ?? null),
    seed: () => {
      setValues(valuesFor(customer));
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The customer could not be saved. Check the entered details and try again.",
    fieldMap: FIELD_MAP,
    formRef,
    isCurrent: seed.isCurrent,
    order: () => fieldOrder(values.locations.length),
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  function toggleLocationRequirement(
    index: number,
    group: "ppeRequirements" | "additionalRequirements",
    requirement: string
  ) {
    setValues((current) => ({
      ...current,
      locations: current.locations.map((location, locationIndex) => {
        if (locationIndex !== index) return location;
        const requirements = location[group];
        return {
          ...location,
          [group]: requirements.includes(requirement)
            ? requirements.filter((item) => item !== requirement)
            : [...requirements, requirement]
        };
      })
    }));
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (isBlank(values.name)) found.name = "Enter the customer's name.";
    values.locations.forEach((location, index) => {
      if (isBlank(location.name)) found[`loc${index}.name`] = "Enter the location name.";
      if (isBlank(location.siteContactName)) found[`loc${index}.contactName`] = "Enter the site contact's name.";
      if (isBlank(location.siteContactMobile)) found[`loc${index}.contactMobile`] = "Enter the site contact's mobile number.";
      if (isBlank(location.siteContactEmail)) found[`loc${index}.contactEmail`] = "Enter the site contact's email address.";
      else if (!/^\S+@\S+\.\S+$/.test(location.siteContactEmail?.trim() ?? "")) found[`loc${index}.contactEmail`] = "Enter a valid email address.";
    });
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
        locations: values.locations.map((location) => ({
          ...(location.id ? { id: location.id } : {}),
          name: location.name.trim(),
          siteContactName: location.siteContactName?.trim() ?? "",
          siteContactMobile: location.siteContactMobile?.trim() ?? "",
          siteContactEmail: location.siteContactEmail?.trim() ?? "",
          ppeRequirements: location.ppeRequirements,
          additionalRequirements: location.additionalRequirements,
          schedulingTimezone: location.schedulingTimezone,
          schedulingOpenTime: location.schedulingOpenTime,
          schedulingCloseTime: location.schedulingCloseTime,
          schedulingWeekdays: location.schedulingWeekdays,
          schedulingBlackoutDates: location.schedulingBlackoutDates
        }))
      }),
      markClean
    );
  }

  const fieldLabels: Record<string, string> = { name: "Name" };
  values.locations.forEach((_, index) => {
    const label = index === 0 ? "Location" : `Location ${index + 1}`;
    fieldLabels[`loc${index}.name`] = `${label} name`;
    fieldLabels[`loc${index}.contactName`] = `${label} site contact name`;
    fieldLabels[`loc${index}.contactMobile`] = `${label} site contact mobile`;
    fieldLabels[`loc${index}.contactEmail`] = `${label} site contact email`;
  });

  return (
    <div className="drawer-backdrop" role="presentation">
      <FormShell
        description="Customer details, locations, and site access requirements."
        dirty={dirty}
        errorSummaryTitle="Customer could not be saved"
        errors={errors}
        fieldLabels={fieldLabels}
        fieldOrder={fieldOrder(values.locations.length)}
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
        title={customer ? "Edit customer" : "Add customer"}
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
        <FormSection description="Where work happens, who to contact there, and what the site requires." title="Locations">
            <div className="customer-location-fields">
              {values.locations.map((location, index) => {
                const label = index === 0 ? "Location" : `Location ${index + 1}`;
                const updateLocation = (field: "name" | "siteContactName" | "siteContactMobile" | "siteContactEmail", value: string) => {
                  clearError({ name: `loc${index}.name`, siteContactName: `loc${index}.contactName`, siteContactMobile: `loc${index}.contactMobile`, siteContactEmail: `loc${index}.contactEmail` }[field]);
                  setValues((current) => ({
                    ...current,
                    locations: current.locations.map((item, itemIndex) => itemIndex === index
                      ? { ...item, [field]: value }
                      : item)
                  }));
                };
                return (
                  <fieldset className="customer-location-entry" key={location.id ?? `location-${index}`}>
                    <legend>{label}</legend>
                    <Field error={errors[`loc${index}.name`]} label="Location name" name={`loc${index}.name`} required>
                      {(props) => <input {...props} aria-label={label} value={location.name} onChange={(event) => updateLocation("name", event.target.value)} />}
                    </Field>
                    <div className="site-contact-fields">
                      <Field error={errors[`loc${index}.contactName`]} label="Site contact name" name={`loc${index}.contactName`} required>
                        {(props) => <input {...props} aria-label="Site contact name" value={location.siteContactName ?? ""} onChange={(event) => updateLocation("siteContactName", event.target.value)} />}
                      </Field>
                      <Field error={errors[`loc${index}.contactMobile`]} label="Site contact mobile" name={`loc${index}.contactMobile`} required>
                        {(props) => <input {...props} aria-label="Site contact mobile" inputMode="tel" type="tel" value={location.siteContactMobile ?? ""} onChange={(event) => updateLocation("siteContactMobile", event.target.value)} />}
                      </Field>
                      <Field error={errors[`loc${index}.contactEmail`]} label="Site contact email" name={`loc${index}.contactEmail`} required>
                        {(props) => <input {...props} aria-label="Site contact email" type="email" value={location.siteContactEmail ?? ""} onChange={(event) => updateLocation("siteContactEmail", event.target.value)} />}
                      </Field>
                    </div>
                    <div className="location-requirements-grid">
                      <fieldset className="requirements-fieldset">
                        <legend>PPE requirements</legend>
                        {ppeRequirements.map((requirement) => (
                          <label className="checkbox-field" key={requirement}>
                            <input
                              checked={location.ppeRequirements.includes(requirement)}
                              type="checkbox"
                              onChange={() => toggleLocationRequirement(index, "ppeRequirements", requirement)}
                            />
                            <span>{requirement}</span>
                          </label>
                        ))}
                      </fieldset>
                      <fieldset className="requirements-fieldset">
                        <legend>Additional requirements</legend>
                        {additionalRequirements.map((requirement) => (
                          <label className="checkbox-field" key={requirement}>
                            <input
                              checked={location.additionalRequirements.includes(requirement)}
                              type="checkbox"
                              onChange={() => toggleLocationRequirement(index, "additionalRequirements", requirement)}
                            />
                            <span>{requirement}</span>
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  </fieldset>
                );
              })}
              <button
                className="customer-add-location"
                type="button"
                onClick={() => setValues((current) => ({
                  ...current,
                  locations: [...current.locations, {
                    name: "",
                    siteContactName: "",
                    siteContactMobile: "",
                    siteContactEmail: "",
                    ppeRequirements: [],
                    additionalRequirements: []
                  }]
                }))}
              >
                <Plus aria-hidden="true" size={16} />
                Add location
              </button>
            </div>

        </FormSection>
        <FormSection title="Customer notes">
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
