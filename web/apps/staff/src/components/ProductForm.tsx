import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

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
    try {
      setSubmitting(true);
      setSubmitError(null);
      await onSubmit({
        code,
        name,
        category,
        subCategory: subCategory || null,
        standardId: null,
        pressureRatings
      });
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Unable to save this product.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{product ? "Edit Product" : "Add Product"}</h2>
            <p>Maintain catalog data and pressure ratings.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Product code</span>
          <input
            aria-label="Product code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span>Product name</span>
          <input
            aria-label="Product name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Category</span>
          <input
            aria-label="Category"
            required
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>
        <label>
          <span>Sub category</span>
          <input
            aria-label="Sub category"
            value={subCategory}
            onChange={(event) => setSubCategory(event.target.value)}
          />
        </label>
        <PressureMatrixEditor rows={pressureRatings} onAddRow={addPressureRating} />
        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save product"}
          </button>
        </div>
      </form>
    </div>
  );
}
