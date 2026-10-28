import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  AdminUserRecord,
  InspectionAvailabilitySlot,
  InspectionBookingCreateValues,
  InspectionBookingRecord
} from "../domain/types";
import { assetLabel } from "../utils/identity";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field, RequiredMark } from "./interaction/FormPrimitives";

const ERROR_OPTIONS = { conflictNeedsRefresh: true };

interface InspectionBookingFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  rescheduleBooking?: InspectionBookingRecord | null;
  inspectors?: Array<Pick<AdminUserRecord, "id" | "displayName">>;
  requiresInspector?: boolean;
  /** A date (YYYY-MM-DD) to offer first, e.g. the day being viewed in the calendar. */
  initialDate?: string;
  onClose: () => void;
  onSubmit: (values: InspectionBookingCreateValues) => Promise<void>;
  onReschedule?: (
    bookingId: string,
    values: {
      availabilityQuoteId: string;
      reason: string | null;
      inspectorUserId: string | null;
    }
  ) => Promise<void>;
}

export function InspectionBookingForm({
  assetOptions,
  open,
  rescheduleBooking = null,
  inspectors = [],
  requiresInspector = false,
  initialDate = "",
  onClose,
  onSubmit,
  onReschedule
}: InspectionBookingFormProps) {
  const locations = useMemo(() => {
    const entries = new Map<string, { id: string; label: string; timezone: string }>();
    assetOptions.forEach((asset) => {
      if (!asset.location) return;
      entries.set(asset.location.id, {
        id: asset.location.id,
        label: `${asset.customer.name} - ${asset.location.name}`,
        timezone: asset.location.schedulingTimezone ?? "UTC"
      });
    });
    if (rescheduleBooking && !entries.has(rescheduleBooking.location.id)) {
      entries.set(rescheduleBooking.location.id, {
        id: rescheduleBooking.location.id,
        label: `${rescheduleBooking.customer.name} - ${rescheduleBooking.location.name}`,
        timezone: rescheduleBooking.location.schedulingTimezone ?? "UTC"
      });
    }
    return Array.from(entries.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }, [assetOptions, rescheduleBooking]);
  const [locationId, setLocationId] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [bookingDate, setBookingDate] = useState("");
  // Availability is stored with the location and date it was requested for, and only
  // trusted while both still match, so a quote can never outlive the choices it priced.
  const [availability, setAvailability] = useState<{
    key: string;
    slots: InspectionAvailabilitySlot[];
  }>({ key: "", slots: [] });
  const [chosenQuoteId, setChosenQuoteId] = useState("");
  const [inspectorUserId, setInspectorUserId] = useState("");
  const [isLoadingAvailability, setLoadingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [additionalInformation, setAdditionalInformation] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const availableAssets = useMemo(
    () => assetOptions.filter((asset) => asset.location?.id === locationId),
    [assetOptions, locationId]
  );
  const customerId = rescheduleBooking?.customer.id ?? availableAssets[0]?.customer.id;
  // A reschedule shows the booking's own assets, which need not be in the loaded list.
  const assetChoices = rescheduleBooking
    ? rescheduleBooking.assets.map((asset) => ({ id: asset.id, assetNumber: asset.assetNumber, assetName: asset.assetName ?? null }))
    : availableAssets;
  const schedulingTimezone = locations.find((location) => location.id === locationId)?.timezone ?? "UTC";
  const availabilityKey = locationId && bookingDate ? `${locationId}|${bookingDate}` : "";
  const availableSlots = availability.key === availabilityKey ? availability.slots : [];
  const availabilityQuoteId = availableSlots.some((slot) => slot.quoteId === chosenQuoteId)
    ? chosenQuoteId
    : "";

  // Reset only when the form opens or its subject changes. Depending on the option
  // lists would wipe the user's choices whenever the workspace refreshes them.
  const rescheduleKey = rescheduleBooking?.id ?? null;
  const { dirty, markClean, touch } = useDirtyTracker(
    JSON.stringify([locationId, assetIds, bookingDate, availabilityQuoteId, inspectorUserId, additionalInformation])
  );
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (rescheduleKey ?? "new") : null,
    sourceSignature: "",
    seed: () => {
      // A new booking starts blank: the user must choose the location and the assets.
      // A reschedule keeps the booking's own location and assets.
      setLocationId(rescheduleBooking ? rescheduleBooking.location.id : "");
      setAssetIds(rescheduleBooking ? rescheduleBooking.assets.map((asset) => asset.id) : []);
      setBookingDate(rescheduleBooking ? "" : initialDate);
      setAvailability({ key: "", slots: [] });
      setChosenQuoteId("");
      setInspectorUserId("");
      setLoadingAvailability(false);
      setAvailabilityError(null);
      setAdditionalInformation("");
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    errorOptions: ERROR_OPTIONS,
    fallback: rescheduleBooking ? "The reschedule could not be requested. Try again." : "The booking could not be created. Try again.",
    formRef,
    isCurrent: seed.isCurrent,
    order: [],
    session: seed.current
  });

  useEffect(() => {
    if (!open || !bookingDate || !customerId || !locationId) return;
    const requestKey = `${locationId}|${bookingDate}`;
    let active = true;
    setLoadingAvailability(true);
    setAvailabilityError(null);
    setChosenQuoteId("");
    void createHmsClient()
      .listInspectionAvailability({
        customerId,
        locationId,
        localDate: bookingDate,
        durationMinutes: 60
      })
      .then((slots) => {
        if (active) setAvailability({ key: requestKey, slots });
      })
      .catch((reason: unknown) => {
        if (active) {
          setAvailabilityError(
            reason instanceof Error
              ? reason.message
              : "Availability could not be loaded."
          );
        }
      })
      .finally(() => {
        if (active) setLoadingAvailability(false);
      });
    return () => {
      active = false;
    };
  }, [bookingDate, customerId, locationId, open]);

  if (!open) return null;

  function updateLocation(nextLocationId: string) {
    // Everything that depended on the previous location is dropped, including the
    // assets: the user picks them again for the new location.
    setLocationId(nextLocationId);
    setAssetIds([]);
    setBookingDate("");
    setAvailability({ key: "", slots: [] });
    setChosenQuoteId("");
    setAvailabilityError(null);
    setLoadingAvailability(false);
  }

  function toggleAsset(assetId: string) {
    setAssetIds((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId]
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // The submit button is not available until the choices are complete; a form submitted by the
    // keyboard before then does nothing.
    if (!customerId || !locationId || assetIds.length === 0 || !availabilityQuoteId) return;
    await submission.run(
      async () => {
        if (rescheduleBooking && onReschedule) {
          await onReschedule(rescheduleBooking.id, {
            availabilityQuoteId,
            reason: additionalInformation.trim() || null,
            inspectorUserId: requiresInspector ? inspectorUserId : null
          });
        } else {
          await onSubmit({
            customerId,
            locationId,
            assetIds,
            availabilityQuoteId,
            additionalInformation: additionalInformation.trim() || null,
          });
        }
      },
      markClean,
      // Keep the chosen site, assets and date; a gone or taken time must be chosen again.
      (failure) => {
        if (failure.kind === "validation" || failure.kind === "conflict" || failure.kind === "missing") setChosenQuoteId("");
      }
    );
  }

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: schedulingTimezone });
  return (
    <div className="drawer-backdrop">
      <FormShell
        closeLabel="Close booking form"
        description={rescheduleBooking ? "Choose a new available time for this confirmed visit." : "Choose one location and the assets that need the same visit."}
        dirty={dirty}
        errorSummaryTitle={rescheduleBooking ? "Reschedule not requested" : "Booking not created"}
        errors={submission.errors}
        fieldLabels={{}}
        fieldOrder={[]}
        formClassName="customer-drawer inspection-booking-form"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitDisabled={!locationId || assetIds.length === 0 || !availabilityQuoteId || (rescheduleBooking !== null && requiresInspector && !inspectorUserId)}
        submitError={submission.submitError}
        submitLabel={rescheduleBooking ? "Request reschedule" : "Create booking"}
        title={rescheduleBooking ? "Request reschedule" : "Book inspection"}
      >
        <FormSection title="Where">
          <Field label="Location" name="locationId" required>
            {(props) => (
              <select
                {...props}
                aria-label="Booking location"
                disabled={Boolean(rescheduleBooking)}
                value={locationId}
                onChange={(event) => updateLocation(event.target.value)}
              >
                {rescheduleBooking ? null : <option value="">Choose the location</option>}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <fieldset className="booking-asset-list" disabled={Boolean(rescheduleBooking)}>
            <legend>Assets<RequiredMark /></legend>
            {!locationId ? <p className="field-hint">Choose a location to see its assets.</p> : null}
            {locationId && assetChoices.length === 0 ? (
              <p className="field-hint">No assets are assigned to this location.</p>
            ) : null}
            {assetChoices.map((asset) => (
              <label key={asset.id} className="checkbox-field">
                <input
                  checked={assetIds.includes(asset.id)}
                  onChange={() => toggleAsset(asset.id)}
                  type="checkbox"
                />
                <span>{assetLabel(asset)}</span>
              </label>
            ))}
          </fieldset>
        </FormSection>
        <FormSection title="When">
          <Field label="Preferred inspection date" name="bookingDate" required>
            {(props) => (
              <input
                {...props}
                aria-label="Preferred inspection date"
                disabled={!locationId}
                type="date"
                value={bookingDate}
                onChange={(event) => setBookingDate(event.target.value)}
              />
            )}
          </Field>
          {bookingDate ? (
            <Field error={availabilityError ?? undefined} label={`Available time (${schedulingTimezone})`} name="availabilityQuoteId" required>
              {(props) => (
                <select
                  {...props}
                  aria-label="Available inspection time"
                  disabled={isLoadingAvailability || availableSlots.length === 0}
                  value={availabilityQuoteId}
                  onChange={(event) => setChosenQuoteId(event.target.value)}
                >
                  <option value="">
                    {isLoadingAvailability
                      ? "Checking availability..."
                      : availableSlots.length
                        ? "Select a time"
                        : "No times available"}
                  </option>
                  {availableSlots.map((slot) => (
                    <option key={slot.quoteId} value={slot.quoteId}>
                      {timeFormat.format(new Date(slot.startsAt))} - {timeFormat.format(new Date(slot.endsAt))}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </FormSection>
        <FormSection title="Details">
          {rescheduleBooking && requiresInspector ? (
            <Field label="Inspector" name="inspectorUserId" required>
              {(props) => (
                <select
                  {...props}
                  aria-label="Inspector for rescheduled inspection"
                  value={inspectorUserId}
                  onChange={(event) => setInspectorUserId(event.target.value)}
                >
                  <option value="">Assign inspector</option>
                  {inspectors.map((inspector) => (
                    <option key={inspector.id} value={inspector.id}>{inspector.displayName}</option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field label={rescheduleBooking ? "Reason for rescheduling" : "Additional information"} name="additionalInformation">
            {(props) => (
              <textarea
                {...props}
                aria-label="Additional inspection information"
                rows={3}
                value={additionalInformation}
                onChange={(event) => setAdditionalInformation(event.target.value)}
              />
            )}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
