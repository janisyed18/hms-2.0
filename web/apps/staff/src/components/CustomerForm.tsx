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
    locations: [{ name: "" }],
    phone: "",
    email: "",
    ppeRequirements: [],
    additionalRequirements: []
  };
}

function valuesFor(customer: CustomerRecord | null): CustomerFormValues {
  if (!customer) {
    return emptyValues();
  }
  const primaryContact = customer.contacts[0];
  return {
    name: customer.name,
    locations: customer.locations.length
      ? customer.locations.map((location) => ({ id: location.id, name: location.name }))
      : [{ name: "" }],
    phone: primaryContact?.phone ?? "",
    email: primaryContact?.email ?? "",
    ppeRequirements: customer.ppeRequirements,
    additionalRequirements: customer.additionalRequirements
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

  function toggleRequirement(
    group: "ppeRequirements" | "additionalRequirements",
    requirement: string
  ) {
    setValues((current) => ({
      ...current,
      [group]: current[group].includes(requirement)
        ? current[group].filter((item) => item !== requirement)
        : [...current[group], requirement]
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
        locations: values.locations.map((location) => ({
          ...(location.id ? { id: location.id } : {}),
          name: location.name.trim()
        })),
        phone: values.phone.trim(),
        email: values.email.trim()
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
          {values.locations.map((location, index) => (
            <label key={location.id ?? `location-${index}`}>
              <span>{index === 0 ? "Location" : `Location ${index + 1}`}</span>
              <input
                aria-label={index === 0 ? "Location" : `Location ${index + 1}`}
                required={index === 0}
                value={location.name}
                onChange={(event) => setValues((current) => ({
                  ...current,
                  locations: current.locations.map((item, itemIndex) => itemIndex === index
                    ? { ...item, name: event.target.value }
                    : item)
                }))}
              />
            </label>
          ))}
          <button
            className="customer-add-location"
            type="button"
            onClick={() => setValues((current) => ({
              ...current,
              locations: [...current.locations, { name: "" }]
            }))}
          >
            <Plus aria-hidden="true" size={16} />
            Add location
          </button>
        </div>

        <label>
          <span>Phone</span>
          <input
            aria-label="Phone"
            inputMode="tel"
            type="tel"
            value={values.phone}
            onChange={(event) => setValues((current) => ({ ...current, phone: event.target.value }))}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            aria-label="Email"
            type="email"
            value={values.email}
            onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
          />
        </label>

        <fieldset className="requirements-fieldset">
          <legend>PPE Requirements</legend>
          {ppeRequirements.map((requirement) => (
            <label className="checkbox-field" key={requirement}>
              <input
                checked={values.ppeRequirements.includes(requirement)}
                type="checkbox"
                onChange={() => toggleRequirement("ppeRequirements", requirement)}
              />
              <span>{requirement}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="requirements-fieldset">
          <legend>Additional Requirements</legend>
          {additionalRequirements.map((requirement) => (
            <label className="checkbox-field" key={requirement}>
              <input
                checked={values.additionalRequirements.includes(requirement)}
                type="checkbox"
                onChange={() => toggleRequirement("additionalRequirements", requirement)}
              />
              <span>{requirement}</span>
            </label>
          ))}
        </fieldset>

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
