import { useId, type ReactNode } from "react";

/** A red asterisk for sighted users; the control itself carries `required` for everyone else. */
export function RequiredMark() {
  return <span aria-hidden="true" className="required-mark"> *</span>;
}

/** One per form: explains the asterisk. */
export function RequiredNote() {
  return (
    <p className="required-note">
      <span aria-hidden="true" className="required-mark">*</span> Required fields
    </p>
  );
}

export function FieldError({ children, id }: { children: ReactNode; id: string }) {
  return <small className="field-error" id={id}>{children}</small>;
}

export interface FieldControlProps {
  id: string;
  "data-field": string;
  required?: true;
  "aria-required"?: true;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

/**
 * A labelled form control: label text with a required mark, the control, and its error. The
 * control is rendered by `children` so it receives the id, `required`, `aria-invalid` and
 * `aria-describedby` it needs; `data-field` lets a form focus the first invalid field.
 */
export function Field({
  children,
  className,
  error,
  hint,
  label,
  name,
  required = false
}: {
  children: (props: FieldControlProps) => ReactNode;
  className?: string;
  error?: string;
  hint?: string;
  label: string;
  name: string;
  required?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  const props: FieldControlProps = {
    id,
    "data-field": name,
    ...(required ? { required: true as const, "aria-required": true as const } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {})
  };
  return (
    <label className={`form-field${error ? " has-error" : ""}${className ? ` ${className}` : ""}`} htmlFor={id}>
      <span>
        {label}
        {required ? <RequiredMark /> : null}
      </span>
      {children(props)}
      {hint ? <small className="field-hint" id={hintId}>{hint}</small> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </label>
  );
}
