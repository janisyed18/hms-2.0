/**
 * Lets a form with unsaved changes hold an in-app navigation until the person decides. One guard
 * at a time (only one form is ever open); it exists only while the form is dirty, so a clean form
 * never interferes with routing.
 */
export interface NavigationGuard {
  /** Ask the person; call `proceed` only if they choose to discard and leave. */
  confirm: (proceed: () => void) => void;
}

let guard: NavigationGuard | null = null;
let bypass = false;

export function setNavigationGuard(next: NavigationGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export function hasNavigationGuard(): boolean {
  return guard !== null && !bypass;
}

/** Run `proceed` now, or after the person confirms when a dirty form is guarding navigation. */
export function guardNavigation(proceed: () => void): void {
  if (!guard || bypass) {
    proceed();
    return;
  }
  guard.confirm(() => {
    bypass = true;
    try {
      proceed();
    } finally {
      bypass = false;
    }
  });
}
