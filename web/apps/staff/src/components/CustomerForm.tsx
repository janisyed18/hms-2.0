import { FormEvent, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
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

export function CustomerForm({ customer, open, onClose, onSubmit }: CustomerFormProps) {
  const [values, setValues] = useState<CustomerFormValues>(emptyValues);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(valuesFor(customer));
      setSubmitError(null);
      clearAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, open]);

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

  /** Field keys, in form order: "name", then per location "loc0.name", "loc0.contactName"... */
  function validate(): { found: FieldErrors; order: string[] } {
    const found: FieldErrors = {};
    const order = ["name"];
    if (isBlank(values.name)) found.name = "Enter the customer's name.";
    values.locations.forEach((location, index) => {
      order.push(`loc${index}.name`, `loc${index}.contactName`, `loc${index}.contactMobile`, `loc${index}.contactEmail`);
      if (isBlank(location.name)) found[`loc${index}.name`] = "Enter the location name.";
      if (isBlank(location.siteContactName)) found[`loc${index}.contactName`] = "Enter the site contact's name.";
      if (isBlank(location.siteContactMobile)) found[`loc${index}.contactMobile`] = "Enter the site contact's mobile number.";
      if (isBlank(location.siteContactEmail)) found[`loc${index}.contactEmail`] = "Enter the site contact's email address.";
      else if (!/^\S+@\S+\.\S+$/.test(location.siteContactEmail?.trim() ?? "")) found[`loc${index}.contactEmail`] = "Enter a valid email address.";
    });
    return { found, order };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const { found, order } = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, order, found);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
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
      });
    } catch (reason) {
      const friendly = friendlyApiError(reason, { fallback: "The customer could not be saved. Check the entered details and try again.", fieldMap: { name: "name" } });
      setErrors(friendly.fieldErrors);
      setSubmitError(friendly.message);
      window.setTimeout(() => {
        if (!focusFirstInvalid(formRef.current, ["name"], friendly.fieldErrors)) {
          formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
        }
      }, 0);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop" role="presentation">
      <form className="customer-drawer customer-profile-form" noValidate onSubmit={handleSubmit} ref={formRef}>
        <div className="drawer-header">
          <div>
            <h2>{customer ? "Edit Customer" : "Add Customer"}</h2>
            <p>Customer details, locations, and site access requirements.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {submitError ? <ActionNotice kind="error" title="Customer could not be saved">{submitError}</ActionNotice> : null}
        <RequiredNote />
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

        <label>
          <span>Notes</span>
          <textarea
            aria-label="Notes"
            rows={3}
            value={values.notes}
            onChange={(event) => setValues((current) => ({ ...current, notes: event.target.value }))}
          />
        </label>

        <div className="drawer-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel="Saving…" type="submit" variant="primary">Save customer</ActionButton>
        </div>
      </form>
    </div>
  );
}
