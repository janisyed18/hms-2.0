import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import { AssetEndEditor } from "./AssetEndEditor";
import type {
  AssetEndValues,
  AssetFormValues,
  AssetRecord,
  AssetProductSummary,
  RecordSummary
} from "../domain/types";

interface AssetFormProps {
  asset: AssetRecord | null;
  customerOptions: RecordSummary[];
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
  productOptions,
  open,
  onClose,
  onSubmit
}: AssetFormProps) {
  const [assetNumber, setAssetNumber] = useState("");
  const [customerSerialNo, setCustomerSerialNo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState("IN_SERVICE");
  const [nextRetestDueAt, setNextRetestDueAt] = useState("");
  const [aEnd, setAEnd] = useState<AssetEndValues>(blankEnd);
  const [bEnd, setBEnd] = useState<AssetEndValues>(blankEnd);
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setAssetNumber(asset?.assetNumber ?? "");
    setCustomerSerialNo(asset?.customerSerialNo ?? "");
    setCustomerId(asset?.customer.id ?? customerOptions[0]?.id ?? "");
    setProductId(asset?.product.id ?? productOptions[0]?.id ?? "");
    setLifecycleStatus(asset?.lifecycleStatus ?? "IN_SERVICE");
    setNextRetestDueAt(asset?.nextRetestDueAt ?? "");
    setAEnd(blankEnd);
    setBEnd(blankEnd);
  }, [asset, customerOptions, open, productOptions]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({
      assetNumber,
      customerId,
      customerSerialNo: customerSerialNo || null,
      productId,
      lifecycleStatus,
      nextRetestDueAt: nextRetestDueAt || null,
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
