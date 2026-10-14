import { FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  AdminUserRecord,
  InspectionAvailabilitySlot,
  InspectionBookingCreateValues,
  InspectionBookingRecord
} from "../domain/types";

interface InspectionBookingFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  rescheduleBooking?: InspectionBookingRecord | null;
  inspectors?: AdminUserRecord[];
  requiresInspector?: boolean;
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
    return Array.from(entries.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }, [assetOptions]);
  const [locationId, setLocationId] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [bookingDate, setBookingDate] = useState("");
  const [availableSlots, setAvailableSlots] = useState<InspectionAvailabilitySlot[]>([]);
  const [availabilityQuoteId, setAvailabilityQuoteId] = useState("");
  const [inspectorUserId, setInspectorUserId] = useState("");
  const [isLoadingAvailability, setLoadingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [additionalInformation, setAdditionalInformation] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const availableAssets = useMemo(
    () => assetOptions.filter((asset) => asset.location?.id === locationId),
    [assetOptions, locationId]
  );
  const schedulingTimezone = locations.find((location) => location.id === locationId)?.timezone ?? "UTC";

  useEffect(() => {
    if (!open) return;
    const firstLocationId = rescheduleBooking?.location.id ?? locations[0]?.id ?? "";
    setLocationId(firstLocationId);
    setAssetIds(
      rescheduleBooking
        ? rescheduleBooking.assets.map((asset) => asset.id)
        : assetOptions
            .filter((asset) => asset.location?.id === firstLocationId)
            .slice(0, 1)
            .map((asset) => asset.id)
    );
    setBookingDate("");
    setAvailableSlots([]);
    setAvailabilityQuoteId("");
    setInspectorUserId("");
    setAvailabilityError(null);
    setAdditionalInformation("");
  }, [assetOptions, locations, open, rescheduleBooking]);

  useEffect(() => {
    const customerId = availableAssets[0]?.customer.id;
    if (!open || !bookingDate || !customerId || !locationId) return;
    let active = true;
    setLoadingAvailability(true);
    setAvailabilityError(null);
    setAvailableSlots([]);
    setAvailabilityQuoteId("");
    void createHmsClient()
      .listInspectionAvailability({
        customerId,
        locationId,
        localDate: bookingDate,
        durationMinutes: 60
      })
      .then((slots) => {
        if (active) setAvailableSlots(slots);
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
  }, [availableAssets, bookingDate, locationId, open]);

  if (!open) return null;

  function updateLocation(nextLocationId: string) {
    setLocationId(nextLocationId);
    setAssetIds(
      assetOptions
        .filter((asset) => asset.location?.id === nextLocationId)
        .slice(0, 1)
        .map((asset) => asset.id)
    );
    setBookingDate("");
    setAvailableSlots([]);
    setAvailabilityQuoteId("");
  }

  function toggleAsset(assetId: string) {
    setAssetIds((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId]
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const customerId = availableAssets[0]?.customer.id;
    if (!customerId || !locationId || assetIds.length === 0 || !availabilityQuoteId) return;
    setSubmitting(true);
    try {
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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer inspection-booking-form" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{rescheduleBooking ? "Request reschedule" : "Book inspection"}</h2>
            <p>{rescheduleBooking ? "Choose a new available time for this confirmed visit." : "Choose one location and the assets that need the same visit."}</p>
          </div>
          <button
            aria-label="Close booking form"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Location</span>
          <select
            aria-label="Booking location"
            required
            disabled={Boolean(rescheduleBooking)}
            value={locationId}
            onChange={(event) => updateLocation(event.target.value)}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="booking-asset-list" disabled={Boolean(rescheduleBooking)}>
          <legend>Assets</legend>
          {availableAssets.map((asset) => (
            <label key={asset.id} className="checkbox-field">
              <input
                checked={assetIds.includes(asset.id)}
                onChange={() => toggleAsset(asset.id)}
                type="checkbox"
              />
              <span>{asset.assetNumber}</span>
            </label>
          ))}
        </fieldset>
        <label>
          <span>Preferred inspection date</span>
          <input
            aria-label="Preferred inspection date"
            required
            type="date"
            value={bookingDate}
            onChange={(event) => setBookingDate(event.target.value)}
          />
        </label>
        {bookingDate ? (
          <label>
            <span>Available time ({schedulingTimezone})</span>
            <select
              aria-label="Available inspection time"
              disabled={isLoadingAvailability || availableSlots.length === 0}
              required
              value={availabilityQuoteId}
              onChange={(event) => setAvailabilityQuoteId(event.target.value)}
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
                  {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: schedulingTimezone
                  }).format(new Date(slot.startsAt))} - {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: schedulingTimezone
                  }).format(new Date(slot.endsAt))}
                </option>
              ))}
            </select>
            {availabilityError ? <small className="form-error">{availabilityError}</small> : null}
          </label>
        ) : null}
        {rescheduleBooking && requiresInspector ? (
          <label>
            <span>Inspector</span>
            <select
              aria-label="Inspector for rescheduled inspection"
              required
              value={inspectorUserId}
              onChange={(event) => setInspectorUserId(event.target.value)}
            >
              <option value="">Assign inspector</option>
              {inspectors.map((inspector) => (
                <option key={inspector.id} value={inspector.id}>{inspector.displayName}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>{rescheduleBooking ? "Reason for rescheduling" : "Additional information"}</span>
          <textarea
            aria-label="Additional inspection information"
            rows={3}
            value={additionalInformation}
            onChange={(event) => setAdditionalInformation(event.target.value)}
          />
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={isSubmitting || assetIds.length === 0 || !availabilityQuoteId || (rescheduleBooking !== null && requiresInspector && !inspectorUserId)}
            type="submit"
          >
            {isSubmitting ? "Saving..." : rescheduleBooking ? "Request reschedule" : "Create booking"}
          </button>
        </div>
      </form>
    </div>
  );
}
