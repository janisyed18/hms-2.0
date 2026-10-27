import { useCallback, useEffect, useState } from "react";

import { setNavigationGuard } from "../../routing/navigationGuard";

/**
 * Protects unsaved form data. `requestClose` closes at once when clean and asks first when dirty.
 * While dirty, in-app navigation and Back/Forward are held for the same question, and the browser's
 * own unload prompt is installed; a clean form installs none of it.
 */
export function useUnsavedChangesGuard({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) {
  const [asking, setAsking] = useState<{ proceed: (() => void) | null } | null>(null);

  const requestClose = useCallback(() => {
    if (dirty) setAsking({ proceed: null });
    else onDiscard();
  }, [dirty, onDiscard]);

  useEffect(() => {
    if (!dirty) return;
    const release = setNavigationGuard({ confirm: (proceed) => setAsking({ proceed }) });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      release();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  const keepEditing = useCallback(() => setAsking(null), []);
  const discard = useCallback(() => {
    const proceed = asking?.proceed ?? null;
    setAsking(null);
    onDiscard();
    proceed?.();
  }, [asking, onDiscard]);

  return { asking: asking !== null, discard, keepEditing, requestClose };
}
