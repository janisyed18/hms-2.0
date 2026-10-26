import { useCallback, useEffect, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetWorkflow } from "../domain/types";
import { friendlyApiError } from "../components/interaction/friendlyApiError";

type WorkflowState =
  | { assetId: string; status: "loading" }
  | { assetId: string; status: "ready"; workflow: AssetWorkflow }
  | { assetId: string; status: "error"; message: string };

/**
 * The workflow summary for one asset, loaded separately from the asset so a failure here never
 * costs the asset itself. An answer is used only if it is for the asset now on screen, so a slow
 * answer for an asset the person has left can never replace the one they are looking at.
 */
export function useAssetWorkflow(assetId: string) {
  const [state, setState] = useState<WorkflowState>({ assetId, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const current = useRef(assetId);

  useEffect(() => {
    current.current = assetId;
    setState({ assetId, status: "loading" });
    createHmsClient()
      .getAssetWorkflow(assetId)
      .then((workflow) => {
        if (current.current !== assetId) return;
        setState({ assetId, status: "ready", workflow });
      })
      .catch((reason: unknown) => {
        if (current.current !== assetId) return;
        setState({
          assetId,
          status: "error",
          message: friendlyApiError(reason, { fallback: "The workflow status could not be loaded." }).message
        });
      });
    // `attempt` is how Retry asks again for the same asset.
  }, [assetId, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  // Whatever the state holds, it is shown only for the asset it was loaded for.
  const visible: WorkflowState = state.assetId === assetId ? state : { assetId, status: "loading" };
  return { state: visible, retry };
}
