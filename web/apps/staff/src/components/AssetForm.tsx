import { FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { AssetEndEditor } from "./AssetEndEditor";
import type {
  AssetConfigurationOptions,
  AssetEndValues,
  AssetFormValues,
  AssetProductSummary,
  AssetRecord,
  CustomerLocation,
  RecordSummary
} from "../domain/types";

interface AssetFormProps {
  asset: AssetRecord | null;
  configurationOptions: AssetConfigurationOptions;
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
  size: "",
  nominalBore: null,
  material: null,
  coupling: null,
  couplingAddOn: null,
  attachMethod: null
};

export function AssetForm({
  asset,
  configurationOptions,
  customerOptions,
  locationOptions,
  productOptions,
  open,
  onClose,
  onSubmit
}: AssetFormProps) {
  const [assetName, setAssetName] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [description, setDescription] = useState("");
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [productId, setProductId] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [graveDate, setGraveDate] = useState("");
  const [nextInspectionDate, setNextInspectionDate] = useState("");
  const [lengthM, setLengthM] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [nominalBoreId, setNominalBoreId] = useState("");
  const [aEnd, setAEnd] = useState<AssetEndValues>(blankEnd);
  const [bEnd, setBEnd] = useState<AssetEndValues>(blankEnd);
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setAssetName(asset?.assetName ?? asset?.assetNumber ?? "");
    setSerialNumber(asset?.customerSerialNo ?? "");
    setDescription(asset?.description ?? asset?.notes ?? "");
    setPurchaseOrderNumber(asset?.purchaseOrderNumber ?? "");
    setCustomerId(asset?.customer.id ?? "");
    setLocationId(asset?.location?.id ?? "");
    setProductId(asset?.product.id ?? "");
    setInstallationDate(asset?.installationDate ?? "");
    setGraveDate(asset?.graveDate ?? "");
    setNextInspectionDate(asset?.nextRetestDueAt ?? "");
    setLengthM(asset?.lengthM ?? "");
    setMaterialId(asset?.aEnd.material?.id ?? asset?.bEnd.material?.id ?? "");
    setNominalBoreId(asset?.aEnd.nominalBore?.id ?? asset?.bEnd.nominalBore?.id ?? "");
    setAEnd(asset?.aEnd ?? blankEnd);
    setBEnd(asset?.bEnd ?? blankEnd);
  }, [asset, open]);

  useEffect(() => {
    if (open && !asset?.customer.id) {
      setCustomerId((current) => current || customerOptions[0]?.id || "");
    }
  }, [asset?.customer.id, customerOptions, open]);

  useEffect(() => {
    if (open && !asset?.product.id) {
      setProductId((current) => current || productOptions[0]?.id || "");
    }
  }, [asset?.product.id, productOptions, open]);

  const customerLocations = useMemo(
    () => locationOptions.find((group) => group.customerId === customerId)?.locations ?? [],
    [customerId, locationOptions]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setLocationId((current) => (
      customerLocations.some((location) => location.id === current)
        ? current
        : customerLocations[0]?.id ?? ""
    ));
  }, [customerLocations, open]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit({
        customerId,
        locationId: locationId || null,
        productId,
        assetName: assetName.trim(),
        serialNumber: serialNumber.trim(),
        description: description.trim(),
        purchaseOrderNumber: purchaseOrderNumber.trim(),
        installationDate: installationDate || null,
        graveDate: graveDate || null,
        nextInspectionDate: nextInspectionDate || null,
        lengthM: lengthM || null,
        materialId: materialId || null,
        nominalBoreId: nominalBoreId || null,
        aEnd,
        bEnd
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer asset-profile-form" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <h2>{asset ? "Edit Asset" : "Add Asset"}</h2>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Agent</span>
          <select aria-label="Agent" required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Select agent</option>
            {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
          </select>
        </label>
        <label>
          <span>Location</span>
          <select aria-label="Location" required value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">Select location</option>
            {customerLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </label>
        <label>
          <span>Asset Name</span>
          <input aria-label="Asset Name" required value={assetName} onChange={(event) => setAssetName(event.target.value)} />
        </label>
        <label>
          <span>Serial Number</span>
          <input aria-label="Serial Number" required value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} />
        </label>
        <label>
          <span>Description</span>
          <textarea aria-label="Description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          <span>Purchase Order Number</span>
          <input aria-label="Purchase Order Number" value={purchaseOrderNumber} onChange={(event) => setPurchaseOrderNumber(event.target.value)} />
        </label>
        <label>
          <span>Installation Date</span>
          <input aria-label="Installation Date" type="date" value={installationDate} onChange={(event) => setInstallationDate(event.target.value)} />
        </label>
        <label>
          <span>Grave Date</span>
          <input aria-label="Grave Date" type="date" value={graveDate} onChange={(event) => setGraveDate(event.target.value)} />
        </label>
        <label>
          <span>Next Inspection Date</span>
          <input aria-label="Next Inspection Date" type="date" value={nextInspectionDate} onChange={(event) => setNextInspectionDate(event.target.value)} />
        </label>
        <label>
          <span>Length (m)</span>
          <input aria-label="Length (m)" min="0" step="0.001" type="number" value={lengthM} onChange={(event) => setLengthM(event.target.value)} />
        </label>
        <label>
          <span>Product</span>
          <select aria-label="Product" required value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">Select product</option>
            {productOptions.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <label>
          <span>Material</span>
          <select aria-label="Material" value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
            <option value="">Select material</option>
            {configurationOptions.materials.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <AssetEndEditor
          attachMethods={configurationOptions.attachMethods}
          couplingAddOns={configurationOptions.couplingAddOns}
          couplings={configurationOptions.couplings}
          label="A"
          values={aEnd}
          onChange={setAEnd}
        />
        <AssetEndEditor
          attachMethods={configurationOptions.attachMethods}
          couplingAddOns={configurationOptions.couplingAddOns}
          couplings={configurationOptions.couplings}
          label="B"
          values={bEnd}
          onChange={setBEnd}
        />
        <label>
          <span>Nominal Bore</span>
          <select aria-label="Nominal Bore" value={nominalBoreId} onChange={(event) => setNominalBoreId(event.target.value)}>
            <option value="">Select nominal bore</option>
            {configurationOptions.nominalBores.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save asset"}
          </button>
        </div>
      </form>
    </div>
  );
}
