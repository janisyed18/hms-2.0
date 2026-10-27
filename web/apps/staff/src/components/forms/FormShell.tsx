import type { ElementType, FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { X } from "lucide-react";

import { ActionButton } from "../interaction/ActionButton";
import { ConfirmDialog } from "../interaction/ConfirmDialog";
import type { FieldErrors } from "../interaction/useFormErrors";
import { FormErrorSummary, StickyFormActions } from "./FormLayout";
import { RequiredNote } from "../interaction/FormPrimitives";
import { useFocusTrap } from "./useFocusTrap";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

/**
 * The one frame every Staff create/edit form shares: title and close, the error summary, the required
 * note, the fields, and the action rail. It also owns the behaviour that must be identical everywhere:
 * focus kept inside and returned on close; Escape, Close and Cancel asking before dirty data is lost
 * (and closing at once when nothing changed); navigation held while dirty; no unload prompt when clean.
 *
 * The caller supplies the backdrop (drawer or modal) and the fields; `formRef` is the form element so
 * the caller can focus an invalid field.
 */
export function FormShell({
  children,
  closeLabel = "Close form",
  dirty,
  errorSummaryTitle,
  errors,
  fieldLabels,
  fieldOrder,
  formClassName,
  formComponent,
  formProps,
  formRef,
  headerClassName,
  isSubmitting,
  onClose,
  onEdit,
  onSubmit,
  pendingLabel,
  submitError,
  submitLabel,
  title
}: {
  children: ReactNode;
  closeLabel?: string;
  dirty: boolean;
  errorSummaryTitle: string;
  errors: FieldErrors;
  fieldLabels: Record<string, string>;
  fieldOrder: string[];
  formClassName: string;
  /** For a caller that animates the form (a motion component). Defaults to a plain form. */
  formComponent?: ElementType;
  formProps?: Record<string, unknown>;
  formRef: RefObject<HTMLFormElement | null>;
  headerClassName: string;
  isSubmitting: boolean;
  /** Closes the form for good. Called directly when clean, and after the person confirms discarding. */
  onClose: () => void;
  /** A real user edit happened (the form's change event). */
  onEdit: () => void;
  onSubmit: (event: FormEvent) => void;
  pendingLabel: string;
  submitError: string | null;
  submitLabel: string;
  title: string;
}) {
  const guard = useUnsavedChangesGuard({ dirty, onDiscard: onClose });
  useFocusTrap(formRef);
  const Form = formComponent ?? "form";
  return (
    <>
      <Form
        {...formProps}
        aria-label={title}
        className={formClassName}
        noValidate
        onChange={onEdit}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (!isSubmitting) guard.requestClose();
          }
        }}
        onSubmit={onSubmit}
        ref={formRef}
      >
        <div className={headerClassName}>
          <h2>{title}</h2>
          <button aria-label={closeLabel} className="icon-button light" disabled={isSubmitting} onClick={guard.requestClose} type="button">
            <X size={18} />
          </button>
        </div>
        <FormErrorSummary
          errors={errors}
          focusRoot={() => formRef.current}
          labels={fieldLabels}
          message={submitError}
          order={fieldOrder}
          title={errorSummaryTitle}
        />
        <RequiredNote />
        {children}
        <StickyFormActions dirty={dirty}>
          <ActionButton disabled={isSubmitting} onClick={guard.requestClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel={pendingLabel} type="submit" variant="primary">{submitLabel}</ActionButton>
        </StickyFormActions>
      </Form>
      <ConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        message="You have unsaved changes. If you leave now they will be lost."
        onCancel={guard.keepEditing}
        onConfirm={guard.discard}
        open={guard.asking}
        pendingLabel="Discarding…"
        title="Discard unsaved changes?"
      />
    </>
  );
}
