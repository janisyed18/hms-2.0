import { FormEvent, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";

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
        additionalRequirements: location.additionalRequirements
      }))
      : emptyValues().locations
  };
}

export function CustomerForm({ customer, open, onClose, onSubmit }: CustomerFormProps) {
  const [values, setValues] = useState<CustomerFormValues>(emptyValues);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(valuesFor(customer));
      setSubmitError(null);
    }
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
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
          additionalRequirements: location.additionalRequirements
        }))
      });
    } catch {
      setSubmitError("The customer could not be saved. Check the entered details and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop" role="presentation">
      <form className="customer-drawer customer-profile-form" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{customer ? "Edit Customer" : "Add Customer"}</h2>
            <p>Customer details, locations, and site access requirements.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <label>
          <span>Name</span>
          <input
            aria-label="Name"
            required
            value={values.name}
            onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
          />
        </label>

        <div className="customer-location-fields">
          {values.locations.map((location, index) => {
            const label = index === 0 ? "Location" : `Location ${index + 1}`;
            const updateLocation = (field: "name" | "siteContactName" | "siteContactMobile" | "siteContactEmail", value: string) => {
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
                <label>
                  <span>Location name</span>
                  <input aria-label={label} required value={location.name} onChange={(event) => updateLocation("name", event.target.value)} />
                </label>
                <div className="site-contact-fields">
                  <label>
                    <span>Site contact name</span>
                    <input aria-label="Site contact name" required value={location.siteContactName ?? ""} onChange={(event) => updateLocation("siteContactName", event.target.value)} />
                  </label>
                  <label>
                    <span>Site contact mobile</span>
                    <input aria-label="Site contact mobile" inputMode="tel" required type="tel" value={location.siteContactMobile ?? ""} onChange={(event) => updateLocation("siteContactMobile", event.target.value)} />
                  </label>
                  <label>
                    <span>Site contact email</span>
                    <input aria-label="Site contact email" required type="email" value={location.siteContactEmail ?? ""} onChange={(event) => updateLocation("siteContactEmail", event.target.value)} />
                  </label>
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

        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save customer"}
          </button>
        </div>
      </form>
    </div>
  );
}
