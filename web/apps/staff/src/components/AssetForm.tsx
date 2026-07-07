import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import { AssetEndEditor } from "./AssetEndEditor";
import type {
  AssetEndValues,
  AssetFormValues,
  AssetRecord,
  AssetProductSummary,
  CustomerLocation,
  RecordSummary
} from "../domain/types";

interface AssetFormProps {
  asset: AssetRecord | null;
  customerOptions: RecordSummary[];
  locationOptions: Array<{
    customerId: string;
    locations: CustomerLocation[];
  }>;
  productOptions: AssetProductSummary[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: AssetFormValues) => Promise<void>;
}

const blankEnd: AssetEndValues = {
  fitting: "",
  size: ""
};

export function AssetForm({
  asset,
  customerOptions,
  locationOptions,
  productOptions,
  open,
  onClose,
  onSubmit
}: AssetFormProps) {
  const [assetNumber, setAssetNumber] = useState("");
  const [customerSerialNo, setCustomerSerialNo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [productId, setProductId] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState("IN_SERVICE");
  const [nextRetestDueAt, setNextRetestDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [aEnd, setAEnd] = useState<AssetEndValues>(blankEnd);
  const [bEnd, setBEnd] = useState<AssetEndValues>(blankEnd);
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const defaultCustomerId = asset?.customer.id ?? customerOptions[0]?.id ?? "";
    const defaultLocations =
      locationOptions.find((group) => group.customerId === defaultCustomerId)?.locations ?? [];
    setAssetNumber(asset?.assetNumber ?? "");
    setCustomerSerialNo(asset?.customerSerialNo ?? "");
    setCustomerId(defaultCustomerId);
    setLocationId(asset?.location?.id ?? defaultLocations[0]?.id ?? "");
    setProductId(asset?.product.id ?? productOptions[0]?.id ?? "");
    setLifecycleStatus(asset?.lifecycleStatus ?? "IN_SERVICE");
    setNextRetestDueAt(asset?.nextRetestDueAt ?? "");
    setNotes(asset?.notes ?? "");
    setAEnd(asset?.aEnd ?? blankEnd);
    setBEnd(asset?.bEnd ?? blankEnd);
  }, [asset, customerOptions, locationOptions, open, productOptions]);

  const customerLocations =
    locationOptions.find((group) => group.customerId === customerId)?.locations ?? [];
  const selectedLocation =
    customerLocations.find((location) => location.id === locationId) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    if (customerLocations.length === 0) {
      setLocationId("");
      return;
    }
    if (!customerLocations.some((location) => location.id === locationId)) {
      setLocationId(customerLocations[0].id);
    }
  }, [customerLocations, locationId, open]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({
      assetNumber,
      customerId,
      locationId: locationId || null,
      customerSerialNo: customerSerialNo || null,
      productId,
      lifecycleStatus,
      nextRetestDueAt: nextRetestDueAt || null,
      notes: notes.trim() || null,
      aEnd,
      bEnd
    });
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{asset ? "Edit Asset" : "Add Asset"}</h2>
            <p>Maintain assembly identity, lifecycle, and end configuration.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Asset number</span>
          <input
            aria-label="Asset number"
            required
            value={assetNumber}
            onChange={(event) => setAssetNumber(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span>Customer serial number</span>
          <input
            aria-label="Customer serial number"
            value={customerSerialNo}
            onChange={(event) => setCustomerSerialNo(event.target.value)}
          />
        </label>
        <label>
          <span>Customer</span>
          <select
            aria-label="Asset customer"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          >
            {customerOptions.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Customer site/address</span>
          <select
            aria-label="Asset location"
            disabled={customerLocations.length === 0}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          >
            {customerLocations.length === 0 ? (
              <option value="">No customer locations available</option>
            ) : null}
            {customerLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          <small className="field-hint">
            {selectedLocation ? locationAddress(selectedLocation) : "Create a customer location before assigning this asset."}
          </small>
        </label>
        <label>
          <span>Product</span>
          <select
            aria-label="Asset product"
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            {productOptions.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Lifecycle status</span>
          <select
            aria-label="Lifecycle status"
            value={lifecycleStatus}
            onChange={(event) => setLifecycleStatus(event.target.value)}
          >
            <option value="IN_SERVICE">In service</option>
            <option value="DUE">Due</option>
            <option value="OVERDUE">Overdue</option>
          </select>
        </label>
        <label>
          <span>Next retest due</span>
          <input
            aria-label="Next retest due"
            type="date"
            value={nextRetestDueAt}
            onChange={(event) => setNextRetestDueAt(event.target.value)}
          />
        </label>
        <label>
          <span>Asset notes</span>
          <textarea
            aria-label="Asset notes"
            rows={4}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <AssetEndEditor label="A" values={aEnd} onChange={setAEnd} />
        <AssetEndEditor label="B" values={bEnd} onChange={setBEnd} />
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save asset"}
          </button>
        </div>
      </form>
    </div>
  );
}

function locationAddress(location: CustomerLocation): string {
  const parts = [
    location.address1,
    location.address2,
    location.city,
    location.state,
    location.country
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No address recorded for this site.";
}
