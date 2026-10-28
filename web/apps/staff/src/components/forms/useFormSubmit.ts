import { useCallback, useRef, useState, type RefObject } from "react";

import { friendlyApiError, type FriendlyError, type FriendlyErrorOptions } from "../interaction/friendlyApiError";
import { focusFirstInvalid, useFormErrors, type FieldErrors } from "../interaction/useFormErrors";

/**
 * Submitting a form the same way everywhere: validate and focus the first gap, lock against a second
 * submit, show what the server said (on its field where it names one), keep everything entered on a
 * failure, and ignore the outcome of a save that belongs to a form that has since moved on.
 *
 * `order` is the form's fields, in form order, for focusing; `fieldMap` maps API field names to them.
 */
export function useFormSubmit({
  errorOptions,
  fallback,
  fieldMap,
  formRef,
  isCurrent,
  order,
  session
}: {
  /** Further options for turning an API failure into words (a 409 that means "refresh", say). */
  errorOptions?: Omit<FriendlyErrorOptions, "fallback" | "fieldMap">;
  fallback: string;
  fieldMap?: Record<string, string>;
  formRef: RefObject<HTMLFormElement | null>;
  isCurrent: (startedIn: number) => boolean;
  /** Field names in form order, or a function of the errors found (forms with repeating groups). */
  order: string[] | ((found: FieldErrors) => string[]);
  session: () => number;
}) {
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lock = useRef(false);

  const orderFor = useCallback(
    (found: FieldErrors) => (typeof order === "function" ? order(found) : order),
    [order]
  );

  /** Shows validation errors and focuses the first. True when there are none. */
  const validate = useCallback(
    (found: FieldErrors): boolean => {
      setSubmitError(null);
      setErrors(found);
      if (Object.keys(found).length === 0) return true;
      focusFirstInvalid(formRef.current, orderFor(found), found);
      return false;
    },
    [formRef, orderFor, setErrors]
  );

  /**
   * Runs the save once at a time. `onSaved` runs only if it succeeded and the form is still the one
   * that saved (it marks the form clean). `onFailed` sees the failure, for a form that must drop
   * something the server just refused (a time slot that was taken).
   */
  const run = useCallback(
    async (action: () => Promise<void>, onSaved: () => void, onFailed?: (failure: FriendlyError) => void) => {
      if (lock.current) return;
      const startedIn = session();
      lock.current = true;
      setSubmitting(true);
      try {
        await action();
        if (isCurrent(startedIn)) onSaved();
      } catch (reason) {
        if (!isCurrent(startedIn)) return;
        const friendly = friendlyApiError(reason, { ...errorOptions, fallback, fieldMap });
        onFailed?.(friendly);
        setErrors(friendly.fieldErrors);
        setSubmitError(friendly.message);
        window.setTimeout(() => {
          if (!focusFirstInvalid(formRef.current, orderFor(friendly.fieldErrors), friendly.fieldErrors)) {
            formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
          }
        }, 0);
      } finally {
        if (isCurrent(startedIn)) {
          lock.current = false;
          setSubmitting(false);
        }
      }
    },
    [errorOptions, fallback, fieldMap, formRef, isCurrent, orderFor, session, setErrors]
  );

  /** A new session (the form was reseeded): nothing from the last one is still pending here. */
  const reset = useCallback(() => {
    lock.current = false;
    setSubmitting(false);
    setSubmitError(null);
    clearAll();
  }, [clearAll]);

  return { clearError, errors, isSubmitting, reset, run, setErrors, setSubmitError, submitError, validate };
}
