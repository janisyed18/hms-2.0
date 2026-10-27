import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { InspectionCapture } from "./components/InspectionCapture";
import { ScanUnavailable } from "./components/ScanUnavailable";
import { SyncQueue } from "./components/SyncQueue";
import { UnsavedChangesDialog } from "./components/UnsavedChangesDialog";
import { WorkQueue } from "./components/WorkQueue";
import { useInspectorWorkspace, type InspectorView } from "./hooks/useInspectorWorkspace";
import {
  InspectorAuthGate,
  type BrowserAuthClient
} from "./auth/InspectorAuthGate";

interface AppProps {
  authClient?: BrowserAuthClient;
  /** Explicit test seam. Production callers must use browser authentication. */
  initialAccessToken?: string;
}

export default function App({ authClient, initialAccessToken }: AppProps = {}) {
  return (
    <InspectorAuthGate client={authClient} initialAccessToken={initialAccessToken}>
      {(userId) => <InspectorWorkspace key={userId} userId={userId} />}
    </InspectorAuthGate>
  );
}

function InspectorWorkspace({ userId }: { userId: string }) {
  const workspace = useInspectorWorkspace(userId);
  const sourceLabel = workspace.lastSyncLabel;

  // A capture holding edits that never reached the outbox is protected: leaving it (another view, the
  // Work queue, opening another assignment) asks first. A clean capture, or any other view, never asks.
  const [captureDirty, setCaptureDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const protectedCapture = workspace.view === "capture" && captureDirty;
  const leave = (action: () => void) => {
    if (protectedCapture) setPendingLeave(() => action);
    else action();
  };
  const navigate = (next: InspectorView) => {
    if (next !== workspace.view) leave(() => workspace.setView(next));
  };
  const onDirtyChange = useCallback((dirty: boolean) => {
    setCaptureDirty(dirty);
    if (!dirty) setPendingLeave(null);
  }, []);

  // The browser's own leave prompt exists only while there is something to lose.
  useEffect(() => {
    if (!protectedCapture) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [protectedCapture]);

  const captureKey =
    workspace.selectedWorkItem?.workContext?.assignment_id ?? workspace.selectedWorkItem?.id ?? "none";

  let content;

  if (workspace.view === "capture") {
    content = (
      <InspectionCapture
        draftFor={workspace.draftFor}
        key={captureKey}
        onBack={() => leave(() => workspace.setView("work"))}
        onDirtyChange={onDirtyChange}
        onQueueAssetUpdate={workspace.queueAssetUpdate}
        onQueuePressureTest={workspace.queuePressureTest}
        onSaveDraft={(values) =>
          workspace.saveInspection({ ...values, status: "DRAFT" })
        }
        onSubmit={(values) =>
          workspace.saveInspection({ ...values, status: "SUBMITTED" })
        }
        workItem={workspace.selectedWorkItem}
      />
    );
  } else if (workspace.view === "queue") {
    content = (
      <SyncQueue
        hasPreservedDrafts={workspace.hasPreservedDrafts}
        isOnline={workspace.isOnline}
        onPull={workspace.pullChanges}
        onPush={workspace.pushQueuedOperations}
        onResolveConflict={workspace.resolveConflict}
        outbox={workspace.outbox.operations}
      />
    );
  } else if (workspace.view === "scan") {
    content = <ScanUnavailable onBack={() => workspace.setView("work")} />;
  } else {
    content = (
      <WorkQueue
        onOpenWorkItem={(item) => leave(() => workspace.openWorkItem(item))}
        outbox={workspace.outbox.operations}
        workItems={workspace.workItems}
      />
    );
  }

  return (
    <AppShell
      isOnline={workspace.isOnline}
      onNavigate={navigate}
      queuedCount={workspace.queuedCount}
      sourceLabel={sourceLabel}
      view={workspace.view}
    >
      {content}
      {pendingLeave ? (
        <UnsavedChangesDialog
          onDiscard={() => {
            const action = pendingLeave;
            setPendingLeave(null);
            action();
          }}
          onKeepEditing={() => setPendingLeave(null)}
        />
      ) : null}
    </AppShell>
  );
}
