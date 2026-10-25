import { FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
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

export function ReferenceForm({
  open,
  standard,
  onClose,
  onSubmit,
  entityLabel = "Standard"
}: ReferenceFormProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCode(standard?.code ?? "");
    setName(standard?.name ?? "");
    setSubmitError(null);
    clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, standard]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const found: FieldErrors = {};
    if (isBlank(code)) found.code = `Enter a ${entityLabel.toLowerCase()} code.`;
    if (isBlank(name)) found.name = `Enter a ${entityLabel.toLowerCase()} name.`;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, ["code", "name"], found);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({ code: code.trim(), name: name.trim() });
    } catch (reason) {
      const friendly = friendlyApiError(reason, { fallback: `The ${entityLabel.toLowerCase()} could not be saved. Try again.`, fieldMap: { code: "code", name: "name" } });
      setErrors(friendly.fieldErrors);
      setSubmitError(friendly.message);
      window.setTimeout(() => {
        if (!focusFirstInvalid(formRef.current, ["code", "name"], friendly.fieldErrors)) {
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
            <h2>{standard ? `Edit ${entityLabel}` : `Add ${entityLabel}`}</h2>
            <p>Controlled catalog data is available immediately to asset configuration.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {submitError ? <ActionNotice kind="error" title={`${entityLabel} could not be saved`}>{submitError}</ActionNotice> : null}
        <RequiredNote />
        <Field error={errors.code} label={`${entityLabel} code`} name="code" required>
          {(props) => <input {...props} aria-label={`${entityLabel} code`} value={code} onChange={(event) => { setCode(event.target.value.toUpperCase()); clearError("code"); }} />}
        </Field>
        <Field error={errors.name} label={`${entityLabel} name`} name="name" required>
          {(props) => <input {...props} aria-label={`${entityLabel} name`} value={name} onChange={(event) => { setName(event.target.value); clearError("name"); }} />}
        </Field>
        <div className="drawer-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel="Saving…" type="submit" variant="primary">{`Save ${entityLabel.toLowerCase()}`}</ActionButton>
        </div>
      </form>
    </div>
  );
}
