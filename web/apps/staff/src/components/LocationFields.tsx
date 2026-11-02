import { useMemo, useState } from "react";

import { Field } from "./interaction/FormPrimitives";
import { Combobox } from "./interaction/Combobox";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type { CustomerLocation, LocationFormValues } from "../domain/types";

export const PPE_REQUIREMENTS = [
  "High Vis",
  "Long Sleeve",
  "Long Pants",
  "Safety Boots",
  "Hard Hat",
  "Safety Glasses",
  "Gloves",
  "Ear Protection"
];

export const ADDITIONAL_REQUIREMENTS = [
  "2-way radio",
  "Vehicle flashing lights",
  "Vehicle Site Approval",
  "Mobile phone restrictions"
];

/** Monday is 0, matching the API's weekday numbers. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FALLBACK_TIME_ZONES = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide",
  "Australia/Perth", "Australia/Darwin", "Australia/Hobart", "Pacific/Auckland", "UTC"
];

export function timeZoneNames(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const names = supported ? supported("timeZone") : [];
  return names.length ? Array.from(new Set([...names, "UTC"])) : FALLBACK_TIME_ZONES;
}

/**
 * A new location starts with working hours and days the person can see and change, but no timezone:
 * a site's timezone is a fact about where it is, so the person chooses it rather than inheriting one.
 */
export function emptyLocation(): LocationFormValues {
  return {
    name: "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    country: "",
    siteContactName: "",
    siteContactMobile: "",
    siteContactEmail: "",
    ppeRequirements: [],
    additionalRequirements: [],
    schedulingTimezone: "",
    schedulingOpenTime: "08:00",
    schedulingCloseTime: "17:00",
    schedulingWeekdays: [0, 1, 2, 3, 4],
    schedulingBlackoutDates: []
  };
}

export function locationValuesFor(location: CustomerLocation): LocationFormValues {
  return {
    name: location.name,
    address1: location.address1 ?? "",
    address2: location.address2 ?? "",
    city: location.city ?? "",
    state: location.state ?? "",
    country: location.country ?? "",
    siteContactName: location.siteContactName ?? "",
    siteContactMobile: location.siteContactMobile ?? "",
    siteContactEmail: location.siteContactEmail ?? "",
    ppeRequirements: location.ppeRequirements,
    additionalRequirements: location.additionalRequirements,
    schedulingTimezone: location.schedulingTimezone ?? "",
    schedulingOpenTime: location.schedulingOpenTime ?? "08:00",
    schedulingCloseTime: location.schedulingCloseTime ?? "17:00",
    schedulingWeekdays: location.schedulingWeekdays ?? [0, 1, 2, 3, 4],
    schedulingBlackoutDates: location.schedulingBlackoutDates ?? []
  };
}

export const LOCATION_FIELD_KEYS = [
  "name", "contactName", "contactMobile", "contactEmail", "timezone", "hours", "weekdays"
] as const;

export function locationFieldLabels(prefix: string, label: string): Record<string, string> {
  return {
    [`${prefix}name`]: `${label} name`,
    [`${prefix}contactName`]: `${label} site contact name`,
    [`${prefix}contactMobile`]: `${label} site contact mobile`,
    [`${prefix}contactEmail`]: `${label} site contact email`,
    [`${prefix}timezone`]: `${label} timezone`,
    [`${prefix}hours`]: `${label} working hours`,
    [`${prefix}weekdays`]: `${label} working days`
  };
}

export function validateLocation(value: LocationFormValues, prefix = ""): FieldErrors {
  const found: FieldErrors = {};
  if (isBlank(value.name)) found[`${prefix}name`] = "Enter the location name.";
  if (isBlank(value.siteContactName)) found[`${prefix}contactName`] = "Enter the site contact's name.";
  if (isBlank(value.siteContactMobile)) found[`${prefix}contactMobile`] = "Enter the site contact's mobile number.";
  if (isBlank(value.siteContactEmail)) found[`${prefix}contactEmail`] = "Enter the site contact's email address.";
  else if (!/^\S+@\S+\.\S+$/.test(value.siteContactEmail.trim())) found[`${prefix}contactEmail`] = "Enter a valid email address.";
  if (!value.schedulingTimezone) found[`${prefix}timezone`] = "Select the timezone this location is in.";
  else if (!timeZoneNames().includes(value.schedulingTimezone)) found[`${prefix}timezone`] = "Select a valid timezone.";
  if (!value.schedulingOpenTime || !value.schedulingCloseTime) found[`${prefix}hours`] = "Enter the opening and closing times.";
  else if (value.schedulingOpenTime >= value.schedulingCloseTime) found[`${prefix}hours`] = "Closing time must be later than opening time.";
  if (value.schedulingWeekdays.length === 0) found[`${prefix}weekdays`] = "Select at least one working day.";
  return found;
}

