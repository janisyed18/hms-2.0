import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { AssetEndEditor } from "./AssetEndEditor";
import { FormGrid, FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { Field } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
import { customerLabel, productLabel } from "../utils/identity";
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
  isCopy?: boolean;
  onClose: () => void;
  onSubmit: (values: AssetFormValues) => Promise<void>;
}

/** Form order of the required fields, for focusing the first one that needs attention. */
const REQUIRED_ORDER = ["customerId", "locationId", "assetName", "serialNumber", "productId"];

const FIELD_LABELS: Record<string, string> = {
  customerId: "Agent",
  locationId: "Location",
  assetName: "Asset Name",
  serialNumber: "Serial Number",
  productId: "Product"
};

/** Backend request fields to this form's fields, so a server rejection lands on the right input. */
const FIELD_MAP: Record<string, string> = {
  customer_id: "customerId",
  location_id: "locationId",
  asset_name: "assetName",
  customer_serial_no: "serialNumber",
  product_id: "productId"
};

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
  isCopy = false,
  onClose,
  onSubmit
}: AssetFormProps) {
  const [assetName, setAssetName] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [notes, setNotes] = useState("");
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([
    customerId, locationId, assetName, serialNumber, notes, purchaseOrderNumber, installationDate, graveDate,
    nextInspectionDate, lengthM, productId, materialId, nominalBoreId, aEnd, bEnd
  ]));
  useEffect(() => { dirtyRef.current = dirty; });

  // The form re-seeds when it opens or is pointed at a different record, never because the same record
  // arrived again from a list refresh. A refreshed copy of the record only replaces a form nobody has
  // edited. Each seeding starts a new session so a slow save for the previous record is ignored.
  const sourceKey = open ? `${asset?.id ?? "new"}:${isCopy ? "copy" : "edit"}` : null;
  const sourceSignature = JSON.stringify(asset ?? null);
  const dirtyRef = useRef(false);
  const seededKey = useRef<string | null>(null);
  const session = useRef(0);

  useEffect(() => {
    if (sourceKey === null) {
      seededKey.current = null;
      return;
    }
    if (seededKey.current === sourceKey && dirtyRef.current) return;
    seededKey.current = sourceKey;
    session.current += 1;
    submitLock.current = false;
    setSubmitting(false);
    setSubmitError(null);
    clearAll();
    setAssetName(asset?.assetName ?? asset?.assetNumber ?? "");
    setSerialNumber(asset?.customerSerialNo ?? "");
    setNotes(asset?.notes ?? asset?.description ?? "");
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
    markClean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceSignature]);

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

  // Defaults can arrive after a first validation (option lists load late): an error about a
  // field that now has a value would be stale.
  useEffect(() => {
    if (customerId) clearError("customerId");
    if (locationId) clearError("locationId");
    if (productId) clearError("productId");
  }, [customerId, locationId, productId, clearError]);

  if (!open) {
    return null;
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!customerId) found.customerId = "Select an agent.";
    if (!locationId) found.locationId = "Select a location.";
    if (isBlank(assetName)) found.assetName = "Enter an asset name.";
    if (isBlank(serialNumber)) found.serialNumber = "Enter a serial number.";
    if (!productId) found.productId = "Select a product.";
    return found;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, REQUIRED_ORDER, found);
      return;
    }
    const startedIn = session.current;
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        customerId,
        locationId: locationId || null,
        productId,
        assetName: assetName.trim(),
        serialNumber: serialNumber.trim(),
        notes: notes.trim(),
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
      // A save that finishes after the form moved to another record says nothing about that record.
      if (startedIn === session.current) markClean();
    } catch (reason) {
      if (startedIn !== session.current) return;
      // The drawer stays open with everything the user entered; say what went wrong.
      const friendly = friendlyApiError(reason, { fallback: "The asset could not be saved. Try again.", fieldMap: FIELD_MAP });
      setErrors(friendly.fieldErrors);
      setSubmitError(friendly.message);
      window.setTimeout(() => {
        if (!focusFirstInvalid(formRef.current, REQUIRED_ORDER, friendly.fieldErrors)) {
          formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
        }
      }, 0);
    } finally {
      if (startedIn === session.current) {
        submitLock.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <div className="drawer-backdrop">
      <FormShell
        dirty={dirty}
        errorSummaryTitle="Asset could not be saved"
        errors={errors}
        fieldLabels={FIELD_LABELS}
        fieldOrder={REQUIRED_ORDER}
        formClassName="customer-drawer asset-profile-form"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submitError}
        submitLabel="Save asset"
        title={isCopy ? "Copy Asset" : asset ? "Edit Asset" : "Add Asset"}
      >
        <FormSection title="Ownership">
          <FormGrid>
            <Field error={errors.customerId} label="Agent" name="customerId" required>
              {(props) => (
                <select {...props} aria-label="Agent" value={customerId} onChange={(event) => { setCustomerId(event.target.value); clearError("customerId"); }}>
                  <option value="">Select agent</option>
                  {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customerLabel(customer)}</option>)}
                </select>
              )}
            </Field>
            <Field error={errors.locationId} label="Location" name="locationId" required>
              {(props) => (
                <select {...props} aria-label="Location" value={locationId} onChange={(event) => { setLocationId(event.target.value); clearError("locationId"); }}>
                  <option value="">Select location</option>
                  {customerLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              )}
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title="Identity">
          <FormGrid>
            <Field error={errors.assetName} label="Asset Name" name="assetName" required>
              {(props) => <input {...props} aria-label="Asset Name" value={assetName} onChange={(event) => { setAssetName(event.target.value); clearError("assetName"); }} />}
            </Field>
            <Field error={errors.serialNumber} label="Serial Number" name="serialNumber" required>
              {(props) => <input {...props} aria-label="Serial Number" value={serialNumber} onChange={(event) => { setSerialNumber(event.target.value); clearError("serialNumber"); }} />}
            </Field>
            <Field label="Purchase Order Number" name="purchaseOrderNumber">
              {(props) => <input {...props} aria-label="Purchase Order Number" value={purchaseOrderNumber} onChange={(event) => setPurchaseOrderNumber(event.target.value)} />}
            </Field>
            <Field className="form-field--wide" label="Notes" name="notes">
              {(props) => <textarea {...props} aria-label="Notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />}
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title="Dates">
          <FormGrid>
            <Field label="Installation Date" name="installationDate">
              {(props) => <input {...props} aria-label="Installation Date" type="date" value={installationDate} onChange={(event) => setInstallationDate(event.target.value)} />}
            </Field>
            <Field label="Grave Date" name="graveDate">
              {(props) => <input {...props} aria-label="Grave Date" type="date" value={graveDate} onChange={(event) => setGraveDate(event.target.value)} />}
            </Field>
            <Field label="Next Inspection Date" name="nextInspectionDate">
              {(props) => <input {...props} aria-label="Next Inspection Date" type="date" value={nextInspectionDate} onChange={(event) => setNextInspectionDate(event.target.value)} />}
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title="Product and configuration">
          <FormGrid>
            <Field error={errors.productId} label="Product" name="productId" required>
              {(props) => (
                <select {...props} aria-label="Product" value={productId} onChange={(event) => { setProductId(event.target.value); clearError("productId"); }}>
                  <option value="">Select product</option>
                  {productOptions.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}
                </select>
              )}
            </Field>
            <Field label="Length (m)" name="lengthM">
              {(props) => <input {...props} aria-label="Length (m)" min="0" step="0.001" type="number" value={lengthM} onChange={(event) => setLengthM(event.target.value)} />}
            </Field>
            <Field label="Material" name="materialId">
              {(props) => (
                <select {...props} aria-label="Material" value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
                  <option value="">Select material</option>
                  {configurationOptions.materials.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              )}
            </Field>
            <Field label="Nominal Bore" name="nominalBoreId">
              {(props) => (
                <select {...props} aria-label="Nominal Bore" value={nominalBoreId} onChange={(event) => setNominalBoreId(event.target.value)}>
                  <option value="">Select nominal bore</option>
                  {configurationOptions.nominalBores.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              )}
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title="Ends">
          <FormGrid>
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
          </FormGrid>
        </FormSection>
      </FormShell>
    </div>
  );
}
