import { useCallback, useState } from "react";

export type FieldErrors = Record<string, string>;

/** Inline field errors for one form, plus focusing the first invalid control. */
export function useFormErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});
  const clearError = useCallback((name: string) => {
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }, []);
  const clearAll = useCallback(() => setErrors({}), []);
  return { errors, setErrors, clearError, clearAll };
}

/** Focus the first field (in form order) that has an error. Returns whether one was found. */
export function focusFirstInvalid(root: HTMLElement | null, order: string[], errors: FieldErrors): boolean {
  for (const name of order) {
    if (!errors[name]) continue;
    const control = root?.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
    if (control) {
      control.focus();
      return true;
    }
  }
  return false;
}

export function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}
