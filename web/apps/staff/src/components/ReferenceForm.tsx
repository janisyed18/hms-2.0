import { useRef, useState, type FormEvent } from "react";

import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type {
  ReferenceCatalogFormValues,
  ReferenceCatalogRecord
} from "../domain/types";

interface ReferenceFormProps {
  open: boolean;
  standard: ReferenceCatalogRecord | null;
  onClose: () => void;
  onSubmit: (values: ReferenceCatalogFormValues) => Promise<void>;
  entityLabel?: string;
}

const ORDER = ["code", "name"];
const FIELD_MAP = { code: "code", name: "name" };

export function ReferenceForm({
  open,
  standard,
  onClose,
  onSubmit,
  entityLabel = "Standard"
}: ReferenceFormProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([code, name]));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (standard?.id ?? "new") : null,
    sourceSignature: JSON.stringify(standard ?? null),
    seed: () => {
      setCode(standard?.code ?? "");
      setName(standard?.name ?? "");
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: `The ${entityLabel.toLowerCase()} could not be saved. Try again.`,
    fieldMap: FIELD_MAP,
    formRef,
    isCurrent: seed.isCurrent,
    order: ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (isBlank(code)) found.code = `Enter a ${entityLabel.toLowerCase()} code.`;
    if (isBlank(name)) found.name = `Enter a ${entityLabel.toLowerCase()} name.`;
    if (!submission.validate(found)) return;
    await submission.run(() => onSubmit({ code: code.trim(), name: name.trim() }), markClean);
  }

  return (
    <div className="drawer-backdrop">
      <FormShell
        description="Controlled catalog data is available immediately to asset configuration."
        dirty={dirty}
        errorSummaryTitle={`${entityLabel} could not be saved`}
        errors={errors}
        fieldLabels={{ code: `${entityLabel} code`, name: `${entityLabel} name` }}
        fieldOrder={ORDER}
        formClassName="customer-drawer"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submission.submitError}
        submitLabel={`Save ${entityLabel.toLowerCase()}`}
        title={standard ? `Edit ${entityLabel}` : `Add ${entityLabel}`}
      >
        <FormSection>
          <Field error={errors.code} label={`${entityLabel} code`} name="code" required>
            {(props) => <input {...props} aria-label={`${entityLabel} code`} value={code} onChange={(event) => { setCode(event.target.value.toUpperCase()); clearError("code"); }} />}
          </Field>
          <Field error={errors.name} label={`${entityLabel} name`} name="name" required>
            {(props) => <input {...props} aria-label={`${entityLabel} name`} value={name} onChange={(event) => { setName(event.target.value); clearError("name"); }} />}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
