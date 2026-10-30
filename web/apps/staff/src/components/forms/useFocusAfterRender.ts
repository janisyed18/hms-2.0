import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Moves focus to something that only exists once a state change has rendered (an error notice, an
 * invalid field), in the same commit as that change and without a timer.
 *
 * `setTimeout(0)` raced React's own scheduling: on a slow or busy machine the timer could fire before
 * the commit, find nothing to focus, and leave focus on the button that was pressed. A layout effect
 * runs inside the commit, so whoever can see the new DOM can also see focus already in place.
 *
 * Call the returned function from the same place that sets the state. It focuses once per call; later
 * renders do not move focus again.
 */
export function useFocusAfterRender(): (focus: () => void) => void {
  const [request, setRequest] = useState<{ focus: () => void } | null>(null);
  useLayoutEffect(() => {
    request?.focus();
  }, [request]);
  return useCallback((focus: () => void) => setRequest({ focus }), []);
}
