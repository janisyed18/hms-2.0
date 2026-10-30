import { useRef, useState, type FormEvent } from "react";

import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
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
const FIELD_LABELS: Record<string, string> = { code: "Product code", name: "Product name", category: "Category" };

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
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([code, name, category, subCategory, pressureRatings]));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (product?.id ?? "new") : null,
    sourceSignature: JSON.stringify(product ?? null),
    seed: () => {
      setCode(product?.code ?? "");
      setName(product?.name ?? "");
      setCategory(product?.category ?? "");
      setSubCategory(product?.subCategory ?? "");
      setPressureRatings([]);
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The product could not be saved. Try again.",
    fieldMap: FIELD_MAP,
    formRef,
    isCurrent: seed.isCurrent,
    order: REQUIRED_ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (isBlank(code)) found.code = "Enter a product code.";
    if (isBlank(name)) found.name = "Enter a product name.";
    if (isBlank(category)) found.category = "Enter a category.";
    if (!submission.validate(found)) return;
    await submission.run(
      () => onSubmit({
        code: code.trim(),
        name: name.trim(),
        category: category.trim(),
        subCategory: subCategory.trim() || null,
        standardId: null,
        pressureRatings
      }),
      markClean
    );
  }

  return (
    <div className="drawer-backdrop">
      <FormShell
        description="Maintain catalog data and pressure ratings."
        dirty={dirty}
        errorSummaryTitle="Product could not be saved"
        errors={errors}
        fieldLabels={FIELD_LABELS}
        fieldOrder={REQUIRED_ORDER}
        formClassName="customer-drawer"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submission.submitError}
        submitLabel="Save product"
        title={product ? "Edit product" : "Add product"}
      >
        <FormSection>
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
        </FormSection>
        <FormSection title="Pressure ratings">
          <PressureMatrixEditor rows={pressureRatings} onAddRow={addPressureRating} />
        </FormSection>
      </FormShell>
    </div>
  );
}