function toggle<T>(items: T[], item: T): T[] {
  return items.includes(item) ? items.filter((existing) => existing !== item) : [...items, item];
}

/**
 * Every location setting a person can maintain: where it is, who is on site, what the site requires
 * and when inspections may be booked. Shared by Add customer (the first location) and the location
 * editor in Customer Details so both ask for the same things.
 */
export function LocationFields({
  clearError,
  errors,
  onChange,
  prefix = "",
  value
}: {
  clearError: (key: string) => void;
  errors: FieldErrors;
  onChange: (next: LocationFormValues) => void;
  prefix?: string;
  value: LocationFormValues;
}) {
  const [blackoutDraft, setBlackoutDraft] = useState("");
  const zones = useMemo(() => timeZoneNames().map((zone) => ({ value: zone, label: zone })), []);
  const set = <K extends keyof LocationFormValues>(key: K, next: LocationFormValues[K], errorKey?: string) => {
    if (errorKey) clearError(`${prefix}${errorKey}`);
    onChange({ ...value, [key]: next });
  };

  return (
    <>
      <Field error={errors[`${prefix}name`]} label="Location name" name={`${prefix}name`} required>
        {(props) => <input {...props} aria-label="Location name" value={value.name} onChange={(event) => set("name", event.target.value, "name")} />}
      </Field>
      <fieldset className="customer-location-entry">
        <legend>Address</legend>
        <Field label="Address line 1" name={`${prefix}address1`}>
          {(props) => <input {...props} aria-label="Address line 1" value={value.address1} onChange={(event) => set("address1", event.target.value)} />}
        </Field>
        <Field label="Address line 2" name={`${prefix}address2`}>
          {(props) => <input {...props} aria-label="Address line 2" value={value.address2} onChange={(event) => set("address2", event.target.value)} />}
        </Field>
        <Field label="City" name={`${prefix}city`}>
          {(props) => <input {...props} aria-label="City" value={value.city} onChange={(event) => set("city", event.target.value)} />}
        </Field>
        <Field label="State" name={`${prefix}state`}>
          {(props) => <input {...props} aria-label="State" value={value.state} onChange={(event) => set("state", event.target.value)} />}
        </Field>
        <Field label="Country" name={`${prefix}country`}>
          {(props) => <input {...props} aria-label="Country" value={value.country} onChange={(event) => set("country", event.target.value)} />}
        </Field>
      </fieldset>
      <div className="site-contact-fields">
        <Field error={errors[`${prefix}contactName`]} label="Site contact name" name={`${prefix}contactName`} required>
          {(props) => <input {...props} aria-label="Site contact name" value={value.siteContactName} onChange={(event) => set("siteContactName", event.target.value, "contactName")} />}
        </Field>
        <Field error={errors[`${prefix}contactMobile`]} label="Site contact mobile" name={`${prefix}contactMobile`} required>
          {(props) => <input {...props} aria-label="Site contact mobile" inputMode="tel" type="tel" value={value.siteContactMobile} onChange={(event) => set("siteContactMobile", event.target.value, "contactMobile")} />}
        </Field>
        <Field error={errors[`${prefix}contactEmail`]} label="Site contact email" name={`${prefix}contactEmail`} required>
          {(props) => <input {...props} aria-label="Site contact email" type="email" value={value.siteContactEmail} onChange={(event) => set("siteContactEmail", event.target.value, "contactEmail")} />}
        </Field>
      </div>
      <div className="location-requirements-grid">
        <fieldset className="requirements-fieldset">
          <legend>PPE requirements</legend>
          {PPE_REQUIREMENTS.map((requirement) => (
            <label className="checkbox-field" key={requirement}>
              <input checked={value.ppeRequirements.includes(requirement)} type="checkbox" onChange={() => set("ppeRequirements", toggle(value.ppeRequirements, requirement))} />
              <span>{requirement}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="requirements-fieldset">
          <legend>Additional requirements</legend>
          {ADDITIONAL_REQUIREMENTS.map((requirement) => (
            <label className="checkbox-field" key={requirement}>
              <input checked={value.additionalRequirements.includes(requirement)} type="checkbox" onChange={() => set("additionalRequirements", toggle(value.additionalRequirements, requirement))} />
              <span>{requirement}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <fieldset className="customer-location-entry">
        <legend>Inspection scheduling</legend>
        <Field error={errors[`${prefix}timezone`]} hint="Bookings at this location are shown in its own timezone." label="Timezone" name={`${prefix}timezone`} required>
          {(props) => (
            <Combobox
              {...props}
              aria-label="Timezone"
              onChange={(next) => set("schedulingTimezone", next, "timezone")}
              options={zones}
              placeholder="Select a timezone"
              value={value.schedulingTimezone}
            />
          )}
        </Field>
        <div className="site-contact-fields">
          <Field error={errors[`${prefix}hours`]} label="Opens" name={`${prefix}hours`} required>
            {(props) => <input {...props} aria-label="Opening time" type="time" value={value.schedulingOpenTime} onChange={(event) => set("schedulingOpenTime", event.target.value, "hours")} />}
          </Field>
          <Field label="Closes" name={`${prefix}closes`} required>
            {(props) => <input {...props} aria-label="Closing time" type="time" value={value.schedulingCloseTime} onChange={(event) => set("schedulingCloseTime", event.target.value, "hours")} />}
          </Field>
        </div>
        <fieldset className="requirements-fieldset" data-field={`${prefix}weekdays`}>
          <legend>Working days</legend>
          {WEEKDAYS.map((day, index) => (
            <label className="checkbox-field" key={day}>
              <input checked={value.schedulingWeekdays.includes(index)} type="checkbox" onChange={() => set("schedulingWeekdays", toggle(value.schedulingWeekdays, index).sort(), "weekdays")} />
              <span>{day}</span>
            </label>
          ))}
          {errors[`${prefix}weekdays`] ? <small className="field-error" role="alert">{errors[`${prefix}weekdays`]}</small> : null}
        </fieldset>
        <fieldset className="requirements-fieldset">
          <legend>Blackout dates</legend>
          <div className="site-contact-fields">
            <Field label="Add a blackout date" name={`${prefix}blackout`}>
              {(props) => <input {...props} aria-label="Blackout date" type="date" value={blackoutDraft} onChange={(event) => setBlackoutDraft(event.target.value)} />}
            </Field>
            <button
              className="secondary-button compact-action"
              disabled={!blackoutDraft || value.schedulingBlackoutDates.includes(blackoutDraft)}
              onClick={() => { set("schedulingBlackoutDates", [...value.schedulingBlackoutDates, blackoutDraft].sort()); setBlackoutDraft(""); }}
              type="button"
            >
              Add date
            </button>
          </div>
          {value.schedulingBlackoutDates.length === 0 ? <p className="empty-requirements">No blackout dates.</p> : (
            <ul className="requirement-list">
              {value.schedulingBlackoutDates.map((date) => (
                <li key={date}>
                  {date}
                  <button aria-label={`Remove blackout date ${date}`} className="secondary-button compact-action" onClick={() => set("schedulingBlackoutDates", value.schedulingBlackoutDates.filter((item) => item !== date))} type="button">Remove</button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </fieldset>
    </>
  );
}

/** "Australia/Sydney · 08:00–17:00 · Mon, Tue, Wed" for showing a location's booking window. */
export function scheduleSummary(location: CustomerLocation): string {
  const days = (location.schedulingWeekdays ?? []).map((day) => WEEKDAYS[day]).filter(Boolean).join(", ");
  return [location.schedulingTimezone, `${location.schedulingOpenTime ?? ""}–${location.schedulingCloseTime ?? ""}`, days].filter(Boolean).join(" · ");
}
