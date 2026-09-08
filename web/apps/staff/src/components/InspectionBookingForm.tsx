import { FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import type {
  AssetRecord,
  InspectionBookingCreateValues
} from "../domain/types";

interface InspectionBookingFormProps {
  assetOptions: AssetRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InspectionBookingCreateValues) => Promise<void>;
}

export function InspectionBookingForm({
  assetOptions,
  open,
  onClose,
  onSubmit
}: InspectionBookingFormProps) {
  const locations = useMemo(() => {
    const entries = new Map<string, { id: string; label: string }>();
    assetOptions.forEach((asset) => {
      if (!asset.location) return;
      entries.set(asset.location.id, {
        id: asset.location.id,
        label: `${asset.customer.name} - ${asset.location.name}`
      });
    });
    return Array.from(entries.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }, [assetOptions]);
  const [locationId, setLocationId] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [additionalInformation, setAdditionalInformation] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const availableAssets = useMemo(
    () => assetOptions.filter((asset) => asset.location?.id === locationId),
    [assetOptions, locationId]
  );

  useEffect(() => {
    if (!open) return;
    const firstLocationId = locations[0]?.id ?? "";
    setLocationId(firstLocationId);
    setAssetIds(
      assetOptions
        .filter((asset) => asset.location?.id === firstLocationId)
        .slice(0, 1)
        .map((asset) => asset.id)
    );
    setScheduledAt("");
    setAdditionalInformation("");
  }, [assetOptions, locations, open]);

  if (!open) return null;

  function updateLocation(nextLocationId: string) {
    setLocationId(nextLocationId);
    setAssetIds(
      assetOptions
        .filter((asset) => asset.location?.id === nextLocationId)
        .slice(0, 1)
        .map((asset) => asset.id)
    );
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
    if (!customerId || !locationId || assetIds.length === 0) return;
    setSubmitting(true);
    try {
      await onSubmit({
        customerId,
        locationId,
        assetIds,
        scheduledAt: new Date(scheduledAt).toISOString(),
        additionalInformation: additionalInformation.trim() || null
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer inspection-booking-form" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Book inspection</h2>
            <p>Choose one location and the assets that need the same visit.</p>
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
        <fieldset className="booking-asset-list">
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
          <span>Inspection date and time</span>
          <input
            aria-label="Inspection date and time"
            required
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </label>
        <label>
          <span>Additional information</span>
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
            disabled={isSubmitting || assetIds.length === 0}
            type="submit"
          >
            {isSubmitting ? "Saving..." : "Create booking"}
          </button>
        </div>
      </form>
    </div>
  );
}
