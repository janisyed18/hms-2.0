import type { ReactNode } from "react";

import { ActionNotice } from "../interaction/ActionNotice";
import type { FieldErrors } from "../interaction/useFormErrors";

/** A titled group of related fields. Sections stack; fields inside flow through a FormGrid. */
export function FormSection({ children, description, step, title }: { children: ReactNode; description?: string; step?: number; title?: string }) {
  return (
    <section aria-label={title} className="form-section">
      {title ? <FormSectionHeader description={description} step={step} title={title} /> : null}
      {children}
    </section>
  );
}

export function FormSectionHeader({ description, step, title }: { description?: string; step?: number; title: string }) {
  return (
    <header className={`form-section__header${step ? " has-step" : ""}`}>
      {step ? <span aria-hidden="true" className="form-section__step">{step}</span> : null}
      <div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
    </header>
  );
}

/** A quiet explanatory note under a field or section: an icon and a sentence, not an alert. */
export function FormNote({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="form-note">
      <span aria-hidden="true" className="form-note__icon">{icon}</span>
      <p>{children}</p>
    </div>
  );
}

/** One column on a phone, two from a tablet up; `wide` children take the full row. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

export function FormHint({ children, id }: { children: ReactNode; id?: string }) {
  return <small className="field-hint" id={id}>{children}</small>;
}

/**
 * What went wrong with the whole submission, plus a link to every field that needs attention. The
 * message (a server rejection) is an alert; the field list only points at the inline errors, which
 * stay beside their controls, so no message is read out twice.
 */
export function FormErrorSummary({
  errors,
  focusRoot,
  labels,
  message,
  order,
  title
}: {
  errors: FieldErrors;
  focusRoot: () => HTMLElement | null;
  labels: Record<string, string>;
  message: string | null;
  order: string[];
  title: string;
}) {
  const failing = order.filter((name) => errors[name]);
  if (!message && failing.length === 0) return null;
  return (
    <div className="form-error-summary">
      {message ? <ActionNotice kind="error" title={title}>{message}</ActionNotice> : null}
      {failing.length > 0 ? (
        <nav aria-label="Fields to correct" className="form-error-summary__fields">
          <span>Fields to correct:</span>
          <ul>
            {failing.map((name) => (
              <li key={name}>
                <button
                  className="link-button"
                  onClick={() => focusRoot()?.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`)?.focus()}
                  type="button"
                >
                  {labels[name] ?? name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The action rail: it stays at the foot of a long form. Save is the one primary action and sits last;
 * Cancel is secondary. Anything destructive belongs elsewhere, behind its own confirmation.
 */
export function StickyFormActions({ children, className, dirty }: { children: ReactNode; className?: string; dirty: boolean }) {
  return (
    <div className={`form-actions${className ? ` ${className}` : ""}`}>
      <span aria-live="polite" className="form-actions__status">{dirty ? "Unsaved changes" : ""}</span>
      <div className="form-actions__buttons">{children}</div>
    </div>
  );
}
