import { useCallback, useEffect, useState } from "react";

/**
 * Whether a form differs from what it was opened with, counted only once the person has changed
 * something. Until the first edit the baseline follows the form, so defaults that arrive late (option
 * lists, a first-in-list customer) never read as unsaved work; after it, putting every value back
 * makes the form clean again.
 *
 * `snapshot` is a stable string of every editable value (JSON of the values, not object identity).
 */
export function useDirtyTracker(snapshot: string) {
  const [touched, setTouched] = useState(false);
  const [baseline, setBaseline] = useState(snapshot);
  useEffect(() => {
    if (!touched) setBaseline(snapshot);
  }, [snapshot, touched]);
  /** Call from a real user edit (the form's change event), never from programmatic updates. */
  const touch = useCallback(() => setTouched(true), []);
  /** Back to clean: after a save, or when the form is reopened for a different record. */
  const markClean = useCallback(() => setTouched(false), []);
  return { dirty: touched && snapshot !== baseline, markClean, touch };
}
