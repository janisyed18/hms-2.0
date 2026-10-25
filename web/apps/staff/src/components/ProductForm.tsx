import { FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
import { PressureMatrixEditor } from "./PressureMatrixEditor";
import type {
  PressureRatingRecord,
  ProductFormValues,
  ProductRecord
} from "../domain/types";

interface ProductFormProps {
  open: boolean;
  product: ProductRecord | null;
  onClose: () => void;
  onSubmit: (values: ProductFormValues) => Promise<void>;
}

const REQUIRED_ORDER = ["code", "name", "category"];
const FIELD_MAP: Record<string, string> = { code: "code", name: "name", category: "category" };

export function ProductForm({
  open,
  product,
  onClose,
  onSubmit
}: ProductFormProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [pressureRatings, setPressureRatings] = useState<PressureRatingRecord[]>([]);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCode(product?.code ?? "");
    setName(product?.name ?? "");
    setCategory(product?.category ?? "");
    setSubCategory(product?.subCategory ?? "");
    setPressureRatings([]);
    setSubmitError(null);
    clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product]);

  if (!open) {
    return null;
  }

  function addPressureRating() {
    setPressureRatings((current) => [
      ...current,
      {
        id: `rating-${current.length + 1}`,
        label: `Rating ${current.length + 1}`,
        pressureKpa: 1000 + current.length * 250
      }
    ]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const found: FieldErrors = {};
    if (isBlank(code)) found.code = "Enter a product code.";
    if (isBlank(name)) found.name = "Enter a product name.";
    if (isBlank(category)) found.category = "Enter a category.";
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, REQUIRED_ORDER, found);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        code: code.trim(),
        name: name.trim(),
        category: category.trim(),
        subCategory: subCategory.trim() || null,
        standardId: null,
        pressureRatings
      });
    } catch (reason) {
      const friendly = friendlyApiError(reason, { fallback: "The product could not be saved. Try again.", fieldMap: FIELD_MAP });
      setErrors(friendly.fieldErrors);
      setSubmitError(friendly.message);
      window.setTimeout(() => {
        if (!focusFirstInvalid(formRef.current, REQUIRED_ORDER, friendly.fieldErrors)) {
          formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
        }
      }, 0);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" noValidate onSubmit={handleSubmit} ref={formRef}>
        <div className="drawer-header">
          <div>
            <h2>{product ? "Edit Product" : "Add Product"}</h2>
            <p>Maintain catalog data and pressure ratings.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {submitError ? <ActionNotice kind="error" title="Product could not be saved">{submitError}</ActionNotice> : null}
        <RequiredNote />
        <Field error={errors.code} label="Product code" name="code" required>
          {(props) => <input {...props} aria-label="Product code" value={code} onChange={(event) => { setCode(event.target.value.toUpperCase()); clearError("code"); }} />}
        </Field>
        <Field error={errors.name} label="Product name" name="name" required>
          {(props) => <input {...props} aria-label="Product name" value={name} onChange={(event) => { setName(event.target.value); clearError("name"); }} />}
        </Field>
        <Field error={errors.category} label="Category" name="category" required>
          {(props) => <input {...props} aria-label="Category" value={category} onChange={(event) => { setCategory(event.target.value); clearError("category"); }} />}
        </Field>
        <Field label="Sub category" name="subCategory">
          {(props) => <input {...props} aria-label="Sub category" value={subCategory} onChange={(event) => setSubCategory(event.target.value)} />}
        </Field>
        <PressureMatrixEditor rows={pressureRatings} onAddRow={addPressureRating} />
        <div className="drawer-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel="Saving…" type="submit" variant="primary">Save product</ActionButton>
        </div>
      </form>
    </div>
  );
}
